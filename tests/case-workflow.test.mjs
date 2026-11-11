import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {openDatabase,createCase,createEpisode} from '../app/lib/vestigo-db.mjs';
import {saveDocument} from '../app/lib/documents.mjs';
import {storeExtraction,caseAnalysis,reviewCaseItem,rebuildCaseAnalysis} from '../app/lib/case-analysis.mjs';
import {saveWorkflow,workflowWorkspace} from '../app/lib/case-workflow.mjs';
import {reviewHistory} from '../app/lib/review-history.mjs';
import {createCaseReport,getCaseReport} from '../app/lib/case-calculations.mjs';
import {extractContextFacts,analyzeStandaloneText} from '../app/lib/document-facts.mjs';
import {processCaseDocument} from '../app/lib/document-processing.mjs';
const note='Контроль на синтетических документах, не реальные материалы';
test('document-derived values save through the same loss workflow, with all acts and exact evidence',async()=>{
 const s=setup();try{
  const put=async(name,groupId,typeId,text)=>{
   const d=saveDocument(s.db,{caseId:s.c.id,name,bytes:Buffer.from(text),groupId,typeId});
   await processCaseDocument(s.db,s.c.id,d.id);return d.id;
  };
  const plannedId=await put('plan.txt','contract','work_contract','Договор подряда № W-1\nОбщая стоимость работ: 100000,05 KZT');
  const a=await put('act-a.txt','primary','completion_act','Акт выполненных работ № A-1\nСтоимость выполненных работ: 30000,01 KZT');
  const b=await put('act-b.txt','primary','completion_act','Акт выполненных работ № A-2\nСтоимость фактического исполнения: 10000,01 KZT');
  const input={action:'loss',victimId:s.a,episodeId:s.ep.id,currency:'KZT',method:'documented_amount',grossMinor:'10000005',fulfilledMinor:'4000002',status:'confirmed',expectedVersion:0,documentCostSelection:{plannedId,actIds:[a,b]}};
  assert.throws(()=>s.save({...input,fulfilledMinor:'3999999'}),/изменились/);
  assert.throws(()=>s.save({...input,documentCostSelection:{plannedId,actIds:[a,a]}}),/различные акты/);
  s.save(input);
  const w=workflowWorkspace(s.db,s.c.id);assert.equal(w.balances[0].originalMinor,'6000003');
  assert.deepEqual(w.losses[0].sources.map(x=>x.documentId),[plannedId,a,b]);
  assert.deepEqual(w.losses[0].sources.map(x=>x.facts[0].line),[2,2,2]);
 }finally{s.close();}
});
function setup(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vestigo-workflow-')),db=openDatabase({dataDirectory:dir}),c=createCase(db,{caseNumber:'SYNTHETIC-FULL-WORKFLOW'}),ep=createEpisode(db,{caseId:c.id,title:'Контрольный эпизод'}),doc=saveDocument(db,{caseId:c.id,name:'synthetic-source.txt',bytes:Buffer.from('Synthetic control facts'),groupId:'bank',typeId:'payment_order'});
 const rows=[['A','990000000001',2500000000],['B','990000000002',500000000],['RETURN','990000000003',200000000]].map(([number,senderId,amountMinor],i)=>({sheet:'Control',row:i+1,type:'payment',date:'2026-10-20',currency:'KZT',senderId,recipientId:number==='RETURN'?'990000000001':'990000000003',senderName:'Контроль',recipientName:'Контроль',amountMinor,amountBasis:'document_total',number,raw:{control:number},attributes:{}}));
 storeExtraction(db,c.id,doc.id,{version:1,status:'extracted',rows,text:'Synthetic',tables:[],warnings:[],unparsedRows:0},{groupId:'bank',typeId:'payment_order'});
 for(const o of caseAnalysis(db,c.id).operations)reviewCaseItem(db,c.id,{kind:'operation',id:o.id,status:'confirmed',note});
 const save=x=>saveWorkflow(db,c.id,{note,...x});const a=save({action:'participant',name:'Потерпевший А',identifier:'990000000001',role:'victim'}).id,b=save({action:'participant',name:'Потерпевший Б',identifier:'990000000002',role:'victim'}).id;
 return {db,c,ep,doc,a,b,save,source:{documentId:doc.id,sheet:'Control',row:1},close(){db.close();fs.rmSync(dir,{recursive:true,force:true});}};
}
function loss(s,victimId,grossMinor,extra={}){return {action:'loss',victimId,episodeId:s.ep.id,currency:'KZT',method:'documented_amount',grossMinor,fulfilledMinor:'0',status:'confirmed',expectedVersion:0,source:s.source,...extra};}

test('victims, per-episode amounts, confirmed returns, arrested assets and unknown balances are separate',()=>{const s=setup();try{
 s.save(loss(s,s.a,'2000000000'));s.save(loss(s,s.b,'500000000'));
 s.save({action:'return',victimId:s.a,episodeId:s.ep.id,currency:'KZT',amountMinor:'200000000',date:'2026-10-21',kind:'money',status:'confirmed',expectedVersion:0,source:s.source});
 s.save({action:'return',victimId:s.b,episodeId:s.ep.id,currency:'KZT',amountMinor:'150000000',date:'2026-10-22',kind:'returned_property',status:'confirmed',expectedVersion:0,source:{documentId:s.doc.id,sheet:'Control',row:2}});
 s.save({action:'asset',name:'Арестованное имущество — контроль',episodeId:s.ep.id,currency:'KZT',amountMinor:'900000000',status:'arrested',source:s.source});
 const w=workflowWorkspace(s.db,s.c.id);assert.equal(w.totals[0].originalMinor,'2500000000');assert.equal(w.totals[0].returnedMinor,'350000000');assert.equal(w.totals[0].remainingMinor,'2150000000');
 assert.equal(w.balances.find(b=>b.victimId===s.a).remainingMinor,'1800000000');assert.equal(w.balances.find(b=>b.victimId===s.b).remainingMinor,'350000000');assert.equal(w.assets.length,1);
 assert.equal(w.losses.length,2);assert.equal(w.returns.length,2);assert.ok(w.warning.includes('Арест'));assert.ok(reviewHistory(s.db,s.c.id).items.some(e=>e.title.includes('возврата')));
}finally{s.close();}});

test('actual payment methodology, duplicate protection, zero fulfilment explicit, repeat versions replace not add',()=>{const s=setup();try{
 const payment=caseAnalysis(s.db,s.c.id).operations.find(o=>o.number==='A');
 const first=s.save(loss(s,s.a,'0',{method:'payments_less_fulfilment',operationIds:[payment.id],fulfilledMinor:'500000000',fulfilmentSource:{documentId:s.doc.id,sheet:'Control',row:2}}));
 let w=workflowWorkspace(s.db,s.c.id);assert.equal(w.losses[0].originalMinor,'2000000000');
 assert.throws(()=>s.save(loss(s,s.b,'0',{method:'payments_less_fulfilment',operationIds:[payment.id]})),/потерпевшего/);
 assert.throws(()=>s.save(loss(s,s.a,'0',{method:'payments_less_fulfilment',operationIds:[payment.id],fulfilledMinor:'0'})),/изменён/);
 s.save(loss(s,s.a,'1900000000',{expectedVersion:first.version}));w=workflowWorkspace(s.db,s.c.id);assert.equal(w.losses.length,1);assert.equal(w.totals[0].originalMinor,'1900000000');
 assert.equal(s.db.prepare('SELECT COUNT(*) n FROM case_loss_versions').get().n,2);
 assert.ok(reviewHistory(s.db,s.c.id).items.some(e=>e.changed));
}finally{s.close();}});

test('missing fulfilment, currencies, sources, foreign victims, episodes and stale payments fail closed',()=>{const s=setup();try{
 assert.throws(()=>s.save(loss(s,s.a,'100',{fulfilledMinor:undefined})),/сумму/);
 assert.throws(()=>s.save(loss(s,s.a,'100',{fulfilledMinor:'101'})),/превышает/);
 assert.throws(()=>s.save(loss(s,s.a,'100',{source:{documentId:'missing'}})),/Источник/);
 const other=createCase(s.db,{caseNumber:'SYNTHETIC-OTHER'});assert.throws(()=>saveWorkflow(s.db,other.id,{note,...loss(s,s.a,'100')}),/Потерпевший/);
 assert.throws(()=>s.save(loss(s,s.a,'100',{episodeId:'missing'})),/Эпизод/);
 const op=caseAnalysis(s.db,s.c.id).operations.find(o=>o.number==='A');s.save(loss(s,s.a,'0',{method:'payments_less_fulfilment',operationIds:[op.id]}));
 reviewCaseItem(s.db,s.c.id,{kind:'operation',id:op.id,status:'rejected',note});const w=workflowWorkspace(s.db,s.c.id);assert.equal(w.losses[0].usable,false);assert.equal(w.totals.length,0);
}finally{s.close();}});

test('unconfirmed return is not reimbursement, versioned decisions retained, over-return is explicit; currencies not netted',()=>{const s=setup();try{
 s.save(loss(s,s.a,'10000'));
 const r={action:'return',victimId:s.a,episodeId:s.ep.id,currency:'KZT',amountMinor:'12000',date:'2026-10-21',kind:'money',status:'pending',expectedVersion:0,source:s.source};
 const saved=s.save(r);assert.equal(workflowWorkspace(s.db,s.c.id).balances[0].returnedMinor,'0');
 assert.throws(()=>s.save({...r}),/уже зарегистрирован/);
 s.save({...r,id:saved.id,expectedVersion:1,status:'confirmed'});let w=workflowWorkspace(s.db,s.c.id);assert.equal(w.balances[0].remainingMinor,'0');assert.equal(w.balances[0].excessMinor,'2000');
 s.save({...r,id:saved.id,expectedVersion:2,status:'rejected'});w=workflowWorkspace(s.db,s.c.id);assert.equal(w.balances[0].returnedMinor,'0');
 s.save({...r,currency:'USD',status:'confirmed'});w=workflowWorkspace(s.db,s.c.id);assert.equal(w.totals.length,2);assert.equal(w.balances.find(b=>b.currency==='USD').remainingMinor,null);
 assert.throws(()=>s.save({...r,id:saved.id,expectedVersion:3,amountMinor:'13000'}),/неизменяемы/);
}finally{s.close();}});

test('episode assignment survives rebuild; excluded source invalidates live calculation without rewriting its snapshot',()=>{const s=setup();try{
 const op=caseAnalysis(s.db,s.c.id).operations.find(o=>o.number==='A');s.save({action:'assign_episode',operationId:op.id,episodeId:s.ep.id,expectedVersion:0});rebuildCaseAnalysis(s.db,s.c.id);
 assert.equal(caseAnalysis(s.db,s.c.id).operations.find(o=>o.id===op.id).episodeId,s.ep.id);
 s.save(loss(s,s.a,'100'));const before=s.db.prepare('SELECT snapshot_json FROM case_loss_versions').get().snapshot_json;
 reviewCaseItem(s.db,s.c.id,{kind:'document',id:s.doc.id,status:'excluded',note});const w=workflowWorkspace(s.db,s.c.id);assert.equal(w.losses[0].usable,false);assert.equal(w.totals.length,0);assert.equal(s.db.prepare('SELECT snapshot_json FROM case_loss_versions').get().snapshot_json,before);
}finally{s.close();}});

test('document assertions, unknown property values, nonmonetary events and reports never invent bank payments',()=>{const s=setup();try{
 const text='Заявление потерпевшего\nФИО потерпевшего: Контроль А\nСумма заявленного ущерба: 20000000 тенге\nСумма заявленного ущерба: 21000000 тенге';
 const facts=extractContextFacts(text);assert.equal(facts.filter(f=>f.field==='claimedAmount').length,2);assert.equal(facts.find(f=>f.field==='claimedAmount').normalized,'2000000000');
 const claim=analyzeStandaloneText({text,pages:[],tables:[],rows:[],warnings:[],status:'review'},{groupId:'victim',typeId:'application'});assert.equal(claim.rows[0].type,'context');assert.equal(claim.rows[0].amountMinor,null);
 const before=caseAnalysis(s.db,s.c.id).operationCount;
 const event=s.save({action:'material_event',senderId:s.a,recipientId:s.b,episodeId:s.ep.id,date:'2026-10-22',kind:'property_transfer',description:'Передано имущество, цена не установлена',status:'pending',amountMinor:null,source:s.source});
 s.save({action:'event_review',id:event.id,expectedVersion:1,status:'confirmed'});
 s.save({action:'asset',name:'Нет оценки',episodeId:s.ep.id,currency:'KZT',valuationKnown:false,status:'arrested',source:s.source});
 let w=workflowWorkspace(s.db,s.c.id);assert.equal(w.materialEvents[0].amountMinor,null);assert.equal(w.assets[0].amountMinor,null);assert.equal(caseAnalysis(s.db,s.c.id).operationCount,before);
 s.save(loss(s,s.a,'2000000000'));const r=createCaseReport(s.db,s.c.id),snapshot=getCaseReport(s.db,s.c.id,r.id);assert.equal(snapshot.workflow.losses.length,1);assert.equal(snapshot.workflow.materialEvents.length,1);
 s.save(loss(s,s.a,'1900000000',{expectedVersion:1}));assert.equal(getCaseReport(s.db,s.c.id,r.id).workflow.losses[0].originalMinor,'2000000000');
 assert.throws(()=>s.save(loss(s,s.a,'100',{episodeId:'',expectedVersion:0})),/пересекается/);
}finally{s.close();}});

test('real TXT comma amounts do not discard accounting/tax text as a spurious CSV table',async()=>{const s=setup();try{
 const before=caseAnalysis(s.db,s.c.id).operationCount;
 for(const [groupId,typeId,text] of [['accounting','trial_balance','Оборотно-сальдовая ведомость\nНачальный остаток: 100000,00 тенге\nКонечный остаток: 50000,00 тенге'],['tax','declaration','Налоговая декларация\nФорма 300.00\nНачислено налога: 12000,00 тенге\nУплачено налога: 5000,00 тенге']]){
  const d=saveDocument(s.db,{caseId:s.c.id,name:'synthetic-'+typeId+'.txt',bytes:Buffer.from(text),groupId,typeId});await processCaseDocument(s.db,s.c.id,d.id);
  const e=s.db.prepare('SELECT status,text_content,summary_json FROM case_extractions WHERE case_id=? AND document_id=?').get(s.c.id,d.id),summary=JSON.parse(e.summary_json);
  assert.equal(e.status,'extracted');assert.ok(e.text_content.includes('тенге'));assert.equal(summary.contextOnly,true);assert.equal(summary.automaticFacts.contextFacts.length,2);
 }
 assert.equal(caseAnalysis(s.db,s.c.id).operationCount,before);
}finally{s.close();}});
