import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {openDatabase,createCase} from '../app/lib/vestigo-db.mjs';import {saveDocument} from '../app/lib/documents.mjs';import {extractOriginal,storeExtraction} from '../app/lib/case-analysis.mjs';
import {caseAnalyticsDataset,flowPayload} from '../app/lib/case-analytics.mjs';import {A,B,invoiceCSV,bankCSV} from './stage3-fixtures.mjs';
test('original Qaztin-style flow API: invoices, bank-only and mixed; exact sources, canonical mirror and visible reconciliation',{timeout:60000},async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vestigo-original-flow-')),db=openDatabase({dataDirectory:dir});
 const cases=['INVOICES','BANK','MIXED'].map(caseNumber=>createCase(db,{caseNumber:'SYNTHETIC-'+caseNumber}));
 const put=async(c,name,body,groupId,typeId)=>{const d=saveDocument(db,{caseId:c.id,name,bytes:Buffer.from(body),groupId,typeId});const {result}=await extractOriginal(db,c.id,d.id);storeExtraction(db,c.id,d.id,result);return d;};
 const flow=(c,extra={})=>{const p=new URLSearchParams({bin:A,depth:'4',...extra});return flowPayload(caseAnalyticsDataset(db,c.id,'KZT',Object.fromEntries(p)),p,db);};
 try{
  await put(cases[0],'invoice.csv',invoiceCSV(),'primary','invoice');
  await put(cases[1],'bank.csv',bankCSV(),'bank','statement');await put(cases[1],'mirror.csv',bankCSV(true),'bank','statement');
  const i=await put(cases[2],'invoice.csv',invoiceCSV(),'primary','invoice');const b=await put(cases[2],'bank.csv',bankCSV(),'bank','statement');
  const a=flow(cases[0]),bank=flow(cases[1]),mixed=flow(cases[2]);
  assert.ok(a.edges.every(e=>e.invoices?.length));assert.equal(a.financial.mode,'relations');assert.equal(a.financial.unmatched,0);
  assert.equal(bank.financial.mode,'money');assert.equal(bank.edges.filter(e=>['transfer','refund'].includes(e.attributes.bankKind)).reduce((n,e)=>n+e.operations,0),19);assert.ok(bank.edges.every(e=>!e.invoices));
  assert.equal(mixed.financial.mode,'combined');assert.ok(mixed.edges.some(e=>e.invoices?.length));assert.ok(mixed.edges.some(e=>e.bankTransfers?.length));assert.ok(mixed.financial.unmatched>0);assert.ok(mixed.financial.proposed>0);assert.equal(mixed.financial.confirmed,0);
  assert.equal(mixed.financial.items.find(x=>x.number==='I2').preliminaryDifferenceMinor,'1000');
  assert.ok(mixed.edges.every(e=>e.attributes.evidence.every(s=>[i.id,b.id].includes(s.documentId))));
  assert.ok(flow(cases[2],{documents:i.id}).edges.every(e=>e.invoices?.length));assert.ok(flow(cases[2],{type:'payment'}).edges.every(e=>e.bankTransfers?.length));
  assert.equal(flow(cases[2],{documents:i.id}).financial.mode,'relations');assert.equal(flow(cases[2],{type:'payment'}).financial.mode,'money');
  assert.equal(flow(cases[2],{documents:b.id}).edges.some(e=>e.invoices?.length),false);
  const other=createCase(db,{caseNumber:'SYNTHETIC-SEPARATE'});assert.equal(flow(other).edges.length,0);
 }finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('original map has no second graph engine or duplicate graph tab in case documents',()=>{
 const dashboard=fs.readFileSync('app/analytics/analytics-dashboard.tsx','utf8'),center=fs.readFileSync('app/components/analysis-center-panel.tsx','utf8');
 assert.ok(dashboard.includes('className="flow-stage"'));assert.ok(dashboard.includes('CaseBankEdgeDetails'));assert.ok(!dashboard.includes('FinancialGraphExtension'));assert.ok(!center.includes('<FinancialGraph'));assert.ok(!center.includes('Схема по документам'));assert.ok(center.includes('view=connections&documents='));
});
