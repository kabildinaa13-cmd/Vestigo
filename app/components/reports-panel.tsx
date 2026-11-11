"use client";
import {useEffect,useState} from "react";
import {formatMinor} from "./calculations-panel";
import DocumentNoticeGroups from "./document-notice-groups";
import {groupDocumentNotices,noticeSourceLabel,noticeSourceUrl} from "../lib/document-notice-groups.mjs";
type Report={id:string;version:number;createdAt:string};
export default function ReportsPanel({caseId,archived,onUpdated}:{caseId:string;archived:boolean;onUpdated:()=>Promise<void>}){
 const [reports,setReports]=useState<Report[]>([]),[error,setError]=useState(""),[busy,setBusy]=useState(false),[revision,setRevision]=useState(0),[preview,setPreview]=useState<any>(null);
 useEffect(()=>{setPreview(null);setReports([]);},[caseId]);
 useEffect(()=>{if(!caseId)return;const abort=new AbortController();fetch(`/api/reports?caseId=${encodeURIComponent(caseId)}`,{signal:abort.signal,cache:"no-store"}).then(async r=>{const p=await r.json();if(!r.ok)throw new Error(p.error);setReports(p.reports);}).catch(e=>{if(!abort.signal.aborted)setError(e.message);});return()=>abort.abort();},[caseId,revision]);
 async function create(){setBusy(true);setError("");try{const r=await fetch("/api/reports",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({caseId})}),p=await r.json();if(!r.ok)throw new Error(p.error);setRevision(v=>v+1);await onUpdated();}catch(e){setError(e instanceof Error?e.message:"Не удалось сохранить отчёт");}finally{setBusy(false);}}
 async function open(id:string){setError("");try{const r=await fetch(`/api/reports?caseId=${encodeURIComponent(caseId)}&id=${id}`,{cache:"no-store"}),p=await r.json();if(!r.ok)throw new Error(p.error);setPreview(p);}catch(e){setError(e instanceof Error?e.message:"Не удалось открыть отчёт");}}
 return <section className="panel bank-analysis-panel"><div className="panel-head"><div><span className="kicker">Материалы по данным дела</span><h2>Аналитические сводки</h2></div><button className="primary" disabled={!caseId||archived||busy} onClick={create}>{busy?"Сохраняем…":"Сформировать новую версию"}</button></div><p className="muted">Каждая версия сохраняет данные на момент формирования. Откройте её для просмотра или скачайте Excel либо JSON.</p>{error&&<p className="notice error" role="alert">{error}</p>}{reports.map(r=><article className="analysis-card" key={r.id}><h3>Сводка · версия {r.version}</h3><p>{new Date(r.createdAt).toLocaleString("ru-RU")}</p><button onClick={()=>open(r.id)}>Открыть</button> <a href={`/api/reports?caseId=${encodeURIComponent(caseId)}&id=${r.id}`}>Скачать JSON</a> <a href={`/api/reports?caseId=${encodeURIComponent(caseId)}&id=${r.id}&format=xlsx`}>Скачать Excel</a></article>)}
 {preview&&<ReportPreview preview={preview} caseId={caseId}/>}
 </section>;
}

const documentStates:Record<string,string>={extracted:"Прочитан",confirmed:"Проверен",review:"Проверить реквизиты",needs_mapping:"Настроить столбцы",needs_ocr:"Нужно распознать текст",failed:"Ошибка чтения",running:"Читается",uploaded:"Ожидает чтения"};
const closed=(r:any)=>["closed","rejected"].includes(r.status)||!!r.retired;
function FindingExamples({examples,caseId}:{examples:any[];caseId:string}){
 return examples.length?<ul className="report-finding-examples">{examples.map((e:any,i:number)=><li key={i}>
  <a href={noticeSourceUrl(caseId,e)} target="_blank" rel="noreferrer">{e.name}</a> · {e.textLine?`${e.page?`страница ${e.page}, `:""}строка текста ${e.row}`:noticeSourceLabel(e)}
  <div>{e.values.map((f:any,j:number)=><span key={j}>{j>0?" · ":""}<b>{f.label}{f.cell?` (${f.cell})`:""}:</b> {f.missing?"пусто":f.normalized?`${f.raw} (извлечено)`:`«${f.raw}»`}{f.unreadable?" (сумма не распознана)":""}</span>)}</div>
 </li>)}</ul>:null;
}
const priority:Record<string,number>={CONFLICTING_DOCUMENT:0,PAYMENT_AMOUNT_DIFFERENCE:0,EXTRACTION_FIELD_CONFLICT:0,REPEATED_INVOICE_ROWS:1,NO_PAYMENT_MATCH:2,PAYMENT_WITHOUT_LINKED_DOCUMENT:2,DOCUMENT_PROCESSING_INCOMPLETE:3,INCOMPLETE_EXTRACTION:4};

export function ReportPreview({preview,caseId}:{preview:any;caseId:string}){
 const workflow=preview.workflow;
 const documents=preview.documents||[],risks=preview.risks||[],openRisks=risks.filter((r:any)=>!closed(r)),history=risks.filter(closed);
 const model=groupDocumentNotices(openRisks,documents,{includeDocumentErrors:true});
 const missing=preview.missingMaterials||[];
 const hasVictim=workflow?.participants?.some((p:any)=>p.role==="victim");
 const hasLoss=workflow?.balances?.some((b:any)=>b.originalMinor!==null&&b.originalMinor!==undefined);
 const documentChecks=missing.filter((m:any)=>m.category==="processing");
 const otherChecks=missing.filter((m:any)=>!["case","processing"].includes(m.category));
 const mainNotice=model.groups.flatMap((g:any)=>g.rows).filter((r:any)=>r.code==="CONFLICTING_DOCUMENT"||r.members.some(({event}:any)=>event.reportEvidence?.examples?.length)).sort((a:any,b:any)=>(priority[a.code]??5)-(priority[b.code]??5)).slice(0,8);
 const reportEvent=(event:any)=><>{event.calculation?.differenceMinor!=null&&event.calculation?.currency&&<p>Разница: {formatMinor(event.calculation.differenceMinor,event.calculation.currency)}</p>}<FindingExamples caseId={caseId} examples={event.reportEvidence?.examples||[]}/>{event.reportEvidence?.truncated&&<p>Приведены примеры; остальные строки — в перечне первоисточников.</p>}</>;
 return <section className="report-preview">
  <div className="panel-head"><h3>Дело {preview.case.caseNumber} · сводка {preview.version}</h3><button onClick={()=>window.print()}>Печать / сохранить PDF</button></div>
  <p>Документов: {documents.length} · операций: {(preview.operations||[]).length} · сопоставлений: {(preview.matches||[]).length}</p>
  {workflow&&<section><h4>Ущерб и возмещение</h4>
   {!hasLoss&&<p><strong>Сумма ущерба не рассчитана.</strong> {!hasVictim?"Зарегистрируйте потерпевшего в разделе «Дело», затем укажите суммы и документы в «Расчёте ущерба».":workflow.losses?.length?"Проверьте основания и статус сохранённого расчёта в разделе «Расчёт ущерба».":"Создайте расчёт и укажите документы-основания в разделе «Расчёт ущерба»."}</p>}
   {(workflow.balances||[]).map((b:any,i:number)=><p key={i}><strong>{workflow.participants.find((p:any)=>p.id===b.victimId)?.name||"Потерпевший"}</strong> · {workflow.episodes.find((e:any)=>e.id===b.episodeId)?.title||"Всё дело"}: расчёт {formatMinor(b.originalMinor,b.currency)}, возвращено {formatMinor(b.returnedMinor,b.currency)}, остаток {formatMinor(b.remainingMinor,b.currency)}.</p>)}
  </section>}
  <section><h4>Что проверить</h4>
   {mainNotice.map((r:any)=>{
    const findings=r.members.map(({event}:any)=>event.reportEvidence).filter(Boolean);
    const examples=[...new Map<string,any>(findings.flatMap((f:any)=>f.examples).map((e:any)=>[JSON.stringify([e.documentId,e.sheet,e.page,e.row]),e])).values()];
    const reason=findings.find((f:any)=>f.reason)?.reason;
    const difference=r.members[0].event.calculation;
    return <article className="analysis-card" key={r.key}>
     <h4>{r.title}</h4>
     {(reason||(r.reading&&r.detail))&&<p>{reason||r.detail}</p>}
     {difference?.differenceMinor!=null&&difference?.currency&&<p><b>Разница:</b> {formatMinor(difference.differenceMinor,difference.currency)}</p>}
     <FindingExamples examples={examples.slice(0,3)} caseId={caseId}/>
     {examples.length>3&&<details><summary>Ещё примеры ({examples.length-3})</summary><FindingExamples examples={examples.slice(3)} caseId={caseId}/></details>}
     {!examples.length&&r.locations.length>0&&<p>{r.locations.map((s:any,i:number)=><span key={i}>{i?" · ":""}<a href={noticeSourceUrl(caseId,s)}>{s.name}: {noticeSourceLabel(s)}</a></span>)}</p>}
     {r.nextStep&&<p><b>Что сделать:</b> {r.nextStep}</p>}
    </article>;
   })}
   {!preview.findingEvidenceVersion&&openRisks.length>0&&<p className="muted">В этой версии сохранены ссылки на источники без значений из строк. Для просмотра конкретных значений сформируйте новую версию.</p>}
   {documentChecks.length>0&&<p>Файлов, где нужно проверить чтение или реквизиты: {documentChecks.length}. См. «Документы» ниже.</p>}
   {otherChecks.length>0&&<ul>{otherChecks.map((m:any,i:number)=><li key={m.id||i}>{m.name?m.name+": ":""}{m.reason}</li>)}</ul>}
   {model.groups.length>0?<details><summary>Замечания и первоисточники ({openRisks.length} сохранённых записей)</summary><DocumentNoticeGroups items={openRisks} documents={documents} caseId={caseId} includeDocumentErrors showFilters={false} renderEvent={reportEvent}/></details>:<p>Открытых замечаний в этой версии нет.</p>}
   {history.length>0&&<details><summary>Закрытые и отклонённые замечания ({history.length})</summary><DocumentNoticeGroups items={history} documents={documents} caseId={caseId} showFilters={false} renderEvent={reportEvent}/></details>}
  </section>
  <details><summary>Документы ({documents.length})</summary><ul>{documents.map((d:any)=><li key={d.id}><a href={noticeSourceUrl(caseId,{documentId:d.id})}>{d.name}</a> · {d.excluded?"Исключён из анализа":documentStates[d.status]||"Статус не указан"}{d.rows>0?` · строк: ${d.rows}`:""}{d.error?` · ${d.error}`:""}</li>)}</ul></details>
  <details><summary>Методики, версии и ограничения</summary>
   {workflow?.losses?.map((l:any)=><article key={l.id}><h4>{l.victimName} · версия {l.version}</h4><p>{l.formula}: {formatMinor(l.grossMinor,l.currency)} − {formatMinor(l.fulfilledMinor,l.currency)} = {formatMinor(l.originalMinor,l.currency)}</p><p>{l.note} · {l.status==="confirmed"&&l.usable!==false?"Подтверждено сотрудником":"Не включено в подтверждённый итог"}</p>{l.sources.map((s:any,i:number)=><p key={i}><a href={noticeSourceUrl(caseId,s)}>{s.name}</a>{s.sheet?` · ${s.sheet}`:""}{s.row?` · строка ${s.row}`:""}</p>)}</article>)}
   {(preview.calculations||[]).map((c:any)=><p key={c.id}>Версия {c.version}: {c.formula} = {formatMinor(c.differenceMinor,c.currency)}. {c.warning}</p>)}
   {preview.warning&&<p>{preview.warning}</p>}{workflow?.warning&&<p>{workflow.warning}</p>}
  </details>
 </section>;
}
