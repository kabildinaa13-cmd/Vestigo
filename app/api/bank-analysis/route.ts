import {withAuthenticatedApi} from "@/app/lib/auth-request.mjs";
export const GET=withAuthenticatedApi(GETHandler);
import {NextRequest,NextResponse} from "next/server";
import {openDatabase} from "@/app/lib/vestigo-db.mjs";
import {bankAnalysis} from "@/app/lib/bank-analysis.mjs";
export const dynamic="force-dynamic";
async function GETHandler(request:NextRequest){
  const db=openDatabase();
  try{const p=request.nextUrl.searchParams;return NextResponse.json(bankAnalysis(db,p.get("caseId")||"",Object.fromEntries(["owner","currency","from","to","q","offset"].map(k=>[k,p.get(k)||""]))),{headers:{"cache-control":"no-store"}});}
  catch(error){return NextResponse.json({error:error instanceof Error?error.message:"Не удалось прочитать банковский анализ"},{status:404});}
  finally{db.close();}
}
