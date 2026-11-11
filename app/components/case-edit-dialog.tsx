"use client";
import {FormEvent,useEffect,useRef,useState} from "react";
type Item={id:string;version:number;caseNumber:string;erdrNumber:string;unitName:string;description:string;periodFrom:string;periodTo:string;qualifications?:string[]};
export default function CaseEditDialog({item,onClose,onSaved}:{item:Item;onClose:()=>void;onSaved:()=>Promise<void>}){
  const dialog=useRef<HTMLDialogElement>(null),[busy,setBusy]=useState(false),[error,setError]=useState("");
  useEffect(()=>{const node=dialog.current;node?.showModal();return()=>node?.close();},[]);
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(busy)return;const data=new FormData(event.currentTarget),fields={...Object.fromEntries(data),qualifications:data.getAll('qualifications')};setBusy(true);setError("");
    try{const response=await fetch("/api/cases",{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({id:item.id,action:"update",expectedVersion:item.version,...fields})}),body=await response.json();if(!response.ok)throw new Error(body.error||"Не удалось сохранить реквизиты");await onSaved();onClose();}
    catch(reason){setError(reason instanceof Error?reason.message:"Не удалось сохранить реквизиты");}finally{setBusy(false);}
  }
  return <dialog ref={dialog} className="case-delete-dialog case-edit-dialog" aria-labelledby="case-edit-title" onCancel={e=>{e.preventDefault();if(!busy)onClose();}}>
    <h2 id="case-edit-title">Редактирование дела</h2><p>Изменяются только реквизиты карточки. Документы, расчёты и история проверок сохраняются.</p>
    {error&&<p role="alert" className="notice error">{error}</p>}
    <form className="form-grid" onSubmit={submit}><fieldset disabled={busy} className="case-edit-fields">
      <label>Номер дела/материала<input name="caseNumber" required maxLength={200} defaultValue={item.caseNumber} autoFocus/></label>
      <label>Номер ЕРДР<input name="erdrNumber" maxLength={100} defaultValue={item.erdrNumber}/></label>
      <label className="full">Подразделение<input name="unitName" maxLength={300} defaultValue={item.unitName}/></label>
      <label>Период с<input name="periodFrom" type="date" defaultValue={item.periodFrom}/></label><label>Период по<input name="periodTo" type="date" defaultValue={item.periodTo}/></label>
      <fieldset className="full"><legend>Предполагаемая квалификация — выбор сотрудника</legend>{['214','216'].map(q=><label key={q}><input type="checkbox" name="qualifications" value={q} defaultChecked={item.qualifications?.includes(q)}/> Статья {q}</label>)}</fieldset>
      <label className="full">Краткое описание<textarea name="description" rows={4} maxLength={20000} defaultValue={item.description}/></label>
    </fieldset><div className="case-actions full"><button type="button" disabled={busy} onClick={onClose}>Отмена</button><button className="primary" disabled={busy}>{busy?"Сохраняем…":"Сохранить изменения"}</button></div></form>
  </dialog>;
}
