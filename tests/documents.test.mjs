import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createCase, createEpisode, getDashboard, openDatabase } from "../app/lib/vestigo-db.mjs";
import { documentOriginal, listDocuments, saveDocument, validateDocument } from "../app/lib/documents.mjs";
import { DOCUMENT_GROUPS } from "../app/lib/document-types.mjs";

let directory, db, caseItem;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "vestigo-documents-"));
  db = openDatabase({ dataDirectory: directory });
  caseItem = createCase(db, { caseNumber: "DOC-TEST" });
});
afterEach(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
const content = Buffer.from("Синтетический документ для испытаний");
const input = (extra = {}) => ({ caseId: caseItem.id, name: "материал.txt", bytes: content,
  groupId: "bank", typeId: "statement", source: "Синтетические данные", receivedAt: "2026-10-19", ...extra });

test("все группы и их виды сохраняются в выбранном деле", () => {
  assert.equal(DOCUMENT_GROUPS.length, 10);
  let count = 0;
  for (const group of DOCUMENT_GROUPS) for (const type of group.types) {
    const saved = saveDocument(db, input({ groupId: group.id, typeId: type.id,
      bytes: Buffer.from(`${group.id}-${type.id}`) }));
    const found = listDocuments(db, caseItem.id).find((item) => item.id === saved.id);
    assert.equal(found.groupId, group.id); assert.equal(found.typeId, type.id);
    count++;
  }
  assert.equal(getDashboard(db).documents, count);
});

test("повторная загрузка одинаковых байтов под другим именем не создаёт дубликат", () => {
  const first = saveDocument(db, input());
  const second = saveDocument(db, input({ name: "другое имя.txt" }));
  assert.equal(second.id, first.id); assert.equal(second.duplicate, true); assert.equal(second.alreadyLinked, true);
  assert.equal(listDocuments(db, caseItem.id).length, 1);
  assert.equal(fs.readdirSync(path.join(directory, "uploads")).length, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM document_versions").get().n, 1);
});

test("один оригинал используется в нескольких эпизодах и делах со своей классификацией", () => {
  const firstEpisode = createEpisode(db, { caseId: caseItem.id, title: "Эпизод 1" });
  const secondEpisode = createEpisode(db, { caseId: caseItem.id, title: "Эпизод 2" });
  const first = saveDocument(db, input({ episodeId: firstEpisode.id }));
  saveDocument(db, input({ episodeId: secondEpisode.id }));
  const secondCase = createCase(db, { caseNumber: "DOC-TEST-2" });
  const second = saveDocument(db, input({ caseId: secondCase.id, groupId: "victim", typeId: "supporting" }));
  assert.equal(second.id, first.id);
  assert.equal(listDocuments(db, caseItem.id)[0].episodes.length, 2);
  assert.equal(listDocuments(db, secondCase.id)[0].groupId, "victim");
  assert.equal(getDashboard(db).documents, 1);
});

test("оригинал, SHA-256, источник и вид сохраняются после повторного открытия базы", () => {
  const saved = saveDocument(db, input());
  db.close(); db = openDatabase({ dataDirectory: directory });
  const record = listDocuments(db, caseItem.id)[0];
  assert.equal(record.source, "Синтетические данные"); assert.equal(record.typeId, "statement");
  assert.equal(record.sha256, createHash("sha256").update(content).digest("hex"));
  assert.deepEqual(documentOriginal(db, saved.id, caseItem.id).bytes, content);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='document.downloaded'").get().n, 1);
});

test("подмена оригинала обнаруживается при скачивании", () => {
  const saved = saveDocument(db, input());
  const stored = db.prepare("SELECT stored_name FROM documents WHERE id=?").get(saved.id).stored_name;
  fs.writeFileSync(path.join(directory, "uploads", stored), "изменённые данные");
  assert.throws(() => documentOriginal(db, saved.id, caseItem.id), /целостности/);
});

test("нельзя привязать чужой эпизод или прочитать файл другого дела/департамента", () => {
  const otherCase = createCase(db, { caseNumber: "OTHER" });
  const otherEpisode = createEpisode(db, { caseId: otherCase.id, title: "Чужой эпизод" });
  assert.throws(() => saveDocument(db, input({ episodeId: otherEpisode.id })), /не относится/);
  const saved = saveDocument(db, input());
  assert.throws(() => documentOriginal(db, saved.id, otherCase.id), /не найден/);
  assert.throws(() => listDocuments(db, caseItem.id, { departmentId: "other-department" }), /не найден/);
});

test("проверяются тип файла, размер, содержимое и классификация", () => {
  assert.throws(() => validateDocument("payload.exe", content), /не поддерживается/);
  assert.throws(() => validateDocument("fake.pdf", content), /формату PDF/);
  assert.throws(() => validateDocument("fake.xlsx", content), /формату Office/);
  assert.throws(() => validateDocument("empty.txt", Buffer.alloc(0)), /Пустой/);
  assert.throws(() => validateDocument("large.txt", Buffer.alloc(50 * 1024 * 1024 + 1)), /50 МБ/);
  assert.throws(() => validateDocument("masked.txt", Buffer.from("MZ executable")), /Исполняемые/);
  assert.throws(() => saveDocument(db, input({ groupId: "bank", typeId: "tax_audit" })), /вид документа/);
  assert.throws(() => saveDocument(db, input({ receivedAt: "2026-02-31" })), /дата/);
  assert.equal(getDashboard(db).documents, 0);
});

test("изменённые байты при одинаковом имени сохраняются отдельно от оригинала", () => {
  const first = saveDocument(db, input());
  const second = saveDocument(db, input({ bytes: Buffer.from("Новая редакция материала") }));
  assert.notEqual(first.id, second.id); assert.equal(second.duplicate, false);
  assert.equal(listDocuments(db, caseItem.id).length, 2);
  assert.deepEqual(documentOriginal(db, first.id, caseItem.id).bytes, content);
});
