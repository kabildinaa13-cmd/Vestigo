"use client";
import {useEffect,useRef,useState} from "react";
export default function CaseDeleteDialog({item,busy,onClose,onConfirm}:{item:{id:string;caseNumber:string};busy:boolean;onClose:()=>void;onConfirm:(id:string,confirmationNumber:string)=>Promise<void>}){
 const dialog=useRef<HTMLDialogElement>(null),[confirmation,setConfirmation]=useState("");
 useEffect(()=>{const node=dialog.current;node?.showModal();return()=>node?.close();},[]);
 return <dialog ref={dialog} className="case-delete-dialog" aria-labelledby="case-delete-title" onCancel={e=>{e.preventDefault();if(!busy)onClose();}}>
  <form onSubmit={e=>{e.preventDefault();if(!busy&&confirmation.trim()===item.caseNumber)void onConfirm(item.id,confirmation);}}>
   <h2 id="case-delete-title">Удалить дело «{item.caseNumber}»?</h2>
   <p>Дело исчезнет из рабочего списка, поиска и аналитики. Его документы, операции и графы сохранятся в корзине для восстановления. Другие дела и общие документы не будут удалены.</p>
   <label>Введите номер дела для подтверждения: <strong>{item.caseNumber}</strong><input value={confirmation} onChange={e=>setConfirmation(e.target.value)} disabled={busy} autoComplete="off" autoFocus required/></label>
   <div className="case-actions"><button type="button" disabled={busy} onClick={onClose}>Отмена</button><button type="submit" className="case-danger" disabled={busy||confirmation.trim()!==item.caseNumber}>{busy?"Удаляем…":"Удалить в корзину"}</button></div>
  </form>
 </dialog>;
}
