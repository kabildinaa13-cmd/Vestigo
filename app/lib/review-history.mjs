import { createHash } from "node:crypto";
import { getCase, DEFAULT_DEPARTMENT_ID, DEFAULT_USER_ID } from "./vestigo-db.mjs";
export const REVIEW_HISTORY_VERSION = "review-history-1.0";
export class ReviewHistoryError extends Error {
    constructor(message, status = 400) { super(message); this.status = status; }
}
const parse = (value, fallback = {}) => { try {
    return JSON.parse(value || "");
}
catch {
    return fallback;
} };
const norm = value => String(value ?? "").normalize("NFKC").toLocaleLowerCase("ru").replace(/ё/g, "е").trim();
export const REVIEW_STATES = { pending: "Не подтверждено", detected: "Требует рассмотрения", checking: "Проверяется", confirmed: "Подтверждено сотрудником", rejected: "Отклонено", insufficient_data: "Недостаточно данных", closed: "Проверка завершена" };
export const REVIEW_KINDS = { match_confirmed: "Подтверждение соответствия документов", match_rejected: "Отклонение связи документов", risk_confirmed: "Подтверждение расхождения / вопроса", risk_rejected: "Отклонение расхождения / вопроса", operation_confirmed: "Подтверждение операции", operation_rejected: "Отклонение операции", status_changed: "Изменение статуса проверки", comment_added: "Комментарий или обоснование", decision_changed: "Изменение ранее принятого решения" };
const typeName = { invoice: "ЭСФ", payment: "Платёж", contract: "Договор", primary: "Первичный документ", accounting: "Учётная операция", claim: "Заявленное требование", reimbursement: "Возмещение" };
Object.assign(REVIEW_KINDS,{group_confirmed:'Подтверждение группировки наименований',group_rejected:'Отклонение группировки наименований',group_reverted:'Отмена группировки наименований'});
function scope(db, caseId, context = {}) { if (!getCase(db, caseId, context.departmentId || DEFAULT_DEPARTMENT_ID))
    throw new ReviewHistoryError("Дело не найдено", 404); }
function operation(db, caseId, id, key) { return db.prepare(`SELECT o.id,o.operation_type type,o.external_key,o.occurred_at date,x.details_json,x.review_status,x.review_note FROM operations o JOIN case_operation_details x ON x.operation_id=o.id WHERE o.case_id=? AND ${key ? "o.external_key" : "o.id"}=?`).get(caseId, String(key || id || "")); }
function operationTitle(o) { if (!o)
    return "Операция из ранее обработанных материалов"; const d = parse(o.details_json); return `${typeName[o.type] || "Операция"}${d.number ? ` «${d.number}»` : " без номера"}${o.date ? ` от ${o.date}` : ""}`; }
function sourceDocument(db, caseId, s) {
    const row = db.prepare("SELECT d.id,d.original_name FROM documents d JOIN case_documents c ON c.document_id=d.id WHERE c.case_id=? AND d.id=?").get(caseId, String(s.documentId || ""));
    if (!row)
        return null;
    return { documentId: row.id, name: row.original_name, sheet: String(s.sheet || ""), row: Number.isSafeInteger(s.row) && s.row > 0 ? s.row : 0, page: Number(s.page) || Number(String(s.sheet || "").match(/PDF(?: bank)? (\d+)/)?.[1] || 0) };
}
// A small immutable context is appended to NEW audit events. Old events are never rewritten.
export function reviewSubject(db, caseId, input) {
    let title = "Аналитический результат", rawSources = [], partyRecords = [], previousStatus = null, previousNote = "", available = false;
    if (input.kind === "risk") {
        const r = db.prepare("SELECT d.description,d.status,x.evidence_json,x.review_note FROM discrepancies d JOIN case_risk_details x ON x.discrepancy_id=d.id WHERE d.case_id=? AND d.id=?").get(caseId, String(input.id || ""));
        if (r) {
            title = r.description;
            rawSources = parse(r.evidence_json, []);
            previousStatus = r.status;
            previousNote = r.review_note;
            available = true;
        }
        else
            title = "Расхождение из ранее обработанных материалов (описание не сохранено)";
    }
    else {
        const ops = input.kind === "match" ? [operation(db, caseId, null, input.leftKey), operation(db, caseId, null, input.rightKey)] : [operation(db, caseId, input.id)];
        title = input.kind === "match" ? `Соответствие: ${operationTitle(ops[0])} ↔ ${operationTitle(ops[1])}` : operationTitle(ops[0]);
        for (const o of ops.filter(Boolean)) {
            const details = parse(o.details_json);
            partyRecords.push(details);
            rawSources.push(...(details.sources || []));
            available = true;
        }
        if (input.kind === "match") {
            const old = db.prepare("SELECT status,note FROM case_matching_reviews WHERE case_id=? AND left_key=? AND right_key=?").get(caseId, input.leftKey, input.rightKey);
            previousStatus = old?.status || "pending";
            previousNote = old?.note || "";
        }
        else {
            previousStatus = ops[0]?.review_status || null;
            previousNote = ops[0]?.review_note || "";
        }
    }
    const sources = [...new Map(rawSources.map(s => sourceDocument(db, caseId, s)).filter(Boolean).map(s => [[s.documentId, s.sheet, s.row, s.page].join(":"), s])).values()];
    for (const s of sources)
        if (s.row) {
            const record = db.prepare("SELECT record_json FROM case_extracted_rows WHERE case_id=? AND document_id=? AND sheet=? AND row_number=?").get(caseId, s.documentId, s.sheet, s.row);
            if (record)
                partyRecords.push(parse(record.record_json));
        }
    const parties = new Map();
    for (const row of partyRecords)
        for (const [identifier, name] of [[row.senderId, row.senderName], [row.recipientId, row.recipientName]])
            if (/^\d{12}$/.test(identifier || ""))
                parties.set(identifier, { identifier, name: String(name || `БИН/ИИН ${identifier}`) });
    return { version: 1, kind: input.kind, title, parties: [...parties.values()], sources, before: { status: previousStatus, note: previousNote }, available };
}
function kindOf(kind, status, before, note) {
    if (kind === 'group') return status === 'confirmed' ? 'group_confirmed' : status === 'rejected' ? 'group_rejected' : 'group_reverted';
    if (before?.status === status && before.note !== note)
        return "comment_added";
    if (kind === "match" && ["confirmed", "rejected"].includes(status))
        return "match_" + status;
    if (kind === "risk" && ["confirmed", "rejected"].includes(status))
        return "risk_" + status;
    if (kind === "operation" && ["confirmed", "rejected"].includes(status))
        return "operation_" + status;
    return "status_changed";
}
function actor(row) { const legacy = row.user_id === DEFAULT_USER_ID || !row.login; return { key: legacy ? "legacy-manual" : row.login, name: legacy ? "Сотрудник не зафиксирован (старый режим)" : row.display_name || row.login, login: legacy ? "" : row.login }; }
function validateDate(value) { if (!value)
    return ""; if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)
    throw new ReviewHistoryError("Некорректная дата фильтра"); return value; }
function publicSource(db, caseId, s) {
    const known = sourceDocument(db, caseId, s);
    if (!known)
        return { name: String(s.name || "Источник из прежней версии анализа"), location: "Источник больше не привязан к делу", originalUrl: null };
    return { name: known.name, location: known.page ? `Страница ${known.page}` : known.row ? `${known.sheet || "Таблица"}, строка ${known.row}` : "Документ целиком", originalUrl: `/api/documents/${encodeURIComponent(known.documentId)}?caseId=${encodeURIComponent(caseId)}${known.page ? `&inline=1#page=${known.page}` : ""}` };
}
export function reviewHistory(db, caseId, query = {}, context = {}) {
    scope(db, caseId, context);
    const from = validateDate(String(query.from || "")), to = validateDate(String(query.to || ""));
    if (from && to && from > to)
        throw new ReviewHistoryError("Начало периода позже окончания");
    if (query.kind && !Object.hasOwn(REVIEW_KINDS, query.kind))
        throw new ReviewHistoryError("Неизвестный вид решения");
    if (query.status && !Object.hasOwn(REVIEW_STATES, query.status))
        throw new ReviewHistoryError("Неизвестный статус проверки");
    let dateFormat;
    try {
        dateFormat = new Intl.DateTimeFormat("en-CA", { timeZone: String(query.timeZone || "Asia/Qyzylorda"), year: "numeric", month: "2-digit", day: "2-digit" });
    }
    catch {
        throw new ReviewHistoryError("Некорректный часовой пояс");
    }
    const day = value => { const date = new Date(value); if (!Number.isFinite(date.getTime()))
        return ""; const p = Object.fromEntries(dateFormat.formatToParts(date).map(p => [p.type, p.value])); return `${p.year}-${p.month}-${p.day}`; };
    // Allowlist excludes processing, extraction, jobs and automatic risk generation at the database query.
    const events = db.prepare(`SELECT a.rowid AS sequence,a.action,a.details_json,a.created_at,a.user_id,u.login,u.display_name FROM audit_log a LEFT JOIN users u ON u.id=a.user_id AND u.department_id=a.department_id WHERE a.entity_type='case' AND a.entity_id=? AND a.department_id=? AND a.action IN ('case.analysis_reviewed','case.match_reviewed','case.goods_group_reviewed','case.financial_category_changed','case.workflow_reviewed') ORDER BY a.created_at,a.rowid`).all(caseId, context.departmentId || DEFAULT_DEPARTMENT_ID);
    const seen = new Set(), all = [], legacySubjects = new Map();
    for (const event of events) {
        const details = parse(event.details_json), kind = event.action === "case.match_reviewed" ? "match" : event.action === 'case.financial_category_changed' ? 'group' : details.kind;
        if(event.action === 'case.financial_category_changed') {
            details.id = 'legacy-category:' + details.term; details.status = 'confirmed';
            details.review = {version:1,kind:'group',title:`Категория «${details.category}» для «${details.term}»`,parties:[],sources:[],before:{status:null,note:`Ранее: ${details.before || 'исходное наименование'}`},available:true};
        }
        if (!["match", "risk", "operation", "group", "workflow"].includes(kind) || !Object.hasOwn(REVIEW_STATES, details.status) || typeof details.note !== "string")
            continue;
        const key = kind === "match" ? JSON.stringify([kind, details.leftKey, details.rightKey]) : JSON.stringify([kind, details.id]);
        if (kind === "match" && (!details.leftKey || !details.rightKey) || kind !== "match" && !details.id)
            continue;
        const captured = details.review?.version === 1 && details.review.kind === kind ? details.review : null;
        if (!captured && !legacySubjects.has(key))
            legacySubjects.set(key, reviewSubject(db, caseId, { kind, id: details.id, leftKey: details.leftKey, rightKey: details.rightKey }));
        const subject = captured || legacySubjects.get(key);
        const before = captured?.before || { status: null, note: "" }, decisionKind = kindOf(kind, details.status, before, details.note);
        const changed = seen.has(key) && !!captured && (before.status !== details.status||captured.changed===true);
        const sources = (subject.sources || []).map(s => publicSource(db, caseId, s));
        all.push({ sequence: event.sequence, createdAt: event.created_at, employee: actor(event), title: subject.title, kind: decisionKind, kindLabel: REVIEW_KINDS[decisionKind], previousState: before.status ? REVIEW_STATES[before.status] || "Состояние не определено" : "Не зафиксировано в старой записи", newState: REVIEW_STATES[details.status], status: details.status, previousNote: before.note || "", reason: details.note, parties: subject.parties || [], documents: sources, changed, legacy: !captured, contextNote: captured ? "" : subject.available ? "Описание объекта восстановлено по текущим материалам. Старый журнал не сохранял его снимок и предыдущее состояние." : "В старой записи не сохранено описание объекта и его источников.", targetKey: createHash("sha256").update(key).digest("hex") });
        seen.add(key);
    }
    const employees = [...new Map(all.map(e => [e.employee.key, e.employee])).values()].sort((a, b) => a.name.localeCompare(b.name, "ru"));
    const counterparty = norm(String(query.counterparty || "").slice(0, 250)), employee = String(query.employee || "").slice(0, 120);
    const filtered = all.filter(e => (!from || day(e.createdAt) >= from) && (!to || day(e.createdAt) <= to) && (!employee || e.employee.key === employee) && (!query.status || e.status === query.status) && (!query.kind || (query.kind === "decision_changed" ? e.changed : e.kind === query.kind)) && (!counterparty || e.parties.some(p => norm(`${p.name} ${p.identifier}`).includes(counterparty))));
    const latest = [...new Map(filtered.map(e => [e.targetKey, e])).values()], offset = Math.max(0, Math.floor(Number(query.offset) || 0)), limit = Math.max(1, Math.min(100, Math.floor(Number(query.limit) || 20)));
    return { version: REVIEW_HISTORY_VERSION, total: filtered.length, allDecisions: all.length, offset, limit, items: filtered.slice().reverse().slice(offset, offset + limit).map(({ targetKey, ...e }) => e), stats: { reviewed: latest.length, confirmations: latest.filter(e => e.status === "confirmed").length, rejections: latest.filter(e => e.status === "rejected").length, unfinished: latest.filter(e => ["pending", "checking", "insufficient_data", "detected"].includes(e.status)).length }, filters: { employees, kinds: REVIEW_KINDS, statuses: REVIEW_STATES }, emptyMessage: all.length ? "По выбранным фильтрам записи не найдены" : "Сотрудники пока не принимали решений по результатам анализа", statisticsNote: "Показатели рассчитаны по последнему решению для каждого вопроса среди отфильтрованных записей. Автоматические результаты сюда не включены.", systemLogAvailable: false };
}
// All password accounts currently have equal rights. Historical users.role and client flags
// are NOT an administrator permission. Fail closed until a real server-side policy exists.
export function systemLog() { throw new ReviewHistoryError("Системный журнал недоступен: администраторские права в этой установке не настроены", 403); }
