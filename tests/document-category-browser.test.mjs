import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
import ts from "typescript";
import * as documentTypes from "../app/lib/document-types.mjs";

const code=ts.transpileModule(readFileSync(new URL("../app/components/document-category-browser.tsx",import.meta.url),"utf8"),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX},
}).outputText;
const jsx=(type,props)=>({type,props});
function setup({caseId="case / control",loading=false}={}){
  let selected="",id=0,cleanup,wasOpen;
  const registryCalls=[];
  const dialog={open:false,showModal(){this.open=true;},close(){this.open=false;}};
  const ref={current:null};
  let effect;
  const react={
    useState:()=>[selected,value=>{selected=value;}],
    useMemo:make=>make(),useRef:()=>ref,useId:()=>`test-${++id}`,
    useEffect:(fn,[open])=>{if(open!==wasOpen){effect=()=>{cleanup?.();cleanup=fn();};wasOpen=open;}},
  };
  const exports={};
  runInNewContext(code,{exports,URLSearchParams,require:path=>path==="react"?react:path==="react/jsx-runtime"?{jsx,jsxs:jsx,Fragment:"fragment"}:documentTypes});
  const props={caseId,loading,onShowInRegistry:id=>registryCalls.push(id),documents:[
    {id:"doc/one",name:"Выписка.xlsx",groupId:"bank",typeId:"statement"},
    {id:"doc-two",name:"Квитанция.pdf",groupId:"bank",typeId:"receipt",excluded:true},
    {id:"doc-three",name:"Акт.txt",groupId:"primary",typeId:"completion_act"},
  ]};
  function render(){
    id=0;
    const tree=exports.default(props);
    ref.current=find(tree,"dialog").length?dialog:null;
    effect?.();effect=undefined;
    return tree;
  }
  return {render,dialog,registryCalls};
}
function find(node,type){
  if(Array.isArray(node))return node.flatMap(n=>find(n,type));
  if(!node?.props)return [];
  return [...(node.type===type?[node]:[]),...find(node.props.children,type)];
}
function text(node){
  if(Array.isArray(node))return node.map(text).join("");
  return node?.props?text(node.props.children):node===false?"":String(node??"");
}
const button=(tree,label)=>find(tree,"button").find(node=>text(node).startsWith(label));

test("clicking a category opens only its saved files; the count, original links and registry action match",()=>{
  const s=setup();
  const trigger=button(s.render(),"Банковские документы");
  assert.equal(trigger.props["aria-haspopup"],"dialog");
  assert.match(text(trigger),/Документов: 2/);
  trigger.props.onClick();
  const modal=find(s.render(),"dialog")[0];
  assert.equal(s.dialog.open,true);
  const originals=find(modal,"a");
  assert.deepEqual(originals.map(text),["Выписка.xlsx","Квитанция.pdf"]);
  assert.equal(originals[0].props.href,"/api/documents/doc%2Fone?caseId=case+%2F+control&inline=1");
  assert.match(text(modal),/Убран из анализа/);
  button(modal,"Показать в реестре").props.onClick();
  assert.equal(s.dialog.open,false);
  assert.deepEqual(s.registryCalls,["bank"]);
  assert.equal(find(s.render(),"dialog").length,0);
});

test("empty categories open; close and Escape dismiss the dialog; the categories wait for a case and its registry",()=>{
  const s=setup();
  button(s.render(),"Договорные документы").props.onClick();
  const empty=find(s.render(),"dialog")[0];
  assert.match(text(empty),/В этой категории пока нет документов/);
  assert.equal(find(empty,"a").length,0);
  button(empty,"Закрыть").props.onClick();
  assert.equal(find(s.render(),"dialog").length,0);
  button(s.render(),"Первичные учётные документы").props.onClick();
  let prevented=false;
  find(s.render(),"dialog")[0].props.onCancel({preventDefault(){prevented=true;}});
  assert.equal(prevented,true);
  assert.equal(s.dialog.open,false);
  assert.equal(find(s.render(),"dialog").length,0);
  for(const scope of [{caseId:""},{loading:true}]){
    assert.equal(button(setup(scope).render(),"Банковские документы").props.disabled,true);
  }
});
