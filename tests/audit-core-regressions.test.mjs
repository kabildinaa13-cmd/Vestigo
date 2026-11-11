import test from "node:test";import assert from "node:assert/strict";
import fs from "node:fs";import os from "node:os";import path from "node:path";import http from "node:http";
import {openDatabase,createCase} from "../app/lib/vestigo-db.mjs";
import {saveDocument} from "../app/lib/documents.mjs";
import {storeExtraction,caseAnalysis} from "../app/lib/case-analysis.mjs";
import {refreshStoredCaseDocuments} from "../app/lib/case-refresh.mjs";
import {processCaseDocument} from "../app/lib/document-processing.mjs";
import {buildBankLedger} from "../app/lib/bank-analysis.mjs";
import {caseAnalyticsDataset} from "../app/lib/case-analytics.mjs";
import {matchCaseDocuments} from "../app/lib/document-matching.mjs";
import {enqueueProcessing,claimProcessing,completeProcessing,failProcessing} from "../app/lib/processing-queue.mjs";
const alpha="990000000001",beta="990000000002",accountA="KZ86125KZT5004100100",accountB="DE89370400440532013000";
const source=n=>({documentId:`synthetic-${n}`,name:"synthetic.csv",sheet:"CSV",row:n});
const bank=(n,overrides={},extra={})=>({source:source(n),row:{type:"payment",number:`PAY-${n}`,date:"2026-10-01",senderId:alpha,recipientId:beta,amountMinor:10000,currency:"KZT",...overrides,bank:{kind:"transfer",ownerId:alpha,ownerAccount:accountA,senderAccount:accountA,recipientAccount:accountB,direction:"outgoing",rawAmountMinor:10000,feeMinor:null,issues:[],...extra}}});
function setup(){const directory=fs.mkdtempSync(path.join(os.tmpdir(),"vestigo-audit-v3-")),db=openDatabase({dataDirectory:directory}),c=createCase(db,{caseNumber:"ONLY-SYNTHETIC-AUDIT"});return {db,c,close(){db.close();fs.rmSync(directory,{recursive:true,force:true});}};}

test("graph date ranges are chronological, not dependent on upload order",()=>{
 const s=setup();try{const d=saveDocument(s.db,{caseId:s.c.id,name:"synthetic-years.csv",bytes:Buffer.from("synthetic dates"),groupId:"bank",typeId:"statement"});const rows=[bank(2,{sheet:"CSV",row:2,raw:{},date:"2023-10-01"}).row,bank(3,{sheet:"CSV",row:3,raw:{},date:"2022-10-01"}).row];storeExtraction(s.db,s.c.id,d.id,{version:1,status:"extracted",rows,pages:[],tables:[],text:"",warnings:[],unparsedRows:0},{groupId:"bank",typeId:"statement"});const edge=caseAnalyticsDataset(s.db,s.c.id).edges[0];assert.deepEqual(edge.years,[2022,2023]);assert.deepEqual(edge.dates,["2022-10-01","2023-10-01"]);}finally{s.close();}
});

test("the same explicit transaction in both parties' statements is one graph payment, with two sources and separate owner ledger views",()=>{
 const s=setup();try{
  const a=bank(2,{sheet:"CSV",row:2,raw:{side:"sender"}},{transactionId:"GLOBAL-TRANSACTION-1",feeMinor:50,feeMode:"separate",rawAmountMinor:10050});
  const b=bank(3,{sheet:"CSV",row:2,raw:{side:"recipient"}},{transactionId:"GLOBAL-TRANSACTION-1",ownerId:beta,ownerAccount:accountB,direction:"incoming",feeMode:"unknown"});
  for(const item of [a,b]){const doc=saveDocument(s.db,{caseId:s.c.id,name:item.source.documentId+".csv",bytes:Buffer.from(item.source.documentId),groupId:"bank",typeId:"statement"});storeExtraction(s.db,s.c.id,doc.id,{version:1,status:"extracted",rows:[item.row],pages:[],tables:[],text:"",warnings:[],unparsedRows:0},{groupId:"bank",typeId:"statement"});}
  const analysis=caseAnalysis(s.db,s.c.id,{all:true});assert.equal(analysis.operationCount,1);assert.equal(analysis.operations[0].sources.length,2);assert.equal(analysis.operations[0].conflict,false);assert.equal(analysis.operations[0].amountMinor,10000);
  const ledger=buildBankLedger([a,b]);assert.equal(ledger.entries.length,2);assert.equal(ledger.summaries[0].feesMinor,"50");
 }finally{s.close();}
});

test("accounts owned by different companies are NOT an internal transfer",()=>{
 const a=bank(2),b=bank(3,{},{ownerId:beta,ownerAccount:accountB,direction:"incoming"});
 const ledger=buildBankLedger([a,b]);assert.ok(ledger.entries.every(e=>!e.internalTransfer));assert.equal(ledger.summaries[0].outgoingMinor,"10000");assert.equal(ledger.summaries[0].incomingMinor,"10000");
 const sameOwner=bank(3,{recipientId:alpha},{ownerId:alpha,ownerAccount:accountB,direction:"incoming"});
 const own=buildBankLedger([bank(2,{recipientId:alpha}),sameOwner]);assert.ok(own.entries.every(e=>e.internalTransfer));assert.equal(own.summaries[0].outgoingMinor,"0");
});

test("undated bank rows stay inspectable but are not included in dated financial totals",()=>{
 const ledger=buildBankLedger([bank(2,{date:""})]);assert.equal(ledger.entries.length,1);assert.ok(ledger.entries[0].issues.length);assert.equal(ledger.summaries[0].incomplete,1);assert.equal(ledger.summaries[0].outgoingMinor,"0");
});

test("an equal amount cannot override an explicit different contract",()=>{
 const contract=n=>({id:`c${n}`,type:"contract",number:String(n),senderId:alpha,recipientId:beta,currency:"KZT",amount:10000,date:"2026-10-01",sources:[source(n)]});
 const invoice={id:"i",type:"invoice",number:"ESF-16",senderId:alpha,recipientId:beta,currency:"KZT",amount:10000,date:"2026-10-01",sources:[source(30)]};
 const payment={id:"p",type:"payment",number:"PAY-15",senderId:beta,recipientId:alpha,currency:"KZT",amount:10000,date:"2026-10-02",purpose:"Оплата по договору № 15",sources:[source(31)]};
 const records=[{source:source(30),row:{contractRef:"16"}}];
 const result=matchCaseDocuments([contract(15),contract(16),invoice,payment],records);
 assert.ok(result.links.some(l=>l.leftId==="c15"&&l.rightId==="p"));assert.ok(result.links.some(l=>l.leftId==="c16"&&l.rightId==="i"));
 assert.equal(result.links.some(l=>l.leftId==="i"&&l.rightId==="p"),false);
 const conflict=matchCaseDocuments([contract(15),contract(16),invoice,{...payment,purpose:"Договор № 15, оплата ESF-16"}],records);
 assert.equal(conflict.links.some(l=>l.leftId==="i"&&l.rightId==="p"),false);assert.ok(conflict.risks.some(r=>r.code==="DOCUMENT_REFERENCE_CONFLICT"));
});

test("refresh does not replace explicitly entered document facts with a new PDF guess",()=>{
 const s=setup();try{
  const d=saveDocument(s.db,{caseId:s.c.id,name:"synthetic.txt",bytes:Buffer.from("Synthetic original"),groupId:"contract",typeId:"supply_agreement"});
  const fields={senderId:alpha,recipientId:beta,amount:"123,45",currency:"KZT",date:"2026-10-01",number:"MANUAL-1"};
  const row={...fields,amountMinor:12345,type:"contract",sheet:"Реквизиты, введённые специалистом",row:2,raw:{original:"Synthetic"},manualSource:true};
  storeExtraction(s.db,s.c.id,d.id,{version:1,status:"extracted",rows:[row],pages:[{page:1,text:"Неполный текст исходного PDF",textSource:"native"}],tables:[],text:"Неполный текст исходного PDF",warnings:[],unparsedRows:0},{groupId:"contract",typeId:"supply_agreement",manualConfirmed:true,documentFields:fields});
  refreshStoredCaseDocuments(s.db,s.c.id);assert.equal(caseAnalysis(s.db,s.c.id).operationCount,1);assert.equal(caseAnalysis(s.db,s.c.id).operations[0].number,"MANUAL-1");assert.equal(caseAnalysis(s.db,s.c.id).operations[0].manualSource,true);
 }finally{s.close();}
});

test("a failed later attempt cannot be disguised by an older completed job on reupload",()=>{
 const s=setup();try{
  const d=saveDocument(s.db,{caseId:s.c.id,name:"synthetic.csv",bytes:Buffer.from("synthetic"),groupId:"bank",typeId:"statement"});
  enqueueProcessing(s.db,{caseId:s.c.id,documentId:d.id});let job=claimProcessing(s.db);completeProcessing(s.db,job.id,job.lease_token,{summary:{status:"extracted"}});
  enqueueProcessing(s.db,{caseId:s.c.id,documentId:d.id,force:true});job=claimProcessing(s.db);failProcessing(s.db,job.id,job.lease_token,new Error("Synthetic read failure"));
  const again=enqueueProcessing(s.db,{caseId:s.c.id,documentId:d.id});assert.equal(again.duplicate,false);assert.equal(again.job.state,"queued");
 }finally{s.close();}
});

test("failure of optional shared publication does not turn committed case extraction into failure",async()=>{
 const s=setup(),previous=process.env.VESTIGO_SERVICE_PORT;
 const server=http.createServer((_req,res)=>{res.writeHead(503,{"content-type":"application/json"});res.end(JSON.stringify({error:"Synthetic shared publication failure"}));});
 await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));process.env.VESTIGO_SERVICE_PORT=String(server.address().port);
 try{
  const csv="БИН поставщика;БИН получателя;Сумма с НДС;Дата;Номер ЭСФ;Валюта\n990000000001;990000000002;123,45;2026-10-01;ESF-AUDIT-1;KZT";
  const d=saveDocument(s.db,{caseId:s.c.id,name:"synthetic.csv",bytes:Buffer.from(csv),groupId:"primary",typeId:"invoice"});
  const result=await processCaseDocument(s.db,s.c.id,d.id,{publishAnalytics:true});assert.equal(result.summary.status,"extracted");assert.equal(result.sharedPublication.status,"failed");assert.equal(caseAnalysis(s.db,s.c.id).operationCount,1);
  assert.equal(s.db.prepare("SELECT status FROM case_extractions WHERE case_id=? AND document_id=?").get(s.c.id,d.id).status,"extracted");assert.equal(s.db.prepare("SELECT status FROM document_analytics WHERE case_id=? AND document_id=?").get(s.c.id,d.id).status,"failed");
 }finally{if(previous===undefined)delete process.env.VESTIGO_SERVICE_PORT;else process.env.VESTIGO_SERVICE_PORT=previous;await new Promise(resolve=>server.close(resolve));s.close();}
});
