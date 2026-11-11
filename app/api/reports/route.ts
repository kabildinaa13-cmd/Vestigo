import {withAuthenticatedApi} from "@/app/lib/auth-request.mjs";
export const GET=withAuthenticatedApi(GETHandler);
export const POST=withAuthenticatedApi(POSTHandler);
import {NextRequest,NextResponse} from "next/server";
import {openDatabase} from "@/app/lib/vestigo-db.mjs";
import {createCaseReport,listCaseReports,getCaseReport} from "@/app/lib/case-calculations.mjs";
import {spawn} from "node:child_process";
import fs from "node:fs";
import path from "node:path";
export const dynamic="force-dynamic";
async function GETHandler(request:NextRequest){const db=openDatabase();try{const p=request.nextUrl.searchParams,caseId=p.get("caseId")||"",id=p.get("id"),report=id?getCaseReport(db,caseId,id):null;
 if(report&&p.get("format")==="xlsx"){
  const input=JSON.stringify(report);if(Buffer.byteLength(input)>16*1024*1024)throw new Error("Сводка превышает 16 МБ. Сузьте набор материалов для Excel; JSON-снимок сохранён.");
  const local=path.join(process.cwd(),".venv",process.platform==="win32"?"Scripts/python.exe":"bin/python"),python=process.env.VESTIGO_PYTHON||(fs.existsSync(local)?local:"python");
  const bytes=await new Promise<Buffer>((resolve,reject)=>{const child=spawn(python,[path.join(process.cwd(),"scripts/export_case_report.py")],{windowsHide:true,stdio:["pipe","pipe","pipe"],env:{...process.env,PYTHONIOENCODING:"utf-8"}}),parts:Buffer[]=[];let size=0,stopped=false;const timer=setTimeout(()=>{stopped=true;child.kill();reject(new Error("Превышено время создания Excel-сводки"));},60000);child.stdout.on("data",chunk=>{size+=chunk.length;if(size>32*1024*1024){stopped=true;child.kill();clearTimeout(timer);reject(new Error("Excel-сводка превышает 32 МБ"));}else parts.push(chunk);});child.stderr.resume();child.stdin.on("error",()=>{});child.on("error",()=>{clearTimeout(timer);reject(new Error("Не удалось запустить локальный обработчик Excel"));});child.on("close",code=>{clearTimeout(timer);if(!stopped){if(code===0)resolve(Buffer.concat(parts));else reject(new Error("Не удалось сформировать Excel-сводку. Проверьте Python и openpyxl."));}});child.stdin.end(input);});
  return new Response(new Uint8Array(bytes),{headers:{"content-type":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","content-disposition":'attachment; filename="vestigo-report.xlsx"',"cache-control":"no-store"}});
 }
 return NextResponse.json(report||{reports:listCaseReports(db,caseId)},{headers:{"cache-control":"no-store",...(id?{"content-disposition":'attachment; filename="vestigo-report.json"'}:{})}});
 }catch(error){return NextResponse.json({error:error instanceof Error?error.message:"Ошибка отчёта"},{status:404});}finally{db.close();}}
async function POSTHandler(request:NextRequest){const origin=request.headers.get("origin"),port=process.env.VESTIGO_SITE_PORT||"3200";if(origin&&![`http://localhost:${port}`,`http://127.0.0.1:${port}`,`http://[::1]:${port}`].includes(origin))return NextResponse.json({error:"Недопустимый источник запроса"},{status:403});const db=openDatabase();try{const body=await request.json();return NextResponse.json(createCaseReport(db,String(body.caseId||"")),{status:201});}catch(error){return NextResponse.json({error:error instanceof Error?error.message:"Ошибка создания отчёта"},{status:422});}finally{db.close();}}
