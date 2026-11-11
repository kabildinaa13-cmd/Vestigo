import { createHash, randomUUID } from 'node:crypto';
import { caseAnalysis, migrateCaseAnalysis } from './case-analysis.mjs';
import { getCase, DEFAULT_DEPARTMENT_ID, DEFAULT_USER_ID } from './vestigo-db.mjs';
import { currentUserId } from './request-identity.mjs';
import { canonicalBankSourceRows, bankEntryKind, isBankFee, isPartyKey, validIban, bankPaymentClass as bankClass, invoicePaymentEligibility, paymentCapacityKey } from './bank-identities.mjs';
import { buildBankLedger } from './bank-analysis.mjs';
import { reviewSubject } from './review-history.mjs';
import {verifiedPartyEvidence,thirdPartySupport,containsDocumentReference} from './payment-party-evidence.mjs';
import {reconciliationProposals} from './reconciliation-proposals.mjs';
import {bankFlowAnalysis,canonicalBankTransfers} from './financial-flows.mjs';
import {financialSignals} from './financial-signals.mjs';
export const FINANCIAL_VERSION = 'financial-profile-3.0';
export class FinancialError extends Error {
    constructor(message, status = 422) { super(message); this.status = status; }
}
const parse = (s, f = {}) => { try {
    return JSON.parse(s || '');
}
catch {
    return f;
} };
export const normalizeCategory = s => String(s ?? '').normalize('NFKC').toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const key = s => [s.documentId, s.sheet, s.row].join(':');
const unique = a => [...new Set(a.filter(Boolean))];
const money = v => Number.isSafeInteger(v) ? BigInt(v) : typeof v === 'string' && /^-?\d+$/.test(v) ? BigInt(v) : null;
export function decimalMinor(value) { const s = String(value ?? '').replace(/[\s\u00a0]/g, '').replace(',', '.'); if (!/^-?\d+(\.\d{1,2})?$/.test(s))
    throw new FinancialError('Укажите точную сумму с не более чем двумя знаками после запятой'); const negative = s.startsWith('-'), [a, b = ''] = s.replace('-', '').split('.'); return ((BigInt(a) * 100n + BigInt(b.padEnd(2, '0'))) * (negative ? -1n : 1n)).toString(); }
export function formatMinor(v) { const n = money(v); if (n === null)
    return 'Нет данных'; const a = n < 0n ? -n : n; return `${n < 0n ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`; }
const add = (o, c, v) => { const n = money(v); if (n !== null && c && c !== 'UNKNOWN')
    o[c] = (BigInt(o[c] || 0) + n).toString(); };
const source = (r) => ({ documentId: r.document_id, name: r.original_name, sheet: r.sheet, row: r.row_number, page: Number(r.sheet.match(/PDF(?: bank)? (\d+)/)?.[1] || 0) });
const refs = s => [...new Map(s.map(s => [key(s), s])).values()];
const eligible = o => !o.conflict && o.reviewStatus !== 'rejected' && o.currency !== 'UNKNOWN' && money(o.amountMinor) !== null;
function scope(db, id, context = {}, write = false) { const c = getCase(db, id, context.departmentId || DEFAULT_DEPARTMENT_ID); if (!c)
    throw new FinancialError('Дело не найдено', 404); if (write && c.status === 'archived')
    throw new FinancialError('Дело находится в архиве', 409); return c; }
export function migrateFinancial(db) {
    migrateCaseAnalysis(db);
    db.exec(`
 CREATE TABLE IF NOT EXISTS case_financial_categories(case_id TEXT NOT NULL REFERENCES cases(id),term TEXT NOT NULL,category TEXT NOT NULL,note TEXT NOT NULL,updated_by TEXT NOT NULL REFERENCES users(id),updated_at TEXT NOT NULL,PRIMARY KEY(case_id,term));
 CREATE TABLE IF NOT EXISTS case_payment_allocations(case_id TEXT NOT NULL REFERENCES cases(id),invoice_key TEXT NOT NULL,payment_key TEXT NOT NULL,invoice_fingerprint TEXT NOT NULL,payment_fingerprint TEXT NOT NULL,amount_minor TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('confirmed','rejected','pending')),note TEXT NOT NULL,updated_by TEXT NOT NULL REFERENCES users(id),updated_at TEXT NOT NULL,PRIMARY KEY(case_id,invoice_key,payment_key));
 CREATE INDEX IF NOT EXISTS payment_allocation_case ON case_payment_allocations(case_id,status);
 CREATE TABLE IF NOT EXISTS case_payment_party_evidence(case_id TEXT NOT NULL REFERENCES cases(id),invoice_key TEXT NOT NULL,payment_key TEXT NOT NULL,invoice_fingerprint TEXT NOT NULL,payment_fingerprint TEXT NOT NULL,evidence_key TEXT NOT NULL,evidence_fingerprint TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('confirmed','rejected','pending')),note TEXT NOT NULL,updated_by TEXT NOT NULL REFERENCES users(id),updated_at TEXT NOT NULL,PRIMARY KEY(case_id,invoice_key,payment_key));
 CREATE TABLE IF NOT EXISTS case_financial_signal_reviews(case_id TEXT NOT NULL REFERENCES cases(id),signal_id TEXT NOT NULL,fingerprint TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('confirmed','rejected','pending','checking')),note TEXT NOT NULL,filters_json TEXT NOT NULL,updated_by TEXT NOT NULL REFERENCES users(id),updated_at TEXT NOT NULL,PRIMARY KEY(case_id,signal_id));
 `);
}
function data(db, caseId, context) {
    const analysis = caseAnalysis(db, caseId, { all: true, skipChains: true }, context);
    const raw = db.prepare(`SELECT r.*,d.original_name FROM case_extracted_rows r JOIN documents d ON d.id=r.document_id WHERE r.case_id=? AND NOT EXISTS(SELECT 1 FROM case_document_exclusions x WHERE x.case_id=r.case_id AND x.document_id=r.document_id) ORDER BY r.document_id,r.sheet,r.row_number`).all(caseId);
    const records = canonicalBankSourceRows(raw).map(r => ({ row: parse(r.record_json), source: source(r) }));
    const keys = new Map(db.prepare('SELECT id,external_key FROM operations WHERE case_id=?').all(caseId).map(r => [r.id, r.external_key]));
    const ops = analysis.operations.map(o => ({ ...o, externalKey: keys.get(o.id) }));
    const categories = new Map(db.prepare('SELECT term,category FROM case_financial_categories WHERE case_id=?').all(caseId).map(r => [r.term, r.category]));
    const ledger = buildBankLedger(records, ops, analysis.matches);
    return { analysis, records, bySource: new Map(records.map(r => [key(r.source), r])), ops, categories, ledger };
}
const lower = s => String(s ?? '').toLocaleLowerCase('ru').replace(/ё/g, 'е');
function activeAllocations(db, caseId, d) { const byKey = new Map(d.ops.map(o => [o.externalKey, o])); return db.prepare('SELECT * FROM case_payment_allocations WHERE case_id=?').all(caseId).map(r => { const invoice = byKey.get(r.invoice_key), payment = byKey.get(r.payment_key), rule=invoicePaymentEligibility(invoice,payment,verifiedPartyEvidence(db,caseId,invoice,payment)); return { ...r, invoiceId: invoice?.id, paymentId: payment?.id, invalidReason:rule.reason, stale: !rule.eligible || !eligible(invoice) || !eligible(payment) || invoice.fingerprint !== r.invoice_fingerprint || payment.fingerprint !== r.payment_fingerprint }; }); }
// A candidate is never counted as a staff-confirmed payment. Payment capacity is global to the case.
export function reconciliation(db, caseId, d) {
    const invoices = d.ops.filter(o => o.type === 'invoice' && eligible(o)), payments = d.ops.filter(o => o.type === 'payment' && eligible(o) && !isBankFee(o)), byId = new Map(d.ops.map(o => [o.id, o]));
    const decisions = activeAllocations(db, caseId, d), allocations = [], used = new Map(), invalidDecisions=[];
    for(const r of decisions)if(r.status==='confirmed'&&r.invalidReason)invalidDecisions.push({method:'allocated_by_employee',invoiceId:r.invoiceId,paymentId:r.paymentId,reason:r.invalidReason});
    for (const r of decisions)
        if (!r.stale && r.status === 'confirmed') {
            allocations.push({ invoiceId: r.invoiceId, paymentId: r.paymentId, amountMinor: r.amount_minor, confirmed: true, method: 'allocated_by_employee', explanation: r.note });
            used.set(r.paymentId, (used.get(r.paymentId) || 0n) + BigInt(r.amount_minor));
        }
    const legacy = db.prepare("SELECT * FROM case_matching_reviews WHERE case_id=? AND status='confirmed'").all(caseId);
    for (const r of legacy) {
        const i = invoices.find(o => o.externalKey === r.left_key), p = payments.find(o => o.externalKey === r.right_key);
        const rule=invoicePaymentEligibility(i,p,verifiedPartyEvidence(db,caseId,i,p));
        if(!rule.eligible){invalidDecisions.push({method:'legacy_employee',invoiceId:i?.id,paymentId:p?.id,invoiceNumber:i?.number,paymentNumber:p?.number,reason:rule.reason,sources:[...(i?.sources||[]),...(p?.sources||[])]});continue;}
        if (!i || !p || r.left_fingerprint !== i.fingerprint || r.right_fingerprint !== p.fingerprint || decisions.some(a => !a.stale && a.payment_key === r.right_key))
            continue;
        allocations.push({ invoiceId: i.id, paymentId: p.id, amountMinor: String(p.amountMinor), confirmed: true, method: 'legacy_employee', explanation: r.note });
        used.set(p.id, BigInt(p.amountMinor));
    }
    // Several historical operation IDs may describe the same fully identified
    // bank transfer. Reject an over-capacity cohort as a whole, never pick a
    // winner by database iteration order. Stored decisions remain untouched.
    const cohorts=new Map();for(const a of allocations){const p=byId.get(a.paymentId),k=paymentCapacityKey(p);if(!cohorts.has(k))cohorts.set(k,[]);cohorts.get(k).push(a);}
    for(const group of cohorts.values()){const p=byId.get(group[0].paymentId),total=group.reduce((n,a)=>n+BigInt(a.amountMinor),0n);if(total>BigInt(p.amountMinor)||group.some(a=>BigInt(a.amountMinor)<=0n)){for(const a of group){invalidDecisions.push({invoiceId:a.invoiceId,paymentId:a.paymentId,reason:'Исторические распределения превышают сумму одного банковского события; решения сохранены, но не включены в оплату'});allocations.splice(allocations.indexOf(a),1);}}}
    used.clear();for(const p of payments){const total=allocations.filter(a=>paymentCapacityKey(byId.get(a.paymentId))===paymentCapacityKey(p)).reduce((n,a)=>n+BigInt(a.amountMinor),0n);if(total>0n)used.set(p.id,total);}
    const thirdPartyPairs=db.prepare("SELECT invoice_key,payment_key FROM case_payment_party_evidence WHERE case_id=? AND status='confirmed'").all(caseId).map(r=>({invoiceId:d.ops.find(o=>o.externalKey===r.invoice_key)?.id,paymentId:d.ops.find(o=>o.externalKey===r.payment_key)?.id}));
    const proposals=reconciliationProposals(d,allocations,decisions,(i,p)=>verifiedPartyEvidence(db,caseId,i,p),thirdPartyPairs),candidates=proposals.candidates;
    const items = invoices.map(i => { const links = allocations.filter(a => a.invoiceId === i.id), confirmed = links.reduce((n, a) => n + BigInt(a.amountMinor), 0n), difference = BigInt(i.amountMinor) - confirmed, total = BigInt(i.amountMinor), percentage = total === 0n ? null : ((difference * 10000n / (total < 0n ? -total : total)).toString()); const refunds = d.analysis.matches.filter(m => m.leftId === i.id && m.method === 'refund_reference').map(m => byId.get(m.rightId)).filter(o => o && eligible(o)); return { invoice: i, allocations: links, candidates: candidates.filter(a => a.invoiceId === i.id), confirmedMinor: confirmed.toString(), unpaidMinor: (difference > 0n ? difference : 0n).toString(), differenceMinor: difference.toString(), differenceBasisPoints: percentage, refunds, needsRefundReview: refunds.length > 0, status: refunds.length ? 'refund_review' : !links.length ? 'unmatched' : difference === 0n ? 'paid' : difference > 0n ? 'partial' : 'overpaid' }; });
    return { items, candidates, allocations, invalidDecisions, proposalCoverage:{truncated:proposals.truncated,comparisons:proposals.comparisons,limit:proposals.limit},correspondences:[...candidates,...allocations.map(a=>({...a,status:'confirmed'})),...decisions.filter(a=>!a.stale&&a.status==='rejected').map(a=>({invoiceId:a.invoiceId,paymentId:a.paymentId,status:'rejected',explanation:a.note,confirmed:false}))],supportingOperations:d.ops.filter(e=>['contract','primary'].includes(e.type)&&!e.conflict&&e.reviewStatus!=='rejected'),partyEvidence:db.prepare('SELECT invoice_key,payment_key,evidence_key,status,note FROM case_payment_party_evidence WHERE case_id=?').all(caseId).map(r=>({invoiceId:d.ops.find(o=>o.externalKey===r.invoice_key)?.id,paymentId:d.ops.find(o=>o.externalKey===r.payment_key)?.id,evidenceId:d.ops.find(o=>o.externalKey===r.evidence_key)?.id,status:r.status,stale:r.status==='confirmed'&&!verifiedPartyEvidence(db,caseId,d.ops.find(o=>o.externalKey===r.invoice_key),d.ops.find(o=>o.externalKey===r.payment_key)),note:r.note})), decisions: decisions.map(({ invoice_key, payment_key, invoice_fingerprint, payment_fingerprint, updated_by, ...r }) => r), payments: payments.map(p => ({ ...p, classification: bankClass(p), allocatedMinor: (used.get(p.id) || 0n).toString(), unallocatedMinor: (BigInt(p.amountMinor) - (used.get(p.id) || 0n)).toString() })), methodology: 'Подтверждённые суммы включают только допустимые решения сотрудников. Кандидаты показаны отдельно. Один платёж может быть распределён между ЭСФ лишь в пределах его суммы; неизвестные валюты, займы, налоги, внутренние переводы, комиссии и возвраты не распределяются как оплата. Недопустимые прежние решения сохранены в истории, но исключены из оплаченных сумм. Отсутствие платежа в массиве не означает отсутствия оплаты.' };
}
function opRows(d, o) { return o.sources.map(s => d.bySource.get(key(s))).filter(Boolean); }
function lineVat(r) {
    if (r.esf?.lineVatMinor !== null && r.esf?.lineVatMinor !== undefined) return String(r.esf.lineVatMinor);
    // Historical KGD exports have distinct line and invoice-total columns. Read the
    // former only with this explicit schema; never copy invoice VAT to each item.
    if (Object.hasOwn(r.raw || {}, 'Всего по счету, сумма НДС') && Object.hasOwn(r.raw || {}, 'Порядковый номер ТРУ')) {
        const v = r.raw['Сумма НДС'];
        if (v !== null && v !== undefined && String(v).trim() !== '') {
            try { return decimalMinor(v); } catch { return null; }
        }
    }
    return null;
}
function invoiceLines(d, invoice) {
    const rows = opRows(d, invoice).filter(r => r.row.type === 'invoice');
    const docs = new Map();
    for (const r of rows) {
        if (!docs.has(r.source.documentId))
            docs.set(r.source.documentId, []);
        docs.get(r.source.documentId).push(r);
    }
    const representative = [...docs.values()].sort((a, b) => b.length - a.length)[0] || [];
    const lines = representative.map(({ row: r, source: s }) => { const original = r.esf?.goodsName || r.purpose || '', term = normalizeCategory(original); return { invoiceId: invoice.id, invoiceNumber: invoice.number, name: original, term, category: d.categories.get(term) || term || 'Без наименования', lineNumber: r.lineNumber || '', quantity: r.esf?.quantity || r.attributes?.quantity || null, unit: r.attributes?.unit || null, unitPriceWithoutVatMinor: r.esf?.unitPriceWithoutVatMinor ?? null, unitPriceWithVatMinor: r.attributes?.unitPriceMinor ?? null, amountMinor: r.esf?.lineAmountMinor ?? null, vatMinor: lineVat(r), vatRate: r.attributes?.vatRate || null, currency: invoice.currency, source: s }; });
    // An explicit position number identifies one line within the representative
    // document. Conflicting amounts are excluded by case analysis upstream.
    const seen = new Map();
    for (const l of lines) {
        const k = l.lineNumber ? 'line:' + String(l.lineNumber).trim() : key(l.source);
        if (!seen.has(k))
            seen.set(k, { ...l, sourceCopies: [l.source] });
        else {
            const prior = seen.get(k);
            const copies = [...prior.sourceCopies, l.source];
            if (prior.amountMinor === null && l.amountMinor !== null) seen.set(k, { ...l, sourceCopies: copies });
            else prior.sourceCopies = copies;
        }
    }
    return [...seen.values()];
}
function invoiceVat(d, i) { const rows = opRows(d, i), values = []; for (const { row: r } of rows) {
    const field = r.attributes?.fieldSources?.vatAmount;
    const explicitTotal = r.esf?.vatTotalMinor;
    if (explicitTotal !== undefined && explicitTotal !== null)
        values.push(String(explicitTotal));
    else if (r.attributes?.vatMinor !== null && r.attributes?.vatMinor !== undefined && (/всего.*счет|total/i.test(field?.column || '') || rows.length === 1))
        values.push(String(r.attributes.vatMinor));
} const distinct = unique(values); return distinct.length === 1 ? distinct[0] : null; }
function statementEntries(d) { return d.ledger.entries.map(e => { const record = e.sources.map(s => d.bySource.get(key(s))?.row).find(Boolean); const b = record?.bank || {}; return { ...e, amountMinor: e.amountMinor === null || e.amountMinor === undefined ? null : String(e.amountMinor), rawAmountMinor: e.rawAmountMinor === null || e.rawAmountMinor === undefined ? null : String(e.rawAmountMinor), feeMinor: e.feeMinor === null || e.feeMinor === undefined ? null : String(e.feeMinor), creditedMinor: e.direction === 'incoming' && !e.conflict && Number.isSafeInteger(b.rawCreditMinor) ? String(b.rawCreditMinor) : e.direction === 'incoming' && e.feeMode === 'credit_after_fee' && Number.isSafeInteger(e.rawAmountMinor) ? String(e.rawAmountMinor) : null, bankName: b.bankName || null, ownerName: b.ownerName || null, openingMinor: record?.attributes?.openingMinor ?? null, closingMinor: record?.attributes?.closingMinor ?? null, classification: bankClass(record || {}) }; }); }
export function financialReport(db, caseId, q = {}, context = {}) {
    if (db.isTransaction)
        return enrichReport(db, caseId, buildReport(db, caseId, q, context),q);
    migrateFinancial(db);
    db.exec('BEGIN');
    try {
        const result = enrichReport(db, caseId, buildReport(db, caseId, q, context),q);
        db.exec('COMMIT');
        return result;
    }
    catch (e) {
        db.exec('ROLLBACK');
        throw e;
    }
}
function enrichReport(db,caseId,report,q){
    for(const [name,min,max] of [['onwardDays',0,90],['toleranceBps',0,10000],['concentrationBps',1,10000]])if(q[name]!==undefined&&q[name]!==''&&(!/^\d+$/.test(String(q[name]))||Number(q[name])<min||Number(q[name])>max))throw new FinancialError('Некорректный порог '+name);
    if(q.largeThreshold&&!/^\d+$/.test(String(q.largeThreshold)))throw new FinancialError('Порог крупной операции задаётся целым числом минимальных единиц');
    if(q.graphMode&&!['auto','combined','money','relations','reconciliation'].includes(q.graphMode))throw new FinancialError('Неизвестный режим графа');
    if(q.bankKind&&!['transfer','refund','fee','fee_refund'].includes(q.bankKind))throw new FinancialError('Неизвестный вид банковской операции');
    report.flowAnalysis=bankFlowAnalysis(report.bank,q);
    report.documentRelations=report.reconciliation.supportingOperations.filter(o=>(!q.identifier||[o.senderId,o.recipientId].includes(q.identifier))&&(!q.documentId||o.sources.some(s=>s.documentId===q.documentId))&&(!q.currency||o.currency===q.currency)&&(!q.from||o.date>=q.from)&&(!q.to||o.date<=q.to)&&(!q.purpose||lower(o.purpose).includes(lower(q.purpose))));
    report.signalAnalysis=financialSignals(report,q,db.prepare('SELECT * FROM case_financial_signal_reviews WHERE case_id=?').all(caseId));
    report.notes.push(report.flowAnalysis.methodology);
    return report;
}
function buildReport(db, caseId, q = {}, context = {}) {
    const parent = scope(db, caseId, context), d = data(db, caseId, context);
    if (q.from && !validDay(q.from) || q.to && !validDay(q.to) || q.from && q.to && q.from > q.to)
        throw new FinancialError('Проверьте границы периода');
    for (const v of [q.min, q.max])
        if (v && !/^\d+$/.test(v))
            throw new FinancialError('Границы суммы графа задаются целым числом минимальных денежных единиц');
    if (q.min && q.max && BigInt(q.min) > BigInt(q.max))
        throw new FinancialError('Минимальная сумма больше максимальной');
    if (q.identifier && !/^\d{12}$/.test(q.identifier) && !(String(q.identifier).startsWith('IBAN:') && validIban(String(q.identifier).slice(5))))
        throw new FinancialError('Некорректный участник');
    if (q.documentId && !d.analysis.documents.some(x => x.id === q.documentId))
        throw new FinancialError('Документ не относится к делу', 404);
    if (q.operation && !['purchase', 'sale'].includes(q.operation))
        throw new FinancialError('Неизвестный вид операции');
    if (q.operation && !q.identifier)
        throw new FinancialError('Для приобретения и реализации выберите организацию');
    const filter = o => (!q.documentId || o.sources?.some(s => s.documentId === q.documentId)) && (!q.identifier || [o.senderId, o.recipientId].includes(q.identifier)) && (!q.currency || o.currency === q.currency) && (!(q.from||q.to)||validDay(o.date)) && (!q.from || o.date >= q.from) && (!q.to || o.date <= q.to) && (!q.purpose || lower(o.purpose).includes(lower(q.purpose))) && (!q.account || [o.bank?.ownerAccount, o.bank?.senderAccount, o.bank?.recipientAccount, o.ownerAccount, o.senderAccount, o.recipientAccount].includes(q.account));
    const ops = d.ops.filter(filter), invoices = ops.filter(o => o.type === 'invoice' && eligible(o) && (!q.operation || (q.operation === 'purchase' ? o.recipientId : o.senderId) === q.identifier));
    const invoiceRows = invoices.map(i => { const rows = opRows(d, i), bases = unique(rows.map(r => r.row.attributes?.taxBaseMinor).filter(v => v !== null && v !== undefined).map(String)); return { ...i, vatMinor: invoiceVat(d, i), netMinor: bases.length === 1 ? bases[0] : null, lines: invoiceLines(d, i), contractRef: unique(rows.map(r => r.row.contractRef)).join('; ') }; });
    const lines = invoiceRows.flatMap(i => i.lines), summary = { purchase: {}, sale: {}, supply: {}, purchaseVat: {}, saleVat: {}, vat: {}, bankIncoming: {}, bankOutgoing: {}, bankFees: {}, bankRefundIncoming: {}, bankRefundOutgoing: {}, bankCredited: {} };
    for (const i of invoiceRows) {
        add(summary.supply, i.currency, i.amountMinor);
        add(summary.vat, i.currency, i.vatMinor);
        if (q.identifier) {
            if (i.senderId === q.identifier) {
                add(summary.sale, i.currency, i.amountMinor);
                add(summary.saleVat, i.currency, i.vatMinor);
            }
            if (i.recipientId === q.identifier) {
                add(summary.purchase, i.currency, i.amountMinor);
                add(summary.purchaseVat, i.currency, i.vatMinor);
            }
        }
    }
    const rawBank=d.records.filter(r=>r.row.type==='payment'),bankDiagnostics={sourceRows:rawBank.length,operations:d.ops.filter(o=>o.type==='payment').length,missingOwners:rawBank.filter(r=>!r.row.bank?.ownerId).length,missingParties:rawBank.filter(r=>!r.row.senderId||!r.row.recipientId).length,missingDates:rawBank.filter(r=>!r.row.date).length,missingCurrency:rawBank.filter(r=>r.row.currency==='UNKNOWN').length,legacyRows:rawBank.filter(r=>r.row.bank?.version!=='bank-parser-1.1').length,filtersActive:!!(q.identifier||q.account||q.currency||q.from||q.to||q.purpose||q.documentId)};
    const bank = statementEntries(d).filter(filter), bankSources = new Set(bank.flatMap(e => e.sources.map(key))), bankRows = d.records.filter(r => bankSources.has(key(r.source)));
    const ledger = buildBankLedger(bankRows, d.ops, d.analysis.matches, d.ledger.entries.map(e => ({ account: e.ownerAccount, ownerId: e.ownerId })));
    for (const t of ledger.summaries) {
        summary.bankIncoming[t.currency] = t.incomingMinor;
        summary.bankOutgoing[t.currency] = t.outgoingMinor;
        summary.bankRefundIncoming[t.currency] = t.refundIncomingMinor;
        summary.bankRefundOutgoing[t.currency] = t.refundOutgoingMinor;
        const hasFee = bank.some(e => e.currency === t.currency && (e.feeMinor !== null || e.kind === 'fee'));
        if (hasFee)
            summary.bankFees[t.currency] = t.feesMinor;
    }
    if (q.identifier) {
        summary.bankIncoming = {};
        summary.bankOutgoing = {};
        summary.bankRefundIncoming = {};
        summary.bankRefundOutgoing = {};
        summary.bankFees = {};
        for (const e of canonicalBankTransfers(bank)) {
            if (!e.internalTransfer && isPartyKey(e.senderId) && isPartyKey(e.recipientId)) {
                const incoming = e.recipientId === q.identifier, outgoing = e.senderId === q.identifier;
                if (incoming)
                    add(e.kind === 'refund' ? summary.bankRefundIncoming : summary.bankIncoming, e.currency, e.amountMinor);
                if (outgoing)
                    add(e.kind === 'refund' ? summary.bankRefundOutgoing : summary.bankOutgoing, e.currency, e.amountMinor);
            }
        }
        // Fees belong to an account perspective, not to the collapsed transfer.
        // The ledger has already linked duplicate standalone fee entries.
        for (const e of bank) {
            if (e.conflict || !e.dateValid || e.ownerId !== q.identifier || !e.direction) continue;
            if (e.kind === 'fee' && e.direction === 'outgoing' && !e.countedWith)
                add(summary.bankFees, e.currency, e.amountMinor);
            if (e.kind === 'transfer' || e.kind === 'refund')
                add(summary.bankFees, e.currency, e.feeMinor);
        }
    }
    for (const e of bank)
        if (!e.conflict && e.dateValid && isPartyKey(e.ownerId) && (!q.identifier || e.ownerId === q.identifier))
            add(summary.bankCredited, e.currency, e.creditedMinor);
    const categories = new Map(), periods = new Map(), parties = new Map();
    for (const i of invoiceRows) {
        const pkey = [i.currency, i.date?.slice(0, 7)].join(':');
        if (!periods.has(pkey))
            periods.set(pkey, { period: i.date?.slice(0, 7) || 'Дата не определена', currency: i.currency, amountMinor: '0', purchaseMinor: '0', saleMinor: '0', invoices: 0, sources: [] });
        const p = periods.get(pkey);
        p.amountMinor = (BigInt(p.amountMinor) + BigInt(i.amountMinor)).toString();
        p.invoices++;
        p.sources.push(...i.sources);
        if (i.recipientId === q.identifier)
            p.purchaseMinor = (BigInt(p.purchaseMinor) + BigInt(i.amountMinor)).toString();
        if (i.senderId === q.identifier)
            p.saleMinor = (BigInt(p.saleMinor) + BigInt(i.amountMinor)).toString();
        for (const id of [i.senderId, i.recipientId]) {
            if (id === q.identifier)
                continue;
            const k = [id, i.currency].join(':');
            if (!parties.has(k))
                parties.set(k, { identifier: id, name: id === i.senderId ? i.senderName : i.recipientName, currency: i.currency, amountMinor: '0', invoices: 0, sources: [] });
            const c = parties.get(k);
            c.amountMinor = (BigInt(c.amountMinor) + BigInt(i.amountMinor)).toString();
            c.invoices++;
            c.sources.push(...i.sources);
        }
        for (const l of i.lines) {
            const k = [l.category, l.currency].join(':');
            if (!categories.has(k))
                categories.set(k, { name: l.category, currency: l.currency, originalNames: new Set(), amountMinor: '0', purchaseMinor: '0', saleMinor: '0', missingAmounts: 0, rows: 0, invoiceIds: new Set(), sources: [] });
            const c = categories.get(k);
            c.originalNames.add(l.name);
            c.rows++;
            c.invoiceIds.add(i.id);
            c.sources.push(l.source);
            const n = money(l.amountMinor);
            if (n === null)
                c.missingAmounts++;
            else {
                c.amountMinor = (BigInt(c.amountMinor) + n).toString();
                if (i.recipientId === q.identifier)
                    c.purchaseMinor = (BigInt(c.purchaseMinor) + n).toString();
                if (i.senderId === q.identifier)
                    c.saleMinor = (BigInt(c.saleMinor) + n).toString();
            }
        }
    }
    const rec = reconciliation(db, caseId, d), selectedInvoices = new Set(invoices.map(i => i.id));
    rec.items = rec.items.filter(x => selectedInvoices.has(x.invoice.id));
    rec.candidates = rec.candidates.filter(c => selectedInvoices.has(c.invoiceId));
    rec.allocations = rec.allocations.filter(c => selectedInvoices.has(c.invoiceId));
    const linkedIds = new Set([...rec.allocations, ...rec.candidates].map(c => c.paymentId));
    rec.linkedPayments = rec.payments.filter(p => linkedIds.has(p.id)).map(p => ({ ...p, outsideFilters: !filter(p) }));
    rec.thirdPartyPayments=rec.payments.filter(p=>p.classification==='commercial_candidate'&&invoices.some(i=>i.senderId===p.recipientId&&i.recipientId!==p.senderId&&i.currency===p.currency&&containsDocumentReference(`${p.reference||''} ${p.purpose||''}`,i.number)));
    rec.payments = rec.payments.filter(filter);
    rec.methodology += ' Период отбирает ЭСФ и банковский реестр по их собственным датам. Для сверки выбранных ЭСФ учитываются сохранённые распределения по всему делу, включая авансы и поздние оплаты; связанные платежи за пределами фильтра показаны отдельно.';
    const docs = d.analysis.documents.filter(x => !q.documentId || x.id === q.documentId), coverage = { files: docs.length, failed: docs.filter(x => x.error || x.status === 'failed').map(x => ({ name: x.name, error: x.error })), partial: docs.filter(x => ['needs_mapping', 'needs_ocr', 'running', 'uploaded'].includes(x.status) || x.summary?.unparsedRows).map(x => x.name), missingVat: invoiceRows.filter(i => i.vatMinor === null).length, missingFees: bank.filter(e => e.kind === 'transfer' && e.feeMinor === null).length, missingStatements: !bank.length, excluded: docs.filter(x => x.excluded).map(x => x.name) };
    const taxRows = d.records.filter(r => r.row.groupId === 'tax' && (!q.documentId || r.source.documentId === q.documentId) && (!q.identifier || [r.row.attributes?.taxpayerId, r.row.senderId, r.row.recipientId].includes(q.identifier)) && (!q.from || !r.row.attributes?.periodTo || r.row.attributes.periodTo >= q.from) && (!q.to || !r.row.attributes?.periodFrom || r.row.attributes.periodFrom <= q.to));
    const conclusions = [];
    if(rec.invalidDecisions.length)conclusions.push(`В деле есть прежние подтверждения, не соответствующие единым правилам сверки: ${rec.invalidDecisions.length}. Они сохранены в истории, но не включены в оплаченные суммы; требуется проверка основания.`);
    for (const [c, n] of Object.entries(summary.supply))
        conclusions.push(`По исследованным действующим ЭСФ документально отражены поставки на ${formatMinor(n)} ${c}. Это объём ЭСФ, не сумма банковских поступлений.`);
    if (q.identifier)
        for (const c of unique([...Object.keys(summary.purchase), ...Object.keys(summary.sale)]))
            conclusions.push(`По участнику ${q.identifier}: приобретение ${formatMinor(summary.purchase[c] ?? '0')} ${c}, реализация ${formatMinor(summary.sale[c] ?? '0')} ${c}.`);
    const unmatched = rec.items.filter(x => x.status === 'unmatched').length, partial = rec.items.filter(x => x.status === 'partial').length;
    conclusions.push(`По ${unmatched} ЭСФ отсутствуют подтверждённые сотрудником соответствия оплат; частично распределённых оплат: ${partial}. Неподтверждённые кандидаты не приравнены к отсутствию банковского платежа.`);
    const confirmedTotals = {};
    for (const x of rec.items)
        if (x.allocations.length)
            add(confirmedTotals, x.invoice.currency, x.confirmedMinor);
    for (const [c, v] of Object.entries(confirmedTotals))
        conclusions.push(`Сотрудником сопоставлены с ЭСФ банковские оплаты на ${formatMinor(v)} ${c}.`);
    if (coverage.missingStatements)
        conclusions.push('Банковские выписки в выбранном массиве не представлены или не распознаны. Оплату и дальнейшее движение денег установить по одним ЭСФ нельзя.');
    if (coverage.partial.length || coverage.failed.length)
        conclusions.push('Набор прочитан не полностью: итоговые показатели охватывают только пригодные извлечённые записи.');
    return { version: FINANCIAL_VERSION, caseId, caseNumber: parent.caseNumber, title: q.documentId ? `Аналитический отчёт по документу ${docs[0]?.name || ''}` : q.identifier ? `Финансовый профиль ${q.identifier}` : `Финансовая сводка дела ${parent.caseNumber}`, filters: q, generatedAt: new Date().toISOString(), documents: docs, summary, counts: { invoices: invoices.length, sourceInvoiceRows: d.records.filter(r => r.row.type === 'invoice' && filter({ ...r.row, sources: [r.source] })).length, goodsRows: lines.length, physicalFiles: new Set(ops.flatMap(o => o.sources.map(s => s.documentId))).size, contracts: ops.filter(o => o.type === 'contract' && eligible(o)).length, contractReferences: unique(invoiceRows.map(o => o.contractRef)).length, documentedDeals: null, uniqueCounterparties: unique(invoices.flatMap(i => [i.senderId, i.recipientId]).filter(id => id !== q.identifier)).length, categories: categories.size, incomingInvoices: q.identifier ? invoices.filter(i => i.recipientId === q.identifier).length : null, outgoingInvoices: q.identifier ? invoices.filter(i => i.senderId === q.identifier).length : null, bankEntries: bank.length }, invoices: invoiceRows, lines, categories: [...categories.values()].map(c => ({ ...c, originalNames: [...c.originalNames], invoiceIds: [...c.invoiceIds], sources: refs(c.sources) })), periods: [...periods.values()].sort((a, b) => a.period.localeCompare(b.period)), counterparties: [...parties.values()], bank, bankDiagnostics, bankLedger: ledger.summaries, reconciliation: rec, taxes: { facts: taxRows.map(r => ({ ...r.row, source: r.source })), paidTaxes: null, incomeTax: null, note: 'НДС из ЭСФ не означает фактически уплаченный налог. Налоговые начисления, платежи, зачёт, возврат, недоимка и переплата не вычисляются без подтверждённых и сопоставленных налоговых источников.' }, coverage, conclusions, risks: d.analysis.risks.filter(r => !q.documentId || r.evidence?.some(s => s.documentId === q.documentId)), notes: ['Денежные итоги рассчитаны целочисленно в минимальных единицах (BigInt), без двоичного округления. Валюты не объединяются.', 'Товарные строки не равны числу ЭСФ, файлов, договоров или сделок. Количество сделок автоматически не установлено.', 'Нормализация названий не использует нечёткое объединение. Оригиналы сохранены; категории можно объединить или разделить вручную.', 'Процент расхождения: (сумма ЭСФ минус распределённая оплата) / модуль суммы ЭСФ. При нулевой сумме процент не определён.'], fingerprint: hash([ops.map(o => [o.id, o.fingerprint, o.reviewStatus]), [...d.categories], rec.allocations]) };
}
function validDay(v) { return /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v; }
export function saveFinancialDecision(db, caseId, input, context = {}) {
    migrateFinancial(db);
    scope(db, caseId, context, true);
    const note = String(input.note || '').trim();
    if (!note || note.length > 4000)
        throw new FinancialError('Укажите обоснование до 4000 символов');
    db.exec('BEGIN IMMEDIATE');
    try {
        const d = data(db, caseId, context), user = context.userId || currentUserId() || DEFAULT_USER_ID, now = new Date().toISOString();
        let details, action;
        if (input.action === 'category') {
            const term = normalizeCategory(input.term), category = String(input.category || '').trim();
            if (!term || term.length > 500 || !category || category.length > 250 || !d.records.some(r => normalizeCategory(r.row.esf?.goodsName || r.row.purpose) === term))
                throw new FinancialError('Выберите наименование из документов дела и категорию до 250 символов');
            const before = db.prepare('SELECT category FROM case_financial_categories WHERE case_id=? AND term=?').get(caseId, term);
            db.prepare('INSERT INTO case_financial_categories VALUES(?,?,?,?,?,?) ON CONFLICT(case_id,term) DO UPDATE SET category=excluded.category,note=excluded.note,updated_by=excluded.updated_by,updated_at=excluded.updated_at').run(caseId, term, category, note, user, now);
            action = 'case.financial_category_changed';
            details = { term, before: before?.category || term, category, note };
        }
        else if (input.action === 'allocation') {
            const i = d.ops.find(o => o.id === input.invoiceId), p = d.ops.find(o => o.id === input.paymentId);
            if (!i || !p || i.type !== 'invoice' || p.type !== 'payment' || !eligible(i) || !eligible(p))
                throw new FinancialError('Выберите пригодные ЭСФ и платёж этого дела');
            if (i.fingerprint !== input.invoiceFingerprint || p.fingerprint !== input.paymentFingerprint)
                throw new FinancialError('Реквизиты изменились: обновите отчёт', 409);
            const status = String(input.status || '');
            if (!['confirmed', 'rejected', 'pending'].includes(status))
                throw new FinancialError('Некорректное решение');
            const rule=invoicePaymentEligibility(i,p,verifiedPartyEvidence(db,caseId,i,p));
            if(status==='confirmed'&&!rule.eligible)throw new FinancialError('Нужны обратные стороны и одна валюта. '+rule.reason);
            const n = BigInt(decimalMinor(input.amount));
            if (n <= 0n || n > BigInt(p.amountMinor) || BigInt(i.amountMinor) <= 0n)
                throw new FinancialError('Распределение должно быть положительным и не превышать сумму платежа');
            const rec = reconciliation(db, caseId, d), capacity=paymentCapacityKey(p), others = rec.allocations.filter(a => paymentCapacityKey(d.ops.find(o=>o.id===a.paymentId))===capacity && !(a.invoiceId===i.id&&a.paymentId===p.id)), used = others.reduce((v, a) => v + BigInt(a.amountMinor), 0n);
            if (status === 'confirmed' && used + n > BigInt(p.amountMinor))
                throw new FinancialError('Сумма распределений превышает платёж');
            const old = db.prepare('SELECT * FROM case_payment_allocations WHERE case_id=? AND invoice_key=? AND payment_key=?').get(caseId, i.externalKey, p.externalKey);
            // Existing legacy decisions must be explicitly reset, not silently overridden or counted twice.
            const legacy = db.prepare("SELECT 1 FROM case_matching_reviews WHERE case_id=? AND right_key=? AND status='confirmed' AND right_fingerprint=?").get(caseId, p.externalKey, p.fingerprint);
            if (legacy)
                throw new FinancialError('Сначала сбросьте прежнее полное соответствие платежа в карточке расхождения');
            const review = reviewSubject(db, caseId, { kind: 'match', leftKey: i.externalKey, rightKey: p.externalKey });
            review.before = { status: old?.status || 'pending', note: old?.note || '' };
            review.title = `Распределение ${formatMinor(n.toString())} ${i.currency}: ЭСФ ${i.number} и платёж ${p.number}`;
            db.prepare('INSERT INTO case_payment_allocations VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(case_id,invoice_key,payment_key) DO UPDATE SET invoice_fingerprint=excluded.invoice_fingerprint,payment_fingerprint=excluded.payment_fingerprint,amount_minor=excluded.amount_minor,status=excluded.status,note=excluded.note,updated_by=excluded.updated_by,updated_at=excluded.updated_at').run(caseId, i.externalKey, p.externalKey, i.fingerprint, p.fingerprint, n.toString(), status, note, user, now);
            action = 'case.match_reviewed';
            details = { leftKey: i.externalKey, rightKey: p.externalKey, status, note, review, allocationMinor: n.toString() };
        }
        else if(input.action==='party_evidence'){
            const i=d.ops.find(o=>o.id===input.invoiceId),p=d.ops.find(o=>o.id===input.paymentId),e=d.ops.find(o=>o.id===input.evidenceId),status=String(input.status||'');
            if(!i||!p||!e||!['confirmed','rejected','pending'].includes(status))throw new FinancialError('Выберите ЭСФ, платёж, подтверждающую операцию и решение');
            if(i.fingerprint!==input.invoiceFingerprint||p.fingerprint!==input.paymentFingerprint||e.fingerprint!==input.evidenceFingerprint)throw new FinancialError('Исходные реквизиты изменились',409);
            if(status==='confirmed'&&(!thirdPartySupport(i,p,e)||!invoicePaymentEligibility(i,{...p,senderId:i.recipientId}).eligible))throw new FinancialError('Нужен пригодный договор/первичный документ между плательщиком и покупателем со ссылкой на эту ЭСФ, одна валюта и допустимый коммерческий платёж поставщику');
            const before=db.prepare('SELECT status,note FROM case_payment_party_evidence WHERE case_id=? AND invoice_key=? AND payment_key=?').get(caseId,i.externalKey,p.externalKey);
            db.prepare('INSERT INTO case_payment_party_evidence VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(case_id,invoice_key,payment_key) DO UPDATE SET invoice_fingerprint=excluded.invoice_fingerprint,payment_fingerprint=excluded.payment_fingerprint,evidence_key=excluded.evidence_key,evidence_fingerprint=excluded.evidence_fingerprint,status=excluded.status,note=excluded.note,updated_by=excluded.updated_by,updated_at=excluded.updated_at').run(caseId,i.externalKey,p.externalKey,i.fingerprint,p.fingerprint,e.externalKey,e.fingerprint,status,note,user,now);
            action='case.analysis_reviewed';details={kind:'risk',id:'party-evidence:'+hash([i.externalKey,p.externalKey]),status,note,review:{version:1,kind:'risk',title:`Основание платежа третьим лицом: ЭСФ ${i.number}, платёж ${p.number}`,sources:refs([...i.sources,...p.sources,...e.sources]),parties:unique([i.senderId,i.recipientId,p.senderId]).map(identifier=>({identifier,name:identifier})),before:before||{status:'pending',note:''},available:true}};
        }
        else if(input.action==='signal'){
            const filters=input.filters&&typeof input.filters==='object'&&!Array.isArray(input.filters)?Object.fromEntries(Object.entries(input.filters).filter(([k,v])=>['identifier','documentId','from','to','currency','account','purpose','operation','largeThreshold','onwardDays','toleranceBps','concentrationBps','bankKind'].includes(k)&&typeof v==='string')):{};
            const report=financialReport(db,caseId,filters,context),signal=report.signalAnalysis.items.find(s=>s.id===input.signalId),status=String(input.status||'');
            if(!signal)throw new FinancialError('Сигнал отсутствует в текущей выборке',404);
            if(signal.fingerprint!==input.fingerprint)throw new FinancialError('Расчёт или источники изменились: обновите анализ',409);
            if(!['confirmed','rejected','pending','checking'].includes(status))throw new FinancialError('Некорректное решение по сигналу');
            const before=db.prepare('SELECT status,note FROM case_financial_signal_reviews WHERE case_id=? AND signal_id=?').get(caseId,signal.id);
            db.prepare('INSERT INTO case_financial_signal_reviews VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(case_id,signal_id) DO UPDATE SET fingerprint=excluded.fingerprint,status=excluded.status,note=excluded.note,filters_json=excluded.filters_json,updated_by=excluded.updated_by,updated_at=excluded.updated_at').run(caseId,signal.id,signal.fingerprint,status,note,JSON.stringify(filters),user,now);
            action='case.analysis_reviewed';details={kind:'risk',id:signal.id,status,note,review:{version:1,kind:'risk',title:signal.title,sources:signal.sources,parties:unique(signal.entries.flatMap(e=>[e.senderId,e.recipientId])).filter(id=>/^\d{12}$/.test(id)).map(identifier=>({identifier,name:identifier})),before:before||{status:'pending',note:''},available:true},condition:signal.condition,calculation:signal.calculation,limitations:signal.limitations};
        }
        else
            throw new FinancialError('Неизвестное действие');
        db.prepare("INSERT INTO audit_log(id,department_id,user_id,action,entity_type,entity_id,details_json,created_at) VALUES(?,?,?,?,'case',?,?,?)").run(randomUUID(), context.departmentId || DEFAULT_DEPARTMENT_ID, user, action, caseId, JSON.stringify(details), now);
        db.exec('COMMIT');
        return { ok: true };
    }
    catch (e) {
        db.exec('ROLLBACK');
        throw e;
    }
}
