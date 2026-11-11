"use client";

import {useEffect,useId,useMemo,useRef,useState} from "react";
import {DOCUMENT_GROUPS,documentType} from "../lib/document-types.mjs";

type CategoryDocument = {id:string;name:string;groupId:string;typeId:string;excluded?:boolean};

export default function DocumentCategoryBrowser({caseId,documents,loading,onShowInRegistry}:{
  caseId:string;documents:CategoryDocument[];loading:boolean;
  onShowInRegistry:(groupId:string)=>void;
}) {
  const [groupId,setGroupId]=useState("");
  const dialog=useRef<HTMLDialogElement>(null);
  const titleId=useId(),descriptionId=useId();
  const group=DOCUMENT_GROUPS.find(item=>item.id===groupId);
  const byGroup=useMemo(()=>{
    const groups=new Map<string,CategoryDocument[]>();
    for(const document of documents){
      const list=groups.get(document.groupId);
      if(list)list.push(document);
      else groups.set(document.groupId,[document]);
    }
    return groups;
  },[documents]);
  const items=group ? byGroup.get(group.id)||[] : [];
  const isOpen=!!group;

  useEffect(()=>{
    const node=dialog.current;
    if(isOpen&&node&&!node.open)node.showModal();
    return ()=>{if(node?.open)node.close();};
  },[isOpen]);

  function close(){
    dialog.current?.close();
    setGroupId("");
  }

  return <>
    <div className="document-groups" aria-label="Группы документов">
      {DOCUMENT_GROUPS.map(category=><button key={category.id} type="button"
        className={groupId===category.id?"document-group selected":"document-group"}
        aria-haspopup="dialog" disabled={!caseId||loading} onClick={()=>setGroupId(category.id)}>
        <strong>{category.name}</strong>{category.note&&<small>{category.note}</small>}
        <span>Документов: {byGroup.get(category.id)?.length||0}</span>
      </button>)}
    </div>
    {group&&<dialog ref={dialog} className="document-category-dialog" aria-labelledby={titleId} aria-describedby={descriptionId}
      onCancel={event=>{event.preventDefault();close();}}>
      <header className="document-category-heading">
        <div><h3 id={titleId}>{group.name}</h3><p id={descriptionId}>Документов в выбранном деле: {items.length}</p></div>
        <button type="button" autoFocus onClick={close}>Закрыть</button>
      </header>
      <div className="document-category-body">
        {items.length ? <ul className="document-category-list">{items.map(item=><li key={item.id}>
          <a href={`/api/documents/${encodeURIComponent(item.id)}?${new URLSearchParams({caseId,inline:"1"})}`}
            target="_blank" rel="noreferrer" title="Открыть оригинал в новой вкладке">{item.name}</a>
          <small>{documentType(item.groupId,item.typeId)?.type.name||"Вид не указан"}{item.excluded?" · Убран из анализа":""}</small>
        </li>)}</ul> : <p>В этой категории пока нет документов.</p>}
      </div>
      {items.some(item=>!item.excluded)&&<footer className="document-category-actions">
        <button type="button" onClick={()=>{close();onShowInRegistry(group.id);}}>Показать в реестре</button>
      </footer>}
    </dialog>}
  </>;
}
