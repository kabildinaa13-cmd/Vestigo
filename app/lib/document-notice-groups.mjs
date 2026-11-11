// Presentation only: no persistence, financial calculations or extraction.
import {readingDiagnostic} from './document-reading-status.mjs';
export const NOTICE_CATEGORIES={data_quality:'Реквизиты и чтение',reconciliation:'Сверка платежей',discrepancy:'Финансовые расхождения',signal:'Аналитические сигналы',decision:'Решения сотрудников',processing_error:'Ошибки обработки'};
const concise={PDF_LOW_SOURCE_QUALITY:'Качество скана и OCR',PDF_PAGES_WITHOUT_TEXT:'Страницы без текста',PDF_SEGMENTS_REQUIRE_REVIEW:'Недостаточно реквизитов',DOCUMENT_CLASSIFICATION_REQUIRED:'Вид документа требует подтверждения',DOCUMENT_PROCESSING_INCOMPLETE:'Полнота обработки требует проверки',INCOMPLETE_EXTRACTION:'Неполное извлечение данных',EXTRACTION_FIELD_CONFLICT:'Противоречивые реквизиты',DOCUMENT_FACT_REVIEW_REQUIRED:'Реквизиты требуют уточнения',WORKBOOK_FORMULA_ERRORS:'Ошибки в сохранённых формулах Excel'};
const severity={critical:0,error:0,high:0,medium:1,info:2};
const text=v=>String(v??'').normalize('NFKC').replace(/\s+/g,' ').trim();
const object=v=>{if(v&&typeof v==='object')return v;try{return JSON.parse(v||'{}');}catch{return {};}};
const stable=v=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):typeof x==='bigint'?String(x):x);
const positive=v=>Number.isSafeInteger(Number(v))&&Number(v)>0?Number(v):0;
const codeOf=r=>String(r.code||r.type||'');
const reconciliationCodes=new Set(['NO_PAYMENT_MATCH','PAYMENT_WITHOUT_LINKED_DOCUMENT']);
const generalReadingCodes=new Set(['DOCUMENT_PROCESSING_INCOMPLETE','INCOMPLETE_EXTRACTION']);
const categoryOf=r=>r.kind==='decision'||r.action?'decision':r.kind==='processing_error'||r.kind==='error'?'processing_error':reconciliationCodes.has(codeOf(r))?'reconciliation':Object.hasOwn(NOTICE_CATEGORIES,r.kind)?r.kind:r.category==='Качество данных'?'data_quality':r.category==='Финансовые расхождения'?'discrepancy':'signal';
export function noticeTitle(r,documents=[]){
  const code=codeOf(r),description=text(r.description||r.title),ref=description.match(/«([^»]+)»/)?.[1];
  if(code==='NO_PAYMENT_MATCH')return ref?`ЭСФ ${ref}: платёж не найден в загруженных файлах`:'Платёж по ЭСФ не найден в загруженных файлах';
  if(code==='PAYMENT_WITHOUT_LINKED_DOCUMENT')return ref?`Платёж ${ref}: документ-основание не найден`:'Документ-основание платежа не найден';
  if(code==='CONFLICTING_DOCUMENT')return `${ref?ref+': ':''}${/нераспознанная сумма|частичный итог/iu.test(r.rule||'')?'сумма не установлена':'противоречие в реквизитах'} — не в итогах`;
  if(generalReadingCodes.has(code)&&documents.length===1&&documents[0].status==='review')return 'Требуется сверить реквизиты';
  return concise[code]||description||'Замечание';
}
export function noticeNextStep(r,documents=[]){
  const code=codeOf(r);
  if(code==='NO_PAYMENT_MATCH')return 'Сверьте номер ЭСФ, период и полноту выписок.';
  if(code==='PAYMENT_WITHOUT_LINKED_DOCUMENT')return 'Сверьте назначение платежа и найдите документ-основание.';
  if(code==='CONFLICTING_DOCUMENT')return 'Сверьте указанные строки с оригиналом.';
  if(generalReadingCodes.has(code)&&documents.length===1&&documents[0].status==='review')return 'Откройте оригинал и проверьте недостающие поля.';
  return '';
}
export function noticeReadingDiagnostic(r,documents){
  if(!generalReadingCodes.has(codeOf(r))||documents.length!==1)return null;
  const [document]=documents;
  if(r.calculation?.readingDiagnostic)return r.calculation.readingDiagnostic;
  if(!document.summary&&/Файл не прочитан, чтение не завершено либо прочитан только текст|Контроль полноты: нужен OCR/iu.test(r.rule||''))
    return {title:'Подробности чтения не сохранены',rule:'В этой записи не указано, какие поля или строки требуют проверки.',nextAction:'Откройте актуальный результат чтения документа.',evidence:[]};
  return readingDiagnostic(document);
}
const rawSources=r=>[...(Array.isArray(r.evidence)?r.evidence:[]),...(Array.isArray(r.sources)?r.sources:[]),...(r.documentId?[{documentId:r.documentId,name:r.name}]:[])].filter(s=>s&&s.documentId);
function location(s){const sheet=String(s.sheet||''),pdf=sheet.match(/^PDF(?: bank)?\s+(\d+)(?:[–—-](\d+))?/),page=positive(s.page)||positive(pdf?.[1]),pageTo=positive(s.pageTo)||positive(pdf?.[2]),cell=String(s.cell||''),cellRow=/^[a-z]{1,3}[1-9]\d*$/i.test(cell)?positive(cell.match(/\d+$/)?.[0]):0;return {...s,documentId:String(s.documentId),sheet,row:positive(s.row)||cellRow,page,pageTo:pageTo>page?pageTo:0,cell,fragment:String(s.fragment||s.fragmentId||'')};}
const locationKey=s=>s.page?stable([s.documentId,s.page,s.pageTo,/^PDF bank/.test(s.sheet)?s.row:0,s.cell,s.fragment]):stable([s.documentId,s.sheet,s.row,s.cell,s.fragment]);
export function noticeSourceLabel(s){if(s.textLine&&s.row)return `Строка текста ${s.row}`;if(s.page)return s.pageTo?`Страницы ${s.page}–${s.pageTo}`:`Страница ${s.page}`;if(s.row)return `${s.sheet||'Таблица'}, строка ${s.row}${s.cell?`, ${s.cell}`:''}`;if(s.cell)return `${s.sheet||'Лист'}, ячейка ${s.cell}`;if(s.fragment)return `Фрагмент ${s.fragment}`;return 'Документ целиком';}
export function noticeSourceUrl(caseId,s){return `/api/documents/${encodeURIComponent(s.documentId)}?${new URLSearchParams({caseId,inline:'1'})}${s.page?`#page=${s.page}`:''}`;}
function locations(r,documents){
  const base=rawSources(r).map(location),ids=[...new Set(base.map(s=>s.documentId))],extra=[];
  if(ids.length===1){const id=ids[0],doc=documents.get(id),summary=object(doc?.summary),calculation=object(r.calculation),code=codeOf(r),source={documentId:id,name:doc?.name||base[0]?.name||'Документ'};
    if(code==='PDF_PAGES_WITHOUT_TEXT')for(const page of calculation.pagesWithoutText||summary.pageAudit?.pagesWithoutText||[])if(positive(page))extra.push(location({...source,page}));
    if(code==='PDF_LOW_SOURCE_QUALITY')for(const p of calculation.pages||summary.pageAudit?.qualityPages||[]){const page=typeof p==='object'?p.page:p;if(positive(page))extra.push(location({...source,page}));}
    if(code==='PDF_SEGMENTS_REQUIRE_REVIEW'&&!base.some(s=>s.page||s.row||s.fragment))for(const [n,s]of (summary.documentAnalysis?.segments||[]).entries())if(!s.approved&&!s.automatic?.eligible&&!['correspondence','tax','expert'].includes(s.groupId)&&s.typeId!=='reconciliation_act')extra.push(location({...source,page:s.from,pageTo:s.to,sheet:s.sheet||'',row:1,fragment:String(n+1),excerpt:s.excerpt||''}));
    if(code==='WORKBOOK_FORMULA_ERRORS')for(const s of calculation.errors||summary.formulaAudit?.errors||[])extra.push(location({...source,sheet:s.sheet,row:s.row,cell:s.cell}));
  }
  const exact=[...base,...extra].filter(s=>s.page||s.row||s.cell||s.fragment);
  return [...new Map((exact.length?exact:base).map(s=>[locationKey(s),s])).values()];
}
function conditionKey(r,index){
  const code=codeOf(r),known=Object.hasOwn(concise,code),calculation=object(r.calculation),condition=text(r.condition||r.rule);
  // Only known quality rules have a separate location payload. Financial
  // operands, currencies, IDs and all unknown-rule descriptions stay in the key.
  const values=known?Object.fromEntries(Object.entries(calculation).filter(([k])=>!['pages','pagesWithoutText','errors','cells','sheet','row','page','source','sources'].includes(k))):calculation;
  return stable([categoryOf(r),code,condition?condition:['individual',r.id||index],r.ruleVersion||r.version||'',values,known?'':text(r.description||r.title),r.status||'',r.note||r.reviewNote||'',!!r.decisionStale,!!r.retired,categoryOf(r)==='decision'?r.id||index:'']);
}
function processingErrors(doc){
  const result=[],summary=object(doc.summary);if(doc.error||['failed','processing_error'].includes(doc.status)||doc.readStatus==='processing_error')result.push({message:String(doc.error||'Обработка завершилась с ошибкой. Откройте документ для подробностей.'),source:{documentId:doc.id,name:doc.name}});
  for(const p of summary.pageAudit?.errors||[])if(p.error)result.push({message:String(p.error),source:{documentId:doc.id,name:doc.name,page:positive(p.page)}});
  return [...new Map(result.map(e=>[stable([e.message,e.source.page||0]),e])).values()];
}
export function groupDocumentNotices(items=[],documents=[],{includeDocumentErrors=false}={}){
  const docs=new Map(documents.filter(d=>d&&d.id).map(d=>[String(d.id),d])),groups=new Map();
  const ensure=ids=>{const key=stable(ids);if(!groups.has(key))groups.set(key,{key,documentIds:ids,documents:ids.map(id=>docs.get(id)||{id,name:'Документ'}),rows:new Map()});return groups.get(key);};
  for(const [index,r]of items.entries()){
    const evidence=rawSources(r);for(const s of evidence)if(!docs.has(String(s.documentId)))docs.set(String(s.documentId),{id:String(s.documentId),name:s.name||'Документ'});
    const ids=[...new Set(evidence.map(s=>String(s.documentId)))].sort(),g=ensure(ids),key=conditionKey(r,index);let row=g.rows.get(key);
    const diagnostic=noticeReadingDiagnostic(r,g.documents);
    if(!row){row={key,code:codeOf(r),category:categoryOf(r),title:diagnostic?.title||noticeTitle(r,g.documents),nextStep:diagnostic?.nextAction||noticeNextStep(r,g.documents)||r.nextAction||'',detail:diagnostic?.rule||r.rule||'',reading:!!diagnostic,severity:r.severity||'info',status:r.status||'pending',members:[],locations:[]};g.rows.set(key,row);}
    if((severity[r.severity]??2)<(severity[row.severity]??2))row.severity=r.severity;
    const saved=locations(r,docs),specific=diagnostic?.evidence.filter(s=>s.page||s.row||s.cell||s.fragment).map(location)||[];
    row.members.push({index,event:r});row.locations.push(...(specific.length?[...saved.filter(s=>s.page||s.row||s.cell||s.fragment),...specific]:saved));
  }
  if(includeDocumentErrors)for(const doc of documents)if(!doc.excluded&&processingErrors(doc).length)ensure([String(doc.id)]);
  const cards=[...groups.values()].map(g=>{
    const rows=[...g.rows.values()].map(r=>{const locs=[...new Map(r.locations.map(s=>[locationKey(s),s])).values()];return {...r,locations:locs,fragmentCount:locs.filter(s=>s.page||s.row||s.cell||s.fragment).length,eventCount:r.members.length};}).sort((a,b)=>(severity[a.severity]??2)-(severity[b.severity]??2)||a.title.localeCompare(b.title,'ru'));
    const rawErrors=[...g.documents.flatMap(d=>processingErrors(d)),...rows.filter(r=>r.category==='processing_error').map(r=>({message:r.members[0].event.description||r.title,source:r.locations[0]||{}}))];
    const errors=[...new Map(rawErrors.map(e=>[stable([e.message,e.source.documentId||'',e.source.page||0]),e])).values()],categories=Object.keys(NOTICE_CATEGORIES).map(id=>({id,title:NOTICE_CATEGORIES[id],rows:rows.filter(r=>r.category===id)})).filter(c=>c.rows.length),facts=g.documents.flatMap(d=>{const p=object(d.summary).pageAudit;return p&&Number.isSafeInteger(p.totalPages)&&Number.isSafeInteger(p.pagesWithText)?[{documentId:d.id,text:`Текст: ${p.pagesWithText} из ${p.totalPages} страниц`}]:[];});
    const preview=noticePreview(rows,facts.length>0);
    return {...g,rows,categories,errors,facts,preview,noticeCount:rows.filter(r=>r.category!=='decision').length,eventCount:rows.reduce((n,r)=>n+r.eventCount,0),repeatedEvents:rows.reduce((n,r)=>n+Math.max(0,r.eventCount-1),0),title:g.documents.length===1?g.documents[0].name:g.documents.length?`Связанные документы (${g.documents.length})`:'Вопросы без указанного первоисточника',joint:g.documents.length>1};
  }).sort((a,b)=>Number(!!b.errors.length)-Number(!!a.errors.length)||a.title.localeCompare(b.title,'ru'));
  return {groups:cards,inputEventCount:items.length,assignedEventCount:cards.reduce((n,g)=>n+g.eventCount,0),noticeCount:cards.reduce((n,g)=>n+g.noticeCount,0),documentCount:new Set(cards.flatMap(g=>g.documentIds)).size};
}
export function noticePreview(rows,hasPageFacts=false){
  const visible=rows.filter(r=>r.category!=='decision'&&r.category!=='processing_error'&&!(hasPageFacts&&r.code==='PDF_PAGES_WITHOUT_TEXT'));
  const hasSpecificQuality=visible.some(r=>r.category==='data_quality'&&!generalReadingCodes.has(r.code));
  let shownGeneral=false;
  return visible.filter(r=>{if(!generalReadingCodes.has(r.code))return true;if(hasSpecificQuality||shownGeneral)return false;shownGeneral=true;return true;}).slice(0,3);
}
