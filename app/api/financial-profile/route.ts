import {NextRequest,NextResponse} from 'next/server';
import {withAuthenticatedApi,readAuthBody} from '@/app/lib/auth-request.mjs';
import {openDatabase} from '@/app/lib/vestigo-db.mjs';
import {financialReport,saveFinancialDecision} from '@/app/lib/financial-profile.mjs';
import {buildFinancialGraph} from '@/app/lib/financial-graph.mjs';
export const dynamic='force-dynamic';
function failure(e:unknown){return NextResponse.json({error:e instanceof Error?e.message:'Ошибка финансового анализа'},{status:e&&typeof e==='object'&&'status' in e?Number(e.status):422});}
export const GET=withAuthenticatedApi(async(request:NextRequest)=>{const db=openDatabase();try{const q=Object.fromEntries(request.nextUrl.searchParams),report=financialReport(db,q.caseId||'',q.view==='graph'?{...q,identifier:'',operation:''}:q);return NextResponse.json(q.view==='graph'?buildFinancialGraph(report,q):report,{headers:{'cache-control':'no-store'}});}catch(e){return failure(e);}finally{db.close();}});
export const POST=withAuthenticatedApi(async(request:NextRequest)=>{let db;try{const b=await readAuthBody(request);db=openDatabase();return NextResponse.json(saveFinancialDecision(db,String(b.caseId||''),b));}catch(e){return failure(e);}finally{db?.close();}});
