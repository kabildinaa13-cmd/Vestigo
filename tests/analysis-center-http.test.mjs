import test from "node:test";import assert from "node:assert/strict";import fs from "node:fs";import os from "node:os";import path from "node:path";import {spawn,spawnSync} from "node:child_process";
import {createAuthenticatedFetch,TEST_SETUP_TOKEN} from "./authenticated-fetch.mjs";
const fetch=createAuthenticatedFetch(),A="990000000001",B="020000000002";
test("analysis center: real XLSX uploads → queue → counterparties → discrepancy → exact sources → audited decisions → rebuild and removal",{timeout:150000},async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),"vestigo-center-http-")),env={...process.env,VESTIGO_DATA_DIR:directory,VESTIGO_SETUP_TOKEN:TEST_SETUP_TOKEN,VESTIGO_SITE_PORT:"3295"},children=[];let logs="";const base="http://localhost:3295";
 const start=args=>{const p=spawn(process.execPath,args,{cwd:process.cwd(),env,windowsHide:true,stdio:["ignore","pipe","pipe"]});p.stdout.on("data",v=>logs=(logs+v).slice(-6000));p.stderr.on("data",v=>logs=(logs+v).slice(-6000));children.push(p);return p;};
 const get=async route=>{const r=await fetch(base+route),p=await r.json();assert.ok(r.ok,JSON.stringify(p));return p;};
 const post=async(route,body,method="POST")=>{const r=await fetch(base+route,{method,headers:{"content-type":"application/json"},body:JSON.stringify(body)}),p=await r.json();assert.ok(r.ok,JSON.stringify(p));return p;};
 try{
  const server=start(["node_modules/vinext/dist/cli.js","dev","--port","3295"]);let ready=false;for(let i=0;i<80;i++){if(server.exitCode!==null)throw Error(logs);try{if((await globalThis.fetch(base+"/api/auth/session",{signal:AbortSignal.timeout(1000)})).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,250));}assert.ok(ready,logs);
  assert.equal((await globalThis.fetch(base+"/api/analysis-center?caseId=unknown")).status,401);
  const caseId=(await post("/api/cases",{caseNumber:"CENTER-SYNTHETIC"})).case.id,other=(await post("/api/cases",{caseNumber:"ISOLATED"})).case.id;
  const upload=async(name,bytes)=>{const form=new FormData();form.set("caseId",caseId);form.set("groupId","unclassified");form.set("typeId","unclassified");form.set("classificationMode","auto");form.set("processInBackground","true");form.set("file",new Blob([bytes]),name);const r=await fetch(base+"/api/documents",{method:"POST",body:form}),p=await r.json();assert.ok(r.ok,JSON.stringify(p));return p;};
  const purchase=await upload("Приобретение синтетика.xlsx",fs.readFileSync("tests/fixtures/esf-89/purchase.xlsx")),sale=await upload("Реализация синтетика.xlsx",fs.readFileSync("tests/fixtures/esf-89/sale.xlsx"));
  const bankCsv=`Дата;БИН владельца счета;БИН контрагента;Наименование контрагента;Дебет;Кредит;Номер документа;Назначение платежа;Валюта\n02.10.2026;${A};${B};ТОО Синтетический поставщик;60,00;0;PAY-CENTER;Оплата SYN-P1;KZT`;
  const bank=await upload("bank.csv",Buffer.from(bankCsv));start(["scripts/processing-worker.mjs"]);
  const wait=async count=>{let jobs;for(let i=0;i<180;i++){jobs=await get(`/api/processing-jobs?caseId=${caseId}`);if((jobs.counts.completed||0)+(jobs.counts.failed||0)===count)return jobs;await new Promise(r=>setTimeout(r,250));}throw Error(JSON.stringify(jobs)+logs);};
  let jobs=await wait(3);assert.equal(jobs.counts.completed,3,JSON.stringify(jobs));
  const center=extra=>get(`/api/analysis-center?caseId=${caseId}${extra||""}`),summary=await center();assert.equal(summary.counts.documents,3);assert.equal(summary.counts.esf,9);assert.equal(summary.counts.goodsRows,14);assert.equal(summary.counts.bankOperations,1);assert.equal(summary.totals.bankTransfers.KZT,"6000");
  const parties=await center("&view=counterparties");assert.ok(parties.total>=5);assert.equal(parties.items.filter(p=>p.identifier===B).length,1);
  const party=await center(`&view=counterparty&identifier=${A}`);assert.equal(party.purchase.KZT,"40000");assert.equal(party.sale.KZT,"38000");assert.equal(party.bankOutgoing.KZT,"6000");assert.ok(party.sources.some(s=>s.documentId===bank.id));
  const card=await center(`&view=document&documentId=${purchase.id}`);assert.equal(card.total,4);assert.equal(Object.keys(card.rows[0].raw).length,89);assert.equal(card.sourceSnapshot,true);
  const raw=await center(`&view=document&documentId=${purchase.id}&mode=source`);assert.equal(raw.total,5);assert.equal(raw.sourceRows[0].row,1);assert.equal(raw.sourceRows[1].values.length,89);
  const byQuery=await center(`&view=document&documentId=${purchase.id}&q=SYN-P1&sort=amountMinor&order=desc`);assert.ok(byQuery.total>0);
  const risks=await center("&view=discrepancies"),risk=risks.items.find(r=>r.code==="PAYMENT_AMOUNT_DIFFERENCE");assert.ok(risk,JSON.stringify(risks));assert.equal(risk.calculation.differenceMinor,"-4000");
  const review=await center(`&view=review&riskId=${risk.id}`);assert.ok(review.sources.every(s=>s.record));assert.ok(review.sources.some(s=>s.fields.amount?.cell==="CB2"));assert.ok(review.sources.some(s=>s.documentId===bank.id));
  await post("/api/analysis-center",{caseId,action:"risk",id:risk.id,fingerprint:risk.fingerprint,status:"checking",note:"Сверяем частичную оплату"});
  const i=review.matchCandidates.find(o=>o.number==="SYN-P1"),p=review.matchCandidates.find(o=>o.type==="payment");
  await post("/api/analysis-center",{caseId,action:"match",leftId:i.id,rightId:p.id,leftFingerprint:i.fingerprint,rightFingerprint:p.fingerprint,status:"confirmed",note:"Выбрана соответствующая ЭСФ"});assert.ok((await center()).matches.some(m=>m.method==="manual_confirmed"));
  const duplicate=await upload("copy.xlsx",fs.readFileSync("tests/fixtures/esf-89/purchase.xlsx"));assert.equal(duplicate.duplicate,true);assert.equal((await center()).counts.esf,9);
  await post("/api/case-analysis",{caseId,action:"rebuild"});assert.equal((await center()).reviews[0].stale,false);
  const exported=await fetch(base+`/api/analysis-center?caseId=${caseId}&view=document&documentId=${purchase.id}&format=json`);assert.equal(exported.status,200);const source=await exported.json();assert.equal(source.sourceRows.length,5);assert.equal(source.rows.length,4);
  const csv=await fetch(base+`/api/analysis-center?caseId=${caseId}&documentId=${purchase.id}&format=csv`);assert.match(await csv.text(),/Регистрационный номер ЭСФ/);
  assert.equal((await fetch(base+`/api/analysis-center?caseId=${other}&view=document&documentId=${purchase.id}`)).status,404);assert.equal((await get(`/api/analysis-center?caseId=${other}`)).counts.counterparties,0);
  const denied=await fetch(base+"/api/analysis-center",{method:"POST",headers:{"content-type":"application/json",origin:"https://outside.invalid"},body:JSON.stringify({caseId,action:"risk"})});assert.equal(denied.status,403);
  await post(`/api/documents/${bank.id}`,{caseId,note:"Synthetic removal"},"DELETE");assert.equal((await center()).counts.bankOperations,0);assert.equal((await center()).checks.rules[0].status,"insufficient_data");assert.ok((await center()).reviews[0].stale);
  await post("/api/case-analysis",{caseId,id:bank.id,kind:"document",status:"active",note:"Synthetic restoration"});assert.equal((await center()).counts.bankOperations,1);
  const history=await center("&view=history");assert.ok(history.items.some(h=>h.kind==="match_confirmed"));assert.ok(history.items.some(h=>h.status==="checking"));assert.ok(history.items.every(h=>h.action===undefined&&h.details===undefined));
  const broken=await upload("broken.json",Buffer.from("{broken"));
  let brokenJob;for(let attempt=0;attempt<180;attempt++){jobs=await get(`/api/processing-jobs?caseId=${caseId}`);brokenJob=jobs.jobs.find(job=>job.documentId===broken.id);if(['failed','completed'].includes(brokenJob?.state))break;await new Promise(r=>setTimeout(r,250));}
  assert.equal(brokenJob?.state,"failed");assert.equal((await center()).checks.rules[0].status,"processing_error");assert.ok((await center()).documents.find(d=>d.id===broken.id).error);
  console.log("CENTER HTTP: XLSX×2 + CSV; 9 unique invoices / 14 rows; partial payment 60.00 vs invoice 100.00 => −40.00 KZT; exact CB2 source; decisions audited; re-analysis/removal/isolation/auth verified.");
 }finally{for(const p of children.reverse())if(p.exitCode===null){if(process.platform==="win32")spawnSync("taskkill",["/PID",String(p.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});else p.kill();}await new Promise(r=>setTimeout(r,800));fs.rmSync(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});
