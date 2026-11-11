// Same amount is not an invoice identity. Original rows and all copies stay intact.
import {createHash} from 'node:crypto';
const norm=s=>String(s||'').normalize('NFKC').toLocaleLowerCase('ru').replace(/\s+/g,'');
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function invoiceIdentity(row){return row.number?JSON.stringify([row.senderId,norm(row.number),...(row.registrationNumber||/^ESF-/i.test(row.number)?[]:[row.recipientId,row.date,row.currency])]):null;}
export function inspectInvoiceRepeats(records){
 const groups=new Map(),risks=[],copies=[];
 for(const {row,source} of records){if(row.type!=='invoice'||!row.number)continue;const key=invoiceIdentity(row);if(!groups.has(key))groups.set(key,[]);groups.get(key).push({row,source});}
 for(const [id,items] of groups){const docs=new Map();for(const x of items){if(!docs.has(x.source.documentId))docs.set(x.source.documentId,[]);docs.get(x.source.documentId).push(x);}
  if(docs.size>1)copies.push({number:items[0].row.number,senderId:items[0].row.senderId,recipientId:items[0].row.recipientId,date:items[0].row.date,amountMinor:items[0].row.amountMinor,currency:items[0].row.currency,sources:items.map(x=>x.source),basis:'Один регистрационный номер ЭСФ в нескольких файлах. Совпадающие реквизиты учитываются один раз; противоречия блокируют итог.'});
  for(const [documentId,lines] of docs){
   // Repeated line numbers with identical values are duplicate source rows, not different invoices.
   const signatures=new Map();for(const x of lines){if(!x.row.lineNumber)continue;const k=digest([x.row.lineNumber,x.row.senderId,x.row.recipientId,x.row.currency,x.row.date,x.row.status,x.row.amountMinor,x.row.esf,x.row.attributes?.unit,x.row.attributes?.unitPriceMinor,x.row.attributes?.vatRate,x.row.attributes?.vatMinor]);if(!signatures.has(k))signatures.set(k,[]);signatures.get(k).push(x);}
   const repeats=[...signatures.values()].filter(g=>g.length>1);if(!repeats.length)continue;
   risks.push({key:'invoice-rows:'+digest([id,documentId]),code:'REPEATED_INVOICE_ROWS',kind:'data_quality',severity:'info',description:`ЭСФ ${lines[0].row.number}: повторены товарные строки с одинаковыми номерами и реквизитами.`,evidence:repeats.flatMap(g=>g.map(x=>x.source)),rule:'Совпали регистрационный номер, номер позиции, стороны, дата, валюта, сумма и данные товара. Это повторение строк выгрузки, не доказательство повторной сделки.',calculation:{invoiceNumber:lines[0].row.number,date:lines[0].row.date,senderId:lines[0].row.senderId,recipientId:lines[0].row.recipientId,amountMinor:String(lines[0].row.amountMinor),currency:lines[0].row.currency,repeatedLineNumbers:repeats.map(g=>g[0].row.lineNumber)},version:'invoice-identity-2.0'});
  }
 }
 return {copies,risks};
}
