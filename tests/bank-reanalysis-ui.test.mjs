import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import ts from 'typescript';
function setup(){
 const data={name:'synthetic.xlsx',status:'review',error:'',text:'',textTruncated:false,summary:{rows:10,tables:[{sheet:'Выписка',columns:['Дата'],mapping:{date:'Дата'}}],warnings:[]},rows:[],offset:0,limit:50,options:{groupId:'bank'}};
 const slots=[data],calls=[];let cursor=0,updated=0;
 const react={useState:initial=>{const index=cursor++;if(!(index in slots))slots[index]=initial;return [slots[index],value=>{slots[index]=typeof value==='function'?value(slots[index]):value;}];},useRef:value=>({current:value}),useEffect:()=>{}};
 const jsx=(type,props)=>({type,props:props||{}}),Preview=()=>null,Stub=()=>null,exports={};
 const code=ts.transpileModule(fs.readFileSync('app/components/extraction-preview.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
 const fetch=async(url,options={})=>{if(options.method==='POST'){const body=JSON.parse(options.body);calls.push(body);return {ok:true,json:async()=>body.preview?{preview:true,fingerprint:'checked-settings',operationsBefore:0,operationsAfter:8,requiredActions:[],sample:[]}: {summary:{rows:10}}};}return {ok:true,json:async()=>data};};
 vm.runInNewContext(code,{exports,require:id=>id==='react'?react:id==='react/jsx-runtime'?{jsx,jsxs:jsx}:id==='./bank-reanalysis-preview'?{__esModule:true,default:Preview}:{__esModule:true,default:Stub},fetch,AbortController,encodeURIComponent,Error});
 const render=()=>{cursor=0;return exports.default({caseId:'synthetic',documentId:'doc',onClose(){},onUpdated:async()=>{updated++;}});};
 function walk(node,predicate,out=[]){if(Array.isArray(node))node.forEach(n=>walk(n,predicate,out));else if(node&&typeof node==='object'){if(predicate(node))out.push(node);walk(node.props?.children,predicate,out);}return out;}
 const find=p=>walk(render(),p),flush=()=>new Promise(r=>setImmediate(r));
 return {calls,find,flush,updated:()=>updated,preview:()=>find(n=>n.type===Preview)[0]};
}
test('real extraction preview handler reads first, does not update case, applies only after explicit confirmation with checked fingerprint',async()=>{
 const s=setup();s.find(n=>n.type==='button'&&n.props.children==='Предварительно прочитать и проверить')[0].props.onClick();await s.flush();assert.equal(s.calls.length,1);assert.equal(s.calls[0].preview,true);assert.equal(s.updated(),0);assert.ok(s.preview());
 s.preview().props.onConfirm();await s.flush();assert.equal(s.calls.length,2);assert.equal(s.calls[1].preview,undefined);assert.equal(s.calls[1].previewFingerprint,'checked-settings');assert.equal(s.updated(),1);assert.equal(s.preview(),undefined);
});
test('cancelling real bank preview does not send apply request or update saved case',async()=>{
 const s=setup();s.find(n=>n.type==='button'&&n.props.children==='Предварительно прочитать и проверить')[0].props.onClick();await s.flush();s.preview().props.onCancel();await s.flush();assert.equal(s.calls.length,1);assert.equal(s.updated(),0);assert.equal(s.preview(),undefined);
});
