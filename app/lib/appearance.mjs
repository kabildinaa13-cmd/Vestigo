export const THEME_KEY = "vestigo.theme";
export const SIDEBAR_KEY = "vestigo.sidebar.collapsed";
// Read appearance before first paint. No document or case data is stored here.
export const appearanceBootstrap = `(()=>{const r=document.documentElement;let t,c;try{t=localStorage.getItem("${THEME_KEY}");c=localStorage.getItem("${SIDEBAR_KEY}")}catch{}r.dataset.theme=t==="light"||t==="dark"?t:matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";r.dataset.sidebar=(c==="true"||(c!=="false"&&matchMedia("(max-width: 760px)").matches))?"collapsed":"expanded"})()`;
