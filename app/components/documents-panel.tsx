"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { DOCUMENT_ACCEPT, DOCUMENT_GROUPS, documentType, MAX_DOCUMENT_BYTES } from "@/app/lib/document-types.mjs";
import BankSettings,{emptyBankSettings} from "./bank-settings";
import DocumentDeleteAction from './document-delete-action';
import ExtractionPreview from "./extraction-preview";
import DocumentAnalysisProgress, {useDocumentProgress} from "./document-analysis-progress";
import {uploadDocument} from "../lib/upload-document";
import {transferPercent} from "../lib/document-progress.mjs";
import CaseEvidenceWorkspace from "./case-evidence-workspace";
import DocumentScopeAction from './document-scope-action';
import DocumentCategoryBrowser from "./document-category-browser";
import {searchSavedDocuments,savedDocumentStatus} from "../lib/saved-document-search.mjs";

type CaseChoice = { id: string; caseNumber: string; status: string };
type EpisodeChoice = { id: string; title: string };
type DocumentItem = {
  id: string; name: string; size: number; mediaType: string; sha256: string; groupId: string; typeId: string; excluded?:boolean;
  source: string; receivedAt: string; status: string; createdAt: string; episodes: EpisodeChoice[];
  archiveMembers?:{id:string;name:string;path:string}[];
  originArchives?:{id:string;name:string;path:string}[];
  analytics: { status: string; updatedAt: string; error: string } | null;
  extraction: { status: string; updatedAt: string; error: string; summary: string } | null;
  classification?: {mode:string;status:string;result:{version?:string;explanation?:string;note?:string;evidence?:string[];candidates?:{groupId:string;typeId:string}[]}}|null;
};
type UploadResult = { name: string; message: string; failed: boolean };
const emptyDocuments:DocumentItem[]=[];

function sizeLabel(bytes: number) {
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} КБ` : `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

async function jsonResponse(response: Response) {
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Ошибка запроса");
  return payload;
}

export default function DocumentsPanel({ cases, caseId, onCaseChange, onUploaded, onCreateCase }: {
  cases: CaseChoice[]; caseId: string; onCaseChange: (id: string) => void;
  onUploaded: () => Promise<void>; onCreateCase: () => void;
}) {
  const [registry,setRegistry] = useState<{caseId:string;documents:DocumentItem[]}|null>(null);
  const documents=registry?.caseId===caseId?registry.documents:emptyDocuments;
  const [deletionNotice,setDeletionNotice]=useState('');
  useEffect(()=>setDeletionNotice(''),[caseId]);
  const [episodes, setEpisodes] = useState<EpisodeChoice[]>([]);
  const [groupId, setGroupId] = useState("bank");
  const [typeId, setTypeId] = useState("statement");
  const [episodeId, setEpisodeId] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [filter, setFilter] = useState("");
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [showRemoved,setShowRemoved]=useState(false);
  const [resultOffset, setResultOffset] = useState(0);
  const [detailsId, setDetailsId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState("");
  const [transfer,setTransfer]=useState<number|null>(0);
  const [results, setResults] = useState<UploadResult[]>([]);
  const [analyzingId, setAnalyzingId] = useState("");
  const [analysisMessage, setAnalysisMessage] = useState("");
  const [bankSettings,setBankSettings]=useState(emptyBankSettings);
  const [autoAnalyze, setAutoAnalyze] = useState(true);
  const [autoClassify,setAutoClassify]=useState(true);
  const [previewId, setPreviewId] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const activeCase = useRef(caseId);
  const selectedGroup = DOCUMENT_GROUPS.find((group) => group.id === groupId)!;
  const selectedCase = cases.find((item) => item.id === caseId);
  const canUpload = !!selectedCase && selectedCase.status !== "archived";

  const load = useCallback(async (id: string, signal?: AbortSignal) => {
    const [docs, episodePayload] = await Promise.all([
      fetch(`/api/documents?caseId=${encodeURIComponent(id)}`, { cache: "no-store", signal }).then(jsonResponse),
      fetch(`/api/episodes?caseId=${encodeURIComponent(id)}`, { cache: "no-store", signal }).then(jsonResponse),
    ]);
    if(signal?.aborted||activeCase.current!==id)return;
    setRegistry({caseId:id,documents:docs.documents});
    setEpisodes(episodePayload.episodes);
  }, []);
  const analysis=useDocumentProgress(caseId,async()=>{await load(caseId);await onUploaded();});
  useEffect(()=>{
    if(!busy)return;
    const warn=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue="";};
    window.addEventListener("beforeunload",warn);return()=>window.removeEventListener("beforeunload",warn);
  },[busy]);

  useEffect(() => {
    const abort = new AbortController();
    activeCase.current=caseId;
    setRegistry(null); setEpisodes([]); setEpisodeId(""); setResults([]); setError(""); setPreviewId(""); setAnalysisMessage("");
    setQuery("");setFilter("");setShowAll(false);setShowRemoved(false);setDetailsId("");setResultOffset(0);
    if (caseId) {
      setLoading(true);
      load(caseId, abort.signal).catch((reason) => {
        if (!abort.signal.aborted) setError(reason.message);
      }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    } else setLoading(false);
    return () => abort.abort();
  }, [caseId, load]);

  useEffect(()=>{setResultOffset(0);setDetailsId("");},[query,filter,showAll,showRemoved]);

  function changeGroup(value: string) {
    setGroupId(value);
    setTypeId(DOCUMENT_GROUPS.find((group) => group.id === value)!.types[0].id);
  }

  function addFiles(selection: FileList | readonly File[]) {
    if (!canUpload || busy) return;
    const added = Array.from(selection);
    if (added.length) setFiles((current) => [...current, ...added]);
  }

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canUpload || !files.length || busy) return;
    const form = new FormData(event.currentTarget);
    const currentCaseId = caseId;
    const queue = [...files];
    setBusy(true); setError(""); setResults([]);setTransfer(0);
    const completed: UploadResult[] = [];
    const failedFiles: File[]=[];
    const batchBytes=queue.reduce((sum,file)=>sum+file.size,0);let sentBytes=0;
    try {
      for (const [index, file] of queue.entries()) {
        setProgress(`Загрузка ${index + 1} из ${queue.length}: ${file.name}`);
        const data = new FormData();
        data.set("file", file); data.set("caseId", currentCaseId); data.set("episodeId", episodeId);
        data.set("groupId", autoClassify?"unclassified":groupId); data.set("typeId", autoClassify?"unclassified":typeId);data.set("classificationMode",autoClassify?"auto":"manual");
        data.set("source", String(form.get("source") || ""));
        data.set("receivedAt", String(form.get("receivedAt") || ""));
        data.set("processInBackground",String(autoAnalyze));
        for(const [key,value] of Object.entries(bankSettings))if(value&&value!=="unknown")data.set(key,value);
        try {
          if (file.size > MAX_DOCUMENT_BYTES) throw new Error("Размер файла превышает 50 МБ");
          if(!DOCUMENT_ACCEPT.split(",").some(extension=>file.name.toLowerCase().endsWith(extension)))throw new Error("Формат не поддерживается. RAR предварительно распакуйте; ZIP можно загрузить целиком.");
          const saved = await uploadDocument(data,(loaded,total)=>setTransfer(transferPercent(sentBytes,loaded,total,file.size,batchBytes)));
          sentBytes+=file.size;
          setTransfer(batchBytes?Math.floor(100*sentBytes/batchBytes):100);
          let message = saved.duplicate
            ? (saved.alreadyLinked ? "Уже есть в деле — повторный файл не создан" : "Оригинал уже сохранён — добавлена связь с делом")
            : "Оригинал сохранён";
          if (autoAnalyze&&saved.processing?.job) {analysis.watch(saved.processing.job,file.name);message+=saved.processing.job.state==="completed"?" · ранее прочитан; повторный анализ не создан":" · ход чтения и анализа показан ниже";}
          if(saved.archive){
            message+=` · документов в ZIP: ${saved.archive.documents.length}`;
            const duplicateCount=saved.archive.documents.filter((document:any)=>document.alreadyLinked).length;
            if(duplicateCount)message+=` · уже были в деле: ${duplicateCount}`;
            if(saved.archive.skipped.length)message+=` · служебных файлов пропущено: ${saved.archive.skipped.length}`;
            for(const document of saved.archive.documents)if(document.processing?.job)analysis.watch(document.processing.job,document.name);
          }
          completed.push({ name: file.name, failed: false, message });
        } catch (reason) {
          failedFiles.push(file);
          completed.push({ name: file.name, failed: true, message: reason instanceof Error ? reason.message : "Ошибка загрузки" });
        }
        setResults([...completed]);
      }
      setFiles(failedFiles);
      if (fileInput.current) fileInput.current.value = "";
      await load(currentCaseId);
      await onUploaded();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось обновить реестр"); }
    finally { setBusy(false); setProgress(""); }
  }

  async function analyzeDocument(item: DocumentItem,classification?:{groupId:string;typeId:string;note:string}) {
    setAnalyzingId(item.id); setError(""); setAnalysisMessage("");
    try {
      const saved=await fetch("/api/processing-jobs", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({caseId,documentId:item.id,options:classification?{classification}:{},force:true}),
      }).then(jsonResponse);
      analysis.watch(saved.job,item.name);
      setAnalysisMessage("Платформа прочитает документ, сопоставит данные и обновит проверки. Ход выполнения показан ниже.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось обработать документ"); }
    finally { await load(caseId).catch(() => undefined); await onUploaded(); setAnalyzingId(""); }
  }

  const visibleDocuments=documents.filter(d=>!!d.excluded===showRemoved);
  const search = searchSavedDocuments(visibleDocuments,query,{groupId:filter,showAll:showAll||showRemoved,offset:resultOffset});

  return <section className="document-workspace">
    <section className="panel">
      <div className="panel-head"><div><span className="kicker">Материалы дела</span><h2>Документы</h2></div>
        {cases.length ? <label className="document-case-label">Дело<select value={caseId} onChange={(event) => onCaseChange(event.target.value)} disabled={busy || !!analyzingId}>
          {cases.map((item) => <option key={item.id} value={item.id}>{item.caseNumber}{item.status === "archived" ? " · архив" : ""}</option>)}
        </select></label> : <button onClick={onCreateCase}>Создать дело</button>}
      </div>
      <p className="document-intro">В автоматическом режиме каждый файл распределяется отдельно по признакам содержимого. Неоднозначные материалы остаются в «Нераспределённых» до решения специалиста. Новые примеры используются для расширения проверяемых правил, а не для скрытого самообучения.</p>
      <DocumentCategoryBrowser key={caseId} caseId={caseId} documents={documents} loading={loading||registry?.caseId!==caseId}
        onShowInRegistry={id=>{setQuery("");setShowRemoved(false);setFilter(id);setResultOffset(0);setDetailsId("");searchInput.current?.focus();}}/>
      {!cases.length ? <div className="empty"><b>Сначала создайте дело</b><p>После этого можно прикрепить документы и распределить их по эпизодам.</p></div> :
        <form className="document-upload-form form-grid" onSubmit={upload}>
          <fieldset className="document-upload-fields full" disabled={busy || !canUpload}>
            <label className="full"><span><input type="checkbox" checked={autoClassify} onChange={e=>{setAutoClassify(e.target.checked);if(e.target.checked)setAutoAnalyze(true);}}/> Автоматически определить группу и вид каждого файла</span></label>
            <label>Группа документов<select disabled={autoClassify} value={groupId} onChange={(event) => changeGroup(event.target.value)}>{DOCUMENT_GROUPS.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>
            <label>Вид документа<select disabled={autoClassify} value={typeId} onChange={(event) => setTypeId(event.target.value)}>{selectedGroup.types.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}</select></label>
            <label>Эпизод<select value={episodeId} onChange={(event) => setEpisodeId(event.target.value)}><option value="">Документ относится ко всему делу</option>{episodes.map((episode) => <option key={episode.id} value={episode.id}>{episode.title}</option>)}</select></label>
            <label>Дата получения<input name="receivedAt" type="date" /></label>
            <label className="full">Источник / способ получения<input name="source" maxLength={2000} placeholder="Например: предоставлено организацией по запросу" /></label>
            <div className="full document-file-field">
              <span>Файлы для загрузки</span>
              <div className={`document-file-picker-actions${draggingFiles ? " is-dragging" : ""}`}
                onDragOver={(event) => {
                  if (!event.dataTransfer.types.includes("Files")) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = canUpload && !busy ? "copy" : "none";
                  if (canUpload && !busy) setDraggingFiles(true);
                }}
                onDragLeave={(event) => {
                  if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDraggingFiles(false);
                }}
                onDrop={(event) => {
                  if (!event.dataTransfer.files.length && !event.dataTransfer.types.includes("Files")) return;
                  event.preventDefault();
                  setDraggingFiles(false);
                  addFiles(event.dataTransfer.files);
                }}>
                <button type="button" onClick={() => fileInput.current?.click()}>{files.length ? "Добавить ещё файлы" : "Выбрать файлы"}</button>
                <span>или перетащите файлы сюда</span>
                <span role="status" aria-live="polite">{files.length ? `Выбрано файлов: ${files.length} · ${sizeLabel(files.reduce((sum, file) => sum + file.size, 0))}` : "Файлы пока не выбраны"}</span>
                {files.length > 0 && <button type="button" onClick={() => { setFiles([]); if (fileInput.current) fileInput.current.value = ""; }}>Очистить список</button>}
              </div>
              <input ref={fileInput} type="file" accept={DOCUMENT_ACCEPT} multiple hidden aria-label="Добавить файлы к списку"
                onChange={(event) => {
                  if (event.currentTarget.files) addFiles(event.currentTarget.files);
                  // The state list owns the selection. Reset the native picker
                  // so the same file can be chosen again after being removed.
                  event.currentTarget.value = "";
                }} />
              <p className="muted">Выбирайте несколько файлов из обычной папки или добавляйте их порциями. Если файлы находятся внутри ZIP, сначала нажмите в Проводнике «Извлечь всё», либо выберите сам ZIP, чтобы загрузить его содержимое целиком.</p>
              {files.length > 0 && <ul className="document-file-selection" aria-label="Выбранные файлы для загрузки">{files.map((file, index) => <li key={`${file.name}-${index}`}><span>{file.name}</span><small>{sizeLabel(file.size)}</small><button type="button" aria-label={`Удалить из списка: ${file.name}`} onClick={() => setFiles((current) => current.filter((_, fileIndex) => fileIndex !== index))}>Удалить из списка</button></li>)}</ul>}
            </div>
          </fieldset>
          <p className="muted full">PDF, Word (DOCX), Excel (XLSX, XLS), CSV, XML, JSON, TXT, сканы JPG, PNG, TIFF и ZIP. До 50 МБ на файл или ZIP; внутри ZIP — до 500 документов и 250 МБ после распаковки. {autoClassify?"Для пачки разных видов оставьте автоматический режим включённым.":"Ручной режим: все выбранные документы получат указанный вид."} Архив RAR нужно предварительно распаковать.</p>
          <BankSettings value={bankSettings} onChange={setBankSettings} disabled={busy}/>
          <label className="full auto-analyze"><input type="checkbox" checked={autoAnalyze} disabled={busy||autoClassify} onChange={e=>setAutoAnalyze(e.target.checked)}/> Прочитать документы, сопоставить данные и проверить риски</label>
          {selectedCase?.status === "archived" && <p className="muted full">Дело находится в архиве. Документы доступны для просмотра и скачивания.</p>}
          <div className="form-actions full"><span role="status" className="document-progress">{progress}</span><button className="primary" disabled={busy || !canUpload || !files.length}>{busy ? `Загрузка${transfer===null?"…":` · ${transfer}%`}` : autoAnalyze?"Загрузить и проанализировать":"Сохранить документы"}</button></div>
        </form>}
      {error && <div className="notice error" role="alert">{error}</div>}
      {analysisMessage && <p className="document-intro" role="status">{analysisMessage}</p>}
      {results.length > 0 && <ul className="document-upload-results" aria-label="Результаты загрузки" aria-live="polite">{results.map((result, index) => <li key={index} className={result.failed ? "failed" : "saved"}><strong>{result.name}</strong><span>{result.message}</span></li>)}</ul>}
      <DocumentAnalysisProgress jobs={analysis.jobs} uploading={busy} transfer={transfer} transferLabel={progress} online={analysis.online} error={analysis.error} onDismiss={analysis.dismiss} onRetry={analysis.retry} canRetry={canUpload} analysisEnabled={autoAnalyze}/>
    </section>

    <CaseEvidenceWorkspace caseId={caseId} revision={documents.map(d=>d.extraction?.updatedAt||d.id).join("|")} archived={!canUpload} onUpdated={async()=>{await load(caseId);await onUploaded();}}/>
    <section className="panel document-search" aria-label="Поиск сохранённых документов">
      <div className="panel-head"><div><span className="kicker">Сохранённые материалы{caseId ? ` · ${documents.length}` : ""}</span><h2>Поиск документов</h2></div></div>
      <label><input type="checkbox" checked={showRemoved} onChange={e=>setShowRemoved(e.target.checked)}/> Убранные из анализа ({documents.filter(d=>d.excluded).length})</label>
      <p className="muted">Убранный файл не участвует в схемах и расчётах. Оригинал и история сохраняются. Повторная загрузка с анализом вернёт файл и запустит новое чтение без создания копии.</p>
      {deletionNotice&&<p role="status">{deletionNotice}</p>}
      <div className="document-toolbar"><label>Поиск среди сохранённых документов<input ref={searchInput} type="search" placeholder="Название, вид, источник или эпизод…" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        {search.active && <button type="button" onClick={() => {setQuery("");setFilter("");setShowAll(false);}}>Очистить поиск документов</button>}</div>
      {loading ? <p className="document-intro" role="status">Загружаем реестр…</p> : !documents.length ?
        <p className="document-search-hint">Документов пока нет. Добавьте файлы в выбранное дело.</p> : !search.active ?
        <div className="document-search-start"><p>Введите запрос, чтобы найти документ среди сохранённых материалов этого дела.</p><button type="button" onClick={()=>setShowAll(true)}>Показать все документы ({documents.length})</button></div> :
        <><p className="document-search-count" role="status">Найдено документов: {search.total}{filter?` · ${DOCUMENT_GROUPS.find(group=>group.id===filter)?.name||filter}`:""}</p>
        {!search.total ? <p className="document-search-hint">По заданным условиям ничего не найдено. Измените запрос или выбранную группу.</p> :
        <ul className="document-search-results" aria-label="Найденные документы">{search.items.map((item:DocumentItem) => {
          const classification = documentType(item.groupId, item.typeId);
          const activeJob=analysis.jobs.find(job=>job.documentId===item.id&&["queued","retry","running"].includes(job.state));
          const archive=item.mediaType==="application/zip";
          const expanded=detailsId===item.id;
          return <li key={item.id} id={`document-${item.id}`} className="document-result">
            <div className="document-result-line"><div className="document-result-title"><button type="button" aria-expanded={expanded} aria-controls={expanded?`document-details-${item.id}`:undefined} onClick={()=>setDetailsId(expanded?"":item.id)}>{item.name}</button><small>{classification?.type.name||"Вид не указан"} · {sizeLabel(item.size)}</small></div>
              <span className={`document-result-status${item.extraction?.status==="failed"?" has-error":""}`}>{item.excluded?'Убран из анализа':savedDocumentStatus(item,!!activeJob||analyzingId===item.id)}</span>
              {canUpload&&!archive&&<DocumentScopeAction caseId={caseId} item={item} disabled={busy||!!activeJob||!!analyzingId} onChanged={async()=>{await load(caseId);await onUploaded();}}/>}
              {canUpload&&<DocumentDeleteAction caseId={caseId} item={item} disabled={busy||!!analyzingId||activeJob?.state==='running'} onDeleted={async result=>{setDeletionNotice(result.message);setDetailsId('');await load(caseId);await onUploaded();}}/>}
              <a className="document-download" aria-label={`Скачать оригинал: ${item.name}`} href={`/api/documents/${encodeURIComponent(item.id)}?caseId=${encodeURIComponent(caseId)}`}>Скачать</a>
            </div>
            {expanded&&<article id={`document-details-${item.id}`} className="document-card document-result-details" aria-label={`Сведения о документе: ${item.name}`}>
            <div className="document-card-heading"><div><span className="kicker">{classification?.group.name || "Без группы"}</span><h3>{item.name}</h3><p>{classification?.type.name || "Вид не указан"}</p></div>
              <button type="button" onClick={()=>setDetailsId("")}>Закрыть сведения</button></div>
            <dl><div><dt>Размер</dt><dd>{sizeLabel(item.size)}</dd></div><div><dt>Дата получения</dt><dd>{item.receivedAt || "Не указана"}</dd></div><div><dt>Источник</dt><dd>{item.source || "Не указан"}</dd></div><div><dt>Эпизоды</dt><dd>{item.episodes.length ? item.episodes.map((episode) => episode.title).join("; ") : "Все дело"}</dd></div></dl>
            <details className="document-integrity"><summary>Контроль целостности SHA-256</summary><code>{item.sha256}</code></details>
            {archive&&<div className="stage-note"><b>Оригинал ZIP сохранён · вложенных документов: {item.archiveMembers?.length||0}</b><p>Каждый вложенный документ читается отдельно. Выберите файл, чтобы найти его в сохранённых материалах. Архив не считается денежной операцией.</p><ul>{item.archiveMembers?.map(member=><li key={member.path}><button type="button" onClick={()=>{setFilter("");setQuery(member.name);setDetailsId("");}}>{member.path}</button></li>)}</ul></div>}
            {!!item.originArchives?.length&&<p className="muted">Из архива: {item.originArchives.map(member=>`${member.name} / ${member.path}`).join("; ")}</p>}
            {!archive&&item.classification&&<div className="stage-note"><b>{item.classification.status==="automatic"?"Вид определён автоматически":item.classification.status==="manual"?"Вид выбран вручную":item.classification.status==="pending"?"Определение вида ещё не выполнено":"Вид требует проверки"}</b><p>{item.classification.result.explanation}</p>{item.classification.result.note&&<p>Основание: {item.classification.result.note}</p>}{item.classification.result.evidence?.map((text,i)=><p key={i}>{text}</p>)}{item.classification.result.version&&<small>Правила: {item.classification.result.version}</small>}</div>}
            {canUpload&&!archive&&<ClassificationReview key={`${item.id}:${item.groupId}:${item.typeId}:${item.classification?.status}`} item={item} busy={busy||!!analyzingId} onSave={value=>analyzeDocument(item,value)}/>}
            {!archive&&<p className="document-status">{analyzingId === item.id ? "Читаем файл и сопоставляем данные дела…" :
              item.extraction?.status === "needs_ocr" ? "Оригинал сохранён · текст не распознан, проверьте ошибки OCR" :
              item.extraction?.status === "needs_mapping" ? "Файл прочитан · настройте столбцы" :
              item.extraction?.status === "failed" ? `Оригинал сохранён · ошибка чтения: ${item.extraction.error}` :
              item.extraction?.status === "running" ? "Обработка выполняется…" :
              item.extraction ? "Данные прочитаны · проверьте извлечённые строки, операции и риски дела" : "Оригинал сохранён · извлечение данных ещё не выполнялось"}</p>}
            {canUpload && !archive && <button type="button" className="document-analyze"
              disabled={busy || !!analyzingId || !!activeJob} onClick={() => analyzeDocument(item)}>
              {analyzingId === item.id || activeJob ? "Платформа анализирует…" : item.extraction ? "Повторить чтение и сопоставление" : "Прочитать и сопоставить"}
            </button>}
            {item.extraction && <button type="button" onClick={()=>setPreviewId(item.id)}>Что прочитано / настроить столбцы</button>}
          </article>}</li>;
        })}</ul>}
        {search.total>search.limit&&<div className="document-search-pagination"><button type="button" disabled={search.offset===0} onClick={()=>{setResultOffset(search.offset-search.limit);setDetailsId("");}}>← Предыдущие</button><span>{search.offset+1}–{Math.min(search.offset+search.limit,search.total)} из {search.total}</span><button type="button" disabled={search.offset+search.limit>=search.total} onClick={()=>{setResultOffset(search.offset+search.limit);setDetailsId("");}}>Следующие →</button></div>}</>}
    </section>
    {previewId&&<ExtractionPreview key={`${caseId}:${previewId}`} caseId={caseId} documentId={previewId} onClose={()=>setPreviewId("")} onUpdated={async()=>{await load(caseId);await onUploaded();}}/>}
  </section>;
}

function ClassificationReview({item,busy,onSave}:{item:DocumentItem;busy:boolean;onSave:(value:{groupId:string;typeId:string;note:string})=>Promise<void>}){
  const suggested=item.classification?.result.candidates?.[0],initialGroup=item.groupId==="unclassified"?(suggested?.groupId||"unclassified"):item.groupId;
  const [group,setGroup]=useState(initialGroup),[type,setType]=useState(item.groupId==="unclassified"?(suggested?.typeId||"unclassified"):item.typeId);
  return <details><summary>Проверить или изменить группу и вид</summary><p>После сохранения файл будет перечитан, операции и риски этого дела пересчитаны. Ручной выбор не заменяется автоматическим при повторном чтении.</p><form className="form-grid" onSubmit={async e=>{e.preventDefault();const form=e.currentTarget,note=String(new FormData(form).get("note")||"");await onSave({groupId:group,typeId:type,note});}}><label>Группа<select value={group} disabled={busy} onChange={e=>{setGroup(e.target.value);setType(DOCUMENT_GROUPS.find(g=>g.id===e.target.value)!.types[0].id);}}>{DOCUMENT_GROUPS.map(g=><option key={g.id} value={g.id}>{g.name}</option>)}</select></label><label>Вид<select value={type} disabled={busy} onChange={e=>setType(e.target.value)}>{DOCUMENT_GROUPS.find(g=>g.id===group)?.types.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label><label className="full">Основание выбора<textarea name="note" required maxLength={4000} disabled={busy}/></label><button className="primary" disabled={busy}>Сохранить вид и пересчитать</button></form></details>;
}
