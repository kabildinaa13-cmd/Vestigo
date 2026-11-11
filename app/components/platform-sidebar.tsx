"use client";

import {FolderOpen,Files,ArrowLeftRight,Calculator,ShieldCheck,Wallet,FileBarChart,Network,LayoutDashboard,Building2,TriangleAlert,ExternalLink,Upload,Search,Bell,ArrowRight,Check,Clock,Link,RefreshCw,UserRound, type LucideIcon} from "lucide-react";
import {SidebarToggle} from "./theme-provider";
import {AccountMenu} from "./session-provider";

const icons:Record<string,LucideIcon>={case:FolderOpen,documents:Files,operations:ArrowLeftRight,calculation:Calculator,review:ShieldCheck,reimbursement:Wallet,reports:FileBarChart,graph:Network,overview:LayoutDashboard,objects:Building2,risks:TriangleAlert,source:ExternalLink,upload:Upload,search:Search,bell:Bell,arrow:ArrowRight,check:Check,clock:Clock,link:Link,refresh:RefreshCw};
export function UiIcon({name,size=20}:{name:string;size?:number}){const Icon=icons[name]||Files;return <Icon size={size} strokeWidth={1.75} aria-hidden="true"/>;}
type Item={label:string;icon:string;active?:boolean;onClick?:()=>void;href?:string;badge?:string};
export default function PlatformSidebar({items,profile}:{items:Item[];profile?:{name:string;detail:string}}){
  return <aside className="sidebar platform-sidebar">
    <a className="platform-brand" href="/" aria-label="Vestigo — дела и материалы">
      <svg width="38" height="38" viewBox="0 0 38 38" fill="none" aria-hidden="true"><path d="M3 7h9l9 22-4 8L3 7Z" fill="currentColor" opacity=".65"/><path d="M22 7h12L21 33l-6-12 7-14Z" fill="currentColor"/></svg>
      <span><strong>Vestigo</strong></span>
    </a>
    <div className="sidebar-section-label" aria-hidden="true" />
    <nav aria-label="Разделы Vestigo">{items.map(item=>{
      const content=<><UiIcon name={item.icon}/><span className="nav-label">{item.label}</span>{item.badge&&<em>{item.badge}</em>}<span className="nav-tooltip" role="tooltip">{item.label}</span></>;
      const props={className:`platform-nav-item${item.active?" active":""}`,"aria-label":item.label,"aria-current":item.active?"page" as const:undefined};
      return item.href?<a key={item.label} {...props} href={item.href}>{content}</a>:<button key={item.label} {...props} type="button" onClick={item.onClick}>{content}</button>;
    })}</nav>
    <div className="sidebar-bottom"><SidebarToggle/><AccountMenu/></div>
  </aside>;
}
