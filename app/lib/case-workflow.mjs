// Case registers reuse participants/reimbursements/assets. No legal conclusions
// or values are inferred from a filename, an invoice total or a claim alone.
import {randomUUID,createHash} from 'node:crypto';
import {getCase,DEFAULT_DEPARTMENT_ID,DEFAULT_USER_ID} from './vestigo-db.mjs';
import {currentUserId} from './request-identity.mjs';
import {caseAnalysis,migrateCaseAnalysis} from './case-analysis.mjs';
import {bankPaymentClass,isBankFee} from './bank-identities.mjs';
import {workCostSources} from './work-cost-sources.mjs';
import {compareWorkCosts} from './work-cost-comparison.mjs';

const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const states=new Set(['pending','confirmed','rejected']);
const parse=x=>JSON.parse(x||'{}');
export class WorkflowError extends Error{constructor(message,status=422){super(message);this.status=status;}}
const fail=(message,status)=>{throw new WorkflowError(message,status);};
const text=(v,max=4000)=>{if(typeof v!=='string'||v.includes('\0')||v.length>max)fail('Некорректное текстовое поле');return v.trim();};
const note=v=>{const s=text(v);if(!s)fail('Укажите обоснование и источник сведений');return s;};
const iso=v=>{if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(Date.parse(v))||new Date(v).toISOString().slice(0,10)!==v)fail('Укажите действительную дату');return v;};
const currency=v=>{if(typeof v!=='string'||!Intl.supportedValuesOf('currency').includes(v))fail('Укажите поддерживаемую валюту');return v;};
// API amounts are strings in minor units, never floating point or locale text.
const minor=v=>{if(typeof v!=='string'||!/^\d{1,16}$/.test(v)||BigInt(v)>9000000000000000n)fail('Укажите неотрицательную сумму в минимальных денежных единицах');return BigInt(v);};
const actor=c=>c.userId||currentUserId()||DEFAULT_USER_ID;
function scope(db,id,c={},write=false){const result=getCase(db,id,c.departmentId||DEFAULT_DEPARTMENT_ID);if(!result)fail('Дело не найдено',404);if(write&&result.status==='archived')fail('Дело находится в архиве',409);return result;}
const tx=(db,fn)=>{db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}};
export function migrateCaseWorkflow(db){migrateCaseAnalysis(db);db.exec(`
 CREATE TABLE IF NOT EXISTS case_loss_versions(id TEXT PRIMARY KEY,case_id TEXT NOT NULL REFERENCES cases(id),scope_key TEXT NOT NULL,version INTEGER NOT NULL,snapshot_json TEXT NOT NULL,created_at TEXT NOT NULL,created_by TEXT NOT NULL REFERENCES users(id),UNIQUE(case_id,scope_key,version));
 CREATE TABLE IF NOT EXISTS case_return_details(id TEXT PRIMARY KEY REFERENCES reimbursements(id),currency TEXT NOT NULL,note TEXT NOT NULL,status TEXT NOT NULL,operation_id TEXT NOT NULL DEFAULT '',operation_fingerprint TEXT NOT NULL DEFAULT '',source_json TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1);
 CREATE TABLE IF NOT EXISTS case_asset_details(id TEXT PRIMARY KEY REFERENCES assets(id),currency TEXT NOT NULL,note TEXT NOT NULL,victim_id TEXT NOT NULL DEFAULT '',version INTEGER NOT NULL DEFAULT 1);
 CREATE TABLE IF NOT EXISTS case_operation_episode(operation_id TEXT PRIMARY KEY REFERENCES operations(id) ON DELETE CASCADE,case_id TEXT NOT NULL REFERENCES cases(id),episode_id TEXT REFERENCES episodes(id),note TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1);
 CREATE TABLE IF NOT EXISTS case_party_names(case_id TEXT NOT NULL REFERENCES cases(id),participant_id TEXT NOT NULL REFERENCES participants(id),name TEXT NOT NULL,PRIMARY KEY(case_id,participant_id));
 CREATE TABLE IF NOT EXISTS case_material_events(id TEXT PRIMARY KEY,case_id TEXT NOT NULL REFERENCES cases(id),episode_id TEXT REFERENCES episodes(id),kind TEXT NOT NULL,date TEXT NOT NULL,sender_id TEXT NOT NULL REFERENCES participants(id),recipient_id TEXT NOT NULL REFERENCES participants(id),details_json TEXT NOT NULL,status TEXT NOT NULL,note TEXT NOT NULL,version INTEGER NOT NULL,created_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
`);if(!db.prepare('PRAGMA table_info(case_asset_details)').all().some(c=>c.name==='valuation_known'))db.exec('ALTER TABLE case_asset_details ADD COLUMN valuation_known INTEGER NOT NULL DEFAULT 1');}
function party(db,caseId,id,victim=false){const p=db.prepare('SELECT p.id,p.identifier,p.kind,COALESCE(n.name,p.name) name FROM participants p JOIN case_participants c ON c.participant_id=p.id LEFT JOIN case_party_names n ON n.case_id=c.case_id AND n.participant_id=p.id WHERE c.case_id=? AND p.id=?'+(victim?" AND c.role='victim'":'')+' LIMIT 1').get(caseId,id);if(!p)fail(victim?'Потерпевший не зарегистрирован в этом деле':'Участник не относится к делу');return p;}
function episode(db,caseId,id){if(id&&!db.prepare('SELECT 1 FROM episodes WHERE id=? AND case_id=?').get(id,caseId))fail('Эпизод не относится к делу');return id||null;}
function source(db,caseId,input){
 if(!input||typeof input!=='object')fail('Укажите документ-основание');
 const doc=db.prepare('SELECT d.id,d.original_name,d.sha256 FROM documents d JOIN case_documents c ON c.document_id=d.id WHERE c.case_id=? AND d.id=?').get(caseId,String(input.documentId||''));
 if(!doc)fail('Источник не найден в выбранном деле');
 if(db.prepare('SELECT 1 FROM case_document_exclusions WHERE case_id=? AND document_id=?').get(caseId,doc.id))fail('Источник исключён из анализа');
 const sheet=String(input.sheet||''),row=input.row||0,page=input.page||0;
 if(sheet.length>500||!Number.isSafeInteger(row)||row<0||!Number.isSafeInteger(page)||page<0||page>100000)fail('Некорректное положение в источнике');
 if(row&&!db.prepare('SELECT 1 FROM case_extracted_rows WHERE case_id=? AND document_id=? AND sheet=? AND row_number=?').get(caseId,doc.id,sheet,row)&&!db.prepare('SELECT 1 FROM case_source_rows WHERE case_id=? AND document_id=? AND sheet=? AND row_number=?').get(caseId,doc.id,sheet,row))fail('Исходная строка отсутствует');
 if(page){const e=db.prepare('SELECT pages_json FROM case_extractions WHERE case_id=? AND document_id=?').get(caseId,doc.id);if(!e||!parse(e.pages_json).some(p=>p.page===page))fail('Исходная страница отсутствует');}
 return {documentId:doc.id,name:doc.original_name,sha256:doc.sha256,sheet,row,page};
}
function decision(db,caseId,id,title,status,reason,sources,c,before=null,parties=[],changed=false){
 const review={version:1,kind:'workflow',title,parties,sources,before:before||{status:null,note:''},available:true,changed};
 db.prepare("INSERT INTO audit_log(id,department_id,user_id,action,entity_type,entity_id,details_json,created_at) VALUES(?,?,?,'case.workflow_reviewed','case',?,?,?)").run(randomUUID(),c.departmentId||DEFAULT_DEPARTMENT_ID,actor(c),caseId,JSON.stringify({id,kind:'workflow',status,note:reason,review}),new Date().toISOString());
}
function operations(db,caseId,c){return caseAnalysis(db,caseId,{all:true,skipChains:true},c).operations;}
function usablePayment(o){return o&&o.type==='payment'&&o.confirmed&&!o.conflict&&o.reviewStatus==='confirmed'&&!isBankFee(o)&&!['conversion','internal'].includes(bankPaymentClass(o))&&o.currency!=='UNKNOWN'&&o.amountMinor>0;}
const usableOutlay=o=>usablePayment(o)&&bankPaymentClass(o)==='commercial_candidate';
function latestLosses(db,caseId){return db.prepare('SELECT a.* FROM case_loss_versions a WHERE a.case_id=? AND a.version=(SELECT MAX(b.version) FROM case_loss_versions b WHERE b.case_id=a.case_id AND b.scope_key=a.scope_key) ORDER BY a.created_at,a.id').all(caseId).map(r=>({id:r.id,version:r.version,createdAt:r.created_at,...parse(r.snapshot_json)}));}
function evidenceProblems(db,caseId,sources){return sources.filter(s=>{const d=db.prepare('SELECT d.sha256 FROM documents d JOIN case_documents c ON c.document_id=d.id WHERE c.case_id=? AND d.id=?').get(caseId,s.documentId);return !d||d.sha256!==s.sha256||db.prepare('SELECT 1 FROM case_document_exclusions WHERE case_id=? AND document_id=?').get(caseId,s.documentId);}).map(s=>'Источник недоступен или исключён: '+s.name);}

export function workflowWorkspace(db,caseId,c={}){
 migrateCaseWorkflow(db);const parent=scope(db,caseId,c),a=caseAnalysis(db,caseId,{all:true,skipChains:true},c),byId=new Map(a.operations.map(o=>[o.id,o]));
 const participants=db.prepare('SELECT p.id,COALESCE(n.name,p.name) name,p.identifier,p.kind,c.role FROM participants p JOIN case_participants c ON c.participant_id=p.id LEFT JOIN case_party_names n ON n.case_id=c.case_id AND n.participant_id=p.id WHERE c.case_id=? ORDER BY name,c.role').all(caseId);
 const losses=latestLosses(db,caseId).map(l=>{const problems=evidenceProblems(db,caseId,l.sources);for(const o of l.operations||[])if(!usablePayment(byId.get(o.id))||byId.get(o.id).fingerprint!==o.fingerprint)problems.push('Платёж изменён, исключён или не подтверждён');return {...l,problems,usable:l.status==='confirmed'&&!problems.length};});
 const returns=db.prepare('SELECT r.*,x.currency,x.note,x.status,x.operation_id,x.operation_fingerprint,x.source_json,x.version FROM reimbursements r LEFT JOIN case_return_details x ON x.id=r.id WHERE r.case_id=? ORDER BY r.occurred_at DESC,r.id').all(caseId).map(r=>{
  const sources=r.source_json?parse(r.source_json):[],problems=evidenceProblems(db,caseId,sources);
  if(!r.currency)problems.push('В старой записи валюта не установлена');
  if(r.operation_id&&(!usablePayment(byId.get(r.operation_id))||byId.get(r.operation_id).fingerprint!==r.operation_fingerprint))problems.push('Связанный платёж изменён или не подтверждён');
  return {id:r.id,victimId:r.victim_participant_id,episodeId:r.episode_id,kind:r.kind,amountMinor:String(r.amount_minor),currency:r.currency||'UNKNOWN',date:r.occurred_at,status:r.status||'pending',note:r.note||'',version:r.version||0,operationId:r.operation_id||'',sources,problems,usable:r.status==='confirmed'&&!problems.length};
 });
 const assets=db.prepare('SELECT a.*,x.currency,x.note,x.victim_id,x.version,x.valuation_known FROM assets a LEFT JOIN case_asset_details x ON x.id=a.id WHERE a.case_id=? ORDER BY a.created_at DESC').all(caseId).map(a=>({id:a.id,name:a.name,status:a.status,episodeId:a.episode_id,victimId:a.victim_id||'',amountMinor:a.valuation_known===1?String(a.estimated_value_minor):null,currency:a.currency||'UNKNOWN',note:a.note||'',documentId:a.document_id,version:a.version||0}));
 const materialEvents=db.prepare('SELECT * FROM case_material_events WHERE case_id=? ORDER BY date DESC,id').all(caseId).map(e=>{const details=parse(e.details_json);return {id:e.id,episodeId:e.episode_id,kind:e.kind,date:e.date,senderId:e.sender_id,recipientId:e.recipient_id,status:e.status,note:e.note,version:e.version,...details,problems:evidenceProblems(db,caseId,[details.source])};});
 const balances=new Map();
 const get=(victimId,episodeId,cur)=>{const key=JSON.stringify([victimId,episodeId||'',cur]);if(!balances.has(key))balances.set(key,{victimId,episodeId:episodeId||null,currency:cur,originalMinor:0n,returnedMinor:0n,lossIds:[],returnIds:[]});return balances.get(key);};
 for(const l of losses.filter(l=>l.usable)){const b=get(l.victimId,l.episodeId,l.currency);b.originalMinor+=BigInt(l.originalMinor);b.lossIds.push(l.id);}
 for(const r of returns.filter(r=>r.usable)){const b=get(r.victimId,r.episodeId,r.currency);b.returnedMinor+=BigInt(r.amountMinor);b.returnIds.push(r.id);}
 const values=[...balances.values()].map(b=>({...b,originalMinor:b.lossIds.length?String(b.originalMinor):null,returnedMinor:String(b.returnedMinor),remainingMinor:b.lossIds.length?String(b.originalMinor>b.returnedMinor?b.originalMinor-b.returnedMinor:0n):null,excessMinor:b.lossIds.length?String(b.returnedMinor>b.originalMinor?b.returnedMinor-b.originalMinor:0n):null}));
 const totals=new Map();for(const b of values){let t=totals.get(b.currency)||{currency:b.currency,originalMinor:0n,returnedMinor:0n,remainingMinor:0n,unallocatedReturnsMinor:0n,calculationCount:0};if(b.originalMinor!==null){t.originalMinor+=BigInt(b.originalMinor);t.calculationCount++;}t.returnedMinor+=BigInt(b.returnedMinor);if(b.remainingMinor!==null)t.remainingMinor+=BigInt(b.remainingMinor);else t.unallocatedReturnsMinor+=BigInt(b.returnedMinor);totals.set(b.currency,t);}
 const missing=[];for(const d of a.documents.filter(d=>!d.excluded&&(d.error||!['extracted','confirmed'].includes(d.status))))missing.push({category:'processing',documentId:d.id,name:d.name,reason:d.error?'Ошибка обработки':'Распознаны не все необходимые реквизиты'});
 if(!participants.some(p=>p.role==='victim'))missing.push({category:'case',reason:'Потерпевшие не зарегистрированы'});
 for(const l of losses.filter(l=>!l.usable))missing.push({category:'calculation',id:l.id,reason:l.problems.join('; ')||'Расчёт не подтверждён сотрудником'});
 for(const r of returns.filter(r=>!r.usable))missing.push({category:'return',id:r.id,reason:r.problems.join('; ')||'Возврат не подтверждён сотрудником'});
 for(const e of materialEvents.filter(e=>e.status!=='confirmed'||e.problems.length))missing.push({category:'material_event',id:e.id,reason:e.problems.join('; ')||'Передача имущества / исполнение обязательства не подтверждены сотрудником'});
 for(const a of assets.filter(a=>a.amountMinor===null))missing.push({category:'valuation',id:a.id,reason:'Оценка имущества не установлена: '+a.name});
 return {caseId,caseNumber:parent.caseNumber,participants,episodes:db.prepare('SELECT id,title FROM episodes WHERE case_id=? ORDER BY created_at').all(caseId),documents:a.documents.filter(d=>!d.excluded).map(d=>({id:d.id,name:d.name})),
  operations:a.operations.filter(usableOutlay).slice(0,500),operationTotal:a.operations.filter(usableOutlay).length,operationChoices:a.operations.slice(0,500).map(o=>({id:o.id,number:o.number,type:o.type,date:o.date,episodeId:o.episodeId})),losses,returns,assets,balances:values,totals:[...totals.values()].map(t=>Object.fromEntries(Object.entries(t).map(([k,v])=>[k,['originalMinor','remainingMinor'].includes(k)&&!t.calculationCount?null:typeof v==='bigint'?String(v):v]))),missing,
  materialEvents,assignments:db.prepare('SELECT operation_id operationId,episode_id episodeId,version FROM case_operation_episode WHERE case_id=?').all(caseId),
  warning:'Предварительный расчёт по выбранным документам и решениям сотрудника, не заключение эксперта. Арест и изъятие имущества не являются возмещением. Валюты не суммируются между собой.'};
}

export function saveWorkflow(db,caseId,input,c={}){
 migrateCaseWorkflow(db);scope(db,caseId,c,true);
 if(!input||typeof input!=='object')fail('Некорректный запрос');
 return tx(db,()=>{
  scope(db,caseId,c,true);const reason=note(input.note),action=String(input.action||'');
  if(action==='participant'){
   const name=text(input.name,500),identifier=text(input.identifier||'',12),role=String(input.role||'');
   if(!name||identifier&&(!/^\d{12}$/.test(identifier)||/^0+$/.test(identifier))||!['participant','victim'].includes(role))fail('Укажите имя, допустимый БИН/ИИН (если известен) и роль');
   let p=identifier?db.prepare('SELECT * FROM participants WHERE department_id=? AND identifier=? ORDER BY created_at,id LIMIT 1').get(c.departmentId||DEFAULT_DEPARTMENT_ID,identifier):db.prepare("SELECT p.* FROM participants p JOIN case_participants x ON x.participant_id=p.id WHERE x.case_id=? AND p.identifier='' AND p.name=? LIMIT 1").get(caseId,name);
   if(!identifier&&!p&&db.prepare("SELECT 1 FROM participants WHERE department_id=? AND identifier='' AND name=? AND kind=?").get(c.departmentId||DEFAULT_DEPARTMENT_ID,name,role==='victim'?'victim':'counterparty'))fail('Есть одноимённая запись без БИН/ИИН. Уточните ФИО/наименование; одинаковое имя не доказывает, что это один участник');
   if(!p){const id=randomUUID();db.prepare("INSERT INTO participants(id,department_id,kind,identifier,name,attributes_json,created_at) VALUES(?,?,?,?,?,'{}',?)").run(id,c.departmentId||DEFAULT_DEPARTMENT_ID,role==='victim'?'victim':'counterparty',identifier,name,new Date().toISOString());p={id,name,identifier};}
   db.prepare('INSERT OR IGNORE INTO case_participants VALUES(?,?,?)').run(caseId,p.id,role);
   db.prepare('INSERT INTO case_party_names VALUES(?,?,?) ON CONFLICT(case_id,participant_id) DO UPDATE SET name=excluded.name').run(caseId,p.id,name);p={...p,name};
   decision(db,caseId,'participant:'+p.id+':'+role,role==='victim'?'Регистрация потерпевшего':'Регистрация участника','confirmed',reason,[],c,null,[{name:p.name,identifier:p.identifier}]);return {id:p.id};
  }
  if(action==='material_event'){
   const ep=episode(db,caseId,input.episodeId),sender=party(db,caseId,input.senderId),recipient=party(db,caseId,input.recipientId),src=source(db,caseId,input.source),date=iso(input.date),kind=String(input.kind||''),description=text(input.description,2000),status=String(input.status||'pending');
   if(sender.id===recipient.id||!['property_transfer','performance'].includes(kind)||!states.has(status)||!description)fail('Укажите вид, разных участников, описание и статус события');
   const amount=input.amountMinor===null||input.amountMinor===undefined?null:String(minor(input.amountMinor)),cur=amount===null?null:currency(input.currency);
   const details={description,amountMinor:amount,currency:cur,source:src};
   if(db.prepare("SELECT 1 FROM case_material_events WHERE case_id=? AND details_json=? AND kind=? AND sender_id=? AND recipient_id=? AND date=? AND status<>'rejected'").get(caseId,JSON.stringify(details),kind,sender.id,recipient.id,date))fail('Это документальное событие уже зарегистрировано');
   const id=randomUUID();db.prepare('INSERT INTO case_material_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,caseId,ep,kind,date,sender.id,recipient.id,JSON.stringify(details),status,reason,1,actor(c),new Date().toISOString());
   decision(db,caseId,'event:'+id,kind==='performance'?'Проверка исполнения обязательства':'Проверка передачи имущества',status,reason,[src],c,null,[{name:sender.name,identifier:sender.identifier},{name:recipient.name,identifier:recipient.identifier}]);return {id,version:1};
  }
  if(action==='event_review'){
   const old=db.prepare('SELECT * FROM case_material_events WHERE case_id=? AND id=?').get(caseId,input.id);if(!old)fail('Событие не найдено в деле');if(input.expectedVersion!==old.version)fail('Решение изменено: обновите данные',409);
   const status=String(input.status||'');if(!states.has(status))fail('Некорректный статус');const src=source(db,caseId,parse(old.details_json).source);
   db.prepare('UPDATE case_material_events SET status=?,note=?,version=version+1 WHERE id=?').run(status,reason,old.id);
   decision(db,caseId,'event:'+old.id,'Проверка документального события',status,reason,[src],c,{status:old.status,note:old.note});return {id:old.id,version:old.version+1};
  }
  if(action==='assign_episode'){
   const op=operations(db,caseId,c).find(o=>o.id===input.operationId);if(!op)fail('Операция не относится к делу');const ep=episode(db,caseId,input.episodeId);
   const old=db.prepare('SELECT * FROM case_operation_episode WHERE operation_id=?').get(op.id);if(input.expectedVersion!==(old?.version||0))fail('Привязка изменена: обновите данные',409);
   db.prepare('INSERT INTO case_operation_episode VALUES(?,?,?,?,?) ON CONFLICT(operation_id) DO UPDATE SET episode_id=excluded.episode_id,note=excluded.note,version=excluded.version').run(op.id,caseId,ep,reason,(old?.version||0)+1);
   db.prepare('UPDATE operations SET episode_id=? WHERE id=? AND case_id=?').run(ep,op.id,caseId);
   decision(db,caseId,'episode:'+op.id,'Привязка операции к эпизоду','confirmed',reason,op.sources,c,old?{status:'confirmed',note:old.note}:null);return {id:op.id};
  }
  if(action==='loss'){
   const victim=party(db,caseId,input.victimId,true),ep=episode(db,caseId,input.episodeId),cur=currency(input.currency),status=String(input.status||'pending');if(!states.has(status))fail('Некорректный статус проверки');
   const method=String(input.method||'');if(!['documented_amount','payments_less_fulfilment'].includes(method))fail('Выберите методику расчёта');
   const selection=input.documentCostSelection,ids=input.operationIds||[];
   if(!Array.isArray(ids)||ids.length>500||ids.some(id=>typeof id!=='string')||new Set(ids).size!==ids.length)fail('Выберите не более 500 различных платежей');
   let documentCosts=null;const sources=[];
   if(selection!==undefined){
    const actIds=selection?.actIds;
    if(method!=='documented_amount'||typeof selection?.plannedId!=='string'||!Array.isArray(actIds)||!actIds.length||actIds.length>100||actIds.some(id=>typeof id!=='string')||new Set(actIds).size!==actIds.length)fail('Выберите документ с общей стоимостью и различные акты исполнения');
    const choices=workCostSources(db,caseId,c.departmentId),base=choices.find(d=>d.role==='planned'&&d.id===selection.plannedId),acts=actIds.map(id=>choices.find(d=>d.role==='actual'&&d.id===id));
    if(!base||acts.some(d=>!d))fail('Один из документов недоступен или не подходит для расчёта. Обновите страницу.',409);
    const comparison=compareWorkCosts(base,acts);if(comparison.error)fail(comparison.error);
    if(comparison.currency!==cur||comparison.plannedMinor!==input.grossMinor||comparison.actualMinor!==input.fulfilledMinor)fail('Суммы или валюта в документах изменились. Обновите страницу и сверьте расчёт.',409);
    documentCosts=[base,...acts].map(d=>({...source(db,caseId,{documentId:d.id}),role:d.role,minor:d.minor,facts:d.facts}));
    sources.push(...documentCosts);
   }else sources.push(source(db,caseId,input.source));
   const all=ids.length?operations(db,caseId,c):[],selected=ids.map(id=>all.find(o=>o.id===id));let gross;
   if(method==='payments_less_fulfilment'){
    if(!selected.length||selected.some(o=>!usableOutlay(o)||o.currency!==cur||!victim.identifier||o.senderId!==victim.identifier||o.episodeId&&o.episodeId!==ep))fail('Нужны подтверждённые коммерческие платежи потерпевшего в одной валюте и выбранном эпизоде; займы, налоги, внутренние переводы, конвертация и комиссии не используются');
    gross=selected.reduce((n,o)=>n+BigInt(o.amountMinor),0n);for(const o of selected)for(const s of o.sources)sources.push(source(db,caseId,s));
   }else{if(ids.length)fail('При документальной сумме не выбирайте платежи повторно');gross=minor(input.grossMinor);}
   const fulfilled=minor(input.fulfilledMinor);if(fulfilled>gross)fail('Стоимость исполнения превышает исходную сумму: нужна другая методика, а не отрицательный ущерб');
   if(fulfilled>0n&&!documentCosts)sources.push(source(db,caseId,input.fulfilmentSource));
   const key=JSON.stringify([victim.id,ep,cur]),old=latestLosses(db,caseId).find(l=>l.scopeKey===key);
   if(input.expectedVersion!==(old?.version||0))fail('Расчёт изменён: обновите данные',409);
   if(status!=='rejected'&&latestLosses(db,caseId).some(l=>l.scopeKey!==key&&l.status!=='rejected'&&l.victimId===victim.id&&l.currency===cur&&(!l.episodeId||!ep)))fail('Расчёт по всему делу пересекается с расчётом по эпизоду того же потерпевшего. Сначала отклоните заменяемый расчёт');
   for(const l of latestLosses(db,caseId).filter(l=>l.scopeKey!==key&&l.status!=='rejected'))if(selected.some(o=>l.operations.some(p=>p.id===o.id)))fail('Платёж уже включён в расчёт другого потерпевшего/эпизода');
   for(const r of db.prepare("SELECT x.operation_id FROM case_return_details x JOIN reimbursements r ON r.id=x.id WHERE r.case_id=? AND x.status<>'rejected'").all(caseId))if(ids.includes(r.operation_id))fail('Платёж уже учтён как возврат');
   const snapshot={scopeKey:key,victimId:victim.id,victimName:victim.name,episodeId:ep,currency:cur,method,methodVersion:'documented-loss-1.0',grossMinor:String(gross),fulfilledMinor:String(fulfilled),originalMinor:String(gross-fulfilled),formula:'Исходная сумма − документированная стоимость исполнения; возвраты учитываются отдельно',status,note:reason,sources:[...new Map(sources.map(s=>[JSON.stringify([s.documentId,s.sheet,s.row,s.page]),s])).values()],operations:selected.map(o=>({id:o.id,fingerprint:o.fingerprint,amountMinor:String(o.amountMinor),currency:o.currency})),warning:'Расчёт не устанавливает состав правонарушения и не заменяет методику специалиста; нулевое исполнение — явно введённое утверждение сотрудника.'};
   snapshot.inputSha256=hash(snapshot);const id=randomUUID(),version=(old?.version||0)+1;
   db.prepare('INSERT INTO case_loss_versions VALUES(?,?,?,?,?,?,?)').run(id,caseId,key,version,JSON.stringify(snapshot),new Date().toISOString(),actor(c));
   decision(db,caseId,'loss:'+key,'Расчёт по потерпевшему: '+victim.name,status,reason+'\nИсходная сумма: '+snapshot.grossMinor+'; исполнение: '+snapshot.fulfilledMinor+'; разница: '+snapshot.originalMinor+' (минимальные единицы '+cur+').',snapshot.sources,c,old?{status:old.status,note:old.note+'\nПредыдущая разница: '+old.originalMinor+' (минимальные единицы '+old.currency+').'}:null,[{name:victim.name,identifier:victim.identifier}],!!old);return {id,version};
  }
  if(action==='return'){
   const victim=party(db,caseId,input.victimId,true),ep=episode(db,caseId,input.episodeId),cur=currency(input.currency),src=source(db,caseId,input.source),date=iso(input.date),amount=minor(input.amountMinor),kind=String(input.kind||''),status=String(input.status||'pending');
   if(!['money','returned_property','recovered_property'].includes(kind)||!states.has(status)||amount<=0n)fail('Выберите вид возврата, положительную сумму и статус');
   const old=input.id?db.prepare('SELECT r.*,x.* FROM reimbursements r JOIN case_return_details x ON x.id=r.id WHERE r.case_id=? AND r.id=?').get(caseId,input.id):null;
   if(input.id&&!old)fail('Возврат не найден в деле');if(input.expectedVersion!==(old?.version||0))fail('Запись возврата изменена: обновите данные',409);
   if(old&&(old.victim_participant_id!==victim.id||old.episode_id!==ep||old.currency!==cur||old.amount_minor!==Number(amount)||old.kind!==kind||old.occurred_at!==date||old.document_id!==src.documentId||old.operation_id!==String(input.operationId||'')))fail('Реквизиты сохранённого возврата неизменяемы: отклоните запись с обоснованием и создайте новую');
   let op=null;if(input.operationId){op=operations(db,caseId,c).find(o=>o.id===input.operationId);if(kind!=='money'||!usablePayment(op)||op.currency!==cur||String(op.amountMinor)!==String(amount)||op.recipientId!==victim.identifier)fail('Платёж возврата должен быть подтверждён и зачислен потерпевшему на указанную сумму');
    if(db.prepare("SELECT r.id FROM reimbursements r JOIN case_return_details x ON x.id=r.id WHERE r.case_id=? AND x.operation_id=? AND x.status<>'rejected' AND r.id<>?").get(caseId,op.id,old?.id||''))fail('Этот платёж возврата уже учтён');
    if(latestLosses(db,caseId).some(l=>l.status!=='rejected'&&l.operations.some(o=>o.id===op.id)))fail('Этот платёж уже включён в исходную сумму расчёта');
   }
   if(!old&&db.prepare("SELECT r.id FROM reimbursements r JOIN case_return_details x ON x.id=r.id WHERE r.case_id=? AND r.victim_participant_id=? AND COALESCE(r.episode_id,'')=? AND r.document_id=? AND r.amount_minor=? AND r.occurred_at=? AND x.currency=? AND r.kind=? AND x.source_json=? AND x.status<>'rejected'").get(caseId,victim.id,ep||'',src.documentId,Number(amount),date,cur,kind,JSON.stringify([src])))fail('Такой возврат по этой исходной строке уже зарегистрирован');
   const id=old?.id||randomUUID(),version=(old?.version||0)+1;
   if(old)db.prepare('UPDATE reimbursements SET confirmed=? WHERE id=? AND case_id=?').run(status==='confirmed'?1:0,id,caseId);
   else db.prepare('INSERT INTO reimbursements VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,caseId,ep,victim.id,kind,Number(amount),date,src.documentId,status==='confirmed'?1:0,new Date().toISOString());
   db.prepare('INSERT INTO case_return_details VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,note=excluded.note,version=excluded.version').run(id,cur,reason,status,op?.id||'',op?.fingerprint||'',JSON.stringify([src]),version);
   decision(db,caseId,'return:'+id,'Проверка фактического возврата: '+victim.name,status,reason,[src],c,old?{status:old.status,note:old.note}:null,[{name:victim.name,identifier:victim.identifier}]);return {id,version};
  }
  if(action==='asset'){
   const ep=episode(db,caseId,input.episodeId),cur=currency(input.currency),src=source(db,caseId,input.source),name=text(input.name,500),known=input.valuationKnown!==false,amount=known?minor(input.amountMinor):0n,status=String(input.status||'');
   if(!name||!['arrested','seized','undetermined'].includes(status))fail('Укажите имущество и его процессуальный статус. Фактический возврат регистрируется отдельно');
   const id=randomUUID();db.prepare('INSERT INTO assets VALUES(?,?,?,?,?,?,?,?)').run(id,caseId,ep,name,status,Number(amount),src.documentId,new Date().toISOString());
   db.prepare("INSERT INTO case_asset_details(id,currency,note,victim_id,version,valuation_known) VALUES(?,?,?,?,1,?)").run(id,cur,reason,'',known?1:0);decision(db,caseId,'asset:'+id,'Учёт имущества: '+name,'pending',reason,[src],c);return {id};
  }
  fail('Неизвестное действие реестра');
 });
}
