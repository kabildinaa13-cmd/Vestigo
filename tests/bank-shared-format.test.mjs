import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {spawnSync} from 'node:child_process';
import {buildBankLedger} from '../app/lib/bank-analysis.mjs';import {bankFlowAnalysis,bankPerspectiveCandidates,canonicalBankTransfers} from '../app/lib/financial-flows.mjs';import {bankPaymentClass} from '../app/lib/bank-identities.mjs';import {buildFinancialGraph} from '../app/lib/financial-graph-core.mjs';
const folder='tests/fixtures/bank-shared/',controls=JSON.parse(fs.readFileSync(folder+'controls.json')),python=process.env.VESTIGO_PYTHON||'.venv/Scripts/python.exe';
const read=(name,options={},asName=name)=>{const p=spawnSync(python,['scripts/extract_case_document.py',folder+name,asName],{input:JSON.stringify({groupId:'bank',typeId:'statement',...options}),encoding:'utf8'});assert.equal(p.status,0,p.stderr);return JSON.parse(p.stdout);};
const records=(r,id)=>r.rows.map(row=>({row,source:{documentId:id,name:id+'.xlsx',sheet:row.sheet,row:row.row}}));
test('actual XLSX shared header: eight full, one partial, one conflicting; footer is not a payment',()=>{
 const r=read('shared-owner-a.xlsx');assert.equal(r.rows.length,10);assert.equal(r.quality.eligibleRows,8);assert.equal(r.quality.reviewRows,2);assert.equal(r.quality.issueCounts.IGNORED_TOTAL,2);assert.equal(r.quality.issueCounts.IGNORED_NOTE,1);
 const p=r.rows.find(x=>x.number==='P1'),incoming=r.rows.find(x=>x.number==='P2');assert.equal(p.senderId,controls.A.bin);assert.equal(p.recipientId,controls.B.bin);assert.equal(p.amountMinor,100000);assert.equal(p.date,'2026-10-01');assert.equal(p.bank.senderAccount,controls.A.account);assert.equal(p.bank.recipientAccount,controls.B.account);assert.equal(incoming.senderId,controls.C.bin);assert.equal(incoming.recipientId,controls.A.bin);
 const partial=r.rows.find(x=>x.number==='PARTIAL');assert.equal(partial.bank.normalizationStatus,'partial');assert.equal(partial.senderId,controls.A.bin);assert.equal(partial.recipientId,'');assert.equal(partial.amountMinor,7000);assert.ok(partial.bank.missingFields.includes('recipient'));assert.equal(r.rows.find(x=>x.number==='CONFLICT').amountMinor,null);
});
test('filename is never bank owner evidence; employee-supplied owner/year can normalize old short dates',()=>{
 const unknown=read('shared-no-owner.xlsx',{},controls.A.bin+' bank.xlsx');assert.equal(unknown.quality.eligibleRows,0);assert.ok(unknown.rows.every(r=>!r.bank.ownerId));
 const fixed=read('shared-no-owner.xlsx',{ownerId:controls.A.bin,ownerAccount:controls.A.account,bankYear:'2026',defaultCurrency:'KZT'});assert.equal(fixed.quality.eligibleRows,1);assert.equal(fixed.rows[0].date,'2026-10-01');
 const contradictory=read('shared-owner-a.xlsx',{ownerId:controls.C.bin});assert.equal(contradictory.quality.eligibleRows,0);assert.ok(contradictory.rows[0].bank.issues.some(s=>s.includes('не совпадает')));
});
test('bank-only ledger and graph preserve noncommercial movements, separate commission and unknown party, deduplicate explicit mirror',()=>{
 const a=read('shared-owner-a.xlsx'),b=read('shared-owner-b.xlsx'),ledger=buildBankLedger([...records(a,'a'),...records(b,'b')]);
 const tax=ledger.entries.find(x=>x.transactionId==='TAX'),pension=ledger.entries.find(x=>x.transactionId==='PENSION'),fee=ledger.entries.find(x=>x.transactionId==='FEE');assert.equal(tax.category,'tax');assert.equal(pension.category,'pension');assert.equal(fee.kind,'fee');assert.equal(fee.amountMinor,1000);assert.ok(ledger.summaries.some(x=>x.feesMinor==='1000'));assert.ok(ledger.summaries.some(x=>x.incomplete>0));
 for(const n of ['TAX','PENSION','LOAN','INTERNAL'])assert.notEqual(bankPaymentClass(a.rows.find(x=>x.number===n)),'commercial_candidate');
 const flow=bankFlowAnalysis(ledger.entries);assert.equal(flow.mergedPerspectives,1);assert.equal(flow.uniqueTransfers,8);assert.ok(flow.transfers.every(x=>x.senderId&&x.recipientId));
 const graph=buildFinancialGraph({bank:ledger.entries,invoices:[],documentRelations:[],reconciliation:{payments:[],allocations:[],candidates:[]}},{graphMode:'money'});assert.ok(graph.nodes.length>0);assert.ok(graph.edges.some(e=>e.type==='bank_transfer'&&e.operations.some(o=>o.category==='tax')));assert.ok(graph.edges.some(e=>e.type==='bank_transfer'&&e.operations.some(o=>o.category==='pension')));const first=graph.edges.flatMap(e=>e.operations).find(e=>e.explicitTransactionId==='T-001');assert.equal(first.sources.length,2);assert.ok(first.sources.every(s=>s.sheet&&s.row));assert.ok(graph.edges.every(e=>!e.from.endsWith('party:')&&!e.to.endsWith('party:')));
});
test('empty graph explains legacy normalization and filter problems; no fake nodes',()=>{
 const graph=buildFinancialGraph({bank:[],invoices:[],bankDiagnostics:{sourceRows:89,operations:0,missingOwners:89,missingParties:89,missingDates:89,legacyRows:89,filtersActive:true},reconciliation:{payments:[],candidates:[],allocations:[]}},{graphMode:'money'});assert.equal(graph.nodes.length,0);assert.ok(graph.diagnostics.some(s=>s.includes('владелец')));assert.ok(graph.diagnostics.some(s=>s.includes('дата')));assert.ok(graph.diagnostics.some(s=>s.includes('фильтры')));
});
test('opposite statement observations without global ID are probable or ambiguous, never automatically merged',()=>{
 const ledger=buildBankLedger([...records(read('shared-owner-a.xlsx'),'a'),...records(read('shared-owner-b.xlsx'),'b')]);const pair=ledger.entries.filter(e=>e.explicitTransactionId==='T-001').map(e=>({...e,explicitTransactionId:''}));
 assert.equal(bankPerspectiveCandidates(pair)[0].status,'probable');assert.equal(canonicalBankTransfers(pair).length,2);
 assert.equal(bankPerspectiveCandidates([...pair,{...pair[0],id:'another-observation'}])[0].status,'ambiguous');
 assert.equal(bankPerspectiveCandidates([pair[0],{...pair[1],purpose:'Другое основание'}]).length,0);
});
