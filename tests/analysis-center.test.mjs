import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";import os from "node:os";import path from "node:path";
import {openDatabase,createCase,changeCaseStatus} from "../app/lib/vestigo-db.mjs";
import {saveDocument} from "../app/lib/documents.mjs";
import {storeExtraction,rebuildCaseAnalysis,reviewCaseItem} from "../app/lib/case-analysis.mjs";
import {analysisCenter,centerReview,exportCenterCsv} from "../app/lib/analysis-center.mjs";
const A="990000000001",B="990000000002",C="990000000003";
function setup(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),"vestigo-center-")),db=openDatabase({dataDirectory:dir}),a=createCase(db,{caseNumber:"CENTER"}),b=createCase(db,{caseNumber:"OTHER"});let count=0;const doc=(name="data.csv")=>saveDocument(db,{caseId:a.id,name,bytes:Buffer.from(`synthetic ${++count}`),groupId:"primary",typeId:"invoice"});return {db,a,b,doc,close:()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});}};}
const row=(patch={})=>({sheet:"Лист 1",row:2,type:"invoice",senderId:A,recipientId:B,senderName:"ТОО Поставщик",recipientName:"ТОО Покупатель",number:"ESF-CENTER-1",date:"2026-10-01",currency:"KZT",amountMinor:10000,amountBasis:"document_total",purpose:"Поставка",status:"CREATED",raw:{"Номер":"ESF-CENTER-1","Сумма":"100.00","Дополнительное поле":"НЕ ТЕРЯТЬ"},...patch});
const extraction=rows=>({version:1,status:"extracted",rows,tables:[],warnings:[],pages:[],text:"",unparsedRows:rows.filter(r=>!r.senderId||!r.recipientId).length});

test("center: source rows, unique counterparties, exact currencies, partial payment, source review, export and case isolation",()=>{
 const s=setup();try{const i=s.doc("invoice.csv"),p=s.doc("bank.csv"),copy=s.doc("other-extract.csv"),unknown=s.doc("incomplete.csv");
 const invoice=extraction([row()]);invoice.sourceTables=[{sheet:"Лист 1",sheetNumber:1,columns:["Номер","Сумма","Дополнительное поле"],rows:[{row:1,values:["Заголовок файла","","Поле вне заголовка"]},{row:2,values:["ESF-CENTER-1","100.00","НЕ ТЕРЯТЬ"]}]}];
 storeExtraction(s.db,s.a.id,i.id,invoice);storeExtraction(s.db,s.a.id,copy.id,extraction([row({raw:{"Сумма":"100.00","Другая выгрузка":"да"}})]));
 storeExtraction(s.db,s.a.id,p.id,extraction([row({type:"payment",senderId:B,recipientId:A,number:"PAY-1",purpose:"Оплата ESF-CENTER-1",amountMinor:6000}),row({row:3,type:"payment",senderId:B,recipientId:C,number:"FEE-1",purpose:"Комиссия банка",amountMinor:100,bank:{kind:"fee"}})]));
 storeExtraction(s.db,s.a.id,unknown.id,extraction([row({senderId:C,recipientId:"",number:"INCOMPLETE",amountMinor:50})]));
 const a=analysisCenter(s.db,s.a.id);assert.equal(a.counts.esf,1);assert.equal(a.counts.counterparties,3);assert.equal(a.totals.supply.KZT,"10000");assert.equal(a.totals.bankTransfers.KZT,"6000");assert.equal(a.totals.bankFees.KZT,"100");assert.equal(a.checks.rules[0].status,"insufficient_data");
 const party=analysisCenter(s.db,s.a.id,{view:"counterparty",identifier:B});assert.equal(party.purchase.KZT,"10000");assert.equal(party.bankOutgoing.KZT,"6000");assert.equal(party.suppliers.length,1);assert.equal(party.documentCount,3);assert.match(party.graphUrl,/bin=/);
 const card=analysisCenter(s.db,s.a.id,{view:"document",documentId:i.id,mode:"source"});assert.equal(card.sourceRows.length,2);assert.equal(card.sourceRows[0].values[2],"Поле вне заголовка");assert.equal(card.sourceSnapshot,true);
 const norm=analysisCenter(s.db,s.a.id,{view:"document",documentId:i.id});assert.equal(norm.rows[0].raw["Дополнительное поле"],"НЕ ТЕРЯТЬ");assert.equal(norm.operations.length,1);
 const risks=analysisCenter(s.db,s.a.id,{view:"discrepancies"}),risk=risks.items.find(r=>r.code==="PAYMENT_AMOUNT_DIFFERENCE");assert.equal(risk.calculation.differenceMinor,"-4000");assert.equal(risk.parties.length,2);const review=analysisCenter(s.db,s.a.id,{view:"review",riskId:risk.id});assert.ok(review.sources.every(s=>s.record));assert.equal(new Set(review.sources.map(s=>s.documentId)).size,3);
 centerReview(s.db,s.a.id,{action:"risk",id:risk.id,fingerprint:risk.fingerprint,status:"checking",note:"Запрос выписки"});assert.equal(analysisCenter(s.db,s.a.id,{view:"review",riskId:risk.id}).issue.status,"checking");
 assert.throws(()=>centerReview(s.db,s.a.id,{action:"risk",id:risk.id,fingerprint:"old",status:"confirmed",note:"stale"}),/изменился/);
 assert.equal(analysisCenter(s.db,s.b.id).counts.esf,0);assert.throws(()=>analysisCenter(s.db,s.b.id,{view:"document",documentId:i.id}),/не относится/);assert.throws(()=>analysisCenter(s.db,s.a.id,{}, {departmentId:"foreign"}),/не найдено/);
 assert.match(exportCenterCsv({rows:[row({raw:{cell:"=HYPERLINK(\"external\")"}})]}),/'=HYPERLINK/);
 }finally{s.close();}
});

test("center: manual matching is audited, rejection applied, refresh stable, changed fingerprints invalidate; no multi-invoice allocation",()=>{
 const s=setup();try{const i=s.doc("invoice.csv"),p=s.doc("bank.csv");
 storeExtraction(s.db,s.a.id,i.id,extraction([row(),row({row:3,number:"ESF-CENTER-2"})]));
 storeExtraction(s.db,s.a.id,p.id,extraction([row({type:"payment",senderId:B,recipientId:A,number:"PAY",purpose:"Оплата",amountMinor:6000})]));
 let review=analysisCenter(s.db,s.a.id,{view:"review",riskId:analysisCenter(s.db,s.a.id,{view:"discrepancies"}).items.find(r=>r.code==="PAYMENT_WITHOUT_LINKED_DOCUMENT").id});
 const first=review.matchCandidates.find(o=>o.number==="ESF-CENTER-1"),second=review.matchCandidates.find(o=>o.number==="ESF-CENTER-2"),payment=review.matchCandidates.find(o=>o.type==="payment");
 const decide=status=>centerReview(s.db,s.a.id,{action:"match",leftId:first.id,rightId:payment.id,leftFingerprint:first.fingerprint,rightFingerprint:payment.fingerprint,status,note:"Сверено с оригиналами"});
 decide("confirmed");assert.equal(analysisCenter(s.db,s.a.id).matches.find(m=>m.rightId===payment.id).method,"manual_confirmed");
 assert.throws(()=>centerReview(s.db,s.a.id,{action:"match",leftId:second.id,rightId:payment.id,leftFingerprint:second.fingerprint,rightFingerprint:payment.fingerprint,status:"confirmed",note:"Нельзя учитывать платёж повторно"}),/уже сопоставлен/);
 rebuildCaseAnalysis(s.db,s.a.id);assert.equal(analysisCenter(s.db,s.a.id).reviews[0].stale,false);
 decide("rejected");assert.ok(!analysisCenter(s.db,s.a.id).matches.some(m=>m.rightId===payment.id));decide("confirmed");
 storeExtraction(s.db,s.a.id,p.id,extraction([row({type:"payment",senderId:B,recipientId:A,number:"PAY",purpose:"Оплата",amountMinor:7000})]));assert.equal(analysisCenter(s.db,s.a.id).reviews[0].stale,true);assert.ok(!analysisCenter(s.db,s.a.id).matches.some(m=>m.method==="manual_confirmed"));
 assert.equal(s.db.prepare("SELECT count(*) n FROM audit_log WHERE action='case.match_reviewed'").get().n,3);
 assert.throws(()=>decide("confirmed"),/изменились/);
 changeCaseStatus(s.db,s.a.id,"archived");assert.throws(()=>centerReview(s.db,s.a.id,{action:"match",leftId:first.id,rightId:payment.id,leftFingerprint:first.fingerprint,rightFingerprint:analysisCenter(s.db,s.a.id,{view:"counterparty",identifier:B}).operations.find(o=>o.id===payment.id).fingerprint,status:"confirmed",note:"Архив"}),/архиве/);
 }finally{s.close();}
});

test("center: zero is not a successful analysis; all four coverage states are explicit",()=>{
 const s=setup();try{assert.equal(analysisCenter(s.db,s.a.id).checks.rules[0].status,"not_run");const i=s.doc(),p=s.doc();storeExtraction(s.db,s.a.id,i.id,extraction([row()]));assert.equal(analysisCenter(s.db,s.a.id).checks.rules[0].status,"insufficient_data");storeExtraction(s.db,s.a.id,p.id,extraction([row({type:"payment",senderId:B,recipientId:A,number:"PAY",purpose:"Оплата ESF-CENTER-1"})]));assert.equal(analysisCenter(s.db,s.a.id).checks.rules[0].status,"no_differences");s.db.prepare("UPDATE case_extractions SET status='failed',error='synthetic parse error' WHERE document_id=?").run(p.id);assert.equal(analysisCenter(s.db,s.a.id).checks.rules[0].status,"processing_error");
 }finally{s.close();}
});
