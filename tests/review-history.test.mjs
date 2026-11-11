import test from "node:test";import assert from "node:assert/strict";import fs from "node:fs";import os from "node:os";import path from "node:path";import {randomUUID,createHash} from "node:crypto";
import {openDatabase,createCase,DEFAULT_DEPARTMENT_ID,DEFAULT_USER_ID} from "../app/lib/vestigo-db.mjs";
import {saveDocument} from "../app/lib/documents.mjs";
import {storeExtraction,caseAnalysis,reviewCaseItem,reviewMatching} from "../app/lib/case-analysis.mjs";
import {reviewHistory,systemLog} from "../app/lib/review-history.mjs";
import {analysisCenter} from "../app/lib/analysis-center.mjs";
const A="990000000001",B="990000000002";
function setup(){const directory=fs.mkdtempSync(path.join(os.tmpdir(),"vestigo-history-")),db=openDatabase({dataDirectory:directory}),a=createCase(db,{caseNumber:"HISTORY-A"}),b=createCase(db,{caseNumber:"HISTORY-B"}),userId=randomUUID();db.prepare("INSERT INTO users VALUES(?,?,?,?,?,1,?)").run(userId,DEFAULT_DEPARTMENT_ID,"test-officer","Айгуль Тестовая","investigator",new Date().toISOString());let n=0;
 const doc=name=>saveDocument(db,{caseId:a.id,name,bytes:Buffer.from("synthetic "+(++n)),groupId:"primary",typeId:"invoice"});
 const row=(patch={})=>({sheet:"Лист1",row:2,type:"invoice",senderId:A,recipientId:B,senderName:"ТОО Альфа",recipientName:"ТОО Бета",number:"ESF-HISTORY-1",date:"2026-10-01",currency:"KZT",amountMinor:10000,amountBasis:"document_total",status:"CREATED",raw:{number:"ESF-HISTORY-1"},...patch});
 const extract=rows=>({version:1,status:"extracted",rows,tables:[],text:"",warnings:[],pages:[],unparsedRows:0});
 const i=doc("invoice.csv"),p=doc("bank.csv");storeExtraction(db,a.id,i.id,extract([row()]));storeExtraction(db,a.id,p.id,extract([row({type:"payment",senderId:B,recipientId:A,number:"PAY-HISTORY",purpose:"Оплата ESF-HISTORY-1",amountMinor:6000})]));
 const risk=caseAnalysis(db,a.id).risks.find(r=>r.code==="PAYMENT_AMOUNT_DIFFERENCE");assert.ok(risk);
 const review=(status,note)=>reviewCaseItem(db,a.id,{kind:"risk",id:risk.id,status,note},{userId});
 const audit=(action,details,{caseId=a.id,user=DEFAULT_USER_ID,date="2026-10-21T21:30:00.000Z"}={})=>{const id=randomUUID();db.prepare("INSERT INTO audit_log VALUES(?,?,?,?,?,?,?,?)").run(id,DEFAULT_DEPARTMENT_ID,user,action,"case",caseId,typeof details==="string"?details:JSON.stringify(details),date);return id;};
 return {db,a,b,userId,i,p,risk,review,audit,close:()=>{db.close();fs.rmSync(directory,{recursive:true,force:true});}};
}
const auditHash=db=>createHash("sha256").update(JSON.stringify(db.prepare("SELECT * FROM audit_log ORDER BY id").all())).digest("hex");

test("history: automatic events never become decisions; old audit survives unchanged and empty state is honest",()=>{
 const s=setup();try{const jobId=randomUUID();s.audit("case.processing_completed",{jobId,documentId:s.i.id,huge:"x".repeat(40000)});s.audit("case.document_extracted","not-json");s.audit("case.analysis_reviewed",{kind:"document",id:s.i.id,status:"excluded",note:"not a review of an analytic result"});
 const before=auditHash(s.db),h=analysisCenter(s.db,s.a.id,{view:"history"});assert.equal(h.total,0);assert.equal(h.allDecisions,0);assert.equal(h.stats.reviewed,0);assert.equal(h.emptyMessage,"Сотрудники пока не принимали решений по результатам анализа");assert.doesNotMatch(JSON.stringify(h),new RegExp(jobId));assert.equal(auditHash(s.db),before);
 assert.equal(s.db.prepare("SELECT count(*) n FROM audit_log WHERE action='case.processing_completed'").get().n,1);
 }finally{s.close();}
});

test("history: confirmations, rejections, changed decisions, comments, human actors, exact sources, filters and unique-question metrics",()=>{
 const s=setup();try{
 s.review("confirmed","Сверено по двум документам");s.review("rejected","Найден другой период выписки");s.review("rejected","Добавлено обоснование отклонения");s.review("checking","Повторная проверка начата");
 const all=reviewHistory(s.db,s.a.id);assert.equal(all.total,4);assert.equal(all.stats.reviewed,1);assert.equal(all.stats.confirmations,0);assert.equal(all.stats.rejections,0);assert.equal(all.stats.unfinished,1);
 const first=all.items.find(e=>e.status==="confirmed");assert.equal(first.previousState,"Требует рассмотрения");assert.equal(first.employee.name,"Айгуль Тестовая");assert.equal(first.employee.login,"test-officer");assert.equal(first.parties.length,2);assert.equal(first.documents.length,2);assert.ok(first.documents.every(d=>d.location.includes("строка 2")&&d.originalUrl));
 const reject=all.items.find(e=>e.kind==="risk_rejected");assert.equal(reject.previousState,"Подтверждено сотрудником");assert.equal(reject.changed,true);assert.equal(reject.previousNote,"Сверено по двум документам");assert.ok(all.items.some(e=>e.kind==="comment_added"&&e.previousState==="Отклонено"));
 assert.ok(all.items.every(e=>e.action===undefined&&e.details===undefined&&e.userId===undefined));
 assert.equal(reviewHistory(s.db,s.a.id,{employee:"test-officer",counterparty:A,status:"rejected"}).total,2);
 assert.equal(reviewHistory(s.db,s.a.id,{counterparty:"альфа",kind:"comment_added"}).total,1);
 assert.equal(reviewHistory(s.db,s.a.id,{kind:"decision_changed"}).total,2);
 assert.equal(reviewHistory(s.db,s.a.id,{employee:"someone-else"}).total,0);
 assert.equal(reviewHistory(s.db,s.a.id,{limit:2,offset:2}).items.length,2);
 const date=all.items[0].createdAt.slice(0,10);assert.equal(reviewHistory(s.db,s.a.id,{from:date,to:date,timeZone:"UTC"}).total,4);assert.equal(reviewHistory(s.db,s.a.id,{from:"2020-01-01",to:"2020-02-01"}).total,0);
 assert.throws(()=>reviewHistory(s.db,s.a.id,{from:"2026-02-30"}),/дата/);assert.throws(()=>reviewHistory(s.db,s.a.id,{kind:"case.processing_completed"}),/вид решения/);assert.throws(()=>reviewHistory(s.db,s.a.id,{timeZone:"invalid-zone"}),/пояс/);
 assert.equal(reviewHistory(s.db,s.b.id).total,0);assert.throws(()=>reviewHistory(s.db,s.a.id,{}, {departmentId:"foreign"}),/не найдено/);
 const snapshot=first.title;s.db.prepare("UPDATE discrepancies SET description='Новое автоматическое описание' WHERE id=?").run(s.risk.id);assert.equal(reviewHistory(s.db,s.a.id).items.find(e=>e.status==="confirmed").title,snapshot);
 const stored=s.db.prepare("SELECT details_json FROM audit_log WHERE action='case.analysis_reviewed' ORDER BY rowid LIMIT 1").get();assert.equal(JSON.parse(stored.details_json).review.version,1);
 }finally{s.close();}
});

test("history: legacy manual decisions are readable without invented previous states; timezone boundaries; service rows are not backfilled",()=>{
 const s=setup();try{s.audit("case.analysis_reviewed",{kind:"risk",id:s.risk.id,status:"confirmed",note:"Старое ручное решение"});const before=auditHash(s.db),h=reviewHistory(s.db,s.a.id,{from:"2026-10-22",to:"2026-10-22",timeZone:"Asia/Qyzylorda"});assert.equal(h.total,1);assert.equal(h.items[0].previousState,"Не зафиксировано в старой записи");assert.equal(h.items[0].legacy,true);assert.match(h.items[0].employee.name,/не зафиксирован/);assert.equal(h.items[0].documents.length,2);assert.equal(auditHash(s.db),before);
 assert.equal(reviewHistory(s.db,s.a.id,{from:"2026-10-22",to:"2026-10-22",timeZone:"UTC"}).total,0);
 }finally{s.close();}
});

test("history: matching decisions keep previous status and sources; system log denies all accounts including obsolete administrator roles",()=>{
 const s=setup();try{const ops=caseAnalysis(s.db,s.a.id).operations,l=ops.find(o=>o.type==="invoice"),r=ops.find(o=>o.type==="payment");
 reviewMatching(s.db,s.a.id,{leftId:l.id,rightId:r.id,status:"confirmed",note:"Подтверждена связь"},{userId:s.userId});reviewMatching(s.db,s.a.id,{leftId:l.id,rightId:r.id,status:"rejected",note:"Сопоставление ошибочно"},{userId:s.userId});
 const h=reviewHistory(s.db,s.a.id);assert.equal(h.total,2);assert.equal(h.items[0].previousState,"Подтверждено сотрудником");assert.equal(h.items[0].kind,"match_rejected");assert.equal(h.items[0].documents.length,2);assert.equal(h.stats.rejections,1);assert.equal(h.stats.reviewed,1);assert.equal(h.systemLogAvailable,false);
 s.db.prepare("UPDATE users SET role='administrator' WHERE id=?").run(s.userId);assert.throws(()=>systemLog(s.db,s.a.id,{userId:s.userId,role:"administrator",isAdmin:true}),e=>e.status===403);assert.throws(()=>analysisCenter(s.db,s.a.id,{view:"system_log",role:"administrator"}),e=>e.status===403);
 }finally{s.close();}
});

test("history: pagination does not silently truncate decisions after 1000 events",()=>{
 const s=setup();try{s.db.exec("BEGIN IMMEDIATE");for(let i=0;i<1005;i++)s.audit("case.analysis_reviewed",{kind:"risk",id:s.risk.id,status:"checking",note:`Комментарий ${i}`},{user:s.userId});s.db.exec("COMMIT");const h=reviewHistory(s.db,s.a.id,{offset:1000,limit:20});assert.equal(h.total,1005);assert.equal(h.items.length,5);assert.equal(h.stats.reviewed,1);assert.equal(h.stats.unfinished,1);
 }finally{s.close();}
});
