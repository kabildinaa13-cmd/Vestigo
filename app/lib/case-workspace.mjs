import {getCase,DEFAULT_DEPARTMENT_ID} from "./vestigo-db.mjs";

const normalize=text=>String(text||"").normalize("NFKC").toLocaleLowerCase("ru").replace(/ё/g,"е");
function scope(db,caseId,context={}){const parent=getCase(db,caseId,context.departmentId||DEFAULT_DEPARTMENT_ID);if(!parent)throw new Error("Дело не найдено");return parent;}
export function migrateCaseSearch(db){
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS case_text_search USING fts5(case_id UNINDEXED,document_id UNINDEXED,page UNINDEXED,sheet UNINDEXED,row_number UNINDEXED,original UNINDEXED,search_text,tokenize='unicode61');`);
}
export function indexCaseDocument(db,caseId,documentId,result){
  migrateCaseSearch(db);
  db.prepare("DELETE FROM case_text_search WHERE case_id=? AND document_id=?").run(caseId,documentId);
  const insert=db.prepare("INSERT INTO case_text_search VALUES(?,?,?,?,?,?,?)");
  function add(text,page=0,sheet="",row=0){if(!String(text||"").trim())return;const value=String(text);insert.run(caseId,documentId,page,sheet,row,value,normalize(value)+"\n"+normalize(value.replace(/(?<=\d)[ \u00a0\u202f](?=\d)/g,"")));}
  if(result.pages?.length){for(const page of result.pages)add(page.text,page.page);}
  else if(result.sourceTables?.length){for(const table of result.sourceTables)for(const row of table.rows)add(row.values.join(" | "),0,String(table.sheet||""),Number(row.row)||0);}
  else if(result.rows?.length){for(const row of result.rows)add(Object.values(row.raw||{}).join(" | "),0,String(row.sheet||""),Number(row.row)||0);}
  else{const text=String(result.text||"");for(let offset=0;offset<text.length;offset+=8000)add(text.slice(offset,offset+8000),0,"Текст",offset/8000+1);}
}
export function searchCaseText(db,caseId,query,{offset=0,limit=30}={},context={}){
  scope(db,caseId,context);migrateCaseSearch(db);
  const terms=normalize(String(query||"").slice(0,250)).match(/[\p{L}\p{N}]+/gu)?.slice(0,12)||[];
  if(!terms.length)return {total:0,results:[],offset:0,limit};
  const expression=terms.map(term=>`"${term}"*`).join(" AND ");
  const from=`FROM case_text_search s JOIN documents d ON d.id=s.document_id JOIN case_documents cd ON cd.case_id=s.case_id AND cd.document_id=s.document_id WHERE case_text_search MATCH ? AND s.case_id=? AND NOT EXISTS(SELECT 1 FROM case_document_exclusions x WHERE x.case_id=s.case_id AND x.document_id=s.document_id)`;
  const total=db.prepare(`SELECT COUNT(*) n ${from}`).get(expression,caseId).n;
  const rows=db.prepare(`SELECT s.document_id AS documentId,d.original_name AS name,s.page,s.sheet,s.row_number AS row,s.original,bm25(case_text_search) rank ${from} ORDER BY rank,s.document_id,s.page,s.row_number LIMIT ? OFFSET ?`).all(expression,caseId,Math.min(100,Math.max(1,limit)),Math.max(0,offset));
  return {total,offset,limit,results:rows.map(({original,...row})=>{const folded=normalize(original);const at=terms.map(term=>folded.indexOf(term)).filter(n=>n>=0).sort((a,b)=>a-b)[0]||0;const start=Math.max(0,at-100);return {...row,excerpt:(start?"…":"")+original.slice(start,start+500)+(original.length>start+500?"…":"")};})};
}

export function caseWorkspaceOverview(db,caseId,{offset=0}={},context={}){
  const parent=scope(db,caseId,context);
  const documents=db.prepare(`SELECT d.id,d.original_name AS name,COALESCE(e.status,'uploaded') status,e.summary_json FROM case_documents c JOIN documents d ON d.id=c.document_id LEFT JOIN case_extractions e ON e.case_id=c.case_id AND e.document_id=c.document_id WHERE c.case_id=? AND d.media_type<>'application/zip' AND NOT EXISTS(SELECT 1 FROM case_document_exclusions x WHERE x.case_id=c.case_id AND x.document_id=c.document_id)`).all(caseId).map(d=>({...d,summary:JSON.parse(d.summary_json||"{}"),summary_json:undefined}));
  const count=(sql,...params)=>db.prepare(sql).get(...params).n;
  const operations=count("SELECT COUNT(*) n FROM operations WHERE case_id=?",caseId);
  const links=count("SELECT COUNT(*) n FROM case_operation_matches WHERE case_id=?",caseId);
  const documentLinks=count(`SELECT COUNT(*) n FROM (SELECT json_extract(x.details_json,'$.senderId'),json_extract(x.details_json,'$.recipientId'),o.currency FROM operations o JOIN case_operation_details x ON x.operation_id=o.id WHERE o.case_id=? AND o.operation_type='invoice' AND x.review_status<>'rejected' AND NOT json_extract(x.details_json,'$.conflict') AND o.currency<>'UNKNOWN' GROUP BY json_extract(x.details_json,'$.senderId'),json_extract(x.details_json,'$.recipientId'),o.currency)`,caseId);
  const unmatched=count("SELECT COUNT(*) n FROM operations o WHERE o.case_id=? AND NOT EXISTS(SELECT 1 FROM case_operation_matches m WHERE m.case_id=o.case_id AND (m.left_id=o.id OR m.right_id=o.id))",caseId);
  const timeline=db.prepare(`SELECT o.id,o.operation_type AS type,o.occurred_at AS date,o.amount_minor AS amountMinor,o.currency,o.confirmed,x.review_status AS reviewStatus,x.details_json FROM operations o JOIN case_operation_details x ON x.operation_id=o.id WHERE o.case_id=? ORDER BY o.occurred_at,o.id LIMIT 30 OFFSET ?`).all(caseId,Math.max(0,offset)).map(({details_json,...row})=>({...row,...JSON.parse(details_json)}));
  const unreadPages=documents.flatMap(d=>(d.summary.pageAudit?.pagesWithoutText||[]).map(page=>({documentId:d.id,name:d.name,page})));
  const incomplete=documents.flatMap(d=>(d.summary.documentAnalysis?.segments||[]).filter(s=>!s.approved&&!s.automatic?.eligible&&["bank","contract","primary"].includes(s.groupId)).map(s=>({documentId:d.id,name:d.name,page:s.from,missing:s.automatic?.missing||[],conflicts:s.automatic?.conflicts||[]}))).filter(s=>s.missing.length||s.conflicts.length);
  return {caseId,caseNumber:parent.caseNumber,documents:documents.length,readDocuments:documents.filter(d=>!["uploaded","running","failed"].includes(d.status)).length,operations,links,documentLinks,unmatched,automaticSegments:documents.reduce((sum,d)=>sum+(d.summary.documentAnalysis?.automaticallyExtracted||0),0),unresolvedSegments:documents.reduce((sum,d)=>sum+(d.summary.documentAnalysis?.unresolved||0),0),incomplete:incomplete.slice(0,20),unreadPages,timeline,offset,limit:30,total:operations,
    explanation:operations?`Документальных связей поставщик → покупатель по ЭСФ: ${documentLinks}. Сопоставлений разных документов (например, ЭСФ и платежа): ${links}. Это разные показатели. Документальная поставка не означает банковский перевод.`:"Операции пока не выделены. Смотрите прочитанный текст и отсутствующие реквизиты; сохранение файла само по себе не создаёт операцию."};
}
