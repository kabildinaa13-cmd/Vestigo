import {withAuthenticatedApi} from "@/app/lib/auth-request.mjs";
export const GET=withAuthenticatedApi(GETHandler);
export const POST=withAuthenticatedApi(POSTHandler);
import {NextRequest,NextResponse} from "next/server";
import {openDatabase} from "@/app/lib/vestigo-db.mjs";
import {migrateCaseAnalysis} from "@/app/lib/case-analysis.mjs";
import {caseWorkspaceOverview,searchCaseText} from "@/app/lib/case-workspace.mjs";
import {refreshStoredCaseDocuments} from "@/app/lib/case-refresh.mjs";
export const dynamic="force-dynamic";
async function GETHandler(request:NextRequest){
  let db:ReturnType<typeof openDatabase>|undefined;
  try{db=openDatabase();migrateCaseAnalysis(db);const p=request.nextUrl.searchParams,caseId=p.get("caseId")||"",offset=Number(p.get("offset"))||0;
    return NextResponse.json(p.has("q")?searchCaseText(db,caseId,p.get("q")||"",{offset}):caseWorkspaceOverview(db,caseId,{offset}),{headers:{"cache-control":"no-store"}});
  }catch(error){return NextResponse.json({error:error instanceof Error?error.message:"Не удалось получить результаты"},{status:400});}finally{db?.close();}
}
async function POSTHandler(request:NextRequest){
  const origin=request.headers.get("origin"),port=process.env.VESTIGO_SITE_PORT||"3200";
  if(origin&&![`http://localhost:${port}`,`http://127.0.0.1:${port}`,`http://[::1]:${port}`].includes(origin))return NextResponse.json({error:"Недопустимый источник запроса"},{status:403});
  let db:ReturnType<typeof openDatabase>|undefined;
  try{const body=await request.json();if(body.action!=="refresh")throw new Error("Неизвестное действие");db=openDatabase();return NextResponse.json(refreshStoredCaseDocuments(db,String(body.caseId||"")));}
  catch(error){return NextResponse.json({error:error instanceof Error?error.message:"Не удалось обновить анализ"},{status:400});}finally{db?.close();}
}
