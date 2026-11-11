import {createAuthenticatedFetch,TEST_SETUP_TOKEN} from "./authenticated-fetch.mjs";
const fetch=createAuthenticatedFetch();
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawn,spawnSync} from "node:child_process";
import {once} from "node:events";
test("HTTP: файл и очередь принимаются вместе; отдельный обработчик завершает работу без ожидающего запроса",{timeout:90000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"vestigo-queue-http-")),env={...process.env,VESTIGO_SETUP_TOKEN:TEST_SETUP_TOKEN,VESTIGO_DATA_DIR:directory},children=[];let logs="";
  const start=args=>{const p=spawn(process.execPath,args,{cwd:process.cwd(),env,windowsHide:true,stdio:["ignore","pipe","pipe"]});p.stdout.on("data",v=>{logs=(logs+v).slice(-8000);});p.stderr.on("data",v=>{logs=(logs+v).slice(-8000);});children.push(p);return p;};
  const server=start([path.resolve("node_modules/vinext/dist/cli.js"),"dev","--port","3297"]),base="http://localhost:3297";
  const json=(url,body)=>fetch(base+url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  try{
    let ready=false;for(let i=0;i<40;i++){if(server.exitCode!==null)throw new Error(logs);try{if((await fetch(base+"/api/dashboard",{signal:AbortSignal.timeout(1000)})).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,300));}assert.ok(ready,logs);
    const c=await json("/api/cases",{caseNumber:"QUEUE-SYNTHETIC"}),caseId=(await c.json()).case.id;
    const upload=async(name,text)=>{const form=new FormData();form.set("caseId",caseId);form.set("groupId","unclassified");form.set("typeId","unclassified");form.set("classificationMode","auto");form.set("processInBackground","true");form.set("file",new Blob([text]),name);const r=await fetch(base+"/api/documents",{method:"POST",body:form});assert.equal(r.status,201,await r.clone().text());return r.json();};
    const csv="БИН поставщика;БИН покупателя;Сумма;Дата;Номер ЭСФ;Валюта\n990000000001;990000000002;1000,01;2026-10-20;ESF-Q-HTTP-1;KZT";
    const invoice=await upload("invoice.csv",csv),broken=await upload("broken.json","{ not valid json"),letter=await upload("letter.txt","Сопроводительное письмо. Направляем материалы для ознакомления.");
    assert.equal(invoice.processing.job.state,"queued");assert.equal((await (await fetch(base+`/api/processing-jobs?caseId=${caseId}`)).json()).counts.queued,3);
    const worker=start(["scripts/processing-worker.mjs"]);let jobs;
    for(let i=0;i<70;i++){if(worker.exitCode!==null)throw new Error(logs);jobs=await (await fetch(base+`/api/processing-jobs?caseId=${caseId}`)).json();if((jobs.counts.completed||0)+(jobs.counts.failed||0)===3)break;await new Promise(r=>setTimeout(r,300));}
    assert.equal(jobs.counts.completed,2,JSON.stringify(jobs)+logs);assert.equal(jobs.counts.failed,1);assert.equal(jobs.workerOnline,true);
    assert.equal(jobs.jobs.find(j=>j.documentId===broken.id).state,"failed");assert.equal(jobs.jobs.find(j=>j.documentId===letter.id).state,"completed");
    const analysis=await (await fetch(base+`/api/case-analysis?caseId=${caseId}`)).json();assert.equal(analysis.operationCount,1);
    const retry=await json("/api/processing-jobs",{caseId,id:invoice.processing.job.id,action:"retry"});assert.equal(retry.status,422);
    const denied=await fetch(base+"/api/processing-jobs",{method:"POST",headers:{origin:"https://other.example","content-type":"application/json"},body:JSON.stringify({caseId,documentId:invoice.id})});assert.equal(denied.status,403);
    const other=await json("/api/cases",{caseNumber:"OTHER-QUEUE"}),otherId=(await other.json()).case.id;
    const foreign=await (await fetch(base+`/api/processing-jobs?caseId=${otherId}&id=${invoice.processing.job.id}`)).json();assert.equal(foreign.jobs.length,0);
  }finally{
    for(const child of children.reverse())if(child.exitCode===null){const exited=once(child,"exit");if(process.platform==="win32")spawnSync("taskkill",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});else child.kill();await Promise.race([exited,new Promise(r=>setTimeout(r,2000))]);}
    fs.rmSync(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
});
