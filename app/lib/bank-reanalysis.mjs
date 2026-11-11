// Preview deliberately uses only SELECT + read-only original-file access.
// It does NOT call processCaseDocument, extractOriginal, storeExtraction,
// migrations, queue reservation, status updates or financial rebuilds.
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {getCase} from './vestigo-db.mjs';
import {operationKey} from './case-analysis.mjs';
import {validIban} from './bank-identities.mjs';
const stable=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const digest=value=>createHash('sha256').update(stable(value)).digest('hex');
function snapshot(db,caseId,documentId,body,context={}){
 const parent=getCase(db,caseId,context.departmentId);if(!parent)throw Error('Дело не найдено');if(parent.status==='archived')throw Error('Дело находится в архиве');
 const meta=db.prepare('SELECT m.group_code,m.type_code,d.sha256,d.stored_name,d.original_name FROM case_documents c JOIN documents d ON d.id=c.document_id JOIN case_document_metadata m ON m.document_id=c.document_id AND m.case_id=c.case_id WHERE c.case_id=? AND c.document_id=?').get(caseId,documentId);
 if(!meta)throw Error('Документ не относится к делу');if(meta.group_code!=='bank')throw Error('Этот предварительный просмотр предназначен для банковских документов');
 if(db.prepare('SELECT 1 FROM case_document_exclusions WHERE case_id=? AND document_id=?').get(caseId,documentId))throw Error('Документ исключён из анализа дела. Сначала верните его в анализ явным действием.');
 const saved=db.prepare('SELECT updated_at,status,options_json,summary_json FROM case_extractions WHERE case_id=? AND document_id=?').get(caseId,documentId),prior=JSON.parse(saved?.options_json||'{}');
 const settings=Object.fromEntries(['mapping','tableSettings','ownerId','ownerAccount','bankFeeMode','defaultCurrency','bankYear','direction','ocrEnabled'].map(k=>[k,body[k]??prior[k]??({mapping:{},tableSettings:[],bankFeeMode:'unknown',ocrEnabled:true}[k]??'')]));
 if(settings.ownerId&&(!/^\d{12}$/.test(settings.ownerId)||settings.ownerId==='000000000000'))throw Error('Укажите действительный БИН/ИИН владельца из 12 цифр; нулевой идентификатор недопустим');
 if(settings.ownerAccount&&!validIban(settings.ownerAccount))throw Error('Укажите корректный IBAN владельца');
 if(settings.bankYear&&!/^(19|20|21)\d{2}$/.test(String(settings.bankYear)))throw Error('Укажите четырёхзначный год периода (1900–2199)');
 if(stable(settings).length>120000)throw Error('Настройки слишком велики');
 return {meta,settings,fingerprint:digest(['bank-preview-1.0',caseId,documentId,meta.sha256,saved,settings])};
}
export function assertBankPreview(db,caseId,documentId,body,context={}){
 if(!body.previewFingerprint)return;
 if(typeof body.previewFingerprint!=='string'||body.previewFingerprint!==snapshot(db,caseId,documentId,body,context).fingerprint)throw Error('Предпросмотр устарел или настройки изменены. Повторите предпросмотр перед применением.');
}
async function readBankOriginal(db,meta,settings){
 const file=db.prepare('PRAGMA database_list').all().find(v=>v.name==='main').file;
 const source=path.join(path.dirname(file),'uploads',path.basename(meta.stored_name));
 const originalHash=createHash('sha256').update(fs.readFileSync(source)).digest('hex');
 if(originalHash!==meta.sha256)throw Error('Контрольная сумма оригинала не совпадает; предварительный анализ остановлен');
 const root=process.cwd(),localPython=path.join(root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
 const python=process.env.VESTIGO_PYTHON||(fs.existsSync(localPython)?localPython:'python');
 return new Promise((resolve,reject)=>{
  const child=spawn(python,[path.join(root,'scripts/extract_case_document.py'),source,meta.original_name],{cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONIOENCODING:'utf-8'}}),chunks=[];let size=0,error='';
  const timer=setTimeout(()=>{child.kill();reject(Error('Превышено время предварительного чтения; сохранённый результат не изменён'));},540000);
  child.stdout.on('data',chunk=>{size+=chunk.length;if(size>96*1024*1024){child.kill();clearTimeout(timer);reject(Error('Результат предварительного чтения слишком велик'));}else chunks.push(chunk);});
  child.stderr.on('data',chunk=>{error=(error+chunk.toString('utf8')).slice(-6000);});
  child.on('error',reason=>{clearTimeout(timer);reject(reason);});
  child.on('close',code=>{clearTimeout(timer);if(code!==0)return reject(Error(error||'Предварительное чтение не завершено'));try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{reject(Error('Некорректный результат предварительного чтения'));}});
  child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({...settings,groupId:meta.group_code,typeId:meta.type_code}));
 });
}
export async function previewBankDocument(db,caseId,documentId,body={},context={}){
 const {meta,settings,fingerprint}=snapshot(db,caseId,documentId,body,context);
 const before=db.prepare('SELECT COUNT(DISTINCT s.operation_id) AS n FROM case_operation_sources s JOIN operations o ON o.id=s.operation_id WHERE o.case_id=? AND s.document_id=?').get(caseId,documentId).n;
 const result=await readBankOriginal(db,meta,settings);
 const full=result.rows.filter(r=>r.type==='payment'&&r.senderId&&r.recipientId&&r.date&&Number.isSafeInteger(r.amountMinor)&&r.currency&&r.currency!=='UNKNOWN'&&!r.attributes?.extractionBlocked);
 const operations=new Set(full.map(r=>operationKey(r,{document_id:documentId,sheet:r.sheet,row_number:r.row}))).size;
 const needsOwner=result.rows.some(r=>r.bank&&!r.bank.ownerId),needsYear=result.rows.some(r=>r.bank?.issues?.some(v=>v.startsWith('Двузначный год')));
 return {preview:true,caseId,documentId,fingerprint,settings,operationsBefore:before,operationsAfter:operations,rows:result.rows.length,eligibleRows:full.length,partialRows:result.rows.filter(r=>r.bank?.normalizationStatus==='partial').length,reviewRows:result.quality?.reviewRows??result.unparsedRows,skippedRows:result.quality?.skippedRows||0,issueCounts:result.quality?.issueCounts||{},requiredActions:[...(needsOwner?['Укажите или подтвердите БИН/ИИК владельца счёта по шапке выписки.']:[]),...(needsYear?['Подтвердите четырёхзначный год периода для дат ДД.ММ.ГГ.']:[])],sample:result.rows.slice(0,20).map(r=>({sheet:r.sheet,row:r.row,date:r.date,senderId:r.senderId,recipientId:r.recipientId,amountMinor:r.amountMinor,currency:r.currency,direction:r.bank?.direction,status:r.bank?.normalizationStatus,missingFields:r.bank?.missingFields||[],issues:r.bank?.issues||[]})),sampleTruncated:result.rows.length>20,message:'Предварительное чтение оригинала. Сохранённые операции, извлечение и решения сотрудников не изменены. Прогноз относится к этому документу, не ко всему делу.'};
}
