"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import DocumentsPanel from "@/app/components/documents-panel";
import CaseAnalysisPanel from "@/app/components/case-analysis-panel";
import CalculationsPanel from "@/app/components/calculations-panel";
import ReportsPanel from "@/app/components/reports-panel";
import CaseDeleteDialog from "@/app/components/case-delete-dialog";
import CaseEditDialog from "@/app/components/case-edit-dialog";
import CaseWorkflowPanel from "@/app/components/case-workflow-panel";
import AnalysisCenterPanel from "@/app/components/analysis-center-panel";
import PlatformSidebar, {UiIcon} from "@/app/components/platform-sidebar";
import {ThemeToggle} from "@/app/components/theme-provider";
import "./analytics-entry.css";
import "./case-analysis.css";
import "./case-trash.css";

type Tab = "Дело" | "Документы" | "Операции" | "Расчёт ущерба" | "Проверка" | "Отчёты";
type CaseItem = {
  id: string; caseNumber: string; erdrNumber: string; unitName: string; responsibleName: string;
  createdAt: string; updatedAt: string; periodFrom: string; periodTo: string;
  qualifications: string[]; status: string; description: string; version: number;
};
type Episode = { id: string; caseId: string; title: string; description: string; periodFrom: string; periodTo: string; status: string; createdAt: string };
type Dashboard = {
  department: { id: string; code: string; name: string };
  cases: number; activeCases: number; episodes: number; documents: number; operations: number;
  calculations: number; discrepancies: number; reimbursements: number; reports: number; latestCases: CaseItem[];
};

const tabs: Tab[] = ["Дело", "Документы", "Операции", "Расчёт ущерба", "Проверка", "Отчёты"];
const tabIcons:Record<Tab,string>={"Дело":"case","Документы":"documents","Операции":"operations","Расчёт ущерба":"calculation","Проверка":"review","Отчёты":"reports"};
const statusLabels: Record<string, string> = { draft: "Черновик", active: "В работе", suspended: "Приостановлено", completed: "Завершено", archived: "Архив" };

async function readJson(response: Response) {
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Ошибка запроса");
  return payload;
}

export default function VestigoPage() {
  const [tab, setTab] = useState<Tab>("Дело");
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [cases, setCases] = useState<CaseItem[]>([]);
  const [deletedCases,setDeletedCases]=useState<{id:string;caseNumber:string;deletedAt:string}[]>([]);
  const [trashOpen,setTrashOpen]=useState(false);
  const [deleteTarget,setDeleteTarget]=useState<CaseItem|null>(null);
  const [editTarget,setEditTarget]=useState<CaseItem|null>(null);
  const [selectedCaseId, setSelectedCaseId] = useState("");
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [caseFormOpen, setCaseFormOpen] = useState(false);
  const [episodeFormOpen, setEpisodeFormOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const selectedCase = useMemo(() => cases.find((item) => item.id === selectedCaseId) ?? null, [cases, selectedCaseId]);

  const refresh = useCallback(async () => {
    const [dashboardPayload, casesPayload,trashPayload] = await Promise.all([
      fetch("/api/dashboard", { cache: "no-store" }).then(readJson),
      fetch("/api/cases", { cache: "no-store" }).then(readJson),
      fetch("/api/cases?trash=1", {cache:"no-store"}).then(readJson),
    ]);
    setDashboard(dashboardPayload);
    setCases(casesPayload.cases);
    setDeletedCases(trashPayload.cases);
    const requested=new URLSearchParams(window.location.search).get("caseId");
    setSelectedCaseId((current) => current && casesPayload.cases.some((item: CaseItem) => item.id === current)
      ? current : (casesPayload.cases.find((item:CaseItem)=>item.id===requested)?.id ?? casesPayload.cases[0]?.id ?? ""));
  }, []);

  useEffect(() => { refresh().catch((reason) => setError(reason.message)); }, [refresh]);
  useEffect(()=>{const requested=new URLSearchParams(window.location.search).get("tab");if(tabs.includes(requested as Tab))setTab(requested as Tab);},[]);
  useEffect(()=>{if(!selectedCaseId)return;const url=new URL(window.location.href);url.searchParams.set("caseId",selectedCaseId);url.searchParams.set("tab",tab);window.history.replaceState(null,"",url);},[selectedCaseId,tab]);
  useEffect(() => {
    if (!selectedCaseId) { setEpisodes([]); return; }
    fetch(`/api/episodes?caseId=${encodeURIComponent(selectedCaseId)}`, { cache: "no-store" })
      .then(readJson).then((payload) => setEpisodes(payload.episodes)).catch((reason) => setError(reason.message));
  }, [selectedCaseId]);

  async function submitCase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      const payload = await fetch("/api/cases", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        caseNumber: data.get("caseNumber"), erdrNumber: data.get("erdrNumber"), unitName: data.get("unitName"),
        periodFrom: data.get("periodFrom"), periodTo: data.get("periodTo"), description: data.get("description"), qualifications:data.getAll('qualifications'),
      }) }).then(readJson);
      form.reset(); setCaseFormOpen(false); setTrashOpen(false); await refresh(); setSelectedCaseId(payload.case.id); setMessage("Дело сохранено в базе Vestigo.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Ошибка"); }
    finally { setBusy(false); }
  }

  async function submitEpisode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!selectedCase) return; setBusy(true); setError(""); setMessage("");
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      await fetch("/api/episodes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        caseId: selectedCase.id, title: data.get("title"), periodFrom: data.get("periodFrom"), periodTo: data.get("periodTo"), description: data.get("description"),
      }) }).then(readJson);
      form.reset(); setEpisodeFormOpen(false);
      const payload = await fetch(`/api/episodes?caseId=${encodeURIComponent(selectedCase.id)}`, { cache: "no-store" }).then(readJson);
      setEpisodes(payload.episodes); await refresh(); setMessage("Эпизод привязан к делу.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Ошибка"); }
    finally { setBusy(false); }
  }

  async function archiveCase() {
    if (!selectedCase || !confirm(`Переместить дело «${selectedCase.caseNumber}» в архив?`)) return;
    setBusy(true); setError("");
    try {
      await fetch("/api/cases", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: selectedCase.id, status: "archived" }) }).then(readJson);
      await refresh(); setMessage("Дело помещено в архив; запись сохранена в журнале действий.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Ошибка"); }
    finally { setBusy(false); }
  }

  async function deleteCase(id:string,confirmationNumber:string){
    setBusy(true);setError("");setMessage("");
    try{
      await fetch("/api/cases",{method:"DELETE",headers:{"content-type":"application/json"},body:JSON.stringify({id,confirmationNumber})}).then(readJson);
      setDeleteTarget(null);setEpisodeFormOpen(false);setSelectedCaseId(current=>current===id?"":current);
      const url=new URL(window.location.href);if(url.searchParams.get("caseId")===id){url.searchParams.delete("caseId");window.history.replaceState(null,"",url);}
      await refresh();setMessage("Дело удалено в корзину. Восстановить его можно в разделе «Корзина».");
    }catch(reason){setDeleteTarget(null);setError(reason instanceof Error?reason.message:"Не удалось удалить дело");}finally{setBusy(false);}
  }
  async function restoreDeletedCase(id:string){
    setBusy(true);setError("");setMessage("");
    try{const payload=await fetch("/api/cases",{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({id,action:"restore"})}).then(readJson);await refresh();setSelectedCaseId(payload.case.id);setTrashOpen(false);setMessage("Дело восстановлено вместе с документами и результатами анализа.");}
    catch(reason){setError(reason instanceof Error?reason.message:"Не удалось восстановить дело");}finally{setBusy(false);}
  }

  return (
    <main className="shell">
      <PlatformSidebar items={[...tabs.map(item=>({label:item,icon:tabIcons[item],active:tab===item,onClick:()=>setTab(item)})),{label:"Аналитика и граф дела",icon:"graph",href:selectedCaseId?`/analytics?caseId=${selectedCaseId}`:"/analytics"}]} profile={{name:"Локальный администратор",detail:"Администратор разработки"}}/>

      <section className="workspace">
        <header className="topbar"><div><p>{selectedCase?.caseNumber || "Дела и материалы"}</p><h1>{tab}</h1></div><ThemeToggle/></header>
        <div className="content">
          {deleteTarget&&<CaseDeleteDialog item={deleteTarget} busy={busy} onClose={()=>setDeleteTarget(null)} onConfirm={deleteCase}/>}
          {editTarget&&<CaseEditDialog key={editTarget.id+":"+editTarget.version} item={editTarget} onClose={()=>setEditTarget(null)} onSaved={async()=>{await refresh();setMessage("Реквизиты дела сохранены. Документы и результаты анализа не изменены.");}}/>}
          {error && <div className="notice error">{error}<button onClick={() => setError("")}>×</button></div>}
          {message && <div className="notice success">{message}<button onClick={() => setMessage("")}>×</button></div>}
          <section className="metrics">
            <Metric label="Дела" value={dashboard?.cases} detail={`${dashboard?.activeCases ?? 0} активных`} />
            <Metric label="Документы" value={dashboard?.documents} detail="только сохранённые" />
            <Metric label="Операции" value={dashboard?.operations} detail="извлечённые, требуют проверки" />
            <Metric label="Вопросы проверки" value={dashboard?.discrepancies} detail="открытые" />
          </section>

          {tab === "Дело" ? (
            <section className="case-layout">
              <div className="panel case-list-panel">
                <div className="panel-head"><div><span className="kicker">Реестр</span><h2>Дела и материалы</h2></div><button className="primary" onClick={() => setCaseFormOpen((value) => !value)}>+ Создать дело</button></div>
                {caseFormOpen && <form className="form-grid" onSubmit={submitCase}>
                  <label>Номер дела/материала<input name="caseNumber" required /></label>
                  <label>Номер ЕРДР<input name="erdrNumber" /></label>
                  <label>Подразделение<input name="unitName" /></label>
                  <label>Период с<input name="periodFrom" type="date" /></label>
                  <label>Период по<input name="periodTo" type="date" /></label>
                  <fieldset className="full"><legend>Предполагаемая квалификация — выбор сотрудника</legend>{['214','216'].map(q=><label key={q}><input type="checkbox" name="qualifications" value={q}/> Статья {q}</label>)}</fieldset>
                  <label className="full">Краткое описание<textarea name="description" rows={3} /></label>
                  <div className="form-actions full"><button type="button" onClick={() => setCaseFormOpen(false)}>Отмена</button><button className="primary" disabled={busy}>Сохранить</button></div>
                </form>}
                <div className="case-trash-tabs"><button aria-pressed={!trashOpen} onClick={()=>setTrashOpen(false)}>Рабочие дела ({cases.length})</button><button aria-pressed={trashOpen} onClick={()=>{setTrashOpen(true);setCaseFormOpen(false);}}>Корзина ({deletedCases.length})</button></div>
                {trashOpen?<div className="case-list">{!deletedCases.length&&<Empty title="Корзина пуста" text="Удалённые дела появятся здесь. Их можно восстановить вместе с документами и графами."/>}{deletedCases.map(item=><article className="case-trash-row" key={item.id}><div><strong>{item.caseNumber}</strong><small>Удалено: {new Date(item.deletedAt).toLocaleString("ru-RU")}</small></div><button disabled={busy} onClick={()=>void restoreDeletedCase(item.id)}>Восстановить</button></article>)}</div>:<div className="case-list">
                  {!cases.length && <Empty title="Дел пока нет" text="Создайте первое дело — оно будет записано в отдельную базу Vestigo." />}
                  {cases.map((item) => <button key={item.id} className={selectedCaseId === item.id ? "case-row selected" : "case-row"} onClick={() => setSelectedCaseId(item.id)}>
                    <span><strong>{item.caseNumber}</strong><small>{item.erdrNumber ? `ЕРДР ${item.erdrNumber}` : "ЕРДР не указан"}</small></span>
                    <span className="articles">{item.qualifications.map((value) => <b key={value}>ст. {value}</b>)}</span>
                    <span><em className={`status ${item.status}`}>{statusLabels[item.status] ?? item.status}</em><small>версия {item.version}</small></span>
                  </button>)}
                </div>}
              </div>

              <div className="panel detail-panel">
                {trashOpen?<Empty title="Корзина дел" text="Удаление обратимо. При восстановлении вернутся прежний статус, документы, операции и графы. Ожидающие задания продолжатся после восстановления. Файлы не уничтожаются, место на диске не освобождается."/>:!selectedCase ? <Empty title="Дело не выбрано" text="Выберите запись или создайте новое дело." /> : <>
                  <div className="detail-title"><div><span className="kicker">Карточка дела</span><h2>{selectedCase.caseNumber}</h2><p>{selectedCase.description || "Описание обстоятельств не заполнено"}</p></div><div className="case-actions">{selectedCase.status !== "archived" && <><button onClick={()=>setEditTarget(selectedCase)} disabled={busy}>Редактировать</button><button onClick={archiveCase} disabled={busy}>Архивировать</button></>}<button className="case-danger" onClick={()=>setDeleteTarget(selectedCase)} disabled={busy}>Удалить дело</button></div></div>
                  <dl className="detail-grid"><div><dt>ЕРДР</dt><dd>{selectedCase.erdrNumber || "Не указан"}</dd></div><div><dt>Подразделение</dt><dd>{selectedCase.unitName || "Не указано"}</dd></div><div><dt>Ответственный</dt><dd>{selectedCase.responsibleName}</dd></div><div><dt>Проверяемый период</dt><dd>{selectedCase.periodFrom || "—"} — {selectedCase.periodTo || "—"}</dd></div></dl>
                  <div className="episode-head"><div><span className="kicker">Связанные сведения</span><h3>Эпизоды ({episodes.length})</h3></div><button onClick={() => setEpisodeFormOpen((value) => !value)}>+ Добавить эпизод</button></div>
                  {episodeFormOpen && <form className="episode-form" onSubmit={submitEpisode}><input name="title" placeholder="Название эпизода" required /><input name="periodFrom" type="date" /><input name="periodTo" type="date" /><textarea name="description" placeholder="Проверяемые обстоятельства" rows={2} /><button className="primary" disabled={busy}>Сохранить эпизод</button></form>}
                  <div className="episodes">{!episodes.length && <p className="muted">Эпизоды ещё не добавлены.</p>}{episodes.map((episode) => <article key={episode.id}><span>ЭП</span><div><strong>{episode.title}</strong><p>{episode.description || "Описание не заполнено"}</p><small>{episode.periodFrom || "—"} — {episode.periodTo || "—"} · статус «На проверке»</small></div></article>)}</div>
                </>}
              </div>
            </section>
          ) : tab === "Документы" ? <DocumentsPanel cases={cases} caseId={selectedCaseId} onCaseChange={setSelectedCaseId}
            onUploaded={refresh} onCreateCase={() => { setTab("Дело"); setCaseFormOpen(true); }} /> : tab === "Операции" || tab === "Проверка" ?
            <><CaseAnalysisPanel cases={cases} caseId={selectedCaseId} onCaseChange={setSelectedCaseId} mode={tab === "Операции" ? "operations" : "risks"} onUpdated={refresh}/>{tab==='Операции'&&<CaseWorkflowPanel caseId={selectedCaseId} archived={selectedCase?.status==='archived'} mode="episodes" onUpdated={refresh}/>}</> : tab==="Расчёт ущерба"?<><CaseWorkflowPanel caseId={selectedCaseId} archived={selectedCase?.status==='archived'} mode="loss" onUpdated={refresh}/><details><summary>Существующие предварительные сравнения платежей и ЭСФ</summary><CalculationsPanel caseId={selectedCaseId} archived={selectedCase?.status==="archived"} onUpdated={refresh}/></details></>:tab==="Отчёты"?<ReportsPanel caseId={selectedCaseId} archived={selectedCase?.status==="archived"} onUpdated={refresh}/>:<ModulePanel tab={tab} dashboard={dashboard} />}
          {tab==='Дело'&&!trashOpen&&selectedCase&&<CaseWorkflowPanel caseId={selectedCaseId} archived={selectedCase.status==='archived'} mode="participants" onUpdated={refresh}/>}
          {tab==="Дело"&&!trashOpen&&selectedCase&&<AnalysisCenterPanel caseId={selectedCaseId} revision={selectedCase.updatedAt} archived={selectedCase.status==="archived"} onUpdated={refresh}/>}
        </div>
      </section>
    </main>
  );
}

function Metric({ label, value, detail }: { label: string; value: number | undefined; detail: string }) {
  const icon=label==="Дела"?"case":label==="Документы"?"documents":label==="Операции"?"operations":"review";
  return <article><div className="metric-top"><span>{label}</span><i className={`metric-icon ${icon}`}><UiIcon name={icon}/></i></div><strong>{value===undefined?"—":new Intl.NumberFormat("ru-RU").format(value)}</strong><small>{detail}</small></article>;
}

function Empty({ title, text }: { title: string; text: string }) { return <div className="empty"><b>{title}</b><p>{text}</p></div>; }

function ModulePanel({ tab, dashboard }: { tab: Tab; dashboard: Dashboard | null }) {
  const config: Record<Exclude<Tab, "Дело">, { count: number; title: string; text: string; next: string }> = {
    "Документы": { count: dashboard?.documents ?? 0, title: "Защищённое хранилище документов", text: "Здесь будут храниться оригиналы, SHA-256, версии, источник и результаты подтверждённого извлечения.", next: "Следующий этап: безопасная загрузка, дедупликация и классификация." },
    "Операции": { count: dashboard?.operations ?? 0, title: "Единый реестр операций", text: "Операции будут связаны с делом, эпизодом, участниками и подтверждающими документами.", next: "Следующий этап: импорт банковских, ЭСФ и 1С-операций." },
    "Расчёт ущерба": { count: dashboard?.calculations ?? 0, title: "Версионируемые расчёты", text: "Расчёт хранит методику, формулу, входные операции, исключения и обоснования ручных корректировок.", next: "Формулы будут добавлены только после юридического согласования методик." },
    "Проверка": { count: dashboard?.discrepancies ?? 0, title: "Реестр расхождений", text: "Каждый вопрос проверки будет иметь документы, операции, альтернативные объяснения, статус и историю.", next: "Следующий этап: детерминированные проверки дублей и несоответствий." },
    "Отчёты": { count: dashboard?.reports ?? 0, title: "Версии аналитических материалов", text: "Отчёты будут формироваться только из сохранённых данных дела со ссылками на документы и методику.", next: "Следующий этап: DOCX, XLSX и PDF после готовности базовых реестров." },
  };
  const item = config[tab as Exclude<Tab, "Дело">];
  return <section className="panel module-panel"><span className="kicker">Модуль Vestigo</span><h2>{item.title}</h2><div className="module-count"><strong>{item.count}</strong><span>записей в отдельной базе Vestigo</span></div><p>{item.text}</p><div className="stage-note"><b>Статус разработки</b><span>{item.next}</span></div><p className="muted">Раздел не показывает демонстрационные записи и не выполняет неподготовленные действия.</p></section>;
}
