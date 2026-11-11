import test from "node:test";import assert from "node:assert/strict";
import {matchCaseDocuments} from "../app/lib/document-matching.mjs";
const invoice={id:"i",type:"invoice",number:"ESF-15",senderId:"990000000001",recipientId:"990000000002",currency:"KZT",amount:800000000,date:"2026-10-01",sources:[{documentId:"invoice",sheet:"ЭСФ",row:2}]};
const payment=(id,amount,extra={})=>({id,type:"payment",number:id,senderId:invoice.recipientId,recipientId:invoice.senderId,currency:"KZT",amount,date:"2026-10-03",purpose:"Оплата ESF-15",sources:[{documentId:id,sheet:"CSV",row:2}],...extra});
test("partial payments sum once; explicit refund reduces amount; currencies never mix",()=>{
 const operations=[invoice,payment("p1",600000000),payment("p2",600000000),payment("refund",400000000,{senderId:invoice.senderId,recipientId:invoice.recipientId,purpose:"Возврат оплаты ESF-15",bank:{kind:"refund"}}),payment("USD",800000000,{currency:"USD"})];
 const result=matchCaseDocuments(operations);assert.equal(result.links.length,3);assert.ok(result.links.some(l=>l.method==="refund_reference"));assert.equal(result.risks.some(r=>r.code==="PAYMENT_AMOUNT_DIFFERENCE"),false);
 const partial=matchCaseDocuments([invoice,payment("p1",600000000)]);assert.equal(partial.risks.find(r=>r.code==="PAYMENT_AMOUNT_DIFFERENCE").calculation.differenceMinor,"-200000000");
});
test("combined payment is not allocated to multiple invoices and no documents is not a crime finding",()=>{
 const result=matchCaseDocuments([invoice,{...invoice,id:"i2",number:"ESF-16"},payment("p",1600000000,{purpose:"Оплата ESF-15 и ESF-16"})]);assert.equal(result.links.length,0);assert.ok(result.risks.some(r=>r.code==="AMBIGUOUS_MATCH"));
 const unmatched=matchCaseDocuments([invoice,payment("p",123,{recipientId:"990000000003",purpose:"Без реквизитов"})]);assert.ok(unmatched.risks.some(r=>r.code==="PAYMENT_WITHOUT_LINKED_DOCUMENT"));
});
