import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {openDatabase,createCase} from "../app/lib/vestigo-db.mjs";
import {saveDocument} from "../app/lib/documents.mjs";
import {storeExtraction,caseAnalysis} from "../app/lib/case-analysis.mjs";
import {analyzePdfResult,extractTextCandidates} from "../app/lib/pdf-analysis.mjs";
const result=()=>({version:1,status:"review",rows:[],tables:[],warnings:[],pages:[{page:1,text:"Платежное поручение\nБИН отправителя: 990000000001\nБИН получателя: 990000000002\nДата платежа: 20.10.2026\nСумма платежа: 1 000,01\nВалюта: KZT\nНазначение платежа: Оплата по договору № CON-1",textSource:"ocr",ocr:{engine:"test-local",kazakhAvailable:false}},{page:2,text:"Договор поставки № CON-1\nСтороны договора"},{page:3,text:"4. Права сторон. 5. Ответственность."},{page:4,text:"АКТ СВЕРКИ взаимных расчетов"}],pageAudit:{totalPages:4,pagesWithText:4,pagesWithoutText:[],ocrPerformed:true}});
test("OCR-разбор автоматически включает полные подписанные реквизиты, не выдумывает остальные",()=>{
  const r=analyzePdfResult(result());assert.equal(r.documentAnalysis.total,3);assert.deepEqual(r.documentAnalysis.segments.map(s=>[s.from,s.to]),[[1,1],[2,3],[4,4]]);
  assert.equal(r.documentAnalysis.segments[0].groupId,"bank");assert.equal(r.documentAnalysis.segments[0].fields.senderId,"990000000001");assert.equal(r.documentAnalysis.segments[0].fields.amount,"1 000,01");assert.equal(r.documentAnalysis.segments[0].fields.date,"2026-10-20");
  assert.equal(r.rows[0].type,"payment");assert.equal(r.rows[0].manualSource,false);assert.equal(r.rows[0].automaticSource,true);assert.ok(r.rows.slice(1).every(row=>row.type==="context"));assert.equal(r.documentAnalysis.automaticallyExtracted,1);assert.equal(r.documentAnalysis.ocrPages,1);assert.equal(r.documentAnalysis.kazakhAvailable,false);assert.equal(r.documentAnalysis.links.length,1);
});
test("только сверенные полные реквизиты становятся операцией, акт сверки остаётся контекстом",()=>{
  const first=analyzePdfResult(result()),defs=first.documentAnalysis.segments.map(s=>({...s}));defs[0].approved=true;defs[0].note="Проверено по оригиналу";defs[0].fields={...defs[0].fields,number:"PAY-1"};defs[2].approved=true;defs[2].note="Сверен акт";
  const r=analyzePdfResult(result(),{segmentReviewDigest:first.documentAnalysis.sourceDigest,segmentReviews:defs});assert.equal(r.rows[0].type,"payment");assert.equal(r.rows[0].amountMinor,100001);assert.equal(r.rows[0].attributes.sourcePage,1);assert.equal(r.rows[1].type,"context");assert.equal(r.rows[2].type,"context");assert.equal(r.documentAnalysis.reviewed,2);
});
test("границы без потерь/пересечений, устаревшая сверка и некорректные поля отклоняются",()=>{
  const first=analyzePdfResult(result()),opts={segmentReviewDigest:first.documentAnalysis.sourceDigest,segmentReviews:first.documentAnalysis.segments.map(s=>({...s}))};
  assert.throws(()=>analyzePdfResult(result(),{...opts,segmentReviewDigest:"old"}),/изменились/);
  assert.throws(()=>analyzePdfResult(result(),{...opts,segmentReviews:opts.segmentReviews.slice(0,1)}),/Все страницы/);
  assert.throws(()=>analyzePdfResult(result(),{...opts,segmentReviews:[{...opts.segmentReviews[0],to:3},...opts.segmentReviews.slice(1)]}),/пересекаются/);
  assert.throws(()=>analyzePdfResult(result(),{...opts,segmentReviews:[{...opts.segmentReviews[0],approved:true,note:"Проверено",fields:{...opts.segmentReviews[0].fields,date:"2026-02-31",number:"P-1"}},...opts.segmentReviews.slice(1)]}),/нужны/);
});
test("кандидаты не исправляют O на 0, не берут цифры из IBAN и не выбирают сумму НДС",()=>{
  const r=extractTextCandidates("KZ9900000000017777 990000000002 ESF-990000000001-20260101-12345 20 ООО ООO.ОО 120,00 НДС 12,00 31.02.2026");assert.deepEqual(r.identifiers,["990000000002","990000000001"]);assert.deepEqual(r.dates,[]);assert.deepEqual(r.amounts,["120,00","12,00"]);
  const v=result();v.pages[0].text="Платежное поручение\nСумма платежа: 100,00\nСумма платежа: 200,00";assert.equal(analyzePdfResult(v).documentAnalysis.segments[0].fields.amount,"");
});
test("сверенные документы PDF доходят до существующих операций и аналитики без дублей",()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"vestigo-pdf-flow-")),db=openDatabase({dataDirectory:directory});try{
    const parent=createCase(db,{caseNumber:"PDF-FLOW"}),doc=saveDocument(db,{caseId:parent.id,name:"synthetic.txt",bytes:Buffer.from("synthetic-pages"),groupId:"unclassified",typeId:"mixed_bundle"});
    const first=analyzePdfResult(result()),reviews=first.documentAnalysis.segments.map(s=>({...s}));reviews[0]={...reviews[0],approved:true,note:"Сверено по оригиналу",fields:{...reviews[0].fields,number:"PAY-1"}};
    const analyzed=analyzePdfResult(result(),{segmentReviewDigest:first.documentAnalysis.sourceDigest,segmentReviews:reviews});
    for(let i=0;i<2;i++)storeExtraction(db,parent.id,doc.id,analyzed,{groupId:"unclassified",typeId:"mixed_bundle"});
    const output=caseAnalysis(db,parent.id);assert.equal(output.operationCount,1);assert.equal(output.operations[0].number,"PAY-1");assert.equal(output.operations[0].confirmed,false);assert.equal(output.operations[0].sources[0].sheet,"PDF 1–1");assert.ok(output.risks.some(r=>r.code==="PDF_SEGMENTS_REQUIRE_REVIEW"));
  }finally{db.close();fs.rmSync(directory,{recursive:true,force:true});}
});
