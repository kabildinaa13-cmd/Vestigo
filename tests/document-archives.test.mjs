import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {zipSync,strToU8} from "fflate";
import {openDatabase,createCase,changeCaseStatus} from "../app/lib/vestigo-db.mjs";
import {saveDocument,listDocuments,documentOriginal} from "../app/lib/documents.mjs";
import {readDocumentArchive,saveDocumentArchive,attachArchiveMembership} from "../app/lib/document-archives.mjs";
import {enqueueProcessing,migrateProcessingQueue,listProcessing} from "../app/lib/processing-queue.mjs";
import {rebuildCaseAnalysis,caseAnalysis} from "../app/lib/case-analysis.mjs";
const zip=entries=>Buffer.from(zipSync(Object.fromEntries(Object.entries(entries).map(([name,text])=>[name,strToU8(text)])),{level:0}));
function setup(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),"vestigo-archive-test-")),db=openDatabase({dataDirectory:dir}),c=createCase(db,{caseNumber:"ZIP-TEST"});
  migrateProcessingQueue(db);return {db,dir,c,close(){db.close();fs.rmSync(dir,{recursive:true,force:true});}};}
const input=(s,bytes,extra={})=>({caseId:s.c.id,name:"Пакет.zip",bytes,groupId:"unclassified",typeId:"unclassified",classificationMode:"auto",afterSave:(db,id,caseId)=>enqueueProcessing(db,{caseId,documentId:id},{},false),...extra});

test("ZIP: сохраняются оригинал, документы, пути и задания; повторы не создаются",async()=>{const s=setup();try{
  const bytes=zip({"папка/Акт.txt":"Синтетический акт","ЭСФ.csv":"Сумма;Дата\n10;2026-10-20"});
  const saved=await saveDocumentArchive(s.db,input(s,bytes));
  assert.equal(saved.archive.documents.length,2);assert.equal(listProcessing(s.db,s.c.id).total,2);
  const listing=attachArchiveMembership(s.db,s.c.id,listDocuments(s.db,s.c.id));assert.equal(listing.length,3);
  assert.equal(listing.find(d=>d.id===saved.id).archiveMembers.length,2);
  assert.equal(listing.find(d=>d.name==="Акт.txt").originArchives[0].path,"папка/Акт.txt");
  assert.deepEqual(documentOriginal(s.db,saved.id,s.c.id).bytes,bytes);
  assert.throws(()=>enqueueProcessing(s.db,{caseId:s.c.id,documentId:saved.id}),/вложенные/);
  const repeated=await saveDocumentArchive(s.db,input(s,bytes,{name:"копия.zip"}));assert.equal(repeated.id,saved.id);
  assert.ok(repeated.archive.documents.every(d=>d.alreadyLinked));assert.equal(listProcessing(s.db,s.c.id).total,2);
  const direct=saveDocument(s.db,{...input(s,Buffer.from("Синтетический акт")),name:"другое.txt"});assert.equal(direct.id,saved.archive.documents.find(d=>d.name==="Акт.txt").id);
  assert.equal(listDocuments(s.db,s.c.id).length,3);assert.equal(fs.readdirSync(path.join(s.dir,"uploads")).length,3);
  rebuildCaseAnalysis(s.db,s.c.id);
  const analysis=caseAnalysis(s.db,s.c.id);assert.equal(analysis.documents.length,2);
  assert.ok(analysis.risks.every(r=>r.evidence.every(e=>e.documentId!==saved.id)));
}finally{s.close();}});

test("ZIP: повреждения, опасные пути, вложенные архивы и неподдерживаемые файлы отклоняются",async()=>{
  for(const entries of [{"../escape.txt":"x"},{"a.zip":"x"},{"payload.exe":"hello"},{"fake.pdf":"not pdf"},{"A.txt":"1","a.txt":"2"}])await assert.rejects(readDocumentArchive(zip(entries)));
  const damaged=zip({"file.txt":"test payload"});const marker=damaged.indexOf(Buffer.from("test payload"));assert.ok(marker>=0);damaged[marker]^=1;
  await assert.rejects(readDocumentArchive(damaged),/Повреждён/);
  for(const kind of ["encrypted","symlink","oversized"]){
    const unsafe=zip({"file.txt":"test"}),central=unsafe.indexOf(Buffer.from("504b0102","hex"));assert.ok(central>=0);
    if(kind==="encrypted"){unsafe.writeUInt16LE(unsafe.readUInt16LE(central+8)|1,central+8);unsafe.writeUInt16LE(unsafe.readUInt16LE(6)|1,6);}
    if(kind==="symlink")unsafe.writeUInt32LE((0o120777*65536)>>>0,central+38);
    if(kind==="oversized")unsafe.writeUInt32LE(51*1024*1024,central+24);
    await assert.rejects(readDocumentArchive(unsafe));
  }
  await assert.rejects(readDocumentArchive(zip({"Thumbs.db":"ignored"})),/нет поддерживаемых/);
  await assert.rejects(readDocumentArchive(zip(Object.fromEntries(Array.from({length:501},(_,i)=>[`${i}.txt`,"x"])))),/500/);
});

test("ZIP: сбой на втором документе откатывает весь пакет, но не трогает старые оригиналы",async()=>{const s=setup();try{
  const old=saveDocument(s.db,{...input(s,Buffer.from("old")),name:"old.txt",afterSave:undefined});
  let calls=0;const bytes=zip({"a.txt":"old","b.txt":"new"});
  await assert.rejects(saveDocumentArchive(s.db,input(s,bytes,{afterSave:()=>{if(++calls===2)throw new Error("Synthetic rollback");}})),/rollback/);
  assert.equal(listDocuments(s.db,s.c.id).length,1);assert.equal(fs.readdirSync(path.join(s.dir,"uploads")).length,1);
  assert.equal(documentOriginal(s.db,old.id,s.c.id).bytes.toString(),"old");
  changeCaseStatus(s.db,s.c.id,"archived");await assert.rejects(saveDocumentArchive(s.db,input(s,bytes)),/архивное/);
}finally{s.close();}});

test("открытие прогретой базы для чтения не требует блокировки записи",()=>{const s=setup();try{
  // Warm cache after schema extensions, then hold another connection's write lock.
  let reader=openDatabase({dataDirectory:s.dir});listDocuments(reader,s.c.id);reader.close();
  reader=openDatabase({dataDirectory:s.dir});reader.close();
  s.db.exec("BEGIN IMMEDIATE");
  try{reader=openDatabase({dataDirectory:s.dir});try{assert.equal(listDocuments(reader,s.c.id).length,0);}finally{reader.close();}}finally{s.db.exec("ROLLBACK");}
}finally{s.close();}});
