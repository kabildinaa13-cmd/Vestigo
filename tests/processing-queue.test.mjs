import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {openDatabase,createCase,changeCaseStatus} from "../app/lib/vestigo-db.mjs";
import {saveDocument,listDocuments} from "../app/lib/documents.mjs";
import {caseAnalysis,storeExtraction} from "../app/lib/case-analysis.mjs";
import {processCaseDocument} from "../app/lib/document-processing.mjs";
import {migrateProcessingQueue,enqueueProcessing,claimProcessing,renewProcessing,assertProcessingLease,completeProcessing,failProcessing,retryProcessing,listProcessing} from "../app/lib/processing-queue.mjs";
function setup(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),"vestigo-queue-test-")),db=openDatabase({dataDirectory:dir}),a=createCase(db,{caseNumber:"A"}),b=createCase(db,{caseNumber:"B"});let n=0;
  const doc=(caseId=a.id,bytes=Buffer.from(`test-${++n}`))=>saveDocument(db,{caseId,name:`document-${n}.csv`,bytes,groupId:"primary",typeId:"invoice"});
  return {db,dir,a,b,doc,close:()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});}};}
test("задания сохраняются после закрытия базы; повторы и чужие дела защищены",()=>{const s=setup();try{
  const d=s.doc(),job=enqueueProcessing(s.db,{caseId:s.a.id,documentId:d.id});assert.equal(enqueueProcessing(s.db,{caseId:s.a.id,documentId:d.id}).job.id,job.job.id);
  assert.throws(()=>enqueueProcessing(s.db,{caseId:s.a.id,documentId:d.id,options:{defaultCurrency:"USD"}}),/другими параметрами/);
  assert.throws(()=>enqueueProcessing(s.db,{caseId:s.b.id,documentId:d.id}),/не относится/);
  const other=openDatabase({dataDirectory:s.dir});try{assert.equal(listProcessing(other,s.a.id).counts.queued,1);assert.equal(listProcessing(other,s.b.id).jobs.length,0);}finally{other.close();}
}finally{s.close();}});
test("два обработчика не получают одно задание и не пишут одновременно в одно дело",()=>{const s=setup();try{
  const first=s.doc(),second=s.doc(),foreign=s.doc(s.b.id);for(const [caseId,d] of [[s.a.id,first],[s.a.id,second],[s.b.id,foreign]])enqueueProcessing(s.db,{caseId,documentId:d.id});
  const one=claimProcessing(s.db),other=openDatabase({dataDirectory:s.dir});try{assert.equal(claimProcessing(other,{maxConcurrent:1}),null);const two=claimProcessing(other);assert.ok(one&&two);assert.notEqual(one.id,two.id);assert.notEqual(one.case_id,two.case_id);assert.equal(claimProcessing(other),null);}finally{other.close();}
}finally{s.close();}});
test("прерванное задание возвращается в очередь; старый обработчик не может сохранить результат",()=>{const s=setup();try{
  const d=s.doc();enqueueProcessing(s.db,{caseId:s.a.id,documentId:d.id});const now=Date.now(),first=claimProcessing(s.db,{now,leaseMs:100}),second=claimProcessing(s.db,{now:now+200,leaseMs:600000});
  assert.equal(first.id,second.id);assert.equal(second.attempts,2);assert.notEqual(first.lease_token,second.lease_token);assert.throws(()=>assertProcessingLease(s.db,first.id,first.lease_token),/потеряло/);
  assert.equal(renewProcessing(s.db,first.id,first.lease_token),false);assert.equal(renewProcessing(s.db,second.id,second.lease_token),true);
  assert.throws(()=>storeExtraction(s.db,s.a.id,d.id,{rows:[],tables:[],warnings:[],status:"extracted"},{processingLease:{id:first.id,token:first.lease_token}}),/потеряло/);
  assert.equal(caseAnalysis(s.db,s.a.id).operationCount,0);
}finally{s.close();}});
test("ошибка не останавливает очередь; число автоматических попыток ограничено, ручной повтор сохраняет историю",()=>{const s=setup();try{
  const d=s.doc();enqueueProcessing(s.db,{caseId:s.a.id,documentId:d.id});let now=Date.now();for(let i=1;i<=3;i++){const j=claimProcessing(s.db,{now});assert.ok(j);assert.equal(j.attempts,i);failProcessing(s.db,j.id,j.lease_token,new Error("Временная ошибка"),{now,retryable:true});now+=120000;}
  assert.equal(listProcessing(s.db,s.a.id).counts.failed,1);assert.equal(claimProcessing(s.db,{now}),null);const old=listProcessing(s.db,s.a.id).jobs[0];const repeated=retryProcessing(s.db,s.a.id,old.id);assert.notEqual(repeated.job.id,old.id);assert.equal(listProcessing(s.db,s.a.id).total,2);
  changeCaseStatus(s.db,s.a.id,"archived");assert.throws(()=>retryProcessing(s.db,s.a.id,old.id),/архиве/);
}finally{s.close();}});
test("оригинал и постановка задания фиксируются вместе; ошибка откатывает приём",()=>{const s=setup();try{
  migrateProcessingQueue(s.db);const d=saveDocument(s.db,{caseId:s.a.id,name:"queued.txt",bytes:Buffer.from("unique"),groupId:"unclassified",typeId:"unclassified",afterSave:(db,id,caseId)=>enqueueProcessing(db,{caseId,documentId:id},{},false)});assert.equal(d.processing.job.state,"queued");
  assert.throws(()=>saveDocument(s.db,{caseId:s.a.id,name:"rollback.txt",bytes:Buffer.from("rollback"),groupId:"bank",typeId:"statement",afterSave:()=>{throw new Error("Тест отката");}}),/Тест отката/);assert.equal(listDocuments(s.db,s.a.id).length,1);
}finally{s.close();}});
test("результат чтения, анализ и завершение задания сохраняются атомарно без дублей",async()=>{const s=setup();try{
  const csv="БИН поставщика;БИН покупателя;Сумма;Дата;Номер ЭСФ;Валюта\n990000000001;990000000002;1000,01;2026-10-20;ESF-QUEUE-1;KZT";
  const d=s.doc(s.a.id,Buffer.from(csv));enqueueProcessing(s.db,{caseId:s.a.id,documentId:d.id});const job=claimProcessing(s.db);
  await processCaseDocument(s.db,s.a.id,d.id,{}, {},{id:job.id,token:job.lease_token});assert.equal(listProcessing(s.db,s.a.id).counts.completed,1);assert.equal(caseAnalysis(s.db,s.a.id).operationCount,1);
  assert.equal(enqueueProcessing(s.db,{caseId:s.a.id,documentId:d.id}).job.state,"completed");
  assert.throws(()=>completeProcessing(s.db,job.id,job.lease_token,{}),/потеряло/);
  enqueueProcessing(s.db,{caseId:s.a.id,documentId:d.id,force:true});const repeated=claimProcessing(s.db);await processCaseDocument(s.db,s.a.id,d.id,{}, {},{id:repeated.id,token:repeated.lease_token});assert.equal(caseAnalysis(s.db,s.a.id).operationCount,1);
}finally{s.close();}});
