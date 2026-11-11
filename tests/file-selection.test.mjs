import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import ts from 'typescript';
import * as documentTypes from '../app/lib/document-types.mjs';import * as progress from '../app/lib/document-progress.mjs';import * as search from '../app/lib/saved-document-search.mjs';
// Render the real component with deterministic hooks and exercise its actual
// picker, removal and upload handlers. No browser session or working DB used.
function setup(){
 const slots=[],sent=[],fail=new Set();let cursor=0;
 const state=initial=>{const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return [slots[i],next=>{slots[i]=typeof next==='function'?next(slots[i]):next;}];};
 const react={useState:state,useRef:initial=>{const i=cursor++;if(!(i in slots))slots[i]={current:initial};return slots[i];},useCallback:fn=>fn,useEffect:()=>{}};
 const jsx=(type,props,key)=>({type,props:props||{},key}),stub=()=>null;
 const modules={react,'react/jsx-runtime':{jsx,jsxs:jsx,Fragment:'fragment'},'@/app/lib/document-types.mjs':documentTypes,'../lib/document-progress.mjs':progress,'../lib/saved-document-search.mjs':search,'./bank-settings':{__esModule:true,default:stub,emptyBankSettings:{}},'./document-analysis-progress':{__esModule:true,default:stub,useDocumentProgress:()=>({jobs:[],online:true,error:'',watch:()=>{},dismiss:()=>{},retry:()=>{}})},'../lib/upload-document':{uploadDocument:async data=>{sent.push(data);if(fail.has(data.get('file').name))throw Error('Synthetic failure');return {id:'synthetic-saved'};}}};
 const exported={};const code=ts.transpileModule(fs.readFileSync('app/components/documents-panel.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
 class Form extends FormData{constructor(){super();}}
 vm.runInNewContext(code,{exports:exported,require:name=>modules[name]||{__esModule:true,default:stub},FormData:Form,fetch:async url=>({ok:true,json:async()=>url.startsWith('/api/documents')?{documents:[]}:{episodes:[]}}),Error,window:{addEventListener(){},removeEventListener(){}}});
 const props={cases:[{id:'synthetic-case',caseNumber:'SYNTHETIC',status:'active'}],caseId:'synthetic-case',onCaseChange:()=>{},onUploaded:async()=>{},onCreateCase:()=>{}};
 const render=()=>{cursor=0;return exported.default(props);};
 function walk(node,predicate,out=[]){if(Array.isArray(node)){for(const child of node)walk(child,predicate,out);}else if(node&&typeof node==='object'){if(predicate(node))out.push(node);walk(node.props?.children,predicate,out);}return out;}
 const find=(predicate)=>walk(render(),predicate),picker=()=>find(n=>n.type==='input'&&n.props.type==='file')[0];
 const choose=files=>{const input={files,value:'fake-path',click(){}};const p=picker();p.props.ref.current=input;p.props.onChange({currentTarget:input});assert.equal(input.value,'');};
 const names=()=>find(n=>n.type==='ul'&&n.props['aria-label']==='Выбранные файлы для загрузки').flatMap(n=>Array.from(n.props.children).map(li=>li.props.children[0].props.children));
 const button=text=>find(n=>n.type==='button'&&n.props.children===text)[0];
 const submit=()=>find(n=>n.type==='form'&&n.props.className==='document-upload-form form-grid')[0].props.onSubmit({preventDefault(){},currentTarget:{}});
 return {choose,names,button,submit,picker,sent,fail,find};
}
const file=(name,body='data')=>new File([body],name,{type:'application/pdf',lastModified:1});
test('picker: repeated choices append, cancelling preserves selection, all selected files upload in order',async()=>{const s=setup(),a=file('one.pdf','A'),b=file('two.pdf','B'),c=file('three.pdf','C');s.choose([a]);s.choose([b,c]);assert.deepEqual(s.names(),['one.pdf','two.pdf','three.pdf']);s.choose([]);assert.equal(s.names().length,3);await s.submit();assert.deepEqual(s.sent.map(d=>d.get('file').name),['one.pdf','two.pdf','three.pdf']);assert.deepEqual(await Promise.all(s.sent.map(d=>d.get('file').text())),['A','B','C']);assert.ok(s.sent.every(d=>d.get('caseId')==='synthetic-case'));assert.deepEqual(s.names(),[]);});
test('picker: removes one selected item, not another equally named file; removed file can be selected again',async()=>{const s=setup(),a=file('same.pdf','A'),b=file('same.pdf','B');s.choose([a,b]);s.find(n=>n.type==='button'&&n.props['aria-label']==='Удалить из списка: same.pdf')[0].props.onClick();assert.equal(s.names().length,1);s.choose([a]);assert.equal(s.names().length,2);await s.submit();assert.deepEqual(await Promise.all(s.sent.map(d=>d.get('file').text())),['B','A']);});
test('picker: clear-all resets selection; add button opens native picker and does not submit the form',()=>{const s=setup();let clicks=0;const p=s.picker();p.props.ref.current={click(){clicks++;},value:''};assert.equal(s.button('Выбрать файлы').props.type,'button');s.button('Выбрать файлы').props.onClick();assert.equal(clicks,1);s.choose([file('a.pdf'),file('b.pdf')]);assert.equal(s.button('Добавить ещё файлы').props.type,'button');assert.equal(s.button('Очистить список').props.type,'button');s.button('Очистить список').props.onClick();assert.deepEqual(s.names(),[]);s.choose([file('a.pdf')]);assert.deepEqual(s.names(),['a.pdf']);});
test('picker: failed upload stays selected and adding another file does not lose it or resend successful files',async()=>{const s=setup();s.fail.add('retry.pdf');s.choose([file('saved.pdf'),file('retry.pdf')]);await s.submit();assert.deepEqual(s.names(),['retry.pdf']);s.choose([file('new.pdf')]);assert.deepEqual(s.names(),['retry.pdf','new.pdf']);s.fail.clear();await s.submit();assert.deepEqual(s.sent.map(d=>d.get('file').name),['saved.pdf','retry.pdf','retry.pdf','new.pdf']);assert.deepEqual(s.names(),[]);});
test('picker: a multi-file drop appends to the same queue and each item is sent',async()=>{
 const s=setup();s.choose([file('first.xlsx')]);
 const zone=()=>s.find(n=>n.type==='div'&&n.props.className?.startsWith('document-file-picker-actions'))[0];
 let prevented=0;const preventDefault=()=>{prevented++;};
 const dataTransfer={types:['Files'],files:[file('statement.csv'),file('documents.zip')],dropEffect:'none'};
 zone().props.onDragOver({dataTransfer,preventDefault});
 assert.equal(dataTransfer.dropEffect,'copy');assert.match(zone().props.className,/is-dragging/);
 zone().props.onDrop({dataTransfer,preventDefault});
 assert.equal(prevented,2);assert.doesNotMatch(zone().props.className,/is-dragging/);
 assert.deepEqual(s.names(),['first.xlsx','statement.csv','documents.zip']);
 await s.submit();assert.deepEqual(s.sent.map(d=>d.get('file').name),['first.xlsx','statement.csv','documents.zip']);
});
