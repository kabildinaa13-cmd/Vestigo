import {caseAnalysis} from "./case-analysis.mjs";
import {canonicalBankSourceRows,bankEntryKind,isPartyKey,partyLabel,bankPurposeCategory} from "./bank-identities.mjs";

const clean=v=>String(v??"").toLocaleLowerCase("ru").replace(/ё/g,"е");
const sourceKey=s=>`${s.documentId}:${s.sheet}:${s.row}`;
const safe=v=>Number.isSafeInteger(v)&&v>=0;
const missingLabels={owner:'владелец счёта',sender:'отправитель',recipient:'получатель',date:'дата',amount:'сумма',direction:'направление',currency:'валюта'};
const zero=()=>({incomingMinor:0n,outgoingMinor:0n,feesMinor:0n,feeRefundsMinor:0n,refundIncomingMinor:0n,refundOutgoingMinor:0n,rawIncomingMinor:0n,rawOutgoingMinor:0n,conversionIncomingMinor:0n,conversionOutgoingMinor:0n,unidentifiedIncomingMinor:0n,unidentifiedOutgoingMinor:0n,knownFees:false,count:0,incomplete:0,conflicts:0});
const serial=o=>Object.fromEntries(Object.entries(o).map(([k,v])=>[k,typeof v==="bigint"?v.toString():v]));

// Pure case-local ledger. Identical amounts are not sufficient grounds to merge payments.
export function buildBankLedger(records,operations=[],matches=[],knownOwnedAccounts=[]){
  const operationBySource=new Map();
  const matchesByOperation=new Map();for(const m of matches)for(const id of [m.leftId,m.rightId]){if(!matchesByOperation.has(id))matchesByOperation.set(id,[]);matchesByOperation.get(id).push(m);}
  for(const o of operations)for(const s of o.sources||[])operationBySource.set(sourceKey(s),o);
  const grouped=new Map();
  for(const {row,source} of records){
    if(row.type!=="payment"||!row.bank||/^(REVOKED|CANCELLED|CANCELED|DELETED|ОТОЗВАН|АННУЛИРОВАН|ОТМЕНЕН)/.test(row.status||""))continue;
    const op=operationBySource.get(sourceKey(source));if(op?.reviewStatus==="rejected")continue;
    const b=row.bank,kind=bankEntryKind(row),reference=String(b.transactionId||row.number||"").trim();
    const key=b.transactionId?JSON.stringify([b.ownerAccount||b.ownerId,row.senderId,row.recipientId,b.senderAccount,b.recipientAccount,b.transactionId,row.date||b.rawDate||sourceKey(source),row.currency,kind,b.direction]):sourceKey(source);
    const entry={id:sourceKey(source),operationId:op?.id||"",ownerId:b.ownerId||"",ownerAccount:b.ownerAccount||"",senderId:row.senderId,recipientId:row.recipientId,senderName:row.senderName,recipientName:row.recipientName,senderAccount:b.senderAccount||"",recipientAccount:b.recipientAccount||"",date:row.date,currency:row.currency||"UNKNOWN",kind,direction:b.direction||"",amountMinor:row.amountMinor,rawAmountMinor:b.rawAmountMinor,feeMinor:b.feeMinor,feeMode:b.feeMode,transactionId:reference,feeReference:b.feeReference||"",purpose:row.purpose||"",issues:[...(b.issues||[])],sources:[source],conflict:!!op?.conflict||!!row.attributes?.conflictingFields?.length,matches:[]};
    entry.category=bankPurposeCategory(row);
    entry.rawDate=b.rawDate||'';entry.unresolvedCounterpartyName=b.unresolvedCounterpartyName||'';entry.counterpartyAccountToken=b.counterpartyAccountToken||'';
    // Preserve the source's text even when it does not establish an identity.
    // A displayed name never becomes a party key or a confirmed graph endpoint.
    if(!isPartyKey(entry.recipientId)&&entry.direction==='outgoing'&&!entry.recipientName)entry.recipientName=entry.unresolvedCounterpartyName;
    if(!isPartyKey(entry.senderId)&&entry.direction==='incoming'&&!entry.senderName)entry.senderName=entry.unresolvedCounterpartyName;
    entry.missingFields=[...new Set([...(b.missingFields||[]),...(!b.ownerId?['owner']:[]),...(!b.direction?['direction']:[]),...(!row.date?['date']:[]),...(!safe(row.amountMinor)?['amount']:[]),...(!isPartyKey(row.senderId)?['sender']:[]),...(!isPartyKey(row.recipientId)?['recipient']:[]),...(row.currency==='UNKNOWN'?['currency']:[])])];
    entry.normalizationStatus=b.normalizationStatus||(entry.missingFields.length?'partial':'normalized');
    if(entry.category==='transfer'&&(!isPartyKey(entry.senderId)||!isPartyKey(entry.recipientId)||!entry.direction||!safe(entry.amountMinor)))entry.category='unidentified';
    if(entry.missingFields.length)entry.issues.push('Неполная банковская запись; не установлены реквизиты: '+entry.missingFields.map(v=>missingLabels[v]||v).join(', '));
    // A statement document number is not a cross-bank transaction identifier.
    entry.explicitTransactionId=String(b.transactionId||'').trim();
    entry.matches=matchesByOperation.get(op?.id)||[];
    entry.date=String(entry.date||"");entry.dateValid=/^\d{4}-\d{2}-\d{2}$/.test(entry.date)&&Number.isFinite(Date.parse(entry.date))&&new Date(entry.date).toISOString().slice(0,10)===entry.date;
    if(!entry.dateValid)entry.issues.push("Дата не распознана; строка сохранена и доступна, но не включена в датированные финансовые итоги");
    const old=grouped.get(key);
    if(old){
      old.sources.push(source);
      if(["amountMinor","rawAmountMinor","feeMinor","direction","feeMode"].some(k=>old[k]!==entry[k])){old.conflict=true;old.issues.push("Версии одной банковской операции содержат разные реквизиты; итог не рассчитан");}
    }else grouped.set(key,entry);
  }
  const entries=[...grouped.values()],accountOwners=new Map();
  for(const item of [...knownOwnedAccounts,...entries.map(e=>({account:e.ownerAccount,ownerId:e.ownerId}))]){
    if(!item||typeof item!=="object"||!item.account||!isPartyKey(item.ownerId))continue;
    if(!accountOwners.has(item.account))accountOwners.set(item.account,new Set());accountOwners.get(item.account).add(item.ownerId);
  }
  const ownerOf=account=>accountOwners.get(account)?.size===1?[...accountOwners.get(account)][0]:"";
  // Only an explicit, unique bank reference can link an inline fee and a standalone fee.
  const inline=entries.filter(e=>e.dateValid&&e.kind==="transfer"&&safe(e.feeMinor)&&e.feeMinor>0&&!e.conflict);
  const standalone=entries.filter(e=>e.dateValid&&e.kind==="fee"&&safe(e.amountMinor)&&!e.conflict);
  const feeMatches=new Map();
  const feeKey=(e,reference,amount)=>JSON.stringify([e.ownerId,e.ownerAccount,e.currency,e.date,reference,amount]);
  const inlineIndex=new Map();for(const e of inline){const key=feeKey(e,e.transactionId,e.feeMinor);if(!inlineIndex.has(key))inlineIndex.set(key,[]);inlineIndex.get(key).push(e);}
  for(const f of standalone){
    const candidates=f.feeReference?inlineIndex.get(feeKey(f,f.feeReference,f.amountMinor))||[]:[];
    if(candidates.length===1){const key=candidates[0].id;if(!feeMatches.has(key))feeMatches.set(key,[]);feeMatches.get(key).push(f);}
  }
  for(const e of inline){const list=feeMatches.get(e.id)||[];if(list.length===1){e.feeAlsoIn=list[0].id;e.feeSources=list[0].sources;list[0].countedWith=e.id;}else if(list.length>1)e.issues.push("Несколько строк комиссии ссылаются на перевод; автоматически не объединены");}
  const summaries=new Map(),counterparties=new Map();
  for(const e of entries){
    const senderOwner=ownerOf(e.senderAccount),recipientOwner=ownerOf(e.recipientAccount);
    e.internalTransfer=!!(/^\d{12}$/.test(e.senderId||'')&&e.senderId===e.recipientId||senderOwner&&senderOwner===recipientOwner&&(/^\d{12}$/.test(senderOwner)||e.senderAccount===e.recipientAccount));
    e.counterpartyId=e.direction==="outgoing"?e.recipientId:e.direction==="incoming"?e.senderId:"";
    e.counterpartyName=(e.direction==="outgoing"?e.recipientName:e.senderName)||e.unresolvedCounterpartyName;
    e.counterpartyAccount=e.direction==="outgoing"?e.recipientAccount:e.senderAccount;
    if(!summaries.has(e.currency))summaries.set(e.currency,zero());const t=summaries.get(e.currency);t.count++;
    if(e.conflict){t.conflicts++;continue;}
    if(!e.dateValid||e.currency==="UNKNOWN"||!e.ownerId||!e.direction||!safe(e.amountMinor)||e.missingFields.length)t.incomplete++;
    if(!e.dateValid||!isPartyKey(e.ownerId)||e.currency==='UNKNOWN'||!e.direction)continue;
    if(e.feeMinor!==null&&e.feeMinor!==undefined||['fee','fee_refund'].includes(e.kind))t.knownFees=true;
    if(e.direction&&safe(e.rawAmountMinor))t[e.direction==="incoming"?"rawIncomingMinor":"rawOutgoingMinor"]+=BigInt(e.rawAmountMinor);
    if(e.kind==="fee"&&!e.countedWith&&e.direction==="outgoing"&&safe(e.amountMinor))t.feesMinor+=BigInt(e.amountMinor);
    if(e.kind==="fee_refund"&&e.direction==="incoming"&&safe(e.amountMinor))t.feeRefundsMinor+=BigInt(e.amountMinor);
    if(!["transfer","refund"].includes(e.kind))continue;
    if(safe(e.feeMinor)&&e.feeMinor>0)t.feesMinor+=BigInt(e.feeMinor);
    if(e.category==='conversion'){
      if(safe(e.amountMinor))t[e.direction==='incoming'?'conversionIncomingMinor':'conversionOutgoingMinor']+=BigInt(e.amountMinor);
      if(isPartyKey(e.counterpartyId)&&e.counterpartyId!==e.ownerId){
        const k=`${e.counterpartyId}:${e.currency}`;
        if(!counterparties.has(k))counterparties.set(k,{id:e.counterpartyId,name:e.counterpartyName||partyLabel(e.counterpartyId),currency:e.currency,accounts:new Set(),owners:new Set(),names:new Set(),incomingMinor:0n,outgoingMinor:0n,count:0,unavailable:0,internalTransfers:0});
        const p=counterparties.get(k);p.count++;p.conversionCount=(p.conversionCount||0)+1;p.conversionIncomingMinor=p.conversionIncomingMinor||0n;p.conversionOutgoingMinor=p.conversionOutgoingMinor||0n;
        if(safe(e.amountMinor))p[e.direction==='incoming'?'conversionIncomingMinor':'conversionOutgoingMinor']+=BigInt(e.amountMinor);if(e.counterpartyAccount)p.accounts.add(e.counterpartyAccount);p.owners.add(e.ownerId);if(e.counterpartyName)p.names.add(e.counterpartyName);
      }
      continue;
    }
    if(!isPartyKey(e.senderId)||!isPartyKey(e.recipientId)){if(safe(e.amountMinor))t[e.direction==='incoming'?'unidentifiedIncomingMinor':'unidentifiedOutgoingMinor']+=BigInt(e.amountMinor);continue;}
    if(!e.internalTransfer&&e.direction&&safe(e.amountMinor))t[e.kind==="refund"?(e.direction==="incoming"?"refundIncomingMinor":"refundOutgoingMinor"):(e.direction==="incoming"?"incomingMinor":"outgoingMinor")]+=BigInt(e.amountMinor);
    if(!isPartyKey(e.counterpartyId))continue;
    const key=`${e.counterpartyId}:${e.currency}`;
    if(!counterparties.has(key))counterparties.set(key,{id:e.counterpartyId,name:e.counterpartyName||partyLabel(e.counterpartyId),currency:e.currency,accounts:new Set(),owners:new Set(),names:new Set(),incomingMinor:0n,outgoingMinor:0n,count:0,unavailable:0,internalTransfers:0});
    const p=counterparties.get(key);p.count++;if(e.counterpartyAccount)p.accounts.add(e.counterpartyAccount);if(e.ownerId)p.owners.add(e.ownerId);if(e.counterpartyName)p.names.add(e.counterpartyName);
    if(e.internalTransfer)p.internalTransfers++;
    if(e.direction&&safe(e.amountMinor))p[e.direction==="incoming"?"incomingMinor":"outgoingMinor"]+=BigInt(e.amountMinor);else p.unavailable++;
  }
  return {entries,summaries:[...summaries].map(([currency,t])=>({currency,...serial(t),feesMinor:t.knownFees?t.feesMinor.toString():null})),counterparties:[...counterparties.values()].map(p=>({...serial(p),accounts:[...p.accounts],owners:[...p.owners],names:[...p.names]}))};
}

export function bankAnalysis(db,caseId,query={}){
  // caseAnalysis performs the same department/case scope check as the existing workspace.
  const analysis=caseAnalysis(db,caseId,{all:true,skipChains:true});
  const sources=canonicalBankSourceRows(db.prepare(`SELECT r.*,d.original_name FROM case_extracted_rows r JOIN documents d ON d.id=r.document_id WHERE r.case_id=? AND NOT EXISTS(SELECT 1 FROM case_document_exclusions x WHERE x.case_id=r.case_id AND x.document_id=r.document_id) ORDER BY r.document_id,r.sheet,r.row_number`).all(caseId));
  const records=sources.map(s=>({row:JSON.parse(s.record_json),source:{documentId:s.document_id,name:s.original_name,sheet:s.sheet,row:s.row_number}}));
  const all=buildBankLedger(records,analysis.operations,analysis.matches);
  const owners=[...new Map(all.entries.filter(e=>e.ownerId).map(e=>[e.ownerAccount||e.ownerId,{id:e.ownerId,account:e.ownerAccount}])).values()];
  const selected=all.entries.filter(e=>(!query.owner||e.ownerAccount===query.owner||e.ownerId===query.owner)&&(!query.currency||e.currency===query.currency)&&(!(query.from||query.to)||e.dateValid)&&(!query.from||e.date>=query.from)&&(!query.to||e.date<=query.to));
  // Recompute totals after owner/date/currency filters, retaining source-level deduplication.
  const selectedKeys=new Set(selected.flatMap(e=>e.sources.map(sourceKey)));
  const ledger=buildBankLedger(records.filter(r=>selectedKeys.has(sourceKey(r.source))),analysis.operations,analysis.matches,all.entries.map(e=>({account:e.ownerAccount,ownerId:e.ownerId})));
  const words=clean(query.q).split(/\s+/).filter(Boolean);
  const entries=ledger.entries.filter(e=>words.every(w=>clean(JSON.stringify(e)).includes(w))).sort((a,b)=>b.date.localeCompare(a.date)||a.id.localeCompare(b.id));
  const counterparties=ledger.counterparties.filter(p=>words.every(w=>clean(JSON.stringify(p)).includes(w)));
  const offset=Math.max(0,Math.floor(Number(query.offset)||0)),limit=50;
  return {caseId,owners,currencies:[...new Set(all.entries.map(e=>e.currency))],summaries:ledger.summaries,counterparties:counterparties.slice(offset,offset+limit),counterpartyCount:counterparties.length,entries:entries.slice(offset,offset+limit),total:entries.length,offset,limit,methodology:"Суммы по валютам раздельно. Переводы, комиссии и возвраты комиссий не смешиваются с ЭСФ. Внутренние переводы между представленными собственными счетами не включены во внешние поступления/переводы. Это движение по документам, не установленный доход, ущерб или остаток счёта. Поиск фильтрует строки и контрагентов; итоги относятся ко всем строкам выбранных счёта, валюты и периода."};
}
