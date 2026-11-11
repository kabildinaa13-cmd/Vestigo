import { createHash, randomUUID } from 'node:crypto';
import { financialReport, migrateFinancial, normalizeCategory, FinancialError } from './financial-profile.mjs';
import { getCase, DEFAULT_DEPARTMENT_ID, DEFAULT_USER_ID } from './vestigo-db.mjs';
import { currentUserId } from './request-identity.mjs';
import { buildFinancialGraph } from './financial-graph.mjs';
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const unique = a => [...new Set(a.filter(v => v !== null && v !== undefined && v !== ''))];
const srcKey = s => JSON.stringify([s.documentId, s.sheet, s.row]);
const sources = a => [...new Map(a.map(s => [srcKey(s), s])).values()];
const sum = a => a.reduce((n, v) => n + BigInt(v ?? 0), 0n).toString();
const completeSum = a => a.some(v=>v===null||v===undefined)?null:sum(a);
const norm = normalizeCategory;
const qnumber = s => { const v = String(s ?? '').replace(/[\s\u00a0]/g, '').replace(',', '.'); if (!/^-?\d+(\.\d{1,6})?$/.test(v))
    return null; const [a, b = ''] = v.replace('-', '').split('.'); return (BigInt(a) * 1000000n + BigInt(b.padEnd(6, '0'))) * (v.startsWith('-') ? -1n : 1n); };
const quantity = n => { const a = n < 0n ? -n : n; return `${n < 0n ? '-' : ''}${a / 1000000n}.${String(a % 1000000n).padStart(6, '0')}`.replace(/\.?0+$/, ''); };
const rounded = (n, d) => { if (d <= 0n)
    return null; const sign = n < 0n ? -1n : 1n, a = n < 0n ? -n : n; return (sign * ((a + d / 2n) / d)).toString(); };
export function migrateGoods(db) { migrateFinancial(db); db.exec(`CREATE TABLE IF NOT EXISTS case_goods_group_decisions(case_id TEXT NOT NULL REFERENCES cases(id),decision_key TEXT NOT NULL,status TEXT NOT NULL,category TEXT NOT NULL,terms_json TEXT NOT NULL,previous_json TEXT NOT NULL,note TEXT NOT NULL,updated_by TEXT NOT NULL REFERENCES users(id),updated_at TEXT NOT NULL,PRIMARY KEY(case_id,decision_key));`); }
const rules = [
    { id: 'road-freight', category: 'Транспортные услуги: перевозка грузов', test: t => /(?:услуг|перевоз|транспортиров|грузоперевоз)/u.test(t) && /груз/u.test(t) && !/пассажир|аренд|ремонт|запчаст|топлив|страхов|железнодорож|авиа|морск|продаж/u.test(t) && (/перевоз.*груз|транспортиров.*груз|грузоперевоз/u.test(t)), basis: 'Одновременно указаны перевозка/транспортировка и груз. Аренда, ремонт, топливо, пассажирские и другие виды перевозок исключены.' },
    { id: 'office-rental', category: 'Аренда помещений', test: t => /аренд|наем/u.test(t) && /помещен|офис/u.test(t) && !/ремонт|оборудован|автомоб|земельн|субаренд/u.test(t), basis: 'Есть признаки аренды и помещения/офиса. Оборудование, автомобили, земля и ремонт не объединяются с арендой помещений.' },
    { id: 'accounting-service', category: 'Бухгалтерское обслуживание', test: t => /бухгалтерск/u.test(t) && /обслуживан|ведени.*учет|услуг/u.test(t) && !/программ|лиценз|обучен|аудит|консультац/u.test(t), basis: 'Бухгалтерский учёт/обслуживание; лицензии, обучение, аудит и консультации исключены.' }
];
export function groupingProposals(lines, decisions = []) { const terms = [...new Map(lines.map(l => [l.term, { term: l.term, name: l.name, category: l.category }])).values()]; return rules.flatMap(rule => { const items = terms.filter(l => rule.test(l.term)); if (items.length < 2)
    return []; const key = hash([rule.id, items.map(i => i.term).sort()]), decision = decisions.find(d => d.decision_key === key); return [{ key, category: decision?.category || rule.category, basis: rule.basis, terms: items, status: decision?.status || 'pending', note: decision?.note || '', rule: rule.id, version: 'goods-group-rules-1.0' }]; }); }
function totals(lines, identifier) { const result = { supply: {}, purchase: {}, sale: {}, vat: {}, purchaseVat: {}, saleVat: {} }; for (const l of lines)
    for (const [name, value] of [['supply', l.amountMinor], ['vat', l.vatMinor], ...(identifier && l.recipientId === identifier ? [['purchase', l.amountMinor], ['purchaseVat', l.vatMinor]] : []), ...(identifier && l.senderId === identifier ? [['sale', l.amountMinor], ['saleVat', l.vatMinor]] : [])])
        if (value !== null && value !== undefined)
            result[name][l.currency] = (BigInt(result[name][l.currency] || 0) + BigInt(value)).toString(); return result; }
function priceGroups(lines) {
    const groups=new Map();
    for(const l of lines){const k=JSON.stringify([l.term,l.unit,l.currency,l.analysisDirection||'document_supply']);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(l);}
    return [...groups.values()].map(items=>{
        const known=items.map(l=>qnumber(l.quantity)).filter(q=>q!==null);
        const priced=items.map(l=>({l,q:qnumber(l.quantity)})).filter(({l,q})=>q!==null&&q>0n&&l.unit&&l.unitPriceWithoutVatMinor!==null&&l.unitPriceWithoutVatMinor!==undefined);
        const qs=priced.reduce((n,x)=>n+x.q,0n),p=priced.reduce((n,x)=>n+x.q*BigInt(x.l.unitPriceWithoutVatMinor),0n);
        return {name:items[0].name,term:items[0].term,unit:items[0].unit,currency:items[0].currency,direction:items[0].analysisDirection||'document_supply',quantity:known.length?quantity(known.reduce((n,q)=>n+q,0n)):null,missingQuantity:items.length-known.length,weightedUnitPriceMinor:rounded(p,qs),priceBasis:'Без НДС; средневзвешенная по количеству, округление до 0,01',pricedRows:priced.length,rows:items.length,sources:sources(items.flatMap(l=>l.sources)),items};
    });
}
function categoryGroups(lines, q) { const groups = new Map(); for (const l of lines) {
    const key = JSON.stringify([l.category, l.currency]);
    if (!groups.has(key))
        groups.set(key, []);
    groups.get(key).push(l);
} return [...groups.values()].map(items => { const prices = priceGroups(items), ids = unique(items.map(l => l.invoiceId)), dates = items.map(l => l.date).filter(Boolean).sort(); return { key: hash([items[0].category, items[0].currency]), name: items[0].category, currency: items[0].currency, originalNames: unique(items.map(l => l.name)), rows: items.length, invoices: ids.length, incomingInvoices: q.identifier ? unique(items.filter(l => l.recipientId === q.identifier).map(l => l.invoiceId)).length : null, outgoingInvoices: q.identifier ? unique(items.filter(l => l.senderId === q.identifier).map(l => l.invoiceId)).length : null, ...Object.fromEntries(Object.entries(totals(items, q.identifier)).map(([k, v]) => [k + 'Minor', v[items[0].currency] ?? null])), suppliers: unique(items.map(l => l.senderId)), buyers: unique(items.map(l => l.recipientId)), contractReferences: unique(items.map(l => l.contractRef)), from: dates[0] || null, to: dates.at(-1) || null, missingAmounts: items.filter(l => l.amountMinor === null).length, missingVat: items.filter(l => l.vatMinor === null).length, quantities: prices.map(({ items, ...p }) => p), weightedUnitPriceMinor: prices.length === 1 ? prices[0].weightedUnitPriceMinor : null, comparability: prices.length === 1 ? 'Одинаковые исходное наименование, единица и валюта' : 'Разные наименования или единицы: общая средняя цена не рассчитывается', invoiceIds: ids, sources: sources(items.flatMap(l => l.sources)) }; }); }
function comparisonGroups(lines) { const groups = new Map(); for (const l of lines)
    for (const [identifier, name, direction, counterparty] of [[l.senderId, l.senderName, 'sale', l.recipientId], [l.recipientId, l.recipientName, 'purchase', l.senderId]]) {
        const k = JSON.stringify([identifier, l.category, l.currency]);
        if (!groups.has(k))
            groups.set(k, { identifier, name, category: l.category, currency: l.currency, purchase: [], sale: [] });
        groups.get(k)[direction].push({ ...l, counterparty });
    } return [...groups.values()].map(g => ({ ...g, purchaseMinor: g.purchase.some(l => l.amountMinor !== null) ? sum(g.purchase.map(l => l.amountMinor)) : null, saleMinor: g.sale.some(l => l.amountMinor !== null) ? sum(g.sale.map(l => l.amountMinor)) : null, differenceMinor: g.purchase.length && g.sale.length && g.purchase.every(l => l.amountMinor !== null) && g.sale.every(l => l.amountMinor !== null) ? (BigInt(sum(g.sale.map(l => l.amountMinor))) - BigInt(sum(g.purchase.map(l => l.amountMinor)))).toString() : null, purchaseRows: g.purchase.length, saleRows: g.sale.length, suppliers: unique(g.purchase.map(l => l.counterparty)), buyers: unique(g.sale.map(l => l.counterparty)), sources: sources([...g.purchase, ...g.sale].flatMap(l => l.sources)), interpretation: 'Разница документальных оборотов, не прибыль, не ущерб и не установленная наценка. Связь конкретных приобретённых и реализованных единиц не установлена.' })); }
function signalList(lines, reconciliation, bank, identifier) {
    const signals = [];
    if(identifier)for(const g of priceGroups(lines.map(l=>({...l,analysisDirection:'comparison'})))) {
        const buy=g.items.filter(l=>l.recipientId===identifier),sell=g.items.filter(l=>l.senderId===identifier);
        if(!buy.length||!sell.length||!g.unit)continue;
        const a=priceGroups(buy)[0],b=priceGroups(sell)[0];
        if(a.pricedRows!==buy.length||b.pricedRows!==sell.length||!a.weightedUnitPriceMinor||!b.weightedUnitPriceMinor)continue;
        const x=BigInt(a.weightedUnitPriceMinor),y=BigInt(b.weightedUnitPriceMinor),min=x<y?x:y,max=x>y?x:y;
        if(min<=0n||max*100n<min*150n)continue;
        signals.push({code:'BUY_SELL_PRICE_RANGE',title:'Различие цен приобретения и реализации сопоставимых по реквизитам позиций',calculation:`Средневзвешенная цена приобретения: ${x}; реализации: ${y} минимальных единиц ${g.currency} за ${g.unit}, без НДС. Различие ${(max-min)*10000n/min} б.п. относительно меньшей цены; порог 50%.`,reason:'Совпали исходное нормализованное название, единица и валюта; организация присутствует как покупатель и поставщик. Все использованные строки имеют количество и цену.',limitation:'Одинаковое название не устанавливает идентичность партий, качество или условия сделок. Это сравнение цен, не установленная наценка, прибыль или ущерб.',sources:g.sources});
    }
    for (const g of priceGroups(lines)) {
        const byDirection = identifier ? [g.items.filter(l => l.senderId === identifier), g.items.filter(l => l.recipientId === identifier)] : [g.items];
        for (const items of byDirection) {
            const known = items.filter(l => l.unit && qnumber(l.quantity) > 0n && l.unitPriceWithoutVatMinor !== null && BigInt(l.unitPriceWithoutVatMinor) > 0n);
            if (unique(known.map(l => l.invoiceId)).length < 2)
                continue;
            const values = known.map(l => BigInt(l.unitPriceWithoutVatMinor)), min = values.reduce((a, b) => a < b ? a : b), max = values.reduce((a, b) => a > b ? a : b);
            if (max * 100n >= min * 150n)
                signals.push({ code: 'UNIT_PRICE_RANGE', title: 'Существенное различие цен одинаковых позиций', calculation: `Минимум ${min} и максимум ${max} минимальных денежных единиц за ${g.unit}, без НДС; изменение ${(max - min) * 10000n / min} базисных пунктов (100 б.п. = 1%). Порог 50%.`, reason: 'Совпали нормализованное исходное наименование, единица измерения, валюта и сторона операции выбранной организации.', limitation: 'Не установлены одинаковое качество, условия поставки или идентичность партий. Это не расчёт наценки или ущерба.', sources: sources(known.flatMap(l => l.sources)) });
        }
    }
    const repeated = new Map();
    for (const l of lines) {
        const k = JSON.stringify([l.senderId, l.recipientId, l.term, l.unit, l.quantity, l.amountMinor, l.currency, l.date]);
        if (!repeated.has(k))
            repeated.set(k, []);
        repeated.get(k).push(l);
    }
    for (const g of repeated.values())
        if (unique(g.map(l => l.invoiceId)).length >= 3)
            signals.push({ code: 'REPEATED_SUPPLIES', title: 'Повторяющиеся реквизиты поставок в разных ЭСФ', calculation: `ЭСФ: ${unique(g.map(l => l.invoiceNumber)).join(', ')}. Число разных счетов: ${unique(g.map(l => l.invoiceId)).length}.`, reason: 'Не менее трёх разных ЭСФ с одинаковыми сторонами, датой, товаром, единицей, количеством, стоимостью и валютой.', limitation: 'Разные номера ЭСФ не признаны дублями. Возможны регулярные реальные поставки.', sources: sources(g.flatMap(l => l.sources)) });
    for (const r of reconciliation)
        if (r.status === 'not_found')
            signals.push({ code: 'NO_PAYMENT_IN_ARRAY', title: `Не найден платёж по ЭСФ ${r.invoice.number}`, calculation: `ЭСФ ${r.invoice.number}: ${r.invoice.amountMinor} ${r.invoice.currency} в минимальных единицах.`, reason: 'По этим сторонам и валюте представлены банковские записи, но соответствие по реквизитам не найдено.', limitation: 'Полнота выписок не подтверждена. Возможны аванс, отсрочка, зачёт, наличная оплата или иной период; это не доказательство неоплаты.', sources: r.invoice.sources });
    for (const p of bank.filter(p => p.classification === 'commercial_candidate' && BigInt(p.unallocatedMinor || 0) > 0n && !p.relatedCandidate))
        signals.push({ code: 'PAYMENT_WITHOUT_INVOICE', title: `Остаток платежа ${p.number} без подтверждённой ЭСФ`, calculation: `Нераспределённая сумма: ${p.unallocatedMinor} ${p.currency} в минимальных единицах.`, reason: 'Коммерческий кандидат банковского платежа не полностью распределён по ЭСФ дела.', limitation: 'Платёж не приписан выбранной услуге без ссылки на ЭСФ. Возможны иное основание или неполнота комплекта.', sources: p.sources });
    return signals;
}
export function buildGoodsAnalysis(report, q = {}, decisions = []) {
    if (q.direction && !['purchase', 'sale'].includes(q.direction))
        throw new FinancialError('Неизвестное направление');
    if (q.direction && !q.identifier)
        throw new FinancialError('Для направления выберите организацию');
    const byInvoice = new Map(report.invoices.map(i => [i.id, i]));
    const allLines = report.invoices.flatMap(i => i.lines.map((l, index) => ({ ...l, key: hash([i.id, l.source, index]), invoiceDate: i.date, date: i.date, senderId: i.senderId, recipientId: i.recipientId, senderName: i.senderName, recipientName: i.recipientName, contractRef: i.contractRef, sources: l.sourceCopies || [l.source] })));
    for(const l of allLines)l.analysisDirection=q.identifier?(l.senderId===q.identifier?'sale':'purchase'):'document_supply';
    const allowedInvoice = i => (!q.identifier || [i.senderId, i.recipientId].includes(q.identifier)) && (!q.counterparty || (q.identifier ? [i.senderId, i.recipientId].filter(id => id !== q.identifier) : [i.senderId, i.recipientId]).includes(q.counterparty)) && (!q.direction || (q.direction === 'purchase' ? i.recipientId : i.senderId) === q.identifier);
    const terms = norm(q.search).split(' ').filter(Boolean);
    const scoped = allLines.filter(l => allowedInvoice(byInvoice.get(l.invoiceId))), lines = scoped.filter(l => (!q.category || l.category === q.category) && (!terms.length || terms.every(t => norm([l.name, l.category, l.invoiceNumber, l.senderId, l.recipientId, l.senderName, l.recipientName].join(' ')).includes(t))));
    const ids = new Set(lines.map(l => l.invoiceId)), invoices = report.invoices.filter(i => ids.has(i.id)).map(i => ({ ...i, selectedLines: lines.filter(l => l.invoiceId === i.id) }));
    const selectedTerms = unique(lines.map(l => l.term)), categories = categoryGroups(lines, q), bankScope = report.reconciliation.payments.filter(p => (!q.identifier || [p.senderId, p.recipientId].includes(q.identifier)) && (!q.counterparty || [p.senderId, p.recipientId].includes(q.counterparty)));
    const reconciliation = report.reconciliation.items.filter(x => ids.has(x.invoice.id)).map(x => { const i = invoices.find(i => i.id === x.invoice.id), bankAvailable = report.bank.some(b => !b.conflict && b.currency === i.currency && b.senderId === i.recipientId && b.recipientId === i.senderId), wholeInvoice = i.selectedLines.length === i.lines.length; return { ...x, invoice: i, bankAvailable, categoryAmountMinor: completeSum(i.selectedLines.map(l => l.amountMinor)), wholeInvoice, categoryConfirmedMinor: wholeInvoice ? x.confirmedMinor : null, status: !bankAvailable && !x.allocations.length && !x.candidates.length ? 'insufficient_data' : x.needsRefundReview ? 'refund_review' : x.allocations.length ? x.status : x.candidates.length ? 'needs_confirmation' : 'not_found', allocationNote: wholeInvoice ? 'Выбранная категория / подборка охватывает все позиции ЭСФ.' : 'Оплата установлена на уровне всей ЭСФ; распределение между её категориями не установлено. Пропорциональное распределение не выполняется.' }; });
    const candidateIds = new Set(reconciliation.flatMap(x => x.candidates.map(a => a.paymentId))), confirmedIds = new Set(reconciliation.flatMap(x => x.allocations.map(a => a.paymentId))), linkedIds = new Set([...candidateIds, ...confirmedIds]), payments = [...new Map([...report.reconciliation.payments, ...report.reconciliation.linkedPayments].filter(p => linkedIds.has(p.id)).map(p => [p.id, p])).values()];
    const scopedBank = bankScope.map(p => ({ ...p, relatedCandidate: report.reconciliation.candidates.some(c => c.paymentId === p.id), linkedToSelection: linkedIds.has(p.id) }));
    const linkedBank = report.bank.filter(b => payments.some(p => p.sources.some(s => b.sources.some(t => srcKey(s) === srcKey(t)))));
    for(const fee of report.bank.filter(b=>b.kind==='fee'&&!b.conflict)){
        const parents=report.bank.filter(b=>b.kind!=='fee'&&b.currency===fee.currency&&b.ownerId&&b.ownerId===fee.ownerId&&(fee.ownerAccount?b.ownerAccount===fee.ownerAccount:true)&&(fee.countedWith===b.id||fee.feeReference&&fee.feeReference===b.transactionId));
        if(parents.length===1&&linkedBank.some(b=>b.id===parents[0].id)&&!linkedBank.some(b=>b.id===fee.id))linkedBank.push(fee);
    }
    const totalsByCurrency = totals(lines, q.identifier), quantities = priceGroups(lines).map(({ items, ...g }) => g), comparisons = comparisonGroups(lines).filter(c => !q.identifier || c.identifier === q.identifier);
    const organizationOptions = [...new Map(allLines.flatMap(l => [[l.senderId, { identifier: l.senderId, name: l.senderName }], [l.recipientId, { identifier: l.recipientId, name: l.recipientName }]])).values()];
    return { version: 'goods-analysis-1.0', caseId: report.caseId, caseNumber: report.caseNumber, fingerprint: report.fingerprint, filters: q, totals: totalsByCurrency, counts: { rows: lines.length, invoices: ids.size, incomingInvoices: q.identifier ? unique(lines.filter(l => l.recipientId === q.identifier).map(l => l.invoiceId)).length : null, outgoingInvoices: q.identifier ? unique(lines.filter(l => l.senderId === q.identifier).map(l => l.invoiceId)).length : null, suppliers: unique(lines.map(l => l.senderId)).length, buyers: unique(lines.map(l => l.recipientId)).length, counterparties: unique(lines.flatMap(l => [l.senderId, l.recipientId]).filter(id => id !== q.identifier)).length, contractReferences: unique(lines.map(l => l.contractRef)).length }, organizationOptions, categoryOptions: unique(scoped.map(l => l.category)).sort((a, b) => a.localeCompare(b, 'ru')), category: categories.length === 1 ? categories[0] : null, categories, lines, invoices, quantities, comparisons, proposals: groupingProposals(allLines, decisions).filter(p => !q.search || p.terms.some(l => norm(l.name).includes(norm(q.search)))), reconciliation, payments, linkedBank, unmatchedPayments: scopedBank.filter(p => BigInt(p.unallocatedMinor || 0) > 0n), signals: signalList(lines, reconciliation, scopedBank, q.identifier), coverage: report.coverage, notes: ['Все суммы категории — стоимость выбранных товарных строк, а не повторённые итоги ЭСФ. Валюты учитываются раздельно.', 'Средняя цена рассчитывается только для одинаковых исходных наименований и единиц, по явной цене без НДС, взвешенной по количеству. Категория из разных услуг не делает их цены сопоставимыми.', 'Разница приобретения и реализации — не прибыль, не ущерб и не доказанная наценка. Идентичность партий не устанавливается по совпадению слов.', 'Связанные платежи и комиссии могут относиться ко всей ЭСФ. Для нескольких категорий в одном счёте оплата конкретной позиции не распределяется автоматически.'], _report: report };
}
export function goodsAnalysis(db, caseId, q = {}, context = {}) { migrateGoods(db); const filter = Object.fromEntries(['from', 'to', 'currency','min','max'].filter(k => q[k]).map(k => [k, q[k]])); if (q.identifier && !/^\d{12}$/.test(q.identifier))
    throw new FinancialError('Укажите БИН/ИИН из 12 цифр'); if (q.counterparty && !/^\d{12}$/.test(q.counterparty))
    throw new FinancialError('Укажите БИН/ИИН контрагента из 12 цифр');
    for(const [k,n]of [['search',250],['category',250]])if(q[k]&&String(q[k]).length>n)throw new FinancialError('Слишком длинный поисковый запрос');
    const full = financialReport(db, caseId, {}, context);
    const decisions = db.prepare('SELECT * FROM case_goods_group_decisions WHERE case_id=?').all(caseId);
    const result = buildGoodsAnalysis(Object.keys(filter).length ? financialReport(db, caseId, filter, context) : full, q, decisions);
    result.fingerprint = full.fingerprint;
    result.counts.missingAmounts=result.lines.filter(l=>l.amountMinor===null).length;
    result.counts.missingVat=result.lines.filter(l=>l.vatMinor===null).length;
    result.proposals = groupingProposals(full.lines, decisions).map(p=>({...p,decisionVersion:decisions.find(d=>d.decision_key===p.key)?.updated_at||''}));
    result.groupDecisions = decisions.map(d=>({key:d.decision_key,status:d.status,category:d.category,terms:JSON.parse(d.terms_json).map(term=>({term,name:full.lines.find(l=>l.term===term)?.name||term})),note:d.note,decisionVersion:d.updated_at}));
    result.organizationOptions = [...new Map(full.invoices.flatMap(i=>[[i.senderId,{identifier:i.senderId,name:i.senderName}],[i.recipientId,{identifier:i.recipientId,name:i.recipientName}]])).values()];
    return result;
}
export function goodsGraph(result, q = {}) {
    const r = result._report, ids = new Set(result.invoices.map(i => i.id)), pid = new Set(result.payments.map(p => p.id)), report = { ...r, invoices: result.invoices.map(i => ({ ...i, graphAmountMinor: completeSum(i.selectedLines.map(l => l.amountMinor)), graphLabel: 'Стоимость выбранных позиций категории', sources: sources(i.selectedLines.flatMap(l => l.sources)) })), bank: result.linkedBank, reconciliation: { ...r.reconciliation, allocations: r.reconciliation.allocations.filter(a => ids.has(a.invoiceId)), candidates: r.reconciliation.candidates.filter(a => ids.has(a.invoiceId)), payments: [...r.reconciliation.payments, ...r.reconciliation.linkedPayments].filter(p => pid.has(p.id)) } };
    // Show only actual subsequent statement entries; proximity is not provenance of funds.
    const selected = new Map(report.bank.map(b=>[b.id,b]));
    let frontier = [...selected.values()], checks = 0;
    for(let hop=0;hop<3&&frontier.length&&checks<20000;hop++) {
        const next=[];
        for(const a of frontier) for(const b of r.bank) {
            if(++checks>20000) break;
            if(selected.has(b.id)||b.conflict||!a.recipientId||a.recipientId!==b.senderId||a.currency!==b.currency||!a.dateValid||!b.dateValid||b.date<a.date)continue;
            const days=(Date.parse(b.date)-Date.parse(a.date))/86400000,x=BigInt(a.amountMinor||0),y=BigInt(b.amountMinor||0);
            if(days>3||x<=0n||y<=0n||(x>y?x-y:y-x)*100n>x*10n)continue;
            selected.set(b.id,b);next.push(b);
        }
        frontier=next;
    }
    report.bank=[...selected.values()];
    const graph = buildFinancialGraph(report, q);
    if(checks>=20000)graph.truncatedSignals=true;
    return { ...graph, methodology: 'Документальные стрелки показывают стоимость выбранных товарных позиций, не полную стоимость смешанной ЭСФ. Банковские переводы подтверждены выписками как события; их отношение к ЭСФ — отдельная подтверждённая или предварительная связь. Оплата строки смешанной ЭСФ не установлена. ' + graph.methodology };
}
export function saveGoodsGrouping(db, caseId, input, context = {}) {
    migrateGoods(db);
    const c = getCase(db, caseId, context.departmentId || DEFAULT_DEPARTMENT_ID);
    if (!c)
        throw new FinancialError('Дело не найдено', 404);
    if (c.status === 'archived')
        throw new FinancialError('Дело находится в архиве', 409);
    const note = String(input.note || '').trim();
    if (!note || note.length > 4000)
        throw new FinancialError('Укажите обоснование до 4000 символов');
    db.exec('BEGIN IMMEDIATE');
    try {
        // Snapshot, optimistic validation, category updates and history commit atomically.
        const report = financialReport(db, caseId, {}, context);
        if (report.fingerprint !== input.fingerprint)
            throw new FinancialError('Данные изменились. Обновите подборку', 409);
        if(!Array.isArray(input.terms))throw new FinancialError('Выберите исходные наименования');
        const available = new Set(report.lines.map(l => l.term)), terms = unique(input.terms.map(norm)).sort();
        if (!terms.length || terms.length > 200 || terms.some(t => !available.has(t)))
            throw new FinancialError('Выберите до 200 исходных наименований этого дела');
        const key = String(input.key || hash(['manual', terms]));
        const old = db.prepare('SELECT * FROM case_goods_group_decisions WHERE case_id=? AND decision_key=?').get(caseId, key), status = String(input.status || ''), category = String(input.category || '').trim();
        if (!['confirmed', 'rejected', 'pending'].includes(status) || !category || category.length > 250)
            throw new FinancialError('Выберите результат и название категории до 250 символов');
        if (old && JSON.stringify(terms) !== old.terms_json)
            throw new FinancialError('Состав решения изменился; создайте новое решение', 409);
        if ((old?.updated_at || '') !== String(input.decisionVersion || ''))
            throw new FinancialError('Решение изменилось. Обновите подборку', 409);
        if (input.key && !old && !groupingProposals(report.lines).some(p => p.key === key && JSON.stringify(p.terms.map(t => t.term).sort()) === JSON.stringify(terms)))
            throw new FinancialError('Предложение не относится к текущим наименованиям', 409);
        const previous = old?.status === 'confirmed' ? JSON.parse(old.previous_json) : Object.fromEntries(terms.map(t => [t, db.prepare('SELECT * FROM case_financial_categories WHERE case_id=? AND term=?').get(caseId, t) || null]));
        const user = context.userId || currentUserId() || DEFAULT_USER_ID, now = new Date().toISOString();
        if (old?.status === 'confirmed')
            for (const t of terms) {
                const current = db.prepare('SELECT * FROM case_financial_categories WHERE case_id=? AND term=?').get(caseId, t);
                if (current?.updated_at !== old.updated_at || current?.updated_by !== old.updated_by)
                    throw new FinancialError('Категория уже изменена другим решением. Обновите её отдельно', 409);
            }
        if (status === 'confirmed')
            for (const t of terms)
                db.prepare('INSERT INTO case_financial_categories VALUES(?,?,?,?,?,?) ON CONFLICT(case_id,term) DO UPDATE SET category=excluded.category,note=excluded.note,updated_by=excluded.updated_by,updated_at=excluded.updated_at').run(caseId, t, category, note, user, now);
        else if (old?.status === 'confirmed')
            for (const t of terms) {
                const p = previous[t];
                if (p)
                    db.prepare('UPDATE case_financial_categories SET category=?,note=?,updated_by=?,updated_at=? WHERE case_id=? AND term=?').run(p.category, p.note, p.updated_by, p.updated_at, caseId, t);
                else
                    db.prepare('DELETE FROM case_financial_categories WHERE case_id=? AND term=?').run(caseId, t);
            }
        db.prepare('INSERT INTO case_goods_group_decisions VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(case_id,decision_key) DO UPDATE SET status=excluded.status,category=excluded.category,previous_json=excluded.previous_json,note=excluded.note,updated_by=excluded.updated_by,updated_at=excluded.updated_at').run(caseId, key, status, category, JSON.stringify(terms), JSON.stringify(previous), note, user, now);
        const relevant = report.lines.filter(l => terms.includes(l.term)), parties = unique(relevant.flatMap(l => { const i = report.invoices.find(i => i.id === l.invoiceId); return [i.senderId, i.recipientId]; })).map(identifier => ({ identifier, name: report.invoices.find(i => i.senderId === identifier)?.senderName || report.invoices.find(i => i.recipientId === identifier)?.recipientName || identifier })), review = { version: 1, kind: 'group', title: `Группировка ${terms.length} наименований: «${category}»`, sources: sources(relevant.flatMap(l => l.sourceCopies || [l.source])), parties, before: { status: old?.status || 'pending', note: old?.note || '' }, available: true };
        db.prepare("INSERT INTO audit_log(id,department_id,user_id,action,entity_type,entity_id,details_json,created_at) VALUES(?,?,?,'case.goods_group_reviewed','case',?,?,?)").run(randomUUID(), context.departmentId || DEFAULT_DEPARTMENT_ID, user, caseId, JSON.stringify({ id: key, kind: 'group', status, note, terms, category, review }), now);
        db.exec('COMMIT');
        return { ok: true, key, status };
    }
    catch (e) {
        if (db.isTransaction)
            db.exec('ROLLBACK');
        throw e;
    }
}
