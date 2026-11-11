import {withAuthenticatedApi} from "@/app/lib/auth-request.mjs";
export const GET=withAuthenticatedApi(GETHandler);
export const POST=withAuthenticatedApi(POSTHandler);
import {NextRequest,NextResponse} from "next/server";
import {openDatabase} from "@/app/lib/vestigo-db.mjs";
import {enqueueProcessing,listProcessing,retryProcessing} from "@/app/lib/processing-queue.mjs";
export const dynamic="force-dynamic";
async function GETHandler(request:NextRequest){const db=openDatabase();try{const p=request.nextUrl.searchParams;return NextResponse.json(listProcessing(db,p.get("caseId")||"",{offset:Number(p.get("offset"))||0,limit:Number(p.get("limit"))||50,id:p.get("id")||"",ids:p.get("ids")?.split(",").filter(Boolean)||[],activeOnly:p.get("activeOnly")==="true"}),{headers:{"cache-control":"no-store"}});}catch(error){return NextResponse.json({error:error instanceof Error?error.message:"Ошибка очереди"},{status:404});}finally{db.close();}}
async function POSTHandler(request:NextRequest){
  const origin=request.headers.get("origin"),port=process.env.VESTIGO_SITE_PORT||"3200";
  if(origin&&![`http://localhost:${port}`,`http://127.0.0.1:${port}`,`http://[::1]:${port}`].includes(origin))return NextResponse.json({error:"Недопустимый источник запроса"},{status:403});
  const reader=request.body?.getReader();let size=0;const parts:Uint8Array[]=[];
  try{if(!reader)throw new Error("Пустой запрос");while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>131072){await reader.cancel();return NextResponse.json({error:"Параметры слишком велики"},{status:413});}parts.push(chunk.value);}}catch{return NextResponse.json({error:"Не удалось прочитать запрос"},{status:400});}finally{reader?.releaseLock();}
  const db=openDatabase();try{const b=JSON.parse(Buffer.concat(parts).toString("utf8")),caseId=String(b.caseId||"");const result=b.action==="retry"?retryProcessing(db,caseId,String(b.id||"")):enqueueProcessing(db,{caseId,documentId:String(b.documentId||""),options:b.options||{},force:b.force===true});return NextResponse.json(result,{status:result.job?.state==="completed"?200:202});}
  catch(error){return NextResponse.json({error:error instanceof Error?error.message:"Ошибка очереди"},{status:422});}finally{db.close();}
}
