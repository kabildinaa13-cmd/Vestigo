import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {openDatabase,createCase} from '../app/lib/vestigo-db.mjs';import {saveDocument} from '../app/lib/documents.mjs';import {extractOriginal,storeExtraction} from '../app/lib/case-analysis.mjs';import {financialReport} from '../app/lib/financial-profile.mjs';import {buildFinancialGraph} from '../app/lib/financial-graph.mjs';
import {A,B,accounts} from './stage3-fixtures.mjs';
test('abbreviated debit/credit, date-time, combined account + labelled BIN: exact operations and bank graph',{timeout:30000},async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vestigo-abbreviated-')),db=openDatabase({dataDirectory:dir});
 try{
  const c=createCase(db,{caseNumber:'SYNTHETIC-ABBREVIATED'}),head=['Дата','БИН владельца счета','Счет владельца','Счет-корреспондент','Деб. оборот','Кред. Оборот','Назначение платежа','Валюта'];
  const rows=[['01.10.2026 12:03:04',A,accounts[A],`${accounts[B]} БИН/ИИН ${B} Синтетический контрагент`,'100.25','0','Оплата услуг','KZT'],['02.10.2026 12:03',A,accounts[A],`${accounts[B]} ${B} Синтетический контрагент`,'0','200.10','Оплата услуг','KZT'],['03.10.2026 12:03',A,accounts[A],'','10','0','Получатель не указан','KZT']];
  const d=saveDocument(db,{caseId:c.id,name:'synthetic.csv',bytes:Buffer.from([head,...rows].map(r=>r.join(';')).join('\n')),groupId:'bank',typeId:'statement'});
  const {result}=await extractOriginal(db,c.id,d.id);assert.equal(result.rows.filter(r=>r.amountMinor>0).length,3);assert.equal(result.rows[0].date,'2026-10-01');assert.equal(result.rows[0].recipientId,B);assert.equal(result.rows[1].senderId,B);assert.equal(result.rows[2].recipientId,'');assert.equal(result.rows[0].amountMinor,10025);assert.equal(result.rows[1].amountMinor,20010);storeExtraction(db,c.id,d.id,result);
  const g=buildFinancialGraph(financialReport(db,c.id));assert.equal(g.graphMode,'money');assert.equal(g.edges.filter(e=>e.type==='bank_transfer').reduce((n,e)=>n+e.count,0),2);assert.ok(g.edges.some(e=>e.type==='bank_record_partial'));assert.ok(!g.edges.some(e=>e.type==='document_supply'));
 }finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}
});
