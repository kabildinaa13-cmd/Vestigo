import {withAuthenticatedApi} from "@/app/lib/auth-request.mjs";
export const GET=withAuthenticatedApi(GETHandler);
export const POST=withAuthenticatedApi(POSTHandler);
import { NextRequest, NextResponse } from "next/server";
import { openDatabase } from "@/app/lib/vestigo-db.mjs";
import { caseAnalysis, getExtraction, reviewCaseItem, rebuildCaseAnalysis } from "@/app/lib/case-analysis.mjs";
export const dynamic="force-dynamic";
async function GETHandler(request:NextRequest){
  const db=openDatabase();
  try{
    const params=request.nextUrl.searchParams,caseId=params.get("caseId")||"",documentId=params.get("documentId");
    const query={q:params.get("q")||"",type:params.get("type")||"",mode:params.get("mode")||"",tableId:params.get("tableId")||"",offset:Number(params.get("offset")||0),sourceRow:Number(params.get("sourceRow")||0),sourceSheet:params.get("sourceSheet")||""};
    return NextResponse.json(documentId?getExtraction(db,caseId,documentId,query):caseAnalysis(db,caseId,query),{headers:{"cache-control":"no-store"}});
  }catch(error){return NextResponse.json({error:error instanceof Error?error.message:"Не удалось загрузить анализ дела"},{status:404});}
  finally{db.close();}
}
async function POSTHandler(request:NextRequest){
  const origin=request.headers.get("origin"),port=process.env.VESTIGO_SITE_PORT||"3200";
  if(origin&&![`http://localhost:${port}`,`http://127.0.0.1:${port}`,`http://[::1]:${port}`].includes(origin))return NextResponse.json({error:"Недопустимый источник запроса"},{status:403});
  const db=openDatabase();
  try{const body=await request.json();if(body.action==="rebuild")rebuildCaseAnalysis(db,String(body.caseId||""));else reviewCaseItem(db,String(body.caseId||""),body);return NextResponse.json({ok:true});}
  catch(error){return NextResponse.json({error:error instanceof Error?error.message:"Не удалось сохранить проверку"},{status:422});}
  finally{db.close();}
}
