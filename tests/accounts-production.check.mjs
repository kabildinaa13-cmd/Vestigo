// Run AFTER npm run build: node --test tests/accounts-production.check.mjs
import test from "node:test";import assert from "node:assert/strict";import fs from "node:fs";import path from "node:path";import os from "node:os";import {spawn,spawnSync} from "node:child_process";import {once} from "node:events";
test("built production server requires login for both pages and APIs",{timeout:60000},async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),"vestigo-auth-production-")),base="http://localhost:3293",code="synthetic-production-setup-code-2026";let logs="";
 const child=spawn(process.execPath,["node_modules/vinext/dist/cli.js","start","--port","3293"],{cwd:process.cwd(),windowsHide:true,env:{...process.env,VESTIGO_DATA_DIR:directory,VESTIGO_SETUP_TOKEN:code},stdio:["ignore","pipe","pipe"]});child.stdout.on("data",v=>logs=(logs+v).slice(-4000));child.stderr.on("data",v=>logs=(logs+v).slice(-4000));
 try{
  let ready=false;for(let i=0;i<80;i++){if(child.exitCode!==null)throw Error(logs);try{if((await fetch(base+"/api/auth/session")).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,200));}assert.ok(ready,logs);
  assert.equal((await fetch(base+"/api/dashboard")).status,401);assert.equal((await fetch(base+"/analytics",{redirect:"manual"})).status,303);
  const response=await fetch(base+"/api/auth/setup",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({setupCode:code,login:"production-tester",password:"Synthetic production password 2026!"})});assert.equal(response.status,201,await response.clone().text());const cookie=response.headers.get("set-cookie").split(";")[0];assert.equal((await fetch(base+"/api/dashboard",{headers:{cookie}})).status,200);assert.equal((await fetch(base+"/analytics",{headers:{cookie}})).status,200);
 }finally{if(child.exitCode===null){const done=once(child,"exit");if(process.platform==="win32")spawnSync("taskkill",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});else child.kill();await Promise.race([done,new Promise(r=>setTimeout(r,1000))]);}fs.rmSync(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});
