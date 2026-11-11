import {NextRequest,NextResponse} from "next/server";
import {withAuthenticatedApi,readAuthBody} from "@/app/lib/auth-request.mjs";
import {openDatabase} from "@/app/lib/vestigo-db.mjs";
import {analysisCenter,centerReview,exportCenterCsv} from "@/app/lib/analysis-center.mjs";
export const dynamic="force-dynamic";
export const GET=withAuthenticatedApi(async(request:NextRequest)=>{
  const db=openDatabase();try{const q=Object.fromEntries(request.nextUrl.searchParams),caseId=q.caseId||"";
    if(q.format){const card=analysisCenter(db,caseId,{...q,view:"document",export:"json"});const csv=q.format==="csv";if(!csv&&q.format!=="json")throw new Error("Доступны JSON и CSV");return new Response(csv?exportCenterCsv(card):JSON.stringify(card,null,2),{headers:{"content-type":csv?"text/csv; charset=utf-8":"application/json; charset=utf-8","content-disposition":`attachment; filename="document-analysis.${csv?'csv':'json'}"`,"x-content-type-options":"nosniff"}});}
    return NextResponse.json(analysisCenter(db,caseId,q));
  }catch(error){return NextResponse.json({error:error instanceof Error?error.message:"Ошибка центра анализа"},{status:error&&typeof error==="object"&&"status" in error?Number(error.status):404});}finally{db.close();}
});
export const POST=withAuthenticatedApi(async(request:NextRequest)=>{let db;try{const body=await readAuthBody(request);db=openDatabase();return NextResponse.json(centerReview(db,String(body.caseId||""),body));}catch(error){return NextResponse.json({error:error instanceof Error?error.message:"Не удалось сохранить решение"},{status:422});}finally{db?.close();}});
