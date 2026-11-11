import {NextRequest,NextResponse} from 'next/server';
import {withAuthenticatedApi,readAuthBody} from '@/app/lib/auth-request.mjs';
import {openDatabase} from '@/app/lib/vestigo-db.mjs';
import {goodsAnalysis,goodsGraph,saveGoodsGrouping} from '@/app/lib/goods-analysis.mjs';
import {goodsExport} from '@/app/lib/goods-export.mjs';
import {exportFinancialReport} from '@/app/lib/financial-export.mjs';
export const dynamic='force-dynamic';
function failure(e:unknown){return NextResponse.json({error:e instanceof Error?e.message:'Ошибка анализа товаров и услуг'},{status:e&&typeof e==='object'&&'status' in e?Number(e.status):422});}
export const GET=withAuthenticatedApi(async(request:NextRequest)=>{let db;try{
    const q=Object.fromEntries(request.nextUrl.searchParams);db=openDatabase();
    const result=goodsAnalysis(db,q.caseId||'',q);db.close();db=undefined;
    if(q.format){const report=goodsExport(result,q.report||'category',request.nextUrl.origin),bytes=await exportFinancialReport(report,q.format,request.signal);const types:Record<string,string>={xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',pdf:'application/pdf'};return new Response(new Uint8Array(bytes as Buffer),{headers:{'content-type':types[q.format],'content-disposition':`attachment; filename="vestigo-goods-report.${q.format}"`,'cache-control':'no-store','x-content-type-options':'nosniff'}});}
    if(q.view==='graph')return NextResponse.json(goodsGraph(result,q),{headers:{'cache-control':'no-store'}});
    const {_report,...publicResult}=result;return NextResponse.json(publicResult,{headers:{'cache-control':'no-store'}});
}catch(e){return failure(e);}finally{db?.close();}});
export const POST=withAuthenticatedApi(async(request:NextRequest)=>{let db;try{const b=await readAuthBody(request);db=openDatabase();return NextResponse.json(saveGoodsGrouping(db,String(b.caseId||''),b));}catch(e){return failure(e);}finally{db?.close();}});
