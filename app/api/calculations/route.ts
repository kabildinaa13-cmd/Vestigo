import {withAuthenticatedApi} from "@/app/lib/auth-request.mjs";
export const GET=withAuthenticatedApi(GETHandler);
export const POST=withAuthenticatedApi(POSTHandler);
import {NextRequest,NextResponse} from "next/server";
import {openDatabase} from "@/app/lib/vestigo-db.mjs";
import {calculationWorkspace,createCalculation} from "@/app/lib/case-calculations.mjs";
export const dynamic="force-dynamic";
async function GETHandler(request:NextRequest){const db=openDatabase();try{const p=request.nextUrl.searchParams;return NextResponse.json(calculationWorkspace(db,p.get("caseId")||"",Object.fromEntries(["from","to","counterparty","episodeId"].map(k=>[k,p.get(k)||""]))),{headers:{"cache-control":"no-store"}});}catch(error){return NextResponse.json({error:error instanceof Error?error.message:"Ошибка расчётов"},{status:404});}finally{db.close();}}
async function POSTHandler(request:NextRequest){const origin=request.headers.get("origin"),port=process.env.VESTIGO_SITE_PORT||"3200";if(origin&&![`http://localhost:${port}`,`http://127.0.0.1:${port}`,`http://[::1]:${port}`].includes(origin))return NextResponse.json({error:"Недопустимый источник запроса"},{status:403});const db=openDatabase();try{const body=await request.json();return NextResponse.json(createCalculation(db,String(body.caseId||""),body),{status:201});}catch(error){return NextResponse.json({error:error instanceof Error?error.message:"Ошибка сохранения расчёта"},{status:422});}finally{db.close();}}
