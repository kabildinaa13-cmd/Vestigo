import {currentUserId} from "./request-identity.mjs";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DEFAULT_DEPARTMENT_ID, DEFAULT_USER_ID, getCase } from "./vestigo-db.mjs";
import { documentType, MAX_DOCUMENT_BYTES } from "./document-types.mjs";

const MEDIA_TYPES = {
  ".zip": "application/zip",
  ".pdf": "application/pdf", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xls": "application/vnd.ms-excel",
  ".csv": "text/csv", ".xml": "application/xml", ".json": "application/json", ".txt": "text/plain",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".tif": "image/tiff", ".tiff": "image/tiff",
};

export function migrateDocuments(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS document_classifications (
    case_id TEXT NOT NULL REFERENCES cases(id),document_id TEXT NOT NULL REFERENCES documents(id),
    mode TEXT NOT NULL,status TEXT NOT NULL,result_json TEXT NOT NULL DEFAULT '{}',updated_at TEXT NOT NULL,
    PRIMARY KEY(case_id,document_id)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS case_document_metadata (
    case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    document_id TEXT NOT NULL REFERENCES documents(id),
    group_code TEXT NOT NULL,
    type_code TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT '',
    received_at TEXT NOT NULL DEFAULT '',
    added_at TEXT NOT NULL,
    PRIMARY KEY(case_id, document_id)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS document_analytics (
    case_id TEXT NOT NULL REFERENCES cases(id), document_id TEXT NOT NULL REFERENCES documents(id),
    status TEXT NOT NULL CHECK(status IN ('running','completed','failed')), updated_at TEXT NOT NULL,
    details_json TEXT NOT NULL DEFAULT '{}', error TEXT NOT NULL DEFAULT '', PRIMARY KEY(case_id, document_id)
  )`);
}

function audit(db, context, action, id, details) {
  db.prepare(`INSERT INTO audit_log(id, department_id, user_id, action, entity_type, entity_id, details_json, created_at)
    VALUES(?, ?, ?, ?, 'document', ?, ?, ?)`).run(randomUUID(), context.departmentId || DEFAULT_DEPARTMENT_ID,
    context.userId || currentUserId() || DEFAULT_USER_ID, action, id, JSON.stringify(details), new Date().toISOString());
}

function storageDirectory(db) {
  const file = db.prepare("PRAGMA database_list").all().find((item) => item.name === "main")?.file;
  if (!file) throw new Error("Файловое хранилище недоступно");
  return path.join(path.dirname(file), "uploads");
}

function filename(value) {
  return String(value || "").replace(/\\/g, "/").split("/").pop()
    .replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 240);
}

export function validateDocument(originalName, bytes) {
  const name = filename(originalName);
  const extension = path.extname(name).toLowerCase();
  if (!MEDIA_TYPES[extension]) throw new Error("Этот формат не поддерживается. Выберите документ из списка разрешённых форматов.");
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw new Error("Пустой файл нельзя загрузить");
  if (bytes.length > MAX_DOCUMENT_BYTES) throw new Error("Размер файла превышает 50 МБ");
  const starts = (hex) => bytes.subarray(0, hex.length / 2).equals(Buffer.from(hex, "hex"));
  if (starts("4d5a") || starts("7f454c46")) throw new Error("Исполняемые файлы запрещены");
  if (extension === ".zip" && !starts("504b0304") && !starts("504b0506")) throw new Error("Файл не соответствует формату ZIP");
  if (extension === ".pdf" && bytes.subarray(0, 5).toString() !== "%PDF-") throw new Error("Файл не соответствует формату PDF");
  if ([".docx", ".xlsx"].includes(extension)) {
    if (!starts("504b0304") || !bytes.includes(Buffer.from("[Content_Types].xml")) ||
      !bytes.includes(Buffer.from(extension === ".docx" ? "word/" : "xl/"))) {
      throw new Error("Файл не соответствует выбранному формату Office");
    }
    if (bytes.includes(Buffer.from("vbaProject.bin"))) throw new Error("Документы с макросами не поддерживаются");
  }
  // Older bank exports use HTML tables under .xls. They are parsed locally as
  // inert data, never rendered/executed or fetched in a browser.
  const legacyHtmlXls=/^\s*(?:\uFEFF)?\s*<(?:!doctype\s+html|html|head|table)\b/i.test(bytes.subarray(0,1024).toString('utf8'));
  if (extension === ".xls" && !starts("d0cf11e0a1b11ae1") && !legacyHtmlXls) throw new Error("Файл не соответствует формату XLS");
  if (extension === ".png" && !starts("89504e470d0a1a0a")) throw new Error("Файл не соответствует формату PNG");
  if ([".jpg", ".jpeg"].includes(extension) && !starts("ffd8ff")) throw new Error("Файл не соответствует формату JPEG");
  if ([".tif", ".tiff"].includes(extension) && !starts("49492a00") && !starts("4d4d002a")) throw new Error("Файл не соответствует формату TIFF");
  return { name, extension, mediaType: MEDIA_TYPES[extension] };
}

function validateScope(db, input, departmentId) {
  const parent = getCase(db, String(input.caseId || ""), departmentId);
  if (!parent) throw new Error("Дело не найдено");
  if (parent.status === "archived") throw new Error("В архивное дело нельзя добавлять документы");
  const episodeId = String(input.episodeId || "");
  if (episodeId && !db.prepare("SELECT id FROM episodes WHERE id = ? AND case_id = ?").get(episodeId, parent.id)) {
    throw new Error("Эпизод не относится к выбранному делу");
  }
  return { parent, episodeId };
}

export function saveDocument(db, input, context = {}, transaction = {}) {
  migrateDocuments(db);
  const departmentId = context.departmentId || DEFAULT_DEPARTMENT_ID;
  const userId = context.userId || currentUserId() || DEFAULT_USER_ID;
  const { parent, episodeId } = validateScope(db, input, departmentId);
  if (!documentType(input.groupId, input.typeId)) throw new Error("Выберите группу и вид документа");
  const receivedAt = String(input.receivedAt || "");
  if (receivedAt && (!/^\d{4}-\d{2}-\d{2}$/.test(receivedAt) || !Number.isFinite(Date.parse(receivedAt)) ||
    new Date(receivedAt).toISOString().slice(0, 10) !== receivedAt)) throw new Error("Некорректная дата получения");
  const source = String(input.source || "").trim();
  if (source.length > 2000) throw new Error("Источник не должен превышать 2000 символов");
  const file = validateDocument(input.name, input.bytes);
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const directory = storageDirectory(db);
  fs.mkdirSync(directory, { recursive: true });
  let writtenPath = "";
  const ownTransaction = transaction.external !== true;
  if (ownTransaction) db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db.prepare("SELECT * FROM documents WHERE department_id = ? AND sha256 = ?").get(departmentId, sha256);
    const id = existing?.id || randomUUID();
    const now = new Date().toISOString();
    const alreadyLinked = !!db.prepare("SELECT 1 FROM case_documents WHERE case_id = ? AND document_id = ?").get(parent.id, id);
    if (!existing) {
      const storedName = `${randomUUID()}.original`;
      writtenPath = path.join(directory, storedName);
      fs.writeFileSync(writtenPath, input.bytes, { flag: "wx", mode: 0o600 });
      transaction.onWrite?.(writtenPath);
      db.prepare(`INSERT INTO documents(id, department_id, original_name, stored_name, media_type, size_bytes, sha256, category,
        source, received_at, processing_status, created_by, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,'uploaded',?,?)`)
        .run(id, departmentId, file.name, storedName, file.mediaType, input.bytes.length, sha256, input.groupId, source, receivedAt, userId, now);
      db.prepare(`INSERT INTO document_versions(id, document_id, version, sha256, stored_name, change_reason, created_by, created_at)
        VALUES(?,?,1,?,?,'Первоначальная загрузка',?,?)`).run(randomUUID(), id, sha256, storedName, userId, now);
    } else {
      const originalPath = path.join(directory, path.basename(existing.stored_name));
      const original = fs.readFileSync(originalPath);
      if (createHash("sha256").update(original).digest("hex") !== sha256) throw new Error("Проверка целостности сохранённого оригинала не пройдена");
    }
    db.prepare("INSERT OR IGNORE INTO case_documents(case_id, document_id) VALUES(?,?)").run(parent.id, id);
    const excluded=!!(db.prepare("SELECT 1 FROM sqlite_master WHERE name='case_document_exclusions'").get()&&db.prepare('SELECT 1 FROM case_document_exclusions WHERE case_id=? AND document_id=?').get(parent.id,id));
    const restored=excluded&&!!input.afterSave;
    if(restored){db.prepare('DELETE FROM case_document_exclusions WHERE case_id=? AND document_id=?').run(parent.id,id);audit(db,context,'document.restored_by_upload',id,{caseId:parent.id,originalName:file.name});}
    db.prepare(`INSERT OR IGNORE INTO case_document_metadata(case_id,document_id,group_code,type_code,source,received_at,added_at)
      VALUES(?,?,?,?,?,?,?)`).run(parent.id, id, input.groupId, input.typeId, source, receivedAt, now);
    if(!alreadyLinked)db.prepare("INSERT OR IGNORE INTO document_classifications VALUES(?,?,?,?,?,?)").run(parent.id,id,input.classificationMode==="auto"?"auto":"manual",input.classificationMode==="auto"?"pending":"manual","{}",now);
    if (episodeId) db.prepare("INSERT OR IGNORE INTO episode_documents(episode_id, document_id) VALUES(?,?)").run(episodeId, id);
    audit(db, context, existing ? (alreadyLinked ? "document.duplicate_detected" : "document.linked") : "document.uploaded", id,
      { caseId: parent.id, episodeId, sha256, originalName: file.name, groupId: input.groupId, typeId: input.typeId });
    const processing=input.afterSave?input.afterSave(db,id,parent.id):null;
    if (ownTransaction) db.exec("COMMIT");
    return { id, duplicate: !!existing, alreadyLinked, restored, name: existing?.original_name || file.name, sha256,...(processing?{processing}: {}) };
  } catch (error) {
    if (ownTransaction) db.exec("ROLLBACK");
    if (writtenPath) fs.unlinkSync(writtenPath);
    throw error;
  }
}

export function listDocuments(db, caseId, context = {}) {
  migrateDocuments(db);
  const departmentId = context.departmentId || DEFAULT_DEPARTMENT_ID;
  if (!getCase(db, caseId, departmentId)) throw new Error("Дело не найдено");
  const rows = db.prepare(`SELECT d.id,d.original_name,d.media_type,d.size_bytes,d.sha256,d.processing_status,d.created_at,
    m.group_code,m.type_code,m.source,m.received_at FROM documents d JOIN case_documents c ON c.document_id=d.id
    LEFT JOIN case_document_metadata m ON m.case_id=c.case_id AND m.document_id=d.id
    WHERE c.case_id=? AND d.department_id=? ORDER BY d.created_at DESC,d.id`).all(caseId, departmentId);
  return rows.map((row) => ({
    excluded:!!(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='case_document_exclusions'").get()&&db.prepare("SELECT 1 FROM case_document_exclusions WHERE case_id=? AND document_id=?").get(caseId,row.id)),
    id: row.id, name: row.original_name, size: row.size_bytes, mediaType: row.media_type, sha256: row.sha256,
    groupId: row.group_code || "", typeId: row.type_code || "", source: row.source || "", receivedAt: row.received_at || "",
    status: row.processing_status, createdAt: row.created_at,
    classification: classificationStatus(db,caseId,row.id),
    analytics: db.prepare("SELECT status,updated_at AS updatedAt,error FROM document_analytics WHERE case_id=? AND document_id=?").get(caseId,row.id) || null,
    extraction: db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='case_extractions'").get()
      ? db.prepare("SELECT status,updated_at AS updatedAt,error,summary_json AS summary FROM case_extractions WHERE case_id=? AND document_id=?").get(caseId,row.id) || null : null,
    episodes: db.prepare(`SELECT e.id,e.title FROM episodes e JOIN episode_documents x ON x.episode_id=e.id
      WHERE e.case_id=? AND x.document_id=? ORDER BY e.created_at`).all(caseId, row.id),
  }));
}

export function documentOriginal(db, id, caseId, context = {}) {
  const departmentId = context.departmentId || DEFAULT_DEPARTMENT_ID;
  const row = db.prepare(`SELECT d.* FROM documents d JOIN case_documents x ON x.document_id=d.id
    JOIN cases c ON c.id=x.case_id WHERE d.id=? AND x.case_id=? AND c.department_id=? AND d.department_id=? AND NOT EXISTS(SELECT 1 FROM case_deletions z WHERE z.case_id=c.id)`)
    .get(id, caseId, departmentId, departmentId);
  if (!row) throw new Error("Документ не найден");
  const bytes = fs.readFileSync(path.join(storageDirectory(db), path.basename(row.stored_name)));
  if (createHash("sha256").update(bytes).digest("hex") !== row.sha256) throw new Error("Проверка целостности оригинала не пройдена");
  audit(db, context, context.purpose === "analysis" ? "document.analysis_original_read" : "document.downloaded", id, { caseId, sha256: row.sha256 });
  return { bytes, name: row.original_name, mediaType: row.media_type, sha256: row.sha256 };
}

export function classificationStatus(db,caseId,documentId){
  migrateDocuments(db);
  const row=db.prepare("SELECT mode,status,result_json,updated_at AS updatedAt FROM document_classifications WHERE case_id=? AND document_id=?").get(caseId,documentId);
  return row?{mode:row.mode,status:row.status,result:JSON.parse(row.result_json),updatedAt:row.updatedAt}:null;
}

// Called within the extraction transaction: classification and derived operations commit together.
export function applyDocumentClassification(db,caseId,documentId,result,context={}){
  const parent=getCase(db,caseId,context.departmentId||DEFAULT_DEPARTMENT_ID);
  if(!parent)throw new Error("Дело не найдено");if(parent.status==="archived")throw new Error("Дело находится в архиве");
  if(!db.prepare("SELECT 1 FROM case_documents WHERE case_id=? AND document_id=?").get(caseId,documentId))throw new Error("Документ не относится к делу");
  if(!documentType(result.groupId,result.typeId))throw new Error("Выберите существующую группу и вид");
  if(!["auto","manual"].includes(result.mode)||!["automatic","review","unclassified","manual"].includes(result.status))throw new Error("Некорректный результат классификации");
  if(result.mode==="manual"&&!String(result.note||"").trim())throw new Error("Укажите основание изменения вида");
  db.prepare("UPDATE case_document_metadata SET group_code=?,type_code=? WHERE case_id=? AND document_id=?").run(result.groupId,result.typeId,caseId,documentId);
  db.prepare("INSERT INTO document_classifications VALUES(?,?,?,?,?,?) ON CONFLICT(case_id,document_id) DO UPDATE SET mode=excluded.mode,status=excluded.status,result_json=excluded.result_json,updated_at=excluded.updated_at").run(caseId,documentId,result.mode,result.status,JSON.stringify(result),new Date().toISOString());
  audit(db,context,"document.classified",documentId,{caseId,...result});
}
