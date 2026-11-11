import {createAuthenticatedFetch,TEST_SETUP_TOKEN} from "./authenticated-fetch.mjs";
const fetch=createAuthenticatedFetch();
import test from "node:test";import assert from "node:assert/strict";
import fs from "node:fs";import os from "node:os";import path from "node:path";
import {spawn,spawnSync} from "node:child_process";import {once} from "node:events";
test("real HTTP pipeline: DOCX 12m + bank CSV 12m + XLSX ESF 8m -> 4m discrepancy, immutable calculations and real Excel report",{timeout:150000},async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),"vestigo-core-http-")),env={...process.env,VESTIGO_SETUP_TOKEN:TEST_SETUP_TOKEN,VESTIGO_DATA_DIR:directory,VESTIGO_OCR_DISABLED:"1"},children=[];let logs="";
 const python=process.env.VESTIGO_PYTHON||path.resolve(".venv/Scripts/python.exe");
 const fixturesRun=spawnSync(python,["tests/make_audit_fixtures.py"],{encoding:"utf8",windowsHide:true});assert.equal(fixturesRun.status,0,fixturesRun.stderr);const fixtures=JSON.parse(fixturesRun.stdout);
 const start=args=>{const p=spawn(process.execPath,args,{cwd:process.cwd(),env,windowsHide:true,stdio:["ignore","pipe","pipe"]});p.stdout.on("data",v=>logs=(logs+v).slice(-5000));p.stderr.on("data",v=>logs=(logs+v).slice(-5000));children.push(p);return p;};
 const server=start([path.resolve("node_modules/vinext/dist/cli.js"),"dev","--port","3297"]),base="http://localhost:3297";
 const get=async url=>{const r=await fetch(base+url);const p=await r.json();assert.ok(r.ok,JSON.stringify(p));return p;};
 const post=async(url,body)=>{const r=await fetch(base+url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});const p=await r.json();assert.ok(r.ok,JSON.stringify(p));return p;};
 try{
  let ready=false;for(let i=0;i<60;i++){if(server.exitCode!==null)throw new Error(logs);try{if((await fetch(base+"/api/dashboard",{signal:AbortSignal.timeout(1000)})).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,250));}assert.ok(ready,logs);
  const caseId=(await post("/api/cases",{caseNumber:"SYNTHETIC-15"})).case.id;
  const upload=async(name,bytes,fields={})=>{const form=new FormData();form.set("caseId",caseId);form.set("groupId","unclassified");form.set("typeId","unclassified");form.set("classificationMode","auto");form.set("processInBackground","true");for(const[k,v]of Object.entries(fields))form.set(k,v);form.set("file",new Blob([bytes]),name);const r=await fetch(base+"/api/documents",{method:"POST",body:form});const p=await r.json();assert.ok(r.ok,JSON.stringify(p));return p;};
  const contract=await upload("contract-15.docx",Buffer.from(fixtures.contract,"base64")),invoice=await upload("invoice-15.xlsx",Buffer.from(fixtures.invoice,"base64"));
  const csv="Дата;БИН владельца счета;БИН контрагента;Наименование контрагента;Дебет;Кредит;Номер документа;Назначение платежа;Валюта\n03.10.2026;990000000002;990000000001;ТОО Синтетический поставщик;12000000,00;0;PAY-15;Оплата по договору № 15;KZT";
  const payment=await upload("bank-15.csv",Buffer.from(csv));start(["scripts/processing-worker.mjs"]);
  const wait=async expected=>{let jobs;for(let i=0;i<180;i++){jobs=await get(`/api/processing-jobs?caseId=${caseId}`);if((jobs.counts.completed||0)+(jobs.counts.failed||0)===expected)return jobs;await new Promise(r=>setTimeout(r,250));}throw new Error("Timeout: "+JSON.stringify(jobs)+logs);};
  let jobs=await wait(3);assert.equal(jobs.counts.completed,3,JSON.stringify(jobs));
  const a=await get(`/api/case-analysis?caseId=${caseId}`);assert.equal(a.documents.length,3);assert.equal(a.operationCount,3);assert.ok(a.matches.length>=3,JSON.stringify(a.matches));
  const risk=a.risks.find(r=>r.code==="PAYMENT_AMOUNT_DIFFERENCE");assert.ok(risk,JSON.stringify(a.risks));assert.equal(risk.calculation.differenceMinor,"400000000");assert.equal(risk.status,"detected");assert.equal(new Set(risk.evidence.map(s=>s.documentId)).size,2);
  const bank=await get(`/api/bank-analysis?caseId=${caseId}`);assert.equal(bank.counterpartyCount,1);assert.equal(bank.summaries[0].outgoingMinor,"1200000000");
  const extraction=await get(`/api/case-analysis?caseId=${caseId}&documentId=${invoice.id}`);assert.equal(extraction.rows[0].attributes.fieldSources.amount.cell,"C2");
  const operationIds=a.operations.filter(o=>o.type!=="contract").map(o=>o.id);
  const calculation=await post("/api/calculations",{caseId,operationIds:[...operationIds,...operationIds],name:"Сравнение 15",method:"payments_minus_invoices",rationale:"Синтетический тест по договору 15"});assert.equal(calculation.differenceMinor,"400000000");assert.equal(calculation.operationCount,2);assert.equal(calculation.classification,"preliminary_difference");
  const report=await post("/api/reports",{caseId}),snapshot=await get(`/api/reports?caseId=${caseId}&id=${report.id}`);assert.equal(snapshot.calculations.length,1);assert.equal(snapshot.operations.length,3);
  const excel=await fetch(base+`/api/reports?caseId=${caseId}&id=${report.id}&format=xlsx`);assert.equal(excel.status,200,await excel.clone().text());const bytes=Buffer.from(await excel.arrayBuffer());assert.equal(bytes.subarray(0,2).toString(),"PK");
  const verify=spawnSync(python,["-c","import sys,io;from openpyxl import load_workbook;b=load_workbook(io.BytesIO(sys.stdin.buffer.read()));assert set(['Сводка','Документы','Операции','Источники','Сопоставление','Вопросы проверки','Расчёты']).issubset(b.sheetnames),b.sheetnames;assert b['Расчёты']['G2'].value=='400000000';assert not any(c.data_type=='f' for s in b for row in s for c in row);print('xlsx verified')"],{input:bytes,windowsHide:true});assert.equal(verify.status,0,String(verify.stderr));
  const again=await upload("bank-copy.csv",Buffer.from(csv));assert.equal(again.duplicate,true);assert.equal((await get(`/api/case-analysis?caseId=${caseId}`)).operationCount,3);
  const corrupt=await upload("broken.json",Buffer.from("{broken")),empty=await upload("empty.pdf",Buffer.from(fixtures.blankPdf,"base64")),encrypted=await upload("encrypted.pdf",Buffer.from(fixtures.encryptedPdf,"base64"));
  const ending=new Set([corrupt.id,empty.id,encrypted.id]);let endingJobs=[];
  for(let attempt=0;attempt<180;attempt++){jobs=await get(`/api/processing-jobs?caseId=${caseId}`);endingJobs=jobs.jobs.filter(job=>ending.has(job.documentId));if(endingJobs.length===3&&endingJobs.every(job=>["completed","failed"].includes(job.state)))break;await new Promise(r=>setTimeout(r,250));}
  assert.equal(endingJobs.find(j=>j.documentId===corrupt.id)?.state,"failed");assert.equal(endingJobs.find(j=>j.documentId===encrypted.id)?.state,"failed");assert.equal(endingJobs.find(j=>j.documentId===empty.id)?.result.summary.status,"needs_ocr");
  const otherId=(await post("/api/cases",{caseNumber:"ISOLATED"})).case.id;const denied=await fetch(base+`/api/reports?caseId=${otherId}&id=${report.id}`);assert.equal(denied.status,404);assert.equal((await get(`/api/bank-analysis?caseId=${otherId}`)).total,0);
  const before=await get(`/api/calculations?caseId=${caseId}`);assert.equal(before.versions[0].differenceMinor,"400000000");
 }finally{for(const p of children.reverse())if(p.exitCode===null){const done=once(p,"exit");if(process.platform==="win32")spawnSync("taskkill",["/PID",String(p.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});else p.kill();await Promise.race([done,new Promise(r=>setTimeout(r,1500))]);}fs.rmSync(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});
