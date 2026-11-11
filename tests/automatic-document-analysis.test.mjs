import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {openDatabase,createCase} from "../app/lib/vestigo-db.mjs";
import {saveDocument} from "../app/lib/documents.mjs";
import {analyzePdfResult} from "../app/lib/pdf-analysis.mjs";
import {extractLabelledFacts,automaticFactDecision} from "../app/lib/document-facts.mjs";
import {storeExtraction,caseAnalysis,reviewCaseItem} from "../app/lib/case-analysis.mjs";
import {searchCaseText,caseWorkspaceOverview} from "../app/lib/case-workspace.mjs";
import {refreshStoredCaseDocuments} from "../app/lib/case-refresh.mjs";
import {caseAnalyticsDataset} from "../app/lib/case-analytics.mjs";
import {processCaseDocument} from "../app/lib/document-processing.mjs";
import {shouldContinueOcr} from "../app/lib/document-processing.mjs";
import {enqueueProcessing,claimProcessing,completeProcessing} from "../app/lib/processing-queue.mjs";
const makeResult=text=>({version:1,status:"review",rows:[],tables:[],warnings:[],text,pages:[{page:1,text,textSource:"native"}],pageAudit:{totalPages:1,pagesWithText:1,pagesWithoutText:[],ocrPerformed:false}});
function setup(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),"vestigo-auto-test-")),db=openDatabase({dataDirectory:dir}),c=createCase(db,{caseNumber:"AUTO-ONLY-SYNTHETIC"});return {db,c,dir,close(){db.close();fs.rmSync(dir,{recursive:true,force:true});}};}
const parties="БИН поставщика: 990000000001\nБИН получателя: 990000000002\nНаименование поставщика: ТОО Альфа\nНаименование получателя: ТОО Бета\n";

test("автоматические PDF: договор → ЭСФ → платёж → сопоставление, риск, граф, поиск и хронология без ручных полей",()=>{const s=setup();try{
  const texts=[`Договор поставки № CON-1\n${parties}Дата документа: 20.10.2026\nОбщая сумма документа: 1000,01\nВалюта: KZT`,
    `Электронный счет-фактура\n${parties}Дата документа: 21.10.2026\nОбщая сумма документа: 1000,01\nВалюта: KZT\nНомер ЭСФ: ESF-990000000001-20261021-00000001\nОснование: договор № CON-1\nПредмет договора: поставка оборудования`,
    `Платежное поручение\nБИН отправителя: 990000000002\nБИН получателя: 990000000001\nДата платежа: 22.10.2026\nСумма платежа: 900,01\nВалюта: KZT\nНомер платежа: PAY-1\nНазначение платежа: Оплата ESF-990000000001-20261021-00000001`];
  const saved=[];
  for(const [i,text] of texts.entries()){const doc=saveDocument(s.db,{caseId:s.c.id,name:`synthetic-${i}.txt`,bytes:Buffer.from(text),groupId:"unclassified",typeId:"mixed_bundle"});saved.push(doc);const result=analyzePdfResult(makeResult(text));assert.equal(result.documentAnalysis.automaticallyExtracted,1);assert.equal(result.rows[0].manualSource,false);storeExtraction(s.db,s.c.id,doc.id,result,{groupId:"unclassified",typeId:"mixed_bundle"});}
  const analysis=caseAnalysis(s.db,s.c.id);assert.equal(analysis.operationCount,3);assert.ok(analysis.operations.every(o=>!o.confirmed&&o.automaticSource));assert.equal(analysis.matches.length,2);assert.ok(analysis.chains.some(c=>c.stages.filter(stage=>stage.operations.length).length===3));assert.ok(analysis.risks.some(r=>r.code==="PAYMENT_AMOUNT_DIFFERENCE"));
  const graph=caseAnalyticsDataset(s.db,s.c.id);assert.equal(graph.nodes.length,2);assert.equal(graph.edges.length,3);
  for(const query of ["поставка","ПОсТаВКа","990000000001","оборуд","ESF-990000000001"])assert.ok(searchCaseText(s.db,s.c.id,query).total>0,query);
  assert.ok(searchCaseText(s.db,s.c.id,"1000,01").total>0);
  const overview=caseWorkspaceOverview(s.db,s.c.id);assert.equal(overview.automaticSegments,3);assert.equal(overview.links,2);assert.deepEqual(overview.timeline.map(o=>o.date),["2026-10-20","2026-10-21","2026-10-22"]);
  const second=createCase(s.db,{caseNumber:"OTHER"});assert.equal(searchCaseText(s.db,second.id,"поставка").total,0);assert.throws(()=>searchCaseText(s.db,"missing","поставка"),/Дело/);
  const first=analysis.operations.find(o=>o.type==="contract");reviewCaseItem(s.db,s.c.id,{kind:"operation",id:first.id,status:"confirmed",note:"Synthetic assertion"});
  refreshStoredCaseDocuments(s.db,s.c.id);const repeated=caseAnalysis(s.db,s.c.id);assert.equal(repeated.operationCount,3);assert.equal(repeated.matches.length,2);assert.equal(repeated.operations.find(o=>o.id===first.id).confirmed,true);
  reviewCaseItem(s.db,s.c.id,{kind:"document",id:saved[1].id,status:"excluded",note:"Synthetic exclusion"});assert.equal(searchCaseText(s.db,s.c.id,"оборуд").total,0);
}finally{s.close();}});

test("противоречивые суммы, несколько БИН в блоке и неполные поля не становятся операциями",()=>{
  const text=`Платежное поручение\n${parties}Дата платежа: 20.10.2026\nСумма платежа: 100,00\nСумма платежа: 200,00\nВалюта: KZT`;
  const r=analyzePdfResult(makeResult(text));assert.equal(r.rows[0].type,"context");assert.ok(r.documentAnalysis.segments[0].automatic.conflicts.includes("amount"));assert.equal(r.rows[0].senderId,"990000000001");
  const bank="Платежное поручение\nОтправитель денег:\nИИН (БИН): 990000000001\nДополнительный БИН 990000000003\nБенефициар/Бенефициар:\nИИН (БИН): 990000000002\nНазначение платежа:";
  assert.equal(extractLabelledFacts(bank,{typeId:"payment_order"}).fields.senderId,"");
  const incomplete=extractLabelledFacts("БИН отправителя: 990000000001\nБИН получателя: 990000000002\nСумма платежа: 100,00",{typeId:"payment_order"});assert.equal(automaticFactDecision(incomplete,{groupId:"bank",typeId:"payment_order"}).eligible,false);
});

test("независимые OCR-варианты с разными цифрами блокируют автоматическую операцию",()=>{
  const r=makeResult(`Платежное поручение\n${parties}Дата платежа: 20.10.2026\nСумма платежа: 100,00\nВалюта: KZT`);r.pages[0].ocr={alternatives:[{text:r.text.replace("100,00","200,00")}]};
  const output=analyzePdfResult(r);assert.equal(output.rows[0].type,"context");assert.ok(output.rows[0].attributes.conflictingFields.includes("amount"));
});

test("реальный обработчик читает подписанные поля TXT без ручного подтверждения",async()=>{const s=setup();try{
  const text=`Договор поставки № TXT-1\n${parties}Дата документа: 20.10.2026\nОбщая сумма документа: 100,00\nВалюта: KZT`;
  const doc=saveDocument(s.db,{caseId:s.c.id,name:"synthetic-contract.txt",bytes:Buffer.from(text),groupId:"unclassified",typeId:"unclassified",classificationMode:"auto"});
  await processCaseDocument(s.db,s.c.id,doc.id);assert.equal(caseAnalysis(s.db,s.c.id).operationCount,1);assert.ok(searchCaseText(s.db,s.c.id,"TXT-1").total>0);
}finally{s.close();}});

test("продолжение OCR ограничено и повторная загрузка не конфликтует с продолжением",()=>{const s=setup();try{
  const partial={pages:[{text:"",ocrError:"Достигнут защитный предел OCR"}]};assert.equal(shouldContinueOcr(partial,0),true);assert.equal(shouldContinueOcr(partial,1),true);assert.equal(shouldContinueOcr(partial,2),false);assert.equal(shouldContinueOcr({pages:[{text:"",ocrError:"Плохое качество"}]},0),false);
  const doc=saveDocument(s.db,{caseId:s.c.id,name:"test.txt",bytes:Buffer.from("synthetic-continuation"),groupId:"unclassified",typeId:"unclassified"});
  const queued=enqueueProcessing(s.db,{caseId:s.c.id,documentId:doc.id,options:{ocrContinuation:1}});
  assert.equal(enqueueProcessing(s.db,{caseId:s.c.id,documentId:doc.id,options:{}}).job.id,queued.job.id);
  const claimed=claimProcessing(s.db);completeProcessing(s.db,claimed.id,claimed.lease_token,{});
  assert.equal(enqueueProcessing(s.db,{caseId:s.c.id,documentId:doc.id,options:{}}).job.id,queued.job.id);
  assert.throws(()=>enqueueProcessing(s.db,{caseId:s.c.id,documentId:doc.id,options:{ocrContinuation:99}}),/продолжений/);
}finally{s.close();}});
