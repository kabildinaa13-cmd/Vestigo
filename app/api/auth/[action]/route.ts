import {NextRequest} from "next/server";
import {openDatabase} from "@/app/lib/vestigo-db.mjs";
import {accountsExist,setupCode,createFirstAccount,loginAccount,logoutAccount,listAccounts,createAccount,changePassword,sessionCookie,cookieToken} from "@/app/lib/accounts.mjs";
import {requestUser,readAuthBody,authWriteAllowed,authError} from "@/app/lib/auth-request.mjs";
export const dynamic="force-dynamic";
type Context={params:Promise<{action:string}>};
function reply(body:unknown,status=200,token?:string,clear=false){const headers:Record<string,string>={"cache-control":"no-store","vary":"Cookie"};if(token!==undefined||clear)headers["set-cookie"]=sessionCookie(token||"",{clear,secure:process.env.VESTIGO_HTTPS==="1"});return Response.json(body,{status,headers});}
export async function GET(request:NextRequest,{params}:Context){const {action}=await params;if(!["session","accounts"].includes(action))return reply({error:"Не найдено"},404);const db=openDatabase();try{const user=requestUser(request);if(action==="session"){const setupRequired=!accountsExist(db);if(setupRequired)setupCode(db);return reply({user,setupRequired,setupCodeFile:setupRequired?"data/first-account-code.txt":undefined});}if(!user)return reply({error:"Войдите по логину и паролю"},401);return reply({accounts:listAccounts(db)});}catch(error){return authError(error);}finally{db.close();}}
export async function POST(request:NextRequest,{params}:Context){
 if(!authWriteAllowed(request))return reply({error:"Недопустимый источник запроса"},403);
 const {action}=await params;if(!["setup","login","logout","accounts","password"].includes(action))return reply({error:"Не найдено"},404);
 const db=openDatabase();try{
  if(action==="logout"){logoutAccount(db,cookieToken(request.headers.get("cookie")));return reply({ok:true},200,undefined,true);}
  const user=["accounts","password"].includes(action)?requestUser(request):null;if(["accounts","password"].includes(action)&&!user)return reply({error:"Войдите по логину и паролю"},401);
  const body=await readAuthBody(request);
  if(action==="accounts"){const account=await createAccount(db,user,body);return reply({account},201);}
  const result=action==="setup"?await createFirstAccount(db,body):action==="login"?await loginAccount(db,body):await changePassword(db,user,body);
  return reply({user:result.user},action==="setup"?201:200,result.token);
 }catch(error){return authError(error);}finally{db.close();}
}
