import test from "node:test";import assert from "node:assert/strict";import fs from "node:fs";import os from "node:os";import path from "node:path";
import {openDatabase,createCase} from "../app/lib/vestigo-db.mjs";import {saveDocument} from "../app/lib/documents.mjs";import {storeExtraction,reviewCaseItem} from "../app/lib/case-analysis.mjs";import {createCalculation,calculationWorkspace,createCaseReport,getCaseReport} from "../app/lib/case-calculations.mjs";import {caseAnalyticsDataset} from "../app/lib/case-analytics.mjs";
test("calculation snapshots survive source exclusion; foreign, conflicting and mixed-currency inputs are rejected",()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"vestigo-calculation-")),db=openDatabase({dataDirectory:dir});try{
  const c=createCase(db,{caseNumber:"SYNTHETIC-CALC"}),other=createCase(db,{caseNumber:"OTHER-CALC"}),d=saveDocument(db,{caseId:c.id,name:"synthetic.csv",bytes:Buffer.from("synthetic"),groupId:"bank",typeId:"statement"});
  const base={sheet:"CSV",type:"payment",row:2,senderId:"IBAN:KZ86125KZT5004100100",recipientId:"IBAN:DE89370400440532013000",date:"2026-10-01",currency:"KZT",amountMinor:10001,number:"PAY-1",raw:{}};
  storeExtraction(db,c.id,d.id,{status:"extracted",version:1,rows:[base,{...base,row:3,currency:"USD",number:"PAY-2"},{...base,type:"invoice",row:4,number:"ESF-1",amountMinor:10000,senderId:base.recipientId,recipientId:base.senderId}],tables:[],text:"",pages:[],warnings:[],unparsedRows:0});
  const workspace=calculationWorkspace(db,c.id),first=workspace.operations.find(o=>o.currency==="KZT"&&o.type==="payment");assert.equal(caseAnalyticsDataset(db,c.id).nodes.length,2);
  const invoice=workspace.operations.find(o=>o.type==="invoice");
  const input={operationIds:[first.id,first.id,invoice.id],method:"payments_minus_invoices",name:"Первичная разница",rationale:"Только синтетические данные"};
  assert.throws(()=>createCalculation(db,c.id,{...input,operationIds:[first.id]}),/обе стороны/);
  const saved=createCalculation(db,c.id,input);assert.equal(saved.differenceMinor,"1");assert.equal(saved.operationCount,2);
  assert.throws(()=>createCalculation(db,other.id,input),/чужая/);assert.throws(()=>createCalculation(db,c.id,{...input,operationIds:workspace.operations.map(o=>o.id)}),/валют/);
  const report=createCaseReport(db,c.id);assert.throws(()=>getCaseReport(db,other.id,report.id),/не найден/);
  reviewCaseItem(db,c.id,{kind:"document",id:d.id,status:"excluded",note:"Синтетическое исключение"});assert.equal(calculationWorkspace(db,c.id).operations.length,0);assert.equal(calculationWorkspace(db,c.id).versions[0].differenceMinor,"1");assert.equal(getCaseReport(db,c.id,report.id).operations.length,3);
 }finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}
});
