"use client";
import {useEffect,useRef,useState} from "react";
type Job={id:string;name:string;state:string;attempts:number;maxAttempts:number;phase:string;error:string;updatedAt:string;result:{message?:string}};
type Payload={jobs:Job[];total:number;counts:Record<string,number>;workerOnline:boolean};
const labels:Record<string,string>={queued:"Принят в очередь",retry:"Ожидает повторной попытки",running:"Обрабатывается",completed:"Обработка завершена",failed:"Нужна проверка ошибки"};
export default function ProcessingQueuePanel({caseId,revision,canEdit,onUpdated}:{caseId:string;revision:number;canEdit:boolean;onUpdated:()=>Promise<void>}){
  const [data,setData]=useState<Payload|null>(null),[error,setError]=useState(""),[offset,setOffset]=useState(0),[refresh,setRefresh]=useState(0),[busy,setBusy]=useState("");
  const callback=useRef(onUpdated),signature=useRef<string|null>(null);callback.current=onUpdated;
  useEffect(()=>{setOffset(0);setData(null);signature.current=null;},[caseId]);
  useEffect(()=>{if(!caseId)return;const abort=new AbortController();let timer:ReturnType<typeof setTimeout>;let live=true;
    async function poll(){try{const response=await fetch(`/api/processing-jobs?caseId=${encodeURIComponent(caseId)}&offset=${offset}`,{cache:"no-store",signal:abort.signal});const result=await response.json();if(!response.ok)throw new Error(result.error);if(!live)return;setData(result);setError("");const next=JSON.stringify([result.counts.completed||0,result.counts.failed||0]);if(signature.current!==null&&signature.current!==next)await callback.current();signature.current=next;}
      catch(reason){if(live&&!abort.signal.aborted)setError(reason instanceof Error?reason.message:"Очередь недоступна");}finally{if(live)timer=setTimeout(poll,3000);}}
    void poll();return()=>{live=false;abort.abort();clearTimeout(timer);};
  },[caseId,offset,revision,refresh]);
  async function retry(id:string){setBusy(id);try{const response=await fetch("/api/processing-jobs",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({caseId,id,action:"retry"})});const p=await response.json();if(!response.ok)throw new Error(p.error);setRefresh(v=>v+1);}catch(reason){setError(reason instanceof Error?reason.message:"Ошибка повторной попытки");}finally{setBusy("");}}
  if(!caseId)return null;
  return <section className="panel processing-queue"><h2>Фоновая обработка документов</h2><p>После приёма файла и задания обработка не зависит от вкладки. Саму передачу ещё не принятых файлов прерывать нельзя. Компьютер или сервер с обработчиком должен работать.</p>{error&&<p className="notice error" role="alert">{error}</p>}{data&&<><p role="status">{data.workerOnline?"Обработчик подключён":"Обработчик не подключён или давно не отвечал; принятые задания сохранены"}. Ожидают: {(data.counts.queued||0)+(data.counts.retry||0)} · выполняются: {data.counts.running||0} · завершены: {data.counts.completed||0} · с ошибкой: {data.counts.failed||0}.</p>
    {data.jobs.map(j=><article key={j.id} className="document-card"><strong>{j.name}</strong><p>{labels[j.state]||j.state} · попытка {j.attempts} из {j.maxAttempts}</p>{j.result.message&&<p>{j.result.message}</p>}{j.error&&<p className="notice error">{j.error}</p>}{j.state==="failed"&&canEdit&&<button disabled={!!busy} onClick={()=>retry(j.id)}>{busy===j.id?"Сохраняем…":"Повторить обработку"}</button>}</article>)}
    {!data.total&&<p>Принятых заданий этого дела пока нет.</p>}{data.total>50&&<div className="analysis-pagination"><button disabled={!offset} onClick={()=>setOffset(Math.max(0,offset-50))}>← Предыдущие</button><span>{offset+1}–{Math.min(data.total,offset+50)} из {data.total}</span><button disabled={offset+50>=data.total} onClick={()=>setOffset(offset+50)}>Следующие →</button></div>}</>}</section>;
}
