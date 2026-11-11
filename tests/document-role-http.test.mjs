import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {createAuthenticatedFetch,TEST_SETUP_TOKEN} from './authenticated-fetch.mjs';

test('HTTP upload -> queue -> worker -> role facts -> matching -> existing graph and source',{timeout:120000},async()=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'vestigo-role-http-')),base='http://localhost:3514',request=createAuthenticatedFetch(),children=[];
 const env={...process.env,VESTIGO_DATA_DIR:folder,VESTIGO_SETUP_TOKEN:TEST_SETUP_TOKEN,VESTIGO_SITE_PORT:'3514'};let logs='';
 const start=args=>{const child=spawn(process.execPath,args,{cwd:process.cwd(),env,windowsHide:true,stdio:['ignore','pipe','pipe']});children.push(child);for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>logs=(logs+bytes).slice(-5000));};
 const api=async(url,method='GET',body)=>{const r=await request(base+url,{method,...(body?{headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})}),p=await r.json();assert.ok(r.ok,JSON.stringify(p));return p;};
 try{
  start(['node_modules/vinext/dist/cli.js','dev','--port','3514']);let ready=false;
  for(let n=0;n<150;n++){try{ready=(await fetch(base+'/api/auth/session')).ok;}catch{}if(ready)break;await new Promise(r=>setTimeout(r,200));}assert.ok(ready,logs);
  const caseId=(await api('/api/cases','POST',{caseNumber:'SYNTHETIC-ROLE-HTTP'})).case.id;
  const roles='Исполнитель: ТОО «Контроль-А»\nБИН: 990000000001\nЗаказчик: ТОО «Контроль-Б»\nБИН: 990000000002',ids=[];
  for(const [name,groupId,typeId,text] of [
   ['contract.txt','contract','agreement',`Договор оказания услуг № CONTROL-1 от 20.10.2026\n${roles}\nОбщая стоимость договора: 1200000 тенге`],
   ['act.txt','primary','completion_act',`Акт выполненных работ № ACT-1 от 21.10.2026\n${roles}\nСтоимость выполненных работ: 1200000 тенге\nОснование: договор № CONTROL-1`]
  ]){
   const form=new FormData();for(const [k,v] of Object.entries({caseId,groupId,typeId,classificationMode:'manual',processInBackground:'true'}))form.set(k,v);
   form.set('file',new Blob([text],{type:'text/plain'}),name);
   const r=await request(base+'/api/documents',{method:'POST',body:form}),d=await r.json();assert.ok(r.ok,JSON.stringify(d));ids.push(d.id);
  }
  start(['scripts/processing-worker.mjs']);let done=false;
  for(let n=0;n<200;n++){const jobs=(await api('/api/processing-jobs?caseId='+caseId)).jobs;assert.ok(!jobs.some(j=>j.state==='failed'),JSON.stringify(jobs));if(jobs.filter(j=>j.state==='completed').length===2){done=true;break;}await new Promise(r=>setTimeout(r,150));}assert.ok(done,logs);
  const a=await api('/api/case-analysis?caseId='+caseId);assert.equal(a.operationCount,2);assert.ok(a.matches.length>=1);
  assert.ok(a.operations.every(o=>o.amountMinor===120000000&&!o.confirmed&&o.senderId==='990000000001'&&o.recipientId==='990000000002'));
  assert.ok(a.operations.every(o=>o.sources.every(s=>ids.includes(s.documentId))));
  const graph=await api('/api/flow?caseId='+caseId+'&bin=990000000001');assert.equal(graph.nodes.length,2);assert.equal(graph.edges.length,2);
  const source=a.operations[0].sources[0];const original=await api(`/api/case-analysis?caseId=${caseId}&documentId=${source.documentId}&sourceSheet=${encodeURIComponent(source.sheet)}&sourceRow=${source.row}`);
  assert.ok(original.rows.some(r=>r.sheet===source.sheet&&r.row===source.row&&r.amountMinor===120000000));
  assert.equal((await fetch(base+'/api/case-analysis?caseId='+caseId)).status,401);
  console.log('ROLE_HTTP_CONTROL: 2 documents -> 2 documentary operations, matching, original sources and authorization checked; no bank transfer invented.');
 }finally{
  for(const p of children.reverse())if(p.exitCode===null)spawnSync('taskkill',['/PID',String(p.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
  await new Promise(r=>setTimeout(r,400));fs.rmSync(folder,{recursive:true,force:true,maxRetries:10,retryDelay:100});
 }
});
