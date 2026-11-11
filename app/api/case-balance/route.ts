import {NextRequest,NextResponse} from 'next/server';
import {withAuthenticatedApi} from '@/app/lib/auth-request.mjs';
import {openDatabase} from '@/app/lib/vestigo-db.mjs';
import {caseBalance} from '@/app/lib/case-balance.mjs';
export const dynamic='force-dynamic';
export const GET=withAuthenticatedApi(async(request:NextRequest)=>{const db=openDatabase();try{const q=Object.fromEntries(request.nextUrl.searchParams);return NextResponse.json(caseBalance(db,q.caseId||'',q),{headers:{'cache-control':'no-store'}});}catch(e){return NextResponse.json({error:e instanceof Error?e.message:'Ошибка сводного баланса'},{status:e&&typeof e==='object'&&'status' in e?Number(e.status):422});}finally{db.close();}});
