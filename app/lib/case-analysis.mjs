import {currentUserId} from "./request-identity.mjs";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { DEFAULT_DEPARTMENT_ID, DEFAULT_USER_ID, getCase } from "./vestigo-db.mjs";
import { documentOriginal, migrateDocuments,applyDocumentClassification } from "./documents.mjs";
import {documentType} from "./document-types.mjs";
import {matchCaseDocuments} from "./document-matching.mjs";
import {verifiedPartyEvidence} from './payment-party-evidence.mjs';
import {evaluateCaseRules,RULE_VERSION} from "./case-rules.mjs";
import {assertProcessingLease,completeProcessing} from "./processing-queue.mjs";
import {indexCaseDocument,migrateCaseSearch as indexCaseDocumentSchema} from "./case-workspace.mjs";
import {canonicalBankSourceRows,validIban,isBankFee,bankEntryKind,bankPaymentClass,invoicePaymentEligibility,paymentCapacityKey} from "./bank-identities.mjs";
import {resolveEsfRevisions} from "./esf-lifecycle.mjs";
import {reviewSubject} from "./review-history.mjs";
import {inspectInvoiceRepeats} from "./invoice-duplicates.mjs";
import {readingDiagnostic} from "./document-reading-status.mjs";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const norm = (value) => String(value || "").toLocaleLowerCase("ru").replace(/ё/g,"е").replace(/[^\p{L}\p{N}]/gu, "");
const CANCELLED = /^(REVOKED|CANCELLED|CANCELED|DELETED|ОТОЗВАН|АННУЛИРОВАН|ОТМЕНЕН)/;
const contextDepartment = (context) => context.departmentId || DEFAULT_DEPARTMENT_ID;

export function migrateCaseAnalysis(db) {
  migrateDocuments(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS case_document_exclusions (
      case_id TEXT NOT NULL REFERENCES cases(id),document_id TEXT NOT NULL REFERENCES documents(id),reason TEXT NOT NULL,
      excluded_at TEXT NOT NULL,PRIMARY KEY(case_id,document_id)
    );
    CREATE INDEX IF NOT EXISTS audit_case_decisions ON audit_log(department_id,entity_type,entity_id,action,created_at);
    CREATE TABLE IF NOT EXISTS case_extractions (
      case_id TEXT NOT NULL REFERENCES cases(id), document_id TEXT NOT NULL REFERENCES documents(id),
      status TEXT NOT NULL, updated_at TEXT NOT NULL, summary_json TEXT NOT NULL DEFAULT '{}',
      text_content TEXT NOT NULL DEFAULT '', pages_json TEXT NOT NULL DEFAULT '[]', options_json TEXT NOT NULL DEFAULT '{}',
      error TEXT NOT NULL DEFAULT '', PRIMARY KEY(case_id,document_id)
    );
    CREATE TABLE IF NOT EXISTS case_extracted_rows (
      case_id TEXT NOT NULL REFERENCES cases(id), document_id TEXT NOT NULL REFERENCES documents(id),
      sheet TEXT NOT NULL, row_number INTEGER NOT NULL, record_json TEXT NOT NULL,
      PRIMARY KEY(case_id,document_id,sheet,row_number)
    );
    CREATE INDEX IF NOT EXISTS extracted_rows_case ON case_extracted_rows(case_id,document_id);
    CREATE TABLE IF NOT EXISTS case_source_rows (
      case_id TEXT NOT NULL REFERENCES cases(id),document_id TEXT NOT NULL REFERENCES documents(id),
      sheet TEXT NOT NULL,sheet_number INTEGER NOT NULL,row_number INTEGER NOT NULL,values_json TEXT NOT NULL,columns_json TEXT NOT NULL,
      PRIMARY KEY(case_id,document_id,sheet,row_number)
    );
    CREATE TABLE IF NOT EXISTS case_matching_reviews (
      case_id TEXT NOT NULL REFERENCES cases(id),left_key TEXT NOT NULL,right_key TEXT NOT NULL,
      left_fingerprint TEXT NOT NULL,right_fingerprint TEXT NOT NULL,status TEXT NOT NULL,note TEXT NOT NULL,
      reviewed_by TEXT NOT NULL,reviewed_at TEXT NOT NULL,PRIMARY KEY(case_id,left_key,right_key)
    );
    CREATE TABLE IF NOT EXISTS case_operation_details (
      operation_id TEXT PRIMARY KEY REFERENCES operations(id) ON DELETE CASCADE,
      generated_key TEXT NOT NULL, fingerprint TEXT NOT NULL, details_json TEXT NOT NULL,
      review_status TEXT NOT NULL DEFAULT 'pending', review_note TEXT NOT NULL DEFAULT '', reviewed_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS case_operation_sources (
      operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
      document_id TEXT NOT NULL REFERENCES documents(id), sheet TEXT NOT NULL, row_number INTEGER NOT NULL,
      PRIMARY KEY(operation_id,document_id,sheet,row_number)
    );
    CREATE TABLE IF NOT EXISTS case_operation_matches (
      case_id TEXT NOT NULL REFERENCES cases(id), left_id TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
      right_id TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE, method TEXT NOT NULL, explanation TEXT NOT NULL,
      PRIMARY KEY(case_id,left_id,right_id)
    );
    CREATE TABLE IF NOT EXISTS case_risk_details (
      discrepancy_id TEXT PRIMARY KEY REFERENCES discrepancies(id) ON DELETE CASCADE,
      generated_key TEXT NOT NULL, fingerprint TEXT NOT NULL, severity TEXT NOT NULL,
      evidence_json TEXT NOT NULL, rule_text TEXT NOT NULL, review_note TEXT NOT NULL DEFAULT ''
    );
  `);
  const riskColumns=db.prepare("PRAGMA table_info(case_risk_details)").all();
  if(!riskColumns.some(c=>c.name==="metadata_json"))db.exec("ALTER TABLE case_risk_details ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'");
}

function scope(db, caseId, context = {}, writable = false) {
  const parent = getCase(db, caseId, contextDepartment(context));
  if (!parent) throw new Error("Дело не найдено");
  if (writable && parent.status === "archived") throw new Error("Дело находится в архиве");
  return parent;
}

function audit(db, caseId, action, details, context = {}) {
  db.prepare(`INSERT INTO audit_log(id,department_id,user_id,action,entity_type,entity_id,details_json,created_at)
    VALUES(?,?,?,?, 'case',?,?,?)`).run(randomUUID(),contextDepartment(context),context.userId || currentUserId() || DEFAULT_USER_ID,
      action,caseId,JSON.stringify(details),new Date().toISOString());
}

export async function extractOriginal(db, caseId, documentId, options = {}, context = {}) {
  scope(db,caseId,context,true);
  if(options.bankYear&&!/^(19|20|21)\d{2}$/.test(String(options.bankYear)))throw new Error('Подтвердите четырёхзначный год периода выписки (1900–2199)');
  if(options.ownerId&&(!/^\d{12}$/.test(options.ownerId)||options.ownerId==='000000000000'))throw new Error("Укажите действительный БИН/ИИН владельца из 12 цифр; нулевой идентификатор недопустим");
  if(options.direction&&!["purchase","sale"].includes(options.direction))throw new Error("Некорректное направление выгрузки");
  if(options.ownerAccount&&!validIban(options.ownerAccount))throw new Error("Укажите корректный IBAN владельца счёта");
  if(options.bankFeeMode&&!["unknown","separate","debit_includes_fee","credit_after_fee"].includes(options.bankFeeMode))throw new Error("Некорректный способ учета банковской комиссии");
  if(options.defaultCurrency&&!/^[A-Z]{3}$/.test(options.defaultCurrency))throw new Error("Укажите трёхбуквенный код валюты, например KZT");
  if(options.documentFields&&(!options.manualConfirmed||typeof options.documentFields!=="object"||Array.isArray(options.documentFields)||Object.keys(options.documentFields).length>20||Object.values(options.documentFields).some(v=>typeof v!=="string"||v.length>2000)))throw new Error("Подтвердите сверку реквизитов с оригиналом и проверьте введённые поля");
  if(options.mapping&&(typeof options.mapping!=="object"||Array.isArray(options.mapping)||Object.keys(options.mapping).length>100||Object.values(options.mapping).some(v=>typeof v!=="string"||v.length>1000)))throw new Error("Некорректная настройка столбцов");
  if(options.tableSettings&&(!Array.isArray(options.tableSettings)||options.tableSettings.length>200||options.tableSettings.some(t=>!t||typeof t!=="object"||Array.isArray(t)||Object.keys(t).some(k=>!["sheet","headerRow","headerDepth","endRow","mapping","dateOrder"].includes(k))||typeof t.sheet!=="string"||t.sheet.length>300||!Number.isSafeInteger(t.headerRow)||t.headerRow<1||t.headerRow>100030||t.headerDepth!==undefined&&![1,2,3].includes(t.headerDepth)||t.dateOrder!==undefined&&!["","DMY","MDY","YMD"].includes(t.dateOrder)||t.endRow!==undefined&&(!Number.isSafeInteger(t.endRow)||t.endRow<t.headerRow||t.endRow>100030)||t.mapping&&(typeof t.mapping!=="object"||Array.isArray(t.mapping)||Object.keys(t.mapping).length>100||Object.values(t.mapping).some(v=>typeof v!=="string"||v.length>1000)))))throw new Error("Некорректные границы или соответствие полей отдельной таблицы");
  const original = documentOriginal(db,documentId,caseId,{...context,purpose:"analysis"});
  const databaseFile = db.prepare("PRAGMA database_list").all().find((item)=>item.name==="main").file;
  const stored = db.prepare("SELECT stored_name FROM documents WHERE id=?").get(documentId);
  const filename = path.join(path.dirname(databaseFile),"uploads",path.basename(stored.stored_name));
  const metadata = db.prepare("SELECT group_code,type_code FROM case_document_metadata WHERE case_id=? AND document_id=?").get(caseId,documentId);
  const root = process.cwd();
  const localPython = path.join(root,".venv",process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const python = process.env.VESTIGO_PYTHON || (fs.existsSync(localPython) ? localPython : "python");
  const override=options.classificationOverride;
  if(override&&!documentType(override.groupId,override.typeId))throw new Error("Некорректный вид документа");
  const settings = { ...options, groupId: override?.groupId || metadata?.group_code || "", typeId: override?.typeId || metadata?.type_code || "" };
  delete settings.classificationOverride;
  delete settings.reuseReadPages;
  // Continuations reuse only this immutable original's server-saved pages, never text supplied by a browser.
  const savedPages=options.ocrContinuation>0?db.prepare("SELECT pages_json FROM case_extractions WHERE case_id=? AND document_id=?").get(caseId,documentId):null;
  const pythonSettings=savedPages?{...settings,reuseReadPages:JSON.parse(savedPages.pages_json)}:settings;
  const result = await new Promise((resolve,reject)=>{
    const child = spawn(python,[path.join(root,"scripts/extract_case_document.py"),filename,original.name],
      {cwd:root,windowsHide:true,stdio:["pipe","pipe","pipe"],env:{...process.env,PYTHONIOENCODING:"utf-8"}});
    const chunks=[]; let size=0, error="", stopped=false;
    const timer=setTimeout(()=>{stopped=true;child.kill();reject(new Error("Превышено время обработки (9 минут). Разделите файл; неполный импорт не выполнен."));},540000);
    child.stdout.on("data",chunk=>{
      size+=chunk.length;
      if(size>96*1024*1024){stopped=true;child.kill();clearTimeout(timer);reject(new Error("Результат превышает 96 МБ. Разделите документ; частичный импорт не выполнен."));}
      else chunks.push(chunk);
    });
    child.stderr.on("data",chunk=>{error=(error+chunk.toString("utf8")).slice(-6000);});
    child.on("error",reason=>{clearTimeout(timer);reject(reason);});
    child.on("close",code=>{
      clearTimeout(timer); if(stopped)return;
      if(code!==0)return reject(new Error(error.trim() || "Не удалось прочитать файл"));
      try {resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));}catch{reject(new Error("Некорректный ответ обработчика"));}
    });
    child.stdin.on("error",()=>{});
    child.stdin.end(JSON.stringify(pythonSettings));
  });
  return {result,settings,sha256:original.sha256};
}

function extractionQuality(result){
  if(!result.quality)return undefined;
  const rows=result.rows||[],contextRows=rows.filter(r=>r.type==='context').length;
  const eligibleRows=rows.filter(r=>r.type!=='context'&&r.senderId&&r.recipientId&&r.date&&Number.isSafeInteger(r.amountMinor)&&r.currency&&r.currency!=='UNKNOWN'&&!r.attributes?.extractionBlocked&&!r.attributes?.conflictingFields?.length).length;
  return {...result.quality,extractedRows:rows.length,contextRows,eligibleRows,reviewRows:rows.length-contextRows-eligibleRows};
}
export function storeExtraction(db,caseId,documentId,result,options={},context={}) {
  migrateCaseAnalysis(db); scope(db,caseId,context,true);
  if(!db.prepare("SELECT 1 FROM case_documents WHERE case_id=? AND document_id=?").get(caseId,documentId))throw new Error("Документ не относится к делу");
  if(!Array.isArray(result.rows) || result.rows.length>100000)throw new Error("Некорректный результат извлечения");
  // Create the index schema before the extraction transaction, then commit indexed text with its facts.
  indexCaseDocumentSchema(db);
  db.exec("BEGIN IMMEDIATE");
  try {
    if(options.processingLease){const j=assertProcessingLease(db,options.processingLease.id,options.processingLease.token);if(j.case_id!==caseId||j.document_id!==documentId)throw new Error("Задание не относится к документу");}
    if(options.classificationDecision)applyDocumentClassification(db,caseId,documentId,options.classificationDecision,context);
    const summary={version:result.version,status:result.status,bankStatementTables:result.bankStatementTables===true,tables:result.tables,warnings:result.warnings,automaticFacts:result.automaticFacts,
      sourceSnapshot:!!result.sourceTables?.length,rows:result.rows.length,unparsedRows:result.unparsedRows,quality:extractionQuality(result),textCharacters:result.text?.length||0,pages:result.pages?.length||0,pageAudit:result.pageAudit,documentAnalysis:result.documentAnalysis,formulaAudit:result.formulaAudit?{...result.formulaAudit,sourceFormulas:undefined}:undefined,documentProfile:result.documentProfile,manualSource:result.rows.some(r=>r.manualSource),contextOnly:result.contextOnly===true||(!result.documentAnalysis&&options.groupId==="correspondence"),classificationStatus:result.documentAnalysis?.reviewed===result.documentAnalysis?.total&&result.documentAnalysis?"segments_reviewed":options.groupId==="unclassified"?"unclassified":options.classificationDecision?.status};
    db.prepare(`INSERT INTO case_extractions(case_id,document_id,status,updated_at,summary_json,text_content,pages_json,options_json)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(case_id,document_id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at,
      summary_json=excluded.summary_json,text_content=excluded.text_content,pages_json=excluded.pages_json,options_json=excluded.options_json,error=''`)
      .run(caseId,documentId,result.status,new Date().toISOString(),JSON.stringify(summary),result.text||"",JSON.stringify(result.pages||[]),JSON.stringify(Object.fromEntries(Object.entries(options).filter(([key])=>!["processingLease","processingMessage"].includes(key)))));
    db.prepare("DELETE FROM case_extracted_rows WHERE case_id=? AND document_id=?").run(caseId,documentId);
    const insert=db.prepare("INSERT INTO case_extracted_rows VALUES(?,?,?,?,?)");
    for(const row of result.rows)insert.run(caseId,documentId,String(row.sheet),row.row,JSON.stringify(row));
    db.prepare("DELETE FROM case_source_rows WHERE case_id=? AND document_id=?").run(caseId,documentId);
    const sourceInsert=db.prepare("INSERT INTO case_source_rows VALUES(?,?,?,?,?,?,?)");
    const formulasByRow=new Map();
    for(const formula of result.formulaAudit?.sourceFormulas||[]){const key=JSON.stringify([formula.sheet,formula.row]);if(!formulasByRow.has(key))formulasByRow.set(key,[]);formulasByRow.get(key).push(formula);}
    let sourceCount=0;
    for(const table of result.sourceTables||[])for(const row of table.rows||[]){
      if(++sourceCount>100030||!Array.isArray(row.values)||row.values.length>500)throw new Error("Недопустимый размер исходной таблицы");
      sourceInsert.run(caseId,documentId,String(table.sheet),table.sheetNumber, row.row,JSON.stringify({values:row.values,formulas:formulasByRow.get(JSON.stringify([table.sheet,row.row]))||[]}),JSON.stringify(table.columns));
    }
    indexCaseDocument(db,caseId,documentId,result);
    rebuildCase(db,caseId,context);
    audit(db,caseId,"case.document_extracted",{documentId,...summary},context);
    if(options.processingLease)completeProcessing(db,options.processingLease.id,options.processingLease.token,{summary,classification:options.classificationDecision||null,message:options.processingMessage||"Документ обработан; проверьте извлечённые данные"});
    db.exec("COMMIT");
    return summary;
  }catch(error){db.exec("ROLLBACK");throw error;}
}

function participant(db,departmentId,identifier,name,caseId,role) {
  if(!identifier)return null;
  let existing=db.prepare("SELECT id,name FROM participants WHERE department_id=? AND identifier=? ORDER BY created_at,id LIMIT 1").get(departmentId,identifier);
  if(!existing){
    const id=randomUUID();
    db.prepare("INSERT INTO participants(id,department_id,kind,identifier,name,created_at) VALUES(?,?,'counterparty',?,?,?)")
      .run(id,departmentId,identifier,name || `БИН/ИИН ${identifier}`,new Date().toISOString());
    existing={id};
  }
  db.prepare("INSERT OR IGNORE INTO case_participants VALUES(?,?,?)").run(caseId,existing.id,role);
  return existing.id;
}

function referenceContains(text,number){
  if(!number || norm(number).length<2)return false;
  const escaped=String(number).replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`,"iu").test(text);
}

export function operationKey(row,item){
  const number=String(row.number||"").toLocaleLowerCase("ru").replace(/\s+/g,"");
  // A conversion ticket can label both debit and credit. Keep each documented
  // leg separate; equal numbers and amounts never establish an FX pair.
  if(row.bank&&bankPaymentClass(row)==='conversion')return 'extract:bank-conversion:v1:'+hash([item.document_id,row.sheet,row.row,row.bank.direction,row.date,row.currency]);
  // Both statement perspectives can describe the same bank event. A payment
  // number alone is not a global transaction ID: require the explicit ID and
  // both checksum-valid accounts before sharing a graph operation.
  const transactionId=String(row.bank?.transactionId||"").trim();
  const senderAccount=validIban(row.bank?.senderAccount),recipientAccount=validIban(row.bank?.recipientAccount);
  if(transactionId&&senderAccount&&recipientAccount)return "extract:bank-event:v1:"+hash([row.type,row.bank.kind||"transfer",transactionId,senderAccount,recipientAccount,row.senderId,row.recipientId,row.date,row.currency]);
  if(row.bank&&number)return "extract:bank:v1:"+hash([row.type,row.bank.kind||"transfer",row.bank.ownerAccount||row.bank.ownerId||"",row.senderId,row.recipientId,number,row.date,row.currency]);
  const registration=row.type==="invoice"&&(row.registrationNumber || /^ESF-/i.test(row.number||""));
  const identity=number?(registration?[row.type,row.senderId,number]:[row.type,row.senderId,row.recipientId,number,row.date]):[row.type,item.document_id,row.sheet,row.row];
  return `extract:v1:${hash(identity)}`;
}

function rebuildCase(db,caseId,context){
  const parent=scope(db,caseId,context,true), departmentId=contextDepartment(context);
  let sourceRows=db.prepare(`SELECT x.*, d.original_name,m.group_code FROM case_extracted_rows x
    JOIN documents d ON d.id=x.document_id LEFT JOIN case_document_metadata m ON m.case_id=x.case_id AND m.document_id=x.document_id
    WHERE x.case_id=? AND NOT EXISTS(SELECT 1 FROM case_document_exclusions z WHERE z.case_id=x.case_id AND z.document_id=x.document_id) ORDER BY x.document_id,x.sheet,x.row_number`).all(caseId);
  sourceRows=canonicalBankSourceRows(sourceRows);
  const groups=new Map(), risks=[],cancelledKeys=new Map(),incompleteInvoiceAmounts=new Map();
  const source=(row)=>({documentId:row.document_id,name:row.original_name,sheet:row.sheet,row:row.row_number});
  const revisions=resolveEsfRevisions(sourceRows.map(item=>{const row=JSON.parse(item.record_json);return {row,key:operationKey(row,item),source:source(item)};}));
  risks.push(...revisions.risks);
  const addRisk=(key,code,severity,description,evidence,rule,nextAction,calculation)=>risks.push({key,code,severity,description,evidence,rule,nextAction,calculation});
  for(const item of sourceRows){const row=JSON.parse(item.record_json);if(CANCELLED.test(row.status)&&row.number)cancelledKeys.set(operationKey(row,item),source(item));}
  for(const item of sourceRows){
    const row=JSON.parse(item.record_json);
    const evidence=source(item);
    if(!["invoice","payment","contract","primary","accounting","claim","reimbursement"].includes(row.type))continue;
    if(CANCELLED.test(row.status))continue;
    if(row.type==="invoice"&&row.number&&row.senderId&&row.recipientId&&row.date&&!Number.isSafeInteger(row.amountMinor)
      &&(row.amountBasis==="line"||row.attributes?.invalidInvoiceTotal||row.attributes?.extractionIssues?.some(x=>x.fields?.some(f=>f==="amount"||f==="lineAmount")))){
      const key=operationKey(row,item),incomplete=incompleteInvoiceAmounts.get(key)||[];
      incomplete.push({source:evidence,invalidTotal:row.amountBasis!=="line"});incompleteInvoiceAmounts.set(key,incomplete);
    }
    if(row.attributes?.extractionBlocked===true)continue;
    const complete=row.senderId && row.recipientId && row.date && Number.isSafeInteger(row.amountMinor) && row.currency;
    if(!complete)continue;
    // Without a document identifier, two equal amounts are not automatically one economic event.
    const key=operationKey(row,item);
    if(revisions.superseded.has(key))continue;
    if(!groups.has(key))groups.set(key,{key,rows:[],sources:[]});
    groups.get(key).rows.push(row); groups.get(key).sources.push(evidence);
  }
  const operations=[],activeIds=new Set();
  for(const group of groups.values()){
    const first=group.rows[0], documentAmounts=new Map();
    for(let i=0;i<group.rows.length;i++){
      const row=group.rows[i], documentId=group.sources[i].documentId;
      if(!documentAmounts.has(documentId))documentAmounts.set(documentId,{totals:new Set(),lines:new Map(),numbered:new Map(),ambiguousLines:false});
      const aggregate=documentAmounts.get(documentId);
      const lineNumber=String(row.lineNumber||"").trim();
      if(first.type==="invoice"&&lineNumber){
        const lineAmount=row.amountBasis==="line"?row.amountMinor:row.esf?.lineAmountMinor;
        const previous=aggregate.numbered.get(lineNumber);
        if(Number.isSafeInteger(lineAmount)){
          if(previous!==undefined&&previous!==lineAmount)aggregate.ambiguousLines=true;
          else aggregate.numbered.set(lineNumber,lineAmount);
        }
      }
      if(row.amountBasis==="line"){
        const key=lineNumber&&first.type==="invoice"?`line:${lineNumber}`:hash(row.raw);
        if(!lineNumber&&aggregate.lines.has(key))aggregate.ambiguousLines=true;
        if(!aggregate.lines.has(key))aggregate.lines.set(key,row.amountMinor);
      }
      else aggregate.totals.add(row.amountMinor);
    }
    const amounts=new Set();
    for(const aggregate of documentAmounts.values()){
      if(aggregate.totals.size)for(const amount of aggregate.totals)amounts.add(amount);
      else {
        const sum=[...aggregate.lines.values()].reduce((a,b)=>a+BigInt(b),0n);
        if(sum>BigInt(Number.MAX_SAFE_INTEGER)||sum<BigInt(Number.MIN_SAFE_INTEGER))throw new Error("Сумма выходит за предел точного представления. Импорт отменён.");
        amounts.add(Number(sum));
      }
    }
    const currencies=[...new Set(group.rows.map(r=>r.currency))];
    const dates=[...new Set(group.rows.map(r=>r.date))];
    const recipientVariants=[...new Set(group.rows.map(r=>r.recipientId))];
    const ambiguousLines=[...documentAmounts.values()].some(a=>a.ambiguousLines);
    const incompleteAmounts=(incompleteInvoiceAmounts.get(group.key)||[]).filter(x=>x.invalidTotal||!documentAmounts.get(x.source.documentId)?.totals.size);
    const cancelledSource=cancelledKeys.get(group.key);
    const bankViews=new Map();
    if(first.bank)for(const r of group.rows){const owner=r.bank?.ownerAccount||r.bank?.ownerId||"";if(!bankViews.has(owner))bankViews.set(owner,new Set());bankViews.get(owner).add(JSON.stringify([r.bank?.feeMinor,r.bank?.feeMode,r.bank?.direction,r.bank?.rawAmountMinor]));}
    // Sender fees and recipient credits legitimately differ; contradictory
    // versions of the SAME owner's statement remain conflicts.
    const bankConflict=[...bankViews.values()].some(variants=>variants.size>1);
    const conflict=amounts.size>1 || currencies.length>1 || dates.length>1 || recipientVariants.length>1 || ambiguousLines || incompleteAmounts.length>0 || !!cancelledSource || bankConflict || revisions.conflicting.has(group.key);
    if(cancelledSource)group.sources.push(cancelledSource);
    const amount=[...amounts][0];
    if(!Number.isSafeInteger(amount))throw new Error("Сумма выходит за предел точного представления. Импорт отменён.");
    const details={number:first.number,reference:[...new Set(group.rows.map(r=>r.reference).filter(Boolean))].join("; "),
      senderId:first.senderId,recipientId:first.recipientId,senderName:first.senderName,recipientName:first.recipientName,
      purpose:[...new Set(group.rows.map(r=>r.purpose).filter(Boolean))].join("; ").slice(0,16000),...(first.bank?{bank:first.bank}:{}),
      ...(first.type==="invoice"?{esf:{...first.esf,revision:revisions.states.get(group.key),goods:[...new Map(group.rows.map(r=>{const goods={lineNumber:r.lineNumber,name:r.esf?.goodsName||r.purpose||"",quantity:r.esf?.quantity||r.attributes?.quantity||"",unitPriceWithoutVatMinor:r.esf?.unitPriceWithoutVatMinor??null,lineAmountMinor:r.esf?.lineAmountMinor??null,contractRef:r.contractRef||""};return [hash(goods),goods];})).values()]}}:{}),
      conflict,amountVariants:[...amounts],currencyVariants:currencies,dateVariants:dates,recipientVariants,ambiguousLines,cancelledSource:!!cancelledSource,inferredOwner:group.rows.some(r=>r.inferredOwner),
      amountBasis:group.rows.some(r=>r.amountBasis==="document_total")?"document_total":"line_sum",manualSource:group.rows.some(r=>r.manualSource),automaticSource:group.rows.some(r=>r.automaticSource),fieldEvidence:group.rows.map(r=>r.attributes?.fieldEvidence||{}),sources:group.sources};
    const fingerprint=hash({details:{...details,sources:undefined,automaticSource:undefined,fieldEvidence:undefined},date:first.date,amount});
    const existing=db.prepare("SELECT o.id,x.fingerprint,x.review_status,x.review_note FROM operations o JOIN case_operation_details x ON x.operation_id=o.id WHERE o.case_id=? AND o.external_key=?").get(caseId,group.key);
    const id=existing?.id||randomUUID(),now=new Date().toISOString(); activeIds.add(id);
    const sender=participant(db,departmentId,first.senderId,first.senderName,caseId,"source_sender");
    const recipient=participant(db,departmentId,first.recipientId,first.recipientName,caseId,"source_recipient");
    const sourceDocuments=new Set(group.sources.map(s=>s.documentId));
    const episodeIds=[...new Map(db.prepare(`SELECT e.id,d.document_id FROM episodes e JOIN episode_documents d ON d.episode_id=e.id
      WHERE e.case_id=?`).all(caseId).filter(e=>sourceDocuments.has(e.document_id)).map(e=>[e.id,e])).values()];
    const manualEpisode=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='case_operation_episode'").get()?db.prepare('SELECT episode_id FROM case_operation_episode WHERE operation_id=? AND case_id=?').get(id,caseId):null;
    const episodeId=manualEpisode?manualEpisode.episode_id:episodeIds.length===1?episodeIds[0].id:null;
    const review=existing?.fingerprint===fingerprint?existing.review_status:"pending";
    db.prepare(`INSERT INTO operations(id,case_id,episode_id,operation_type,occurred_at,amount_minor,currency,sender_participant_id,
      recipient_participant_id,purpose,external_key,confidence,confirmed,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(case_id,external_key) DO UPDATE SET episode_id=excluded.episode_id,occurred_at=excluded.occurred_at,
      amount_minor=excluded.amount_minor,currency=excluded.currency,sender_participant_id=excluded.sender_participant_id,
      recipient_participant_id=excluded.recipient_participant_id,purpose=excluded.purpose,confirmed=excluded.confirmed`)
      .run(id,caseId,episodeId,first.type,first.date,amount,first.currency,sender,recipient,details.purpose,group.key,first.inferredOwner?0.8:1,review==="confirmed"&&!conflict?1:0,now);
    db.prepare(`INSERT INTO case_operation_details(operation_id,generated_key,fingerprint,details_json,review_status,review_note)
      VALUES(?,?,?,?,?,?) ON CONFLICT(operation_id) DO UPDATE SET fingerprint=excluded.fingerprint,details_json=excluded.details_json,
      review_status=excluded.review_status,review_note=excluded.review_note`)
      .run(id,group.key,fingerprint,JSON.stringify(details),review,existing?.fingerprint===fingerprint?existing.review_note:"");
    db.prepare("DELETE FROM case_operation_sources WHERE operation_id=?").run(id);
    db.prepare("DELETE FROM operation_documents WHERE operation_id=?").run(id);
    for(const s of group.sources){
      db.prepare("INSERT OR IGNORE INTO case_operation_sources VALUES(?,?,?,?)").run(id,s.documentId,s.sheet,s.row);
      db.prepare("INSERT OR IGNORE INTO operation_documents(operation_id,document_id,page_number,fragment) VALUES(?,?,0,?)")
        .run(id,s.documentId,`${s.sheet}: строка ${s.row}`);
    }
    const operation={id,key:group.key,fingerprint,type:first.type,date:first.date,amount,currency:first.currency,review,...details};
    operations.push(operation);
    if(conflict)addRisk(group.key,"CONFLICTING_DOCUMENT","high",`Неоднозначные данные документа «${first.number}». Итог требует проверки.`,[...group.sources,...incompleteAmounts.map(x=>x.source)],
      incompleteAmounts.length?"Нераспознанная сумма ЭСФ или товарной строки не позволяет включить частичный итог в оборот.":"Разные суммы, даты, валюты или получатели одной ЭСФ; противоречащие статусы либо неоднозначные товарные строки. Ни одна версия не признана правильной автоматически.");
    if(first.senderId===first.recipientId&&!(first.type==='payment'&&bankPaymentClass(first)==='conversion'))addRisk(`${group.key}:self`,"SELF_TRANSACTION","medium",`Одинаковый БИН/ИИН у обеих сторон документа «${first.number}».`,group.sources,"Сравнение идентификаторов сторон. Возможны внутренний перевод или ошибка реквизитов.");
  }
  for(const old of db.prepare("SELECT o.id FROM operations o JOIN case_operation_details d ON d.operation_id=o.id WHERE o.case_id=?").all(caseId)){
    if(!activeIds.has(old.id))db.prepare("DELETE FROM operations WHERE id=?").run(old.id);
  }
  db.prepare("DELETE FROM case_operation_matches WHERE case_id=?").run(caseId);
  const reviews=db.prepare("SELECT * FROM case_matching_reviews WHERE case_id=?").all(caseId);
  const decisions=reviews.flatMap(r=>{const left=operations.find(o=>o.key===r.left_key&&o.fingerprint===r.left_fingerprint),right=operations.find(o=>o.key===r.right_key&&o.fingerprint===r.right_fingerprint);return left&&right?[{leftId:left.id,rightId:right.id,status:r.status,note:r.note}]:[];});
  const matching=matchCaseDocuments(operations,sourceRows.map(item=>({row:JSON.parse(item.record_json),source:source(item)})),decisions,(i,p)=>verifiedPartyEvidence(db,caseId,i,p));
  risks.push(...matching.risks);
  for(const link of matching.links)db.prepare("INSERT OR REPLACE INTO case_operation_matches VALUES(?,?,?,?,?)").run(caseId,link.leftId,link.rightId,link.method,link.explanation);
  risks.push(...inspectInvoiceRepeats(sourceRows.map(item=>({row:JSON.parse(item.record_json),source:source(item)}))).risks);
  const extractions=db.prepare("SELECT e.document_id,e.status,e.summary_json FROM case_extractions e WHERE case_id=? AND status<>'running' AND NOT EXISTS(SELECT 1 FROM case_document_exclusions z WHERE z.case_id=e.case_id AND z.document_id=e.document_id)").all(caseId);
  for(const extraction of extractions){
    const summary=JSON.parse(extraction.summary_json),name=db.prepare("SELECT original_name FROM documents WHERE id=?").get(extraction.document_id).original_name;
    if(extraction.status==="needs_ocr"||(!summary.contextOnly&&(extraction.status==="needs_mapping"||summary.unparsedRows))){
      const diagnostic=readingDiagnostic({id:extraction.document_id,name,status:extraction.status,summary});
      if(diagnostic)addRisk(`quality:${extraction.document_id}`,"INCOMPLETE_EXTRACTION","info",diagnostic.title,diagnostic.evidence,diagnostic.rule,diagnostic.nextAction,{readingDiagnostic:diagnostic});
    }
  }
  const documentSet=db.prepare(`SELECT c.document_id AS id,d.original_name AS name,COALESCE(e.status,'uploaded') AS status,COALESCE(e.summary_json,'{}') AS summary_json,e.error FROM case_documents c JOIN documents d ON d.id=c.document_id LEFT JOIN case_extractions e ON e.case_id=c.case_id AND e.document_id=c.document_id WHERE c.case_id=? AND d.media_type<>'application/zip' AND NOT EXISTS(SELECT 1 FROM case_document_exclusions z WHERE z.case_id=c.case_id AND z.document_id=c.document_id)`).all(caseId).map(d=>({...d,summary:JSON.parse(d.summary_json)}));
  const existingLinks=db.prepare("SELECT left_id AS leftId,right_id AS rightId,method,explanation FROM case_operation_matches WHERE case_id=?").all(caseId);
  const extended=evaluateCaseRules({records:sourceRows.map(item=>({row:JSON.parse(item.record_json),source:source(item)})),operations,documents:documentSet,priorLinks:existingLinks});
  risks.push(...extended.risks);
  for(const link of extended.links)db.prepare("INSERT OR REPLACE INTO case_operation_matches VALUES(?,?,?,?,?)").run(caseId,link.leftId,link.rightId,link.method,link.explanation);
  const activeRiskIds=new Set(),now=new Date().toISOString();
  for(const risk of risks){
    const old=db.prepare("SELECT d.id,d.status,x.fingerprint,x.review_note FROM discrepancies d JOIN case_risk_details x ON x.discrepancy_id=d.id WHERE d.case_id=? AND x.generated_key=?").get(caseId,risk.key);
    const fingerprint=hash([risk.description,risk.evidence,risk.rule,risk.calculation]), id=old?.id||randomUUID();activeRiskIds.add(id);
    const status=old&&(old.fingerprint===fingerprint||old.review_note)?old.status:"detected";
    db.prepare(`INSERT INTO discrepancies(id,case_id,discrepancy_type,description,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET description=excluded.description,status=excluded.status,updated_at=excluded.updated_at`)
      .run(id,caseId,risk.code,risk.description,status,now,now);
    db.prepare(`INSERT INTO case_risk_details(discrepancy_id,generated_key,fingerprint,severity,evidence_json,rule_text)
      VALUES(?,?,?,?,?,?) ON CONFLICT(discrepancy_id) DO UPDATE SET fingerprint=excluded.fingerprint,severity=excluded.severity,evidence_json=excluded.evidence_json,rule_text=excluded.rule_text`)
      .run(id,risk.key,fingerprint,risk.severity,JSON.stringify(risk.evidence),risk.rule);
    db.prepare("UPDATE case_risk_details SET metadata_json=? WHERE discrepancy_id=?").run(JSON.stringify({kind:risk.kind||(["CONFLICTING_DOCUMENT","INCOMPLETE_EXTRACTION","NO_PAYMENT_MATCH","AMBIGUOUS_MATCH"].includes(risk.code)?"data_quality":risk.code==="PAYMENT_AMOUNT_DIFFERENCE"?"discrepancy":"signal"),nextAction:risk.nextAction||"Сверьте источники и зафиксируйте обоснование решения.",calculation:risk.calculation||{},ruleVersion:risk.version||"case-base-1.0",decisionStale:!!(old&&old.review_note&&old.fingerprint!==fingerprint)}),id);
  }
  for(const previous of db.prepare("SELECT d.id,d.status,x.review_note,x.metadata_json FROM discrepancies d JOIN case_risk_details x ON x.discrepancy_id=d.id WHERE d.case_id=?").all(caseId)){
    if(!activeRiskIds.has(previous.id)){
      // Retire obsolete automatic findings without rewriting employees' decisions or audit history.
      if(previous.status==='detected'&&!previous.review_note)db.prepare("UPDATE discrepancies SET status='closed',updated_at=? WHERE id=?").run(now,previous.id);
      db.prepare("UPDATE case_risk_details SET metadata_json=? WHERE discrepancy_id=?").run(JSON.stringify({...JSON.parse(previous.metadata_json||'{}'),retired:true,retiredReason:'Условие автоматического правила больше не выполняется; прежняя запись и решение сохранены.'}),previous.id);
    }
  }
  db.prepare("UPDATE cases SET updated_at=? WHERE id=?").run(now,parent.id);
}

export function getExtraction(db,caseId,documentId,query={},context={}){
  migrateCaseAnalysis(db);scope(db,caseId,context);
  const extraction=db.prepare("SELECT * FROM case_extractions WHERE case_id=? AND document_id=?").get(caseId,documentId);
  if(!extraction)throw new Error("Извлечение ещё не выполнялось");
  const limit=50,offset=Math.max(0,Number(query.offset)||0);
  const rows=(query.sourceRow?db.prepare("SELECT record_json FROM case_extracted_rows WHERE case_id=? AND document_id=? AND sheet=? AND row_number=?").all(caseId,documentId,String(query.sourceSheet||""),Number(query.sourceRow)):
    db.prepare("SELECT record_json FROM case_extracted_rows WHERE case_id=? AND document_id=? ORDER BY sheet,row_number LIMIT ? OFFSET ?")
    .all(caseId,documentId,limit,offset)).map(r=>JSON.parse(r.record_json));
  const summary=JSON.parse(extraction.summary_json),table=summary.tables?.find(t=>t.tableId===query.tableId),sourceRows=[];
  if(query.tableId&&!table)throw new Error("Таблица не найдена в этом документе");
  let sourceTotal=0;
  if(query.mode==="source"){
    const conditions=["case_id=?","document_id=?"],params=[caseId,documentId];
    if(table){conditions.push("sheet=?","row_number>=?","row_number<=?");params.push(table.sheet,table.headerRow,table.endRow);}
    sourceTotal=db.prepare(`SELECT COUNT(*) n FROM case_source_rows WHERE ${conditions.join(' AND ')}`).get(...params).n;
    for(const row of db.prepare(`SELECT sheet,row_number,values_json,columns_json FROM case_source_rows WHERE ${conditions.join(' AND ')} ORDER BY sheet_number,row_number LIMIT ? OFFSET ?`).all(...params,limit,offset)){const raw=JSON.parse(row.values_json);sourceRows.push({sheet:row.sheet,row:row.row_number,values:Array.isArray(raw)?raw:raw.values,formulas:raw.formulas||[],columns:JSON.parse(row.columns_json)});}
  }
  const operationsFormed=db.prepare("SELECT COUNT(DISTINCT s.operation_id) n FROM case_operation_sources s JOIN operations o ON o.id=s.operation_id WHERE o.case_id=? AND s.document_id=?").get(caseId,documentId).n;
  summary.quality={...(summary.quality||{version:'legacy',read:summary.rows!==undefined&&extraction.status!=='needs_ocr',examples:[],sheets:[],tables:[]}),operationsFormed};
  return {name:db.prepare("SELECT original_name FROM documents WHERE id=?").get(documentId).original_name,status:extraction.status,updatedAt:extraction.updated_at,error:extraction.error,summary,sourceRows,sourceTotal,
    options:JSON.parse(extraction.options_json),text:extraction.text_content.slice(0,200000),textTruncated:extraction.text_content.length>200000,
    rows,offset,limit};
}

export function caseAnalysis(db,caseId,query={},context={}){
  migrateCaseAnalysis(db);scope(db,caseId,context);
  const allOperations=db.prepare(`SELECT o.*,x.details_json,x.fingerprint,x.review_status,x.review_note FROM operations o
    JOIN case_operation_details x ON x.operation_id=o.id WHERE o.case_id=? ORDER BY occurred_at DESC,id`).all(caseId)
    .map(o=>({id:o.id,type:o.operation_type,date:o.occurred_at,amountMinor:o.amount_minor,currency:o.currency,
      episodeId:o.episode_id,fingerprint:o.fingerprint,confirmed:!!o.confirmed,reviewStatus:o.review_status,reviewNote:o.review_note,...JSON.parse(o.details_json)}));
  const q=norm(query.q),filter=String(query.type||"");
  const filtered=allOperations.filter(o=>(!filter||o.type===filter)&&(!q||norm(JSON.stringify(o)).includes(q)));
  const offset=Math.max(0,Number(query.offset)||0),limit=50;
  const risks=db.prepare(`SELECT d.*,x.severity,x.evidence_json,x.rule_text,x.review_note,x.metadata_json FROM discrepancies d
    JOIN case_risk_details x ON x.discrepancy_id=d.id WHERE d.case_id=? ORDER BY CASE x.severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,d.created_at DESC`).all(caseId)
    .map(r=>({id:r.id,code:r.discrepancy_type,description:r.description,status:r.status,severity:r.severity,evidence:JSON.parse(r.evidence_json),rule:r.rule_text,note:r.review_note,...JSON.parse(r.metadata_json)}));
  const totals={};
  for(const o of allOperations)if(!o.conflict&&o.reviewStatus!=="rejected"){
    const key=`${isBankFee(o)?o.bank?.kind||"fee":o.type}:${o.currency}`;if(totals[key]===null)continue;totals[key]=(totals[key]||0)+o.amountMinor;
    if(!Number.isSafeInteger(totals[key]))totals[key]=null;
  }
  const documents=db.prepare(`SELECT d.id,d.original_name AS name,COALESCE(e.status,'uploaded') AS status,e.updated_at AS updatedAt,COALESCE(e.summary_json,'{}') AS summary_json,e.error
    FROM case_documents c JOIN documents d ON d.id=c.document_id LEFT JOIN case_extractions e ON e.document_id=c.document_id AND e.case_id=c.case_id WHERE c.case_id=? AND d.media_type<>'application/zip'`).all(caseId).map(d=>({...d,excluded:!!db.prepare("SELECT 1 FROM case_document_exclusions WHERE case_id=? AND document_id=?").get(caseId,d.id),summary:JSON.parse(d.summary_json),summary_json:undefined}));
  const operationById=new Map(allOperations.map(o=>[o.id,o]));
  const matches=db.prepare("SELECT left_id AS leftId,right_id AS rightId,method,explanation FROM case_operation_matches WHERE case_id=?").all(caseId)
    .filter(m=>{const left=operationById.get(m.leftId),right=operationById.get(m.rightId);return left?.type!=="invoice"||right?.type!=="payment"||m.method==="refund_reference"&&bankEntryKind(right)==="refund"||invoicePaymentEligibility(left,right,verifiedPartyEvidence(db,caseId,left,right)).eligible;})
    .map(m=>({...m,leftSource:operationById.get(m.leftId)?.sources[0],rightSource:operationById.get(m.rightId)?.sources[0]}));
  const records=db.prepare(`SELECT r.*,d.original_name FROM case_extracted_rows r JOIN documents d ON d.id=r.document_id WHERE r.case_id=? AND NOT EXISTS(SELECT 1 FROM case_document_exclusions z WHERE z.case_id=r.case_id AND z.document_id=r.document_id)`).all(caseId).map(r=>({row:JSON.parse(r.record_json),source:{documentId:r.document_id,name:r.original_name,sheet:r.sheet,row:r.row_number}}));
  const extra=query.skipChains?{chains:[],ruleVersion:RULE_VERSION}:evaluateCaseRules({records,operations:allOperations.map(o=>({...o,amount:o.amountMinor,review:o.reviewStatus})),documents,priorLinks:matches,chainsOnly:true});
  const history=db.prepare("SELECT action,details_json,created_at FROM audit_log WHERE entity_type='case' AND entity_id=? AND action IN ('case.analysis_reviewed','case.document_extracted','case.document_scope_changed','case.analysis_rebuilt') ORDER BY created_at DESC LIMIT 100").all(caseId).map(h=>({action:h.action,details:JSON.parse(h.details_json),createdAt:h.created_at}));
  return {caseId,total:filtered.length,operationCount:allOperations.length,operations:query.all?filtered:filtered.slice(offset,offset+limit),offset,limit,totals,chains:extra.chains,ruleVersion:extra.ruleVersion,history,
    participants:[...new Map(allOperations.flatMap(o=>[{identifier:o.senderId,name:o.senderName},{identifier:o.recipientId,name:o.recipientName}]).map(p=>[p.identifier,p])).values()],
    risks,matches,documents,coverage:{hasPayments:allOperations.some(o=>o.type==="payment"),hasInvoices:allOperations.some(o=>o.type==="invoice")}};
}

export function rebuildCaseAnalysis(db,caseId,context={},transaction=true){
  migrateCaseAnalysis(db);scope(db,caseId,context,true);if(transaction)db.exec("BEGIN IMMEDIATE");
  try{rebuildCase(db,caseId,context);audit(db,caseId,"case.analysis_rebuilt",{ruleVersion:RULE_VERSION,note:"Пересчитаны связи и проверки по сохранённым извлечённым данным; оригиналы не перечитывались."},context);if(transaction)db.exec("COMMIT");}
  catch(error){if(transaction)db.exec("ROLLBACK");throw error;}
}

export function reviewCaseItem(db,caseId,input,context={}){
  migrateCaseAnalysis(db);scope(db,caseId,context,true);
  const note=String(input.note||"").trim();
  if(!note||note.length>4000)throw new Error("Укажите обоснование проверки (до 4000 символов)");
  db.exec("BEGIN IMMEDIATE");
  try{
    let review;
    if(input.kind==="document"){
      if(!["excluded","active"].includes(input.status))throw new Error("Недопустимый статус документа");
      if(!db.prepare("SELECT 1 FROM case_documents WHERE case_id=? AND document_id=?").get(caseId,input.id))throw new Error("Документ не относится к делу");
      if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='processing_jobs'").get()&&db.prepare("SELECT 1 FROM processing_jobs WHERE case_id=? AND document_id=? AND state IN ('queued','retry','running')").get(caseId,input.id))throw new Error('Дождитесь завершения обработки этого файла перед изменением состава материалов');
      if(input.status==="excluded")db.prepare("INSERT INTO case_document_exclusions VALUES(?,?,?,?) ON CONFLICT(case_id,document_id) DO UPDATE SET reason=excluded.reason,excluded_at=excluded.excluded_at").run(caseId,input.id,note,new Date().toISOString());
      else db.prepare("DELETE FROM case_document_exclusions WHERE case_id=? AND document_id=?").run(caseId,input.id);
      rebuildCase(db,caseId,context);audit(db,caseId,"case.document_scope_changed",{documentId:input.id,status:input.status,note},context);
    }else if(input.kind==="operation"){
      if(!["pending","confirmed","rejected"].includes(input.status))throw new Error("Недопустимый статус операции");
    const item=db.prepare("SELECT o.id,o.currency,x.details_json FROM operations o JOIN case_operation_details x ON x.operation_id=o.id WHERE o.id=? AND o.case_id=?").get(input.id,caseId);
      if(!item)throw new Error("Операция не найдена");
      if(input.status==="confirmed"&&JSON.parse(item.details_json).conflict)throw new Error("Сначала устраните расхождение реквизитов в источниках. Конфликтную операцию нельзя подтвердить.");
      if(input.status==="confirmed"&&item.currency==="UNKNOWN")throw new Error("Валюта не указана. Задайте столбец валюты или подтвердите валюту файла в настройках извлечения.");
      review=reviewSubject(db,caseId,{kind:"operation",id:input.id});
      db.prepare("UPDATE case_operation_details SET review_status=?,review_note=?,reviewed_at=? WHERE operation_id=?").run(input.status,note,new Date().toISOString(),item.id);
      db.prepare("UPDATE operations SET confirmed=? WHERE id=?").run(input.status==="confirmed"?1:0,item.id);
      rebuildCase(db,caseId,context);
    }else if(input.kind==="risk"){
      if(!["checking","confirmed","rejected","insufficient_data","closed"].includes(input.status))throw new Error("Недопустимый статус вопроса проверки");
      const item=db.prepare("SELECT d.id FROM discrepancies d JOIN case_risk_details x ON x.discrepancy_id=d.id WHERE d.id=? AND d.case_id=?").get(input.id,caseId);
      if(!item)throw new Error("Вопрос проверки не найден");
      review=reviewSubject(db,caseId,{kind:"risk",id:input.id});
      db.prepare("UPDATE discrepancies SET status=?,updated_at=? WHERE id=?").run(input.status,new Date().toISOString(),input.id);
      db.prepare("UPDATE case_risk_details SET review_note=? WHERE discrepancy_id=?").run(note,input.id);
    }else throw new Error("Неизвестный вид записи");
    audit(db,caseId,"case.analysis_reviewed",{kind:input.kind,id:input.id,status:input.status,note,...(review?{review}:{})},context);
    db.exec("COMMIT");
  }catch(error){db.exec("ROLLBACK");throw error;}
}

// Decisions refer to source-generated identities and fingerprints, not transient row positions.
export function reviewMatching(db,caseId,input,context={}){
  migrateCaseAnalysis(db);scope(db,caseId,context,true);
  const note=String(input.note||"").trim();
  if(!note||note.length>4000||!["confirmed","rejected","pending"].includes(input.status))throw new Error("Укажите решение и обоснование до 4000 символов");
  db.exec("BEGIN IMMEDIATE");
  try{
    const read=id=>db.prepare("SELECT o.id,o.operation_type type,o.occurred_at date,o.currency,o.amount_minor amountMinor,o.external_key,x.fingerprint,x.details_json,x.review_status FROM operations o JOIN case_operation_details x ON x.operation_id=o.id WHERE o.case_id=? AND o.id=?").get(caseId,String(id||""));
    const left=read(input.leftId),right=read(input.rightId);
    if(!left||!right||left.type!=="invoice"||right.type!=="payment")throw new Error("Выберите ЭСФ и платёж этого дела");
    const l=JSON.parse(left.details_json),r=JSON.parse(right.details_json);
    if(input.status==="confirmed"){
      const invoice={...l,...left,reviewStatus:left.review_status},payment={...r,...right,reviewStatus:right.review_status};
      const eligibility=invoicePaymentEligibility(invoice,payment,verifiedPartyEvidence(db,caseId,invoice,payment));
      if(!eligibility.eligible)throw new Error(eligibility.reason);
      const cohort=db.prepare("SELECT o.id,o.occurred_at date,o.currency,o.amount_minor amountMinor,o.external_key,x.details_json,x.fingerprint FROM operations o JOIN case_operation_details x ON x.operation_id=o.id WHERE o.case_id=? AND o.operation_type='payment' AND o.id<>?").all(caseId,right.id).filter(o=>paymentCapacityKey({...JSON.parse(o.details_json),...o})===paymentCapacityKey(payment));
      for(const other of cohort){
        const full=db.prepare("SELECT 1 FROM case_matching_reviews r JOIN operations i ON i.case_id=r.case_id AND i.external_key=r.left_key JOIN case_operation_details x ON x.operation_id=i.id WHERE r.case_id=? AND r.right_key=? AND r.right_fingerprint=? AND r.status='confirmed' AND x.fingerprint=r.left_fingerprint AND x.review_status<>'rejected'").get(caseId,other.external_key,other.fingerprint);
        const parts=db.prepare("SELECT 1 FROM sqlite_master WHERE name='case_payment_allocations'").get()&&db.prepare("SELECT 1 FROM case_payment_allocations r JOIN operations i ON i.case_id=r.case_id AND i.external_key=r.invoice_key JOIN case_operation_details x ON x.operation_id=i.id WHERE r.case_id=? AND r.payment_key=? AND r.payment_fingerprint=? AND r.status='confirmed' AND x.fingerprint=r.invoice_fingerprint AND x.review_status<>'rejected'").get(caseId,other.external_key,other.fingerprint);
        if(full||parts)throw new Error('Другое наблюдение того же банковского события уже распределено; сбросьте прежнее решение, чтобы не учитывать перевод дважды');
      }
      if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='case_payment_allocations'").get()){
        const allocated=db.prepare("SELECT 1 FROM case_payment_allocations a JOIN operations o ON o.case_id=a.case_id AND o.external_key=a.invoice_key JOIN case_operation_details x ON x.operation_id=o.id WHERE a.case_id=? AND a.payment_key=? AND a.payment_fingerprint=? AND a.status='confirmed' AND x.fingerprint=a.invoice_fingerprint AND x.review_status<>'rejected'").get(caseId,right.external_key,right.fingerprint);
        if(allocated)throw new Error("У платежа есть распределения в финансовой сверке. Сначала сбросьте их, чтобы не учитывать платёж повторно");
      }
      const others=db.prepare("SELECT * FROM case_matching_reviews WHERE case_id=? AND right_key=? AND left_key<>? AND status='confirmed'").all(caseId,right.external_key,left.external_key);
      if(others.some(d=>d.right_fingerprint===right.fingerprint&&db.prepare("SELECT 1 FROM operations o JOIN case_operation_details x ON x.operation_id=o.id WHERE o.case_id=? AND o.external_key=? AND x.fingerprint=?").get(caseId,d.left_key,d.left_fingerprint)))throw new Error("Платёж уже сопоставлен с другой ЭСФ. Сначала сбросьте прежнее решение");
    }
    const review=reviewSubject(db,caseId,{kind:"match",leftKey:left.external_key,rightKey:right.external_key});
    db.prepare(`INSERT INTO case_matching_reviews VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(case_id,left_key,right_key) DO UPDATE SET left_fingerprint=excluded.left_fingerprint,right_fingerprint=excluded.right_fingerprint,status=excluded.status,note=excluded.note,reviewed_by=excluded.reviewed_by,reviewed_at=excluded.reviewed_at`).run(caseId,left.external_key,right.external_key,left.fingerprint,right.fingerprint,input.status,note,context.userId||currentUserId()||DEFAULT_USER_ID,new Date().toISOString());
    rebuildCase(db,caseId,context);
    audit(db,caseId,"case.match_reviewed",{leftKey:left.external_key,rightKey:right.external_key,status:input.status,note,review},context);
    db.exec("COMMIT");return {ok:true};
  }catch(error){db.exec("ROLLBACK");throw error;}
}
