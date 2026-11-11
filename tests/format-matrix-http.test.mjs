import {createAuthenticatedFetch,TEST_SETUP_TOKEN} from "./authenticated-fetch.mjs";
const fetch=createAuthenticatedFetch();
import test from "node:test";import assert from "node:assert/strict";
import fs from "node:fs";import os from "node:os";import path from "node:path";
import {spawn,spawnSync} from "node:child_process";import {once} from "node:events";
import {encodeUploadMetadata,UPLOAD_METADATA_HEADER} from "../app/lib/upload-protocol.mjs";
test("actual API format matrix: XLSX100/XLS100/CSV/JSON/XML/DOCX/TXT/PDF3/OCR PDF PNG JPEG TIFF/ZIP; exclusion recalculates and preserves original",{timeout:240000},async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),"vestigo-format-matrix-")),env={...process.env,VESTIGO_SETUP_TOKEN:TEST_SETUP_TOKEN,VESTIGO_DATA_DIR:directory,VESTIGO_OCR_CACHE:path.join(directory,"ocr")},children=[];delete env.VESTIGO_OCR_DISABLED;
 const python=process.env.VESTIGO_PYTHON||path.resolve(process.platform==="win32"?".venv/Scripts/python.exe":".venv/bin/python");let logs="";
 const fixtureRun=spawnSync(python,["tests/make_format_matrix.py"],{encoding:"utf8",windowsHide:true,maxBuffer:16*1024*1024});assert.equal(fixtureRun.status,0,fixtureRun.stderr);const fixtures=JSON.parse(fixtureRun.stdout).files;
 const start=args=>{const p=spawn(process.execPath,args,{cwd:process.cwd(),env,windowsHide:true,stdio:["ignore","pipe","pipe"]});p.stdout.on("data",v=>logs=(logs+v).slice(-8000));p.stderr.on("data",v=>logs=(logs+v).slice(-8000));children.push(p);return p;};
 const server=start([path.resolve("node_modules/vinext/dist/cli.js"),"dev","--port","3297"]),base="http://localhost:3297";
 const json=async(url,method="GET",body)=>{const r=await fetch(base+url,{method,...(body?{headers:{"content-type":"application/json"},body:JSON.stringify(body)}:{})});const p=await r.json();assert.ok(r.ok,JSON.stringify(p));return p;};
 try{
  let ready=false;for(let i=0;i<60;i++){if(server.exitCode!==null)throw new Error(logs);try{if((await fetch(base+"/api/dashboard",{signal:AbortSignal.timeout(1000)})).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,250));}assert.ok(ready,logs);
  const caseId=(await json("/api/cases","POST",{caseNumber:"SYNTHETIC-FORMAT-MATRIX"})).case.id,otherId=(await json("/api/cases","POST",{caseNumber:"SYNTHETIC-FOREIGN"})).case.id;
  const saved=[];
  for(const fixture of fixtures){const metadata={caseId,name:fixture.name,groupId:fixture.group||"primary",typeId:fixture.kind||"invoice",classificationMode:"manual",processInBackground:"true"},r=await fetch(base+"/api/documents",{method:"POST",headers:{"content-type":"application/octet-stream",[UPLOAD_METADATA_HEADER]:encodeUploadMetadata(metadata)},body:Buffer.from(fixture.base64,"base64")}),p=await r.json();assert.ok(r.ok,fixture.name+JSON.stringify(p));saved.push({...fixture,id:p.id,upload:p});}
  start(["scripts/processing-worker.mjs"]);let jobs;
  for(let i=0;i<600;i++){jobs=await json(`/api/processing-jobs?caseId=${caseId}&limit=100`);if(!(jobs.counts.queued||jobs.counts.running||jobs.counts.retry))break;await new Promise(r=>setTimeout(r,250));}
  assert.ok(!jobs.counts.queued&&!jobs.counts.running&&!jobs.counts.retry,JSON.stringify(jobs)+logs);
  const results=[];
  for(const file of saved){
   const documentId=file.name.endsWith(".zip")?file.upload.archive.documents[0].id:file.id,job=jobs.jobs.find(j=>j.documentId===documentId);assert.ok(job,file.name);
   if(file.failed){assert.equal(job.state,"failed",file.name);continue;}
   assert.equal(job.state,"completed",file.name+JSON.stringify(job));const result=await json(`/api/case-analysis?caseId=${caseId}&documentId=${documentId}`);assert.equal(result.summary.rows,file.expected,file.name+JSON.stringify(result.summary));
   if(file.pages){assert.equal(result.summary.pageAudit.totalPages,file.pages);assert.equal(result.summary.pageAudit.pagesWithText,file.pages);assert.equal(result.summary.pageAudit.ocrPerformed,false);}
   if(file.contextOnly){assert.ok(result.rows.every(r=>r.type==="context"));assert.equal((await json(`/api/case-analysis?caseId=${caseId}&q=${encodeURIComponent(file.name)}`)).total,0);}
   if(file.ocr){assert.equal(result.summary.pageAudit.ocrPerformed,true,file.name);assert.equal(result.summary.pageAudit.pagesWithText,1,file.name);assert.ok(result.summary.documentAnalysis.automaticallyExtracted>0,file.name+JSON.stringify(result.summary.documentAnalysis.segments.map(s=>({typeId:s.typeId,fields:s.fields,automatic:s.automatic,excerpt:s.excerpt}))));}
   if(file.empty){assert.equal(job.progress.attention,true);assert.notEqual(job.progress.label,"Чтение и анализ завершены");}
   if(file.expected===100){assert.equal(result.rows.length,50);const tail=await json(`/api/case-analysis?caseId=${caseId}&documentId=${documentId}&offset=50`);assert.equal(tail.rows.length,50);assert.equal(new Set([...result.rows,...tail.rows].map(r=>r.date)).size,1);assert.equal(result.rows[0].attributes.fieldSources.senderId.cell,"A2");}
   results.push([file.name,job.state,result.summary.rows,result.summary.pageAudit?.pagesWithText||0]);
  }
  assert.equal((await json(`/api/case-analysis?caseId=${otherId}`)).operationCount,0);
  const csv=saved.find(f=>f.name==="invoice.csv"),before=await json(`/api/case-analysis?caseId=${caseId}`),downloadBefore=Buffer.from(await (await fetch(base+`/api/documents/${csv.id}?caseId=${caseId}`)).arrayBuffer());
  const foreign=await fetch(base+`/api/documents/${csv.id}?caseId=${otherId}`);assert.equal(foreign.status,404);
  const denied=await fetch(base+`/api/documents/${csv.id}`,{method:"DELETE",headers:{origin:"https://foreign.example","content-type":"application/json"},body:JSON.stringify({caseId,note:"Synthetic exclusion"})});assert.equal(denied.status,403);
  const removed=await json(`/api/documents/${csv.id}`,"DELETE",{caseId,note:"Synthetic reversible exclusion"});assert.equal(removed.originalPreserved,true);
  const after=await json(`/api/case-analysis?caseId=${caseId}`);assert.equal(after.operationCount,before.operationCount-1);assert.equal(after.documents.find(d=>d.id===csv.id).excluded,true);assert.equal((await json(`/api/documents?caseId=${caseId}`)).documents.find(d=>d.id===csv.id).excluded,true);
  const downloadAfter=Buffer.from(await (await fetch(base+`/api/documents/${csv.id}?caseId=${caseId}`)).arrayBuffer());assert.deepEqual(downloadAfter,downloadBefore);
  await json("/api/case-analysis","POST",{caseId,id:csv.id,kind:"document",status:"active",note:"Synthetic restoration"});assert.equal((await json(`/api/case-analysis?caseId=${caseId}`)).operationCount,before.operationCount);
  const graph=await json(`/api/flow?caseId=${caseId}&bin=990000000001&scope=all&depth=3`);assert.equal(graph.nodes.length,2);assert.ok(graph.edges.length>0);
  // These compact lines contain only synthetic fixture names and actual measured counts.
  console.log("FORMAT_MATRIX "+JSON.stringify(results));
 }finally{for(const p of children.reverse())if(p.exitCode===null){const done=once(p,"exit");if(process.platform==="win32")spawnSync("taskkill",["/PID",String(p.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});else p.kill();await Promise.race([done,new Promise(r=>setTimeout(r,1500))]);}fs.rmSync(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});
