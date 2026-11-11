export function validIban(value){
  const v=String(value||"").replace(/\s+/g,"").toUpperCase();
  if(!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(v)||(v.startsWith("KZ")&&v.length!==20))return "";
  let remainder=0;
  for(const c of v.slice(4)+v.slice(0,4))for(const digit of /[A-Z]/.test(c)?String(c.charCodeAt(0)-55):c)remainder=(remainder*10+Number(digit))%97;
  return remainder===1?v:"";
}
export const isPartyKey=value=>/^\d{12}$/.test(value||"")&&value!=='000000000000'||String(value||"").startsWith("IBAN:")&&!!validIban(String(value).slice(5));
export const partyLabel=value=>String(value||"").startsWith("IBAN:")?"IBAN "+String(value).slice(5):"БИН/ИИН "+value;
export function bankEntryKind(value){
  if(["fee","fee_refund","transfer","refund"].includes(value.bank?.kind))return value.bank.kind;
  const purpose=String(value.purpose||"").toLocaleLowerCase("ru").replace(/ё/g,"е").trim();
  if(/^возврат\s+(оплаты|платежа|денежных\s+средств)(?:$|[^\p{L}])/u.test(purpose))return "refund";
  if(/^(возврат|возмещение)\s+(банковской\s+)?комиссии(?:$|[^\p{L}])/u.test(purpose))return "fee_refund";
  return /^(комиссия\s+банка|банковская\s+комиссия|комиссионное\s+вознаграждение|списание\s+комиссии|удержание\s+комиссии)(?:$|[^\p{L}])/u.test(purpose)?"fee":"transfer";
}
export const isBankFee=value=>(!value.type||value.type==="payment")&&["fee","fee_refund"].includes(bankEntryKind(value));
export function bankPurposeCategory(value){
 const kind=bankEntryKind(value);if(kind!=='transfer')return kind;
 const p=String(value.purpose||'').toLocaleLowerCase('ru').replace(/ё/g,'е');
 if(/пенсионн/u.test(p))return 'pension';if(/социальн.*(?:отчисл|плат|взнос)/u.test(p))return 'social';
 return bankPaymentClass(value)==='commercial_candidate'?'transfer':bankPaymentClass(value);
}
export function paymentCapacityKey(o){
  const a=validIban(o?.bank?.senderAccount),b=validIban(o?.bank?.recipientAccount),id=String(o?.bank?.transactionId||'').trim();
  return id&&a&&b?JSON.stringify(['bank-event',id,a,b,o.senderId,o.recipientId,o.date,o.currency,String(o.amountMinor??o.amount),bankEntryKind(o)]):'operation:'+(o?.id||o?.externalKey||o?.external_key||'');
}

// One classification for candidates, both review routes and historical decisions.
// "commercial_candidate" is eligibility for review, never proof of revenue/payment.
export function bankPaymentClass(value){
  const kind=bankEntryKind(value);if(kind!=="transfer")return kind;
  const statedKind=bankEntryKind({...value,bank:undefined});if(statedKind!=="transfer")return statedKind;
  const purpose=String(value.purpose||"").normalize("NFKC").toLocaleLowerCase("ru").replace(/ё/g,"е");
  if(/^(?:на\s+(?:ре|рас)?конвертацию|(?:ре|рас)?конвертаци[яю]|конверсионн[\p{L}]*|на\s+(?:покупку|продажу|обмен)\s+(?:иностранной\s+)?валюты)(?:$|[^\p{L}])/u.test(purpose.trim()))return 'conversion';
  if(/\b(?:loan|credit)\b|заем|займ|выдача кредита|погашение кредита/u.test(purpose))return "loan";
  if(/налог|бюджет|пеня|пени|социальн.*(?:отчисл|плат|взнос|перечисл)|пенсионн/u.test(purpose))return "tax";
  if(value.bank?.internalTransfer===true||value.senderId&&value.senderId===value.recipientId||/между собственными|внутренний перевод|собственных средств/u.test(purpose))return "internal";
  if(/взнос.*капитал|вклад.*капитал|дивиденд/u.test(purpose))return "capital";
  return "commercial_candidate";
}
export function invoicePaymentEligibility(invoice,payment,authorization=null){
  const classification=payment?bankPaymentClass(payment):"unknown";
  const fail=reason=>({eligible:false,classification,reason});
  if(!invoice||!payment||invoice.type!=="invoice"||payment.type!=="payment")return fail("Нужны ЭСФ и банковский платёж этого дела");
  if(invoice.conflict||payment.conflict||[invoice.reviewStatus,invoice.review,payment.reviewStatus,payment.review].includes("rejected"))return fail("Конфликтующие или отклонённые операции не распределяются");
  if(!invoice.currency||invoice.currency==="UNKNOWN"||invoice.currency!==payment.currency)return fail("Для оплаты нужна одна известная валюта");
  if(classification!=="commercial_candidate")return fail("Займы, налоги, внутренние переводы, комиссии, возвраты и движения капитала не засчитываются как оплата ЭСФ");
  const thirdParty=authorization?.valid===true&&authorization.payerId===payment.senderId&&authorization.debtorId===invoice.recipientId&&authorization.supplierId===invoice.senderId;
  if(!invoice.senderId||!invoice.recipientId||invoice.senderId===invoice.recipientId||invoice.senderId!==payment.recipientId||invoice.recipientId!==payment.senderId&&!thirdParty)return fail("Нужны согласованные обратные стороны либо проверенное документальное основание оплаты третьим лицом");
  const positive=o=>{const n=o.amountMinor??o.amount;return typeof n==="number"?Number.isSafeInteger(n)&&n>0:typeof n==="string"&&/^\d+$/.test(n)&&BigInt(n)>0n;};
  if(!positive(invoice)||!positive(payment))return fail("Для распределения нужны положительные точные суммы ЭСФ и платежа");
  return {eligible:true,classification,reason:""};
}

export function canonicalBankSourceRows(sourceRows){
  const aliases=new Map();
  const parsed=sourceRows.map(source=>({...source,bankRecord:JSON.parse(source.record_json)}));
  for(const {bankRecord:row} of parsed){
    if(!row.bank)continue;
    for(const [account,identifier] of [[row.bank.ownerAccount,row.bank.ownerBin],[row.bank.senderAccount,row.bank.senderBin],[row.bank.recipientAccount,row.bank.recipientBin]]){
      if(!validIban(account)||!/^\d{12}$/.test(identifier||""))continue;
      if(!aliases.has(account))aliases.set(account,new Set());
      aliases.get(account).add(identifier);
    }
  }
  const resolve=id=>{
    if(!String(id||"").startsWith("IBAN:"))return id;
    const values=aliases.get(id.slice(5));
    return values?.size===1?[...values][0]:id;
  };
  return parsed.map(({bankRecord:row,...source})=>{
    if(!row.bank)return source;
    row={...row,senderId:resolve(row.senderId),recipientId:resolve(row.recipientId),bank:{...row.bank,ownerId:resolve(row.bank.ownerId),issues:[...(row.bank.issues||[])]}};
    for(const account of [row.bank.ownerAccount,row.bank.senderAccount,row.bank.recipientAccount])if(aliases.get(account)?.size>1)row.bank.issues.push("Один IBAN указан у разных БИН/ИИН; объединение по счёту не выполнено");
    return {...source,record_json:JSON.stringify(row)};
  });
}
