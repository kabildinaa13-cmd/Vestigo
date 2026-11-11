import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { changeCaseStatus, createCase, createEpisode, getDashboard, listCases, listEpisodes, openDatabase } from "../app/lib/vestigo-db.mjs";

let directory;
let db;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), "vestigo-test-")); db = openDatabase({ dataDirectory: directory }); });
afterEach(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });

test("дело без квалификации сохраняется и отражается в реальных показателях", () => {
  const item = createCase(db, { caseNumber: "ER-001", description: "Проверка" });
  assert.equal(item.caseNumber, "ER-001");
  assert.deepEqual(item.qualifications, []);
  assert.equal(listCases(db).length, 1);
  assert.equal(getDashboard(db).cases, 1);
  assert.equal(getDashboard(db).activeCases, 1);
});

test("номер дела уникален внутри департамента", () => {
  createCase(db, { caseNumber: "ER-002", qualifications: ["216"] });
  assert.throws(() => createCase(db, { caseNumber: "ER-002", qualifications: ["216"] }), /UNIQUE/);
});

test("эпизод привязывается к существующему делу", () => {
  const item = createCase(db, { caseNumber: "ER-003", qualifications: ["214", "216"] });
  createEpisode(db, { caseId: item.id, title: "Эпизод 1", description: "Сопоставление ЭСФ" });
  assert.equal(listEpisodes(db, item.id).length, 1);
  assert.equal(getDashboard(db).episodes, 1);
});

test("архивирование версионирует дело и фиксируется в аудите", () => {
  const item = createCase(db, { caseNumber: "ER-004", qualifications: ["214"] });
  const archived = changeCaseStatus(db, item.id, "archived");
  assert.equal(archived.status, "archived");
  assert.equal(archived.version, 2);
  const actions = db.prepare("SELECT action FROM audit_log ORDER BY created_at").all().map((row) => row.action);
  assert.deepEqual(actions, ["case.created", "case.status_changed"]);
});

test("операция не может повторяться по внешнему ключу внутри одного дела", () => {
  const item = createCase(db, { caseNumber: "ER-005", qualifications: ["216"] });
  const statement = db.prepare(`INSERT INTO operations(id, case_id, operation_type, occurred_at, amount_minor, external_key, created_at)
    VALUES(?, ?, 'esf', '2026-01-01', 10000, 'ESF-1', '2026-01-01')`);
  statement.run("op-1", item.id);
  assert.throws(() => statement.run("op-2", item.id), /UNIQUE/);
});

test("один документ может относиться к нескольким эпизодам без копирования документа", () => {
  const item = createCase(db, { caseNumber: "ER-006", qualifications: ["216"] });
  const first = createEpisode(db, { caseId: item.id, title: "Первый" });
  const second = createEpisode(db, { caseId: item.id, title: "Второй" });
  db.prepare(`INSERT INTO documents(id, department_id, original_name, stored_name, media_type, size_bytes, sha256, category, processing_status, created_by, created_at)
    VALUES('doc-1','der-pilot','a.pdf','a.bin','application/pdf',10,'hash-a','contract','uploaded','local-system-user','2026-01-01')`).run();
  const link = db.prepare("INSERT INTO episode_documents(episode_id, document_id) VALUES(?, 'doc-1')");
  link.run(first.id); link.run(second.id);
  assert.equal(db.prepare("SELECT COUNT(*) value FROM documents").get().value, 1);
  assert.equal(db.prepare("SELECT COUNT(*) value FROM episode_documents").get().value, 2);
});
