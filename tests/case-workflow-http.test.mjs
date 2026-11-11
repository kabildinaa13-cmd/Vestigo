import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn,spawnSync} from 'node:child_process';
import {createAuthenticatedFetch,TEST_SETUP_TOKEN} from './authenticated-fetch.mjs';
test('real HTTP case workflow: upload XLSX, worker, victims, episode, calculation, return decision, arrested asset, report and access',{timeout:180000},async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vestigo-workflow-http-')),base='http://localhost:3516',env={...process.env,VESTIGO_DATA_DIR:dir,VESTIGO_SETUP_TOKEN:TEST_SETUP_TOKEN,VESTIGO_SITE_PORT:'3516'},children=[],request=createAuthenticatedFetch();let logs='';
 const start=args=>{const p=spawn(process.execPath,args,{cwd:process.cwd(),env,windowsHide:true,stdio:['ignore','pipe','pipe']});children.push(p);for(const s of[p.stdout,p.stderr])s.on('data',b=>logs=(logs+b).slice(-5000));};
 const api=async(url,method='GET',body)=>{const r=await request(base+url,{method,...(body?{headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})}),p=await r.json();assert.ok(r.ok,JSON.stringify(p));return p;};
 try{
  start(['node_modules/vinext/dist/cli.js','dev','--port','3516']);let ready=false;for(let i=0;i<150;i++){try{ready=(await fetch(base+'/api/auth/session')).ok;}catch{}if(ready)break;await new Promise(r=>setTimeout(r,200));}assert.ok(ready,logs);
  const c=(await api('/api/cases','POST',{caseNumber:'SYNTHETIC-WORKFLOW-HTTP',periodFrom:'2026-10-01',periodTo:'2026-10-29',qualifications:['214']})).case.id;
  const ep=(await api('/api/episodes','POST',{caseId:c,title:'Контрольный эпизод'})).episode.id;
  const form=new FormData();for(const[k,v]of Object.entries({caseId:c,groupId:'bank',typeId:'statement',classificationMode:'manual',processInBackground:'true'}))form.set(k,v);form.set('file',new Blob([fs.readFileSync('tests/fixtures/one-bank/control.xlsx')]),'synthetic-control.xlsx');const r=await request(base+'/api/documents',{method:'POST',body:form}),d=await r.json();assert.ok(r.ok,JSON.stringify(d));
  start(['scripts/processing-worker.mjs']);let done=false;for(let i=0;i<200;i++){const jobs=(await api('/api/processing-jobs?caseId='+c)).jobs;if(jobs.some(j=>j.state==='failed'))throw Error(JSON.stringify(jobs));if(jobs.some(j=>j.id===d.processing.job.id&&j.state==='completed')){done=true;break;}await new Promise(r=>setTimeout(r,150));}assert.ok(done,logs);
  const note='Контроль по синтетическому комплекту, не реальные материалы',save=b=>api('/api/case-workflow','POST',{caseId:c,note,...b});
  const victim=(await save({action:'participant',role:'victim',name:'Потерпевший — контроль HTTP',identifier:'990000000101'})).id;
  const analysis=await api('/api/case-analysis?caseId='+c);assert.equal(analysis.operationCount,10);
  const op=analysis.operations.find(o=>o.type==='payment');await save({action:'assign_episode',operationId:op.id,episodeId:ep,expectedVersion:0});
  await save({action:'loss',victimId:victim,episodeId:ep,currency:'KZT',method:'documented_amount',grossMinor:'2000000000',fulfilledMinor:'0',status:'confirmed',expectedVersion:0,source:{documentId:d.id}});
  const ret={action:'return',victimId:victim,episodeId:ep,currency:'KZT',amountMinor:'50000000',date:'2026-10-23',kind:'money',status:'pending',expectedVersion:0,source:{documentId:d.id}};const saved=await save(ret);
  assert.equal((await api('/api/case-workflow?caseId='+c)).balances[0].returnedMinor,'0');
  await save({...ret,id:saved.id,status:'confirmed',expectedVersion:saved.version});
  await save({action:'asset',name:'Арестованный контрольный объект',currency:'KZT',amountMinor:'900000000',status:'arrested',source:{documentId:d.id}});
  const w=await api('/api/case-workflow?caseId='+c);assert.equal(w.balances[0].remainingMinor,'1950000000');assert.equal(w.assets.length,1);
  const report=await api('/api/reports','POST',{caseId:c}),snapshot=await api(`/api/reports?caseId=${c}&id=${report.id}`);assert.equal(snapshot.workflow.balances[0].remainingMinor,'1950000000');assert.ok(snapshot.case.qualifications.includes('214'));assert.ok(snapshot.missingMaterials);
  const excel=await request(`${base}/api/reports?caseId=${c}&id=${report.id}&format=xlsx`),bytes=Buffer.from(await excel.arrayBuffer());assert.ok(excel.ok,bytes.toString().slice(0,100));assert.equal(bytes.subarray(0,2).toString(),'PK');
  const inspected=spawnSync(path.join(process.cwd(),'.venv','Scripts','python.exe'),['-c',"import sys,io;from openpyxl import load_workbook;b=load_workbook(io.BytesIO(sys.stdin.buffer.read()));assert 'Возмещение' in b.sheetnames;assert 'Потерпевшие и остаток' in b.sheetnames;assert any(c.value=='1950000000' for row in b['Потерпевшие и остаток'] for c in row);print('EXCEL_CONTROL_OK')"],{input:bytes,encoding:'utf8',windowsHide:true});assert.equal(inspected.status,0,inspected.stderr);
  const history=await api(`/api/analysis-center?caseId=${c}&view=history`);assert.ok(history.total>=5);assert.ok(history.items.some(e=>e.title.includes('возврата')));assert.ok(history.items.every(e=>e.employee.login==='synthetic-tester'));assert.doesNotMatch(JSON.stringify(history),/case\.processing_completed|jobId/);
  assert.equal((await fetch(base+'/api/case-workflow?caseId='+c)).status,401);
  assert.equal((await request(base+'/api/case-workflow',{method:'POST',headers:{origin:'https://foreign.invalid','content-type':'application/json'},body:JSON.stringify({caseId:c,action:'participant'})})).status,403);
  const other=(await api('/api/cases','POST',{caseNumber:'SYNTHETIC-OTHER-WORKFLOW'})).case.id;
  const foreign=await request(base+'/api/case-workflow',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...ret,caseId:other,note})});assert.equal(foreign.status,422);
  console.log('WORKFLOW_HTTP_CONTROL: real XLSX -> 10 operations; victim/episode; 20M calculation, 0.5M confirmed return, 19.5M remainder; arrested asset excluded; report XLSX inspected; auth and case isolation passed.');
 }finally{for(const p of children.reverse())if(p.exitCode===null)spawnSync('taskkill',['/PID',String(p.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});await new Promise(r=>setTimeout(r,400));fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});
