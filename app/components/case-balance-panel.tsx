"use client";
import { useEffect, useMemo, useState } from 'react';
import { FinancialGraphExtension } from './financial-profile-panel';
import GoodsAnalysisPanel from './goods-analysis-panel';
import OrganizationPicker from './organization-picker';
import DocumentNoticeGroups from './document-notice-groups';
type Data = Record<string, any>;
const reasonLabels: Record<string, string> = { included: 'Включены в операции', context: 'Контекст, не денежная операция', cancelled: 'Отменённая ЭСФ', superseded: 'Заменены исправленной ЭСФ', incomplete: 'Не хватает реквизитов', conflict: 'Конфликт реквизитов', rejected: 'Отклонены сотрудником' };
function money(v: unknown, c = '') { try {
    if (v === undefined || v === null)
        throw 0;
    const n = BigInt(String(v)), a = n < 0n ? -n : n;
    return `${n < 0n ? '−' : ''}${(a / 100n).toLocaleString('ru-RU')},${String(a % 100n).padStart(2, '0')} ${c}`;
}
catch {
    return 'Нет данных';
} }
function Totals({ values }: {
    values: Data;
}) { return Object.keys(values || {}).length ? <>{Object.entries(values).map(([c, v]) => <span className="balance-value" key={c}>{money(v).trim()}<span className="balance-currency"> {c}</span></span>)}</> : <>Нет данных</>; }
function Sources({ items, caseId, onDocument }: {
    items: Data[];
    caseId: string;
    onDocument: (id: string) => void;
}) { return <details><summary>Первоисточники ({items.length})</summary>{items.map((s, i) => <p key={i}><button onClick={() => onDocument(s.documentId)}>{s.name || 'Документ'}</button> · {s.sheet}, строка {s.row} <a href={`/api/documents/${s.documentId}?caseId=${encodeURIComponent(caseId)}`} target="_blank" rel="noreferrer">Оригинал</a></p>)}</details>; }
function Rows({ items, columns, render }: {
    items: Data[];
    columns: [
        string,
        string
    ][];
    render: (r: Data) => React.ReactNode;
}) {
    const [sort, setSort] = useState(''), [asc, setAsc] = useState(true), [page, setPage] = useState(0);
    const sorted = useMemo(() => [...items].sort((a, b) => { if (!sort)
        return 0; const x = a[sort], y = b[sort]; let v = 0; if (sort.endsWith('Minor')) {
        const l = BigInt(x ?? 0), r = BigInt(y ?? 0);
        v = l < r ? -1 : l > r ? 1 : 0;
    }
    else
        v = String(x ?? '').localeCompare(String(y ?? ''), 'ru', { numeric: true }); return asc ? v : -v; }), [items, sort, asc]);
    useEffect(() => setPage(0), [items, sort, asc]);
    return <><div className="center-table-scroll"><table><thead><tr>{columns.map(([key, title]) => <th key={key} aria-sort={sort === key ? (asc ? 'ascending' : 'descending') : 'none'}><button onClick={() => { if (sort === key)
        setAsc(a => !a);
    else {
        setSort(key);
        setAsc(true);
    } }}>{title}{sort === key ? (asc ? ' ↑' : ' ↓') : ''}</button></th>)}</tr></thead><tbody>{sorted.slice(page * 20, page * 20 + 20).map(render)}</tbody></table></div>{!items.length && <p>Нет записей для выбранных условий.</p>}{items.length > 20 && <div className="analysis-pagination"><button disabled={!page} onClick={() => setPage(p => p - 1)}>Назад</button><span>{page * 20 + 1}–{Math.min(items.length, page * 20 + 20)} из {items.length}</span><button disabled={(page + 1) * 20 >= items.length} onClick={() => setPage(p => p + 1)}>Далее</button></div>}</>;
}
export default function CaseBalancePanel({ caseId, revision, onDocument, onRisk, onNoticeDocument, onNoticeSource }: {
    caseId: string;
    revision: string;
    onDocument: (id: string) => void;
    onRisk: (id: string) => void;
    onNoticeDocument?: (id:string)=>void;
    onNoticeSource?: (source:Data)=>void;
}) {
    const [data, setData] = useState<Data | null>(null), [filters, setFilters] = useState<Record<string, string>>({}), [view, setView] = useState('overview'), [error, setError] = useState(''), [loading, setLoading] = useState(false);
    useEffect(() => { setData(null); setFilters({}); setView('overview'); setError(''); }, [caseId]);
    const query = useMemo(() => new URLSearchParams({ caseId, ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)) }).toString(), [caseId, filters]);
    useEffect(() => { const c = new AbortController(); setLoading(true); const timer = setTimeout(() => fetch(`/api/case-balance?${query}`, { signal: c.signal, cache: 'no-store' }).then(async (r) => { const p = await r.json(); if (!r.ok)
        throw new Error(p.error || 'Не удалось получить сводку'); return p; }).then(p => { setData(p); setError(''); }).catch(e => { if (!c.signal.aborted)
        setError(e.message); }).finally(() => { if (!c.signal.aborted)
        setLoading(false); }), 250); return () => { clearTimeout(timer); c.abort(); }; }, [query, revision]);
    const sourceProps = { caseId, onDocument };
    const metric = (title: string, value: React.ReactNode, next: string, operation = '') => <button className="financial-metric" onClick={() => { setView(next); if (operation && filters.identifier)
        setFilters(f => ({ ...f, operation })); }}><span>{title}</span><strong>{value}</strong><small>Открыть расшифровку</small></button>;
    const setOrganization = (identifier: string) => { setFilters(f => ({ ...f, identifier, operation: '' })); setView('invoices'); };
    return <section className="case-balance" aria-label="Картотека организаций"><h3>Картотека организаций</h3>
 <div className="analysis-toolbar financial-filters"><OrganizationPicker items={data?.organizationOptions ?? data?.organizations ?? []} value={filters.identifier||''} onChange={identifier=>setFilters(f=>({...f,identifier,operation:''}))}/><label>С даты<input type="date" value={filters.from || ''} onChange={e => setFilters(f => ({ ...f, from: e.target.value }))}/></label><label>По дату<input type="date" value={filters.to || ''} onChange={e => setFilters(f => ({ ...f, to: e.target.value }))}/></label><label>Вид операции<select disabled={!filters.identifier} value={filters.operation || ''} onChange={e => setFilters(f => ({ ...f, operation: e.target.value }))}><option value="">Приобретение и реализация</option><option value="purchase">Приобретение</option><option value="sale">Реализация</option></select></label><button onClick={() => setFilters({})}>Сбросить</button></div>
 {error && <p className="notice error" role="alert">{error}</p>}{loading && <p role="status">Пересчитываем по сохранённым источникам…</p>}
 {data && !loading && <><p className="stage-note">{data.selectedOrganization ? `Объект расчёта: ${data.selectedOrganization.name}, БИН/ИИН ${data.selectedOrganization.identifier}.` : 'Приобретение и реализация разных организаций не складываются. Выберите организацию или откройте её строку в таблице.'}</p>
 <div className="center-metrics">
 {metric('Приобретение по ЭСФ', filters.identifier ? <Totals values={data.summary.purchase}/> : <>Выберите организацию</>, 'invoices', 'purchase')}
 {metric('Реализация по ЭСФ', filters.identifier ? <Totals values={data.summary.sale}/> : <>Выберите организацию</>, 'invoices', 'sale')}
 {metric('НДС приобретения', filters.identifier ? <Totals values={data.summary.purchaseVat}/> : <>Выберите организацию</>, 'invoices', 'purchase')}
 {metric('НДС реализации', filters.identifier ? <Totals values={data.summary.saleVat}/> : <>Выберите организацию</>, 'invoices', 'sale')}
 {metric('Действующие ЭСФ', data.counts.invoices, 'invoices')}{metric('Уникальные товары и услуги', data.uniqueGoodsNames, 'goods')}
 {metric(filters.identifier ? 'Контрагенты организации' : 'Участники действующих ЭСФ', data.counts.uniqueCounterparties, 'organizations')}
 {metric('Выделенные договоры', data.counts.contracts, 'contracts')}{metric('Ссылки на договоры в ЭСФ', data.counts.contractReferences, 'contracts')}
 {metric('Документальные связи поставок', data.edges.filter((e: Data) => e.type === 'document_supply').length, 'links')}
 {metric('Банковские поступления', <Totals values={data.summary.bankIncoming}/>, 'bank')}{metric('Банковские списания', <Totals values={data.summary.bankOutgoing}/>, 'bank')}{metric('Банковские комиссии', <Totals values={data.summary.bankFees}/>, 'bank')}
 </div><p className="muted">Количество сделок отдельно не установлено. ЭСФ, товарная строка, договор и сделка не считаются одной величиной. Все суммы разделены по валютам.</p>
 <nav className="analysis-toolbar" aria-label="Расшифровки баланса">{[['overview','Общая финансовая картина'],['goods', 'Товары и услуги'], ['comparison', 'Приобретение / реализация'], ['organizations', 'Контрагенты'], ['reconciliation', 'Сверка ЭСФ и банков'], ['links', 'Финансовые и документальные связи'], ['questions', 'Вопросы проверки'], ['invoices', 'ЭСФ'], ['contracts', 'Договоры'], ['bank', 'Банковские данные'], ['audit', 'Проверка обработки']].map(([id, title]) => <button key={id} aria-pressed={view === id} onClick={() => setView(id)}>{title}</button>)}</nav>
 {view==='overview'&&<div className="center-item"><h4>Документальная финансовая картина</h4><p>Учтены только действующие, не исключённые ЭСФ без конфликтов реквизитов. Товарных строк: {data.counts.goodsRows}. Их стоимость не прибавляется повторно к итогам ЭСФ.</p><button onClick={()=>setView('invoices')}>Стоимость документальных поставок: <Totals values={data.summary.supply}/> — открыть ЭСФ и источники</button><p>Нажмите финансовый показатель выше, чтобы открыть его расшифровку. Для приобретения и реализации выберите организацию; для конкретной услуги — подраздел «Товары и услуги».</p><p className="muted">Банковские переводы, поставки по ЭСФ и предварительные аналитические соответствия учитываются раздельно.</p></div>}
 {view === 'organizations' && !filters.identifier && <><h4>Раздельные балансы организаций за выбранный период</h4><Rows items={data.organizations} columns={[["name", "Организация / БИН"], ["purchaseCount", "Приобретение / ЭСФ"], ["saleCount", "Реализация / ЭСФ"]]} render={e => <tr key={e.identifier}><td><button onClick={() => setOrganization(e.identifier)}>{e.name}</button><small>{e.identifier}</small></td><td><Totals values={e.purchase}/><small>{e.purchaseCount} ЭСФ</small></td><td><Totals values={e.sale}/><small>{e.saleCount} ЭСФ</small></td></tr>}/></>}
 {view === 'organizations' && filters.identifier && <><h4>Контрагенты выбранной организации</h4><Rows items={data.counterparties} columns={[["name", "Контрагент / БИН"], ["amountMinor", "Стоимость поставок"], ["invoices", "ЭСФ / первоисточники"]]} render={e => <tr key={e.identifier + e.currency}><td><button onClick={() => setOrganization(e.identifier)}>{e.name}</button><small>{e.identifier}</small></td><td>{money(e.amountMinor, e.currency)}</td><td>{e.invoices}<Sources items={e.sources} {...sourceProps}/></td></tr>}/></>}
 {view === 'invoices' && <><h4>ЭСФ, включённые в расчёт ({data.invoices.length})</h4><Rows items={data.invoices} columns={[["number", "ЭСФ / дата"], ["senderName", "Поставщик → покупатель"], ["amountMinor", "Стоимость с НДС"], ["vatMinor", "НДС"], ["contractRef", "Договор / строки"]]} render={i => <tr key={i.id}><td>{i.number}<small>{i.date} · {i.esf?.revision?.kind || 'ordinary'}</small></td><td>{i.senderName}<small>{i.senderId}</small> → {i.recipientName}<small>{i.recipientId}</small></td><td>{money(i.amountMinor, i.currency)}</td><td>{money(i.vatMinor, i.currency)}</td><td>{i.contractRef || 'Не указан'}<small>Товарных строк: {i.lines.length}</small><Sources items={i.sources} {...sourceProps}/></td></tr>}/></>}
 {['goods','comparison','reconciliation','questions'].includes(view) && <GoodsAnalysisPanel caseId={caseId} revision={revision} mode={view} filters={filters} onDocument={onDocument}/>}
 {view === 'contracts' && <><p>Договоров, выделенных из самостоятельных документов: {data.counts.contracts}. Ссылки в ЭСФ не подтверждают наличие текста договора или число сделок.</p><Rows items={data.invoices.filter((i: Data) => i.contractRef)} columns={[["contractRef", "Ссылка на договор"], ["number", "ЭСФ"], ["amountMinor", "Стоимость ЭСФ / источник"]]} render={i => <tr key={i.id}><td>{i.contractRef}</td><td>{i.number}</td><td>{money(i.amountMinor, i.currency)}<Sources items={i.sources} {...sourceProps}/></td></tr>}/></>}
 {view === 'links' && <><p>Поставщик → покупатель: документальные поставки по ЭСФ. Это не подтверждённые банковские перечисления.</p>{data.graphDiagnostics && <p className="stage-note">{data.graphDiagnostics}</p>}<Rows items={data.edges.filter((e: Data) => e.type === 'document_supply')} columns={[["senderName", "Поставщик"], ["recipientName", "Покупатель"], ["amountMinor", "Сумма поставок"], ["count", "Количество ЭСФ / расшифровка"]]} render={e => <tr key={e.id}><td>{e.senderName}<small>{e.senderId}</small></td><td>{e.recipientName}<small>{e.recipientId}</small></td><td>{money(e.amountMinor, e.currency)}</td><td><details><summary>{e.count} ЭСФ</summary>{e.operations.map((i: Data) => <p key={i.id}>{i.number} · {i.date} · {money(i.amountMinor, i.currency)}</p>)}<Sources items={e.sources} {...sourceProps}/></details></td></tr>}/><FinancialGraphExtension caseId={caseId} identifier={filters.identifier || ''}/><a href={`/analytics?caseId=${encodeURIComponent(caseId)}${filters.identifier ? `&bin=${filters.identifier}` : ''}`}>Открыть существующую карту связей →</a></>}
 {view === 'bank' && <>{data.matchingDiagnostic ? <p className="stage-note">{data.matchingDiagnostic}</p> : <><p>Банковских записей: {data.bank.length}. Подтверждённые распределения оплат: {data.reconciliation.allocations.length}; ЭСФ без подтверждённых соответствий: {data.reconciliation.items.filter((x: Data) => x.status === 'unmatched').length}. Это не утверждение о неоплате.</p><Rows items={data.bank} columns={[["date", "Дата"], ["amountMinor", "Сумма"], ["feeMinor", "Комиссия"], ["purpose", "Назначение / источник"]]} render={b => <tr key={b.id}><td>{b.date}</td><td>{money(b.amountMinor, b.currency)}</td><td>{money(b.feeMinor, b.currency)}</td><td>{b.purpose}<Sources items={b.sources} {...sourceProps}/></td></tr>}/></>}<p>Банковские переводы и документальная реализация учитываются раздельно. Сверка с решениями сотрудников доступна во вкладке «Финансовый анализ».</p></>}
 {view === 'audit' && <><h4>Проверка обработки всех файлов дела</h4>{data.audit.map((d: Data) => <details key={d.id} className="center-item"><summary>{d.name} · {d.rows} строк · {d.invoiceIds} номеров ЭСФ · {d.operations} операций</summary><p>{d.contextOnly ? 'Прочитан как контекст; создание денежных операций не требуется.' : `Статус: ${d.status}`}</p>{d.profile && <p>{d.profile.note}</p>}<p>{Object.entries(d.reasons).map(([k, v]) => `${reasonLabels[k] || k}: ${v}`).join('; ')}</p><button onClick={() => onDocument(d.id)}>Открыть прочитанные данные</button><Rows items={d.invoices} columns={[["number", "ЭСФ"], ["status", "Состояние"], ["amountMinor", "Сумма / исходные строки"]]} render={i => <tr key={i.number}><td>{i.number}</td><td>{i.status}</td><td>{money(i.amountMinor, i.currency)}<Sources items={i.rows} {...sourceProps}/></td></tr>}/><details><summary>Каждая исходная строка и причина включения / исключения</summary>{d.outcomes.map((r: Data) => <p key={r.source.sheet + r.source.row}>{r.source.sheet}, строка {r.source.row}: {r.number} — {reasonLabels[r.reason]}</p>)}</details></details>)}<details><summary>Повторы между выгрузками ({data.repeatChecks.copies.length})</summary>{data.repeatChecks.copies.map((c: Data) => <article key={c.number}><p>{c.number} · {c.date} · {c.senderId} → {c.recipientId} · {money(c.amountMinor, c.currency)}</p><p>{c.basis}</p><Sources items={c.sources} {...sourceProps}/></article>)}</details><details><summary>Разные ЭСФ с одинаковыми суммами — не дубли ({data.repeatChecks.sameAmountDifferentInvoices.length} групп)</summary>{data.repeatChecks.sameAmountDifferentInvoices.map((g: Data, n: number) => <article key={n}><p>{g.basis}</p>{g.items.map((i: Data) => <div key={i.id}><p>{i.number} · {i.date} · {i.senderId} → {i.recipientId} · {money(i.amountMinor, i.currency)}</p><Sources items={i.sources} {...sourceProps}/></div>)}</article>)}</details></>}
 <h4>Замечания по документам</h4>{data.coverage.missingStatements && <p className="stage-note">Сверка оплат не выполнена: банковские выписки не представлены. Отсутствие финансовых расхождений не подтверждает полноту оплат.</p>}<DocumentNoticeGroups items={data.warningGroups.flatMap((g:Data)=>g.items)} documents={data.documents} caseId={caseId} includeDocumentErrors onDocument={onNoticeDocument||onDocument} onSource={onNoticeSource} onSelectEvent={onRisk}/><p className="muted">Закрытые и прежние результаты сохранены в «Расхождениях» с фильтром «Включая закрытые». Ошибки обработки, финансовые расхождения и аналитические сигналы показаны раздельно.</p>
 </>}
 </section>;
}
