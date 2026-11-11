"use client";
import {useState} from 'react';
export default function DocumentScopeAction({caseId,item,disabled,onChanged}:{caseId:string;item:{id:string;name:string;excluded?:boolean};disabled:boolean;onChanged:()=>Promise<void>}){
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 async function change(){
  const message=item.excluded?`Вернуть «${item.name}» в анализ этого дела?`:`Убрать «${item.name}» из анализа этого дела? Его операции исчезнут из расчётов и схем. Оригинал и история сохранятся; файл можно вернуть или загрузить повторно.`;
  if(!window.confirm(message))return;
  setBusy(true);setError('');
  try{const r=await fetch('/api/case-analysis',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({caseId,kind:'document',id:item.id,status:item.excluded?'active':'excluded',note:item.excluded?'Сотрудник вернул документ в анализ через реестр файлов':'Сотрудник убрал документ из анализа через реестр файлов'})});const data=await r.json();if(!r.ok)throw Error(data.error||'Не удалось изменить состав материалов');await onChanged();}
  catch(e){setError(e instanceof Error?e.message:'Не удалось изменить состав материалов');}finally{setBusy(false);}
 }
 return <span><button type="button" disabled={disabled||busy} onClick={change}>{busy?'Сохраняем…':item.excluded?'Вернуть в анализ':'Убрать из анализа'}</button>{error&&<span role="alert">{error}</span>}</span>;
}
