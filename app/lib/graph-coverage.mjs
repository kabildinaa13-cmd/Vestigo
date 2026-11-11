import {paymentCapacityKey} from './bank-identities.mjs';
// Presentation of existing reconciliation results. Does not create allocations or write data.
export function resolveGraphMode(report, requested) {
  if (requested && requested !== 'auto') return requested;
  const bank = !!report.bank?.length;
  const documents = !!report.invoices?.length || !!report.documentRelations?.length;
  return bank && documents ? 'combined' : bank ? 'money' : 'relations';
}
export function graphCoverage(report) {
  const rec=report.reconciliation||{}, invoices=report.invoices||[], bank=report.bank||[];
  const candidates=rec.candidates||[], items=rec.items||[], payments=rec.payments||[];
  const ids=new Set(invoices.map(i=>i.id)), byInvoice=new Map();
  for(const c of candidates){if(!byInvoice.has(c.invoiceId))byInvoice.set(c.invoiceId,[]);byInvoice.get(c.invoiceId).push(c);}
  const paymentById=new Map([...payments,...(rec.linkedPayments||[])].map(p=>[p.id,p])), invoiceByPayment=new Map();
  for(const c of candidates){const k=paymentCapacityKey(paymentById.get(c.paymentId));if(!invoiceByPayment.has(k))invoiceByPayment.set(k,new Set());invoiceByPayment.get(k).add(c.invoiceId);}
  const summaries=items.filter(x=>ids.has(x.invoice.id)).map(x=>{
    const proposed=byInvoice.get(x.invoice.id)||[];
    const seen=new Set();let candidatePayment=0n,ambiguous=false;
    for(const c of proposed){const p=paymentById.get(c.paymentId),k=paymentCapacityKey(p);if(!p||c.amountMinor===null){ambiguous=true;continue;}if(seen.has(k))continue;seen.add(k);
      if(c.method==='explicit_invoice_bundle')candidatePayment+=BigInt(c.amountMinor);
      else if(invoiceByPayment.get(k)?.size===1)candidatePayment+=BigInt(p.unallocatedMinor??p.amountMinor);
      else ambiguous=true;
    }
    const comparisonDifference=proposed.length&&!ambiguous?String(BigInt(x.invoice.amountMinor)-BigInt(x.confirmedMinor)-candidatePayment):null;
    const status=x.status==='paid'?'confirmed':x.status==='partial'?'confirmed_partial'
      :['overpaid','refund_review'].includes(x.status)?x.status
      :proposed.some(c=>c.amountMinor===null||c.status==='requires_review')?'ambiguous'
      :proposed.length?'proposed':bank.length?'no_payment':'no_statements';
    return {invoiceId:x.invoice.id,number:x.invoice.number,date:x.invoice.date,currency:x.invoice.currency,
      amountMinor:String(x.invoice.amountMinor),confirmedMinor:x.confirmedMinor,unpaidMinor:x.unpaidMinor,
      status,candidates:proposed.length,candidatePaymentMinor:proposed.length&&!ambiguous?String(candidatePayment):null,
      preliminaryDifferenceMinor:comparisonDifference,
      comparisonSources:proposed.flatMap(c=>paymentById.get(c.paymentId)?.sources||[]),sources:x.invoice.sources||[],
      explanation:status==='no_statements'?'Банковские строки не загружены: оплату проверить нельзя.'
        :status==='no_payment'?'В исследованном массиве не найден допустимый платёж. Возможны аванс, отсрочка или неполный комплект выписок.'
        :status==='ambiguous'?'Есть неоднозначное соответствие. Сумма автоматически не распределяется.'
        :status==='proposed'?'Найдено предварительное соответствие по реквизитам. Это ещё не подтверждённая оплата.'
        :status==='confirmed_partial'?'Сотрудником подтверждена только часть суммы ЭСФ.'
        :status==='confirmed'?'Допустимые распределения сотрудника покрывают сумму ЭСФ.'
        :status==='refund_review'?'Найден возврат: требуется проверить экономическое основание.'
        :'Подтверждённые распределения превышают сумму ЭСФ: требуется проверка.'};
  });
  const linked=new Set([...(rec.allocations||[]),...candidates].map(x=>x.paymentId));
  return {invoices:invoices.length,bankRows:bank.length,mode:resolveGraphMode(report),
    confirmed:summaries.filter(x=>x.status==='confirmed').length,
    partial:summaries.filter(x=>x.status==='confirmed_partial').length,
    proposed:summaries.filter(x=>['proposed','ambiguous'].includes(x.status)).length,
    unmatched:summaries.filter(x=>x.status==='no_payment').length,
    unlinkedPayments:payments.filter(p=>!linked.has(p.id)&&p.classification==='commercial_candidate').map(p=>({id:p.id,number:p.number,date:p.date,amountMinor:String(p.amountMinor),currency:p.currency,sources:p.sources||[]})),
    items:summaries,truncated:!!rec.proposalCoverage?.truncated,
    explanation:'ЭСФ отражает поставку, выписка — движение денег. Равенство общих оборотов не доказывает оплату. Комиссии, займы, налоги, возвраты и внутренние переводы не требуют ЭСФ как оплаты реализации. Предложения не включены в подтверждённые суммы.'};
}
