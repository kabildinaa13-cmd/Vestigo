import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
import {classifyDocument} from '../app/lib/document-classifier.mjs';import {accounts,A,B} from './stage3-fixtures.mjs';
const parse=(file,name,options)=>{const p=spawnSync(process.env.VESTIGO_PYTHON||'.venv/Scripts/python.exe',['scripts/extract_case_document.py',file,name],{input:JSON.stringify({ocrEnabled:false,...options}),encoding:'utf8'});assert.equal(p.status,0,'Synthetic extraction failed');return JSON.parse(p.stdout);};
test('card heading, timestamps, currency in movement cells: known owner IBAN, no fabricated counterparty',{timeout:30000},()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vestigo-card-layout-'));try{
 const file=path.join(dir,'synthetic.csv');fs.writeFileSync(file,[`Выписка по карт счету ${accounts[A]}`,'Клиент: Синтетический владелец','ИИН:','Период выписки: с 01.01.2026 по 30.10.2026','Дата операции;Поступления;Расходы;Описание операции','01.10.2026 10:15;100.25 KZT;0;Зачисление без реквизитов отправителя','02.10.2026 12:03:04;0;20.10 KZT;Покупка без реквизитов получателя'].join('\n'));
 const read=parse(file,'synthetic.csv',{groupId:'bank',typeId:'statement'}),rows=read.rows.filter(r=>r.type==='payment');assert.equal(rows.length,2);assert.equal(rows[0].amountMinor,10025);assert.equal(rows[1].amountMinor,2010);assert.ok(rows.every(r=>r.date&&r.currency==='KZT'&&r.bank.ownerAccount===accounts[A]&&r.bank.ownerId==='IBAN:'+accounts[A]));assert.equal(rows[0].senderId,'');assert.equal(rows[1].recipientId,'');
 const automatic=classifyDocument({name:'synthetic.csv',text:read.text,tables:read.tables});assert.equal(automatic.status,'automatic');assert.equal(automatic.typeId,'statement');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('85 BCC-shaped short dates preserve money; only explicit confirmed year enables dated operations',{timeout:30000},()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vestigo-short-layout-'));try{
 const file=path.join(dir,'synthetic.csv'),body=['Дата;БИН владельца счета;Счет владельца;БИН контрагента;Счет контрагента;Дебет;Кредит;Валюта;Номер документа',...Array.from({length:85},(_,n)=>`01.10.26;${A};${accounts[A]};${B};${accounts[B]};1.01;0;KZT;CONTROL-${n}`)].join('\n');fs.writeFileSync(file,body);
 const before=parse(file,'synthetic.csv',{groupId:'bank',typeId:'statement'}),after=parse(file,'synthetic.csv',{groupId:'bank',typeId:'statement',bankYear:'2026'});assert.equal(before.rows.length,85);assert.ok(before.rows.every(r=>!r.date&&r.amountMinor===101));assert.ok(after.rows.every(r=>r.date==='2026-10-01'&&r.amountMinor===101&&r.senderId===A&&r.recipientId===B));assert.equal(fs.readFileSync(file,'utf8'),body);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
