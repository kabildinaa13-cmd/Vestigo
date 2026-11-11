import {withAuthenticatedApi} from "@/app/lib/auth-request.mjs";
export const POST=withAuthenticatedApi(POSTHandler);
import {NextRequest,NextResponse} from "next/server";
import {openDatabase} from "@/app/lib/vestigo-db.mjs";
import {processCaseDocument} from "@/app/lib/document-processing.mjs";
import {previewBankDocument} from "@/app/lib/bank-reanalysis.mjs";
export const dynamic="force-dynamic";
async function POSTHandler(request:NextRequest,{params}:{params:Promise<{id:string}>}){
  const origin=request.headers.get("origin"),port=process.env.VESTIGO_SITE_PORT||"3200";
  if(origin&&![`http://localhost:${port}`,`http://127.0.0.1:${port}`,`http://[::1]:${port}`].includes(origin))return NextResponse.json({error:"Недопустимый источник запроса"},{status:403});
  if(Number(request.headers.get("content-length"))>131072)return NextResponse.json({error:"Параметры слишком велики"},{status:413});
  const db=openDatabase();try{const {id}=await params,body=await request.json();return NextResponse.json(body.preview===true?await previewBankDocument(db,String(body.caseId||""),id,body):await processCaseDocument(db,String(body.caseId||""),id,body));}
  catch(error){return NextResponse.json({error:error instanceof Error?error.message:"Ошибка обработки"},{status:422});}finally{db.close();}
}
