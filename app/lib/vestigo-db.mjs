import {currentUserId} from "./request-identity.mjs";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_DEPARTMENT_ID = "der-pilot";
export const DEFAULT_USER_ID = "local-system-user";
const initializedSchemas = new Map();

function clean(value) {
  return String(value ?? "").trim();
}

function json(value) {
  return JSON.stringify(value ?? []);
}

function withTransaction(db, operation) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function openDatabase(options = {}) {
  const dataDirectory = options.dataDirectory
    ? path.resolve(options.dataDirectory)
    : path.resolve(process.env.VESTIGO_DATA_DIR || path.join(process.cwd(), "data"));
  fs.mkdirSync(dataDirectory, { recursive: true });
  const databasePath = options.databasePath
    ? path.resolve(options.databasePath)
    : path.join(dataDirectory, "vestigo.sqlite");
  const db = new DatabaseSync(databasePath);
  try {
    db.exec("PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON;");
    if (db.prepare("PRAGMA journal_mode").get().journal_mode !== "wal") db.exec("PRAGMA journal_mode = WAL;");
    const version = db.prepare("PRAGMA schema_version").get().schema_version;
    if (initializedSchemas.get(databasePath) !== version) {
      migrate(db);
      if (initializedSchemas.size >= 128) initializedSchemas.clear();
      initializedSchemas.set(databasePath, db.prepare("PRAGMA schema_version").get().schema_version);
    }
    seedSystemIdentity(db);
    return db;
  } catch (error) { db.close(); throw error; }
}

export function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS departments (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      department_id TEXT NOT NULL REFERENCES departments(id),
      login TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('administrator','investigator','analyst','specialist','auditor','observer')),
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cases (
      id TEXT PRIMARY KEY,
      department_id TEXT NOT NULL REFERENCES departments(id),
      case_number TEXT NOT NULL,
      erdr_number TEXT NOT NULL DEFAULT '',
      unit_name TEXT NOT NULL DEFAULT '',
      responsible_user_id TEXT REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      period_from TEXT NOT NULL DEFAULT '',
      period_to TEXT NOT NULL DEFAULT '',
      qualifications_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL CHECK(status IN ('draft','active','suspended','completed','archived')),
      description TEXT NOT NULL DEFAULT '',
      version INTEGER NOT NULL DEFAULT 1,
      UNIQUE(department_id, case_number)
    );
    CREATE INDEX IF NOT EXISTS cases_department_status_idx ON cases(department_id, status);

    CREATE TABLE IF NOT EXISTS case_deletions (
      case_id TEXT PRIMARY KEY REFERENCES cases(id) ON DELETE CASCADE,
      deleted_at TEXT NOT NULL,
      deleted_by TEXT NOT NULL REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS episodes (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      period_from TEXT NOT NULL DEFAULT '',
      period_to TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK(status IN ('checking','confirmed','rejected','closed')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS participants (
      id TEXT PRIMARY KEY,
      department_id TEXT NOT NULL REFERENCES departments(id),
      kind TEXT NOT NULL CHECK(kind IN ('organization','person','victim','counterparty','bank')),
      identifier TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      attributes_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      UNIQUE(department_id, kind, identifier, name)
    );

    CREATE TABLE IF NOT EXISTS case_participants (
      case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      participant_id TEXT NOT NULL REFERENCES participants(id),
      role TEXT NOT NULL,
      PRIMARY KEY(case_id, participant_id, role)
    );

    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      department_id TEXT NOT NULL REFERENCES departments(id),
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      media_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
      sha256 TEXT NOT NULL,
      category TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT '',
      received_at TEXT NOT NULL DEFAULT '',
      processing_status TEXT NOT NULL CHECK(processing_status IN ('uploaded','processing','review','confirmed','failed')),
      extracted_json TEXT NOT NULL DEFAULT '{}',
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      UNIQUE(department_id, sha256)
    );

    CREATE TABLE IF NOT EXISTS document_versions (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      change_reason TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      UNIQUE(document_id, version)
    );

    CREATE TABLE IF NOT EXISTS case_documents (
      case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      document_id TEXT NOT NULL REFERENCES documents(id),
      purpose TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(case_id, document_id)
    );

    CREATE TABLE IF NOT EXISTS episode_documents (
      episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
      document_id TEXT NOT NULL REFERENCES documents(id),
      purpose TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(episode_id, document_id)
    );

    CREATE TABLE IF NOT EXISTS operations (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      episode_id TEXT REFERENCES episodes(id) ON DELETE SET NULL,
      operation_type TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      amount_minor INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'KZT',
      sender_participant_id TEXT REFERENCES participants(id),
      recipient_participant_id TEXT REFERENCES participants(id),
      purpose TEXT NOT NULL DEFAULT '',
      external_key TEXT NOT NULL DEFAULT '',
      confidence REAL NOT NULL DEFAULT 1 CHECK(confidence >= 0 AND confidence <= 1),
      confirmed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE(case_id, external_key)
    );

    CREATE TABLE IF NOT EXISTS operation_documents (
      operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
      document_id TEXT NOT NULL REFERENCES documents(id),
      page_number INTEGER,
      fragment TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(operation_id, document_id, page_number, fragment)
    );

    CREATE TABLE IF NOT EXISTS calculations (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      episode_id TEXT REFERENCES episodes(id) ON DELETE SET NULL,
      qualification TEXT NOT NULL CHECK(qualification IN ('214','216')),
      methodology_code TEXT NOT NULL,
      methodology_version TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('draft','preliminary_review','confirmed','superseded')),
      original_damage_minor INTEGER NOT NULL DEFAULT 0,
      formula_json TEXT NOT NULL,
      explanation TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      version INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS calculation_items (
      id TEXT PRIMARY KEY,
      calculation_id TEXT NOT NULL REFERENCES calculations(id) ON DELETE CASCADE,
      operation_id TEXT REFERENCES operations(id),
      item_type TEXT NOT NULL,
      amount_minor INTEGER NOT NULL,
      included INTEGER NOT NULL DEFAULT 1,
      legal_basis TEXT NOT NULL DEFAULT '',
      justification TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS discrepancies (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      episode_id TEXT REFERENCES episodes(id) ON DELETE SET NULL,
      discrepancy_type TEXT NOT NULL,
      description TEXT NOT NULL,
      amount_minor INTEGER,
      status TEXT NOT NULL CHECK(status IN ('detected','checking','confirmed','rejected','insufficient_data','closed')),
      alternative_explanations TEXT NOT NULL DEFAULT '',
      assigned_user_id TEXT REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reimbursements (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      episode_id TEXT REFERENCES episodes(id) ON DELETE SET NULL,
      victim_participant_id TEXT REFERENCES participants(id),
      kind TEXT NOT NULL CHECK(kind IN ('money','returned_property','recovered_property')),
      amount_minor INTEGER NOT NULL DEFAULT 0,
      occurred_at TEXT NOT NULL,
      document_id TEXT REFERENCES documents(id),
      confirmed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      episode_id TEXT REFERENCES episodes(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('voluntarily_returned','recovered','arrested','seized','transferred_to_victim','undetermined')),
      estimated_value_minor INTEGER NOT NULL DEFAULT 0,
      document_id TEXT REFERENCES documents(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      report_type TEXT NOT NULL,
      format TEXT NOT NULL CHECK(format IN ('docx','xlsx','pdf')),
      version INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('draft','generated','failed')),
      stored_name TEXT NOT NULL DEFAULT '',
      parameters_json TEXT NOT NULL DEFAULT '{}',
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      UNIQUE(case_id, report_type, version)
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      department_id TEXT NOT NULL REFERENCES departments(id),
      user_id TEXT REFERENCES users(id),
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS audit_department_time_idx ON audit_log(department_id, created_at DESC);
  `);
}

function seedSystemIdentity(db) {
  if (db.prepare("SELECT 1 FROM departments WHERE id=?").get(DEFAULT_DEPARTMENT_ID) &&
      db.prepare("SELECT 1 FROM users WHERE id=?").get(DEFAULT_USER_ID)) return;
  const now = new Date().toISOString();
  db.prepare(`INSERT OR IGNORE INTO departments(id, code, name, active, created_at)
    VALUES(?, ?, ?, 1, ?)`).run(DEFAULT_DEPARTMENT_ID, "PILOT", "Пилотный департамент", now);
  db.prepare(`INSERT OR IGNORE INTO users(id, department_id, login, display_name, role, active, created_at)
    VALUES(?, ?, ?, ?, 'administrator', 1, ?)`).run(
      DEFAULT_USER_ID,
      DEFAULT_DEPARTMENT_ID,
      "local-admin",
      "Локальный администратор",
      now,
    );
}

function writeAudit(db, { departmentId, userId = currentUserId() || DEFAULT_USER_ID, action, entityType, entityId, details = {} }) {
  db.prepare(`INSERT INTO audit_log(id, department_id, user_id, action, entity_type, entity_id, details_json, created_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?)`).run(
      randomUUID(), departmentId, userId, action, entityType, entityId, JSON.stringify(details), new Date().toISOString(),
    );
}

export function createCase(db, input, context = {}) {
  const departmentId = context.departmentId || DEFAULT_DEPARTMENT_ID;
  const userId = context.userId || currentUserId() || DEFAULT_USER_ID;
  const caseNumber = clean(input.caseNumber);
  if (!caseNumber) throw new Error("Укажите номер дела или материала");
  const qualifications = [...new Set((input.qualifications ?? []).map(clean).filter((v) => v === "214" || v === "216"))];
  const now = new Date().toISOString();
  const id = randomUUID();
  withTransaction(db, () => {
    db.prepare(`INSERT INTO cases(
      id, department_id, case_number, erdr_number, unit_name, responsible_user_id,
      created_at, updated_at, period_from, period_to, qualifications_json, status, description
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`)
      .run(id, departmentId, caseNumber, clean(input.erdrNumber), clean(input.unitName), userId,
        now, now, clean(input.periodFrom), clean(input.periodTo), json(qualifications), clean(input.description));
    writeAudit(db, { departmentId, userId, action: "case.created", entityType: "case", entityId: id,
      details: { caseNumber, qualifications } });
  });
  return getCase(db, id, departmentId);
}

export function getCase(db, id, departmentId = DEFAULT_DEPARTMENT_ID) {
  const row = db.prepare(`SELECT c.*, u.display_name AS responsible_name
    FROM cases c LEFT JOIN users u ON u.id = c.responsible_user_id
    WHERE c.id = ? AND c.department_id = ? AND NOT EXISTS(SELECT 1 FROM case_deletions z WHERE z.case_id=c.id)`).get(id, departmentId);
  return row ? mapCase(row) : null;
}

export function listCases(db, filters = {}, departmentId = DEFAULT_DEPARTMENT_ID) {
  const conditions = ["c.department_id = ?", "NOT EXISTS(SELECT 1 FROM case_deletions z WHERE z.case_id=c.id)"];
  const params = [departmentId];
  if (filters.status) { conditions.push("c.status = ?"); params.push(clean(filters.status)); }
  if (filters.query) {
    conditions.push("(c.case_number LIKE ? OR c.erdr_number LIKE ? OR c.description LIKE ?)");
    const q = `%${clean(filters.query)}%`;
    params.push(q, q, q);
  }
  return db.prepare(`SELECT c.*, u.display_name AS responsible_name
    FROM cases c LEFT JOIN users u ON u.id = c.responsible_user_id
    WHERE ${conditions.join(" AND ")} ORDER BY c.updated_at DESC`).all(...params).map(mapCase);
}

export class CaseEditError extends Error {
  constructor(message,status=400){super(message);this.status=status;}
}
export function updateCase(db,input,context={}){
  const fields={caseNumber:200,erdrNumber:100,unitName:300,description:20000,periodFrom:10,periodTo:10};
  if(!input||typeof input!=="object"||Array.isArray(input))throw new CaseEditError("Некорректные реквизиты дела");
  if(input.action!==undefined&&input.action!=="update")throw new CaseEditError("Неизвестное действие редактирования дела");
  for(const name of Object.keys(input))if(!["id","action","expectedVersion","qualifications",...Object.keys(fields)].includes(name))throw new CaseEditError(`Поле ${name} не поддерживается при редактировании дела`);
  if(!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<1)throw new CaseEditError("Передайте текущую версию дела; обновите карточку",409);
  const changes={};for(const [name,max] of Object.entries(fields))if(Object.hasOwn(input,name)){
    if(typeof input[name]!=="string"||input[name].length>max||input[name].includes("\u0000"))throw new CaseEditError(`Некорректное поле ${name}: допустимо до ${max} символов`);
    changes[name]=input[name].trim();
  }
  if(Object.hasOwn(input,'qualifications')){if(!Array.isArray(input.qualifications)||input.qualifications.some(v=>!['214','216'].includes(v)))throw new CaseEditError('Некорректная предполагаемая квалификация');changes.qualifications=[...new Set(input.qualifications)].sort();}
  if(!Object.keys(changes).length)throw new CaseEditError("Нет реквизитов для изменения");
  if(changes.caseNumber==="")throw new CaseEditError("Укажите номер дела или материала");
  const departmentId=context.departmentId||DEFAULT_DEPARTMENT_ID,userId=context.userId||currentUserId()||DEFAULT_USER_ID;
  return withTransaction(db,()=>{
    const before=getCase(db,String(input.id||""),departmentId);
    if(!before)throw new CaseEditError("Дело не найдено",404);
    if(before.status==="archived")throw new CaseEditError("Дело в архиве: сначала восстановите рабочий статус",409);
    if(before.version!==input.expectedVersion)throw new CaseEditError("Дело изменено другим сотрудником. Обновите карточку и повторите изменения",409);
    const next={...before,...changes},date=value=>!value||/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+"T00:00:00Z"))&&new Date(value+"T00:00:00Z").toISOString().slice(0,10)===value;
    if(!date(next.periodFrom)||!date(next.periodTo))throw new CaseEditError("Укажите действительную дату в формате ГГГГ-ММ-ДД");
    if(next.periodFrom&&next.periodTo&&next.periodFrom>next.periodTo)throw new CaseEditError("Начало периода не может быть позже окончания");
    const changed=Object.keys(changes).filter(name=>JSON.stringify(before[name])!==JSON.stringify(next[name]));if(!changed.length)return before;
    try{db.prepare("UPDATE cases SET case_number=?,erdr_number=?,unit_name=?,description=?,period_from=?,period_to=?,qualifications_json=?,updated_at=?,version=version+1 WHERE id=? AND department_id=? AND version=?").run(next.caseNumber,next.erdrNumber,next.unitName,next.description,next.periodFrom,next.periodTo,JSON.stringify(next.qualifications),new Date().toISOString(),before.id,departmentId,before.version);}
    catch(error){if(String(error.message).includes("UNIQUE"))throw new CaseEditError("Дело с таким номером уже существует",409);throw error;}
    writeAudit(db,{departmentId,userId,action:"case.updated",entityType:"case",entityId:before.id,details:{fromVersion:before.version,toVersion:before.version+1,before:Object.fromEntries(changed.map(k=>[k,before[k]])),after:Object.fromEntries(changed.map(k=>[k,next[k]]))}});
    return getCase(db,before.id,departmentId);
  });
}

export function changeCaseStatus(db, id, status, context = {}) {
  const allowed = new Set(["draft", "active", "suspended", "completed", "archived"]);
  if (!allowed.has(status)) throw new Error("Недопустимый статус дела");
  const departmentId = context.departmentId || DEFAULT_DEPARTMENT_ID;
  const userId = context.userId || DEFAULT_USER_ID;
  const existing = getCase(db, id, departmentId);
  if (!existing) throw new Error("Дело не найдено");
  const now = new Date().toISOString();
  withTransaction(db, () => {
    db.prepare("UPDATE cases SET status = ?, updated_at = ?, version = version + 1 WHERE id = ? AND department_id = ?")
      .run(status, now, id, departmentId);
    writeAudit(db, { departmentId, userId, action: "case.status_changed", entityType: "case", entityId: id,
      details: { from: existing.status, to: status } });
  });
  return getCase(db, id, departmentId);
}

function mapCase(row) {
  return {
    id: row.id,
    caseNumber: row.case_number,
    erdrNumber: row.erdr_number,
    unitName: row.unit_name,
    responsibleName: row.responsible_name ?? "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    periodFrom: row.period_from,
    periodTo: row.period_to,
    qualifications: JSON.parse(row.qualifications_json || "[]"),
    status: row.status,
    description: row.description,
    version: row.version,
  };
}

export function createEpisode(db, input, context = {}) {
  const departmentId = context.departmentId || DEFAULT_DEPARTMENT_ID;
  const userId = context.userId || DEFAULT_USER_ID;
  const parent = getCase(db, clean(input.caseId), departmentId);
  if (!parent) throw new Error("Дело не найдено");
  const title = clean(input.title);
  if (!title) throw new Error("Укажите название эпизода");
  const id = randomUUID();
  const now = new Date().toISOString();
  withTransaction(db, () => {
    db.prepare(`INSERT INTO episodes(id, case_id, title, description, period_from, period_to, status, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, 'checking', ?, ?)`).run(
        id, parent.id, title, clean(input.description), clean(input.periodFrom), clean(input.periodTo), now, now,
      );
    db.prepare("UPDATE cases SET updated_at = ?, version = version + 1 WHERE id = ?").run(now, parent.id);
    writeAudit(db, { departmentId, userId, action: "episode.created", entityType: "episode", entityId: id,
      details: { caseId: parent.id, title } });
  });
  return db.prepare("SELECT * FROM episodes WHERE id = ?").get(id);
}

export function listEpisodes(db, caseId, departmentId = DEFAULT_DEPARTMENT_ID) {
  const parent = getCase(db, caseId, departmentId);
  if (!parent) return [];
  return db.prepare("SELECT * FROM episodes WHERE case_id = ? ORDER BY created_at DESC").all(caseId).map((row) => ({
    id: row.id,
    caseId: row.case_id,
    title: row.title,
    description: row.description,
    periodFrom: row.period_from,
    periodTo: row.period_to,
    status: row.status,
    createdAt: row.created_at,
  }));
}

export function getDashboard(db, departmentId = DEFAULT_DEPARTMENT_ID) {
  const visible="NOT EXISTS(SELECT 1 FROM case_deletions z WHERE z.case_id=c.id)";
  const relatedCount=(table,extra="")=>db.prepare(`SELECT COUNT(*) value FROM ${table} x JOIN cases c ON c.id=x.case_id WHERE c.department_id=? AND ${visible} ${extra}`).get(departmentId).value;
  const versionCount=table=>db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)?relatedCount(table):0;
  return {
    department:db.prepare("SELECT id,code,name FROM departments WHERE id=?").get(departmentId),
    cases:db.prepare(`SELECT COUNT(*) value FROM cases c WHERE c.department_id=? AND ${visible}`).get(departmentId).value,
    activeCases:db.prepare(`SELECT COUNT(*) value FROM cases c WHERE c.department_id=? AND c.status IN ('active','suspended') AND ${visible}`).get(departmentId).value,
    episodes:relatedCount("episodes"),
    documents:db.prepare(`SELECT COUNT(DISTINCT d.id) value FROM documents d JOIN case_documents cd ON cd.document_id=d.id JOIN cases c ON c.id=cd.case_id WHERE c.department_id=? AND d.department_id=c.department_id AND ${visible}`).get(departmentId).value,
    operations:relatedCount("operations"),
    calculations:relatedCount("calculations")+versionCount("case_calculation_versions"),
    discrepancies:relatedCount("discrepancies","AND x.status NOT IN ('closed','rejected')"),
    reimbursements:relatedCount("reimbursements"),
    reports:relatedCount("reports")+versionCount("case_report_versions"),
    latestCases:listCases(db,{},departmentId).slice(0,5),
  };
}
