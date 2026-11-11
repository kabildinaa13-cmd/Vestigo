import test from "node:test";import assert from "node:assert/strict";
import fs from "node:fs";import path from "node:path";import os from "node:os";
import {openDatabase,createCase,listCases} from "../app/lib/vestigo-db.mjs";
import {runAsUser} from "../app/lib/request-identity.mjs";
import {accountsExist,setupCode,createFirstAccount,createAccount,loginAccount,findSession,logoutAccount,changePassword,listAccounts,sessionCookie,cookieToken} from "../app/lib/accounts.mjs";
const password="Synthetic good password 2026!";
function setup(){const directory=fs.mkdtempSync(path.join(os.tmpdir(),"vestigo-accounts-")),db=openDatabase({dataDirectory:directory});return {directory,db,close(){db.close();fs.rmSync(directory,{recursive:true,force:true});}};}
test("first account requires a local one-time code, hashes salted passwords, and never exposes roles or hashes",async()=>{const s=setup();try{
 const old=createCase(s.db,{caseNumber:"EXISTING"});assert.equal(accountsExist(s.db),false);const code=setupCode(s.db);assert.ok(code.length>=24);await assert.rejects(createFirstAccount(s.db,{login:"alice",password,setupCode:"wrong"}),e=>e.status===403);
 const a=await createFirstAccount(s.db,{login:"Alice",password,displayName:"Алиса",setupCode:code});assert.deepEqual(Object.keys(a.user).sort(),["displayName","id","login"]);assert.equal(a.user.login,"alice");assert.equal(listCases(s.db)[0].id,old.id);assert.equal(accountsExist(s.db),true);assert.equal(setupCode(s.db),null);
 await assert.rejects(createFirstAccount(s.db,{login:"other",password,setupCode:code}),e=>e.status===409);
 const stored=s.db.prepare("SELECT password_hash FROM account_credentials").get().password_hash;assert.match(stored,/^scrypt\$32768\$/);assert.ok(!stored.includes(password));assert.ok(!JSON.stringify(listAccounts(s.db)).includes("role"));
 const storedSession=s.db.prepare("SELECT token_hash FROM account_sessions").get().token_hash;assert.notEqual(storedSession,a.token);assert.equal(findSession(s.db,a.token).id,a.user.id);assert.equal(findSession(s.db,"A".repeat(43)),null);
 const cookie=sessionCookie(a.token);assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Strict/);assert.match(sessionCookie(a.token,{secure:true}),/; Secure/);assert.equal(cookieToken(cookie),a.token);assert.equal(cookieToken(cookie+"; "+cookie),"");
 }finally{s.close();}});
test("accounts have equal case access and actions retain the actual account author",async()=>{const s=setup();try{
 const a=await createFirstAccount(s.db,{login:"alice",password,setupCode:setupCode(s.db)});const b=await createAccount(s.db,a.user,{login:"bob",password,currentPassword:password});const c=runAsUser(a.user,()=>createCase(s.db,{caseNumber:"SHARED"}));assert.equal(runAsUser(b,()=>listCases(s.db))[0].id,c.id);assert.equal(s.db.prepare("SELECT responsible_user_id FROM cases WHERE id=?").get(c.id).responsible_user_id,a.user.id);
 const hashA=s.db.prepare("SELECT password_hash FROM account_credentials WHERE user_id=?").get(a.user.id).password_hash,hashB=s.db.prepare("SELECT password_hash FROM account_credentials WHERE user_id=?").get(b.id).password_hash;assert.notEqual(hashA,hashB);
 await assert.rejects(createAccount(s.db,b,{login:"ALICE",password,currentPassword:password}),e=>e.status===409);await assert.rejects(createAccount(s.db,b,{login:"mallory",password,currentPassword:"wrong"}),e=>e.status===403);
 }finally{s.close();}});
test("login, expiry, logout, password change and persistence invalidate the right sessions",async()=>{const s=setup();try{
 const a=await createFirstAccount(s.db,{login:"alice",password,setupCode:setupCode(s.db)});await assert.rejects(loginAccount(s.db,{login:"local-admin",password}),e=>e.status===401);await assert.rejects(loginAccount(s.db,{login:"missing",password}),e=>e.status===401);const second=await loginAccount(s.db,{login:"ALICE",password});
 const b=await createAccount(s.db,a.user,{login:"bob",password,currentPassword:password}),bSession=await loginAccount(s.db,{login:"bob",password});
 const changed=await changePassword(s.db,a.user,{currentPassword:password,password:password+" changed"});assert.equal(findSession(s.db,a.token),null);assert.equal(findSession(s.db,second.token),null);assert.equal(findSession(s.db,bSession.token).id,b.id);assert.equal(findSession(s.db,changed.token).id,a.user.id);
 await assert.rejects(loginAccount(s.db,{login:"alice",password}),e=>e.status===401);const again=await loginAccount(s.db,{login:"alice",password:password+" changed"});logoutAccount(s.db,again.token);assert.equal(findSession(s.db,again.token),null);assert.equal(findSession(s.db,changed.token,Date.now()+13*3600000),null);
 const other=openDatabase({dataDirectory:s.directory});try{assert.equal(findSession(other,changed.token).id,a.user.id);}finally{other.close();}
 }finally{s.close();}});
test("login throttling is persistent; two simultaneous initial setups cannot create two first accounts",async()=>{const s=setup();try{
 const input={login:"alice",password,setupCode:setupCode(s.db)};const attempts=await Promise.allSettled([createFirstAccount(s.db,input),createFirstAccount(s.db,{...input,login:"bob"})]);assert.equal(attempts.filter(a=>a.status==="fulfilled").length,1);assert.equal(listAccounts(s.db).length,1);
 for(let i=0;i<10;i++)await assert.rejects(loginAccount(s.db,{login:"missing",password}),e=>e.status===401);await assert.rejects(loginAccount(s.db,{login:"missing",password}),e=>e.status===429);
 const other=openDatabase({dataDirectory:s.directory});try{await assert.rejects(loginAccount(other,{login:"missing",password}),e=>e.status===429);}finally{other.close();}
 }finally{s.close();}});
