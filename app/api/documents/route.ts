import {withAuthenticatedApi} from "@/app/lib/auth-request.mjs";
export const GET=withAuthenticatedApi(GETHandler);
export const POST=withAuthenticatedApi(POSTHandler);
import { NextRequest, NextResponse } from "next/server";
import { openDatabase } from "@/app/lib/vestigo-db.mjs";
import { listDocuments, saveDocument } from "@/app/lib/documents.mjs";
import { MAX_DOCUMENT_BYTES } from "@/app/lib/document-types.mjs";
import {enqueueProcessing,migrateProcessingQueue} from "@/app/lib/processing-queue.mjs";
import {decodeUploadMetadata,UPLOAD_METADATA_HEADER} from "@/app/lib/upload-protocol.mjs";
import {saveDocumentArchive,attachArchiveMembership} from "@/app/lib/document-archives.mjs";

export const dynamic = "force-dynamic";

async function GETHandler(request: NextRequest) {
  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    db=openDatabase();
    const caseId=request.nextUrl.searchParams.get("caseId")||"";
    return NextResponse.json({ documents: attachArchiveMembership(db,caseId,listDocuments(db,caseId)) },
      { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Не удалось получить документы" }, { status: 404 });
  } finally { db?.close(); }
}

async function POSTHandler(request: NextRequest) {
  const origin = request.headers.get("origin");
  const port = process.env.VESTIGO_SITE_PORT || "3200";
  if (origin && ![`http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`].includes(origin)) {
    return NextResponse.json({ error: "Недопустимый источник запроса" }, { status: 403 });
  }
  const binary=request.headers.get("content-type")?.split(";")[0].trim()==="application/octet-stream";
  const limit = MAX_DOCUMENT_BYTES + (binary?0:1024*1024);
  if (Number(request.headers.get("content-length")) > limit) return NextResponse.json({ error: "Размер файла превышает 50 МБ" }, { status: 413 });
  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    const metadata=binary?decodeUploadMetadata(request.headers.get(UPLOAD_METADATA_HEADER)):null;
    const reader = request.body?.getReader();
    if (!reader) throw new Error("Выберите файл");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > limit) { await reader.cancel(); return NextResponse.json({ error: "Размер файла превышает 50 МБ" }, { status: 413 }); }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    const body=Buffer.concat(chunks);
    let values:Record<string,string>,name:string,bytes:Buffer;
    if(binary){values=metadata;name=values.name;bytes=body;}
    else{
      const form=await new Response(body,{headers:{"content-type":request.headers.get("content-type")||""}}).formData();
      const file=form.get("file");if(!file||typeof file==="string")throw new Error("Выберите файл");
      values=Object.fromEntries([...form.entries()].filter((entry):entry is [string,string]=>typeof entry[1]==="string"));
      name=file.name;bytes=Buffer.from(await file.arrayBuffer());
    }
    if(bytes.length>MAX_DOCUMENT_BYTES)return NextResponse.json({error:"Размер файла превышает 50 МБ"},{status:413});
    db = openDatabase();
    migrateProcessingQueue(db);
    const processingOptions=Object.fromEntries(["ownerId","ownerAccount","bankFeeMode","defaultCurrency","bankYear"].filter(k=>values[k]).map(k=>[k,values[k]]));
    const input={...values,name,bytes,
      afterSave:values.processInBackground==="true"?(database:ReturnType<typeof openDatabase>,id:string,caseId:string)=>enqueueProcessing(database,{caseId,documentId:id,options:processingOptions,force:true},{},false):undefined};
    const result=name.trim().toLowerCase().endsWith(".zip")?await saveDocumentArchive(db,input):saveDocument(db,input);
    return NextResponse.json(result, { status: result.duplicate ? 200 : 201 });
  } catch (error) {
    const message=error instanceof Error?error.message:"Не удалось сохранить документ";
    return NextResponse.json({ error: /database is (locked|busy)/i.test(message)?"База данных занята. Повторите загрузку через несколько секунд — дубли не создадутся.":message }, { status: /database is (locked|busy)/i.test(message)?503:400 });
  } finally { db?.close(); }
}
