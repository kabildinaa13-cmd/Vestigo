import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {getCase,DEFAULT_DEPARTMENT_ID,DEFAULT_USER_ID} from './vestigo-db.mjs';
import {currentUserId} from './request-identity.mjs';
import {migrateCaseAnalysis,rebuildCaseAnalysis} from './case-analysis.mjs';

export class DocumentRemovalError extends Error{constructor(message,status=422){super(message);this.status=status;}}
const exists=(db,table)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
export function migrateDocumentRemoval(db){
 db.exec(`CREATE TABLE IF NOT EXISTS document_file_purges (
  stored_name TEXT PRIMARY KEY,document_id TEXT NOT NULL,case_id TEXT NOT NULL,department_id TEXT NOT NULL,
  created_at TEXT NOT NULL,last_error TEXT NOT NULL DEFAULT ''
 )`);
}
function directory(db){const file=db.prepare('PRAGMA database_list').all().find(r=>r.name==='main')?.file;if(!file)throw new DocumentRemovalError('Файловое хранилище недоступно');return path.resolve(path.dirname(file),'uploads');}
function originalPath(root,name){
 if(typeof name!=='string'||!name||path.basename(name)!==name||name.includes('\\')||name.includes('/')||!name.endsWith('.original'))throw new DocumentRemovalError('Некорректный путь оригинала; удаление отменено');
 const target=path.resolve(root,name);if(path.dirname(target)!==root)throw new DocumentRemovalError('Путь оригинала выходит за хранилище');return target;
}
// The durable cleanup queue closes the DB/filesystem boundary. A locked file is
// not reported as physically removed; the worker retries it after commit.
export function cleanupDocumentFiles(db,{documentId='',limit=50}={}){
 migrateDocumentRemoval(db);const root=directory(db),rows=db.prepare(`SELECT * FROM document_file_purges ${documentId?'WHERE document_id=?':''} ORDER BY created_at LIMIT ?`).all(...(documentId?[documentId]:[]),limit);
 for(const row of rows){try{
   const target=originalPath(root,row.stored_name);
   if(db.prepare('SELECT 1 FROM documents WHERE stored_name=?').get(row.stored_name)||db.prepare('SELECT 1 FROM document_versions WHERE stored_name=?').get(row.stored_name))throw Error('Оригинал снова используется; автоматическая очистка остановлена');
   try{fs.unlinkSync(target);}catch(e){if(e.code!=='ENOENT')throw e;}
   db.prepare('DELETE FROM document_file_purges WHERE stored_name=?').run(row.stored_name);
  }catch(e){db.prepare('UPDATE document_file_purges SET last_error=? WHERE stored_name=?').run(String(e.code||e.message).slice(0,500),row.stored_name);}
 }
 return db.prepare(`SELECT COUNT(*) n FROM document_file_purges ${documentId?'WHERE document_id=?':''}`).get(...(documentId?[documentId]:[])).n;
}
export function deleteCaseDocument(db,caseId,documentId,input={},context={}){
 migrateCaseAnalysis(db);migrateDocumentRemoval(db);
 const department=context.departmentId||DEFAULT_DEPARTMENT_ID,user=context.userId||currentUserId()||DEFAULT_USER_ID;
 let originalRemoved=false,otherCases=0,name='';
 db.exec('BEGIN IMMEDIATE');try{
  const parent=getCase(db,caseId,department);if(!parent)throw new DocumentRemovalError('Дело не найдено',404);if(parent.status==='archived')throw new DocumentRemovalError('Дело находится в архиве',409);
  const doc=db.prepare('SELECT d.* FROM documents d JOIN case_documents c ON c.document_id=d.id WHERE c.case_id=? AND d.id=? AND d.department_id=?').get(caseId,documentId,department);
  if(!doc)throw new DocumentRemovalError('Файл не найден в выбранном деле',404);name=doc.original_name;
  if(input.confirmationName!==name)throw new DocumentRemovalError('Подтвердите полное удаление выбранного файла');
  const active=(exists(db,'processing_jobs')&&db.prepare("SELECT 1 FROM processing_jobs WHERE case_id=? AND state='running'").get(caseId))||db.prepare("SELECT 1 FROM case_extractions WHERE case_id=? AND status='running'").get(caseId)||db.prepare("SELECT 1 FROM document_analytics WHERE case_id=? AND status='running'").get(caseId);
  if(active)throw new DocumentRemovalError('Дождитесь завершения обработки документов этого дела и повторите удаление',409);
  for(const table of ['reimbursements','assets'])if(db.prepare(`SELECT 1 FROM ${table} WHERE case_id=? AND document_id=?`).get(caseId,documentId))throw new DocumentRemovalError('Файл используется в материалах о возмещении или имуществе. Сначала измените ссылку на документ в соответствующей записи.',409);
  if(db.prepare('SELECT 1 FROM calculation_items i JOIN operations o ON o.id=i.operation_id JOIN operation_documents d ON d.operation_id=o.id WHERE o.case_id=? AND d.document_id=?').get(caseId,documentId))throw new DocumentRemovalError('Операции файла используются в сохранённом расчёте. Сначала исключите их из расчёта.',409);
  if(db.prepare('SELECT 1 FROM operation_documents d JOIN operations o ON o.id=d.operation_id LEFT JOIN case_operation_details x ON x.operation_id=o.id WHERE o.case_id=? AND d.document_id=? AND x.operation_id IS NULL').get(caseId,documentId))throw new DocumentRemovalError('Файл связан с операцией, добавленной вручную. Сначала измените её первоисточник.',409);
  // Remove only this case's scope and extracted content. Historical employee
  // decisions remain in the immutable audit; derived views are rebuilt below.
  for(const table of ['case_extracted_rows','case_source_rows','case_extractions','document_classifications','case_document_metadata','document_analytics','case_document_exclusions','processing_jobs','case_text_search'])if(exists(db,table))db.prepare(`DELETE FROM ${table} WHERE case_id=? AND document_id=?`).run(caseId,documentId);
  db.prepare('DELETE FROM episode_documents WHERE document_id=? AND episode_id IN (SELECT id FROM episodes WHERE case_id=?)').run(documentId,caseId);
  if(exists(db,'document_archive_members'))db.prepare('DELETE FROM document_archive_members WHERE case_id=? AND (document_id=? OR archive_document_id=?)').run(caseId,documentId,documentId);
  db.prepare('DELETE FROM case_documents WHERE case_id=? AND document_id=?').run(caseId,documentId);
  rebuildCaseAnalysis(db,caseId,context,false);
  // Remove generated participant roles no longer supported by any operation;
  // manually assigned roles and participants in other cases stay intact.
  db.prepare("DELETE FROM case_participants WHERE case_id=? AND role IN ('source_sender','source_recipient') AND NOT EXISTS(SELECT 1 FROM operations o WHERE o.case_id=case_participants.case_id AND (o.sender_participant_id=case_participants.participant_id OR o.recipient_participant_id=case_participants.participant_id))").run(caseId);
  otherCases=db.prepare('SELECT COUNT(*) n FROM case_documents WHERE document_id=?').get(documentId).n;
  if(!otherCases){
   const root=directory(db),names=[...new Set([doc.stored_name,...db.prepare('SELECT stored_name FROM document_versions WHERE document_id=?').all(documentId).map(r=>r.stored_name)])];
   for(const stored of names){originalPath(root,stored);db.prepare('INSERT OR IGNORE INTO document_file_purges(stored_name,document_id,case_id,department_id,created_at) VALUES(?,?,?,?,?)').run(stored,documentId,caseId,department,new Date().toISOString());}
   // Foreign keys intentionally reject unexpected remaining references. The
   // surrounding transaction then restores the complete case unchanged.
   db.prepare('DELETE FROM documents WHERE id=?').run(documentId);originalRemoved=true;
  }
  const now=new Date().toISOString();db.prepare('UPDATE cases SET updated_at=?,version=version+1 WHERE id=?').run(now,caseId);
  db.prepare("INSERT INTO audit_log(id,department_id,user_id,action,entity_type,entity_id,details_json,created_at) VALUES(?,?,?,'case.document_deleted','case',?,?,?)").run(randomUUID(),department,user,caseId,JSON.stringify({documentId,name,sha256:doc.sha256,permanentInCase:true,originalRetainedForOtherCases:!!otherCases,queuedPhysicalDeletion:originalRemoved}),now);
  db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');if(/FOREIGN KEY constraint/i.test(e.message))throw new DocumentRemovalError('Файл связан с другими сохранёнными материалами. Удаление отменено без изменения данных; сначала проверьте ссылки на него.',409);throw e;}
 let cleanupPending=0;
 if(originalRemoved){try{cleanupPending=cleanupDocumentFiles(db,{documentId});}catch{cleanupPending=1;}}
 return {caseId,documentId,deleted:true,originalDeleted:originalRemoved&&!cleanupPending,sharedOriginal:!!otherCases,cleanupPending:!!cleanupPending,message:cleanupPending?'Файл удалён из дела и аналитики. Оригинал временно занят; очистка хранилища будет повторена обработчиком.':otherCases?'Файл полностью удалён из этого дела. Оригинал сохранён для других дел.':'Файл и его результаты обработки удалены из дела; оригинал удалён из хранилища.'};
}
