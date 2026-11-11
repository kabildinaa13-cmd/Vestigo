import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {captureReportFindings} from '../app/lib/report-finding-evidence.mjs';

test('freeze precise, case-scoped examples including invalid raw values, without altering risk records',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  db.exec(`CREATE TABLE case_extracted_rows(case_id,document_id,sheet,row_number,record_json);
   CREATE TABLE case_extractions(case_id,document_id,status,text_content,pages_json);
   CREATE TABLE case_document_metadata(case_id,document_id,type_code,group_code);`);
  const stmt=db.prepare("INSERT INTO case_extracted_rows VALUES (?,'d','Таблица',?,?)");
  const put=(caseId,row,number,lineNumber,amountMinor,raw)=>stmt.run(caseId,row,JSON.stringify({number,lineNumber,amountMinor,amountBasis:'line',currency:'KZT',attributes:{fieldSources:{lineAmount:{column:'Сумма строки',raw,cell:'K'+row}}}}));
  put('c',5,'INV','1',2001,'20,01');put('c',6,'INV','1',2002,'20,02');put('other',5,'INV','1',99999,'999,99');
  put('c',9,'PART','1',3001,'30,01');put('c',10,'PART','2',null,'ошибка');
  const risk=(id,rows,rule='')=>({id,code:'CONFLICTING_DOCUMENT',rule,status:'detected',evidence:rows.map(row=>({documentId:'d',sheet:'Таблица',row}))});
  const open=[risk('conflict',[5,6]),risk('incomplete',[9,10],'Нераспознанная сумма, частичный итог.')],docs=[{id:'d',name:'lines.csv'}];
  const original=JSON.stringify(open);
  const frozen=captureReportFindings(db,'c',open,docs);
  assert.equal(JSON.stringify(open),original);
  assert.match(frozen[0].reportEvidence.reason,/номер позиции/);
  assert.deepEqual(frozen[0].reportEvidence.examples.map(e=>e.values.find(v=>v.key==='lineAmount').raw),['20,01','20,02']);
  assert.deepEqual(frozen[1].reportEvidence.examples[1].values.find(v=>v.key==='lineAmount'),{key:'lineAmount',label:'Сумма строки',raw:'ошибка',cell:'K10',missing:false,unreadable:true});
  db.exec('DELETE FROM case_extracted_rows');
  assert.equal(frozen[1].reportEvidence.examples[1].row,10);
  assert.equal(captureReportFindings(db,'c',open,docs)[0].reportEvidence.examples.length,0);
 }finally{db.close();}
});
