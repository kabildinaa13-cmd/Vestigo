import {randomUUID} from "node:crypto";
import {openDatabase} from "../app/lib/vestigo-db.mjs";
import {migrateCaseAnalysis} from "../app/lib/case-analysis.mjs";
import {workerHeartbeat,claimProcessing,renewProcessing,failProcessing} from "../app/lib/processing-queue.mjs";
import {processCaseDocument} from "../app/lib/document-processing.mjs";
import {cleanupDocumentFiles} from "../app/lib/document-removal.mjs";
const id=randomUUID();let stopping=false;
const requestedConcurrency=Number(process.env.VESTIGO_PROCESSING_CONCURRENCY||1),maxConcurrent=Number.isInteger(requestedConcurrency)&&requestedConcurrency>=1&&requestedConcurrency<=4?requestedConcurrency:1;
process.on("SIGINT",()=>{stopping=true;});process.on("SIGTERM",()=>{stopping=true;});
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
console.log("Vestigo background processor started");
while(!stopping){
  let db,job;
  try{
    db=openDatabase();
    migrateCaseAnalysis(db);cleanupDocumentFiles(db);workerHeartbeat(db,id);job=claimProcessing(db,{maxConcurrent});
    if(job){
      const heartbeat=setInterval(()=>{try{workerHeartbeat(db,id);if(!renewProcessing(db,job.id,job.lease_token))console.error("Processing lease lost; result will not commit");}catch{console.error("Processing heartbeat delayed");}},10000);
      try{await processCaseDocument(db,job.case_id,job.document_id,job.options,{departmentId:job.department_id,userId:job.user_id},{id:job.id,token:job.lease_token});}
      catch(error){const transient=/SQLITE_BUSY|database is locked|EBUSY|ECONNRESET|в этом деле уже обрабатывается/i.test(String(error.message));failProcessing(db,job.id,job.lease_token,error,{retryable:transient});console.error("Document job requires attention",job.id);}
      finally{clearInterval(heartbeat);}
    }
  }catch{console.error("Background processor unavailable; retrying");}
  finally{db?.close();}
  if(!job)await wait(1500);
}
console.log("Vestigo background processor stopped");
