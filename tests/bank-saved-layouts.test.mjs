import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {openDatabase,createCase} from '../app/lib/vestigo-db.mjs';
import {saveDocument,validateDocument} from '../app/lib/documents.mjs';
import {extractOriginal,storeExtraction} from '../app/lib/case-analysis.mjs';
import {classifyDocument} from '../app/lib/document-classifier.mjs';
import {financialReport} from '../app/lib/financial-profile.mjs';
import {buildFinancialGraph} from '../app/lib/financial-graph.mjs';
import {A,B,accounts} from './stage3-fixtures.mjs';

const head=`<tr><th rowspan="2">№ документа</th><th rowspan="2">Дата транзакции</th><th colspan="2">Корреспондент</th><th colspan="2">Обороты в валюте счета</th><th rowspan="2">Назначение платежа</th></tr><tr><th>БИК наименование Банка</th><th>Счет, наименование БИН/ИИН</th><th>Дебет</th><th>Кредит</th></tr>`;
function html(movements=true){return `<HTML><HEAD><meta charset="utf-8"></HEAD><BODY><script>throw Error('must never execute')</script><iframe src="https://invalid.example/never"></iframe><p>Выписка по счету</p><table><tr><td>БИН клиента</td><td>${A}</td></tr><tr><td>IBAN</td><td>${accounts[A]}</td></tr><tr><td>Валюта</td><td>KZT</td></tr></table><table>${head}${movements?`<tr><td>CONTROL-1</td><td>01.10.2026</td><td>BANK</td><td>${accounts[B]} ${B} Синтетический контрагент</td><td>100.25</td><td>0</td><td>Оплата услуг</td></tr><tr><td>CONTROL-2</td><td>02.10.2026</td><td>BANK</td><td>неустановленный получатель</td><td>20.10</td><td>0</td><td>Оплата без реквизитов</td></tr>`:''}<tr><td colspan="4">Исходящий остаток</td><td>0</td><td>0</td><td></td></tr></table></BODY></HTML>`;}

test('saved HTML-XLS bank layout: upload → auto classification → operations → graph, original preserved',{timeout:30000},async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vestigo-html-bank-')),db=openDatabase({dataDirectory:dir});
 try{
  const c=createCase(db,{caseNumber:'SYNTHETIC-HTML'}),bytes=Buffer.from(html());validateDocument('synthetic.xls',bytes);
  const d=saveDocument(db,{caseId:c.id,name:'synthetic.xls',bytes,groupId:'bank',typeId:'statement'});
  const {result}=await extractOriginal(db,c.id,d.id);assert.equal(result.tables.length,1);assert.equal(result.rows.length,2);assert.equal(result.tables[0].headerRow,5);assert.ok(!result.text.includes('must never execute'));
  const classification=classifyDocument({text:result.text,tables:result.tables});assert.equal(classification.status,'automatic');assert.equal(classification.typeId,'statement');
  assert.equal(result.rows[0].amountMinor,10025);assert.equal(result.rows[0].senderId,A);assert.equal(result.rows[0].recipientId,B);assert.equal(result.rows[0].date,'2026-10-01');assert.equal(result.rows[0].row,6);assert.equal(result.rows[1].recipientId,'');assert.equal(result.rows[1].amountMinor,2010);
  storeExtraction(db,c.id,d.id,result);const graph=buildFinancialGraph(financialReport(db,c.id));assert.equal(graph.edges.filter(e=>e.type==='bank_transfer').reduce((n,e)=>n+e.count,0),1);assert.ok(graph.edges.some(e=>e.type==='bank_record_partial'));
  const source=db.prepare('SELECT stored_name FROM documents WHERE id=?').get(d.id);assert.ok(fs.readFileSync(path.join(dir,'uploads',source.stored_name)).equals(bytes));
  assert.throws(()=>validateDocument('bad.xls',Buffer.from('not an excel document')));
 }finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('saved empty HTML-XLS statement is read with zero payments; merged band is not a second empty table',{timeout:30000},async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vestigo-empty-bank-')),db=openDatabase({dataDirectory:dir});
 try{const c=createCase(db,{caseNumber:'EMPTY'}),d=saveDocument(db,{caseId:c.id,name:'empty.xls',bytes:Buffer.from(html(false)),groupId:'bank',typeId:'statement'});const {result}=await extractOriginal(db,c.id,d.id);assert.equal(result.status,'extracted');assert.equal(result.emptyBankStatement,true);assert.equal(result.rows.length,0);assert.equal(result.tables.length,1);}
 finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('internet-bank activity log is readable context, never fabricated transfers even when assigned statement',{timeout:30000},async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vestigo-bank-activity-')),db=openDatabase({dataDirectory:dir});
 try{
  const c=createCase(db,{caseNumber:'ACTIVITY'}),bytes=Buffer.from(['История действий','','Время действия;Тип действия;Тип пользователя;БИН;Наименование организац;Логин;IP адрес;Сообщение',`01.10.2026 12:00;Просмотр;Сотрудник;${A};Синтетический клиент;synthetic;192.0.2.1;Просмотр перевода 123.45 KZT`].join('\n'));
  const d=saveDocument(db,{caseId:c.id,name:'activity.csv',bytes,groupId:'bank',typeId:'statement'});const {result}=await extractOriginal(db,c.id,d.id);assert.equal(result.status,'extracted');assert.equal(result.documentProfile.kind,'bank_activity_log');assert.equal(result.contextOnly,true);assert.ok(result.rows.every(r=>r.type==='context'));assert.equal(result.tables[0].headerRow,3);
  const classification=classifyDocument({text:result.text,tables:result.tables});assert.equal(classification.typeId,'activity_log');assert.equal(classification.status,'automatic');storeExtraction(db,c.id,d.id,result);assert.equal(db.prepare('SELECT COUNT(*) n FROM operations WHERE case_id=?').get(c.id).n,0);
 }finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}
});
