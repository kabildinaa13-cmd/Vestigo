import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import vm from 'node:vm';import ts from 'typescript';import {createRequire} from 'node:module';
import React from 'react';import {renderToString} from 'react-dom/server';
const require=createRequire(import.meta.url),root=process.cwd();
function renderer(browser=false){
 const cache=new Map();
 function load(filename){
  const file=['', '.tsx','.ts','.mjs','.js'].map(ext=>filename+ext).find(f=>fs.existsSync(f)&&fs.statSync(f).isFile());if(!file)throw Error('Missing client module: '+filename);
  if(cache.has(file))return cache.get(file).exports;const module={exports:{}};cache.set(file,module);
  const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true,allowJs:true}}).outputText;
  const resolve=id=>id.startsWith('@/')?load(path.join(root,id.slice(2))):id.startsWith('.')?load(path.resolve(path.dirname(file),id)):require(id);
  vm.runInNewContext(code,{exports:module.exports,module,require:resolve,console,URL,URLSearchParams,AbortController,Headers,TextEncoder,TextDecoder,FormData,Blob,File,fetch:()=>{throw Error('First render must not fetch')},...(browser?{window:{location:{search:'?caseId=wrong-browser-value&currency=USD',origin:'http://synthetic.local'}},localStorage:{getItem:()=> 'dark'}}:{})},{filename:file});return module.exports;
 }
 const Workspace=load(path.join(root,'app/analytics/analytics-workspace')).default,Scope=load(path.join(root,'app/analytics/case-scope')),Dashboard=load(path.join(root,'app/analytics/analytics-dashboard')).PlatformDashboard;
 return {Workspace,Scope,Dashboard,render:scope=>renderToString(React.createElement(Workspace,{scope}))};
}
const scope={id:'synthetic-case-a',number:'SYNTHETIC-A',status:'active',currency:'EUR'};
test('regression reproduction: losing case context adds Sources/Uploads; the workspace owns its provider',()=>{
 const r=renderer();const detached=renderToString(React.createElement(r.Dashboard,{userName:'SYNTHETIC-A',userEmail:'Только материалы этого дела',isAdmin:false}));assert.match(detached,/aria-label="Источники"/);assert.match(detached,/aria-label="Загрузки"/);
 const html=r.render(scope);assert.doesNotMatch(html,/aria-label="Источники"/);assert.doesNotMatch(html,/aria-label="Загрузки"/);assert.match(html,/Связей по операциям/);assert.match(html,/Документы выбранного дела/);assert.match(html,/synthetic-case-a/);
});
test('actual client subtree: SSR and initial browser render agree on scope/menu even with conflicting URL and saved dark theme',()=>{
 const server=renderer(false).render(scope),client=renderer(true).render(scope);assert.equal(client,server);assert.doesNotMatch(client,/wrong-browser-value/);assert.match(client,/value="EUR" selected=""/);
});
test('shared archive is explicit null, not a fallback when a case is selected',()=>{
 const r=renderer(),archive=r.render(null);assert.match(archive,/aria-label="Источники"/);assert.match(archive,/aria-label="Загрузки"/);assert.doesNotMatch(archive,/case-scope-banner/);assert.equal(archive,renderer(true).render(null));
 const other=r.render({...scope,id:'synthetic-case-b',number:'SYNTHETIC-B'});assert.match(other,/synthetic-case-b/);assert.doesNotMatch(other,/synthetic-case-a/);
});
test('server route uses a single client entry and dashboard resets on case/currency change, without suppressing mismatches',()=>{
 const page=fs.readFileSync('app/analytics/page.tsx','utf8'),workspace=fs.readFileSync('app/analytics/analytics-workspace.tsx','utf8');assert.match(page,/import AnalyticsWorkspace/);assert.doesNotMatch(page,/<PlatformDashboard|<CaseScopeProvider/);assert.match(workspace,/^"use client"/);assert.match(workspace,/<CaseScopeProvider scope=\{scope\}>/);assert.match(workspace,/key=\{scope\?`\$\{scope.id\}:\$\{scope.currency\}`:'legacy'\}/);const executable=ts.transpileModule(workspace,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,removeComments:true}}).outputText;assert.doesNotMatch(executable,/suppressHydrationWarning|ssr:\s*false|typeof window|localStorage/);
});
