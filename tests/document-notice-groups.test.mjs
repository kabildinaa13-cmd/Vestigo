import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import {renderToStaticMarkup} from 'react-dom/server';
import * as notices from '../app/lib/document-notice-groups.mjs';
const {groupDocumentNotices,noticeSourceLabel,noticeSourceUrl}=notices;
const doc={id:'pdf',name:'санкция по телефонам.pdf',summary:{pageAudit:{totalPages:31,pagesWithText:30,pagesWithoutText:[31],qualityPages:[2,3]},documentAnalysis:{segments:[{from:4,to:5,automatic:{eligible:false}}]}}};
const event=(id,code='PDF_LOW_SOURCE_QUALITY',extra={})=>({id,code,kind:'data_quality',severity:'medium',status:'pending',description:'Сохранённое описание',rule:'Проверка качества источника',ruleVersion:'v1',evidence:[{documentId:doc.id,name:doc.name}],...extra});
test('reading notice distinguishes read text, exact table rows and actual reading errors',()=>{
 const risk=event('reading','DOCUMENT_PROCESSING_INCOMPLETE',{rule:'Файл не прочитан, чтение не завершено либо прочитан только текст.'});
 const row=(status,summary,error)=>groupDocumentNotices([risk],[{...doc,status,summary,error}]).groups[0].rows[0];
 const act=row('review',{textCharacters:55,automaticFacts:{missing:['date'],fieldLocations:[{line:3,text:'Дата: 31.02.2026'}]}});
 assert.match(act.title,/Текст прочитан/);
 assert.match(act.detail,/дата документа/);
 assert.equal(noticeSourceLabel(act.locations[0]),'Строка текста 3');
 const table=row('review',{quality:{reviewRows:2,examples:[{sheet:'Лист',row:10,message:'Сумма позиции не распознана'}]}});
 assert.match(table.title,/Таблица прочитана/);
 assert.equal(noticeSourceLabel(table.locations[0]),'Лист, строка 10');
 assert.match(table.locations[0].excerpt,/Сумма позиции/);
 assert.equal(row('failed',{},'Контрольная ошибка').detail,'Контрольная ошибка');
 assert.match(row('review',undefined).title,/не сохранены/);
});
test('plain-language overview keeps reconciliation apart and puts generic reading notes behind details',()=>{
 const events=[
  event('review','DOCUMENT_PROCESSING_INCOMPLETE'),
  event('partial','CONFLICTING_DOCUMENT',{description:'Неоднозначные данные документа «V2-INCOMPLETE». Итог требует проверки.',rule:'Нераспознанная сумма; частичный итог.',severity:'high'}),
  event('payment','NO_PAYMENT_MATCH',{description:'Для ЭСФ «V2-INV-EUR» не найден однозначный платёж.'}),
 ];
 const g=groupDocumentNotices(events,[{...doc,status:'review'}]).groups[0];
 assert.deepEqual(new Set(g.preview.map(r=>r.code)),new Set(['CONFLICTING_DOCUMENT','NO_PAYMENT_MATCH']));
 assert.equal(g.rows.find(r=>r.code==='NO_PAYMENT_MATCH').category,'reconciliation');
 assert.match(g.preview.find(r=>r.code==='CONFLICTING_DOCUMENT').title,/V2-INCOMPLETE: сумма не установлена/);
 assert.equal(g.rows.length,3);assert.equal(g.rows.find(r=>r.code==='DOCUMENT_PROCESSING_INCOMPLETE').members[0].event,events[0]);
});
function deepFreeze(value){if(value&&typeof value==='object'){Object.freeze(value);Object.values(value).forEach(deepFreeze);}return value;}
test('one document: four different notices share one compact card, original events and saved OCR coverage remain',()=>{
 const events=['PDF_LOW_SOURCE_QUALITY','PDF_PAGES_WITHOUT_TEXT','PDF_SEGMENTS_REQUIRE_REVIEW','DOCUMENT_CLASSIFICATION_REQUIRED'].map((code,i)=>event(String(i),code));
 const before=JSON.stringify([events,doc]);deepFreeze(events);deepFreeze(doc);
 const model=groupDocumentNotices(events,[doc]);assert.equal(model.groups.length,1);const g=model.groups[0];
 assert.equal(g.noticeCount,4);assert.equal(g.eventCount,4);assert.equal(g.facts[0].text,'Текст: 30 из 31 страниц');assert.equal(g.preview.length,3);
 assert.equal(g.rows.find(r=>r.code==='PDF_LOW_SOURCE_QUALITY').fragmentCount,2);
 assert.equal(g.rows.find(r=>r.code==='PDF_SEGMENTS_REQUIRE_REVIEW').locations[0].page,4);
 assert.deepEqual(g.rows.find(r=>r.code==='PDF_PAGES_WITHOUT_TEXT').locations.map(s=>s.page),[31]);
 assert.equal(model.inputEventCount,model.assignedEventCount);assert.equal(JSON.stringify([events,doc]),before);
});
test('same source and condition: display one notice with unique fragments while retaining every original event',()=>{
 const events=[2,3,3].map((page,i)=>event(String(i),'PDF_LOW_SOURCE_QUALITY',{evidence:[{documentId:'pdf',page}],calculation:{page}}));
 const g=groupDocumentNotices(events,[{id:'pdf',name:'doc.pdf'}]).groups[0];assert.equal(g.rows.length,1);assert.equal(g.rows[0].fragmentCount,2);assert.equal(g.rows[0].eventCount,3);assert.equal(g.repeatedEvents,2);assert.deepEqual(g.rows[0].members.map(m=>m.event.id),['0','1','2']);
});
test('same PDF page represented by sheet and page is one fragment; bank rows remain distinct',()=>{
 const events=[event('a','PDF_LOW_SOURCE_QUALITY',{evidence:[{documentId:'pdf',sheet:'PDF 2',row:1},{documentId:'pdf',page:2}]})];
 assert.equal(groupDocumentNotices(events).groups[0].rows[0].fragmentCount,1);
 events[0].evidence=[{documentId:'pdf',sheet:'PDF bank 2',row:1},{documentId:'pdf',sheet:'PDF bank 2',row:2}];
 assert.equal(groupDocumentNotices(events).groups[0].rows[0].fragmentCount,2);
});
test('different conditions, calculations, currencies, statuses and decisions are never collapsed by similar wording',()=>{
 const events=[event('a','SAME',{kind:'discrepancy',calculation:{amount:'100',currency:'KZT'}}),event('b','SAME',{kind:'discrepancy',calculation:{amount:'101',currency:'KZT'}}),event('c','SAME',{kind:'discrepancy',calculation:{amount:'100',currency:'USD'}}),event('d','SAME',{kind:'discrepancy',calculation:{amount:'100',currency:'KZT'},rule:'Другое условие'}),event('e','SAME',{kind:'discrepancy',status:'confirmed'}),event('f','SAME',{kind:'signal'}),event('g','SAME',{kind:'decision'}),event('h','SAME',{kind:'decision'})];
 const g=groupDocumentNotices(events).groups[0];assert.equal(g.rows.length,8);assert.deepEqual(new Set(g.categories.map(c=>c.id)),new Set(['discrepancy','signal','decision']));assert.equal(g.noticeCount,6);
 const noRule=[event('x','PDF_LOW_SOURCE_QUALITY',{rule:''}),event('y','PDF_LOW_SOURCE_QUALITY',{rule:''})];assert.equal(groupDocumentNotices(noRule).noticeCount,2);
});
test('same filename and rule in different documents stay separate; multi-document comparisons keep both sources',()=>{
 const events=[event('a','SAME',{evidence:[{documentId:'one',name:'same.xlsx',sheet:'Лист',row:2}]}),event('b','SAME',{evidence:[{documentId:'two',name:'same.xlsx',sheet:'Лист',row:2}]}),event('c','SAME',{kind:'discrepancy',evidence:[{documentId:'one',name:'same.xlsx',row:2},{documentId:'two',name:'same.xlsx',row:3}]})];
 const model=groupDocumentNotices(events);assert.equal(model.groups.length,3);const joint=model.groups.find(g=>g.joint);assert.deepEqual(joint.documentIds,['one','two']);assert.equal(joint.rows[0].locations.length,2);assert.equal(model.assignedEventCount,3);
});
test('processing errors are explicit even with no notices and preserve page-level diagnostics',()=>{
 const failed={id:'failed',name:'failed.pdf',status:'failed',error:'Не удалось прочитать файл',summary:{pageAudit:{errors:[{page:4,error:'OCR недоступен'}]}}};
 const model=groupDocumentNotices([], [failed],{includeDocumentErrors:true});assert.equal(model.groups.length,1);assert.equal(model.groups[0].errors.length,2);assert.equal(model.groups[0].errors[1].source.page,4);assert.equal(model.inputEventCount,0);
 assert.equal(groupDocumentNotices([],[]).groups.length,0);assert.equal(groupDocumentNotices([],[{id:'fine',name:'fine.pdf',status:'extracted'}],{includeDocumentErrors:true}).groups.length,0);
});
test('many documents: stable pagination input, all original events retained without mutation',()=>{
 const events=deepFreeze(Array.from({length:2400},(_,i)=>event(String(i),'QUALITY',{evidence:[{documentId:`doc-${i%1200}`,name:`doc-${i%1200}.xlsx`,sheet:'Данные',row:i+1}]})));
 const model=groupDocumentNotices(events);assert.equal(model.groups.length,1200);assert.equal(model.assignedEventCount,2400);assert.equal(model.noticeCount,1200);assert.equal(model.groups.flatMap(g=>g.rows.flatMap(r=>r.members)).length,2400);
});
test('source links: case/document encoding and exact saved page; XLSX cell-derived row and fragment labels',()=>{
 assert.equal(noticeSourceUrl('case x&y',{documentId:'id/#?',page:31}),'/api/documents/id%2F%23%3F?caseId=case+x%26y&inline=1#page=31');
 assert.equal(noticeSourceLabel({page:4,pageTo:5}),'Страницы 4–5');assert.equal(noticeSourceLabel({sheet:'Данные',row:8,cell:'C8'}),'Данные, строка 8, C8');
 const row=groupDocumentNotices([event('x','WORKBOOK_FORMULA_ERRORS',{calculation:{errors:[{sheet:'Расчёт',cell:'C8'}]}})]).groups[0].rows[0];assert.equal(row.locations[0].row,8);
});
function loadComponent(react=React){const exports={};const code=ts.transpileModule(fs.readFileSync('app/components/document-notice-groups.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;vm.runInNewContext(code,{exports,require:id=>id==='react'?react:id==='react/jsx-runtime'?jsxRuntime:notices});return exports.default;}
test('real React SSR: compact single card and single document action; errors visible before expanding, safe escaped content',()=>{
 const Component=loadComponent();const html=renderToStaticMarkup(React.createElement(Component,{caseId:'case',documents:[{...doc,error:'<script>bad</script>'}],items:[event('1'),event('2','DOCUMENT_CLASSIFICATION_REQUIRED')]}));
 assert.equal((html.match(/<article /g)||[]).length,1);assert.equal((html.match(/>Открыть документ и замечания</g)||[]).length,1);assert.match(html,/Подробнее/);assert.match(html,/Текст: 30 из 31 страниц/);assert.match(html,/&lt;script&gt;bad/);assert.doesNotMatch(html,/<script>/);assert.match(html,/Ошибки обработки: 1/);assert.doesNotMatch(html,/Исходные замечания и проверка/);
});
test('real React SSR: no notices has empty state; first render of large list mounts at most 20 cards',()=>{
 const Component=loadComponent();assert.match(renderToStaticMarkup(React.createElement(Component,{caseId:'x',items:[]})),/замечаний нет/);
 const events=Array.from({length:200},(_,i)=>event(String(i),'QUALITY',{evidence:[{documentId:String(i),name:`doc${i}.pdf`}]}));const html=renderToStaticMarkup(React.createElement(Component,{caseId:'x',items:events}));assert.equal((html.match(/<article /g)||[]).length,20);assert.match(html,/1–20 из 200/);
});

// Execute the real TSX and its event handlers with instance-scoped hooks.
// This supplements SSR with deterministic expand, filter, paging and source checks.
function interactive(props){
 const instances=new Map();let context,effects=[],dirty=false;
 const hooks={useState:initial=>{const c=context,i=c.cursor++;if(!(i in c.slots))c.slots[i]=typeof initial==='function'?initial():initial;return [c.slots[i],value=>{const next=typeof value==='function'?value(c.slots[i]):value;if(!Object.is(next,c.slots[i])){c.slots[i]=next;dirty=true;}}];},useMemo:fn=>fn(),useEffect:(fn,deps)=>{const c=context,i=c.cursor++;if(!c.slots[i]||deps.some((d,n)=>!Object.is(d,c.slots[i][n]))){c.slots[i]=deps;effects.push(fn);}}};
 const Component=loadComponent(hooks);
 function resolve(node,path='root'){
  if(Array.isArray(node))return node.map((n,i)=>resolve(n,`${path}/${n?.key??i}`));
  if(!node||typeof node!=='object')return node;
  if(typeof node.type==='function'){const key=`${path}/${node.type.name}`;if(!instances.has(key))instances.set(key,{slots:[],cursor:0});const previous=context;context=instances.get(key);context.cursor=0;const result=node.type(node.props);context=previous;return resolve(result,`${key}/body`);}
  return {type:node.type,props:{...node.props,children:resolve(node.props?.children,`${path}/children`)}};
 }
 function render(){let tree;for(let attempts=0;attempts<5;attempts++){dirty=false;effects=[];tree=resolve(React.createElement(Component,props));for(const effect of effects)effect();if(!dirty)return tree;}throw Error('Unstable hooks');}
 function walk(node,predicate,out=[]){if(Array.isArray(node))node.forEach(n=>walk(n,predicate,out));else if(node&&typeof node==='object'){if(predicate(node))out.push(node);walk(node.props?.children,predicate,out);}return out;}
 const find=predicate=>walk(render(),predicate),textOf=node=>Array.isArray(node)?node.map(textOf).join(''):node&&typeof node==='object'?textOf(node.props?.children):String(node??'');
 const toggle=(predicate,open)=>{const details=find(n=>n.type==='details'&&predicate(n))[0];assert.ok(details);details.props.onToggle({currentTarget:{open}});return render();};
 return {find,render,toggle,textOf};
}
test('real handlers: expand/collapse, exact PDF links, row preview, original-event decisions stay separate',()=>{
 const selected=[],sources=[],opened=[];const events=[event('a','PDF_LOW_SOURCE_QUALITY'),event('b','PDF_LOW_SOURCE_QUALITY'),event('c','PDF_PAGES_WITHOUT_TEXT'),event('d','CUSTOM',{evidence:[{documentId:'table',name:'bank.xlsx',sheet:'Операции',row:8}]})];
 const s=interactive({caseId:'synthetic',items:events,documents:[doc],onSelectEvent:id=>selected.push(id),onDocument:id=>opened.push(id),onSource:source=>sources.push(source)});
 assert.equal(s.find(n=>n.type==='article').length,2);assert.equal(s.find(n=>n.type==='a').length,0);
 s.find(n=>n.type==='button'&&s.textOf(n)==='Открыть документ и замечания')[0].props.onClick();assert.equal(opened.length,1);
 for(const details of s.find(n=>n.type==='details'&&n.props.className==='notice-card-details'))details.props.onToggle({currentTarget:{open:true}});s.render();
 // Follow the saved table location independently of locale-specific sort order.
 const rowButton=s.find(n=>n.type==='button'&&s.textOf(n).includes('строка 8'))[0];assert.ok(rowButton);rowButton.props.onClick();assert.equal(sources[0].row,8);assert.equal(sources[0].sheet,'Операции');
 assert.ok(s.find(n=>n.type==='a'&&n.props.href.endsWith('#page=31')).length);assert.ok(s.find(n=>n.type==='a'&&n.props.href.endsWith('#page=2')).length);
 s.toggle(n=>s.textOf(n.props.children).startsWith('Исходные замечания и проверка (2)'),true);
 const buttons=s.find(n=>n.type==='button'&&s.textOf(n).startsWith('Открыть проверку замечания'));assert.equal(buttons.length,2);buttons[0].props.onClick();buttons[1].props.onClick();assert.deepEqual(selected,['a','b']);
 // Native details owns the open state; after a close the handler does not
 // discard mounted review forms, preserving unsaved user-entered notes.
 s.toggle(n=>s.textOf(n.props.children).startsWith('Исходные замечания и проверка (2)'),false);assert.equal(s.find(n=>n.type==='button'&&s.textOf(n).startsWith('Открыть проверку замечания')).length,2);
});
test('real handlers: document/category filters, paging through 1000 documents, empty result',()=>{
 const items=Array.from({length:1000},(_,i)=>event(String(i),'QUALITY',{kind:i%2?'signal':'data_quality',evidence:[{documentId:`d-${i}`,name:`Документ ${String(i).padStart(4,'0')}.pdf`}]}));
 const s=interactive({caseId:'x',items});assert.equal(s.find(n=>n.type==='article').length,20);
 s.find(n=>n.type==='button'&&s.textOf(n)==='Документы →')[0].props.onClick();assert.ok(s.find(n=>n.type==='h4'&&s.textOf(n).includes('0020')).length);
 s.find(n=>n.type==='input'&&n.props.type==='search')[0].props.onChange({target:{value:'Документ 0999'}});assert.equal(s.find(n=>n.type==='article').length,1);
 s.find(n=>n.type==='select')[0].props.onChange({target:{value:'data_quality'}});assert.equal(s.find(n=>n.type==='article').length,0);assert.ok(s.find(n=>n.props?.role==='status'&&s.textOf(n).includes('замечаний нет')).length);
 s.find(n=>n.type==='input'&&n.props.type==='search')[0].props.onChange({target:{value:''}});assert.equal(s.find(n=>n.type==='article').length,20);
 assert.ok(s.find(n=>n.props.className==='notice-count'&&s.textOf(n).includes('Замечаний: 1')).length);
});
test('saved processing-error events stay visible on closed cards even without document metadata',()=>{
 const events=[event('critical','READ_FAILED',{kind:'processing_error',description:'Чтение источника завершилось ошибкой'})];const Component=loadComponent();const html=renderToStaticMarkup(React.createElement(Component,{caseId:'x',items:events}));assert.match(html,/Чтение источника завершилось ошибкой/);assert.equal((html.match(/Ошибки обработки: 1/g)||[]).length,1);
});
