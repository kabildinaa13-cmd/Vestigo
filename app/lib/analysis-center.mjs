import {createHash} from "node:crypto";
import {caseAnalysis,migrateCaseAnalysis,reviewMatching,reviewCaseItem} from "./case-analysis.mjs";
import {getCase,DEFAULT_DEPARTMENT_ID} from "./vestigo-db.mjs";
import {isBankFee} from "./bank-identities.mjs";
import {reviewHistory,systemLog} from "./review-history.mjs";

export const CENTER_VERSION="analysis-center-1.0";
const json=(v,fallback={})=>{try{return JSON.parse(v||"");}catch{return fallback;}};
const norm=v=>String(v??"").normalize("NFKC").toLocaleLowerCase("ru").replace(/ё/g,"е");
const unique=v=>[...new Set(v.filter(Boolean))];
const srcKey=s=>[s.documentId,s.sheet||"",s.row||0].join(":");
const sources=v=>[...new Map(v.map(s=>[srcKey(s),s])).values()];
const offsetOf=q=>Math.max(0,Math.floor(Number(q.offset)||0));
const limitOf=q=>Math.max(1,Math.min(100,Math.floor(Number(q.limit)||30)));
function scoped(db,caseId,context){const parent=getCase(db,caseId,context.departmentId||DEFAULT_DEPARTMENT_ID);if(!parent)throw new Error("Дело не найдено");return parent;}
function records(db,caseId){return db.prepare(`SELECT r.*,d.original_name FROM case_extracted_rows r JOIN documents d ON d.id=r.document_id WHERE r.case_id=? AND NOT EXISTS(SELECT 1 FROM case_document_exclusions x WHERE x.case_id=r.case_id AND x.document_id=r.document_id) ORDER BY r.document_id,r.sheet,r.row_number`).all(caseId).map(r=>({value:json(r.record_json),source:{documentId:r.document_id,name:r.original_name,sheet:r.sheet,row:r.row_number,page:Number(r.sheet.match(/PDF(?: bank)? (\d+)/)?.[1]||0)}}));}
function addMoney(target,currency,minor){if(!Number.isSafeInteger(minor))return;target[currency]=(BigInt(target[currency]||0)+BigInt(minor)).toString();}
function balances(ops,id){const result={purchase:{},sale:{},bankIncoming:{},bankOutgoing:{},bankFees:{}};
  for(const o of ops){if(o.conflict||o.reviewStatus==="rejected")continue;
    if(o.type==="invoice"){if(o.recipientId===id)addMoney(result.purchase,o.currency,o.amountMinor);if(o.senderId===id)addMoney(result.sale,o.currency,o.amountMinor);}
    if(o.type==="payment"){
      if(isBankFee(o)){if(o.senderId===id||o.recipientId===id)addMoney(result.bankFees,o.currency,o.amountMinor);continue;}
      if(o.recipientId===id)addMoney(result.bankIncoming,o.currency,o.amountMinor);
      if(o.senderId===id)addMoney(result.bankOutgoing,o.currency,o.amountMinor);
    }
  }return result;
}
function operationShape(o){return {id:o.id,fingerprint:o.fingerprint,type:o.type,number:o.number,date:o.date,amountMinor:String(o.amountMinor),currency:o.currency,senderId:o.senderId,recipientId:o.recipientId,senderName:o.senderName,recipientName:o.recipientName,purpose:o.purpose,conflict:o.conflict,reviewStatus:o.reviewStatus,esf:o.esf,bank:o.bank,sources:o.sources};}
function enrichRisk(r,ops,rows){const evidence=sources(r.evidence||[]),keys=new Set(evidence.map(srcKey));
  const related=ops.filter(o=>(o.sources||[]).some(s=>keys.has(srcKey(s)))),recordRows=rows.filter(r=>keys.has(srcKey(r.source)));
  const parties=new Map();for(const o of [...related,...recordRows.map(r=>r.value)])for(const [id,name]of [[o.senderId,o.senderName],[o.recipientId,o.recipientName]])if(id)parties.set(id,{identifier:id,name:name||id});
  const code=r.code||"",category=r.kind==='data_quality'?"Качество данных":r.kind==='discrepancy'?"Финансовые расхождения":"Вопросы проверки";
  const explanations=r.kind==='discrepancy'?["Частичная оплата или иной период выписки","Возврат, аванс, зачёт или изменение условий договора"]:/DUPLICATE|REPEATED/.test(code)?["Повторная выгрузка","Повтор товарных строк одного документа"]:["Неполный комплект материалов","Неоднозначные реквизиты или разные версии документа"];
  return {...r,category,parties:[...parties.values()],evidence,operations:related.map(operationShape),confidence:code==="PAYMENT_AMOUNT_DIFFERENCE"?"Документальная ссылка и идентификаторы сторон; требует проверки полноты оплат":"Основание: "+r.rule,explanations,requiredDocuments:category==="Суммы не совпадают"?["Полная банковская выписка за сопоставимый период","ЭСФ, договор, дополнительные соглашения и документы возврата"]:[r.nextAction||"Уточняющие первичные документы"],fingerprint:createHash("sha256").update(JSON.stringify([r.code,r.description,r.calculation,evidence])).digest("hex")};
}

function dataset(db,caseId,context){const analysis=caseAnalysis(db,caseId,{all:true,skipChains:true},context),rows=records(db,caseId),ops=analysis.operations;
  const risks=analysis.risks.map(r=>enrichRisk(r,ops,rows));
  const entities=new Map();
  function entity(id){if(!/^\d{12}$/.test(id||""))return null;if(!entities.has(id))entities.set(id,{identifier:id,names:new Map(),roles:new Set(),sources:[],operations:[],suppliers:new Set(),buyers:new Set(),contracts:new Set()});return entities.get(id);}
  for(const {value:r,source}of rows){for(const [id,name,role]of [[r.senderId,r.senderName,r.type==="payment"?"Отправитель средств":"Поставщик / сторона 1"],[r.recipientId,r.recipientName,r.type==="payment"?"Получатель средств":"Покупатель / сторона 2"]]){const e=entity(id);if(!e)continue;if(name){if(!e.names.has(name))e.names.set(name,[]);e.names.get(name).push(source);}e.sources.push(source);e.roles.add(role);if(r.contractRef)e.contracts.add(r.contractRef);}}
  for(const o of ops)for(const [id,side]of [[o.senderId,"sender"],[o.recipientId,"recipient"]]){const e=entity(id);if(!e)continue;e.operations.push(o);e.sources.push(...o.sources);if(o.type==="contract"&&o.number)e.contracts.add(o.number);if(o.type==="invoice"&&!o.conflict&&o.reviewStatus!=="rejected"){if(side==="sender")e.buyers.add(o.recipientId);else e.suppliers.add(o.senderId);}}
  const counterparties=[...entities.values()].map(e=>{const related=risks.filter(r=>!["closed","rejected"].includes(r.status)&&r.parties.some(p=>p.identifier===e.identifier));const names=[...e.names].map(([name,s])=>({name,sources:sources(s)}));return {identifier:e.identifier,name:names[0]?.name||`БИН/ИИН ${e.identifier}`,names,roles:[...e.roles],sources:sources(e.sources),documentCount:new Set(e.sources.map(s=>s.documentId)).size,operationCount:e.operations.length,invoiceCount:e.operations.filter(o=>o.type==="invoice").length,contractRefs:[...e.contracts],suppliers:[...e.suppliers],buyers:[...e.buyers],linkCount:new Set(e.operations.filter(o=>!o.conflict&&o.reviewStatus!=="rejected").map(o=>o.senderId===e.identifier?o.recipientId:o.senderId)).size,questionCount:related.length,nameConflict:names.length>1,...balances(e.operations,e.identifier)};});
  return {analysis,rows,ops,risks,counterparties};
}
function checks(data){const {analysis:a,ops}=data,docs=a.documents.filter(d=>!d.excluded),errors=docs.filter(d=>d.status==="failed"||d.error),pending=docs.filter(d=>["uploaded","running"].includes(d.status)),partial=docs.filter(d=>d.status==="needs_ocr"||d.status==="needs_mapping"||d.summary.unparsedRows||d.summary.pageAudit?.pagesWithoutText?.length);
  const allRead=!!docs.length&&!errors.length&&!pending.length&&!partial.length;
  const byId=new Map(ops.map(o=>[o.id,o]));
  const compared=new Set(a.matches.filter(m=>["document_reference","shared_contract_reference","manual_confirmed"].includes(m.method)&&byId.get(m.leftId)?.type==="invoice"&&byId.get(m.rightId)?.type==="payment").map(m=>m.leftId));
  const definitions=[{id:"payment_amount",name:"ЭСФ и связанные оплаты",compared:compared.size,codes:["PAYMENT_AMOUNT_DIFFERENCE"],prerequisites:"Нужны ЭСФ и платежи с однозначным основанием; сумма сама по себе не доказывает соответствие."},{id:"duplicates",name:"Повторения строк ЭСФ",compared:data.rows.filter(r=>r.value.type==='invoice').length,codes:["REPEATED_INVOICE_ROWS"],prerequisites:"Сравниваются номера ЭСФ и позиций, стороны, даты и реквизиты товара. Разные номера с одинаковой суммой не являются дублями."}];
  return {allRead,errors:errors.length,pending:pending.length,partial:partial.length,rules:definitions.map(r=>{const found=data.risks.filter(i=>r.codes.includes(i.code)&&!["closed","rejected"].includes(i.status)).length;return {...r,findings:found,status:errors.length?"processing_error":!docs.some(d=>d.updatedAt)?"not_run":!r.compared||!allRead?"insufficient_data":found?"differences_found":"no_differences"};})};
}

export function analysisCenter(db,caseId,query={},context={}){
  if(query.view==="system_log")return systemLog();
  migrateCaseAnalysis(db);const parent=scoped(db,caseId,context);
  if(query.view==="history")return reviewHistory(db,caseId,query,context);
  const data=dataset(db,caseId,context),{analysis:a,rows,ops,risks,counterparties}=data;
  const fingerprint=createHash("sha256").update(JSON.stringify([a.documents.map(d=>[d.id,d.status,d.updatedAt,d.excluded,d.error]),ops.map(o=>[o.id,o.reviewStatus,o.amountMinor]),risks.map(r=>[r.id,r.status,r.fingerprint]),a.matches])).digest("hex");
  const view=query.view||"summary",q=norm(query.q),offset=offsetOf(query),limit=limitOf(query),page=list=>({total:list.length,offset,limit,items:list.slice(offset,offset+limit)});
  if(view==="counterparties"){let list=counterparties.filter(e=>!q||norm(JSON.stringify([e.identifier,e.names,e.roles])).includes(q));list.sort((l,r)=>query.sort==="questions"?r.questionCount-l.questionCount:l.name.localeCompare(r.name,"ru"));return {...page(list),fingerprint};}
  if(view==="counterparty"){
    const e=counterparties.find(e=>e.identifier===query.identifier);if(!e)throw new Error("Контрагент не найден в документах этого дела");
    const related=ops.filter(o=>o.senderId===e.identifier||o.recipientId===e.identifier);
    return {...e,operations:related.map(operationShape),timeline:related.slice().sort((l,r)=>l.date.localeCompare(r.date)).map(operationShape),risks:risks.filter(r=>r.parties.some(p=>p.identifier===e.identifier)),graphUrl:`/analytics?caseId=${encodeURIComponent(caseId)}&bin=${e.identifier}`,fingerprint};
  }
  if(view==="discrepancies")return {...page(risks.filter(r=>(query.closed==="1"||!r.retired&&!["closed","rejected"].includes(r.status))&&(!query.kind||r.kind===query.kind)&&(!q||norm(JSON.stringify(r)).includes(q)))),checks:checks(data),fingerprint};
  if(view==="review"){
    const issue=risks.find(r=>r.id===query.riskId);if(!issue)throw new Error("Расхождение не найдено в этом деле");
    const sourceData=issue.evidence.map(s=>{const extracted=db.prepare("SELECT record_json FROM case_extracted_rows WHERE case_id=? AND document_id=? AND sheet=? AND row_number=?").get(caseId,s.documentId,s.sheet||"",s.row||0);const extraction=db.prepare("SELECT pages_json,text_content FROM case_extractions WHERE case_id=? AND document_id=?").get(caseId,s.documentId);const row=extracted?json(extracted.record_json):null;const page=s.page||Number(String(s.sheet||"").match(/PDF(?: bank)? (\d+)/)?.[1]||0);return {...s,page,record:row,fields:row?.attributes?.fieldSources||{},fragment:(json(extraction?.pages_json,[]).find(p=>p.page===page)?.text||(!s.row?extraction?.text_content:"" )||"").slice(0,12000)};});
    return {issue,sources:sourceData,matchCandidates:ops.filter(o=>["invoice","payment"].includes(o.type)&&!o.conflict&&o.reviewStatus!=="rejected").map(operationShape),fingerprint};
  }
  if(view==="document")return documentCard(db,caseId,query,data,fingerprint);
  const liveDocs=a.documents.filter(d=>!d.excluded),counts={documents:liveDocs.length,processed:liveDocs.filter(d=>d.updatedAt&&!['failed','running'].includes(d.status)).length,counterparties:counterparties.length,esf:ops.filter(o=>o.type==="invoice").length,goodsRows:rows.filter(r=>r.value.type==="invoice").length,contracts:ops.filter(o=>o.type==="contract").length,contractReferences:new Set(rows.map(r=>r.value.contractRef).filter(Boolean)).size,bankOperations:ops.filter(o=>o.type==="payment"&&!isBankFee(o)).length,fees:ops.filter(isBankFee).length,operations:ops.length,discrepancies:risks.filter(r=>r.kind==="discrepancy"&&!["closed","rejected"].includes(r.status)).length,unconfirmed:ops.filter(o=>o.reviewStatus!=="confirmed").length,links:a.matches.length};
  const totals={supply:{},bankTransfers:{},bankFees:{}};for(const o of ops)if(!o.conflict&&o.reviewStatus!=="rejected"){if(o.type==="invoice")addMoney(totals.supply,o.currency,o.amountMinor);if(o.type==="payment")addMoney(isBankFee(o)?totals.bankFees:totals.bankTransfers,o.currency,o.amountMinor);}
  const reviews=db.prepare(`SELECT r.*,l.id AS leftId,p.id AS rightId,lx.fingerprint AS current_left,px.fingerprint AS current_right FROM case_matching_reviews r LEFT JOIN operations l ON l.case_id=r.case_id AND l.external_key=r.left_key LEFT JOIN operations p ON p.case_id=r.case_id AND p.external_key=r.right_key LEFT JOIN case_operation_details lx ON lx.operation_id=l.id LEFT JOIN case_operation_details px ON px.operation_id=p.id WHERE r.case_id=?`).all(caseId).map(r=>({...r,stale:r.left_fingerprint!==r.current_left||r.right_fingerprint!==r.current_right}));
  return {caseId,caseNumber:parent.caseNumber,version:CENTER_VERSION,fingerprint,counts,totals,checks:checks(data),documents:a.documents.map(d=>({...d,operations:ops.filter(o=>o.sources.some(s=>s.documentId===d.id)).length,readStatus:d.error||d.status==="failed"?"processing_error":!d.updatedAt?"not_run":d.status==="needs_ocr"||d.status==="needs_mapping"||d.summary.unparsedRows?"insufficient_data":"read"})),matches:a.matches,reviews,explanation:"Суммы поставок по ЭСФ, банковских переводов и отдельных комиссий рассчитываются раздельно, в каждой валюте. Неполные, отменённые и конфликтные строки доступны в карточках источников, но не подменяют пригодные операции."};
}

function documentCard(db,caseId,q,data,fingerprint){
  const d=data.analysis.documents.find(d=>d.id===q.documentId);if(!d)throw new Error("Документ не относится к делу");
  const extraction=db.prepare("SELECT * FROM case_extractions WHERE case_id=? AND document_id=?").get(caseId,d.id),all=db.prepare("SELECT * FROM case_extracted_rows WHERE case_id=? AND document_id=? ORDER BY sheet,row_number").all(caseId,d.id).map(r=>json(r.record_json));
  let list=all.filter(r=>(!q.sheet||r.sheet===q.sheet)&&(!q.type||r.type===q.type)&&(!q.q||norm(JSON.stringify(r)).includes(norm(q.q))));
  const direction=q.order==="desc"?-1:1,sort=["row","date","amountMinor","number","senderName","recipientName"].includes(q.sort)?q.sort:"row";
  list.sort((a,b)=>direction*(sort==="amountMinor"||sort==="row"?((a[sort]??-Infinity)-(b[sort]??-Infinity)):String(a[sort]??"").localeCompare(String(b[sort]??""),"ru")));
  const source=db.prepare("SELECT * FROM case_source_rows WHERE case_id=? AND document_id=? ORDER BY sheet_number,row_number").all(caseId,d.id).filter(r=>(!q.sheet||r.sheet===q.sheet)&&(!q.q||norm(r.values_json).includes(norm(q.q)))).map(r=>{const raw=json(r.values_json,[]);return {sheet:r.sheet,sheetNumber:r.sheet_number,row:r.row_number,values:Array.isArray(raw)?raw:raw.values,formulas:raw.formulas||[],columns:json(r.columns_json,[])};});
  const offset=offsetOf(q),limit=limitOf(q),pageNumber=Math.max(0,Number(q.page)||0),pages=json(extraction?.pages_json,[]).filter(p=>(!pageNumber||p.page===pageNumber)&&(!q.q||norm(p.text).includes(norm(q.q))));
  const reasons=all.filter(r=>!d.summary.contextOnly&&(!r.senderId||!r.recipientId||!r.date||!Number.isSafeInteger(r.amountMinor)||!r.currency||r.currency==="UNKNOWN")).map(r=>({sheet:r.sheet,row:r.row,missing:[...(!r.senderId?["БИН/ИИН отправителя"]:[]),...(!r.recipientId?["БИН/ИИН получателя"]:[]),...(!r.date?["Дата"]:[]),...(!Number.isSafeInteger(r.amountMinor)?["Сумма"]:[]),...(!r.currency||r.currency==="UNKNOWN"?["Валюта"]:[])]}));
  const snapshot=!!d.summary.sourceSnapshot;
  if(q.export==="json")return {caseId,document:d,originalUrl:`/api/documents/${d.id}?caseId=${encodeURIComponent(caseId)}`,sourceSnapshot:snapshot,rows:list,sourceRows:source,pages:json(extraction?.pages_json,[]),text:extraction?.text_content||"",coverage:d.summary,exportedAt:new Date().toISOString()};
  const sourceRows=q.mode==="source"?source.slice(offset,offset+limit):[];
  return {document:d,fingerprint,rows:q.mode==="source"?[]:list.slice(offset,offset+limit),total:q.mode==="pages"?pages.length:q.mode==="source"?source.length:list.length,offset,limit,sourceRows,sourceSnapshot:snapshot,sourceWarning:snapshot?"":"Файл прочитан предыдущей версией: сохранены нормализованные строки и их исходные поля. Для всех строк, включая преамбулу, повторите чтение оригинала.",pages:pages.slice(offset,offset+limit),pageCount:pages.length,text:(extraction?.text_content||"").slice(0,200000),textTruncated:(extraction?.text_content?.length||0)>200000,sheets:unique(all.map(r=>r.sheet)),operations:data.ops.filter(o=>o.sources.some(s=>s.documentId===d.id)).map(operationShape),counterparties:data.counterparties.filter(e=>e.sources.some(s=>s.documentId===d.id)),risks:data.risks.filter(r=>r.evidence.some(s=>s.documentId===d.id)),incomplete:{total:reasons.length,items:reasons.slice(offset,offset+limit)},matches:data.analysis.matches.filter(m=>data.ops.some(o=>(o.id===m.leftId||o.id===m.rightId)&&o.sources.some(s=>s.documentId===d.id)))};
}

export function centerReview(db,caseId,input,context={}){
  if(input.action==="match"){
    migrateCaseAnalysis(db);scoped(db,caseId,context);
    const current=id=>db.prepare("SELECT x.fingerprint FROM operations o JOIN case_operation_details x ON x.operation_id=o.id WHERE o.case_id=? AND o.id=?").get(caseId,String(id||""))?.fingerprint;
    if(!input.leftFingerprint||!input.rightFingerprint||current(input.leftId)!==input.leftFingerprint||current(input.rightId)!==input.rightFingerprint)throw new Error("Реквизиты операции изменились. Обновите карточку перед сопоставлением");
    return reviewMatching(db,caseId,input,context);
  }
  if(input.action!=="risk")throw new Error("Неизвестное действие");
  const result=analysisCenter(db,caseId,{view:"review",riskId:input.id},context);
  if(!input.fingerprint||input.fingerprint!==result.issue.fingerprint)throw new Error("Результат изменился. Обновите карточку перед подтверждением");
  reviewCaseItem(db,caseId,{...input,kind:"risk"},context);return {ok:true};
}

export function exportCenterCsv(card){
  const safe=value=>{let v=typeof value==="object"?JSON.stringify(value):String(value??"");if(/^[\s]*[=+\-@]/.test(v))v="'"+v;return '"'+v.replace(/"/g,'""')+'"';};
  const rows=card.rows||[],keys=unique(rows.flatMap(r=>Object.keys(r.raw||{})));
  return "\uFEFF"+[["Лист","Строка",...keys]].concat(rows.map(r=>[r.sheet,r.row,...keys.map(k=>r.raw?.[k]??"")])).map(r=>r.map(safe).join(";")).join("\r\n");
}
