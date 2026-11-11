import fs from "node:fs";
import path from "node:path";
import {crc32} from "node:zlib";
import yauzl from "yauzl";
import {saveDocument, validateDocument, migrateDocuments} from "./documents.mjs";
import {MAX_DOCUMENT_BYTES} from "./document-types.mjs";

export const MAX_ARCHIVE_FILES=500;
export const MAX_ARCHIVE_BYTES=250*1024*1024;

// No paths from an archive are written to disk: originals use opaque storage names.
export async function readDocumentArchive(bytes){
  validateDocument("documents.zip",bytes);
  const files=[],skipped=[],paths=new Set();let total=0,expanded=0,entries=0;
  async function visit(content,ancestry=[],depth=0){
    if(depth>3)throw new Error("В ZIP допускается не более трёх уровней вложенных ZIP");
    let zip;
    try{
      zip=await yauzl.fromBufferPromise(content,{validateEntrySizes:true,strictFileNames:true});
      for await(const entry of zip.eachEntry()){
        if(++entries>1000)throw new Error("Слишком много записей в ZIP (максимум 1000 на весь пакет)");
        const name=entry.fileName,source=[...ancestry,name].join("!/");
        if(name.length>1024||source.length>4096||name.includes("\\\\")||name.includes("\\0")||/^[\\/]|^[A-Za-z]:/.test(name)||name.split("/").some(p=>p===".."||p==="."))throw new Error("Недопустимый путь внутри ZIP");
        if((entry.generalPurposeBitFlag&1)!==0)throw new Error("ZIP с паролем не поддерживается — распакуйте его перед загрузкой");
        if(((entry.externalFileAttributes>>>16)&0o170000)===0o120000)throw new Error("Символические ссылки внутри ZIP запрещены");
        if(name.endsWith("/"))continue;
        if(name.startsWith("__MACOSX/")||[".DS_Store","Thumbs.db"].includes(path.posix.basename(name))){skipped.push(source);continue;}
        const key=JSON.stringify([...ancestry,name].map(x=>x.normalize("NFKC").toLocaleLowerCase("ru")));
        if(paths.has(key))throw new Error("В ZIP повторяется путь файла: "+source);paths.add(key);
        const ext=path.posix.extname(name).toLowerCase();
        if([".rar",".7z"].includes(ext))throw new Error("Вложенный RAR/7z нужно распаковать локально перед загрузкой: "+source);
        if(entry.uncompressedSize>MAX_DOCUMENT_BYTES)throw new Error("Вложенный файл превышает 50 МБ: "+source);
        if(expanded+entry.uncompressedSize>MAX_ARCHIVE_BYTES)throw new Error("Размер распакованных документов и контейнеров превышает 250 МБ");
        const stream=await zip.openReadStreamPromise(entry),chunks=[];let size=0,checksum=0;
        for await(const chunk of stream){
          size+=chunk.length;expanded+=chunk.length;
          if(size>MAX_DOCUMENT_BYTES||expanded>MAX_ARCHIVE_BYTES){stream.destroy();throw new Error("Превышен допустимый размер распакованного ZIP");}
          checksum=crc32(chunk,checksum);chunks.push(chunk);
        }
        if(size!==entry.uncompressedSize||(checksum>>>0)!==(entry.crc32>>>0))throw new Error("Повреждён файл внутри ZIP: "+source);
        const data=Buffer.concat(chunks);
        if(ext===".zip"){validateDocument("nested.zip",data);await visit(data,[...ancestry,name],depth+1);continue;}
        if(files.length>=MAX_ARCHIVE_FILES)throw new Error("В ZIP допускается не более 500 документов на весь пакет");
        const validated=validateDocument(name,data);
        files.push({path:source,name:validated.name,bytes:data});total+=size;
      }
    }finally{zip?.close();}
  }
  try{await visit(bytes);if(!files.length)throw new Error("В ZIP нет поддерживаемых документов");return {files,skipped,totalBytes:total};}
  catch(error){throw new Error("ZIP не загружен: "+String(error?.message||error));}
}

export function migrateDocumentArchives(db){
  db.exec(`CREATE TABLE IF NOT EXISTS document_archive_members (
    case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    archive_document_id TEXT NOT NULL REFERENCES documents(id),
    document_id TEXT NOT NULL REFERENCES documents(id),entry_path TEXT NOT NULL,
    PRIMARY KEY(case_id,archive_document_id,entry_path)
  ); CREATE INDEX IF NOT EXISTS archive_member_document ON document_archive_members(case_id,document_id)`);
}

export async function saveDocumentArchive(db,input,context={}){
  const contents=await readDocumentArchive(input.bytes);
  migrateDocuments(db);migrateDocumentArchives(db);
  const written=[];
  const transaction={external:true,onWrite:file=>written.push(file)};
  db.exec("BEGIN IMMEDIATE");
  try{
    const archive=saveDocument(db,{...input,groupId:"unclassified",typeId:"archive",classificationMode:"manual",afterSave:undefined},context,transaction);
    const documents=[];
    for(const file of contents.files){
      const saved=saveDocument(db,{...input,name:file.name,bytes:file.bytes},context,transaction);
      db.prepare("INSERT OR IGNORE INTO document_archive_members VALUES(?,?,?,?)").run(String(input.caseId),archive.id,saved.id,file.path);
      documents.push({...saved,path:file.path});
    }
    db.exec("COMMIT");
    return {...archive,archive:{documents,skipped:contents.skipped,totalBytes:contents.totalBytes}};
  }catch(error){
    db.exec("ROLLBACK");
    // These explicit opaque paths were created by this transaction, never pre-existing originals.
    for(const file of written)if(fs.existsSync(file))fs.unlinkSync(file);
    throw error;
  }
}

export function attachArchiveMembership(db,caseId,documents){
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='document_archive_members'").get())return documents;
  const members=db.prepare(`SELECT m.*,a.original_name archive_name,d.original_name document_name FROM document_archive_members m
    JOIN documents a ON a.id=m.archive_document_id JOIN documents d ON d.id=m.document_id
    JOIN case_documents ac ON ac.case_id=m.case_id AND ac.document_id=a.id
    JOIN case_documents dc ON dc.case_id=m.case_id AND dc.document_id=d.id WHERE m.case_id=? ORDER BY m.entry_path`).all(caseId);
  const byArchive=new Map(),byDocument=new Map();
  for(const member of members){
    if(!byArchive.has(member.archive_document_id))byArchive.set(member.archive_document_id,[]);
    byArchive.get(member.archive_document_id).push({id:member.document_id,name:member.document_name,path:member.entry_path});
    if(!byDocument.has(member.document_id))byDocument.set(member.document_id,[]);
    byDocument.get(member.document_id).push({id:member.archive_document_id,name:member.archive_name,path:member.entry_path});
  }
  return documents.map(document=>({...document,archiveMembers:byArchive.get(document.id)||[],originArchives:byDocument.get(document.id)||[]}));
}
