import {randomUUID} from 'node:crypto';
import {getCase,DEFAULT_DEPARTMENT_ID,DEFAULT_USER_ID} from './vestigo-db.mjs';
import {currentUserId} from './request-identity.mjs';
export class CaseTrashError extends Error{constructor(message,status=400){super(message);this.status=status;}}
const exists=(db,table)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE name=? AND type='table'").get(table);
export function listDeletedCases(db,departmentId=DEFAULT_DEPARTMENT_ID){return db.prepare(`SELECT c.id,c.case_number caseNumber,c.status,c.description,z.deleted_at deletedAt FROM case_deletions z JOIN cases c ON c.id=z.case_id WHERE c.department_id=? ORDER BY z.deleted_at DESC,c.id`).all(departmentId);}
function audit(db,parent,action,userId){db.prepare("INSERT INTO audit_log(id,department_id,user_id,action,entity_type,entity_id,details_json,created_at) VALUES(?,?,?,?,'case',?,?,?)").run(randomUUID(),parent.department_id,userId,action,parent.id,JSON.stringify({caseNumber:parent.case_number,recoverable:true}),new Date().toISOString());}
export function trashCase(db,input,context={}){
 const department=context.departmentId||DEFAULT_DEPARTMENT_ID,user=context.userId||currentUserId()||DEFAULT_USER_ID,id=String(input.id||'');
 db.exec('BEGIN IMMEDIATE');try{
  const parent=getCase(db,id,department);if(!parent)throw new CaseTrashError('Дело не найдено или уже находится в корзине',404);
  if(String(input.confirmationNumber||'').trim()!==parent.caseNumber)throw new CaseTrashError('Для удаления введите точный номер дела');
  const running=(exists(db,'processing_jobs')&&db.prepare("SELECT 1 FROM processing_jobs WHERE case_id=? AND state='running'").get(id))||(exists(db,'case_extractions')&&db.prepare("SELECT 1 FROM case_extractions WHERE case_id=? AND status='running'").get(id))||(exists(db,'document_analytics')&&db.prepare("SELECT 1 FROM document_analytics WHERE case_id=? AND status='running'").get(id));
  if(running)throw new CaseTrashError('Дождитесь завершения обработки документов этого дела и повторите удаление',409);
  const now=new Date().toISOString();db.prepare('INSERT INTO case_deletions(case_id,deleted_at,deleted_by) VALUES(?,?,?)').run(id,now,user);db.prepare('UPDATE cases SET updated_at=?,version=version+1 WHERE id=?').run(now,id);
  audit(db,{id,department_id:department,case_number:parent.caseNumber},'case.trashed',user);db.exec('COMMIT');return {id,caseNumber:parent.caseNumber,deletedAt:now,recoverable:true};
 }catch(e){db.exec('ROLLBACK');throw e;}
}
export function restoreCase(db,id,context={}){
 const department=context.departmentId||DEFAULT_DEPARTMENT_ID,user=context.userId||currentUserId()||DEFAULT_USER_ID;
 db.exec('BEGIN IMMEDIATE');try{
  const parent=db.prepare('SELECT c.* FROM cases c JOIN case_deletions z ON z.case_id=c.id WHERE c.id=? AND c.department_id=?').get(id,department);if(!parent)throw new CaseTrashError('Удалённое дело не найдено',404);
  db.prepare('DELETE FROM case_deletions WHERE case_id=?').run(id);db.prepare('UPDATE cases SET updated_at=?,version=version+1 WHERE id=?').run(new Date().toISOString(),id);audit(db,parent,'case.restored',user);db.exec('COMMIT');return getCase(db,id,department);
 }catch(e){db.exec('ROLLBACK');throw e;}
}
