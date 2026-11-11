import {withAuthenticatedApi} from "@/app/lib/auth-request.mjs";
import {systemLog,ReviewHistoryError} from "@/app/lib/review-history.mjs";
export const dynamic="force-dynamic";
export const GET=withAuthenticatedApi(async()=>{
  try{return Response.json(systemLog());}
  catch(error){return Response.json({error:error instanceof Error?error.message:"Доступ запрещён"},{status:error instanceof ReviewHistoryError?error.status:403});}
});
