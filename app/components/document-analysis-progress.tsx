"use client";
import {useCallback,useEffect,useRef,useState} from "react";
import {CheckCircle2,FileSearch,LoaderCircle,TriangleAlert} from "lucide-react";
import {analysisSummary,documentProgress} from "../lib/document-progress.mjs";

export type AnalysisJob={id:string;caseId:string;documentId:string;name:string;state:string;phase:string;error:string;createdAt:string;updatedAt:string;result:{summary?:Record<string,any>;message?:string}};
const active=(job:AnalysisJob)=>["queued","retry","running"].includes(job.state);

export function useDocumentProgress(caseId:string,onUpdated:()=>Promise<void>){
  const [jobs,setJobs]=useState<AnalysisJob[]>([]),[error,setError]=useState("");
  const [online,setOnline]=useState<boolean|null>(null);
  const tracked=useRef(new Map<string,AnalysisJob>()),scope=useRef(caseId),callback=useRef(onUpdated);
  const wake=useRef<(()=>void)|null>(null);
  const finished=useRef(new Set<string>());callback.current=onUpdated;
  const merge=useCallback((incoming:AnalysisJob[])=>{
    for(const job of incoming){
      if(job.caseId!==scope.current)continue;
      const old=tracked.current.get(job.documentId);
      if(old&&(old.createdAt>job.createdAt||(old.id===job.id&&old.updatedAt>job.updatedAt)))continue;
      tracked.current.set(job.documentId,{...job,name:job.name||old?.name||"Документ"});
    }
    setJobs([...tracked.current.values()]);
  },[]);
  const watch=useCallback((job:AnalysisJob,name?:string)=>{merge([{...job,name:name||job.name}]);wake.current?.();},[merge]);
  useEffect(()=>{
    const abort=new AbortController();let live=true,polling=false,timer:ReturnType<typeof setTimeout>;
    scope.current=caseId;tracked.current.clear();finished.current.clear();setJobs([]);setError("");setOnline(null);
    if(!caseId)return()=>abort.abort();
    async function read(params:string){
      const response=await fetch(`/api/processing-jobs?caseId=${encodeURIComponent(caseId)}&${params}`,{cache:"no-store",signal:abort.signal});
      const payload=await response.json();if(!response.ok)throw new Error(payload.error||"Не удалось получить ход анализа");
      return payload as {jobs:AnalysisJob[];total:number;workerOnline:boolean};
    }
    async function poll(){
      if(!live||polling)return;polling=true;
      try{
        // Discover active work after refresh; finished historical attempts are not displayed.
        const discovered=await read("activeOnly=true&limit=100");if(!live)return;
        setOnline(discovered.workerOnline);merge(discovered.jobs);
        const ids=[...tracked.current.values()].filter(active).map(j=>j.id);
        let changed=false;
        for(let start=0;start<ids.length;start+=100){
          const payload=await read(`ids=${encodeURIComponent(ids.slice(start,start+100).join(","))}`);if(!live)return;
          merge(payload.jobs);
          for(const job of payload.jobs)if(!active(job)&&!finished.current.has(job.id)){finished.current.add(job.id);changed=true;}
        }
        if(changed)await callback.current();
        if(live)setError("");
      }catch(reason){if(live&&!abort.signal.aborted)setError(reason instanceof Error?reason.message:"Не удалось обновить ход анализа");}
      finally{polling=false;if(live)timer=setTimeout(poll,[...tracked.current.values()].some(active)?1200:8000);}
    }
    wake.current=()=>{clearTimeout(timer);void poll();};
    void poll();
    return()=>{live=false;abort.abort();clearTimeout(timer);wake.current=null;};
  },[caseId,merge]);
  const dismiss=()=>{for(const [id,job] of tracked.current)if(!active(job))tracked.current.delete(id);setJobs([...tracked.current.values()]);};
  async function retry(job:AnalysisJob){
    const response=await fetch("/api/processing-jobs",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({caseId,id:job.id,action:"retry"})});
    const payload=await response.json();if(!response.ok)throw new Error(payload.error||"Не удалось повторить чтение");
    watch(payload.job,job.name);
  }
  return {jobs,watch,error,online,dismiss,retry};
}

export default function DocumentAnalysisProgress({jobs,uploading,transfer,transferLabel,online,error,onDismiss,onRetry,canRetry,analysisEnabled}:{
  jobs:AnalysisJob[];uploading:boolean;transfer:number|null;transferLabel:string;online:boolean|null;error:string;
  onDismiss:()=>void;onRetry:(job:AnalysisJob)=>Promise<void>;canRetry:boolean;analysisEnabled:boolean;
}){
  const [expanded,setExpanded]=useState(false),[retrying,setRetrying]=useState(""),[retryError,setRetryError]=useState("");
  if(!uploading&&!jobs.length)return null;
  const summary=analysisSummary(jobs);
  const rank=(job:AnalysisJob)=>job.state==="running"?0:job.state==="retry"?1:job.state==="queued"?2:job.state==="failed"?3:4;
  const ordered=[...jobs].sort((a,b)=>rank(a)-rank(b)||b.createdAt.localeCompare(a.createdAt)),visible=expanded?ordered:ordered.slice(0,10);
  return <section className="upload-analysis" aria-label="Чтение и анализ документов">
    <div className="upload-analysis-heading"><div><FileSearch size={21}/><h3>{jobs.length||analysisEnabled?"Чтение и анализ документов":"Загрузка документов"}</h3></div>{!uploading&&!summary.active&&<button type="button" onClick={onDismiss}>Скрыть результаты</button>}</div>
    {uploading&&<div className="transfer-progress"><div><span>{transferLabel||"Передаём файлы"}</span><b>{transfer===null?"Передача…":`${transfer}%`}</b></div><ProgressBar value={transfer} label="Передача файлов на платформу"/></div>}
    {jobs.length>0&&<p className="analysis-progress-summary" role="status">Обработано: <b>{summary.done} из {summary.total}</b>{summary.active>0&&` · анализируются или ожидают чтения: ${summary.active}`}{summary.failed>0&&` · ошибок: ${summary.failed}`}</p>}
    {online===false&&summary.active>0&&<p className="stage-note">Обработчик сейчас недоступен. Оригиналы сохранены; чтение продолжится после его запуска. Анализ ещё не завершён.</p>}
    <ul className="analysis-progress-files">{visible.map(job=>{
      const progress=documentProgress(job),running=active(job),failed=job.state==="failed";
      const tone=failed?"failed":progress.attention?"attention":running?"active":"complete";
      return <li key={job.id} className={tone}>
        <div className="analysis-file-title">{failed||progress.attention?<TriangleAlert size={18}/>:running?<LoaderCircle size={18} className="progress-spinner"/>:<CheckCircle2 size={18}/>}<strong>{job.name}</strong><b>{progress.percent===null?"Нужна проверка":`${progress.percent}%`}</b></div>
        <span className="analysis-file-stage">{progress.label}</span>
        <ProgressBar value={progress.percent} label={`${job.name}: ${progress.label}`}/>
        {job.state==="completed"&&job.result.message&&<p>{job.result.message}</p>}
        {failed&&<p role="alert">{job.error||"Оригинал сохранён, но чтение не завершено."}</p>}
        {failed&&canRetry&&<button type="button" disabled={!!retrying} onClick={async()=>{setRetrying(job.id);setRetryError("");try{await onRetry(job);}catch(reason){setRetryError(reason instanceof Error?reason.message:"Ошибка повторного чтения");}finally{setRetrying("");}}}>{retrying===job.id?"Запускаем…":"Повторить чтение"}</button>}
      </li>;
    })}</ul>
    {jobs.length>10&&<button type="button" onClick={()=>setExpanded(v=>!v)}>{expanded?"Свернуть список":`Показать все файлы (${jobs.length})`}</button>}
    {(error||retryError)&&<p className="notice error" role="alert">{retryError||error}. Сохранённые файлы не удалены.</p>}
    {(jobs.length>0||analysisEnabled)&&<p className="analysis-progress-note">Процент анализа отражает завершённые этапы, а не время ожидания или долю страниц. 100% появляется после сохранения результата и пересчёта проверок. Реквизиты, OCR и замечания необходимо сверить с оригиналом.</p>}
  </section>;
}

function ProgressBar({value,label}:{value:number|null;label:string}){
  return <div className={`document-progress-track${value===null?" undetermined":""}`} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value??undefined} aria-valuetext={value===null?label:`${value}% · ${label}`}><span style={{width:`${value??0}%`}}/></div>;
}
