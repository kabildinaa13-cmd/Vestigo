import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as protocol from "../app/lib/upload-protocol.mjs";
function setup(){
  const instances=[],timers=[];
  class XHR {constructor(){this.upload={};this.headers={};instances.push(this);}open(method,url){this.method=method;this.url=url;}setRequestHeader(key,value){this.headers[key]=value;}send(data){this.data=data;}}
  const exports={};
  const js=ts.transpileModule(fs.readFileSync("app/lib/upload-document.ts","utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInNewContext(js,{exports,XMLHttpRequest:XHR,Error,SyntaxError,JSON,require:name=>{assert.equal(name,"./upload-protocol.mjs");return protocol;},setTimeout:fn=>timers.push(fn)});
  return {upload:exports.uploadDocument,instances,timers};
}
function form(){const data=new FormData();data.set("file",new Blob(["test"]),"Пример.zip");data.set("caseId","test-case");return data;}
test("upload sends raw bytes with UTF8 metadata and reports actual transfer progress",async()=>{
  const s=setup(),observed=[],data=form(),promise=s.upload(data,(loaded,total)=>observed.push([loaded,total]));
  const xhr=s.instances[0];assert.equal(xhr.method,"POST");assert.equal(xhr.url,"/api/documents");assert.equal(xhr.data,data.get("file"));
  assert.equal(xhr.headers["content-type"],"application/octet-stream");assert.equal(protocol.decodeUploadMetadata(xhr.headers[protocol.UPLOAD_METADATA_HEADER]).name,"Пример.zip");
  xhr.upload.onprogress({loaded:50,total:200,lengthComputable:true});assert.deepEqual(observed,[[50,200]]);
  xhr.upload.onprogress({loaded:75,total:0,lengthComputable:false});assert.deepEqual(observed[1],[75,0]);
  xhr.status=201;xhr.responseText='{"id":"synthetic"}';xhr.onload();assert.equal((await promise).id,"synthetic");
});
test("failed, oversized or invalid server responses never become successful uploads",async()=>{
  for(const kind of ["server","invalid","large","timeout"]){
    const s=setup(),promise=s.upload(form(),()=>{}),xhr=s.instances[0];
    if(kind==="timeout")xhr.ontimeout();else{xhr.status=kind==="server"?400:kind==="large"?413:200;xhr.responseText=kind==="server"?'{"error":"Rejected"}':'not json';xhr.onload();}
    await assert.rejects(promise,kind==="large"?/50 МБ/:undefined);
  }
});
test("connection retries are bounded; the file and metadata do not change",async()=>{
  const s=setup(),data=form(),promise=s.upload(data,()=>{});
  s.instances[0].onerror();assert.equal(s.timers.length,1);s.timers.shift()();
  s.instances[1].onerror();s.timers.shift()();s.instances[2].onerror();
  await assert.rejects(promise,/прервано/);assert.equal(s.instances.length,3);assert.equal(s.timers.length,0);
  assert.ok(s.instances.every(xhr=>xhr.data===data.get("file")));
});
test("temporary database-busy response is retried, permanent errors are not",async()=>{
  const s=setup(),promise=s.upload(form(),()=>{}),first=s.instances[0];
  first.status=503;first.responseText='{"error":"database busy"}';first.onload();assert.equal(s.timers.length,1);s.timers.shift()();
  const second=s.instances[1];second.status=201;second.responseText='{"id":"saved-on-retry"}';second.onload();assert.equal((await promise).id,"saved-on-retry");
  const failed=s.upload(form(),()=>{}),third=s.instances[2];third.status=400;third.responseText='{"error":"Invalid file"}';third.onload();
  await assert.rejects(failed,/Invalid file/);assert.equal(s.timers.length,0);
});
