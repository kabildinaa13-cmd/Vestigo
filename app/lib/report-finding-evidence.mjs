import {readWorkCost} from './work-cost-sources.mjs';
import {readingDiagnostic} from './document-reading-status.mjs';

const generic=new Set(['DOCUMENT_PROCESSING_INCOMPLETE','INCOMPLETE_EXTRACTION']);
const limit=6;
const clip=(v,max=250)=>String(v??'').trim().slice(0,max);
const fieldLabels={number:'Номер документа',lineNumber:'Номер позиции',amount:'Сумма документа',lineAmount:'Сумма строки',date:'Дата',senderId:'БИН отправителя',recipientId:'БИН получателя',currency:'Валюта',status:'Статус',transactionId:'ID транзакции',purpose:'Назначение платежа',debit:'Дебет по выписке',credit:'Кредит по выписке'};
const toMajor=n=>{const x=BigInt(n),a=x<0n?-x:x;return `${x<0n?'−':''}${a/100n},${String(a%100n).padStart(2,'0')}`;};
const numeric=v=>Number.isSafeInteger(v);

function rowValues(r,code){
 const sources=r.attributes?.fieldSources||{},amountKey=r.amountBasis==='line'?'lineAmount':'amount';
 const keys=['number','lineNumber',amountKey,'date','currency'];
 if(code==='CONFLICTING_DOCUMENT'||code==='EXTRACTION_FIELD_CONFLICT')keys.push('senderId','recipientId','status',...(r.attributes?.conflictingFields||[]));
 if(r.type==='payment')keys.push('transactionId','purpose',r.bank?.direction==='incoming'?'credit':'debit');
 const values=[];
 for(const key of new Set(keys)){
  if(!Object.hasOwn(fieldLabels,key))continue;
  const f=sources[key]||{},value=key===amountKey?r.amountMinor:key==='transactionId'?r.bank?.transactionId:r[key];
  const raw=clip(f.raw??(key===amountKey?(numeric(value)?toMajor(value):''):value));
  if(raw||key===amountKey)values.push({key,label:clip(f.column||fieldLabels[key]),raw,cell:clip(f.cell,32),missing:!raw,unreadable:key===amountKey&&!numeric(value)&&!!raw,...(f.raw==null&&raw?{normalized:true}:{})});
 }
 return values;
}

function findingReason(risk,examples,records){
 if(risk.code!=='CONFLICTING_DOCUMENT')return '';
 const rows=records.filter(Boolean);
 const bad=examples.find(e=>e.values.some(v=>v.unreadable||v.missing));
 if(bad&&/нераспознанная сумма|частичный итог/iu.test(risk.rule||''))return 'В одной из строк сумма не прочитана. Известные строки не считаются полным итогом.';
 for(const key of ['lineNumber','number']){
  const groups=new Map();
  for(const row of rows){
   if(!row[key]||!numeric(row.amountMinor))continue;
   const basis=row.amountBasis==='line'?'line':'document';
   if(key==='lineNumber'&&basis!=='line'||key==='number'&&basis!=='document')continue;
   if(!row.currency||row.currency==='UNKNOWN')continue;
   const id=JSON.stringify([row.number,row.currency,row[key]]);
   const amounts=groups.get(id)||new Set();amounts.add(row.amountMinor);groups.set(id,amounts);
  }
  if([...groups.values()].some(a=>a.size>1))return key==='lineNumber'?'Один номер позиции указан с разными суммами.':'По одному номеру документа указаны разные итоговые суммы.';
 }
 return '';
}

// Freeze only a small, relevant excerpt in the report. Opening an old version
// must never consult the current extraction or silently replace its evidence.
export function captureReportFindings(db,caseId,risks,documents){
 const docs=new Map(documents.filter(d=>!d.excluded).map(d=>[d.id,d]));
 const row=db.prepare('SELECT record_json FROM case_extracted_rows WHERE case_id=? AND document_id=? AND sheet=? AND row_number=?');
 const text=db.prepare(`SELECT e.text_content body,e.pages_json pages,m.type_code type,m.group_code AS "group"
  FROM case_extractions e JOIN case_document_metadata m ON m.case_id=e.case_id AND m.document_id=e.document_id
  WHERE e.case_id=? AND e.document_id=? AND e.status IN ('review','confirmed','extracted')`);
 const rowCache=new Map(),costCache=new Map();
 const loadRow=s=>{
  const key=JSON.stringify([s.documentId,s.sheet,s.row]);
  if(!rowCache.has(key)){const result=row.get(caseId,s.documentId,s.sheet,s.row);rowCache.set(key,result?JSON.parse(result.record_json):null);}
  return rowCache.get(key);
 };
 const cost=s=>{
  if(!costCache.has(s.documentId)){
   const source=text.get(caseId,s.documentId);
   costCache.set(s.documentId,source?readWorkCost({...source,id:s.documentId,name:s.name,pages:JSON.parse(source.pages||'[]')}):null);
  }
  return costCache.get(s.documentId);
 };
 return risks.map(risk=>{
  if(risk.retired||['closed','rejected'].includes(risk.status))return risk;
  const sources=new Map();
  const add=s=>{if(docs.has(s.documentId))sources.set(JSON.stringify([s.documentId,s.sheet||'',s.row||0,s.page||0]),s);};
  const documentIds=[...new Set((risk.evidence||[]).map(s=>s.documentId))];
  const diagnostic=generic.has(risk.code)&&documentIds.length===1&&docs.has(documentIds[0])?
   risk.calculation?.readingDiagnostic||readingDiagnostic(docs.get(documentIds[0])):null;
  for(const s of diagnostic?.evidence||[])if(s.row||s.page)add(s);
  for(const s of risk.evidence||[]){
   add(s);
   if(!s.row&&generic.has(risk.code)){
    for(const q of (docs.get(s.documentId)?.summary?.quality?.examples||[])){
     if(q.row&&q.sheet&&!String(q.code||'').startsWith('IGNORED_'))add({...s,sheet:q.sheet,row:q.row});
     if(sources.size>limit)break;
    }
   }
  }
  const examples=[],records=[];
  for(const s of [...sources.values()].slice(0,limit)){
   const name=docs.get(s.documentId).name,ref={documentId:s.documentId,name,sheet:clip(s.sheet,150),row:s.row||0,page:s.page||Number(String(s.sheet||'').match(/^PDF(?: bank)?\s+(\d+)/)?.[1]||0)};
   if(s.textLine&&s.excerpt){examples.push({...ref,textLine:true,values:[{key:'sourceLine',label:'Текст строки',raw:clip(s.excerpt)}]});continue;}
   const record=s.row?loadRow(s):null;
   if(record){
    const values=rowValues(record,risk.code);
    if(values.length){examples.push({...ref,values});records.push(record);}
   }else if(!s.row&&generic.has(risk.code)){
    const f=cost(s)?.facts?.find(f=>f.minor!=null);
    if(f)examples.push({...ref,row:f.line,page:f.page||0,textLine:true,values:[{key:'labelledCost',label:clip(f.label),raw:clip(f.raw)}]});
   }
  }
  const reason=findingReason(risk,examples,records);
  return {...risk,...(diagnostic?{calculation:{...risk.calculation,readingDiagnostic:diagnostic}}:{}),reportEvidence:{examples,reason,truncated:sources.size>limit}};
 });
}
