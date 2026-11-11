import {createHash} from 'node:crypto';
import {bankFlowAnalysis,bankFlowSignals} from './financial-flows.mjs';
import {markDirectedCycles} from './directed-cycles.mjs';
import {incompleteBankObservations} from './bank-observations.mjs';
import {isPartyKey,validIban,bankPaymentClass} from './bank-identities.mjs';
import {resolveGraphMode,graphCoverage} from './graph-coverage.mjs';
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0,24);
const refs=a=>[...new Map(a.map(s=>[[s.documentId,s.sheet,s.row].join(':'),s])).values()];
// Documentary arrows and temporal hypotheses are never the same edge type.
export function buildFinancialGraph(report,q={}){
  const mode=resolveGraphMode(report,q.graphMode),nodes=new Map(),edges=new Map(),ownerClaims=new Map(),moneyMode=mode==='money'||mode==='combined',relations=mode==='relations'||mode==='combined'||mode==='reconciliation';
  const node=(id,label,type)=>{if(id&&!nodes.has(id))nodes.set(id,{id,label:label||id,type});return id;};
  const org=(id,name)=>id?node('party:'+id,`${name||id}\n${id}`,'party'):'';
  const acct=a=>a?node('account:'+a,a,'account'):'';
  const edge=(from,to,type,currency,amount,sources=[],detail=null)=>{if(!from||!to)return;const id=hash([from,to,type,currency]);if(!edges.has(id))edges.set(id,{id,from,to,type,currency,amountMinor:null,count:0,sources:[],operations:[],certainty:['settlement_candidate','onward_hypothesis'].includes(type)?'hypothesis':type==='settlement_confirmed'?'employee_confirmed':'documented'});const e=edges.get(id);if(amount!==null&&amount!==undefined)e.amountMinor=(BigInt(e.amountMinor||0)+BigInt(amount)).toString();e.count++;e.sources.push(...sources);if(detail)e.operations.push(detail);};
  const filtered=report.bank.filter(e=>(!q.min||e.amountMinor!==null&&BigInt(e.amountMinor)>=BigInt(q.min))&&(!q.max||e.amountMinor!==null&&BigInt(e.amountMinor)<=BigInt(q.max))&&(!q.bankKind||e.kind===q.bankKind)),flow=bankFlowAnalysis(filtered,q),analysis=bankFlowSignals(flow,q);
  for(const e of report.bank)if(e.ownerAccount&&e.ownerId){if(!ownerClaims.has(e.ownerAccount))ownerClaims.set(e.ownerAccount,new Set());ownerClaims.get(e.ownerAccount).add(e.ownerId);}
  if(moneyMode)for(const e of flow.transfers){
    const from=e.senderAccount?acct(e.senderAccount):org(e.senderId,e.senderName),to=e.recipientAccount?acct(e.recipientAccount):org(e.recipientId,e.recipientName);
    for(const [id,name,a] of [[e.senderId,e.senderName,e.senderAccount],[e.recipientId,e.recipientName,e.recipientAccount]])if(a&&id){const claim=ownerClaims.get(a);if(claim?.size===1&&claim.has(id))edge(org(id,name),acct(a),'account_ownership','',null,e.sources);else if(!claim)edge(org(id,name),acct(a),'account_party_reference','',null,e.sources);}
    edge(from,to,'bank_transfer',e.currency,e.amountMinor,e.sources,{...e,number:e.transactionId,identityBasis:e.identityBasis});
  }
  const observations=moneyMode?incompleteBankObservations(filtered,q):[];
  const conversions=moneyMode?filtered.filter(e=>bankPaymentClass(e)==='conversion'&&!e.conflict&&e.dateValid&&isPartyKey(e.ownerId)&&validIban(e.ownerAccount)&&['incoming','outgoing'].includes(e.direction)&&e.currency&&e.currency!=='UNKNOWN'&&/^\d+$/.test(String(e.amountMinor??''))):[];
  for(const e of conversions){
    const owner=acct(e.ownerAccount),side=e.direction==='outgoing'?'recipient':'sender',otherAccount=validIban(e[side+'Account']),otherId=e[side+'Id'];
    let other='';
    if(otherAccount&&otherAccount!==e.ownerAccount){other=acct(otherAccount);if(isPartyKey(otherId))edge(org(otherId,e[side+'Name']),other,'account_party_reference','',null,e.sources);}
    else if(isPartyKey(otherId)&&otherId!==e.ownerId)other=org(otherId,e[side+'Name']);
    else other=node('conversion:'+hash([e.ownerAccount,e.direction,e.currency]),`Конвертация: ${e.direction==='incoming'?'зачисления':'списания'} (${e.currency})`,'conversion');
    edge(org(e.ownerId,e.ownerName),owner,'account_ownership','',null,e.sources);
    edge(e.direction==='outgoing'?owner:other,e.direction==='outgoing'?other:owner,'bank_conversion_leg',e.currency,e.amountMinor,e.sources,{...e,explanation:'Документированное движение по счёту при конвертации. Не внешний расчёт и не оплата ЭСФ. Совпадение сумм не устанавливает парность конверсионных записей.'});
  }
  for(const e of observations){
    const endpoint=side=>{
      if(validIban(e[side+'Account']))return acct(validIban(e[side+'Account']));
      if(isPartyKey(e[side+'Id']))return org(e[side+'Id'],e[side+'Name']);
      const isCounterparty=e.direction==='outgoing'&&side==='recipient'||e.direction==='incoming'&&side==='sender';
      if(isCounterparty&&/^\d{20}$/.test(e.counterpartyAccountToken||''))return node('source-account:'+hash([e.sources[0]?.documentId,e.counterpartyAccountToken]),`Счёт из исходной ячейки: ${e.counterpartyAccountToken}\nНе IBAN; владелец не установлен`,'source_account');
      return node(`unidentified:${e.id}:${side}`,`${side==='sender'?'Отправитель':'Получатель'} не установлен\n${e.unresolvedCounterpartyName||e[side+'Name']||'Реквизиты в исходной строке'}`,'unidentified_party');
    };
    const detail={...e,number:e.transactionId,observationOnly:true,explanation:'Запись выписки с неполными реквизитами. Не включена в полные переводы, хронологические сигналы или сверку оплат. Неизвестный год и отсутствующие идентификаторы не подставляются.'};
    // One separate source-record edge; never a summed confirmed flow.
    const record=node(`incomplete-bank:${e.id}`,`Строка выписки ${e.transactionId||''}\n${e.dateValid?e.date:e.rawDate||'Дата не установлена'}`,'bank_record');
    edge(endpoint('sender'),record,'bank_record_partial',e.currency,e.amountMinor,e.sources,detail);
    edge(record,endpoint('recipient'),'bank_record_party','',null,e.sources,detail);
  }
  const invoiceById=new Map(report.invoices.map(i=>[i.id,i])),contractNodes=new Map();
  if(relations)for(const d of report.documentRelations||[]){const a=org(d.senderId,d.senderName),b=org(d.recipientId,d.recipientName),contract=d.type==='contract',id=node((contract?'contract-operation:':'primary:')+d.id,`${contract?'Договор':'Первичный документ'} ${d.number}\n${d.date}`,contract?'contract':'primary');edge(a,id,contract?'documented_contract':'document_primary',d.currency,d.amountMinor,d.sources,{id:d.id,number:d.number,date:d.date,amountMinor:d.amountMinor,purpose:d.purpose});edge(id,b,'document_party',d.currency,null,d.sources);if(contract){const key=JSON.stringify([d.senderId,d.recipientId,d.number]);if(!contractNodes.has(key))contractNodes.set(key,[]);contractNodes.get(key).push(id);}}
  if(relations)for(const i of report.invoices){
    const seller=org(i.senderId,i.senderName),buyer=org(i.recipientId,i.recipientName),amount=Object.hasOwn(i,'graphAmountMinor')?i.graphAmountMinor:i.amountMinor;
    edge(seller,buyer,'document_supply',i.currency,amount,i.sources,{id:i.id,number:i.number,date:i.date,amountMinor:amount,purpose:`${i.graphLabel||'ЭСФ'} ${i.number}`,goods:(i.lines||[]).map(l=>l.name)});
    const id=node('invoice:'+i.id,`ЭСФ ${i.number}\n${i.date}`,'invoice');edge(seller,id,'supply_document',i.currency,null,i.sources);edge(id,buyer,'supply_document',i.currency,null,i.sources);
    for(const reference of String(i.contractRef||'').split(';').map(s=>s.trim()).filter(Boolean)){const found=contractNodes.get(JSON.stringify([i.senderId,i.recipientId,reference])),c=found?.length===1?found[0]:node('contract:'+hash([i.senderId,i.recipientId,reference]),`Ссылка на договор ${reference}\nОригинал однозначно не выделен`,'contract');edge(seller,c,'contract_reference','',null,i.sources);edge(c,id,'contract_invoice','',null,i.sources);}
  }
  if(mode==='combined'||mode==='reconciliation'){
    const payments=new Map([...report.reconciliation.payments,...(report.reconciliation.linkedPayments||[])].map(p=>[p.id,p]));
    const connectedPayments=new Set(),bankOperations=new Set(report.bank.map(e=>e.operationId)),filteredByOperation=new Map();
    for(const e of filtered){if(!filteredByOperation.has(e.operationId))filteredByOperation.set(e.operationId,[]);filteredByOperation.get(e.operationId).push(e);}
    for(const a of [...report.reconciliation.allocations,...report.reconciliation.candidates]){
      const i=invoiceById.get(a.invoiceId),p=payments.get(a.paymentId);if(!i||!p)continue;
      const entries=filteredByOperation.get(p.id)||[];
      if(bankOperations.has(p.id)&&!entries.length)continue;
      const id=node('payment:'+p.id,`Платёж ${p.number}\n${p.date}`,'payment');
      edge('invoice:'+i.id,id,a.confirmed?'settlement_confirmed':'settlement_candidate',p.currency,a.amountMinor,[...i.sources,...p.sources],{...a,date:p.date,purpose:p.purpose});
      if(!connectedPayments.has(p.id)){
        connectedPayments.add(p.id);
        const entry=entries[0],from=entry?.senderAccount?acct(entry.senderAccount):org(p.senderId,p.senderName),to=entry?.recipientAccount?acct(entry.recipientAccount):org(p.recipientId,p.recipientName);
        edge(from,id,'bank_payment_record','',null,p.sources,{id:p.id,date:p.date,purpose:p.purpose,explanation:'Реквизиты платежа; сумма учтена на стрелке банковского перевода, а не повторно здесь.'});
        edge(id,to,'bank_payment_record','',null,p.sources);
      }
    }
  }
  if(moneyMode&&q.showHypotheses==='1')for(const s of analysis.signals.filter(s=>['onward_candidate','return_cycle'].includes(s.type))){
    const ids=s.entries.map(e=>{const id=node('event:'+e.id,`Перевод ${e.transactionId||e.date}\n${e.amountMinor} минимальных единиц ${e.currency}`,'bank_event');edge(e.senderAccount?acct(e.senderAccount):org(e.senderId,e.senderName),id,'bank_observation','',null,e.sources);edge(id,e.recipientAccount?acct(e.recipientAccount):org(e.recipientId,e.recipientName),'bank_observation','',null,e.sources);return id;});edge(ids[0],ids[1],'onward_hypothesis',s.calculation.currency,null,s.sources,{...s,date:s.entries[0].date,purpose:s.title,explanation:s.explanation});
  }
  let resultEdges=[...edges.values()].map(e=>({...e,sources:refs(e.sources)}));const focus=Object.hasOwn(q,'focus')?q.focus:q.identifier;
  if(focus){const roots=new Set([focus,'party:'+focus,'account:'+focus].filter(id=>nodes.has(id))),adj=new Map(),association=new Map();for(const e of resultEdges){for(const [a,b] of [[e.from,e.to],[e.to,e.from]]){if(!adj.has(a))adj.set(a,[]);adj.get(a).push(b);if(['account_ownership','account_party_reference'].includes(e.type)){if(!association.has(a))association.set(a,[]);association.get(a).push(b);}}}const visited=new Set(roots),closure=ids=>{const all=[...ids];for(let n=0;n<all.length;n++)for(const other of association.get(all[n])||[])if(!visited.has(other)){visited.add(other);all.push(other);}return all;};let frontier=closure(roots);const depth=Math.max(1,Math.min(6,Number(q.depth)||3));for(let n=0;n<depth;n++){const next=[];for(const id of frontier)for(const other of adj.get(id)||[])if(!visited.has(other)){visited.add(other);next.push(other);}frontier=closure(next);}resultEdges=resultEdges.filter(e=>visited.has(e.from)&&visited.has(e.to));}
  const cyclic=new Set();for(const currency of new Set(resultEdges.filter(e=>e.type==='bank_transfer').map(e=>e.currency)))for(const e of markDirectedCycles(resultEdges.filter(e=>e.type==='bank_transfer'&&e.currency===currency)))if(e.cycle)cyclic.add(e.id);
  resultEdges=resultEdges.map(e=>({...e,cycle:cyclic.has(e.id)}));const totalEdges=resultEdges.length,truncatedGraph=totalEdges>2000;resultEdges=resultEdges.slice(0,2000);const used=new Set(resultEdges.flatMap(e=>[e.from,e.to])),visible=new Set(resultEdges.filter(e=>e.type==='bank_transfer').flatMap(e=>e.operations.map(o=>o.id)));
  const info=report.bankDiagnostics||{},diagnostics=[];
  if(conversions.length)diagnostics.push(`Конверсионных записей: ${conversions.length}. На схеме они выделены отдельно от переводов контрагентам; списания и зачисления не объединяются в одну сделку по равенству сумм.`);
  if(observations.length)diagnostics.push(`Неполных записей выписок на схеме: ${observations.length}. Это отдельные исходные строки, не полные переводы: дата или участник не установлены. Суммы не включены в подтверждённый поток, сверку и хронологические выводы. При фильтре периода такие строки не отображаются.`);
  if(moneyMode&&!resultEdges.some(e=>e.type==='bank_transfer')){
    if(!info.sourceRows&&!report.bank.length)diagnostics.push('В выбранном деле не найдены извлечённые банковские строки. Загрузите выписку или проверьте выбранное дело.');
    if(info.missingOwners)diagnostics.push(`Не установлен владелец счёта: строк ${info.missingOwners}. Проверьте шапку и реквизиты банковской выписки.`);
    if(info.missingParties)diagnostics.push(`Не установлены обе стороны: строк ${info.missingParties}. Неполные записи сохранены, но подтверждённые связи не выдумываются.`);
    if(info.missingDates)diagnostics.push(`Не распознана дата: строк ${info.missingDates}. Для ДД.ММ.ГГ подтвердите год периода.`);
    if(info.missingCurrency)diagnostics.push(`Не установлена валюта: строк ${info.missingCurrency}.`);
    if(info.filtersActive||focus||q.min||q.max||q.bankKind)diagnostics.push('Проверьте фильтры организации, счёта, периода, валюты, суммы и вида операции; они могут исключать имеющиеся переводы.');
    if(info.legacyRows)diagnostics.push('Есть банковские строки прежней версии обработки. Откройте документ и предварительно проверьте результат повторного анализа; автоматический повторный импорт не выполняется.');
    if(!diagnostics.length)diagnostics.push('В этой выборке нет переводов с известными датой, суммой, валютой и обеими сторонами. Комиссии и неполные записи доступны в банковской аналитике.');
  }
  if(!resultEdges.length&&!moneyMode)diagnostics.push('В выбранном виде и фильтрах нет пригодных документальных связей. Банковские переводы доступны отдельно в виде «Движение денег», без обязательного наличия ЭСФ.');
return {coverage:graphCoverage(report),documents:report.documents||[],diagnostics,nodes:[...nodes.values()].filter(n=>used.has(n.id)),edges:resultEdges,signals:moneyMode?analysis.signals.filter(s=>s.entries.every(e=>visible.has(e.id))):[],truncatedSignals:analysis.truncated,truncatedGraph,totalEdges,graphMode:mode,flowCriteria:analysis.criteria,legend:{bank_payment_record:'Платёж и его стороны — сумма не учитывается повторно',source_account:'Счёт из источника — владелец не установлен',bank_conversion_leg:'Движение по счёту при конвертации',conversion:'Конверсия валюты — отдельное направление',bank_record_partial:'Неполная запись выписки — не установленная операция',bank_record_party:'Сторона неполной записи',bank_record:'Исходная строка выписки',unidentified_party:'Участник не установлен',account_ownership:'Счёт владельца по выписке',account_party_reference:'Счёт указан у стороны в выписке',bank_observation:'Реквизиты банковского наблюдения',supply_document:'ЭСФ и сторона поставки',contract_reference:'Номер договора в ЭСФ',contract_invoice:'Договор — ЭСФ',documented_contract:'Договор по документу',document_primary:'Первичный документ',document_party:'Сторона документа',party:'Участник',account:'Банковский счёт',contract:'Договор / ссылка на договор',invoice:'ЭСФ',payment:'Платёж',bank_event:'Банковское наблюдение',primary:'Первичный документ',bank_transfer:'Банковский перевод по документам',document_supply:'Поставка по ЭСФ, не банковский платёж',settlement_candidate:'Предложение, не оплаченная сумма',settlement_confirmed:'Распределение подтверждено сотрудником',onward_hypothesis:'Гипотеза; идентичность средств не установлена'},methodology:'Банковские переводы, поставки, решения об оплате и гипотезы имеют отдельные типы. Встречные записи объединяются только по явному банковскому ID, двум проверенным IBAN, сторонам, дате, валюте, виду и сумме. Направленные циклы проверяются отдельно в каждой валюте, без зависимости от расположения узлов. Глубина раскрывает только загруженные сведения; отсутствующие выписки не достраиваются. Пунктирная последовательность не доказывает идентичность денег.'};
}
