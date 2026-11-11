import {withAuthenticatedApi} from "@/app/lib/auth-request.mjs";
export const DELETE=withAuthenticatedApi(DELETEHandler);
export const GET=withAuthenticatedApi(GETHandler);
import { NextRequest, NextResponse } from "next/server";
import { openDatabase } from "@/app/lib/vestigo-db.mjs";
import { documentOriginal } from "@/app/lib/documents.mjs";
import {reviewCaseItem} from "@/app/lib/case-analysis.mjs";
import {localWriteAllowed} from "@/app/lib/local-request.mjs";
import {readAuthBody} from "@/app/lib/auth-request.mjs";
import {deleteCaseDocument} from "@/app/lib/document-removal.mjs";

export const dynamic = "force-dynamic";

// Legacy calls still exclude reversibly; explicit permanent mode purges this case.
// An original shared with another case is never removed from that other case.
async function DELETEHandler(request:NextRequest,{params}:{params:Promise<{id:string}>}){
  if(!localWriteAllowed(request))return NextResponse.json({error:"Недопустимый источник запроса"},{status:403});
  if(Number(request.headers.get("content-length"))>16384)return NextResponse.json({error:"Слишком большой запрос"},{status:413});
  const db=openDatabase();
  try{const {id}=await params,body=await readAuthBody(request),caseId=String(body.caseId||"");if(body.mode==='permanent')return NextResponse.json(deleteCaseDocument(db,caseId,id,body));if(body.mode!==undefined)throw new Error('Неизвестный способ удаления');reviewCaseItem(db,caseId,{kind:"document",id,status:"excluded",note:String(body.note||"")});return NextResponse.json({caseId,id,excluded:true,originalPreserved:true});}
  catch(error){return NextResponse.json({error:error instanceof Error?error.message:"Не удалось удалить документ"},{status:typeof (error as {status?:number})?.status==='number'?(error as {status:number}).status:422});}
  finally{db.close();}
}

async function GETHandler(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const db = openDatabase();
  try {
    const { id } = await params;
    const result = documentOriginal(db, id, request.nextUrl.searchParams.get("caseId") || "");
    const disposition = request.nextUrl.searchParams.get("inline") === "1" && result.mediaType === "application/pdf" ? "inline" : "attachment";
    return new Response(new Uint8Array(result.bytes), { headers: {
      "content-type": result.mediaType,
      "content-disposition": `${disposition}; filename="document"; filename*=UTF-8''${encodeURIComponent(result.name)}`,
      "content-length": String(result.bytes.length),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'",
      "x-document-sha256": result.sha256,
    } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Документ недоступен" }, { status: 404 });
  } finally { db.close(); }
}
