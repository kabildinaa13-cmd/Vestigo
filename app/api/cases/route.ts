import {withAuthenticatedApi} from "@/app/lib/auth-request.mjs";
import {readAuthBody} from "@/app/lib/auth-request.mjs";
import {trashCase,restoreCase,listDeletedCases} from "@/app/lib/case-trash.mjs";
export const GET=withAuthenticatedApi(GETHandler);
export const POST=withAuthenticatedApi(POSTHandler);
export const PATCH=withAuthenticatedApi(PATCHHandler);
export const DELETE=withAuthenticatedApi(DELETEHandler);
import { NextRequest, NextResponse } from "next/server";
import { changeCaseStatus, createCase, listCases, openDatabase, updateCase } from "@/app/lib/vestigo-db.mjs";

import {localWriteAllowed} from "@/app/lib/local-request.mjs";

export const dynamic = "force-dynamic";

async function GETHandler(request: NextRequest) {
  const db = openDatabase();
  try {
    if(request.nextUrl.searchParams.get("trash")==="1")return NextResponse.json({cases:listDeletedCases(db)});
    return NextResponse.json({ cases: listCases(db, {
      query: request.nextUrl.searchParams.get("query") ?? "",
      status: request.nextUrl.searchParams.get("status") ?? "",
    }) });
  } finally { db.close(); }
}

async function POSTHandler(request: NextRequest) {
  if(!localWriteAllowed(request))return NextResponse.json({error:"Недопустимый источник запроса"},{status:403});
  const db = openDatabase();
  try {
    const item = createCase(db, await request.json());
    return NextResponse.json({ case: item }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Не удалось создать дело";
    return NextResponse.json({ error: message }, { status: message.includes("UNIQUE") ? 409 : 400 });
  } finally { db.close(); }
}

async function PATCHHandler(request: NextRequest) {
  if(!localWriteAllowed(request))return NextResponse.json({error:"Недопустимый источник запроса"},{status:403});
  const db = openDatabase();
  try {
    const body = await readAuthBody(request);
    if(body.action==="restore")return NextResponse.json({case:restoreCase(db,String(body.id||""))});
    if(body.action==="update"||["caseNumber","erdrNumber","unitName","description","periodFrom","periodTo"].some(name=>Object.hasOwn(body,name)))return NextResponse.json({case:updateCase(db,body)});
    if(body.action)throw new Error("Неизвестное действие с делом");
    const item = changeCaseStatus(db, String(body.id ?? ""), String(body.status ?? ""));
    return NextResponse.json({ case: item });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Не удалось изменить дело" }, { status: Number((error as {status?:number}).status)||400 });
  } finally { db.close(); }
}

async function DELETEHandler(request:NextRequest){
  let db:ReturnType<typeof openDatabase>|undefined;
  try{const body=await readAuthBody(request);db=openDatabase();return NextResponse.json({deleted:trashCase(db,body)});}
  catch(error){return NextResponse.json({error:error instanceof Error?error.message:"Не удалось удалить дело"},{status:Number((error as {status?:number}).status)||400});}
  finally{db?.close();}
}
