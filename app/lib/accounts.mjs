import {randomBytes,randomUUID,createHash,scrypt as derive,timingSafeEqual} from "node:crypto";
import {promisify} from "node:util";
import fs from "node:fs";import path from "node:path";
import {DEFAULT_DEPARTMENT_ID} from "./vestigo-db.mjs";
const scrypt=promisify(derive),hash=v=>createHash("sha256").update(v).digest("hex");
let deriving=0;
async function deriveKey(value,salt){if(deriving>=4)throw new AccountError("Сервис входа занят. Повторите через несколько секунд",429);deriving++;try{return await scrypt(value,salt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024});}finally{deriving--;}}
export const SESSION_COOKIE="vestigo_session",SESSION_SECONDS=12*60*60;
const IDLE_MS=2*60*60*1000;
export class AccountError extends Error{constructor(message,status=400){super(message);this.status=status;}}
export function migrateAccounts(db){db.exec(`
 CREATE TABLE IF NOT EXISTS account_credentials(user_id TEXT PRIMARY KEY REFERENCES users(id),login_key TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,password_changed_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS account_sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,last_seen_at INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS account_sessions_user ON account_sessions(user_id);
 CREATE TABLE IF NOT EXISTS account_login_limits(bucket TEXT PRIMARY KEY,started_at INTEGER NOT NULL,failures INTEGER NOT NULL);
`);}
const publicUser=row=>({id:row.id,login:row.login,displayName:row.display_name});
function audit(db,userId,action,details={}){db.prepare("INSERT INTO audit_log(id,department_id,user_id,action,entity_type,entity_id,details_json,created_at) VALUES(?,?,?,?, 'account',?,?,?)").run(randomUUID(),DEFAULT_DEPARTMENT_ID,userId,action,userId,JSON.stringify(details),new Date().toISOString());}
export function normalizeLogin(value){const login=String(value||"").normalize("NFKC").trim().toLocaleLowerCase("ru");if(!/^[a-zа-яё0-9][a-zа-яё0-9._-]{2,63}$/u.test(login))throw new AccountError("Логин: от 3 до 64 букв, цифр, точек, дефисов или подчёркиваний");return login;}
function passwordText(value){if(typeof value!=="string"||[...value].length<12||[...value].length>128||Buffer.byteLength(value)>512)throw new AccountError("Пароль должен содержать от 12 до 128 символов");return value;}
async function passwordHash(value){const salt=randomBytes(16).toString("hex"),key=await deriveKey(passwordText(value),salt);return `scrypt$32768$${salt}$${key.toString("hex")}`;}
// Equal-cost invalid-account verification prevents the fast username-existence path.
const dummy="scrypt$32768$00000000000000000000000000000000$"+"0".repeat(128);
export async function verifyPassword(value,encoded){if(typeof value!=="string"||Buffer.byteLength(value)>512)return false;const parts=String(encoded||dummy).split("$");if(parts.length!==4||parts[0]!=="scrypt"||parts[1]!=="32768"||!/^[a-f0-9]{32}$/.test(parts[2])||!/^[a-f0-9]{128}$/.test(parts[3]))return false;
 const actual=await deriveKey(value,parts[2]);return timingSafeEqual(actual,Buffer.from(parts[3],"hex"));}
export function accountsExist(db){migrateAccounts(db);return !!db.prepare("SELECT 1 FROM account_credentials LIMIT 1").get();}
export function setupCode(db){if(accountsExist(db))return null;const supplied=process.env.VESTIGO_SETUP_TOKEN;if(supplied){if(supplied.length<24)throw new Error("VESTIGO_SETUP_TOKEN должен содержать не менее 24 символов");return supplied;}
 const directory=path.dirname(db.prepare("PRAGMA database_list").all().find(r=>r.name==="main").file),file=path.join(directory,"first-account-code.txt");
 try{return fs.readFileSync(file,"utf8").trim();}catch(error){if(error.code!=="ENOENT")throw error;}
 const code=randomBytes(24).toString("base64url");try{fs.writeFileSync(file,code+"\n",{flag:"wx",mode:0o600});return code;}catch(error){if(error.code==="EEXIST")return fs.readFileSync(file,"utf8").trim();throw error;}}
function validSetupCode(actual,expected){const a=hash(String(actual||"")),b=hash(String(expected||""));return timingSafeEqual(Buffer.from(a),Buffer.from(b));}
function session(db,user){const token=randomBytes(32).toString("base64url"),now=Date.now();db.prepare("DELETE FROM account_sessions WHERE expires_at<=? OR last_seen_at<=?").run(now,now-IDLE_MS);db.prepare("INSERT INTO account_sessions VALUES(?,?,?,?,?)").run(hash(token),user.id,now,now+SESSION_SECONDS*1000,now);return {user:publicUser(user),token};}
function insertAccount(db,input,encoded){const login=normalizeLogin(input.login),name=String(input.displayName||login).trim();if(!name||name.length>120)throw new AccountError("Имя должно содержать не более 120 символов");
 if(db.prepare("SELECT 1 FROM users WHERE lower(login)=?").get(login)||db.prepare("SELECT 1 FROM account_credentials WHERE login_key=?").get(login))throw new AccountError("Такой логин уже занят",409);
 const id=randomUUID(),now=new Date().toISOString();
 // Historical users.role is retained only for schema compatibility; it is not
 // exposed or consulted. Every password account has the same full access.
 db.prepare("INSERT INTO users(id,department_id,login,display_name,role,active,created_at) VALUES(?,?,?,?, 'investigator',1,?)").run(id,DEFAULT_DEPARTMENT_ID,login,name,now);
 db.prepare("INSERT INTO account_credentials VALUES(?,?,?,?)").run(id,login,encoded,now);return {id,login,display_name:name};}
export async function createFirstAccount(db,input){const code=setupCode(db);if(!code)throw new AccountError("Первый аккаунт уже создан. Войдите в систему",409);if(!validSetupCode(input.setupCode,code))throw new AccountError("Неверный одноразовый код настройки",403);
 const encoded=await passwordHash(input.password);db.exec("BEGIN IMMEDIATE");try{if(db.prepare("SELECT 1 FROM account_credentials LIMIT 1").get())throw new AccountError("Первый аккаунт уже создан",409);const user=insertAccount(db,input,encoded);audit(db,user.id,"account.first_created");const result=session(db,user);db.exec("COMMIT");return result;}catch(e){db.exec("ROLLBACK");throw e;}}
function checkLimits(db,key,now=Date.now()){for(const [bucket,limit] of [["login:"+hash(key),10],["all",100]]){const row=db.prepare("SELECT * FROM account_login_limits WHERE bucket=?").get(bucket);if(row&&row.started_at>now-15*60*1000&&row.failures>=limit)throw new AccountError("Слишком много попыток входа. Повторите через 15 минут",429);}}
function failedAttempt(db,key){const now=Date.now();for(const bucket of ["login:"+hash(key),"all"]){db.prepare("INSERT INTO account_login_limits VALUES(?,?,1) ON CONFLICT(bucket) DO UPDATE SET started_at=CASE WHEN started_at<? THEN excluded.started_at ELSE started_at END,failures=CASE WHEN started_at<? THEN 1 ELSE failures+1 END").run(bucket,now,now-15*60*1000,now-15*60*1000);}db.prepare("DELETE FROM account_login_limits WHERE started_at<?").run(now-24*60*60*1000);}
export async function loginAccount(db,input){migrateAccounts(db);let login;try{login=normalizeLogin(input.login);}catch{login=String(input.login||"").slice(0,64).toLocaleLowerCase("ru");}checkLimits(db,login);
 const user=db.prepare("SELECT u.*,c.password_hash FROM account_credentials c JOIN users u ON u.id=c.user_id WHERE c.login_key=? AND u.active=1").get(login);
 const verified=await verifyPassword(input.password,user?.password_hash);if(!verified||!user){failedAttempt(db,login);throw new AccountError("Неверный логин или пароль",401);}db.prepare("DELETE FROM account_login_limits WHERE bucket=?").run("login:"+hash(login));audit(db,user.id,"account.login");return session(db,user);}
export function cookieToken(header){const values=String(header||"").split(";").map(v=>v.trim()).filter(v=>v.startsWith(SESSION_COOKIE+"="));if(values.length!==1)return "";const token=values[0].slice(SESSION_COOKIE.length+1);return /^[A-Za-z0-9_-]{43}$/.test(token)?token:"";}
export function findSession(db,token,now=Date.now()){migrateAccounts(db);if(!/^[A-Za-z0-9_-]{43}$/.test(token||""))return null;
 const row=db.prepare("SELECT u.id,u.login,u.display_name,s.expires_at,s.last_seen_at FROM account_sessions s JOIN users u ON u.id=s.user_id JOIN account_credentials c ON c.user_id=u.id WHERE s.token_hash=? AND u.active=1").get(hash(token));
 if(!row||row.expires_at<=now||row.last_seen_at<=now-IDLE_MS)return null;if(row.last_seen_at<now-5*60*1000)db.prepare("UPDATE account_sessions SET last_seen_at=? WHERE token_hash=?").run(now,hash(token));return publicUser(row);}
export function logoutAccount(db,token){const user=findSession(db,token);db.prepare("DELETE FROM account_sessions WHERE token_hash=?").run(hash(token));if(user)audit(db,user.id,"account.logout");}
export function listAccounts(db){migrateAccounts(db);return db.prepare("SELECT u.id,u.login,u.display_name FROM users u JOIN account_credentials c ON c.user_id=u.id WHERE u.active=1 ORDER BY c.login_key").all().map(publicUser);}
async function confirmPassword(db,userId,password){const row=db.prepare("SELECT password_hash FROM account_credentials WHERE user_id=?").get(userId);if(!row||!await verifyPassword(password,row.password_hash))throw new AccountError("Текущий пароль указан неверно",403);}
export async function createAccount(db,user,input){checkLimits(db,"confirm:"+user.id);try{await confirmPassword(db,user.id,input.currentPassword);}catch(e){failedAttempt(db,"confirm:"+user.id);throw e;}
 const encoded=await passwordHash(input.password);db.exec("BEGIN IMMEDIATE");try{const created=insertAccount(db,input,encoded);audit(db,user.id,"account.created",{accountId:created.id});db.exec("COMMIT");return publicUser(created);}catch(e){db.exec("ROLLBACK");throw e;}}
export async function changePassword(db,user,input){checkLimits(db,"confirm:"+user.id);try{await confirmPassword(db,user.id,input.currentPassword);}catch(e){failedAttempt(db,"confirm:"+user.id);throw e;}
 const encoded=await passwordHash(input.password);db.exec("BEGIN IMMEDIATE");try{db.prepare("UPDATE account_credentials SET password_hash=?,password_changed_at=? WHERE user_id=?").run(encoded,new Date().toISOString(),user.id);db.prepare("DELETE FROM account_sessions WHERE user_id=?").run(user.id);audit(db,user.id,"account.password_changed");const result=session(db,{id:user.id,login:user.login,display_name:user.displayName});db.exec("COMMIT");return result;}catch(e){db.exec("ROLLBACK");throw e;}}
export function sessionCookie(token,{secure=false,clear=false}={}){return `${SESSION_COOKIE}=${clear?"":token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear?0:SESSION_SECONDS}${secure?"; Secure":""}`;}
