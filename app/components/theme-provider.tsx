"use client";

import {createContext, useContext, useEffect, useState, type ReactNode} from "react";
import {Moon, Sun, PanelLeftClose, PanelLeftOpen} from "lucide-react";
import {THEME_KEY,SIDEBAR_KEY} from "../lib/appearance.mjs";

type Theme = "light" | "dark";
const ThemeContext = createContext({theme:"light" as Theme, collapsed:false, toggleTheme:()=>{}, toggleSidebar:()=>{}});

export function ThemeProvider({children}:{children:ReactNode}) {
  const [theme,setTheme]=useState<Theme>("light");
  const [collapsed,setCollapsed]=useState(false);
  useEffect(()=>{
    const system=window.matchMedia("(prefers-color-scheme: dark)");
    const compact=window.matchMedia("(max-width: 760px)");
    const sync=()=>{
      let saved:string|null=null,sidebar:string|null=null;
      try{saved=localStorage.getItem(THEME_KEY);sidebar=localStorage.getItem(SIDEBAR_KEY);}catch{}
      const next:Theme=saved==="dark"||saved==="light"?saved:system.matches?"dark":"light";
      document.documentElement.dataset.theme=next;
      const isCollapsed=sidebar==="true"||(sidebar!=="false"&&compact.matches);
      document.documentElement.dataset.sidebar=isCollapsed?"collapsed":"expanded";
      setTheme(next);setCollapsed(isCollapsed);
    };
    sync();system.addEventListener("change",sync);compact.addEventListener("change",sync);
    const storage=(event:StorageEvent)=>{if(event.key===THEME_KEY||event.key===SIDEBAR_KEY||event.key===null)sync();};
    window.addEventListener("storage",storage);
    return()=>{system.removeEventListener("change",sync);compact.removeEventListener("change",sync);window.removeEventListener("storage",storage);};
  },[]);
  function toggleTheme(){
    const next:Theme=theme==="dark"?"light":"dark";
    document.documentElement.dataset.theme=next;setTheme(next);
    try{localStorage.setItem(THEME_KEY,next);}catch{}
  }
  function toggleSidebar(){
    const next=!collapsed;document.documentElement.dataset.sidebar=next?"collapsed":"expanded";setCollapsed(next);
    try{localStorage.setItem(SIDEBAR_KEY,String(next));}catch{}
  }
  return <ThemeContext.Provider value={{theme,collapsed,toggleTheme,toggleSidebar}}>{children}</ThemeContext.Provider>;
}

export function ThemeToggle(){
  const {theme,toggleTheme}=useContext(ThemeContext);
  const label=theme==="dark"?"Включить светлую тему":"Включить тёмную тему";
  return <button type="button" className="appearance-toggle" onClick={toggleTheme} aria-label={label} title={label} aria-pressed={theme==="dark"}>
    {theme==="dark"?<Moon size={19} aria-hidden="true"/>:<Sun size={19} aria-hidden="true"/>}
    <span>{theme==="dark"?"Тёмная тема":"Светлая тема"}</span>
  </button>;
}

export function SidebarToggle(){
  const {collapsed,toggleSidebar}=useContext(ThemeContext);
  const label=collapsed?"Развернуть меню":"Свернуть меню";
  return <button type="button" className="sidebar-toggle" onClick={toggleSidebar} title={label} aria-label={label} aria-expanded={!collapsed}>
    {collapsed?<PanelLeftOpen size={19}/>:<PanelLeftClose size={19}/>}<span>{label}</span>
  </button>;
}
