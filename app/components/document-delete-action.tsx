"use client";
import {useState} from 'react';
type Result={message:string;cleanupPending?:boolean;sharedOriginal?:boolean};
export default function DocumentDeleteAction({caseId,item,disabled=false,onDeleted}:{caseId:string;item:Record<string,any>;disabled?:boolean;onDeleted:(result:Result)=>Promise<void>}){
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 async function remove(){
  if(!window.confirm(`Полностью удалить «${item.name}» из этого дела? Файл исчезнет из списка, поиска, операций и графа. Восстановление через платформу невозможно — понадобится повторная загрузка. Если оригинал используется в другом деле, он сохранится там. История действий сохранится.`))return;
  setBusy(true);setError('');let deleted=false;
  try{const r=await fetch(`/api/documents/${encodeURIComponent(item.id)}`,{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({caseId,mode:'permanent',confirmationName:item.name})});const data=await r.json();if(!r.ok)throw Error(data.error||'Не удалось удалить файл');deleted=true;await onDeleted(data);}
  catch(e){setError(deleted?'Файл удалён, но список не обновился. Нажмите «Обновить результаты».':e instanceof Error?e.message:'Не удалось удалить файл');}finally{setBusy(false);}
 }
 return <span><button type="button" aria-label={`Удалить полностью: ${item.name}`} disabled={disabled||busy} onClick={remove}>{busy?'Удаляем…':'Удалить полностью'}</button>{error&&<span role="alert">{error}</span>}</span>;
}
