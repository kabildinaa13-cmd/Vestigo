"use client";
import {useEffect,useState} from "react";
import {compareWorkCosts} from "../lib/work-cost-comparison.mjs";
import {formatMinor} from "./calculations-panel";

type Fact={label:string;raw:string;line:number;page:number};
type Source={id:string;name:string;hash:string;role:"planned"|"actual";reference:string;facts:Fact[];minor?:string;currency?:string;problem?:string};

export default function WorkCostFields({caseId}:{caseId:string}){
 const [sources,setSources]=useState<Source[]|null>(null),[error,setError]=useState(""),[planned,setPlanned]=useState(""),[selected,setSelected]=useState<string[]>([]);
 useEffect(()=>{
  const abort=new AbortController();
  fetch(`/api/case-workflow?caseId=${encodeURIComponent(caseId)}&view=work-comparison`,{signal:abort.signal,cache:"no-store"})
   .then(async r=>{const body=await r.json();if(!r.ok)throw new Error(body.error);return body.sources as Source[];})
   .then(v=>{if(!abort.signal.aborted){setSources(v);setPlanned(v.filter(d=>d.role==="planned"&&!d.problem).length===1?v.find(d=>d.role==="planned"&&!d.problem)!.id:"");}})
   .catch(e=>{if(!abort.signal.aborted)setError(e.message);});
  return ()=>abort.abort();
 },[caseId]);
 const base=sources?.filter(d=>d.role==="planned"&&!d.problem)||[],acts=sources?.filter(d=>d.role==="actual"&&!d.problem)||[];
 const chosenBase=base.find(d=>d.id===planned),chosenActs=acts.filter(d=>selected.includes(d.id));
 const result=planned&&chosenActs.length?compareWorkCosts(chosenBase,chosenActs):null;
 const original=(d:Source,f:Fact)=>`/api/documents/${encodeURIComponent(d.id)}?${new URLSearchParams({caseId,inline:"1"})}${f.page?`#page=${f.page}`:""}`;
 return <div className="full">
  {error?<p role="alert">{error}</p>:!sources?<p>Читаем сохранённые реквизиты…</p>:<>
   {!base.length&&<p>Не найдена общая стоимость работ с валютой. Проверьте договор, смету или расчёт.</p>}
   {!acts.length&&<p>Не найдена стоимость фактического исполнения с валютой. Проверьте акты. Без акта сумма не считается нулевой.</p>}
   {base.length>0&&<label>Документ с общей стоимостью <select name="plannedDocumentId" value={planned} onChange={e=>setPlanned(e.target.value)}><option value="">Выберите документ</option>{base.map(d=><option key={d.id} value={d.id}>{d.name} — {formatMinor(d.minor,d.currency!)}</option>)}</select></label>}
   {acts.length>0&&<fieldset><legend>Акты фактического исполнения</legend><p>Отметьте акты по выбранным работам. Один и тот же объём работ учитывайте один раз.</p>{acts.map(d=><label key={d.id}><input type="checkbox" name="actDocumentId" value={d.id} checked={selected.includes(d.id)} onChange={e=>setSelected(prev=>e.target.checked?[...prev,d.id]:prev.filter(id=>id!==d.id))}/> {d.name} — {formatMinor(d.minor,d.currency!)}</label>)}</fieldset>}
   {result?.error?<p role="alert">{result.error}</p>:result&&result.currency?<div role="status">
    <p><strong>{result.exceedsPlan?"Разница":"Предварительный расчёт ущерба"}: {formatMinor(result.differenceMinor,result.currency)}</strong></p>
    <p>{formatMinor(result.plannedMinor,result.currency)} − {formatMinor(result.actualMinor,result.currency)} = {formatMinor(result.differenceMinor,result.currency)}.</p>
    {result.exceedsPlan&&<p>Стоимость исполнения выше общей стоимости. Сверьте объём работ и выбранные документы.</p>}
    {!result.exceedsPlan&&<><input type="hidden" name="documentCostCurrency" value={result.currency}/><input type="hidden" name="documentCostGross" value={result.plannedMinor}/><input type="hidden" name="documentCostFulfilled" value={result.actualMinor}/></>}
   </div>:null}
   {(chosenBase||chosenActs.length>0)&&<ul>{[...(chosenBase?[chosenBase]:[]),...chosenActs].map(d=><li key={d.id}>{d.facts.map((f,i)=><div key={i}><a href={original(d,f)} target="_blank" rel="noreferrer">{d.name}</a> · {f.page?`стр. ${f.page}, `:""}строка {f.line}: {f.label} — {f.raw}</div>)}</li>)}</ul>}
   {sources.some(d=>d.problem)&&<details><summary>Какие документы требуют уточнения</summary><ul>{sources.filter(d=>d.problem).map(d=><li key={d.id}>{d.name}: {d.problem}</li>)}</ul></details>}
  </>}
 </div>;
}
