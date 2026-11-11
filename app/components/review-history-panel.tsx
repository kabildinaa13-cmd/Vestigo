"use client";
import {useEffect,useState} from "react";

type Employee={key:string;name:string;login:string};
type Entry={sequence:number;createdAt:string;employee:Employee;title:string;kind:string;kindLabel:string;previousState:string;newState:string;status:string;previousNote:string;reason:string;parties:{identifier:string;name:string}[];documents:{name:string;location:string;originalUrl:string|null}[];changed:boolean;legacy:boolean;contextNote:string};
type History={total:number;allDecisions:number;offset:number;limit:number;items:Entry[];stats:{reviewed:number;confirmations:number;rejections:number;unfinished:number};filters:{employees:Employee[];kinds:Record<string,string>;statuses:Record<string,string>};emptyMessage:string;statisticsNote:string};
const emptyFilters={from:"",to:"",employee:"",kind:"",counterparty:"",status:""};

export default function ReviewHistoryPanel({caseId,revision=""}:{caseId:string;revision?:string}){
  const [data,setData]=useState<History|null>(null),[filters,setFilters]=useState(emptyFilters),[offset,setOffset]=useState(0),[loading,setLoading]=useState(true),[error,setError]=useState(""),[version,setVersion]=useState(0);
  useEffect(()=>{setData(null);setFilters(emptyFilters);setOffset(0);setError("");},[caseId]);
  useEffect(()=>{if(!caseId)return;const c=new AbortController();setLoading(true);const timer=setTimeout(async()=>{
    try{const query=new URLSearchParams({caseId,view:"history",offset:String(offset),timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,...filters});const response=await fetch(`/api/analysis-center?${query}`,{signal:c.signal,cache:"no-store"});const result=await response.json();if(!response.ok)throw new Error(result.error||"Не удалось получить историю проверок");if(!c.signal.aborted){setData(result);setError("");}}
    catch(e){if(!c.signal.aborted)setError(e instanceof Error?e.message:"Ошибка получения истории");}
    finally{if(!c.signal.aborted)setLoading(false);}
  },250);return()=>{clearTimeout(timer);c.abort();};},[caseId,revision,filters,offset,version]);
  function update(key:keyof typeof emptyFilters,value:string){setFilters(f=>({...f,[key]:value}));setOffset(0);}
  return <section className="review-history" aria-label="История проверок" aria-busy={loading}>
    <div className="analysis-center-heading"><div><h3>История проверок</h3><p className="muted">Решения сотрудников по результатам анализа. Автоматическая обработка документов в эту историю не входит.</p></div><button type="button" disabled={loading} onClick={()=>setVersion(v=>v+1)}>Обновить историю</button></div>
    <div className="review-history-filters">
      <label>Дата с<input type="date" value={filters.from} onChange={e=>update("from",e.target.value)}/></label>
      <label>Дата по<input type="date" value={filters.to} onChange={e=>update("to",e.target.value)}/></label>
      <label>Сотрудник<select value={filters.employee} onChange={e=>update("employee",e.target.value)}><option value="">Все сотрудники</option>{data?.filters.employees.map(e=><option key={e.key} value={e.key}>{e.name}{e.login&&e.login!==e.name?` (${e.login})`:""}</option>)}</select></label>
      <label>Вид решения<select value={filters.kind} onChange={e=>update("kind",e.target.value)}><option value="">Все виды решений</option>{Object.entries(data?.filters.kinds||{}).map(([key,label])=><option value={key} key={key}>{label}</option>)}</select></label>
      <label>Контрагент: название или БИН<input type="search" value={filters.counterparty} onChange={e=>update("counterparty",e.target.value)} placeholder="Название организации или БИН…"/></label>
      <label>Результат решения<select value={filters.status} onChange={e=>update("status",e.target.value)}><option value="">Все статусы</option>{Object.entries(data?.filters.statuses||{}).map(([key,label])=><option value={key} key={key}>{label}</option>)}</select></label>
    </div>
    <div className="analysis-toolbar"><button type="button" onClick={()=>{setFilters(emptyFilters);setOffset(0);}}>Сбросить фильтры</button><span className="muted">Период учитывается в часовом поясе вашего устройства.</span></div>
    {loading&&<p role="status">{data?"Обновляем подборку…":"Загружаем историю проверок…"}</p>}{error&&<p className="notice error" role="alert">{error}</p>}
    {data&&!error&&<>
      <dl className="review-history-metrics">{[["Проверенных вопросов",data.stats.reviewed],["Подтверждений",data.stats.confirmations],["Отклонений",data.stats.rejections],["Незавершённых проверок",data.stats.unfinished]].map(([name,value])=><div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl>
      <p className="muted review-statistics-note">{data.statisticsNote}</p>
      {!loading&&!data.items.length&&<p className="review-history-empty" role="status">{data.emptyMessage}</p>}
      {!!data.items.length&&<p>Записей в подборке: {data.total}</p>}
      <div className="review-history-items">{data.items.map(e=><article className="review-history-card" key={e.sequence}>
        <div className="review-history-card-head"><time dateTime={e.createdAt}>{new Date(e.createdAt).toLocaleString("ru-RU")}</time><span className={`review-state review-state-${e.status}`}>{e.newState}</span></div>
        <p className="review-employee"><b>Сотрудник:</b> {e.employee.name}{e.employee.login&&e.employee.login!==e.employee.name?` (${e.employee.login})`:""}</p>
        <h4>{e.kindLabel}</h4>{e.changed&&<p className="review-change-note">Изменение ранее принятого решения</p>}
        <p><b>Проверяемый результат:</b> {e.title}</p>
        {!!e.parties.length&&<div className="review-parties">{e.parties.map(p=><p key={p.identifier}>{p.name}<small>БИН/ИИН {p.identifier}</small></p>)}</div>}
        <dl className="review-state-change"><div><dt>Предыдущее состояние</dt><dd>{e.previousState}</dd></div><div><dt>Новое состояние</dt><dd>{e.newState}</dd></div></dl>
        {e.previousNote&&e.previousNote!==e.reason&&<details><summary>Предыдущее обоснование</summary><p className="review-reason">{e.previousNote}</p></details>}
        <div className="review-reason-box"><b>Обоснование / комментарий</b><p className="review-reason">{e.reason||"Обоснование не было сохранено"}</p></div>
        <h4>Связанные документы и первоисточники</h4>{e.documents.length?<ul className="review-source-list">{e.documents.map((s,i)=><li key={i}>{s.originalUrl?<a href={s.originalUrl} target="_blank" rel="noreferrer">{s.name}</a>:<span>{s.name}</span>}<small>{s.location}</small></li>)}</ul>:<p className="muted">Источники в старой записи не зафиксированы.</p>}
        {e.contextNote&&<p className="muted review-legacy-note">{e.contextNote}</p>}
      </article>)}</div>
      {data.total>data.limit&&<div className="analysis-pagination"><button type="button" disabled={!offset||loading} onClick={()=>setOffset(Math.max(0,offset-data.limit))}>← Назад</button><span>{offset+1}–{Math.min(offset+data.limit,data.total)} из {data.total}</span><button type="button" disabled={offset+data.limit>=data.total||loading} onClick={()=>setOffset(offset+data.limit)}>Далее →</button></div>}
    </>}
  </section>;
}
