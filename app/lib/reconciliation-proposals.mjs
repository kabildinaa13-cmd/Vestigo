import {invoicePaymentEligibility,bankPaymentClass,paymentCapacityKey} from './bank-identities.mjs';
import {containsDocumentReference} from './payment-party-evidence.mjs';
const sourceKey=s=>[s.documentId,s.sheet,s.row].join(':');
const unique=a=>[...new Set(a.filter(Boolean))];
const positive=o=>o&&!o.conflict&&!['rejected'].includes(o.reviewStatus||o.review)&&o.currency&&o.currency!=='UNKNOWN'&&/^\d+$/.test(String(o.amountMinor??o.amount))&&BigInt(o.amountMinor??o.amount)>0n;
// Pure bounded candidate generation; decisions and amounts are never written here.
export function reconciliationProposals(d,allocations,decisions,authorization=()=>null,thirdPartyPairs=[]){
  const invoices=d.ops.filter(o=>o.type==='invoice'&&positive(o)),payments=d.ops.filter(o=>o.type==='payment'&&positive(o)&&bankPaymentClass(o)==='commercial_candidate'),raw=new Map(d.records.map(r=>[sourceKey(r.source),r.row])),byPair=new Map(),byNumber=new Map(),candidates=[],limit=20000;let comparisons=0,truncated=false;
  const refs=o=>unique([...(o.sources||[]).flatMap(s=>{const r=raw.get(sourceKey(s));return [r?.contractRef,r?.esf?.contractRef];}),...[...String(o.purpose||'').matchAll(/(?:договор[а-я]*|contract)\s*(?:№|No\.?|N)?\s*([\p{L}\d][\p{L}\d/._-]{1,60})/giu)].map(m=>m[1])]);
  const refMap=new Map(d.ops.map(o=>[o.id,refs(o)]));
  // Keep ineligible invoices in the reference index: an explicit reference to
  // a conflicted or foreign-currency invoice must not fall back to another
  // invoice merely because its amount happens to agree.
  for(const i of d.ops.filter(o=>o.type==='invoice')){const k=JSON.stringify([i.senderId,i.recipientId]);if(!byPair.has(k))byPair.set(k,[]);byPair.get(k).push(i);const number=String(i.number||'').normalize('NFKC').toLocaleLowerCase('ru');if(number.length>=2){if(!byNumber.has(number))byNumber.set(number,[]);byNumber.get(number).push(i);}}
  const paymentById=new Map(payments.map(p=>[p.id,p])),usedP=new Map(),usedI=new Map();for(const a of allocations){const k=paymentCapacityKey(paymentById.get(a.paymentId));usedP.set(k,(usedP.get(k)||0n)+BigInt(a.amountMinor));usedI.set(a.invoiceId,(usedI.get(a.invoiceId)||0n)+BigInt(a.amountMinor));}
  for(const p of payments){
    const text=`${p.reference||''} ${p.purpose||''}`,direct=byPair.get(JSON.stringify([p.recipientId,p.senderId]))||[],third=thirdPartyPairs.filter(x=>x.paymentId===p.id).map(x=>invoices.find(i=>i.id===x.invoiceId)).filter(i=>i&&authorization(i,p));
    // Fast exact index for usual invoice numbers. Complex spaced references use
    // the bounded pair scan below; limits are reported, never hidden.
    const referenceText=text.replace(/(?:договор[а-я]*|контракт[а-я]*|contract|акт[а-я]*)\s*(?:№|No\.?|N)?\s*[\p{L}\d][\p{L}\d/._-]*/giu,' '),tokens=referenceText.normalize('NFKC').toLocaleLowerCase('ru').match(/[\p{L}\d][\p{L}\d/._-]{0,120}/gu)||[],indexed=new Set();for(const token of tokens)for(const variant of new Set([token,token.replace(/[./_-]+$/,'')]))for(const i of byNumber.get(variant)||[])if(containsDocumentReference(referenceText,i.number))indexed.add(i);
    const pool=indexed.size?[...indexed]:[...direct,...third],available=BigInt(p.amountMinor)-(usedP.get(paymentCapacityKey(p))||0n);if(available<=0n)continue;const proposals=[],referencedIds=new Set();
    for(const i of pool){
      if(++comparisons>limit){truncated=true;break;}
      const number=containsDocumentReference(referenceText,i.number);if(number)referencedIds.add(i.id);
      const auth=authorization(i,p);if(!positive(i)||!invoicePaymentEligibility(i,p,auth).eligible)continue;
      if(allocations.some(a=>a.invoiceId===i.id&&a.paymentId===p.id)||decisions.some(a=>!a.stale&&a.invoiceId===i.id&&a.paymentId===p.id&&a.status==='rejected'))continue;
      const contracts=(refMap.get(i.id)||[]).filter(r=>(refMap.get(p.id)||[]).includes(r)),days=(Date.parse(p.date)-Date.parse(i.date))/86400000,exact=String(i.amountMinor)===String(p.amountMinor);
      const prior=(d.analysis.matches||[]).find(m=>m.leftId===i.id&&m.rightId===p.id&&['shared_contract_reference','manual_confirmed'].includes(m.method));
      if(!number&&!contracts.length&&!auth&&!prior&&!(exact&&Number.isFinite(days)&&Math.abs(days)<=90))continue;
      const contrary=number&&refMap.get(i.id)?.length&&refMap.get(p.id)?.length&&!contracts.length;
      if(contrary)continue;
      const method=auth?'third_party_document':number?'document_reference':contracts.length?'shared_contract_reference':prior?.method||'amount_parties_date',remaining=BigInt(i.amountMinor)-(usedI.get(i.id)||0n);
      proposals.push({invoiceId:i.id,paymentId:p.id,amountMinor:String(remaining>0n?(remaining<available?remaining:available):available),confirmed:false,method,classification:'commercial_candidate',status:method==='amount_parties_date'?'requires_review':'proposed',confidence:method==='amount_parties_date'?'Косвенное совпадение; требуется проверка':'Документальное основание; требуется решение сотрудника',explanation:auth?'Основание платежа третьим лицом подтверждено сотрудником по документу; сама оплата ещё не подтверждена.':number?'Номер ЭСФ указан в платеже; обратные стороны и валюта совпадают.':contracts.length?'В исходных строках указан общий договор; совпадают стороны и валюта.':prior?.explanation||'Точная сумма, обратные стороны, одна валюта и интервал не более 90 дней.',criteria:{invoiceReference:number,contractReferences:contracts,reverseParties:i.recipientId===p.senderId,thirdPartyEvidence:auth||null,currency:i.currency,invoiceMinor:String(i.amountMinor),paymentMinor:String(p.amountMinor),dateOffsetDays:Number.isFinite(days)?days:null,timing:days<0?'advance':days>0?'later':'same_day',accounts:{sender:p.bank?.senderAccount||null,recipient:p.bank?.recipientAccount||null},limits:'Дата и сумма не доказывают исполнение. Предложенная часть не является распределённой оплатой.'},sources:[...i.sources,...p.sources,...(auth?.sources||[])]});
    }
    // A direct invoice reference takes precedence over an equal amount for a
    // different invoice. Never dilute explicit evidence with a weaker guess.
    if(truncated)break;
    if(referencedIds.size){for(let n=proposals.length-1;n>=0;n--)if(!referencedIds.has(proposals[n].invoiceId))proposals.splice(n,1);}
    else if(proposals.some(c=>c.criteria.contractReferences.length)){for(let n=proposals.length-1;n>=0;n--)if(!proposals[n].criteria.contractReferences.length)proposals.splice(n,1);}
    // A single payment naming several invoices is a bundle only if the whole
    // exact sum agrees. Otherwise no arbitrary priority or amount is assigned.
    const explicit=proposals.filter(x=>x.criteria.invoiceReference),sum=explicit.reduce((n,c)=>n+BigInt(c.criteria.invoiceMinor),0n),bundle=explicit.length>1&&sum===BigInt(p.amountMinor)&&available===BigInt(p.amountMinor)&&explicit.every(c=>!usedI.has(c.invoiceId));
    for(const c of proposals){if(bundle&&c.criteria.invoiceReference){c.method='explicit_invoice_bundle';c.amountMinor=c.criteria.invoiceMinor;c.criteria.bundleInvoiceIds=explicit.map(x=>x.invoiceId);c.explanation='Платёж содержит номера нескольких ЭСФ; сумма всей явно указанной группы равна платежу. Части требуют отдельных решений.';}else if(proposals.length>1){c.status='requires_review';c.amountMinor=null;c.explanation+=' Несколько возможных ЭСФ; сумма автоматически между ними не распределена.';}candidates.push(c);}
    if(truncated)break;
  }
  return {candidates,truncated,comparisons,limit};
}
