import {withAuthenticatedApi,readAuthBody} from '@/app/lib/auth-request.mjs';
import {openDatabase} from '@/app/lib/vestigo-db.mjs';
import {workflowWorkspace,saveWorkflow} from '@/app/lib/case-workflow.mjs';
import {workCostSources} from '@/app/lib/work-cost-sources.mjs';
export const dynamic='force-dynamic';
const failure=(e:any)=>Response.json({error:e instanceof Error?e.message:'Ошибка реестра дела'},{status:e.status||422});
export const GET=withAuthenticatedApi(async(request:Request)=>{const db=openDatabase();try{const q=new URL(request.url).searchParams,id=q.get('caseId')||'';return Response.json(q.get('view')==='work-comparison'?{sources:workCostSources(db,id)}:workflowWorkspace(db,id));}catch(e){return failure(e);}finally{db.close();}});
export const POST=withAuthenticatedApi(async(request:Request)=>{let db;try{const body=await readAuthBody(request);db=openDatabase();return Response.json(saveWorkflow(db,String(body.caseId||''),body),{status:201});}catch(e){return failure(e);}finally{db?.close();}});
