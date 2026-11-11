import {isBankFee,bankEntryKind,bankPaymentClass,invoicePaymentEligibility} from "./bank-identities.mjs";
const norm=v=>String(v??"").toLocaleLowerCase("ru").replace(/ё/g,"е").replace(/[^\p{L}\p{N}]/gu,"");
const partyPair=o=>[o.senderId,o.recipientId].sort().join(":")+":"+o.currency;
const sourceKey=s=>`${s.documentId}:${s.sheet}:${s.row}`;
function contains(text,number){if(!number||norm(number).length<2)return false;return new RegExp(`(^|[^\\p{L}\\p{N}])${String(number).replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}($|[^\\p{L}\\p{N}])`,"iu").test(text);}
export function matchCaseDocuments(operations,records=[],decisions=[],authorization=()=>null){
 const active=operations.filter(o=>!o.conflict&&o.review!=="rejected"&&o.reviewStatus!=="rejected"&&o.currency!=="UNKNOWN"&&!isBankFee(o)),invoices=active.filter(o=>o.type==="invoice"),payments=active.filter(o=>o.type==="payment"),contracts=active.filter(o=>o.type==="contract"),links=[],risks=[],contractByOp=new Map();
 const amount=o=>o.amount??o.amountMinor,rawBySource=new Map(records.map(r=>[sourceKey(r.source),r.row]));
 const addRisk=(key,code,severity,description,evidence,rule,calculation={})=>risks.push({key,code,severity,kind:code.includes("DIFFERENCE")?"discrepancy":"data_quality",description,evidence,rule,calculation,version:"document-matching-2.0"});
 const link=(left,right,method,explanation)=>{if(!links.some(l=>l.leftId===left.id&&l.rightId===right.id))links.push({leftId:left.id,rightId:right.id,method,explanation});};
 for(const op of active){if(op.type==="contract")continue;
   const rows=(op.sources||[]).map(s=>rawBySource.get(sourceKey(s))).filter(Boolean),refs=rows.flatMap(r=>[r.contractRef,...(op.type!=="payment"?[r.reference]:[])]).filter(Boolean);
   const labelledRefs=[...String(op.purpose||"").matchAll(/(?:договор[а-я]*|контракт[а-я]*|contract)\s*(?:(?:поставки|подряда|аренды)\s*)?(?:№|No\.?\b|N\b)?\s*([\p{L}\d][\p{L}\d/._-]{0,60})/giu)].map(m=>m[1]);
   const candidates=contracts.filter(c=>partyPair(c)===partyPair(op)&&[...refs,...labelledRefs].some(r=>norm(r)===norm(c.number)));
   if(candidates.length===1){contractByOp.set(op.id,candidates[0]);link(candidates[0],op,"contract_reference","Номер договора указан в поле основания или назначении; стороны и валюта совпадают. Связь предварительная, не доказательство исполнения.");}
   else if(candidates.length>1)addRisk(`${op.id}:contract-ambiguous`,"CONTRACT_VERSION_AMBIGUITY","info","Ссылка соответствует нескольким договорам/редакциям.",op.sources,"Действующая редакция и распределение суммы не выбираются автоматически.");
 }
 const matched=new Map(),refundsByInvoice=new Map();
 const invoicesByPair=new Map();for(const i of invoices){const key=`${i.senderId}:${i.recipientId}:${i.currency}`;if(!invoicesByPair.has(key))invoicesByPair.set(key,[]);invoicesByPair.get(key).push(i);}
 for(const p of payments.filter(p=>bankPaymentClass(p)==="commercial_candidate")){
   const reverse=invoicesByPair.get(`${p.recipientId}:${p.senderId}:${p.currency}`)||[],manualThird=decisions.filter(d=>d.rightId===p.id&&d.status==='confirmed').map(d=>invoices.find(i=>i.id===d.leftId)).filter(i=>i&&!reverse.includes(i));
   const candidates=[...reverse,...manualThird].filter(i=>invoicePaymentEligibility(i,p,authorization(i,p)).eligible),text=`${p.reference||""} ${p.purpose||""}`;
   const explicit=candidates.filter(i=>contains(text,i.number));
   const contract=contractByOp.get(p.id);
   const contradictions=explicit.filter(i=>contract&&contractByOp.has(i.id)&&contractByOp.get(i.id).id!==contract.id);
   if(contradictions.length){addRisk(`${p.id}:reference-conflict`,"DOCUMENT_REFERENCE_CONFLICT","medium","Назначение платежа указывает на договор и ЭСФ разных договоров.",[...p.sources,...contradictions.flatMap(i=>i.sources),...contract.sources],"Сумма не отменяет противоречие документальных ссылок. Связь оплаты с ЭСФ не назначена; требуется сверка основания.");continue;}
   const shared=contractByOp.has(p.id)?candidates.filter(i=>contractByOp.get(i.id)?.id===contractByOp.get(p.id).id):[];
   const manual=candidates.filter(i=>decisions.some(d=>d.leftId===i.id&&d.rightId===p.id&&d.status==="confirmed"));
   const possible=(manual.length?manual:explicit.length?explicit:contract?shared:candidates.filter(i=>amount(i)===amount(p)&&Math.abs(Date.parse(i.date)-Date.parse(p.date))<=90*86400000)).filter(i=>!decisions.some(d=>d.leftId===i.id&&d.rightId===p.id&&d.status==="rejected"));
   if(possible.length===1){const i=possible[0],method=manual.length?"manual_confirmed":explicit.length?"document_reference":shared.length?"shared_contract_reference":"amount_parties_date";
     link(i,p,method,manual.length?"Соответствие ЭСФ и платежа выбрано сотрудником с обоснованием; исходные реквизиты не изменялись.":explicit.length?"Номер ЭСФ указан в основании/назначении платежа; стороны обратные, валюта совпадает. Связь требует проверки.":shared.length?"Платёж и единственная ЭСФ ссылаются на один договор; стороны и валюта совпадают. Это кандидат связи, не подтверждение исполнения.":"Совпали обратные стороны, валюта и сумма; даты в пределах 90 дней. Это кандидат, не доказательство оплаты этой ЭСФ.");
     if(!matched.has(i.id))matched.set(i.id,[]);matched.get(i.id).push({payment:p,method});
   }else if(possible.length>1)addRisk(`${p.id}:ambiguous`,"AMBIGUOUS_MATCH","medium",`Для платежа «${p.number||p.date}» найдено несколько возможных ЭСФ.`,[...p.sources,...possible.flatMap(i=>i.sources)],"Возможен объединённый платёж. Сумма не распределена между ЭСФ автоматически и не учтена несколько раз.");
   else if(invoices.length||contracts.length)addRisk(`${p.id}:without-support`,"PAYMENT_WITHOUT_LINKED_DOCUMENT","info",`Для платежа «${p.number||p.date}» не найден однозначный подтверждающий документ.`,p.sources,"Проверяется только загруженный комплект. Не доказывает отсутствие реального договора, поставки или расчёта.");
 }
 for(const r of payments.filter(p=>bankEntryKind(p)==="refund")){
  const possible=invoices.filter(i=>i.senderId===r.senderId&&i.recipientId===r.recipientId&&i.currency===r.currency&&(contains(`${r.reference||""} ${r.purpose||""}`,i.number)||contractByOp.has(r.id)&&contractByOp.get(i.id)?.id===contractByOp.get(r.id).id));
  if(possible.length===1){const i=possible[0];link(i,r,"refund_reference","Возврат с прямой ссылкой на ЭСФ или общий договор; стороны и валюта совпадают. Уменьшает сумму связанных оплат, не считается новой оплатой.");if(!refundsByInvoice.has(i.id))refundsByInvoice.set(i.id,[]);refundsByInvoice.get(i.id).push(r);}
  else addRisk(`${r.id}:refund-unallocated`,"REFUND_NOT_ALLOCATED","info","Возврат не распределён между подтверждающими документами.",r.sources,"Для уменьшения конкретной оплаты требуется однозначное основание возврата. По одной сумме соответствие не назначается.");
 }
 if(payments.length)for(const i of invoices){const list=matched.get(i.id)||[],refunds=refundsByInvoice.get(i.id)||[];
   if(!list.length)addRisk(`${i.id}:unmatched`,"NO_PAYMENT_MATCH","info",`Для ЭСФ «${i.number}» не найден однозначный платёж среди загруженных материалов.`,i.sources,"Возможны неполная выписка, отсрочка, зачёт, наличные или иной период. Не доказывает отсутствие оплаты.");
   else if(list.every(m=>m.method!=="amount_parties_date")){
     const gross=list.reduce((n,m)=>n+BigInt(amount(m.payment)),0n),refundTotal=refunds.reduce((n,r)=>n+BigInt(amount(r)),0n),total=gross-refundTotal,difference=total-BigInt(amount(i));
     if(difference!==0n)addRisk(`${i.id}:payment_total`,"PAYMENT_AMOUNT_DIFFERENCE","medium",`Сумма связанных платежей отличается от ЭСФ «${i.number}».`,[...i.sources,...list.flatMap(m=>m.payment.sources),...refunds.flatMap(r=>r.sources)],"Сравнение по документальной ссылке; частичные оплаты и неполнота материалов могут объяснить разницу. Это расхождение, не установленный ущерб.",{invoiceMinor:String(amount(i)),grossPaymentMinor:String(gross),refundMinor:String(refundTotal),paymentMinor:String(total),differenceMinor:String(difference),currency:i.currency,formula:"Σ связанных платежей − Σ связанных возвратов − сумма ЭСФ",operationIds:[i.id,...list.map(m=>m.payment.id),...refunds.map(r=>r.id)]});
   }
 }
 return {links,risks};
}
