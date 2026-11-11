import {createHash} from "node:crypto";
import {classifyDocument} from "./document-classifier.mjs";
import {documentType} from "./document-types.mjs";
import {extractLabelledFacts,automaticFactDecision,sameFactValue,extractContextFacts} from "./document-facts.mjs";
export const PDF_ANALYSIS_VERSION="pdf-analysis-2.0";
const digest=v=>createHash("sha256").update(JSON.stringify(v)).digest("hex");
const normal=v=>String(v||"").normalize("NFKC").toLocaleLowerCase("ru").replace(/ё/g,"е").replace(/\s+/g," ").trim();
const unique=v=>[...new Set(v)];
function validDate(value){if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;const d=new Date(value+"T00:00:00Z");return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===value;}
function amount(value){const text=String(value||"").replace(/[ \u00a0]/g,"").replace(",",".");if(!/^-?\d{1,13}(?:\.\d{1,2})?$/.test(text))return null;const neg=text.startsWith("-"),[a,b=""]=text.replace("-","").split(".");const n=BigInt(a)*100n+BigInt(b.padEnd(2,"0"));return Number(n)*(neg?-1:1);}
function explicitFields(text){
  const one=(expression)=>{const values=unique([...text.matchAll(expression)].map(m=>m[1].trim()));return values.length===1?values[0]:"";};
  const date=one(/(?:Дата платежа|Дата документа|Дата выписки)\s*[:：]\s*(\d{2}[.]\d{2}[.]\d{4}|\d{4}-\d{2}-\d{2})/giu);
  const iso=/^\d{2}[.]\d{2}[.]\d{4}$/.test(date)?date.split(".").reverse().join("-"):date;
  const total=one(/^(?:Общая сумма(?: документа| с НДС)?|Сумма платежа|Итого к оплате)\s*[:：]\s*(\d[\d \u00a0]*[.,]\d{2})(?:[ \t]*(?:KZT|USD|EUR|тенге|₸))?[ \t]*$/gimu);
  return {senderId:one(/(?:БИН поставщика|БИН отправителя|ИИН отправителя|ИИН\/БИН поставщика)\s*[:：]\s*(\d{12})(?!\d)/giu),recipientId:one(/(?:БИН получателя|БИН покупателя|ИИН получателя|ИИН\/БИН получателя)\s*[:：]\s*(\d{12})(?!\d)/giu),senderName:one(/Наименование поставщика\s*[:：][ \t]*([^\r\n]{1,500})/giu),recipientName:one(/Наименование получателя\s*[:：][ \t]*([^\r\n]{1,500})/giu),date:validDate(iso)?iso:"",amount:amount(total)!==null?total:"",currency:one(/(?:Валюта|Код валюты)\s*[:：]\s*([A-Z]{3})(?![A-Z])/gu),purpose:one(/(?:Назначение платежа|Предмет договора)\s*[:：][ \t]*([^\r\n]{1,1000})/giu)};
}
export function extractTextCandidates(text){
  const ids=unique([...text.matchAll(/(?<![\p{L}\d])\d{12}(?![\p{L}\d])/gu)].map(m=>m[0])).slice(0,50);
  const dates=unique([...text.matchAll(/\b(\d{2})[.\/](\d{2})[.\/](\d{4})\b/g)].map(m=>`${m[3]}-${m[2]}-${m[1]}`).filter(validDate)).slice(0,50);
  const references=unique([...text.matchAll(/(?:договор[а-я]*|контракт[а-я]*)\s*(?:поставки(?:\s+товара)?|подряда|аренды|товара|основание)?\s*(?:№|N\b)\s*([\p{L}\d][\p{L}\d/._-]{0,60})/giu)].map(m=>m[1])).slice(0,30);
  const invoices=unique([...text.matchAll(/ESF-[A-Z\d-]{10,100}/gi)].map(m=>m[0])).slice(0,30);
  const amounts=unique([...text.matchAll(/(?<![\p{L}\d.])(?:\d{1,3}(?:[ \u00a0]\d{3})+|\d{1,13})[.,]\d{2}(?![\d.])/gu)].map(m=>m[0])).slice(0,50);
  return {identifiers:ids,dates,contractReferences:references,invoiceNumbers:invoices,amounts};
}
function proposedSegments(pages){
  const segments=[];
  for(const page of pages){
    const result=classifyDocument({text:page.text||""});
    const known=result.status==="automatic";
    const previous=segments.at(-1);
    // An unknown page is NOT silently attached to a different document. Only explicit continuation clues permit a proposal.
    const top=normal((page.text||"").slice(0,800));
    const contractContinuation=previous?.groupId==="contract"&&/^(?:\d+[.]\d+|\d+[.]?\s+(?:права|ответственность|срок|порядок|прочие|юридические))/u.test(top);
    const invoiceContinuation=previous?.typeId==="invoice"&&/^раздел\s+[gгhн]\s*[.]?\s*(?:данные|сведения)/u.test(top);
    if(!known&&previous&&page.text?.trim()&&(contractContinuation||invoiceContinuation)) {previous.to=page.page;previous.continuationUncertain=true;continue;}
    segments.push({from:page.page,to:page.page,groupId:known?result.groupId:"unclassified",typeId:known?result.typeId:"unclassified",approved:false,note:"",continuationUncertain:!known});
  }
  return segments;
}
export function analyzePdfResult(result,options={}){
  if(!result.pages?.length)return result;
  const pages=result.pages,sourceDigest=digest(pages.map(p=>({page:p.page,text:p.text,rotation:p.ocr?.rotation||0})));
  let definitions=proposedSegments(pages);
  if(options.segmentReviews!==undefined){
    if(options.segmentReviewDigest!==sourceDigest)throw new Error("Текст или версия OCR изменились. Откройте актуальный результат перед сверкой границ.");
    if(!Array.isArray(options.segmentReviews)||options.segmentReviews.length>1000||!options.segmentReviews.length)throw new Error("Некорректный список документов PDF");
    const used=new Set();definitions=options.segmentReviews.map(input=>{
      const {from,to,groupId,typeId}=input;
      if(!Number.isInteger(from)||!Number.isInteger(to)||from<1||to<from||to>pages.length||!documentType(groupId,typeId))throw new Error("Проверьте диапазоны страниц и виды документов.");
      for(let p=from;p<=to;p++){if(used.has(p))throw new Error("Диапазоны документов пересекаются.");used.add(p);}
      const fields=input.fields||{};
      if(typeof fields!=="object"||Array.isArray(fields)||Object.keys(fields).length>15||Object.values(fields).some(v=>typeof v!=="string"||v.length>2000))throw new Error("Некорректные реквизиты документа");
      const approved=input.approved===true,note=String(input.note||"").trim();
      if(approved&&(!note||note.length>4000))throw new Error("Для сверенного документа укажите основание сверки с оригиналом.");
      return {from,to,groupId,typeId,approved,note,fields};
    }).sort((a,b)=>a.from-b.from);
    if(used.size!==pages.length)throw new Error("Все страницы должны входить в документ или нераспределённый фрагмент.");
  }
  const rows=[],warnings=[...(result.warnings||[])];
  const segments=definitions.map((definition,index)=>{
    const relevant=pages.filter(p=>p.page>=definition.from&&p.page<=definition.to),text=relevant.map(p=>p.text||"").join("\n"),candidates=extractTextCandidates(text);
    const facts=extractLabelledFacts(text,{typeId:definition.typeId,groupId:definition.groupId});
    const fields={...facts.fields,...definition.fields};
    const automaticFields=Object.entries(fields).every(([key,value])=>String(value||"")===String(facts.fields[key]||""));
    const hasUnreadPages=relevant.some(p=>!p.text?.trim());
    // Compare independent OCR variants instead of silently choosing conflicting digits.
    for(const page of relevant)for(const alternative of page.ocr?.alternatives||[]){const alternate=extractLabelledFacts(alternative.text||"",{typeId:definition.typeId,groupId:definition.groupId});for(const key of ["senderId","recipientId","date","amount","currency"]){if(alternate.fields[key]&&facts.fields[key]&&!sameFactValue(key,alternate.fields[key],facts.fields[key]))facts.conflicts.push(key);}}
    facts.conflicts=[...new Set(facts.conflicts)];
    const automatic=automaticFactDecision(facts,{...definition,unread:hasUnreadPages,uncertain:definition.continuationUncertain===true});
    automatic.eligible=automatic.eligible&&automaticFields&&options.autoExtract!==false;
    // Candidate sets deliberately do not assign unrelated IDs or dates to transaction roles.
    const context=["correspondence","unclassified","tax","expert"].includes(definition.groupId)||definition.typeId==="reconciliation_act";
    const canCreate=(definition.approved||automatic.eligible)&&!context;
    if(definition.approved&&!context&&(!/^\d{12}$/.test(fields.senderId)||!/^\d{12}$/.test(fields.recipientId)||!validDate(fields.date)||amount(fields.amount)===null||!/^[A-Z]{3}$/.test(fields.currency)||!fields.number.trim()))throw new Error(`Документ ${index+1}: для операции нужны обе стороны, дата, сумма, валюта и номер. Неизвестное оставьте не подтверждённым.`);
    const type=definition.groupId==="bank"?"payment":definition.groupId==="contract"?"contract":definition.typeId==="invoice"?"invoice":definition.groupId==="primary"?"primary":definition.groupId==="reimbursement"?"reimbursement":definition.groupId==="victim"?"claim":"accounting";
    const sheet=`PDF ${definition.from}–${definition.to}`;
    rows.push({sheet,row:1,type:canCreate?type:"context",groupId:definition.groupId,documentType:definition.typeId,raw:{"Страницы":`${definition.from}–${definition.to}`,"Текст":text.slice(0,100000),"БИН/ИИН — кандидаты":candidates.identifiers.join(", "),"Даты — кандидаты":candidates.dates.join(", "),"Суммы — кандидаты":candidates.amounts.join("; ")},senderId:fields.senderId,senderName:fields.senderName,recipientId:fields.recipientId,recipientName:fields.recipientName,date:fields.date,amountMinor:canCreate?amount(fields.amount):null,currency:fields.currency||"UNKNOWN",number:fields.number,registrationNumber:definition.typeId==="invoice"&&fields.number.startsWith("ESF-"),reference:fields.reference||fields.contractRef,contractRef:fields.contractRef,purpose:fields.purpose,status:"",amountBasis:"document_total",manualSource:definition.approved&&!context,automaticSource:automatic.eligible&&!definition.approved,attributes:{sourcePage:definition.from,sourcePageTo:definition.to,ocrSource:relevant.some(p=>p.textSource==="ocr"),segmentReviewed:definition.approved,reviewNote:definition.note,extractionRule:facts.version,fieldEvidence:facts.evidence,missingFields:automatic.missing,conflictingFields:automatic.conflicts,automaticPreliminary:automatic.eligible&&!definition.approved}});
    rows.at(-1).attributes.documentFacts=relevant.flatMap(page=>extractContextFacts(page.text||'').map(f=>({...f,page:page.page,ocr:page.textSource==='ocr'})));
    return {...definition,fields,candidates,automatic,fieldEvidence:facts.evidence,documentFacts:rows.at(-1).attributes.documentFacts,excerpt:text.slice(0,1800),ocr:relevant.some(p=>p.textSource==="ocr"),hasUnreadPages,qualityReviewRequired:relevant.some(p=>p.lowSourceResolution||p.ocr?.qualityReviewRequired),sheet};
  });
  const links=[];
  for(let i=0;i<segments.length;i++)for(const ref of segments[i].candidates.contractReferences){
    const targets=segments.map((s,n)=>({s,n})).filter(({s,n})=>n!==i&&s.groupId==="contract"&&normal(s.fields.number)===normal(ref)&&s.fields.number);
    if(targets.length===1)links.push({from:i+1,to:targets[0].n+1,reference:ref,method:"number_candidate",verified:false,explanation:"Совпал номер-кандидат. Стороны, действующая редакция и исполнение требуют проверки."});
  }
  warnings.push("Полные однозначные реквизиты автоматически участвуют в предварительной аналитике; подтверждение фактической операции не присваивается. Неизвестные и противоречивые поля не дополняются наугад.");
  const pageAudit=result.pageAudit||{},ocrPages=pages.filter(p=>p.textSource==="ocr");
  const automaticallyExtracted=segments.filter(s=>s.automatic.eligible&&!s.approved).length;
  const unresolved=segments.filter(s=>!s.approved&&!s.automatic.eligible&&!["correspondence","tax","expert"].includes(s.groupId)&&s.typeId!=="reconciliation_act").length;
  return {...result,rows,warnings,unparsedRows:0,contextOnly:!rows.some(r=>r.type!=="context"),status:pageAudit.pagesWithText===0?"needs_ocr":!unresolved&&!pageAudit.pagesWithoutText?.length?"extracted":"review",
    documentAnalysis:{version:PDF_ANALYSIS_VERSION,sourceDigest,segments,links,reviewed:segments.filter(s=>s.approved).length,automaticallyExtracted,unresolved,total:segments.length,ocrPages:ocrPages.length,engines:unique(ocrPages.map(p=>p.ocr?.engine).filter(Boolean)),kazakhAvailable:ocrPages.length?ocrPages.every(p=>p.ocr?.kazakhAvailable):null}};
}
