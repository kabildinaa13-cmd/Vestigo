import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {openDatabase,createCase} from '../app/lib/vestigo-db.mjs';
import {saveDocument} from '../app/lib/documents.mjs';
import {extractOriginal,storeExtraction} from '../app/lib/case-analysis.mjs';
import {financialReport,saveFinancialDecision} from '../app/lib/financial-profile.mjs';
import {buildFinancialGraph} from '../app/lib/financial-graph.mjs';
import {invoiceCSV,bankCSV} from './stage3-fixtures.mjs';

test('document -> actual parsers -> invoice-only, bank-only and combined graphs, exact allocations and scope isolation',{timeout:60000},async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vestigo-graph-modes-')),db=openDatabase({dataDirectory:dir});
 const cases=['INVOICES','BANK','BOTH','EMPTY'].map(caseNumber=>createCase(db,{caseNumber:'SYNTHETIC-'+caseNumber}));
 const put=async(c,name,body,groupId,typeId)=>{const doc=saveDocument(db,{caseId:c.id,name,bytes:Buffer.from(body),groupId,typeId});const {result}=await extractOriginal(db,c.id,doc.id);storeExtraction(db,c.id,doc.id,result);return doc;};
 try{
  await put(cases[0],'invoices.csv',invoiceCSV(),'primary','invoice');
  await put(cases[1],'bank.csv',bankCSV(),'bank','statement');
  const invDoc=await put(cases[2],'invoices.csv',invoiceCSV(),'primary','invoice');
  const bankDoc=await put(cases[2],'bank.csv',bankCSV(),'bank','statement');
  const graph=(c,q={})=>buildFinancialGraph(financialReport(db,c.id,q),{graphMode:'auto',...q});
  let g=graph(cases[0]);assert.equal(g.graphMode,'relations');assert.equal(g.edges.filter(e=>e.type==='document_supply').reduce((n,e)=>n+e.count,0),6);assert.equal(g.edges.filter(e=>e.type==='bank_transfer').length,0);assert.ok(g.coverage.items.every(i=>i.status==='no_statements'));assert.equal(g.coverage.unmatched,0);
  g=graph(cases[1]);assert.equal(g.graphMode,'money');assert.equal(g.edges.filter(e=>e.type==='bank_transfer').reduce((n,e)=>n+e.count,0),19);assert.equal(g.edges.filter(e=>e.type==='document_supply').length,0);assert.equal(g.coverage.invoices,0);
  g=graph(cases[2]);assert.equal(g.graphMode,'combined');assert.equal(g.coverage.confirmed,0);assert.ok(g.coverage.proposed>0);assert.ok(g.coverage.unmatched>0);assert.ok(g.edges.some(e=>e.type==='settlement_candidate'&&e.certainty==='hypothesis'));assert.ok(!g.edges.some(e=>e.type==='settlement_confirmed'));
  for(const n of g.nodes.filter(n=>n.type==='payment'))assert.equal(g.edges.filter(e=>e.type==='bank_payment_record'&&(e.from===n.id||e.to===n.id)).length,2);
  assert.ok(g.edges.filter(e=>e.type==='bank_payment_record').every(e=>e.amountMinor===null));
  assert.equal(g.coverage.items.find(i=>i.number==='I2').candidatePaymentMinor,'5000');
  assert.equal(g.coverage.items.find(i=>i.number==='I2').preliminaryDifferenceMinor,'1000');
  assert.ok(g.edges.every(e=>e.sources.length&&e.sources.every(s=>[invDoc.id,bankDoc.id].includes(s.documentId))));
  assert.equal(graph(cases[2],{documentId:invDoc.id}).graphMode,'relations');assert.equal(graph(cases[2],{documentId:bankDoc.id}).graphMode,'money');
  assert.equal(graph(cases[3]).edges.length,0);assert.throws(()=>financialReport(db,cases[0].id,{documentId:bankDoc.id}),/не относится/);
  let r=financialReport(db,cases[2].id),i=r.invoices.find(x=>x.number==='I2'),p=r.reconciliation.payments.find(x=>x.number==='P3');
  saveFinancialDecision(db,cases[2].id,{action:'allocation',invoiceId:i.id,paymentId:p.id,invoiceFingerprint:i.fingerprint,paymentFingerprint:p.fingerprint,amount:'20',status:'confirmed',note:'Синтетическая сверка источников'});
  g=graph(cases[2]);assert.equal(g.coverage.items.find(x=>x.number==='I2').status,'confirmed_partial');assert.equal(g.coverage.items.find(x=>x.number==='I2').confirmedMinor,'2000');assert.ok(g.edges.some(e=>e.type==='settlement_confirmed'&&e.amountMinor==='2000'));
  const bytes=db.prepare('SELECT COUNT(*) n FROM audit_log').get().n;graph(cases[2]);assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_log').get().n,bytes);
 }finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}
});
