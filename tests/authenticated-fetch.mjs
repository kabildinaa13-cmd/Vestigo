// Existing end-to-end suites now sign in through the real setup API. There is
// no disabled-auth mode in the application or test server.
export const TEST_SETUP_TOKEN="synthetic-only-bootstrap-code-20261021";
const password="Synthetic test password 2026!",login="synthetic-tester";
export function createAuthenticatedFetch(){const cookies=new Map(),pending=new Map();return async function authenticatedFetch(input,options={}){
 const origin=new URL(String(input)).origin;
 async function establish(){let r=await globalThis.fetch(origin+"/api/auth/session"),status=await r.json();r=await globalThis.fetch(origin+`/api/auth/${status.setupRequired?"setup":"login"}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({login,password,displayName:"Synthetic tester",setupCode:TEST_SETUP_TOKEN})});if(!r.ok)throw Error("Synthetic authentication failed: "+await r.text());cookies.set(origin,r.headers.get("set-cookie").split(";")[0]);}
 if(!cookies.has(origin)){if(!pending.has(origin))pending.set(origin,establish().finally(()=>pending.delete(origin)));await pending.get(origin);}
 const headers=new Headers(options.headers);headers.set("cookie",cookies.get(origin));return globalThis.fetch(input,{...options,headers});
};}
