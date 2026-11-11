// Deterministic, labelled facts only. A candidate ID is never assigned a role by position alone.
export const FACTS_VERSION="labelled-facts-1.2";
const unique=v=>[...new Set(v.filter(Boolean))];
const one=v=>{const values=unique(v);return values.length===1?values[0]:"";};
const idPattern=/(?<![\p{L}\d])\d{12}(?![\p{L}\d])/gu;
const currencies=new Set(Intl.supportedValuesOf("currency"));
const validId=value=>/^\d{12}$/.test(value)&&value!=="000000000000";
export function validFactDate(value){if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;const d=new Date(value+"T00:00:00Z");return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===value;}
const dateValue=v=>{const s=v.replace(/\//g,".");return /^\d{2}\.\d{2}\.\d{4}$/.test(s)?s.split(".").reverse().join("-"):s;};
export function factAmount(value){const s=String(value||"").replace(/[ \u00a0\u202f]/g,"").replace(",",".");if(!/^-?\d{1,13}(?:\.\d{1,2})?$/.test(s))return null;const neg=s.startsWith("-"),[a,b=""]=s.replace("-","").split(".");const n=Number(BigInt(a)*100n+BigInt(b.padEnd(2,"0")))*(neg?-1:1);return Number.isSafeInteger(n)?n:null;}
export function sameFactValue(key,a,b){return key==="amount"?factAmount(a)!==null&&factAmount(a)===factAmount(b):String(a).trim()===String(b).trim();}

export function extractLabelledFacts(value,{typeId="",groupId=""}={}){
  const text=String(value||"").normalize("NFC").replace(/\r/g,"").replace(/ё/g,"е"),evidence={},conflicts=[];
  const collect=(field,expression,convert=v=>v.trim())=>{
    const matches=[...text.matchAll(expression)],all=unique(matches.map(m=>convert(m[1]))),values=all.filter((value,index)=>!all.slice(0,index).some(previous=>sameFactValue(field,previous,value)));
    if(values.length>1||matches.some(m=>!convert(m[1])))conflicts.push(field);
    if(values.length===1)evidence[field]=matches.filter(m=>sameFactValue(field,convert(m[1]),values[0])).map(m=>m[0].slice(0,300));
    return values.length===1?values[0]:"";
  };
  const fields={
    senderId:collect("senderId",/(?:БИН поставщика|БИН отправителя|ИИН отправителя|БИН плательщика|ИИН\/БИН поставщика|БИН\/ИИН поставщика)\s*[:：]?\s*(\d{12})(?!\d)/giu),
    recipientId:collect("recipientId",/(?:БИН получателя|БИН покупателя|ИИН получателя|ИИН\/БИН получателя|БИН\/ИИН покупателя)\s*[:：]?\s*(\d{12})(?!\d)/giu),
    senderName:collect("senderName",/Наименование (?:поставщика|отправителя|плательщика)\s*[:：][ \t]*([^\n]{1,500})/giu),
    recipientName:collect("recipientName",/Наименование (?:получателя|покупателя)\s*[:：][ \t]*([^\n]{1,500})/giu),
    date:collect("date",new RegExp(`(?:${typeId==="invoice"?"Дата совершения оборота":"Дата платежа|Дата документа"})\\s*[:：]?\\s*(\\d{2}[./]\\d{2}[./]\\d{4}|\\d{4}-\\d{2}-\\d{2})`,"giu"),v=>{const d=dateValue(v);return validFactDate(d)?d:"";}),
    amount:collect("amount",/^[ \t]*(?:Общая сумма(?: документа| с НДС)?|Сумма платежа|Итого к оплате|Сумма договора|Общая стоимость договора|Стоимость выполненных работ|Стоимость оказанных услуг)\s*[:：]?\s*(\d(?:[\d \u00a0\u202f]*\d)?(?:[.,]\d{2})?)(?:[ \t]*(?:KZT|USD|EUR|RUB|тенге|теңге|₸))?[ \t]*$/gimu,v=>factAmount(v)!==null?v.trim():""),
    currency:collect("currency",/(?:Валюта|Код валюты)\s*[:：]?\s*([A-Z]{3})(?![A-Z])/gu),
    number:collect("number",new RegExp(`(?:${typeId==="invoice"?"Регистрационный номер ЭСФ|Номер ЭСФ":typeId==="payment_order"?"Номер платежного поручения|Номер платежа|Номер документа":"Номер договора|Номер документа|Номер накладной|Номер акта"})\\s*[:：№]?\\s*([\\p{L}\\d][\\p{L}\\d/._-]{0,100})`,"giu")),
    purpose:collect("purpose",/(?:Назначение платежа|Предмет договора)\s*[:：][ \t]*([^\n]{1,2000})/giu),
    contractRef:"",reference:"",
  };
  if(["completion_act","acceptance_act"].includes(typeId)){
    // These labels identify parties to an act, not to a payment. Keep explicit
    // role labels separate from the general bank/invoice aliases.
    for(const [field,role] of [["senderId","исполнителя"],["recipientId","заказчика"]]){
      const expression=new RegExp(`^[ \\t]*(?:БИН|ИИН|БИН/ИИН|ИИН/БИН)[ \\t]+${role}[ \\t]*[:：][ \\t]*(\\d{12})[ \\t]*$`,"gimu");
      const previous=fields[field],found=collect(field,expression);
      if(previous&&found&&previous!==found){fields[field]="";conflicts.push(field);}
      else fields[field]=previous||found;
    }
    const priorDateEvidence=evidence.date||[];
    const genericDate=collect("date",/^[ \t]*Дата(?: акта)?[ \t]*[:：][ \t]*(\d{2}[./]\d{2}[./]\d{4}|\d{4}-\d{2}-\d{2})[ \t]*$/gimu,v=>{const d=dateValue(v);return validFactDate(d)?d:"";});
    if(fields.date&&genericDate&&fields.date!==genericDate){fields.date="";conflicts.push("date");}
    else fields.date=fields.date||genericDate;
    if(priorDateEvidence.length)evidence.date=unique([...priorDateEvidence,...(evidence.date||[])]);
    const priorAmount=fields.amount,priorEvidence=evidence.amount||[];
    const actual=collect("amount",/^[ \t]*(?:Стоимость фактического исполнения|Стоимость фактически выполненных работ|Фактическая стоимость работ)[ \t]*[:：][ \t]*((?:\d+|\d{1,3}(?:[ \u00a0\u202f]\d{3})+)(?:[.,]\d{1,2})?)(?:[ \t]*(?:KZT|USD|EUR|RUB|тенге|теңге|₸))?[ \t]*$/gimu,v=>factAmount(v)!==null?v.trim():"");
    if(priorAmount&&actual&&factAmount(priorAmount)!==factAmount(actual)){fields.amount="";conflicts.push("amount");}
    else fields.amount=priorAmount||actual;
    if(priorEvidence.length)evidence.amount=unique([...priorEvidence,...(evidence.amount||[])]);
  }
  const amountCurrencies=unique((evidence.amount||[]).flatMap(fragment=>[...fragment.matchAll(/(?<![\p{L}])(?:KZT|USD|EUR|RUB|тенге|теңге|₸)(?![\p{L}])/giu)].map(m=>/тенге|теңге|₸/iu.test(m[0])?'KZT':m[0].toUpperCase())));
  if(amountCurrencies.length>1||fields.currency&&amountCurrencies.some(c=>c!==fields.currency))conflicts.push('currency');
  // Role blocks are bounded by headings, never by the position of an arbitrary ID.
  // Contract/act parties describe supply, not the direction of a bank transfer.
  const commercial=groupId==="contract"||groupId==="primary"||["agreement","supply_agreement","work_contract","completion_act","acceptance_act","delivery_note"].includes(typeId);
  if(commercial&&typeId!=="invoice"){
    const roles={"поставщик":"sender","продавец":"sender","исполнитель":"sender","арендодатель":"sender","покупатель":"recipient","заказчик":"recipient","арендатор":"recipient"};
    const lines=text.split("\n"),blocks=[];
    const heading=/^[ \t]*(Поставщик|Продавец|Исполнитель|Арендодатель|Покупатель|Заказчик|Арендатор)(?:[ \t]*[:：][ \t]*(.*)|[ \t]*)$/iu;
    const stop=/^[ \t]*(?:банк(?:\s|:)|банковские реквизиты|представитель|директор|подписи|предмет договора|цена договора|общая сумма|сумма договора|срок|ответственность|назначение платежа)/iu;
    for(let i=0;i<lines.length;i++){
      const h=lines[i].match(heading);if(!h)continue;
      const body=[h[2]||""];
      for(let j=i+1;j<Math.min(lines.length,i+9);j++){if(heading.test(lines[j])||stop.test(lines[j]))break;body.push(lines[j]);}
      const block=body.join("\n"),ids=unique([...block.matchAll(/(?:ИИН\s*\(\s*БИН\s*\)|БИН\s*\(\s*ИИН\s*\)|ИИН\/БИН|БИН\/ИИН|БИН|ИИН|БСН|ЖСН)[ \t]*[:：]?[ \t]*(?:\n[ \t]*)?(\d{12})(?![\p{L}\d])/giu)].map(m=>m[1]));
      const name=body.map(line=>line.trim()).find(line=>/^(?:ТОО|АО|ИП|ЖШС)(?:\s|«|"|“)/u.test(line))?.split(/[,;]?[ \t]*(?:БИН|ИИН|БСН|ЖСН)\s*[:：]/iu)[0].trim();
      blocks.push({role:roles[h[1].toLowerCase()],ids,name,evidence:[lines[i],...body.slice(1)].join("\n").slice(0,1500)});
    }
    for(const role of ["sender","recipient"]){
      const selected=blocks.filter(b=>b.role===role),field=role+"Id",ids=unique([fields[field],...selected.flatMap(b=>b.ids)]);
      if(ids.some(id=>!validId(id))||ids.length>1){fields[field]="";conflicts.push(field);}
      else if(ids.length===1&&!conflicts.includes(field)){fields[field]=ids[0];evidence[field]=unique([...(evidence[field]||[]),...selected.filter(b=>b.ids.includes(ids[0])).map(b=>b.evidence)]);}
      // Do not attach a name from a different or unidentified role block.
      const names=unique(selected.filter(b=>b.ids.length===1&&b.ids[0]===fields[field]).map(b=>b.name));
      if(!fields[role+"Name"]&&names.length===1){fields[role+"Name"]=names[0];evidence[role+"Name"]=[names[0]];}
    }
    const title=groupId==="contract"||["agreement","supply_agreement","work_contract"].includes(typeId)?"(?:Договор|Контракт)":"(?:Акт (?:выполненных работ|оказанных услуг|приема[ -]передачи)|(?:Товарная )?Накладная(?: на (?:отпуск|передачу|возврат)[^\\n№]{0,50})?)";
    const headers=[...text.matchAll(new RegExp(`^[ \\t]*${title}[^\\n№]{0,100}?[ \\t]*№[ \\t]*([\\p{L}\\d][\\p{L}\\d/._-]{0,60})(?:[ \\t]+от[ \\t]+(\\d{2}[./]\\d{2}[./]\\d{4}|\\d{4}-\\d{2}-\\d{2}))?`,"gimu"))];
    for(const [field,index,convert] of [["number",1,v=>v],["date",2,dateValue]]){
      const matches=headers.filter(m=>m[index]);
      const candidates=unique([fields[field],...matches.map(m=>convert(m[index]))]);
      if(candidates.length>1||field==="date"&&candidates.some(d=>!validFactDate(d))){fields[field]="";conflicts.push(field);}
      else if(candidates.length===1&&!conflicts.includes(field)){fields[field]=candidates[0];evidence[field]=unique([...(evidence[field]||[]),...matches.map(m=>m[0])]);}
    }
  }
  if(!fields.date&&!conflicts.includes("date"))fields.date=collect("date",/(?:Дата выписки|Дата документа)\s*[:：]?\s*(\d{2}[./]\d{2}[./]\d{4}|\d{4}-\d{2}-\d{2})/giu,v=>{const d=dateValue(v);return validFactDate(d)?d:"";});
  // Standard payment form has explicit sender/beneficiary blocks, each with one ID.
  if(typeId==="payment_order"){
    const sender=text.search(/Отправитель денег|Плательщик\s*[:：]/iu),beneficiary=text.search(/Бенеф[иін]циар\s*[/:：]|Получатель денег/iu);
    const purpose=text.search(/Назначение платежа/iu);
    for(const [field,begin,end] of [["senderId",sender,beneficiary],["recipientId",beneficiary,purpose>=0?purpose:text.length]]){
      if(fields[field]||conflicts.includes(field)||begin<0||end<=begin)continue;
      const block=text.slice(begin,Math.min(end,begin+1200)),ids=unique([...block.matchAll(idPattern)].map(m=>m[0]));
      if(/ИИН\s*\(\s*БИН\s*\)|БИН\s*\(\s*ИИН\s*\)|ЖСН/iu.test(block)&&ids.length===1){fields[field]=ids[0];evidence[field]=[block.slice(0,1000)];}
      const nameField=field==="senderId"?"senderName":"recipientName",name=block.slice(0,220).match(/(?:ТОО|АО|ИП)\s+[^\n]{2,250}/u)?.[0];
      if(!fields[nameField]&&name&&!/банк/iu.test(name)){fields[nameField]=name;evidence[nameField]=[name];}
    }
    if(!fields.amount&&!conflicts.includes("amount")){
      const block=text.slice(0,beneficiary>0?beneficiary:1500),matches=[...block.matchAll(/(?:^|\n)Сумма\s*[:：]\s*(\d[\d \u00a0\u202f]*[.,]\d{2})(?!\d)/gu)];
      const amounts=unique(matches.map(m=>factAmount(m[1])!==null?m[1].trim():""));
      if(amounts.length===1){fields.amount=amounts[0];evidence.amount=matches.map(m=>m[0]);}else if(amounts.length>1)conflicts.push("amount");
    }
    if(!fields.date&&!conflicts.includes("date")){
      const matches=[...text.matchAll(/(?:Да)?та валютирования\s*[:：]?\s*(\d{2}[./]\d{2}[./]\d{4}|\d{4}-\d{2}-\d{2})/giu)],dates=unique(matches.map(m=>dateValue(m[1])).filter(validFactDate));
      if(dates.length===1){fields.date=dates[0];evidence.date=matches.map(m=>m[0]);evidence.dateKind=["Дата валютирования, не время совершения платежа"];}else if(dates.length>1)conflicts.push("date");
    }
    if(!fields.purpose&&purpose>=0){fields.purpose=text.slice(purpose+"Назначение платежа".length).replace(/^\s*[:：]?\s*/,"").split(/Подписи отправителя|Басшы\/Руководитель|Документи ЭСК/iu)[0].slice(0,1600).trim();}
  }
  if(!fields.currency&&!conflicts.includes("currency")){
    const labels=unique([...text.matchAll(/(?<![\p{L}])(?:KZT|USD|EUR|RUB|тенге|теңге|₸|доллар(?:ов|а)?|евро|рубл(?:ей|я)?)(?![\p{L}])/giu)].map(m=>/KZT|тенге|теңге|₸/iu.test(m[0])?"KZT":/USD|доллар/iu.test(m[0])?"USD":/EUR|евро/iu.test(m[0])?"EUR":"RUB"));
    if(labels.length===1){fields.currency=labels[0];evidence.currency=["Явное обозначение валюты в тексте: "+labels[0]];}
  }
  if(!fields.number&&!conflicts.includes("number")){
    const expression=typeId==="payment_order"?/(?:ПЛАТЕЖНОЕ\s+ПОРУЧЕНИЕ|ТӨЛЕМ\s+ТАПСЫРМА)[^\n]{0,30}(?:\n\s*)?(?:№|No\b|N\b)\s*([\p{L}\d][\p{L}\d/._-]{0,60})/giu:typeId==="invoice"?/\b(ESF-[A-Z\d-]{10,100})\b/giu:/^(?:Договор|Контракт)[^\n]{0,60}?(?:№|No\b|N\b)\s*([\p{L}\d][\p{L}\d/._-]{0,60})/gimu;
    const matches=[...text.matchAll(expression)];fields.number=one(matches.map(m=>m[1]));if(fields.number)evidence.number=matches.map(m=>m[0]);
  }
  const refs=unique([...text.matchAll(/(?:договор[а-я]*|контракт[а-я]*)\s*(?:поставки|подряда|аренды)?\s*(?:№|N\b)\s*([\p{L}\d][\p{L}\d/._-]{0,60})/giu)].map(m=>m[1]));
  fields.contractRef=one(refs);
  const invoiceRefs=unique([...text.matchAll(/ESF-[A-Z\d-]{10,100}/gi)].map(m=>m[0]));
  fields.reference=typeId==="invoice"?fields.contractRef:one(invoiceRefs)||fields.contractRef;
  for(const field of ["senderId","recipientId"])if(fields[field]&&!validId(fields[field])){fields[field]="";conflicts.push(field);}
  return {fields,evidence,conflicts:unique(conflicts),version:FACTS_VERSION};
}

export function automaticFactDecision(facts,{groupId,typeId,unread=false,uncertain=false}={}){
  const f=facts.fields,missing=["senderId","recipientId","date","amount","currency"].filter(k=>!f[k]);
  if(groupId!=="bank"&&!f.number)missing.push("number");
  const allowed=groupId==="bank"&&["payment_order","receipt"].includes(typeId)||groupId==="contract"&&typeId!=="addendum"&&typeId!=="specification"||groupId==="primary";
  const valid=validId(f.senderId)&&validId(f.recipientId)&&validFactDate(f.date)&&factAmount(f.amount)!==null&&currencies.has(f.currency);
  return {eligible:!!allowed&&!!valid&&!missing.length&&!facts.conflicts.length&&!unread&&!uncertain,missing,conflicts:facts.conflicts,version:FACTS_VERSION};
}

// Non-transaction documents carry assertions and findings, not bank movements.
// Preserve every matching labelled assertion with its line; never choose one
// of several claim amounts, net tax values or opinions as a financial total.
export function extractContextFacts(value){
 const lines=String(value||'').normalize('NFC').replace(/\r/g,'').split('\n'),facts=[];
 const rules=[
  ['victim','Потерпевший|ФИО потерпевшего|Наименование потерпевшего','text'],
  ['victimIdentifier','БИН потерпевшего|ИИН потерпевшего|БИН/ИИН потерпевшего','identifier'],
  ['claimedAmount','Заявленный ущерб|Сумма заявленного ущерба|Размер заявленного ущерба|Сумма ущерба','amount'],
  ['returnedAmount','Сумма возврата|Возвращено денежных средств|Фактически возвращено','amount'],
  ['property','Наименование имущества|Возвращенное имущество|Возвращённое имущество|Предмет оценки','text'],
  ['valuation','Оценочная стоимость|Рыночная стоимость|Стоимость возвращенного имущества|Стоимость возвращённого имущества','amount'],
  ['taxAccrued','Начислено налога|Начислено','amount'],['taxPaid','Уплачено налога|Фактически уплачено налога','amount'],
  ['taxArrears','Недоимка','amount'],['taxOverpayment','Переплата налога','amount'],
  ['opening','Начальный остаток|Сальдо начальное','amount'],['closing','Конечный остаток|Сальдо конечное','amount'],
  ['conclusion','Вывод специалиста|Вывод эксперта|Выводы|Заключение по результатам ревизии','text'],
  ['reference','Договор основание|Номер договора основания|Номер связанного документа','text'],
 ];
 for(let i=0;i<lines.length;i++)for(const [field,label,kind] of rules){
  const match=lines[i].match(new RegExp(`^[ \\t]*(${label})[ \\t]*[:：][ \\t]*(.*)$`,'iu'));if(!match)continue;
  const raw=match[2].trim()||lines[i+1]?.trim()||'';if(!raw)continue;
  const currencyTokens=unique([...raw.matchAll(/(?<![\p{L}])(?:KZT|USD|EUR|RUB|тенге|теңге|₸)(?![\p{L}])/giu)].map(m=>/тенге|теңге|₸/iu.test(m[0])?'KZT':m[0].toUpperCase()));
  const amount=kind==='amount'?factAmount(raw.replace(/[ \t]*(?:KZT|USD|EUR|RUB|тенге|теңге|₸)[ \t]*$/iu,'')):null;
  facts.push({field,label:match[1],kind,raw:raw.slice(0,2000),normalized:kind==='amount'?(amount===null?null:String(amount)):kind==='identifier'?(validId(raw)?raw:null):raw.slice(0,2000),currency:currencyTokens.length===1?currencyTokens[0]:null,line:i+1,endLine:match[2].trim()?i+1:i+2,interpretation:'Утверждение исходного документа, не подтверждённая операция'});
 }
 return facts;
}

export function analyzeStandaloneText(result,settings){
  const layoutOnly=!result.tables?.length||result.tables.every(t=>!Object.keys(t.mapping||{}).length)&&!result.rows?.some(r=>r.senderId||r.recipientId||r.amountMinor!==null&&r.amountMinor!==undefined);
  if(!result.pages?.length&&layoutOnly&&!result.rows?.some(r=>r.type!=='context'&&r.senderId&&r.recipientId&&Number.isSafeInteger(r.amountMinor))&&['victim','reimbursement','tax','expert','accounting'].includes(settings.groupId)){
    const facts=extractContextFacts(result.text);if(!facts.length)return result;
    const quality=result.quality?{...result.quality,layoutTableDiagnostics:{issueCounts:result.quality.issueCounts,examples:result.quality.examples},extractedRows:1,contextRows:1,eligibleRows:0,reviewRows:0,issueCounts:Object.fromEntries(Object.entries(result.quality.issueCounts||{}).filter(([code])=>code.startsWith('IGNORED_'))),examples:(result.quality.examples||[]).filter(e=>e.code.startsWith('IGNORED_'))}:undefined;
    return {...result,status:'extracted',unparsedRows:0,contextOnly:true,...(quality?{quality}:{}),warnings:[...(result.warnings||[]).filter(w=>!/^Текст прочитан\. Надёжно выделить операции|^Не распознаны основные поля\.|^Неполные реквизиты в строках:/.test(w)),'Извлечены подписанные сведения документа. Заявления, оценки и сведения о возврате сохранены как утверждения источника, не как подтверждённые банковские операции.'],automaticFacts:{eligible:false,missing:[],conflicts:[],version:FACTS_VERSION,contextFacts:facts},rows:[{sheet:'Факты документа',row:1,type:'context',senderId:'',recipientId:'',date:'',currency:'UNKNOWN',amountMinor:null,number:'',raw:Object.fromEntries(facts.map(f=>[f.label+' · строка '+f.line,f.raw])),attributes:{documentFacts:facts}}]};
  }
  if(result.pages?.length||result.documentProfile||!["bank","contract","primary"].includes(settings.groupId))return result;
  // A table with economic facts owns its own extraction. Never replace invoice
  // lines or a partially parsed ledger with a total found elsewhere in the text.
  if(result.tables?.length&&(settings.typeId==='invoice'||result.tables.some(table=>Object.keys(table.mapping||{}).length)||result.rows?.some(row=>row.senderId||row.recipientId||row.amountMinor!==null&&row.amountMinor!==undefined)))return result;
  if(result.rows?.some(row=>row.type!=="context"&&row.senderId&&row.recipientId&&Number.isSafeInteger(row.amountMinor)))return result;
  const facts=extractLabelledFacts(result.text||"",settings),decision=automaticFactDecision(facts,settings),f=facts.fields;
  if(!decision.eligible){
    const probes={senderId:/^\s*(?:БИН|ИИН).*(?:исполнителя|поставщика|отправителя)/iu,recipientId:/^\s*(?:БИН|ИИН).*(?:заказчика|покупателя|получателя)/iu,date:/^\s*Дата\b|^\s*Дата(?:\s|:)/iu,amount:/^\s*(?:Сумма|Стоимость|Общая сумма|Итого)/iu,currency:/^\s*(?:Валюта|Код валюты)/iu,number:/^\s*(?:Номер|Акт|Договор).*?(?:№|:)/iu};
    const requested=new Set([...decision.missing,...decision.conflicts]);
    const fieldLocations=(result.text||"").split(/\r?\n/).flatMap((line,i)=>[...requested].some(k=>probes[k]?.test(line))?[{line:i+1,text:line.trim().slice(0,300)}]:[]).slice(0,12);
    return {...result,automaticFacts:{...decision,fieldLocations}};
  }
  const type=settings.groupId==="bank"?"payment":settings.groupId==="contract"?"contract":settings.typeId==="invoice"?"invoice":"primary";
  const quality=result.quality?{...result.quality,
    // The empty-mapping layout was not a transaction table. Keep the original
    // diagnostics for traceability, but do not present its cells as failed transfers.
    ...(result.tables?.length?{layoutTableDiagnostics:{issueCounts:result.quality.issueCounts,examples:result.quality.examples},
      issueCounts:Object.fromEntries(Object.entries(result.quality.issueCounts||{}).filter(([code])=>code.startsWith('IGNORED_'))),
      examples:(result.quality.examples||[]).filter(item=>item.code.startsWith('IGNORED_'))}:{}),
    extractedRows:1,eligibleRows:1,reviewRows:0,contextRows:0}:undefined;
  return {...result,status:"extracted",unparsedRows:0,contextOnly:false,automaticFacts:decision,...(quality?{quality}:{}),
    warnings:(result.warnings||[]).filter(w=>!/^Не распознаны основные поля\.|^Текст прочитан\. Надёжно выделить операции|^Неполные реквизиты в строках:/.test(w)),
    rows:[{sheet:"Текст документа",row:1,type,groupId:settings.groupId,documentType:settings.typeId,raw:{"Текст":result.text},...f,amountMinor:factAmount(f.amount),registrationNumber:type==="invoice"&&/^ESF-/i.test(f.number),amountBasis:"document_total",automaticSource:true,manualSource:false,attributes:{automaticPreliminary:true,extractionRule:facts.version,fieldEvidence:facts.evidence}}]};
}
