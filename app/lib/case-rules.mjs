import {createHash} from "node:crypto";
import {isBankFee,bankEntryKind,bankPaymentClass} from "./bank-identities.mjs";
import {readingDiagnostic} from "./document-reading-status.mjs";
const norm=v=>String(v??"").normalize("NFKC").toLocaleLowerCase("ru").replace(/ё/g,"е").replace(/[^\p{L}\p{N}]/gu,"");
const digest=v=>createHash("sha256").update(JSON.stringify(v)).digest("hex");
const money=n=>`${(n/100).toLocaleString("ru-RU",{maximumFractionDigits:2})}`;
export const RULE_VERSION="case-rules-1.4";
const inactive=r=>/^(REVOKED|CANCELLED|CANCELED|DELETED|ОТОЗВАН|АННУЛИРОВАН|ОТМЕНЕН)/.test(r.status||"");
const pair=r=>[r.senderId,r.recipientId].sort().join(":");
const live=o=>!o.conflict&&o.review!=="rejected"&&!inactive(o)&&!isBankFee(o)&&!(o.type==='payment'&&bankPaymentClass(o)==='conversion');
function decimal(v){
  const s=String(v??"").trim().replace(/[\s\u00a0]/g,"").replace(",",".");
  if(!/^-?\d+(\.\d{1,6})?$/.test(s))return null;
  const negative=s.startsWith("-"),[a,b=""]=s.replace(/^-/ ,"").split(".");
  return BigInt(a)*1000000n*(negative?-1n:1n)+BigInt(b.padEnd(6,"0"))*(negative?-1n:1n);
}
export function evaluateCaseRules({records,operations,documents,priorLinks=[],chainsOnly=false}){
  const risks=[],links=[],chains=[];
  const add=(key,code,kind,severity,description,evidence,rule,nextAction,calculation={})=>risks.push({key:`extended:${key}`,code,kind,severity,description,evidence,rule,nextAction,calculation,version:RULE_VERSION});
  for(const record of records)if(record.row.bank?.issues?.length)add("bank-row:"+digest(record.source),"BANK_ROW_NEEDS_CONTEXT","data_quality","info","Не все параметры банковской строки определены.",[record.source],"Неизвестные стороны, направление и включение комиссии не угадываются.","Укажите владельца счёта и способ учета комиссии в настройках файла.",{issues:record.row.bank.issues});
  const stages={contract:"Договор",primary:"Исполнение",invoice:"ЭСФ",payment:"Оплата",reimbursement:"Возврат",accounting:"Учёт",claim:"Требование"};
  const operationBySource=new Map();
  for(const record of records){const conflicts=record.row.attributes?.conflictingFields||[];if(conflicts.length)add(`facts-conflict:${record.source.documentId}:${record.source.sheet}:${record.source.row}`,"EXTRACTION_FIELD_CONFLICT","data_quality","medium","В тексте или независимых вариантах OCR расходятся реквизиты; автоматическая операция не создана.",[record.source],"Сравниваются явно подписанные поля, а не произвольные числа на странице.","Нужен более качественный исходный файл для однозначного извлечения.",{fields:conflicts});}
  for(const operation of operations)for(const s of operation.sources)operationBySource.set(`${s.documentId}:${s.sheet}:${s.row}`,operation);
  const source=record=>record.source;
  const items=records.map(record=>({...record.row,source:record.source,operation:operationBySource.get(`${record.source.documentId}:${record.source.sheet}:${record.source.row}`)})).filter(r=>!inactive(r)&&r.type!=="context");
  const contracts=operations.filter(o=>o.type==="contract"&&live(o));
  const refs=new Map();
  for(const contract of contracts){const key=`${pair(contract)}:${norm(contract.number)}`;if(!refs.has(key))refs.set(key,[]);refs.get(key).push(contract);}
  const explicitLinks=new Set();
  for(const item of items){
    const operation=item.operation;
    if(!operation||!live(operation)||operation.type==="contract")continue;
    const reference=item.contractRef||((operation.type!=="payment")?item.reference:"");
    if(!reference)continue;
    const candidates=refs.get(`${pair(operation)}:${norm(reference)}`)||[];
    if(candidates.length===1){
      const contract=candidates[0],key=`${contract.id}:${operation.id}`;
      if(!explicitLinks.has(key)){links.push({leftId:contract.id,rightId:operation.id,method:"contract_reference",explanation:"Совпали номер договора и идентификаторы сторон. Это документальная ссылка, не подтверждение фактического исполнения."});explicitLinks.add(key);}
    }else if(candidates.length>1)add(`${operation.id}:versions`,"CONTRACT_VERSION_AMBIGUITY","data_quality","info",`Для ссылки «${reference}» есть несколько версий договора.`,operation.sources,"Одинаковые номер и стороны не определяют автоматически действующую редакцию.","Укажите действующую редакцию и основание изменений.");
  }
  const allLinks=[...priorLinks,...links];
  const connected=new Map(operations.map(o=>[o.id,new Set()]));
  for(const link of allLinks){connected.get(link.leftId)?.add(link.rightId);connected.get(link.rightId)?.add(link.leftId);}
  const byId=new Map(operations.map(o=>[o.id,o]));
  for(const contract of [...contracts,...operations.filter(o=>o.type==="invoice"&&live(o)&&!links.some(l=>l.rightId===o.id))]){
    const found=new Set([contract.id]),queue=[contract.id];
    for(let i=0;i<queue.length;i++)for(const id of connected.get(queue[i])||[])if(!found.has(id)){found.add(id);queue.push(id);}
    const related=[...found].map(id=>byId.get(id)).filter(Boolean);
    const chain={id:contract.id,number:contract.number,stages:Object.keys(stages).map(type=>({type,label:stages[type],operations:related.filter(o=>o.type===type).map(o=>({id:o.id,number:o.number,sources:o.sources,date:o.date,amountMinor:o.amount,currency:o.currency}))})),explanation:"Связи основаны на номерах документов и реквизитах сторон. Отсутствующая ступень означает только отсутствие однозначной связи в загруженном наборе."};
    chains.push(chain);
    if(contract.type!=="contract")continue;
    const invoices=related.filter(o=>o.type==="invoice"&&live(o)&&o.currency===contract.currency);
    const payments=related.filter(o=>o.type==="payment"&&bankEntryKind(o)!=="refund"&&live(o)&&o.currency===contract.currency&&o.senderId===contract.recipientId&&o.recipientId===contract.senderId);
    const directIds=new Set(allLinks.filter(l=>l.leftId===contract.id&&l.method==="contract_reference").map(l=>l.rightId));
    // Do not infer contractual overpayment through an amount/date-only match.
    const explicitPayments=payments.filter(p=>directIds.has(p.id)||priorLinks.some(l=>l.rightId===p.id&&l.method==="document_reference"&&invoices.some(i=>i.id===l.leftId&&directIds.has(i.id))));
    if(contract.currency!=="UNKNOWN"&&contract.amount>0&&explicitPayments.length){
      const paid=explicitPayments.reduce((a,p)=>a+p.amount,0);
      if(Number.isSafeInteger(paid)&&paid>contract.amount)add(`${contract.id}:overpayment`,"CONTRACT_PAYMENT_EXCESS","discrepancy","medium",`Платежи по ссылкам на договор «${contract.number}» превышают его представленную сумму.`,[...contract.sources,...explicitPayments.flatMap(p=>p.sources)],"Суммируются только известная валюта и платежи с документальной ссылкой. Допсоглашения, возвраты и изменения цены могут объяснить разницу.","Проверьте действующую редакцию договора, дополнительные соглашения и возвраты.",{contractMinor:contract.amount,paymentMinor:paid,differenceMinor:paid-contract.amount,currency:contract.currency});
    }
    if(!related.some(o=>o.type==="primary")&&invoices.length)add(`${contract.id}:fulfillment`,"FULFILLMENT_NOT_LINKED","data_quality","info",`По договору «${contract.number}» связаны ЭСФ, но не связаны акты или накладные.`,[...contract.sources,...invoices.flatMap(o=>o.sources)],"Проверяется комплект загруженных документов, а не реальность поставки.","Добавьте документы исполнения или укажите, почему для этой операции они не применяются.");
  }
  if(chainsOnly)return {risks:[],links,chains,ruleVersion:RULE_VERSION};
  for(const item of items){
    const s=source(item),fields=item.attributes||{},key=`${s.documentId}:${s.sheet}:${s.row}`;
    const qty=decimal(fields.quantity);
    if(item.amountBasis==="line"&&qty!==null&&Number.isSafeInteger(fields.unitPriceMinor)&&Number.isSafeInteger(item.amountMinor)&&fields.priceBasis==="WITH_VAT"){
      const numerator=qty*BigInt(fields.unitPriceMinor);
      if(numerator%1000000n===0n&&numerator/1000000n!==BigInt(item.amountMinor))add(`${key}:line`,"LINE_ARITHMETIC","discrepancy","medium","Сумма строки не равна количеству, умноженному на цену с НДС.",[s],"Сравнение выполняется только при явно заданной цене с НДС и точном результате в копейках; правило округления не выдумывается.","Проверьте количество, цену, скидки, единицы измерения и основание суммы.",{quantity:fields.quantity,unitPriceMinor:fields.unitPriceMinor,lineMinor:item.amountMinor});
    }
    const opening=fields.openingMinor,incoming=fields.incomingMinor,outgoing=fields.outgoingMinor,closing=fields.closingMinor;
    if([opening,incoming,outgoing,closing].every(Number.isSafeInteger)&&opening+incoming-outgoing!==closing)add(`${key}:balance`,"BALANCE_ROLLFORWARD","discrepancy","medium","Начальный остаток и движения не согласуются с конечным остатком.",[s],"Начальный остаток + поступления − выбытия сравниваются с конечным остатком. Не применяется к неоднозначным дебетовым/кредитовым сальдо.","Сверьте полноту периода, знак остатков и пропущенные движения.",{openingMinor:opening,incomingMinor:incoming,outgoingMinor:outgoing,closingMinor:closing});
    const stock=[fields.openingQuantity,fields.receivedQuantity,fields.issuedQuantity,fields.closingQuantity].map(decimal);
    if(stock.every(v=>v!==null)&&fields.unit&&stock[0]+stock[1]-stock[2]!==stock[3])add(`${key}:stock`,"INVENTORY_ROLLFORWARD","discrepancy","medium","Количество по инвентаризации не согласуется с начальным остатком и движениями.",[s],"Остаток + поступление − выбытие сравниваются в одной строке и единице измерения, без преобразования разных единиц.","Сверьте единицы, возвраты, списания и полноту движений.",{unit:fields.unit,opening:fields.openingQuantity,received:fields.receivedQuantity,issued:fields.issuedQuantity,closing:fields.closingQuantity});
    if(fields.periodFrom&&fields.periodTo&&fields.periodFrom>fields.periodTo)add(`${key}:period`,"INVALID_DOCUMENT_PERIOD","discrepancy","medium","Начало периода документа позже его окончания.",[s],"Сравнение явно извлечённых границ периода.","Проверьте даты в источнике и настройку столбцов.");
    if(fields.monthlyEnergy&&fields.billingDate&&Number.isInteger(fields.divisorDays)){
      const date=new Date(`${fields.billingDate}T00:00:00Z`),days=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,0)).getUTCDate();
      if(days!==fields.divisorDays)add(`${key}:days`,"PERIOD_DAYS_DIFFERENCE","signal","medium","Число дней в формуле отличается от календарного месяца оборота.",[s],"Сопоставлены явная дата оборота и делитель формулы. Расчётный период по договору может отличаться от календарного месяца.","Уточните период потребления и договорный порядок расчёта; не исправляйте делитель автоматически.",{formulaDays:fields.divisorDays,calendarDays:days,period:fields.billingDate});
    }
    if(item.groupId==="tax"&&fields.taxBasis==="ESF_NET"&&fields.periodFrom&&fields.periodTo&&Number.isSafeInteger(fields.taxBaseMinor)&&item.senderId&&item.currency!=="UNKNOWN"){
      const scoped=items.filter(r=>r.type==="invoice"&&r.senderId===item.senderId&&r.currency===item.currency&&r.date>=fields.periodFrom&&r.date<=fields.periodTo&&Number.isSafeInteger(r.attributes?.taxBaseMinor)&&r.operation&&live(r.operation));
      const unique=new Map(scoped.map(r=>[r.operation.id,r]));
      if(unique.size){const total=[...unique.values()].reduce((a,r)=>a+r.attributes.taxBaseMinor,0);
        if(Number.isSafeInteger(total)&&total!==fields.taxBaseMinor)add(`${key}:tax`,"DECLARATION_ESF_NET_DIFFERENCE","discrepancy","medium","Заявленный оборот без НДС отличается от ЭСФ за тот же период.",[s,...[...unique.values()].map(source)],"Сверка разрешена только при явно указанной базе ESF_NET, одной валюте и границах периода. Это не автоматический расчёт налогового обязательства.","Проверьте состав оборота, корректировки, дополнительные декларации и метод признания.",{declarationMinor:fields.taxBaseMinor,esfNetMinor:total,currency:item.currency,periodFrom:fields.periodFrom,periodTo:fields.periodTo});}
    }
    if(item.groupId==="reimbursement"&&item.operation){
      const reference=fields.paymentRef||item.reference;
      const candidates=operations.filter(o=>o.type==="payment"&&live(o)&&reference&&norm(o.number)===norm(reference)&&o.senderId===item.senderId&&o.recipientId===item.recipientId&&o.currency===item.currency&&o.amount===item.amountMinor&&item.currency!=="UNKNOWN");
      if(candidates.length!==1)add(`${key}:refund`,"REFUND_NOT_VERIFIED","data_quality","info","Подтверждение возврата не сопоставлено с единственной банковской операцией.",[s],"Проверены номер, стороны, валюта и сумма только в загруженных платежах. Акт возврата имущества не доказывает денежный перевод.","Добавьте банковское подтверждение или отдельно зафиксируйте передачу имущества и её оценку.");
    }
  }
  const primaryByContractItem=new Map();
  for(const item of items){const a=item.attributes||{};if(!item.contractRef||!a.itemCode||!a.unit||!item.operation||!live(item.operation))continue;
    const key=`${pair(item)}:${norm(item.contractRef)}:${a.itemCode}:${a.unit}`;
    if(!primaryByContractItem.has(key))primaryByContractItem.set(key,[]);primaryByContractItem.get(key).push(item);}
  for(const [key,list] of primaryByContractItem){const invoices=list.filter(i=>i.type==="invoice"),primary=list.filter(i=>i.type==="primary");
    if(invoices.length===1&&primary.length===1&&decimal(invoices[0].attributes.quantity)!==null&&decimal(primary[0].attributes.quantity)!==null&&decimal(invoices[0].attributes.quantity)!==decimal(primary[0].attributes.quantity))add(`${key}:quantity`,"PRIMARY_INVOICE_QUANTITY","discrepancy","medium","В ЭСФ и документе исполнения различается количество одной позиции.",list.map(source),"Совпали ссылка на договор, стороны, код позиции и единица. Проверяется только однозначная пара; частичные поставки могут объяснить разницу.","Проверьте частичные поставки, возвраты и состав комплекта.");}
  const payments=operations.filter(o=>o.type==="payment"&&bankEntryKind(o)!=="refund"&&live(o)&&o.currency!=="UNKNOWN"&&o.amount>0);
  const paymentIndex=new Map();for(const p of payments){const key=`${p.senderId}:${p.amount}:${p.currency}`;if(!paymentIndex.has(key))paymentIndex.set(key,[]);paymentIndex.get(key).push(p);}
  if(payments.length>5000)add("pattern-limit","PATTERN_CHECK_REQUIRES_SCOPE","data_quality","info","Для проверки транзитных цепочек требуется сузить набор платежей.",[],"В этой версии шаблонная проверка цепочек ограничена 5000 платежами. Граф и сохранённые операции этим лимитом не ограничиваются.","Выделите исследуемый период/эпизод и выполняйте проверку на целевом наборе.");
  let comparisons=0,patternResults=0,limited=false;
  patternSearch: for(const first of payments.length<=5000?payments:[])for(const next of paymentIndex.get(`${first.recipientId}:${first.amount}:${first.currency}`)||[]){
    if(++comparisons>100000||patternResults>=2000){limited=true;break patternSearch;}
    const diff=Date.parse(next.date)-Date.parse(first.date);
    if(first.id===next.id||diff<0||diff>86400000||first.senderId===next.recipientId)continue;
    // This is a pattern, never an attribution of the same money.
    add(`transit:${first.id}:${next.id}`,"RAPID_EQUAL_AMOUNT_TRANSFERS","signal","medium","Последовательные переводы одной суммы через общего участника в пределах суток.",[...first.sources,...next.sources],"Порог: одинаковая сумма и валюта, общий промежуточный участник, даты в пределах 24 часов. При точности даты до дня время суток неизвестно.","Проверьте назначение, договоры и остаток счёта; совпадение не доказывает движение тех же средств.",{amountMinor:first.amount,currency:first.currency,windowHours:24});
    patternResults++;
    for(const last of paymentIndex.get(`${next.recipientId}:${first.amount}:${first.currency}`)||[]){
      if(++comparisons>100000||patternResults>=2000){limited=true;break patternSearch;}
      if(last.recipientId===first.senderId&&new Set([first.id,next.id,last.id]).size===3&&Date.parse(last.date)>=Date.parse(next.date)&&Date.parse(last.date)-Date.parse(first.date)<=3*86400000){add(`cycle:${digest([first.id,next.id,last.id].sort())}`,"CIRCULAR_THREE_PARTY_PAYMENTS","signal","medium","Три перевода одной суммы образуют замкнутую цепочку участников.",[...first.sources,...next.sources,...last.sources],"Три разных платежа, одна валюта и сумма, возврат к первому участнику за три дня. Это структура связей, не доказанная незаконная схема.","Проверьте экономические основания всех трёх платежей.");patternResults++;}}
  }
  if(limited)add("pattern-comparison-limit","PATTERN_CHECK_PARTIAL","data_quality","info","Шаблонная проверка переводов выполнена частично: достигнут защитный предел.",[],"Предел — 100 000 сравнений или 2 000 найденных комбинаций. Все операции сохранены; отсутствие сигнала не означает завершённую проверку остальных комбинаций.","Разделите исследование на отдельные периоды или эпизоды.",{comparisons,patternResults});
  for(const document of documents){const summary=document.summary||{};
    if(summary.pageAudit?.qualityPages?.length)add(`pdf-quality:${document.id}`,"PDF_LOW_SOURCE_QUALITY","data_quality","medium",`Качество скана/OCR «${document.name}» требует особой проверки: ${summary.pageAudit.qualityPages.length} страниц.`,[{documentId:document.id,name:document.name}],"Эвристика: исходные растровые изображения меньше 1800 пикселей по большей стороне, мало распознанного текста либо средняя диагностическая оценка слов Tesseract ниже 60. Это не оценка достоверности документа и не вероятность правильности реквизитов.","Проверьте указанные страницы и цифры по оригиналу. При возможности получите более качественный скан.",{pages:summary.pageAudit.qualityPages});
    if(summary.pageAudit?.pagesWithoutText?.length)add(`pdf-coverage:${document.id}`,"PDF_PAGES_WITHOUT_TEXT","data_quality","info",`В «${document.name}» нет извлекаемого текста на ${summary.pageAudit.pagesWithoutText.length} из ${summary.pageAudit.totalPages} страниц.`,[{documentId:document.id,name:document.name}],"Некоторые страницы могут быть сканами, пустыми или содержать графику. Сохранение оригинала не означает полное распознавание содержимого; результаты OCR и ошибки показаны отдельно.","Откройте перечисленные страницы и ошибки OCR. Для содержательных сканов нужна сверка; составной пакет нужно разделить по документам.",{totalPages:summary.pageAudit.totalPages,pagesWithText:summary.pageAudit.pagesWithText,pagesWithoutText:summary.pageAudit.pagesWithoutText,ocrPerformed:summary.pageAudit.ocrPerformed===true});
    const unresolved=summary.documentAnalysis?.unresolved??(summary.documentAnalysis?summary.documentAnalysis.total-summary.documentAnalysis.reviewed:0);
    if(unresolved)add(`pdf-review:${document.id}`,"PDF_SEGMENTS_REQUIRE_REVIEW","data_quality","info",`В «${document.name}» недостаточно однозначных реквизитов для ${unresolved} фрагментов.`,[{documentId:document.id,name:document.name}],"Полные однозначные реквизиты автоматически участвуют в предварительной аналитике. Неизвестные стороны, суммы и даты не угадываются; причины показаны по страницам.","Используйте исходную электронную выгрузку или более качественный скан. Отсутствие извлечённой операции не доказывает отсутствия самой операции.");
    if(summary.documentProfile?.requiresFactReview)add(`facts-review:${document.id}`,"DOCUMENT_FACT_REVIEW_REQUIRED","data_quality","info",`Проверьте реквизиты и назначение «${document.name}».`,[{documentId:document.id,name:document.name}],summary.documentProfile.note,"Сверьте оригинал. Распознавание вида документа не подтверждает его суммы, период, фактический доход или ущерб.");
    if(summary.formulaAudit?.periodMismatchCount){const entries=summary.formulaAudit.periodMismatches||[];
      add(`formula-period:${document.id}`,"WORKBOOK_PERIOD_DAYS_DIFFERENCE","signal","medium",`Делитель в формулах энергопотребления отличается от календарного месяца: ${summary.formulaAudit.periodMismatchCount} ячеек.`,entries.map(e=>({documentId:document.id,name:document.name,sheet:e.sheet,row:e.row})),"Проверяются только прямые формулы количества / 24 / число дней и явная дата оборота в таблице энергопотребления. Расчётный период может отличаться от календарного месяца.","Проверьте период потребления по договору и источнику; не исправляйте формулы автоматически.",{count:summary.formulaAudit.periodMismatchCount,cells:entries});
    }
    if(["review","unclassified"].includes(summary.classificationStatus))add(`classification:${document.id}`,"DOCUMENT_CLASSIFICATION_REQUIRED","data_quality","info",`Для «${document.name}» не подтверждён вид документа.`,[{documentId:document.id,name:document.name}],"Признаки вида недостаточны или противоречат друг другу. До распределения строки не превращаются в операции.","Откройте оригинал и выберите группу и вид в разделе «Документы».");
    if(summary.formulaAudit?.errorCount)add(`formula:${document.id}`,"WORKBOOK_FORMULA_ERRORS","data_quality","medium",`В сохранённых результатах Excel есть ошибки: ${summary.formulaAudit.errorCount}.`,[{documentId:document.id,name:document.name}],"Читаются ошибки, сохранённые в файле, без исполнения формул. Наличие ошибки во вспомогательной ячейке не доказывает ошибочность всех итогов.","Откройте список ячеек, проследите зависимости и исправьте источник после проверки.",{errorCount:summary.formulaAudit.errorCount,errors:summary.formulaAudit.errors});
    if(["failed","running","uploaded","review"].includes(document.status)&&!(document.status==="review"&&summary.contextOnly)){
      const d=readingDiagnostic(document);
      if(d)add(`incomplete:${document.id}`,"DOCUMENT_PROCESSING_INCOMPLETE","data_quality","info",d.title,d.evidence,d.rule,d.nextAction,{readingDiagnostic:d});
    }
  }
  return {risks:[...new Map(risks.map(r=>[r.key,r])).values()],links,chains,ruleVersion:RULE_VERSION};
}
