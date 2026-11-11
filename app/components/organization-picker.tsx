"use client";
import {useEffect,useId,useMemo,useRef,useState} from 'react';
import {searchOrganizations} from '../lib/organization-search.mjs';
type Organization={identifier:string;name:string};
export default function OrganizationPicker({items,value,onChange}:{items:Organization[];value:string;onChange:(identifier:string)=>void}){
    const id=useId(),[query,setQuery]=useState(''),[open,setOpen]=useState(false),[active,setActive]=useState(0),list=useRef<HTMLDivElement>(null);
    const selected=items.find(item=>item.identifier===value);
    const matches=useMemo(()=>searchOrganizations(items,query),[items,query]);
    const options=[...(!query.trim()?[{identifier:'',name:'Все организации — раздельные балансы'}]:[]),...matches];
    const shown=selected?`${selected.name} · ${selected.identifier}`:value||'Все организации — раздельные балансы';
    useEffect(()=>{setQuery('');setOpen(false);setActive(0);},[value]);
    useEffect(()=>setActive(0),[query]);
    useEffect(()=>{if(open)list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({block:'nearest'});},[active,open]);
    const choose=(item:Organization)=>{onChange(item.identifier);setOpen(false);setQuery('');setActive(0);};
    return <div className="organization-picker" onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node|null)){setOpen(false);setQuery('');}}}>
        <label htmlFor={id}>Организация — объект расчёта</label>
        <div className="organization-picker-input"><input id={id} role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={`${id}-list`} aria-activedescendant={open&&options[active]?`${id}-option-${active}`:undefined} autoComplete="off" placeholder="Поиск по названию или БИН/ИИН…" value={open?query:shown} onFocus={()=>{setOpen(true);setQuery('');setActive(0);}} onClick={()=>setOpen(true)} onChange={e=>{setQuery(e.target.value);setOpen(true);setActive(0);}} onKeyDown={e=>{
            if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();setOpen(true);setActive(a=>Math.max(0,Math.min(options.length-1,a+(e.key==='ArrowDown'?1:-1))));}
            else if(e.key==='Enter'&&open){e.preventDefault();if(options[active])choose(options[active]);}
            else if(e.key==='Escape'){e.preventDefault();setOpen(false);setQuery('');}
            else if(e.key==='Tab'){setOpen(false);setQuery('');}
        }}/><button type="button" aria-label="Сбросить выбранную организацию" disabled={!value&&!query} onClick={()=>{onChange('');setQuery('');setOpen(false);}}>×</button></div>
        {open&&<div className="organization-picker-popup"><div ref={list} role="listbox" aria-label="Найденные организации" id={`${id}-list`}>{options.map((item,index)=><button type="button" role="option" aria-selected={item.identifier===value} id={`${id}-option-${index}`} data-index={index} className={active===index?'is-active':''} key={item.identifier} onMouseDown={e=>e.preventDefault()} onMouseEnter={()=>setActive(index)} onClick={()=>choose(item)}><span>{item.name}</span>{item.identifier&&<small>{item.identifier}</small>}</button>)}</div><div className="organization-picker-count" role="status">{matches.length?`Найдено организаций: ${matches.length}`:'Организации не найдены'}</div></div>}
    </div>;
}
