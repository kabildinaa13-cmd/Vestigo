import test from 'node:test';
import assert from 'node:assert/strict';
import {readWorkCost,workCostSources} from '../app/lib/work-cost-sources.mjs';
import {compareWorkCosts} from '../app/lib/work-cost-comparison.mjs';
import {DatabaseSync} from 'node:sqlite';

const planned=readWorkCost({id:'p',type:'work_contract',group:'contract',body:'Договор подряда № 1\nОбщая стоимость работ: 100 000,05 тенге'});
const act=(id,number,amount)=>readWorkCost({id,type:'completion_act',group:'primary',body:`Акт выполненных работ № ${number}\nСтоимость фактического исполнения: ${amount}`});
test('work comparison uses document values exactly, does not need a victim, and preserves source line',()=>{
 const r=compareWorkCosts(planned,[act('a','A-1','40 000,02 KZT')]);
 assert.deepEqual(r,{currency:'KZT',plannedMinor:'10000005',actualMinor:'4000002',differenceMinor:'6000003',exceedsPlan:false});
 assert.equal(planned.facts[0].line,2);
 assert.equal(compareWorkCosts(planned,[act('a','A-1','40 000,02 KZT'),act('b','A-2','0,01 KZT')]).differenceMinor,'6000002');
 assert.equal(compareWorkCosts(planned,[act('a','A-1','100000,06 KZT')]).differenceMinor,'-1');
});
test('no guessed zero, ambiguous totals, invoice sums, victim claims, or duplicate acts',()=>{
 assert.match(compareWorkCosts(planned,[]).error,/акт исполнения/);
 assert.match(compareWorkCosts(planned,[act('a','A-1','10 EUR')]).error,/валютах/);
 assert.match(compareWorkCosts(planned,[act('a','A-1','10 KZT'),act('b','a-1','10 KZT')]).error,/повтор/);
 for(const value of ['12 34,01 KZT','1000,001 KZT','1000,01'])assert.ok(act('a','A-1',value).problem);
 assert.ok(readWorkCost({id:'a',type:'completion_act',body:'Стоимость выполненных работ: 10 KZT\nСтоимость выполненных работ: 11 KZT'}).problem);
 assert.equal(readWorkCost({id:'i',type:'invoice',body:'Общая стоимость работ: 10 KZT'}),null);
 assert.equal(readWorkCost({id:'v',type:'application',body:'Сумма заявленного ущерба: 10 KZT'}),null);
 assert.ok(readWorkCost({id:'v',type:'claimed_damage',body:'Сумма заявленного ущерба: 10 KZT'}).problem);
 assert.match(readWorkCost({id:'a',type:'completion_act',pages:[{page:1,text:'Стоимость выполненных работ: 10 KZT'},{page:2,text:''}]}).problem,/Не все страницы/);
});
test('source lookup reads only linked, active and processed material in the selected case',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  db.exec(`CREATE TABLE cases(id,department_id,status,responsible_user_id); CREATE TABLE users(id,display_name); CREATE TABLE case_deletions(case_id);
    CREATE TABLE documents(id,original_name,sha256); CREATE TABLE case_documents(case_id,document_id);
    CREATE TABLE case_document_metadata(case_id,document_id,group_code,type_code);
    CREATE TABLE case_extractions(case_id,document_id,status,text_content,pages_json);
    CREATE TABLE case_document_exclusions(case_id,document_id);
    INSERT INTO cases VALUES ('one','der-pilot','active',NULL),('two','der-pilot','active',NULL);
    INSERT INTO documents VALUES ('a','act.txt','a'),('b','excluded.txt','b'),('c','other.txt','c'),('d','running.txt','d');
    INSERT INTO case_documents VALUES ('one','a'),('one','b'),('two','c'),('one','d');
    INSERT INTO case_document_metadata VALUES ('one','a','primary','completion_act'),('one','b','primary','completion_act'),('two','c','primary','completion_act'),('one','d','primary','completion_act');
    INSERT INTO case_extractions VALUES ('one','a','review','Стоимость выполненных работ: 10 KZT','[]'),('one','b','extracted','Стоимость выполненных работ: 15 KZT','[]'),('two','c','extracted','Стоимость выполненных работ: 20 KZT','[]'),('one','d','running','Стоимость выполненных работ: 30 KZT','[]');
    INSERT INTO case_document_exclusions VALUES ('one','b');`);
  db.exec('PRAGMA query_only=ON');
  assert.deepEqual(workCostSources(db,'one').map(d=>[d.id,d.minor]),[['a','1000']]);
  assert.throws(()=>workCostSources(db,'absent'),/не найдено/);
 }finally{db.close();}
});
