import {createHash} from 'node:crypto';
import {validIban,isPartyKey,bankPaymentClass} from './bank-identities.mjs';
import {markDirectedCycles} from './directed-cycles.mjs';
export const FLOW_VERSION='financial-flows-3.0';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const unique=a=>[...new Set(a.filter(Boolean))];
const sources=a=>[...new Map(a.map(s=>[[s.documentId,s.sheet,s.row].join(':'),s])).values()];
const plus=(a,b)=>(BigInt(a||0)+BigInt(b||0)).toString();
const day=v=>/^\d{4}-\d{2}-\d{2}$/.test(v||'')&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
const safe=v=>typeof v==='number'?Number.isSafeInteger(v)&&v>=0:typeof v==='string'&&/^\d+$/.test(v);
const endpoint=(e,side)=>validIban(e[side+'Account'])?'account:'+validIban(e[side+'Account']):isPartyKey(e[side+'Id'])?'party:'+e[side+'Id']:null;

export function canonicalBankTransfers(entries){
  const groups=new Map();
  for(const entry of entries){
    if(entry.conflict||!entry.dateValid||!day(entry.date)||!safe(entry.amountMinor)||!entry.currency||entry.currency==='UNKNOWN'||!['transfer','refund'].includes(entry.kind)||bankPaymentClass(entry)==='conversion')continue;
    // A dated owner-ledger movement can be retained without its counterparty;
    // it is not a confirmed two-ended transfer in the consolidated graph.
    if(!endpoint(entry,'sender')||!endpoint(entry,'recipient'))continue;
    const a=validIban(entry.senderAccount),b=validIban(entry.recipientAccount),explicit=String(entry.explicitTransactionId||'').trim();
    // Missing accounts or bank ID: keep observations distinct. Equal amounts,
    // payment numbers and dates alone never identify a cross-statement event.
    const identity=explicit&&a&&b?['bank-id',explicit,a,b,entry.senderId,entry.recipientId,entry.date,entry.currency,entry.kind,String(entry.amountMinor)]:['observation',entry.id];
    const id='transfer:'+hash(identity);let event=groups.get(id);
    if(!event){event={...entry,id,amountMinor:String(entry.amountMinor),operationIds:[],sources:[],observations:[],identityBasis:identity[0],classification:endpoint(entry,'sender')&&endpoint(entry,'recipient')?bankPaymentClass({type:'payment',...entry,bank:{kind:entry.kind,internalTransfer:entry.internalTransfer}}):'unidentified'};groups.set(id,event);}
    event.operationIds=unique([...event.operationIds,entry.operationId]);event.sources=sources([...event.sources,...entry.sources]);
    event.observations.push({entryId:entry.id,ownerId:entry.ownerId,ownerAccount:entry.ownerAccount,direction:entry.direction,feeMinor:entry.feeMinor,feeMode:entry.feeMode,sources:entry.sources});
  }
  return [...groups.values()].map(e=>({...e,statementPerspectives:unique(e.observations.map(x=>x.ownerAccount||x.ownerId)).length,numberOfTransfers:1}));
}

export function bankFlowAnalysis(entries,q={}){
  const transfers=canonicalBankTransfers(entries),accounts=new Map(),organisations=new Map(),periods=new Map(),volume={};
  const account=(id,owner,currency)=>{const key=JSON.stringify([id,owner,currency]);if(!accounts.has(key))accounts.set(key,{account:id||'Счёт не указан',ownerId:owner,currency,incomingMinor:'0',outgoingMinor:'0',feesMinor:null,feeRefundMinor:'0',transferCount:0,firstDate:null,lastDate:null,sources:[]});return accounts.get(key);};
  for(const e of entries){
    if(e.conflict||!e.dateValid||!safe(e.amountMinor)||e.currency==='UNKNOWN')continue;
    const a=account(e.ownerAccount,e.ownerId,e.currency);a.firstDate=!a.firstDate||e.date<a.firstDate?e.date:a.firstDate;a.lastDate=!a.lastDate||e.date>a.lastDate?e.date:a.lastDate;a.sources.push(...e.sources);
    if(['transfer','refund'].includes(e.kind)){a.transferCount++;if(e.direction==='incoming')a.incomingMinor=plus(a.incomingMinor,e.amountMinor);if(e.direction==='outgoing')a.outgoingMinor=plus(a.outgoingMinor,e.amountMinor);if(e.feeMinor!==null&&e.feeMinor!==undefined)a.feesMinor=plus(a.feesMinor,e.feeMinor);}
    if(e.kind==='fee'&&!e.countedWith)a.feesMinor=plus(a.feesMinor,e.amountMinor);
    if(e.kind==='fee_refund')a.feeRefundMinor=plus(a.feeRefundMinor,e.amountMinor);
  }
  for(const e of transfers){
    volume[e.currency]=plus(volume[e.currency],e.amountMinor);
    for(const [id,direction,other] of [[e.senderId,'outgoing',e.recipientId],[e.recipientId,'incoming',e.senderId]]){
      if(!id)continue;const k=JSON.stringify([id,e.currency]);if(!organisations.has(k))organisations.set(k,{identifier:id,currency:e.currency,incomingMinor:'0',outgoingMinor:'0',refundIncomingMinor:'0',refundOutgoingMinor:'0',count:0,firstDate:e.date,lastDate:e.date,counterparties:new Map(),sources:[]});const o=organisations.get(k);o.count++;o.firstDate=e.date<o.firstDate?e.date:o.firstDate;o.lastDate=e.date>o.lastDate?e.date:o.lastDate;o.sources.push(...e.sources);
      const field=e.kind==='refund'?(direction==='incoming'?'refundIncomingMinor':'refundOutgoingMinor'):(direction==='incoming'?'incomingMinor':'outgoingMinor');if(!e.internalTransfer)o[field]=plus(o[field],e.amountMinor);
      if(!o.counterparties.has(other))o.counterparties.set(other,{identifier:other,incomingMinor:'0',outgoingMinor:'0',count:0,sources:[]});const p=o.counterparties.get(other);p.count++;p[direction+'Minor']=plus(p[direction+'Minor'],e.amountMinor);p.sources.push(...e.sources);
    }
    const key=JSON.stringify([e.date.slice(0,7),e.currency]);if(!periods.has(key))periods.set(key,{period:e.date.slice(0,7),currency:e.currency,amountMinor:'0',count:0,sources:[]});const p=periods.get(key);p.amountMinor=plus(p.amountMinor,e.amountMinor);p.count++;p.sources.push(...e.sources);
  }
  return {version:FLOW_VERSION,transfers,perspectiveCandidates:bankPerspectiveCandidates(entries),uniqueTransfers:transfers.length,statementEntries:entries.length,mergedPerspectives:transfers.reduce((n,e)=>n+Math.max(0,e.observations.length-1),0),transferVolume:volume,accounts:[...accounts.values()].map(x=>({...x,sources:sources(x.sources)})),organisations:[...organisations.values()].map(x=>({...x,sources:sources(x.sources),counterparties:[...x.counterparties.values()].map(p=>({...p,sources:sources(p.sources)}))})),periods:[...periods.values()].sort((a,b)=>a.period.localeCompare(b.period)),largeTransfers:q.largeThreshold?transfers.filter(e=>BigInt(e.amountMinor)>=BigInt(q.largeThreshold)):[],methodology:'Объём переводов не суммируется с оборотами счетов. Подтверждённые встречные записи объединяются только по явному банковскому ID, двум проверенным IBAN, сторонам, дате, валюте, виду и сумме. Вероятные и неоднозначные соответствия без общего банковского ID показаны отдельно и не объединяются автоматически; их объём может отражать несколько наблюдений одного перевода. Поступления разных экономических классов не объявляются выручкой.'};
}

export function bankPerspectiveCandidates(entries){
 const groups=new Map();
 for(const e of entries){
  if(e.conflict||!e.dateValid||!day(e.date)||!safe(e.amountMinor)||e.currency==='UNKNOWN'||e.explicitTransactionId||!['transfer','refund'].includes(e.kind)||bankPaymentClass(e)==='conversion')continue;
  const a=validIban(e.senderAccount),b=validIban(e.recipientAccount),ref=String(e.transactionId||'').trim(),purpose=String(e.purpose||'').normalize('NFKC').toLocaleLowerCase('ru').replace(/\s+/g,' ').trim();
  if(!a||!b||a===b||!ref||!purpose||!isPartyKey(e.senderId)||!isPartyKey(e.recipientId))continue;
  const side=e.ownerAccount===a&&e.direction==='outgoing'?'out':e.ownerAccount===b&&e.direction==='incoming'?'in':'';if(!side)continue;
  const key=JSON.stringify([a,b,e.senderId,e.recipientId,e.date,e.currency,e.kind,String(e.amountMinor),ref,purpose]);
  if(!groups.has(key))groups.set(key,{out:[],in:[]});groups.get(key)[side].push(e);
 }
 return [...groups].filter(([,g])=>g.out.length&&g.in.length).map(([key,g])=>({id:'perspective:'+hash(key),status:g.out.length===1&&g.in.length===1?'probable':'ambiguous',outgoing:g.out.length,incoming:g.in.length,entries:[...g.out,...g.in].map(e=>e.id),sources:sources([...g.out,...g.in].flatMap(e=>e.sources)),reason:'Совпали оба счёта, стороны, дата, сумма, валюта, номер документа и назначение; наблюдаются противоположные стороны выписок. Общий банковский ID отсутствует.',explanation:'Это предложение для проверки, не установленная идентичность переводов. Записи и их суммы не объединены автоматически.'}));
}

export function bankFlowSignals(flow,q={}){
  const list=flow.transfers.filter(e=>endpoint(e,'sender')&&endpoint(e,'recipient')),signals=[],maxSignals=500,maxComparisons=20000,window=Number(q.onwardDays??3),bps=Number(q.toleranceBps??1000),threshold=Number(q.concentrationBps??5000);let comparisons=0,truncated=false;
  const add=(type,title,entries,condition,calculation,limitations)=>{if(signals.length>=maxSignals){truncated=true;return;}const ids=entries.map(e=>e.id).sort();signals.push({id:'signal:'+hash([type,ids,condition,calculation]),type,title,entries,operationIds:unique(entries.flatMap(e=>e.operationIds)),sources:sources(entries.flatMap(e=>e.sources)),condition,calculation,reason:condition,explanation:condition+' '+limitations,limitations,certainty:'hypothesis',ruleVersion:FLOW_VERSION});};
  const repeat=new Map(),bySender=new Map();
  for(const e of list){if(e.kind!=='transfer')continue;const k=JSON.stringify([endpoint(e,'sender'),endpoint(e,'recipient'),e.currency,e.amountMinor]);if(!repeat.has(k))repeat.set(k,[]);repeat.get(k).push(e);const a=JSON.stringify([endpoint(e,'sender'),e.currency]);if(!bySender.has(a))bySender.set(a,[]);bySender.get(a).push(e);}
  for(const g of repeat.values())if(g.length>=3)add('repeated',`Повторяющиеся переводы: ${g.length}`,g,'Не менее трёх уникальных переводов между одними сторонами на одинаковую сумму и в одной валюте.',{count:g.length,amountMinor:g[0].amountMinor,currency:g[0].currency},'Одинаковая сумма не доказывает дублирование или дробление; возможны регулярные обязательства.');
  for(const g of bySender.values()){
    const total=g.reduce((s,e)=>s+BigInt(e.amountMinor),0n);if(g.length<3||total<=0n)continue;const recipients=new Map();for(const e of g){const id=endpoint(e,'recipient');if(!recipients.has(id))recipients.set(id,[]);recipients.get(id).push(e);}
    for(const [id,items] of recipients){const amount=items.reduce((s,e)=>s+BigInt(e.amountMinor),0n);if(amount*10000n>=total*BigInt(threshold))add('concentration',`Концентрация переводов у ${id}`,items,`Доля получателя не менее ${threshold} базисных пунктов в исходящих переводах стороны и валюты.`,{recipientMinor:String(amount),totalOutgoingMinor:String(total),shareBps:String(amount*10000n/total),thresholdBps:threshold,currency:g[0].currency},'Показатель относится только к представленным операциям; концентрация может иметь обычное хозяйственное основание.');}
    // Equal 30-day windows; never treat unobserved periods as confirmed inactivity.
    const ordered=g.slice().sort((a,b)=>a.date.localeCompare(b.date));if((Date.parse(ordered.at(-1).date)-Date.parse(ordered[0].date))/86400000<90)continue;const end=Date.parse(ordered.at(-1).date)+86400000,groups=[[],[],[],[]];for(const e of g){const n=Math.floor((end-1-Date.parse(e.date))/(30*86400000));if(n<4)groups[n].push(e);}const history=groups.slice(1),active=history.filter(a=>a.length).length;if(active<2||!groups[0].length)continue;const prior=history.flat(),recent=groups[0],pSum=prior.reduce((n,e)=>n+BigInt(e.amountMinor),0n),rSum=recent.reduce((n,e)=>n+BigInt(e.amountMinor),0n);if(recent.length*3>=prior.length*2&&rSum*3n>=pSum*2n)add('activity_change','Рост частоты и суммы в представленном массиве',[...recent,...prior],'Частота и сумма последнего 30-дневного окна не менее чем вдвое превышают среднее трёх предшествующих 30-дневных окон.',{recentCount:recent.length,priorCount:prior.length,recentMinor:String(rSum),priorMinor:String(pSum),priorWindows:3,windowDays:30,endExclusive:new Date(end).toISOString().slice(0,10),currency:g[0].currency},'Отсутствие выписок не означает отсутствие активности. Это изменение состава представленных записей, не подтверждённая аномалия бизнеса.');
  }
  outer:for(const a of list){for(const b of bySender.get(JSON.stringify([endpoint(a,'recipient'),a.currency]))||[]){if(++comparisons>maxComparisons){truncated=true;break outer;}if(a.id===b.id||b.date<a.date)continue;const days=(Date.parse(b.date)-Date.parse(a.date))/86400000;if(days>window)continue;const x=BigInt(a.amountMinor),y=BigInt(b.amountMinor),delta=x>y?x-y:y-x;if(x<=0n||y<=0n||delta*10000n>x*BigInt(bps))continue;
    // When two different accounts of the intermediary are known, its internal
    // transfer is a missing link. Party equality alone cannot bridge the accounts.
    if(a.recipientAccount&&b.senderAccount&&a.recipientAccount!==b.senderAccount)continue;
    const returning=endpoint(a,'sender')===endpoint(b,'recipient');add(returning?'return_cycle':'onward_candidate',returning?'Встречный перевод':'Возможное последующее перечисление',[a,b],`Последовательность дат: до ${window} дней; отличие сумм до ${bps} базисных пунктов; одна валюта и совпадающий проверяемый счёт/участник посредника.`,{days,firstMinor:a.amountMinor,nextMinor:b.amountMinor,differenceMinor:String(delta),toleranceBps:bps,currency:a.currency,intermediaryAccount:a.recipientAccount||b.senderAccount||null},'При отсутствии времени внутри дня порядок не установлен. Это гипотеза, не идентичность денег; смешение потоков и другие операции не исключены.');
    if(signals.length>=maxSignals){truncated=true;break outer;}
  }}
  // Topological cycles are evaluated independently for each currency.
  for(const currency of unique(list.map(e=>e.currency))){const edges=markDirectedCycles(list.filter(e=>e.currency===currency).map(e=>({from:endpoint(e,'sender'),to:endpoint(e,'recipient'),event:e}))),cyclic=edges.filter(e=>e.cycle);if(cyclic.length)add('directed_cycle',`Направленные циклические маршруты (${currency})`,cyclic.map(e=>e.event),'Рёбра принадлежат направленным сильно связным компонентам одной валюты.',{edgeCount:cyclic.length,currency},'Топология не доказывает временную последовательность цикла или возврат именно тех же средств; проверьте даты и основания каждой операции.');}
  return {signals,truncated,comparisons,limits:{maxSignals,maxComparisons},criteria:{onwardDays:window,toleranceBps:bps,concentrationBps:threshold}};
}
