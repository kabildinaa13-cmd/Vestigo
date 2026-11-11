import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase,createCase,changeCaseStatus } from "../app/lib/vestigo-db.mjs";
import {saveDocument} from "../app/lib/documents.mjs";
import {storeExtraction,caseAnalysis,reviewCaseItem,getExtraction,extractOriginal} from "../app/lib/case-analysis.mjs";
function setup(){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"vestigo-case-test-")),db=openDatabase({dataDirectory:directory});
  const a=createCase(db,{caseNumber:"CASE-A"}),b=createCase(db,{caseNumber:"CASE-B"});
  const document=(name="test.csv",caseId=a.id,bytes=Buffer.from(`test ${Math.random()}`))=>saveDocument(db,{caseId,groupId:"primary",typeId:"invoice",name,bytes});
  const finish=()=>{db.close();fs.rmSync(directory,{recursive:true,force:true});};
  return {db,a,b,document,finish};
}
function row(overrides={}){return {sheet:"Лист1",row:2,type:"invoice",senderId:"990000000001",recipientId:"990000000002",senderName:"Тестовый поставщик",recipientName:"Тестовый покупатель",date:"2026-10-01",amountMinor:123456,currency:"KZT",number:"ESF-TEST-1",reference:"",purpose:"Поставка",amountBasis:"document_total",status:"CREATED",raw:{number:"ESF-TEST-1",line:"1"},...overrides};}
function extracted(rows,status="extracted"){return {version:1,status,rows,tables:[],warnings:[],text:"",pages:[],unparsedRows:rows.filter(r=>!r.senderId||!r.recipientId||r.amountMinor===null).length};}

test("дела изолированы, повторная обработка и одинаковая ЭСФ в разных файлах не удваивают операции",()=>{
  const s=setup();try{
    const d=s.document();storeExtraction(s.db,s.a.id,d.id,extracted([row(),row({row:3})]));
    assert.equal(caseAnalysis(s.db,s.a.id).operationCount,1);assert.equal(caseAnalysis(s.db,s.b.id).operationCount,0);
    const original=caseAnalysis(s.db,s.a.id).operations[0];
    assert.equal(original.amountMinor,123456);assert.equal(original.sources.length,2);assert.equal(original.confirmed,false);
    storeExtraction(s.db,s.a.id,d.id,extracted([row(),row({row:3})]));
    assert.equal(caseAnalysis(s.db,s.a.id).operations[0].id,original.id);
    const other=s.document("copy.csv");storeExtraction(s.db,s.a.id,other.id,extracted([row()]));
    assert.equal(caseAnalysis(s.db,s.a.id).operationCount,1);
    assert.equal(caseAnalysis(s.db,s.a.id).operations[0].sources.length,3);
    assert.throws(()=>getExtraction(s.db,s.b.id,d.id),/ещё не выполнялось/);
  }finally{s.finish();}
});
test("конфликт суммы не скрывается, блокирует подтверждение и снимает прежнее подтверждение",()=>{
  const s=setup();try{
    const d=s.document();storeExtraction(s.db,s.a.id,d.id,extracted([row()]));
    const id=caseAnalysis(s.db,s.a.id).operations[0].id;
    reviewCaseItem(s.db,s.a.id,{kind:"operation",id,status:"confirmed",note:"Сверено с оригиналом"});
    assert.equal(caseAnalysis(s.db,s.a.id).operations[0].confirmed,true);
    const changed=s.document();storeExtraction(s.db,s.a.id,changed.id,extracted([row({amountMinor:99999})]));
    const result=caseAnalysis(s.db,s.a.id);
    assert.equal(result.operations[0].conflict,true);assert.equal(result.operations[0].confirmed,false);
    assert.ok(result.risks.some(r=>r.code==="CONFLICTING_DOCUMENT"&&r.evidence.length===2));
    assert.throws(()=>reviewCaseItem(s.db,s.a.id,{kind:"operation",id,status:"confirmed",note:"Попытка"}),/Конфликтную/);
  }finally{s.finish();}
});
test("сопоставление платежа с ЭСФ по номеру, сторонам и валюте; обоснование и аудит",()=>{
  const s=setup();try{
    const invoice=s.document(),payment=s.document("bank.csv");
    storeExtraction(s.db,s.a.id,invoice.id,extracted([row()]));
    storeExtraction(s.db,s.a.id,payment.id,extracted([row({type:"payment",number:"PAY-1",senderId:"990000000002",recipientId:"990000000001",purpose:"Оплата по ESF-TEST-1",amountMinor:100000})]));
    const result=caseAnalysis(s.db,s.a.id);assert.equal(result.matches.length,1);
    assert.equal(result.matches[0].method,"document_reference");assert.ok(result.risks.some(r=>r.code==="PAYMENT_AMOUNT_DIFFERENCE"));
    const risk=result.risks.find(r=>r.code==="PAYMENT_AMOUNT_DIFFERENCE");
    reviewCaseItem(s.db,s.a.id,{kind:"risk",id:risk.id,status:"insufficient_data",note:"Запрошена полная выписка"});
    assert.equal(caseAnalysis(s.db,s.a.id).risks.find(r=>r.id===risk.id).status,"insufficient_data");
    assert.ok(s.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='case.analysis_reviewed'").get().n);
    assert.throws(()=>reviewCaseItem(s.db,s.b.id,{kind:"risk",id:risk.id,status:"closed",note:"Чужое дело"}),/не найден/);
  }finally{s.finish();}
});
test("неоднозначное совпадение и неполный комплект не объявляются доказанным нарушением",()=>{
  const s=setup();try{
    const d=s.document();storeExtraction(s.db,s.a.id,d.id,extracted([row(),row({number:"ESF-TEST-2",row:3})]));
    assert.equal(caseAnalysis(s.db,s.a.id).risks.some(r=>r.code==="NO_PAYMENT_MATCH"),false);
    const p=s.document();storeExtraction(s.db,s.a.id,p.id,extracted([row({type:"payment",number:"PAY",senderId:"990000000002",recipientId:"990000000001"})]));
    const result=caseAnalysis(s.db,s.a.id);assert.equal(result.matches.length,0);assert.ok(result.risks.some(r=>r.code==="AMBIGUOUS_MATCH"));
    assert.ok(result.risks.find(r=>r.code==="NO_PAYMENT_MATCH").rule.includes("Не доказывает"));
  }finally{s.finish();}
});
test("исключённые ЭСФ и неполные строки не становятся операциями; все строки доступны",()=>{
  const s=setup();try{
    const d=s.document();storeExtraction(s.db,s.a.id,d.id,extracted([row({status:"REVOKED"}),row({row:3,recipientId:""})]));
    assert.equal(caseAnalysis(s.db,s.a.id).operationCount,0);assert.equal(getExtraction(s.db,s.a.id,d.id).rows.length,2);
    assert.ok(caseAnalysis(s.db,s.a.id).risks.some(r=>r.code==="INCOMPLETE_EXTRACTION"));
    changeCaseStatus(s.db,s.a.id,"archived");
    assert.throws(()=>storeExtraction(s.db,s.a.id,d.id,extracted([])),/архиве/);
  }finally{s.finish();}
});
test("без номера равные платежи не сливаются; разные валюты не сопоставляются",()=>{
  const s=setup();try{
    const d=s.document();storeExtraction(s.db,s.a.id,d.id,extracted([row({type:"payment",number:""}),row({type:"payment",number:"",row:3})]));
    const result=caseAnalysis(s.db,s.a.id);assert.equal(result.operationCount,2);assert.ok(!result.risks.some(r=>r.code==="POSSIBLE_DUPLICATE")); // Equality without a document identity does not establish a duplicate.
    const i=s.document();storeExtraction(s.db,s.a.id,i.id,extracted([row({currency:"USD",senderId:"990000000002",recipientId:"990000000001"})]));
    assert.equal(caseAnalysis(s.db,s.a.id).matches.length,0);
  }finally{s.finish();}
});
test("реальный CSV: копейки без округления, регистр, повторные ИИН/БИН, владелец приоб, ручное соответствие",async()=>{
  const s=setup();try{
    const csv="Регистрационный номер ЭСФ;ИИН/БИН;Наименование поставщика по данным ИС ЭСФ;ИИН/БИН;Наименование получателя по данным ИС ЭСФ;Сумма с НДС;Дата выписки\nESF-X;010740002706;ТОО Тест;210440002261;ТОО Покупатель;1234,56;2026-10-01";
    const d=s.document("invoice.csv",s.a.id,Buffer.from(csv));
    const {result}=await extractOriginal(s.db,s.a.id,d.id);
    assert.equal(result.rows[0].senderId,"010740002706");assert.equal(result.rows[0].recipientId,"210440002261");assert.equal(result.rows[0].amountMinor,123456);
    const custom=s.document("210440002261 приоб.csv",s.a.id,Buffer.from("А;Б;В;Г\n010740002706;9,99;2026-10-01;N-1"));
    const parsed=await extractOriginal(s.db,s.a.id,custom.id,{mapping:{senderId:"А",amount:"Б",date:"В",number:"Г"}});
    assert.equal(parsed.result.rows[0].recipientId,"210440002261");assert.equal(parsed.result.rows[0].amountMinor,999);assert.equal(parsed.result.rows[0].inferredOwner,true);
  }finally{s.finish();}
});

test("валюта не выдумывается: UNKNOWN блокирует подтверждение и сопоставление",()=>{
  const s=setup();try{
    const d=s.document();storeExtraction(s.db,s.a.id,d.id,extracted([row({currency:"UNKNOWN"})]));
    const operation=caseAnalysis(s.db,s.a.id).operations[0];
    assert.throws(()=>reviewCaseItem(s.db,s.a.id,{kind:"operation",id:operation.id,status:"confirmed",note:"Проверка"}),/Валюта не указана/);
    const p=s.document();storeExtraction(s.db,s.a.id,p.id,extracted([row({type:"payment",senderId:"990000000002",recipientId:"990000000001",purpose:"ESF-TEST-1"})]));
    assert.equal(caseAnalysis(s.db,s.a.id).matches.length,0);
  }finally{s.finish();}
});
test("противоречащие статусы, получатели и ненумерованные товарные строки не скрываются",()=>{
  const s=setup();try{
    const d=s.document();storeExtraction(s.db,s.a.id,d.id,extracted([row(),row({row:3,status:"REVOKED"})]));
    assert.equal(caseAnalysis(s.db,s.a.id).operations[0].conflict,true);
    storeExtraction(s.db,s.a.id,d.id,extracted([row(),row({row:3,recipientId:"990000000003"})]));
    assert.equal(caseAnalysis(s.db,s.a.id).operationCount,1);assert.equal(caseAnalysis(s.db,s.a.id).operations[0].conflict,true);
    storeExtraction(s.db,s.a.id,d.id,extracted([row({amountBasis:"line"}),row({row:3,amountBasis:"line"})]));
    assert.equal(caseAnalysis(s.db,s.a.id).operations[0].conflict,true);
    storeExtraction(s.db,s.a.id,d.id,extracted([row({amountBasis:"line",lineNumber:"1",raw:{line:"1"}}),row({row:3,amountBasis:"line",lineNumber:"2",raw:{line:"2"}})]));
    const operation=caseAnalysis(s.db,s.a.id).operations[0];assert.equal(operation.amountMinor,246912);assert.equal(operation.conflict,false);
  }finally{s.finish();}
});
