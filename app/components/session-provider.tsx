"use client";
import {createContext,useContext,useEffect,useState,type ReactNode} from "react";
import {LogOut,UserRound,UsersRound} from "lucide-react";
type User={id:string;login:string;displayName:string};
const SessionContext=createContext<User|null>(null);
export const useSession=()=>useContext(SessionContext);
export function SessionProvider({children}:{children:ReactNode}){
 const [user,setUser]=useState<User|null>(null);
 useEffect(()=>{
  let alive=true;const original=window.fetch.bind(window);
  // Existing screens keep their normal error handling; a lost session also
  // closes the private workspace instead of leaving stale data on screen.
  const wrapped:typeof fetch=async(input,init)=>{const response=await original(input,init);const url=typeof input==="string"?input:input instanceof URL?input.href:input.url;const target=new URL(url,window.location.href);if(response.status===401&&target.origin===window.location.origin&&!target.pathname.startsWith("/api/auth/")&&window.location.pathname!=="/login")window.location.replace("/login?next="+encodeURIComponent(window.location.pathname+window.location.search));return response;};
  window.fetch=wrapped;
  const sync=async()=>{try{const r=await original("/api/auth/session",{cache:"no-store"}),data=await r.json();if(!alive||!r.ok)return;setUser(data.user);if(!data.user&&window.location.pathname!=="/login")window.location.replace("/login?next="+encodeURIComponent(window.location.pathname+window.location.search));}catch{}};
  void sync();const timer=setInterval(()=>{if(document.visibilityState==="visible")void sync();},60000);window.addEventListener("focus",sync);
  return()=>{alive=false;clearInterval(timer);window.removeEventListener("focus",sync);if(window.fetch===wrapped)window.fetch=original;};
 },[]);
 return <SessionContext.Provider value={user}>{children}</SessionContext.Provider>;
}
export function AccountMenu(){const user=useSession();const [busy,setBusy]=useState(false),[error,setError]=useState("");if(!user)return null;
 async function logout(){setBusy(true);setError("");try{const r=await fetch("/api/auth/logout",{method:"POST"});if(!r.ok)throw Error("Не удалось выйти. Повторите попытку");window.location.assign("/login");}catch(e){setError(e instanceof Error?e.message:"Ошибка выхода");setBusy(false);}}
 return <div className="account-menu"><div className="account-identity" title={user.login}><UserRound size={18}/><span><strong>{user.displayName}</strong><small>{user.login}</small></span></div><a href="/accounts" className="account-action" title="Аккаунты и пароль"><UsersRound size={17}/><span>Аккаунты</span></a><button type="button" className="account-action" onClick={logout} disabled={busy} title="Выйти"><LogOut size={17}/><span>Выйти</span></button>{error&&<small role="alert">{error}</small>}</div>;
}
