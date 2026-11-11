import {currentUserId} from "./request-identity.mjs";
import {randomUUID} from "node:crypto";
import {getCase,DEFAULT_DEPARTMENT_ID,DEFAULT_USER_ID} from "./vestigo-db.mjs";
import {DOCUMENT_STAGES,documentProgress} from "./document-progress.mjs";
export const QUEUE_VERSION="processing-queue-1.0";
const active="'queued','retry','running'";
const nowIso=now=>new Date(now).toISOString();
export function migrateProcessingQueue(db){
  db.exec(`CREATE TABLE IF NOT EXISTS processing_jobs (
    id TEXT PRIMARY KEY,department_id TEXT NOT NULL REFERENCES departments(id),user_id TEXT NOT NULL,
    case_id TEXT NOT NULL REFERENCES cases(id),document_id TEXT NOT NULL REFERENCES documents(id),
    state TEXT NOT NULL CHECK(state IN ('queued','retry','running','completed','failed')),
    attempts INTEGER NOT NULL DEFAULT 0,max_attempts INTEGER NOT NULL DEFAULT 3,
    options_json TEXT NOT NULL,result_json TEXT NOT NULL DEFAULT '{}',error TEXT NOT NULL DEFAULT '',
    phase TEXT NOT NULL DEFAULT 'waiting',available_at TEXT NOT NULL,lease_until TEXT NOT NULL DEFAULT '',
    lease_token TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,finished_at TEXT NOT NULL DEFAULT ''
  );
  CREATE UNIQUE INDEX IF NOT EXISTS processing_active_document ON processing_jobs(case_id,document_id) WHERE state IN (${active});
  CREATE UNIQUE INDEX IF NOT EXISTS processing_running_case ON processing_jobs(case_id) WHERE state='running';
  CREATE INDEX IF NOT EXISTS processing_ready ON processing_jobs(state,available_at,created_at);
  CREATE INDEX IF NOT EXISTS processing_case ON processing_jobs(case_id,created_at);
  CREATE TABLE IF NOT EXISTS processing_workers (id TEXT PRIMARY KEY,last_seen TEXT NOT NULL,version TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS processing_department_turns (department_id TEXT PRIMARY KEY,last_started TEXT NOT NULL);`);
}
function scope(db,caseId,documentId,context={},writable=true){
  const department=context.departmentId||DEFAULT_DEPARTMENT_ID,parent=getCase(db,caseId,department);
  if(!parent)throw new Error("Дело не найдено");if(writable&&parent.status==="archived")throw new Error("Дело находится в архиве");
  if(documentId&&!db.prepare("SELECT 1 FROM case_documents c JOIN documents d ON d.id=c.document_id WHERE c.case_id=? AND c.document_id=? AND d.department_id=?").get(caseId,documentId,department))throw new Error("Документ не относится к делу");
  if(documentId&&writable&&db.prepare("SELECT media_type FROM documents WHERE id=?").get(documentId)?.media_type==="application/zip")throw new Error("Анализируются вложенные документы ZIP, а не сам архив");
  return department;
}
function audit(db,job,action,details={}){db.prepare("INSERT INTO audit_log(id,department_id,user_id,action,entity_type,entity_id,details_json,created_at) VALUES(?,?,?,?,'case',?,?,?)").run(randomUUID(),job.department_id,job.user_id,action,job.case_id,JSON.stringify({jobId:job.id,documentId:job.document_id,...details}),new Date().toISOString());}
function canonical(value,depth=0){if(depth>12)throw new Error("Слишком глубокая вложенность параметров");if(Array.isArray(value))return value.map(v=>canonical(v,depth+1));if(value&&typeof value==="object")return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k],depth+1)]));return value;}
function optionsJson(options){
  const allowed=["mapping","ownerId","ownerAccount","bankFeeMode","bankYear","direction","defaultCurrency","documentFields","manualConfirmed","classification","ocrContinuation"];
  if(!options||typeof options!=="object"||Array.isArray(options)||Object.keys(options).some(k=>!allowed.includes(k)))throw new Error("Некорректные параметры обработки");
  if(options.ocrContinuation!==undefined&&(!Number.isInteger(options.ocrContinuation)||options.ocrContinuation<0||options.ocrContinuation>2))throw new Error("Недопустимое число продолжений OCR");
  const json=JSON.stringify(canonical(options));if(Buffer.byteLength(json)>128*1024)throw new Error("Параметры обработки слишком велики");return json;
}
function sameProcessingOptions(left,right){const a=JSON.parse(left),b=JSON.parse(right);delete a.ocrContinuation;delete b.ocrContinuation;return JSON.stringify(canonical(a))===JSON.stringify(canonical(b));}
export function publicJob(row){if(!row)return null;const job={id:row.id,caseId:row.case_id,documentId:row.document_id,name:row.original_name||"",state:row.state,attempts:row.attempts,maxAttempts:row.max_attempts,phase:row.phase,error:row.error,createdAt:row.created_at,updatedAt:row.updated_at,finishedAt:row.finished_at,result:JSON.parse(row.result_json)};return {...job,progress:documentProgress(job)};}
export function updateProcessingPhase(db,id,token,phase){
  if(!Object.hasOwn(DOCUMENT_STAGES,phase)||phase==="done"||phase==="waiting")throw new Error("Некорректный этап чтения");
  const job=assertProcessingLease(db,id,token);
  const previous=DOCUMENT_STAGES[job.phase]?.percent||0;
  if(DOCUMENT_STAGES[phase].percent<previous)throw new Error("Этап обработки не может вернуться назад");
  db.prepare("UPDATE processing_jobs SET phase=?,updated_at=? WHERE id=? AND state='running' AND lease_token=?").run(phase,new Date().toISOString(),id,token);
}
export function enqueueProcessing(db,{caseId,documentId,options={},force=false},context={},transaction=true){
  migrateProcessingQueue(db);const department=scope(db,caseId,documentId,context),json=optionsJson(options);
  if(transaction)db.exec("BEGIN IMMEDIATE");
  try{
    const existing=db.prepare(`SELECT * FROM processing_jobs WHERE case_id=? AND document_id=? AND state IN (${active})`).get(caseId,documentId);
    if(existing){if(!sameProcessingOptions(existing.options_json,json))throw new Error("Для этого файла уже сохранено задание с другими параметрами. Дождитесь завершения.");if(transaction)db.exec("COMMIT");return {job:publicJob(existing),duplicate:true};}
    if(!force){const latest=db.prepare("SELECT * FROM processing_jobs WHERE case_id=? AND document_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(caseId,documentId);if(latest?.state==="completed"&&sameProcessingOptions(latest.options_json,json)){if(transaction)db.exec("COMMIT");return {job:publicJob(latest),duplicate:true};}}
    const id=randomUUID(),now=new Date().toISOString();
    db.prepare("INSERT INTO processing_jobs(id,department_id,user_id,case_id,document_id,state,options_json,available_at,created_at,updated_at) VALUES(?,?,?,?,?,'queued',?,?,?,?)").run(id,department,context.userId || currentUserId() || DEFAULT_USER_ID,caseId,documentId,json,now,now,now);
    const job=db.prepare("SELECT * FROM processing_jobs WHERE id=?").get(id);audit(db,job,"case.processing_queued");
    if(transaction)db.exec("COMMIT");return {job:publicJob(job),duplicate:false};
  }catch(error){if(transaction)db.exec("ROLLBACK");throw error;}
}
export function assertProcessingLease(db,jobId,token,now=Date.now()){
  const job=db.prepare("SELECT * FROM processing_jobs WHERE id=? AND state='running' AND lease_token=? AND lease_until>?").get(jobId,token,nowIso(now));
  if(!job)throw new Error("Задание потеряло право обработки; устаревший результат не сохранён");return job;
}
export function reserveSynchronousProcessing(db,caseId,documentId,context={}){
  migrateProcessingQueue(db);const department=scope(db,caseId,documentId,context);db.exec("BEGIN IMMEDIATE");
  try{
    if(db.prepare(`SELECT 1 FROM processing_jobs WHERE case_id=? AND (state='running' OR (document_id=? AND state IN ('queued','retry')))`).get(caseId,documentId))throw new Error("В деле уже есть фоновое задание. Дождитесь его завершения.");
    const id=randomUUID(),token=randomUUID(),now=Date.now();
    db.prepare("INSERT INTO processing_jobs(id,department_id,user_id,case_id,document_id,state,attempts,max_attempts,options_json,phase,available_at,lease_until,lease_token,created_at,updated_at) VALUES(?,?,?,?,?,'running',1,1,'{}','reading',?,?,?,?,?)").run(id,department,context.userId || currentUserId() || DEFAULT_USER_ID,caseId,documentId,nowIso(now),nowIso(now+600000),token,nowIso(now),nowIso(now));
    audit(db,db.prepare("SELECT * FROM processing_jobs WHERE id=?").get(id),"case.processing_started",{synchronous:true});db.exec("COMMIT");return {id,token,kind:"sync"};
  }catch(error){db.exec("ROLLBACK");throw error;}
}
export function workerHeartbeat(db,id,now=Date.now()){migrateProcessingQueue(db);db.prepare("INSERT INTO processing_workers VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen,version=excluded.version").run(id,nowIso(now),QUEUE_VERSION);}
export function claimProcessing(db,{now=Date.now(),leaseMs=600000,maxConcurrent=Infinity}={}){
  migrateProcessingQueue(db);db.exec("BEGIN IMMEDIATE");
  try{
    for(const old of db.prepare("SELECT * FROM processing_jobs WHERE state='running' AND lease_until<=?").all(nowIso(now))){
      const failed=old.attempts>=old.max_attempts;
      db.prepare("UPDATE processing_jobs SET state=?,phase='interrupted',lease_token='',lease_until='',available_at=?,updated_at=?,finished_at=?,error=? WHERE id=?").run(failed?"failed":"retry",nowIso(now),nowIso(now),failed?nowIso(now):"","Обработчик прервался; сохранённое задание восстановлено",old.id);
      if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='case_extractions'").get())db.prepare("UPDATE case_extractions SET status='failed',error=? WHERE case_id=? AND document_id=? AND status='running'").run("Предыдущий обработчик прервался",old.case_id,old.document_id);
      audit(db,old,"case.processing_recovered",{state:failed?"failed":"retry"});
    }
    if(db.prepare("SELECT COUNT(*) n FROM processing_jobs WHERE state='running'").get().n>=maxConcurrent){db.exec("COMMIT");return null;}
    const extractionGuard=db.prepare("SELECT 1 FROM sqlite_master WHERE name='case_extractions'").get()?"AND NOT EXISTS(SELECT 1 FROM case_extractions e WHERE e.case_id=j.case_id AND e.status='running' AND e.updated_at>?)":"";
    const statement=db.prepare(`SELECT j.* FROM processing_jobs j LEFT JOIN processing_department_turns t ON t.department_id=j.department_id WHERE j.state IN ('queued','retry') AND j.available_at<=? AND NOT EXISTS(SELECT 1 FROM case_deletions z WHERE z.case_id=j.case_id) AND NOT EXISTS(SELECT 1 FROM processing_jobs r WHERE r.case_id=j.case_id AND r.state='running') ${extractionGuard} ORDER BY COALESCE(t.last_started,''),j.created_at,j.id LIMIT 1`);
    const row=extractionGuard?statement.get(nowIso(now),nowIso(now-600000)):statement.get(nowIso(now));
    if(!row){db.exec("COMMIT");return null;}
    const token=randomUUID();db.prepare("UPDATE processing_jobs SET state='running',phase='reading',attempts=attempts+1,lease_token=?,lease_until=?,updated_at=?,error='' WHERE id=?").run(token,nowIso(now+leaseMs),nowIso(now),row.id);
    db.prepare("INSERT INTO processing_department_turns VALUES(?,?) ON CONFLICT(department_id) DO UPDATE SET last_started=excluded.last_started").run(row.department_id,nowIso(now));
    const claimed=db.prepare("SELECT * FROM processing_jobs WHERE id=?").get(row.id);audit(db,claimed,"case.processing_started",{attempt:claimed.attempts});db.exec("COMMIT");return {...claimed,options:JSON.parse(claimed.options_json)};
  }catch(error){db.exec("ROLLBACK");throw error;}
}
export function renewProcessing(db,id,token,{now=Date.now(),leaseMs=600000}={}){return db.prepare("UPDATE processing_jobs SET lease_until=?,updated_at=? WHERE id=? AND state='running' AND lease_token=? AND lease_until>?").run(nowIso(now+leaseMs),nowIso(now),id,token,nowIso(now)).changes===1;}
export function completeProcessing(db,id,token,result){const job=assertProcessingLease(db,id,token);const now=new Date().toISOString();db.prepare("UPDATE processing_jobs SET state='completed',phase='done',result_json=?,updated_at=?,finished_at=?,lease_until='',lease_token='',error='' WHERE id=?").run(JSON.stringify(result),now,now,id);audit(db,job,"case.processing_completed");}
export function failProcessing(db,id,token,error,{now=Date.now(),retryable=false}={}){
  const job=db.prepare("SELECT * FROM processing_jobs WHERE id=? AND state='running' AND lease_token=?").get(id,token);if(!job)return false;
  const retry=retryable&&job.attempts<job.max_attempts,message=String(error?.message||error).slice(0,4000);
  db.prepare("UPDATE processing_jobs SET state=?,phase='error',error=?,available_at=?,updated_at=?,finished_at=?,lease_until='',lease_token='' WHERE id=?").run(retry?"retry":"failed",message,nowIso(now+Math.min(60000,2000*2**job.attempts)),nowIso(now),retry?"":nowIso(now),id);
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='case_extractions'").get())db.prepare("UPDATE case_extractions SET status='failed',error=?,updated_at=? WHERE case_id=? AND document_id=? AND status='running'").run(message,nowIso(now),job.case_id,job.document_id);
  audit(db,job,"case.processing_failed",{retry,message});return true;
}
export function retryProcessing(db,caseId,id,context={}){
  migrateProcessingQueue(db);scope(db,caseId,null,context);
  const old=db.prepare("SELECT * FROM processing_jobs WHERE id=? AND case_id=?").get(id,caseId);if(!old||old.state!=="failed")throw new Error("Повторить можно только ошибочное задание этого дела");
  return enqueueProcessing(db,{caseId,documentId:old.document_id,options:JSON.parse(old.options_json),force:true},context);
}
export function listProcessing(db,caseId,{offset=0,limit=50,id="",ids=/** @type {string[]} */([]),activeOnly=false}={},context={}){
  migrateProcessingQueue(db);scope(db,caseId,null,context,false);
  if(!Array.isArray(ids)||ids.length>100||ids.some(v=>typeof v!=="string"||!/^[a-zA-Z0-9-]{1,80}$/.test(v)))throw new Error("Некорректный список документов анализа");
  const prefix="SELECT j.*,d.original_name FROM processing_jobs j JOIN documents d ON d.id=j.document_id WHERE j.case_id=?";
  const jobs=id?db.prepare(prefix+" AND j.id=?").all(caseId,id):ids.length?db.prepare(prefix+` AND j.id IN (${ids.map(()=>"?").join(",")})`).all(caseId,...ids):db.prepare(prefix+(activeOnly?` AND j.state IN (${active})`:"")+" ORDER BY j.created_at DESC,j.id LIMIT ? OFFSET ?").all(caseId,Math.min(100,Math.max(1,limit)),Math.max(0,offset));
  const counts=Object.fromEntries(db.prepare("SELECT state,COUNT(*) n FROM processing_jobs WHERE case_id=? GROUP BY state").all(caseId).map(r=>[r.state,r.n]));
  const last=db.prepare("SELECT MAX(last_seen) last FROM processing_workers").get().last;
  const total=ids.length?jobs.length:activeOnly?(counts.queued||0)+(counts.retry||0)+(counts.running||0):Object.values(counts).reduce((a,b)=>a+b,0);
  return {jobs:jobs.map(publicJob),counts,total,workerOnline:!!last&&Date.now()-Date.parse(last)<60000,workerLastSeen:last||null,version:QUEUE_VERSION};
}
