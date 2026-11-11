"use client";
import {useEffect,useState} from "react";
import {DOCUMENT_GROUPS} from "../lib/document-types.mjs";
type Segment={from:number;to:number;groupId:string;typeId:string;approved:boolean;note:string;fields:Record<string,string>;automatic?:{eligible:boolean;missing:string[];conflicts:string[]};fieldEvidence?:Record<string,string[]>;candidates:{identifiers:string[];dates:string[];amounts:string[];invoiceNumbers:string[];contractReferences:string[]};excerpt:string;ocr:boolean;hasUnreadPages:boolean;qualityReviewRequired?:boolean};
export type PdfAnalysis={version:string;sourceDigest:string;segments:Segment[];reviewed:number;automaticallyExtracted?:number;unresolved?:number;total:number;ocrPages:number;engines:string[];kazakhAvailable:boolean|null;links:{from:number;to:number;reference:string;explanation:string}[]};
const fields:Record<string,string>={senderId:"БИН/ИИН поставщика / отправителя",senderName:"Наименование поставщика / отправителя",recipientId:"БИН/ИИН покупателя / получателя",recipientName:"Наименование покупателя / получателя",date:"Дата операции — ГГГГ-ММ-ДД",amount:"Общая сумма документа",currency:"Валюта — KZT, USD…",number:"Номер документа / ЭСФ",contractRef:"Номер договора-основания",reference:"Ссылка на связанную ЭСФ / иной документ",purpose:"Предмет / назначение"};
export default function PdfDocumentAnalysis({analysis,caseId,documentId,onUpdated}:{analysis:PdfAnalysis;caseId:string;documentId:string;onUpdated:()=>Promise<void>}){
  const [segments,setSegments]=useState(analysis.segments),[busy,setBusy]=useState(false),[error,setError]=useState("");
  useEffect(()=>setSegments(analysis.segments),[analysis]);
  function change(index:number,patch:Partial<Segment>){setSegments(values=>values.map((s,i)=>i===index?{...s,...patch}:s));}
  async function save(reset=false){setBusy(true);setError("");try{
    const response=await fetch(`/api/documents/${encodeURIComponent(documentId)}/analyze`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(reset?{caseId,resetSegmentReviews:true}:{caseId,segmentReviewDigest:analysis.sourceDigest,segmentReviews:segments.map(({from,to,groupId,typeId,fields,approved,note})=>({from,to,groupId,typeId,fields,approved,note}))})});
    const payload=await response.json();if(!response.ok)throw new Error(payload.error);await onUpdated();
  }catch(reason){setError(reason instanceof Error?reason.message:"Не удалось применить сверку");}finally{setBusy(false);}}
  return <section aria-label="Автоматический разбор PDF">
    <h3>Документы по страницам</h3>
    <p>Фрагментов: {analysis.total}. Автоматически включено в аналитику: {analysis.automaticallyExtracted||0}. Дополнено специалистом: {analysis.reviewed}. OCR: {analysis.ocrPages} страниц ({analysis.engines.join(", ")||"не использовалось"}).</p>
    <p>Полные однозначные реквизиты уже участвуют в операциях, сопоставлении и графе без обязательного ручного ввода. Автоматический результат предварительный: он не подтверждает фактическое исполнение. Для неполных фрагментов ниже показаны конкретные отсутствующие поля.</p>
    {analysis.kazakhAvailable===false&&<p className="stage-note">Казахский OCR-пакет не установлен: проверьте казахский текст и имена по оригиналу.</p>}
    {error&&<p className="notice error" role="alert">{error}</p>}
    {segments.map((s,i)=><details key={i} open={i===0}>
      <summary>Документ {i+1}: страницы {s.from}–{s.to} · {DOCUMENT_GROUPS.find(g=>g.id===s.groupId)?.types.find(t=>t.id===s.typeId)?.name||"Вид не определён"} · {s.approved?"сверен":s.automatic?.eligible?"автоматически в аналитике":"недостаточно реквизитов"}</summary>
      {!!s.automatic?.missing.length&&<p>Не извлечено: {s.automatic.missing.map(key=>fields[key]||key).join("; ")}.</p>}
      {!!s.automatic?.conflicts.length&&<p className="notice error">Противоречивые поля: {s.automatic.conflicts.map(key=>fields[key]||key).join("; ")}. Операция автоматически не создана.</p>}
      {!!s.fieldEvidence&&<details><summary>Из каких фрагментов взяты реквизиты</summary>{Object.entries(s.fieldEvidence).map(([key,values])=><p key={key}><b>{fields[key]||key}:</b> {values.join("; ")}</p>)}</details>}
      {s.hasUnreadPages&&<p className="notice error">В этом фрагменте есть страницы без распознанного текста.</p>}
      {s.qualityReviewRequired&&<p className="stage-note">Низкое разрешение скана или низкое диагностическое качество OCR. Не полагайтесь на цифры без сверки; при возможности загрузите более качественную копию.</p>}
      <p><a href={`/api/documents/${encodeURIComponent(documentId)}?caseId=${encodeURIComponent(caseId)}&inline=1#page=${s.from}`} target="_blank" rel="noreferrer">Открыть оригинал: страницы {s.from}–{s.to}</a></p>
      <div className="form-grid">
        <label>Первая страница<input type="number" min={1} value={s.from} disabled={busy} onChange={e=>change(i,{from:Number(e.target.value),approved:false})}/></label>
        <label>Последняя страница<input type="number" min={s.from} value={s.to} disabled={busy} onChange={e=>change(i,{to:Number(e.target.value),approved:false})}/></label>
        <label>Группа<select value={s.groupId} disabled={busy} onChange={e=>change(i,{groupId:e.target.value,typeId:DOCUMENT_GROUPS.find(g=>g.id===e.target.value)?.types[0].id||"unclassified",approved:false})}>{DOCUMENT_GROUPS.map(g=><option key={g.id} value={g.id}>{g.name}</option>)}</select></label>
        <label>Вид<select value={s.typeId} disabled={busy} onChange={e=>change(i,{typeId:e.target.value,approved:false})}>{DOCUMENT_GROUPS.find(g=>g.id===s.groupId)?.types.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
      </div>
      <p>БИН/ИИН-кандидаты: {s.candidates.identifiers.join(", ")||"не выделены"}. Даты: {s.candidates.dates.join(", ")||"не выделены"}.</p>
      <p>Суммы-кандидаты (включая строки/НДС, это не итог): {s.candidates.amounts.join("; ")||"не выделены"}.</p>
      <pre className="extracted-text">{s.excerpt||"Текст отсутствует"}</pre>
      <div className="form-grid">{Object.entries(fields).map(([key,label])=><label key={key}>{label}<input value={s.fields[key]||""} maxLength={key==="purpose"?2000:300} disabled={busy} onChange={e=>change(i,{fields:{...s.fields,[key]:e.target.value},approved:false})}/></label>)}</div>
      <label>Основание сверки с оригиналом<input value={s.note||""} maxLength={4000} disabled={busy} onChange={e=>change(i,{note:e.target.value,approved:false})}/></label>
      <label><input type="checkbox" checked={s.approved} disabled={busy||!s.note.trim()} onChange={e=>change(i,{approved:e.target.checked})}/> Границы, вид и реквизиты сверены с оригиналом</label>
      <p>Для объединения продолжений отредактируйте диапазон и удалите лишний фрагмент; страницы не должны пересекаться или теряться.</p>
      <button disabled={busy||segments.length<=1} onClick={()=>setSegments(values=>values.filter((_,n)=>n!==i))}>Убрать фрагмент из предложенного разделения</button>
    </details>)}
    <button disabled={busy} onClick={()=>setSegments(values=>[...values,{from:1,to:1,groupId:"unclassified",typeId:"unclassified",approved:false,note:"",fields:{},candidates:{identifiers:[],dates:[],amounts:[],invoiceNumbers:[],contractReferences:[]},excerpt:"Новый диапазон — проверьте по оригиналу",ocr:false,hasUnreadPages:false}])}>Добавить диапазон страниц</button>
    <button className="primary" disabled={busy} onClick={()=>save()}>{busy?"Применяем сверку…":"Сохранить разделение и сверенные реквизиты"}</button>
    <p>Повторное предложение границ отменяет сохранённую сверку этого файла и пересчитывает связанные операции.</p>
    <button disabled={busy} onClick={()=>{if(window.confirm("Отменить сверку этого файла и заново предложить границы? Операции этого файла будут пересчитаны, оригинал сохранится."))void save(true);}}>Заново предложить границы</button>
    {!!analysis.links.length&&<details><summary>Ссылки по номерам — требуют сверки сторон</summary>{analysis.links.map((l,i)=><p key={i}>Документ {l.from} → {l.to}, № {l.reference}. {l.explanation}</p>)}</details>}
  </section>;
}
