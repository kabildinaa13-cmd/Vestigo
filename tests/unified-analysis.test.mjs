import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {openDatabase,createCase,changeCaseStatus} from "../app/lib/vestigo-db.mjs";
import {saveDocument,documentOriginal} from "../app/lib/documents.mjs";
import {storeExtraction,caseAnalysis,reviewCaseItem,rebuildCaseAnalysis} from "../app/lib/case-analysis.mjs";
import {caseAnalyticsDataset,handleCaseAnalytics} from "../app/lib/case-analytics.mjs";
import {evaluateCaseRules,RULE_VERSION} from "../app/lib/case-rules.mjs";
const a="990000000001",b="990000000002",c="990000000003";
const row=(v={})=>({sheet:"Лист1",row:2,type:"invoice",senderId:a,recipientId:b,senderName:"ТОО Альфа",recipientName:"ТОО Бета",date:"2026-10-01",amountMinor:100000,currency:"KZT",number:"ESF-TEST",reference:"",purpose:"Поставка",amountBasis:"document_total",status:"CREATED",raw:{номер:"ESF-TEST"},attributes:{},...v});
function setup(){const directory=fs.mkdtempSync(path.join(os.tmpdir(),"vestigo-unified-test-")),db=openDatabase({dataDirectory:directory}),parent=createCase(db,{caseNumber:"UNIFIED"}),other=createCase(db,{caseNumber:"OTHER"});let n=0;
  function add(rows){const doc=saveDocument(db,{caseId:parent.id,groupId:"primary",typeId:"invoice",name:`test-${++n}.csv`,bytes:Buffer.from(`unique ${n}`)});storeExtraction(db,parent.id,doc.id,{version:1,status:"extracted",rows,tables:[],warnings:[],text:"",unparsedRows:0});return doc;}
  return {db,parent,other,add,close:()=>{db.close();fs.rmSync(directory,{recursive:true,force:true});}};
}
test("единые карточки и граф читают только своё дело; неполные строки доступны в поиске без выдуманной операции",()=>{const s=setup();try{
  s.add([row(),row({row:3,number:"",senderId:c,senderName:"ТОО Частичные данные",recipientId:"",amountMinor:null})]);
  const own=caseAnalyticsDataset(s.db,s.parent.id),empty=caseAnalyticsDataset(s.db,s.other.id);
  assert.equal(own.entities.length,3);assert.equal(own.edges.length,1);assert.equal(own.analysis.operationCount,1);assert.equal(own.entities.find(e=>e.bin===c).name,"ТОО Частичные данные");
  assert.equal(empty.entities.length,0);assert.equal(empty.records.length,0);assert.throws(()=>caseAnalyticsDataset(s.db,"missing"),/Дело не найдено/);
}finally{s.close();}});
test("цепочка договора, исполнения, ЭСФ и платежа использует точные ссылки; переплата объяснима",()=>{const s=setup();try{
  s.add([row({type:"contract",number:"CON-1"}),row({row:3,type:"primary",number:"ACT-1",contractRef:"CON-1"}),row({row:4,contractRef:"CON-1"}),row({row:5,type:"payment",number:"PAY-1",senderId:b,recipientId:a,contractRef:"CON-1",amountMinor:120000})]);
  const analysis=caseAnalysis(s.db,s.parent.id),chain=analysis.chains.find(c=>c.number==="CON-1");
  assert.ok(chain);for(const type of ["contract","primary","invoice","payment"])assert.equal(chain.stages.find(s=>s.type===type).operations.length,1);
  const risk=analysis.risks.find(r=>r.code==="CONTRACT_PAYMENT_EXCESS");assert.ok(risk);assert.equal(risk.kind,"discrepancy");assert.equal(risk.calculation.differenceMinor,20000);assert.ok(risk.nextAction);assert.equal(risk.ruleVersion,RULE_VERSION);
  const data=caseAnalyticsDataset(s.db,s.parent.id);assert.equal(data.edges.filter(e=>e.relations.includes("ЭСФ"))[0].amount,1000);assert.equal(data.edges.filter(e=>e.relations.includes("Платёж"))[0].dealAmount,1200);
}finally{s.close();}});
test("исключение и возврат файла обратимы, журналируются, не удаляют оригинал и не затрагивают другое дело",()=>{const s=setup();try{
  const doc=s.add([row()]);reviewCaseItem(s.db,s.parent.id,{kind:"document",id:doc.id,status:"excluded",note:"Ошибочно отнесён к делу"});
  assert.equal(caseAnalysis(s.db,s.parent.id).operationCount,0);assert.equal(caseAnalyticsDataset(s.db,s.parent.id).entities.length,0);assert.equal(documentOriginal(s.db,doc.id,s.parent.id).name,doc.name||"test-1.csv");
  assert.throws(()=>reviewCaseItem(s.db,s.other.id,{kind:"document",id:doc.id,status:"active",note:"Чужой"}),/не относится/);
  reviewCaseItem(s.db,s.parent.id,{kind:"document",id:doc.id,status:"active",note:"Реквизиты проверены"});assert.equal(caseAnalysis(s.db,s.parent.id).operationCount,1);assert.ok(caseAnalysis(s.db,s.parent.id).history.some(h=>h.action==="case.document_scope_changed"));
  changeCaseStatus(s.db,s.parent.id,"archived");assert.throws(()=>reviewCaseItem(s.db,s.parent.id,{kind:"document",id:doc.id,status:"excluded",note:"Проба"}),/архиве/);
}finally{s.close();}});
test("валюты не смешиваются в графе; сигналы строки не приписываются всем организациям того же файла",()=>{const s=setup();try{
  s.add([row({senderId:a,recipientId:a}),row({row:3,number:"ESF-USD",senderId:b,recipientId:c,currency:"USD"})]);
  const kzt=caseAnalyticsDataset(s.db,s.parent.id,"KZT"),usd=caseAnalyticsDataset(s.db,s.parent.id,"USD");
  assert.equal(kzt.edges.length,1);assert.equal(usd.edges.length,1);assert.equal(kzt.edges[0].attributes.currency,"KZT");assert.equal(usd.edges[0].attributes.currency,"USD");assert.equal(kzt.entities.find(e=>e.bin===c).signals,0);
}finally{s.close();}});
test("бухгалтерские и товарные проверки имеют источники и не применяют округление автоматически",()=>{
  const source={documentId:"D",name:"test.xlsx",sheet:"Лист1",row:2};
  const result=evaluateCaseRules({operations:[],documents:[],records:[{source,row:row({amountBasis:"line",amountMinor:310,attributes:{quantity:"3",unitPriceMinor:100,priceBasis:"WITH_VAT",openingMinor:1000,incomingMinor:300,outgoingMinor:200,closingMinor:200,openingQuantity:"10",receivedQuantity:"2",issuedQuantity:"1",closingQuantity:"9",unit:"шт"}})}]});
  for(const code of ["LINE_ARITHMETIC","BALANCE_ROLLFORWARD","INVENTORY_ROLLFORWARD"]){const risk=result.risks.find(r=>r.code===code);assert.ok(risk);assert.equal(risk.kind,"discrepancy");assert.deepEqual(risk.evidence,[source]);}
  assert.equal(evaluateCaseRules({operations:[],documents:[],records:[{source,row:row({amountBasis:"line",amountMinor:33,attributes:{quantity:"0.333333",unitPriceMinor:100,priceBasis:"WITH_VAT"}})}]}).risks.length,0);
});
test("транзит и цикл — признаки с источниками, не вывод о движении тех же денег",()=>{
  const operation=(id,from,to,date)=>({id,type:"payment",senderId:from,recipientId:to,date,amount:10000,currency:"KZT",review:"pending",sources:[{documentId:id,name:id}]});
  const result=evaluateCaseRules({records:[],documents:[],operations:[operation("z",a,b,"2026-10-01"),operation("a",b,c,"2026-10-02"),operation("b",c,a,"2026-10-03")]});
  assert.ok(result.risks.some(r=>r.code==="RAPID_EQUAL_AMOUNT_TRANSFERS"&&r.kind==="signal"));assert.equal(result.risks.filter(r=>r.code==="CIRCULAR_THREE_PARTY_PAYMENTS").length,1);
});
test("ошибки сохранённых формул и отсутствие подтверждения возврата не скрываются",()=>{const s=setup();try{
  s.add([row({groupId:"reimbursement",type:"reimbursement"})]);assert.ok(caseAnalysis(s.db,s.parent.id).risks.some(r=>r.code==="REFUND_NOT_VERIFIED"&&r.kind==="data_quality"));
  const result=evaluateCaseRules({records:[],operations:[],documents:[{id:"d",name:"test.xlsx",summary:{formulaAudit:{errorCount:1,errors:[{sheet:"S",cell:"A1",error:"#N/A"}]}}}]});assert.equal(result.risks[0].code,"WORKBOOK_FORMULA_ERRORS");
}finally{s.close();}});
test("scoped API не подменяет неизвестное дело общей базой",async()=>{const s=setup(),old=process.env.VESTIGO_DATA_DIR;try{
  process.env.VESTIGO_DATA_DIR=path.dirname(s.db.prepare("PRAGMA database_list").all().find(r=>r.name==="main").file);
  const response=handleCaseAnalytics(new Request("http://localhost/api/entities?caseId=missing"),"entities");assert.equal(response.status,404);
  assert.equal(handleCaseAnalytics(new Request("http://localhost/api/entities"),"entities"),null);
}finally{if(old===undefined)delete process.env.VESTIGO_DATA_DIR;else process.env.VESTIGO_DATA_DIR=old;s.close();}});
test("пересчёт правил сохраняет подтверждение неизменённой операции и журналирует запуск",()=>{const s=setup();try{
  rebuildCaseAnalysis(s.db,s.other.id);assert.equal(caseAnalysis(s.db,s.other.id).operationCount,0);
  s.add([row()]);const id=caseAnalysis(s.db,s.parent.id).operations[0].id;reviewCaseItem(s.db,s.parent.id,{kind:"operation",id,status:"confirmed",note:"Сверено"});rebuildCaseAnalysis(s.db,s.parent.id);
  const result=caseAnalysis(s.db,s.parent.id);assert.equal(result.operations[0].confirmed,true);assert.ok(result.history.some(h=>h.action==="case.analysis_rebuilt"));
  changeCaseStatus(s.db,s.parent.id,"archived");assert.throws(()=>rebuildCaseAnalysis(s.db,s.parent.id),/архиве/);
}finally{s.close();}});
