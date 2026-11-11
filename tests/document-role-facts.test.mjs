import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {extractLabelledFacts,automaticFactDecision,analyzeStandaloneText} from '../app/lib/document-facts.mjs';
import {openDatabase,createCase} from '../app/lib/vestigo-db.mjs';
import {saveDocument} from '../app/lib/documents.mjs';
import {processCaseDocument} from '../app/lib/document-processing.mjs';
import {caseAnalysis,reviewCaseItem} from '../app/lib/case-analysis.mjs';
import {caseAnalyticsDataset} from '../app/lib/case-analytics.mjs';
import {analyzePdfResult} from '../app/lib/pdf-analysis.mjs';

const settings={groupId:'contract',typeId:'agreement'};
const roles='Исполнитель: ТОО «Контроль-А»\nБИН: 990000000001\nЗаказчик: ТОО «Контроль-Б»\nБИН: 990000000002';
const contract=`Договор оказания услуг № CONTROL-1 от 20.10.2026\n${roles}\nОбщая стоимость договора: 1 200 000 тенге\nНДС: 128571,43 тенге\nПредмет договора: испытание оборудования`;

test('completion act: direct roles, plain date and actual cost create a documentary operation, not a payment',()=>{
 const settings={groupId:'primary',typeId:'completion_act'};
 const text=['Акт выполненных работ № ACT-CONTROL','Дата: 03.10.2026','БИН заказчика: 990000000002','БИН исполнителя: 990000000001','Стоимость фактического исполнения: 40 000,02 тенге'].join('\n');
 const result=analyzeStandaloneText({status:'review',text,rows:[]},settings);
 assert.equal(result.status,'extracted');
 assert.deepEqual(result.rows.map(r=>[r.type,r.date,r.number,r.senderId,r.recipientId,r.amountMinor,r.currency]),[['primary','2026-10-03','ACT-CONTROL','990000000001','990000000002',4000002,'KZT']]);
 const ambiguous=analyzeStandaloneText({status:'review',text:text+'\nСтоимость фактического исполнения: 41 000,02 тенге',rows:[]},settings);
 assert.equal(ambiguous.rows.length,0);
 assert.ok(ambiguous.automaticFacts.conflicts.includes('amount'));
 assert.deepEqual(ambiguous.automaticFacts.fieldLocations.map(f=>f.line),[5,6]);
});

test('commercial roles, header date/number and integer total; VAT is not the contract total',()=>{
 const f=extractLabelledFacts(contract,settings);
 assert.equal(f.fields.senderId,'990000000001');assert.equal(f.fields.recipientId,'990000000002');
 assert.equal(f.fields.senderName,'ТОО «Контроль-А»');assert.equal(f.fields.date,'2026-10-20');
 assert.equal(f.fields.number,'CONTROL-1');assert.equal(f.fields.amount,'1 200 000');assert.equal(f.fields.currency,'KZT');
 assert.equal(automaticFactDecision(f,settings).eligible,true);assert.ok(f.evidence.senderId[0].includes('Исполнитель'));
});

for(const [left,right] of [['Поставщик','Покупатель'],['Продавец','Покупатель'],['Арендодатель','Арендатор']])test(`bounded role pair: ${left}/${right}`,()=>{
 const f=extractLabelledFacts(contract.replace('Исполнитель',left).replace('Заказчик',right),settings);
 assert.equal(automaticFactDecision(f,settings).eligible,true);
});

test('act own date and number are not the referenced contract date/number',()=>{
 const f=extractLabelledFacts(`Акт выполненных работ № ACT-1 от 21.10.2026\n${roles}\nСтоимость выполненных работ: 1200000,00 тенге\nОснование: договор № CONTROL-1 от 20.10.2026`,{groupId:'primary',typeId:'completion_act'});
 assert.equal(f.fields.number,'ACT-1');assert.equal(f.fields.date,'2026-10-21');assert.equal(f.fields.reference,'CONTROL-1');
 assert.equal(automaticFactDecision(f,{groupId:'primary',typeId:'completion_act'}).eligible,true);
});

test('different IDs assigned to the same role block automatic extraction',()=>{
 for(const text of [contract.replace('БИН: 990000000001','БИН: 990000000001\nИИН/БИН: 990000000003'),contract+'\nБИН поставщика: 990000000003']){
  const f=extractLabelledFacts(text,settings);assert.ok(f.conflicts.includes('senderId'));assert.equal(automaticFactDecision(f,settings).eligible,false);
 }
});

test('bank BIN, unlabelled numbers and zeros never become commercial participants',()=>{
 const base=contract.replace('БИН: 990000000001','Банк: АО Контрольный банк\nБИН: 990000000003');
 assert.equal(extractLabelledFacts(base,settings).fields.senderId,'');
 assert.equal(extractLabelledFacts(contract.replace('БИН: 990000000001','990000000001'),settings).fields.senderId,'');
 const f=extractLabelledFacts(contract.replace('990000000001','000000000000'),settings);assert.equal(automaticFactDecision(f,settings).eligible,false);
});

test('contradictory totals, dates and invalid calendar dates are not silently selected',()=>{
 for(const text of [contract+'\nСумма договора: 1300000 тенге',contract+'\nДата документа: 22.10.2026',contract+'\nДата документа: 31.02.2026',contract.replace('20.10.2026','31.02.2026'),contract+'\nВалюта: USD'])
  assert.equal(automaticFactDecision(extractLabelledFacts(text,settings),settings).eligible,false);
});

test('text fallback never replaces invoice goods lines or partial financial table rows',()=>{
 const result={text:contract,tables:[{sheet:'Control'}],rows:[{senderId:'',recipientId:'',amountMinor:123}],warnings:[]};
 assert.equal(analyzeStandaloneText(result,settings),result);
 const invoice={...result,rows:[]};assert.equal(analyzeStandaloneText(invoice,{groupId:'primary',typeId:'invoice'}),invoice);
});

test('addenda, specifications and claims do not become completed payments',()=>{
 for(const s of [{groupId:'contract',typeId:'addendum'},{groupId:'contract',typeId:'specification'},{groupId:'victim',typeId:'application'},{groupId:'tax',typeId:'declaration'}])
  assert.equal(automaticFactDecision(extractLabelledFacts(contract,s),s).eligible,false);
});

test('same fact rules apply to a native PDF page and preserve the page source',()=>{
 const r=analyzePdfResult({status:'review',text:contract,tables:[],rows:[],warnings:[],pages:[{page:1,text:contract,textSource:'native'}],pageAudit:{totalPages:1,pagesWithText:1,pagesWithoutText:[]}});
 assert.equal(r.documentAnalysis.automaticallyExtracted,1);assert.equal(r.rows[0].type,'contract');assert.equal(r.rows[0].attributes.sourcePage,1);
 assert.equal(r.rows[0].amountMinor,120000000);assert.equal(r.rows[0].manualSource,false);
});

test('actual handlers: contract and act -> persisted operations, participants, matching, graph, source; reprocessing retains review',async()=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'vestigo-role-flow-')),db=openDatabase({dataDirectory:folder});
 try{
  const c=createCase(db,{caseNumber:'SYNTHETIC-ROLE-CONTROL'}),documents=[];
  for(const [name,text,s] of [
   ['control-contract.txt',contract,settings],
   ['control-act.txt',`Акт выполненных работ № ACT-1 от 21.10.2026\n${roles}\nСтоимость выполненных работ: 1200000 тенге\nОснование: договор № CONTROL-1`,{groupId:'primary',typeId:'completion_act'}]
  ]){const d=saveDocument(db,{caseId:c.id,name,bytes:Buffer.from(text),...s});documents.push(d);await processCaseDocument(db,c.id,d.id);}
  const a=caseAnalysis(db,c.id);assert.equal(a.operationCount,2);assert.ok(a.operations.every(o=>!o.confirmed));
  assert.ok(a.matches.length>=1);const graph=caseAnalyticsDataset(db,c.id);assert.equal(graph.nodes.length,2);assert.ok(graph.edges.length>=2);
  assert.ok(a.operations.every(o=>o.sources.length&&o.sources.every(s=>documents.some(d=>d.id===s.documentId))));
  const op=a.operations.find(o=>o.type==='contract');reviewCaseItem(db,c.id,{kind:'operation',id:op.id,status:'confirmed',note:'Synthetic control, not a real case'});
  await processCaseDocument(db,c.id,documents[0].id);const again=caseAnalysis(db,c.id);
  assert.equal(again.operationCount,2);assert.equal(again.operations.find(o=>o.id===op.id).confirmed,true);
 }finally{db.close();fs.rmSync(folder,{recursive:true,force:true});}
});

test('actual DOCX handler: role requisites in layout table are not mistaken for operation rows',async()=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'vestigo-docx-role-')),db=openDatabase({dataDirectory:folder});
 try{
  const file=path.join(folder,'synthetic-layout.docx');
  // Minimal synthetic OOXML input, not a user document. The application reader
  // must read both paragraphs and table text; no Office automation is involved.
  const generator=`import sys,zipfile,json,html
p=json.loads(sys.stdin.buffer.read().decode('utf-8'))
paragraph=lambda t:'<w:p><w:r><w:t>'+html.escape(t)+'</w:t></w:r></w:p>'
rows=['<w:tr>'+''.join('<w:tc>'+paragraph(v)+'</w:tc>' for v in row)+'</w:tr>' for row in p['table']]
xml='<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'+''.join(paragraph(t) for t in p['lines'])+'<w:tbl>'+''.join(rows)+'</w:tbl></w:body></w:document>'
with zipfile.ZipFile(sys.argv[1],'w') as z:
 z.writestr('word/document.xml',xml)
 z.writestr('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
`;
  const generated=spawnSync(path.join(process.cwd(),'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python'),['-c',generator,file],{input:JSON.stringify({lines:['Договор оказания услуг № WORD-1 от 20.10.2026','Общая стоимость договора: 1 200 000 тенге'],table:[['Исполнитель:','ТОО «Контроль-А»'],['БИН:','990000000001'],['Заказчик:','ТОО «Контроль-Б»'],['БИН:','990000000002']]}),encoding:'utf8',windowsHide:true});
  assert.equal(generated.status,0,generated.stderr);
  const c=createCase(db,{caseNumber:'SYNTHETIC-WORD-ROLES'}),doc=saveDocument(db,{caseId:c.id,name:'synthetic-layout.docx',bytes:fs.readFileSync(file),...settings});
  await processCaseDocument(db,c.id,doc.id);const a=caseAnalysis(db,c.id);
  assert.equal(a.operationCount,1,JSON.stringify(db.prepare('SELECT summary_json,text_content FROM case_extractions WHERE case_id=?').all(c.id)));assert.equal(a.operations[0].amountMinor,120000000);assert.equal(a.operations[0].number,'WORD-1');
  const extraction=db.prepare('SELECT status,summary_json FROM case_extractions WHERE case_id=? AND document_id=?').get(c.id,doc.id);
  assert.equal(extraction.status,'extracted');assert.equal(JSON.parse(extraction.summary_json).unparsedRows,0);
  assert.ok(db.prepare('SELECT COUNT(*) n FROM case_source_rows WHERE case_id=? AND document_id=?').get(c.id,doc.id).n>0);
 }finally{db.close();fs.rmSync(folder,{recursive:true,force:true});}
});
