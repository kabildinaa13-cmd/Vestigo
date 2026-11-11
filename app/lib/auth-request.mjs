import {openDatabase} from "./vestigo-db.mjs";
import {findSession,cookieToken,AccountError} from "./accounts.mjs";
import {runAsUser} from "./request-identity.mjs";
export function requestUser(request){const db=openDatabase();try{return findSession(db,cookieToken(request.headers.get("cookie")));}finally{db.close();}}
export function authWriteAllowed(request){if(["GET","HEAD","OPTIONS"].includes(request.method))return true;if(request.headers.get("sec-fetch-site")==="cross-site")return false;const origin=request.headers.get("origin");return !origin||origin===new URL(request.url).origin;}
export function withAuthenticatedApi(handler){return async function(request,...args){
 if(!authWriteAllowed(request))return Response.json({error:"Недопустимый источник запроса"},{status:403,headers:{"cache-control":"no-store"}});
 const user=requestUser(request);if(!user)return Response.json({error:"Войдите по логину и паролю"},{status:401,headers:{"cache-control":"no-store"}});
 const result=await runAsUser(user,()=>handler(request,...args));result.headers.set("cache-control","no-store");result.headers.set("vary","Cookie");return result;
};}
export async function readAuthBody(request){if(!authWriteAllowed(request))throw new AccountError("Недопустимый источник запроса",403);if(request.headers.get("content-type")?.split(";")[0]!=="application/json")throw new AccountError("Ожидается JSON",415);
 const reader=request.body?.getReader();if(!reader)throw new AccountError("Пустой запрос");let size=0;const chunks=[];while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>12288){await reader.cancel();throw new AccountError("Слишком большой запрос",413);}chunks.push(Buffer.from(value));}try{const result=JSON.parse(Buffer.concat(chunks).toString("utf8"));if(!result||typeof result!=="object"||Array.isArray(result))throw Error();return result;}catch{throw new AccountError("Некорректный JSON");}}
export const authError=error=>Response.json({error:error instanceof AccountError?error.message:"Не удалось выполнить операцию с аккаунтом"},{status:error instanceof AccountError?error.status:500,headers:{"cache-control":"no-store"}});
