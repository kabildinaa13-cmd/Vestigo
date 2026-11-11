import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {openDatabase,createCase} from "../app/lib/vestigo-db.mjs";
import {saveDocument} from "../app/lib/documents.mjs";
import {documentProgress,transferPercent,analysisSummary} from "../app/lib/document-progress.mjs";
import {enqueueProcessing,claimProcessing,updateProcessingPhase,completeProcessing,failProcessing,listProcessing} from "../app/lib/processing-queue.mjs";

test("percentages represent confirmed stages, not time; failures and unread pages never show success",()=>{
  assert.equal(documentProgress({state:"queued"}).percent,0);
  assert.equal(documentProgress({state:"running",phase:"reading"}).percent,10);
  assert.equal(documentProgress({state:"running",phase:"matching"}).percent,90);
  assert.equal(documentProgress({state:"failed"}).percent,null);
  assert.equal(documentProgress({state:"completed",result:{summary:{status:"needs_ocr"}}}).percent,null);
  assert.equal(documentProgress({state:"completed",result:{summary:{pageAudit:{pagesWithoutText:[2]}}}}).percent,null);
  assert.equal(documentProgress({state:"completed",result:{summary:{status:"extracted"}}}).percent,100);
  assert.equal(documentProgress({state:"completed",result:{summary:{status:"needs_mapping"}}}).attention,true);
  assert.equal(analysisSummary([{state:"completed"},{state:"failed"},{state:"running",phase:"reading"}]).percent,36);
});
test("transfer percent is calculated from observed bytes, including multipart overhead",()=>{
  assert.equal(transferPercent(100,60,120,100,400),37);
  assert.equal(transferPercent(0,200,100,400,400),100);
  assert.equal(transferPercent(0,0,0,100,100),null);
  assert.equal(transferPercent(0,-10,100,100,100),0);
});
test("server stages are scoped and monotonic; only committed completion produces 100 percent",()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"vestigo-progress-test-")),db=openDatabase({dataDirectory:dir});
  try{
    const a=createCase(db,{caseNumber:"PROGRESS-A"}),b=createCase(db,{caseNumber:"PROGRESS-B"});
    const doc=saveDocument(db,{caseId:a.id,name:"synthetic.txt",bytes:Buffer.from("TEST"),groupId:"unclassified",typeId:"unclassified"});
    const queued=enqueueProcessing(db,{caseId:a.id,documentId:doc.id}).job;
    const job=claimProcessing(db);
    updateProcessingPhase(db,job.id,job.lease_token,"classifying");
    assert.equal(listProcessing(db,a.id,{ids:[job.id]}).jobs[0].progress.percent,55);
    assert.equal(listProcessing(db,b.id,{ids:[job.id]}).jobs.length,0);
    assert.throws(()=>updateProcessingPhase(db,job.id,job.lease_token,"reading"),/назад/);
    assert.throws(()=>updateProcessingPhase(db,job.id,"stale","matching"),/потеряло/);
    assert.throws(()=>updateProcessingPhase(db,job.id,job.lease_token,"done"),/Некорректный/);
    assert.throws(()=>listProcessing(db,a.id,{ids:["x'); DROP TABLE cases;--"]}),/Некорректный/);
    assert.throws(()=>listProcessing(db,a.id,{ids:Array(101).fill(job.id)}),/Некорректный/);
    assert.equal(listProcessing(db,a.id,{activeOnly:true}).total,1);
    completeProcessing(db,job.id,job.lease_token,{summary:{status:"extracted"}});
    assert.equal(listProcessing(db,a.id,{ids:[queued.id]}).jobs[0].progress.percent,100);
    assert.equal(listProcessing(db,a.id,{activeOnly:true}).total,0);
  }finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test("old background queue panel is not rendered; upload and analysis progress are separate",()=>{
  const panel=fs.readFileSync("app/components/documents-panel.tsx","utf8");
  assert.doesNotMatch(panel,/ProcessingQueuePanel|задание сохранено в фоновой|Сохранить задания на фоновое/i);
  assert.match(panel,/DocumentAnalysisProgress/);assert.match(panel,/uploadDocument\(data/);
});
