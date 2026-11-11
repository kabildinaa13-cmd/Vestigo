import {currentUserId} from "./request-identity.mjs";
import {randomUUID,createHash} from "node:crypto";
import {getCase,DEFAULT_DEPARTMENT_ID,DEFAULT_USER_ID} from "./vestigo-db.mjs";
import {caseAnalysis} from "./case-analysis.mjs";
import {isBankFee,bankEntryKind} from "./bank-identities.mjs";
import {workflowWorkspace} from './case-workflow.mjs';
import {captureReportFindings} from './report-finding-evidence.mjs';

export function migrateCaseCalculations(db){db.exec(`
 CREATE TABLE IF NOT EXISTS case_calculation_versions(id TEXT PRIMARY KEY,case_id TEXT NOT NULL REFERENCES cases(id),version INTEGER NOT NULL,created_at TEXT NOT NULL,created_by TEXT NOT NULL REFERENCES users(id),snapshot_json TEXT NOT NULL,UNIQUE(case_id,version));
 CREATE TABLE IF NOT EXISTS case_report_versions(id TEXT PRIMARY KEY,case_id TEXT NOT NULL REFERENCES cases(id),version INTEGER NOT NULL,created_at TEXT NOT NULL,created_by TEXT NOT NULL REFERENCES users(id),snapshot_json TEXT NOT NULL,UNIQUE(case_id,version));
`);}
function scope(db,caseId,context={},write=false){const c=getCase(db,caseId,context.departmentId||DEFAULT_DEPARTMENT_ID);if(!c)throw new Error("Дело не найдено");if(write&&c.status==="archived")throw new Error("Дело находится в архиве");return c;}
function audit(db,caseId,action,id,context){db.prepare("INSERT INTO audit_log(id,department_id,user_id,action,entity_type,entity_id,details_json,created_at) VALUES(?,?,?,?, 'case',?,?,?)").run(randomUUID(),context.departmentId||DEFAULT_DEPARTMENT_ID,context.userId || currentUserId() || DEFAULT_USER_ID,action,caseId,JSON.stringify({id}),new Date().toISOString());}
export function calculationWorkspace(db,caseId,query={},context={}){
 migrateCaseCalculations(db);scope(db,caseId,context);
 const analysis=caseAnalysis(db,caseId,{all:true,skipChains:true},context);
 const operations=analysis.operations.filter(o=>!o.conflict&&o.reviewStatus!=="rejected"&&o.currency!=="UNKNOWN"&&!isBankFee(o)&&["invoice","payment","reimbursement"].includes(o.type)&&(!query.from||o.date>=query.from)&&(!query.to||o.date<=query.to)&&(!query.counterparty||[o.senderId,o.recipientId].includes(query.counterparty))&&(!query.episodeId||o.episodeId===query.episodeId));
 return {operations:operations.slice(0,500),total:operations.length,limit:500,versions:db.prepare("SELECT * FROM case_calculation_versions WHERE case_id=? ORDER BY version DESC LIMIT 100").all(caseId).map(v=>({id:v.id,version:v.version,createdAt:v.created_at,...JSON.parse(v.snapshot_json)})),episodes:db.prepare("SELECT id,title FROM episodes WHERE case_id=?").all(caseId),participants:analysis.participants};
}
export function createCalculation(db,caseId,input,context={}){
 migrateCaseCalculations(db);scope(db,caseId,context,true);
 const method=String(input.method||"payments_minus_invoices"),methods={payments_minus_invoices:{formula:"Σ платежей − Σ возвратов оплаты − Σ ЭСФ",positive:"payment",negative:"invoice"},payments_minus_reimbursements:{formula:"Σ платежей − Σ возвратов оплаты − Σ документов возврата",positive:"payment",negative:"reimbursement"}};
 if(!methods[method])throw new Error("Выберите поддерживаемую воспроизводимую формулу");
 const name=String(input.name||"").trim(),rationale=String(input.rationale||"").trim();if(!name||name.length>200||!rationale||rationale.length>4000)throw new Error("Укажите название расчёта и обоснование применимости методики");
 if(!Array.isArray(input.operationIds))throw new Error("Выберите операции расчёта");const ids=[...new Set(input.operationIds)];if(!ids.length||ids.length>500||ids.some(id=>typeof id!=="string"))throw new Error("Выберите от 1 до 500 операций без повторов");
 db.exec("BEGIN IMMEDIATE");try{
 const a=caseAnalysis(db,caseId,{all:true,skipChains:true},context),available=new Map(a.operations.map(o=>[o.id,o])),operations=ids.map(id=>available.get(id));
 if(operations.some(o=>!o||o.conflict||o.reviewStatus==="rejected"||o.currency==="UNKNOWN"||isBankFee(o)||![methods[method].positive,methods[method].negative].includes(o.type)))throw new Error("Выбрана чужая, конфликтующая, отклонённая или неподходящая операция");
 if(!operations.some(o=>o.type===methods[method].positive)||!operations.some(o=>o.type===methods[method].negative))throw new Error("Выберите обе стороны сравнения: платежи и ЭСФ либо документы возврата. Отсутствующий документ нельзя считать нулевой суммой.");
 const currencies=new Set(operations.map(o=>o.currency));if(currencies.size!==1)throw new Error("Один расчёт — одна валюта; разные валюты не складываются");
 const groups=new Map();
 const signed=o=>BigInt(o.amountMinor)*(o.type==="payment"&&bankEntryKind(o)==="refund"?-1n:1n);
 for(const o of operations){const key=[o.senderId,o.recipientId].sort().join(":"),g=groups.get(key)||{parties:[o.senderId,o.recipientId].sort(),positiveMinor:0n,negativeMinor:0n,operationIds:[]};g[o.type===methods[method].positive?"positiveMinor":"negativeMinor"]+=signed(o);g.operationIds.push(o.id);groups.set(key,g);}
 const sum=type=>operations.filter(o=>o.type===type).reduce((n,o)=>n+signed(o),0n),positive=sum(methods[method].positive),negative=sum(methods[method].negative);
 const snapshot={name,method,methodVersion:"case-calculation-1.0",rationale,classification:"preliminary_difference",status:"preliminary_review",formula:methods[method].formula,positiveMinor:String(positive),negativeMinor:String(negative),differenceMinor:String(positive-negative),currency:[...currencies][0],confirmedOperationCount:operations.filter(o=>o.confirmed).length,operationCount:operations.length,filters:input.filters||{},groups:[...groups.values()].map(g=>({...g,positiveMinor:String(g.positiveMinor),negativeMinor:String(g.negativeMinor),differenceMinor:String(g.positiveMinor-g.negativeMinor)})),operations,warning:"Предварительное арифметическое сравнение выбранных документов. Не установленный ущерб и не правовая квалификация. Методика расчёта ущерба и полномочия подтверждающего специалиста требуют отдельного согласования."};
 snapshot.inputSha256=createHash("sha256").update(JSON.stringify(operations)).digest("hex");
 const id=randomUUID(),version=db.prepare("SELECT COALESCE(MAX(version),0)+1 AS n FROM case_calculation_versions WHERE case_id=?").get(caseId).n,createdAt=new Date().toISOString();
 db.prepare("INSERT INTO case_calculation_versions VALUES(?,?,?,?,?,?)").run(id,caseId,version,createdAt,context.userId || currentUserId() || DEFAULT_USER_ID,JSON.stringify(snapshot));audit(db,caseId,"case.calculation_saved",id,context);db.exec("COMMIT");return {id,version,createdAt,...snapshot};
 }catch(error){db.exec("ROLLBACK");throw error;}
}
export function listCaseReports(db,caseId,context={}){migrateCaseCalculations(db);scope(db,caseId,context);return db.prepare("SELECT id,version,created_at FROM case_report_versions WHERE case_id=? ORDER BY version DESC LIMIT 100").all(caseId).map(v=>({id:v.id,version:v.version,createdAt:v.created_at}));}
export function createCaseReport(db,caseId,context={}){
 migrateCaseCalculations(db);const parent=scope(db,caseId,context,true);db.exec("BEGIN IMMEDIATE");try{
 const a=caseAnalysis(db,caseId,{all:true},context),calculations=db.prepare("SELECT id,version,created_at,snapshot_json FROM case_calculation_versions WHERE case_id=? ORDER BY version").all(caseId).map(c=>({id:c.id,version:c.version,createdAt:c.created_at,...JSON.parse(c.snapshot_json)}));
 const workflow=workflowWorkspace(db,caseId,context);
 const snapshot={case:{id:parent.id,caseNumber:parent.caseNumber,periodFrom:parent.periodFrom,periodTo:parent.periodTo,qualifications:parent.qualifications,description:parent.description},generatedAt:new Date().toISOString(),documents:a.documents.map(d=>({id:d.id,name:d.name,status:d.status,error:d.error,excluded:d.excluded,rows:d.summary.rows||0,facts:[...(d.summary.automaticFacts?.contextFacts||[]),...(d.summary.documentAnalysis?.segments||[]).flatMap(s=>(s.documentFacts||[]).map(f=>({...f,page:f.page||s.from})))]})),operations:a.operations,matches:a.matches,risks:captureReportFindings(db,caseId,a.risks,a.documents),findingEvidenceVersion:1,calculations,workflow,missingMaterials:workflow.missing,ruleVersion:a.ruleVersion,warning:"Аналитическая сводка загруженных материалов. Расхождения и сигналы не являются доказанным ущербом или заключением эксперта."};
 const id=randomUUID(),version=db.prepare("SELECT COALESCE(MAX(version),0)+1 AS n FROM case_report_versions WHERE case_id=?").get(caseId).n;
 db.prepare("INSERT INTO case_report_versions VALUES(?,?,?,?,?,?)").run(id,caseId,version,snapshot.generatedAt,context.userId || currentUserId() || DEFAULT_USER_ID,JSON.stringify(snapshot));audit(db,caseId,"case.report_snapshot_saved",id,context);db.exec("COMMIT");return {id,version,createdAt:snapshot.generatedAt};
 }catch(error){db.exec("ROLLBACK");throw error;}
}
export function getCaseReport(db,caseId,id,context={}){migrateCaseCalculations(db);scope(db,caseId,context);const r=db.prepare("SELECT * FROM case_report_versions WHERE case_id=? AND id=?").get(caseId,id);if(!r)throw new Error("Отчёт не найден в выбранном деле");return {id:r.id,version:r.version,...JSON.parse(r.snapshot_json)};}
