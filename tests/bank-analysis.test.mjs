import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";import os from "node:os";import path from "node:path";
import {buildBankLedger,bankAnalysis} from "../app/lib/bank-analysis.mjs";
import {canonicalBankSourceRows,validIban,isBankFee} from "../app/lib/bank-identities.mjs";
import {openDatabase,createCase} from "../app/lib/vestigo-db.mjs";
import {saveDocument} from "../app/lib/documents.mjs";
import {storeExtraction,caseAnalysis,reviewCaseItem,extractOriginal} from "../app/lib/case-analysis.mjs";
import {caseAnalyticsDataset} from "../app/lib/case-analytics.mjs";
const owner="990000000001",supplier="990000000002",iban="KZ86125KZT5004100100";
const record=(r={},b={})=>({sheet:"CSV",row:2,type:"payment",senderId:owner,recipientId:supplier,senderName:"ТОО Владелец",recipientName:"ТОО Поставщик",date:"2026-10-01",currency:"KZT",amountMinor:100000,number:"PAY-1",purpose:"Оплата ESF-1 по договору D-1",status:"CREATED",raw:{},...r,bank:{kind:"transfer",direction:"outgoing",ownerId:owner,ownerBin:owner,ownerAccount:iban,rawAmountMinor:100050,feeMinor:50,feeMode:"debit_includes_fee",transactionId:"PAY-1",issues:[],...b}});
const source=(n)=>({documentId:"doc-"+n,name:"bank.csv",sheet:"CSV",row:n});
test("commissions/refunds and duplicate sources stay separate from principal",()=>{
 const transfer=record(),fee=record({row:3,number:"F-1",amountMinor:50,purpose:"Комиссия банка"},{kind:"fee",transactionId:"F-1",feeReference:"PAY-1",feeMinor:null,rawAmountMinor:50});
 const refund=record({row:4,number:"R-1",senderId:supplier,recipientId:owner,amountMinor:10,purpose:"Возврат комиссии"},{kind:"fee_refund",direction:"incoming",transactionId:"R-1",feeMinor:null,rawAmountMinor:10});
 const result=buildBankLedger([{row:transfer,source:source(2)},{row:transfer,source:source(5)},{row:fee,source:source(3)},{row:refund,source:source(4)}]);
 assert.equal(result.entries.length,3);assert.equal(result.summaries[0].outgoingMinor,"100000");assert.equal(result.summaries[0].feesMinor,"50");assert.equal(result.summaries[0].feeRefundsMinor,"10");assert.equal(result.counterparties.length,1);
 assert.equal(result.entries[0].sources.length,2);assert.ok(result.entries.find(e=>e.kind==="fee").countedWith);
});
test("equal amounts alone never deduplicate fees or unnumbered payments; currencies remain separate",()=>{
 const rows=[{row:record({number:""},{transactionId:"",feeMinor:null}),source:source(2)},{row:record({number:""},{transactionId:"",feeMinor:null}),source:source(3)},{row:record({currency:"USD"}),source:source(4)}];
 const result=buildBankLedger(rows);assert.equal(result.entries.length,3);assert.equal(result.summaries.length,2);assert.equal(result.summaries.find(s=>s.currency==="KZT").outgoingMinor,"200000");
});
test("IBAN alias requires explicit unique BIN evidence",()=>{
 assert.equal(validIban(iban),iban);assert.equal(validIban("KZ00125KZT5004100100"),"");
 const wrap=row=>({record_json:JSON.stringify(row)}),unidentified=record({senderId:"IBAN:"+iban},{ownerId:"IBAN:"+iban,ownerBin:""});
 const result=canonicalBankSourceRows([wrap(unidentified),wrap(record())]);assert.equal(JSON.parse(result[0].record_json).senderId,owner);
 const conflicting=record({senderId:supplier},{ownerId:supplier,ownerBin:supplier});assert.equal(JSON.parse(canonicalBankSourceRows([wrap(unidentified),wrap(record()),wrap(conflicting)])[0].record_json).senderId,"IBAN:"+iban);
 assert.ok(isBankFee({type:"payment",purpose:"Комиссия банка за перевод"}));assert.equal(isBankFee({type:"contract",purpose:"Комиссия банка"}),false);
});
test("real CSV -> extraction -> matching -> counterparty ledger -> existing graph; exclusion and case isolation",async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"vestigo-bank-integration-")),db=openDatabase({dataDirectory:dir});
 try{
  const a=createCase(db,{caseNumber:"BANK-A"}),b=createCase(db,{caseNumber:"BANK-B"});
  const invoice=saveDocument(db,{caseId:a.id,name:"invoice.csv",bytes:Buffer.from("invoice"),groupId:"primary",typeId:"invoice"});
  const invoiceRow={...record({type:"invoice",senderId:supplier,recipientId:owner,number:"ESF-1",amountMinor:100000}),bank:undefined};
  const result=rows=>({version:1,status:"extracted",rows,tables:[],warnings:[],text:"",pages:[],unparsedRows:0});
  storeExtraction(db,a.id,invoice.id,result([invoiceRow]));
  const csv="Дата;БИН контрагента;Наименование контрагента;Дебет;Кредит;Комиссия;Номер документа;Назначение платежа\n01.10.2026;990000000002;ТОО Поставщик;1000,50;0;0,50;PAY-1;Оплата ESF-1";
  const doc=saveDocument(db,{caseId:a.id,name:"bank.csv",bytes:Buffer.from(csv),groupId:"bank",typeId:"statement"});
  const parsed=await extractOriginal(db,a.id,doc.id,{ownerId:owner,ownerAccount:iban,defaultCurrency:"KZT",bankFeeMode:"debit_includes_fee"});
  storeExtraction(db,a.id,doc.id,parsed.result,parsed.settings);
  const analysis=caseAnalysis(db,a.id,{all:true});assert.equal(analysis.matches.length,1);assert.equal(analysis.operations.find(o=>o.type==="payment").amountMinor,100000);
  let ledger=bankAnalysis(db,a.id);assert.equal(ledger.counterpartyCount,1);assert.equal(ledger.summaries[0].feesMinor,"50");assert.equal(ledger.entries[0].matches.length,1);
  assert.equal(bankAnalysis(db,b.id).entries.length,0);
  const graph=caseAnalyticsDataset(db,a.id);assert.ok(graph.nodes.some(n=>n.bin===supplier));assert.equal(graph.edges.find(e=>e.relations[0]==="Платёж").dealAmount,1000);
  storeExtraction(db,a.id,doc.id,parsed.result,parsed.settings);assert.equal(bankAnalysis(db,a.id).entries.length,1);
  reviewCaseItem(db,a.id,{kind:"document",id:doc.id,status:"excluded",note:"Тест исключения"});assert.equal(bankAnalysis(db,a.id).entries.length,0);
 }finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}
});
