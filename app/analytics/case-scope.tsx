"use client";
import {createContext,useContext,useEffect,useState,ReactNode} from "react";
import {CaseEsfSummary,minorText,type EsfSummary} from "../components/esf-graph-panels";
import FinancialProfilePanel from "../components/financial-profile-panel";
type Scope={id:string;number:string;status:string;currency:string};
export const CaseScopeContext=createContext<Scope|null>(null);
export function analyticsFetch(input:RequestInfo|URL,init?:RequestInit){
  if(typeof window!=="undefined"&&typeof input==="string"){
    const scope=new URLSearchParams(window.location.search),caseId=scope.get("caseId");
    if(caseId){
      if(input.startsWith("/local-service/")||input.startsWith("/api/open-records")||input.startsWith("/api/sources"))return Promise.reject(new Error("В аналитике дела доступны только его документы. Общая база и внешнее обогащение не изменяются."));
      if(input.startsWith("/api/")){const url=new URL(input,window.location.origin);url.searchParams.set("caseId",caseId);url.searchParams.set("currency",scope.get("currency")||"KZT");return fetch(url,init);}
    }
  }
  return fetch(input,init);
}
export function CaseScopeProvider({scope,children}:{scope:Scope|null;children:ReactNode}){
  return <CaseScopeContext.Provider value={scope}>
    {scope&&<section className="case-scope-banner"><strong>Дело {scope.number}</strong><span>Один набор документов для операций, карточек, графа и рисков</span><label>Валюта сумм на графе<select value={scope.currency} onChange={e=>{const url=new URL(window.location.href);url.searchParams.set("currency",e.target.value);window.location.assign(url.toString());}}>{["KZT","USD","EUR","RUB","UNKNOWN"].map(c=><option key={c} value={c}>{c==="UNKNOWN"?"Не определена (суммы требуют проверки)":c}</option>)}</select></label><a href={`/?caseId=${scope.id}&tab=Документы`}>Документы дела →</a><a href={`/?caseId=${scope.id}&tab=Операции`}>Операции и цепочки →</a></section>}
    {children}
  </CaseScopeContext.Provider>;
}
type Operation={type:string;amountMinor:number;currency:string;conflict:boolean;reviewStatus:string;sources:{name:string;documentId:string}[]};
export function CaseFinancialSummary({bin}:{bin:string}){
  const selectedScope=useContext(CaseScopeContext);
  return selectedScope?<><FinancialProfilePanel caseId={selectedScope.id} identifier={bin} archived={selectedScope.status==='archived'}/><LegacyCaseFinancialSummary bin={bin}/></>:null;
}
export function LegacyCaseFinancialSummary({bin}:{bin:string}){
  const [esf,setEsf]=useState<EsfSummary|null>(null);
  const scope=useContext(CaseScopeContext),[operations,setOperations]=useState<Operation[]>([]),[error,setError]=useState("");
  useEffect(()=>{const abort=new AbortController();setEsf(null);setError("");analyticsFetch(`/api/financials?bin=${encodeURIComponent(bin)}`,{signal:abort.signal,cache:"no-store"}).then(async r=>{const p=await r.json();if(!r.ok)throw new Error(p.error);setOperations(p.caseOperations||[]);setEsf(p.esfSummary||null);}).catch(reason=>{if(!abort.signal.aborted)setError(reason.message);});return()=>abort.abort();},[bin]);
  const totals=new Map<string,bigint>();for(const o of operations){if(o.type==="invoice"||o.conflict||o.reviewStatus==="rejected"||o.currency==="UNKNOWN"||!Number.isSafeInteger(o.amountMinor))continue;const key=`${o.type} ${o.currency}`;totals.set(key,(totals.get(key)||0n)+BigInt(o.amountMinor));}
  const labels:Record<string,string>={invoice:"ЭСФ",payment:"Платежи",contract:"Договоры",primary:"Исполнение",accounting:"Учёт",claim:"Требования",reimbursement:"Возвраты"};
  return <section className="dossier-section"><h3>Операции участника в этом деле</h3><p>Типы и валюты показаны отдельно. Эти суммы нельзя складывать в единый доход или ущерб.</p>{esf&&<CaseEsfSummary summary={esf}/>} {error&&<p role="alert">{error}</p>}<div className="case-totals">{[...totals].map(([key,n])=>{const [type,currency]=key.split(" ");return <p key={key}><b>{labels[type]||type}:</b> {minorText(n.toString(),currency)}</p>;})}</div><a href={`/?caseId=${scope?.id}&tab=Операции`}>Открыть операции, источники и цепочки дела →</a></section>;
}
