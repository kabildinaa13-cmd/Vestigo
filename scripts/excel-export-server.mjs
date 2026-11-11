import http from "node:http";
import {isPartyKey} from "../app/lib/bank-identities.mjs";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const host = "127.0.0.1";
const port = Number(process.env.VESTIGO_SERVICE_PORT || 4418);
const siteOrigin = `http://localhost:${process.env.VESTIGO_SITE_PORT || 3200}`;
const maxBody = 35_000_000;
const maxUploadBody = 150_000_000;
const codeRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const projectRoot = process.env.VESTIGO_ANALYTICS_ROOT || codeRoot;
const uploadLogPath = path.join(
  projectRoot,
  "data",
  "source-documents",
  "uploads",
  "upload-log.json",
);
const pythonExecutable =
  process.env.VESTIGO_PYTHON ||
  (process.platform === "win32" ? "py" : "python3");
const pythonPrefixArgs =
  process.env.VESTIGO_PYTHON || process.platform !== "win32" ? [] : ["-3"];
const money = new Intl.NumberFormat("ru-KZ", { maximumFractionDigits: 0 });
const integer = new Intl.NumberFormat("ru-KZ", { maximumFractionDigits: 0 });
const amountText = (value) => `${money.format(Math.round(value))} ₸`;
const idFormula = (value) => (value ? `=${String(value)}` : '=""');

import { DatabaseSync } from "node:sqlite";

const dbPath = path.join(projectRoot, "data", "vestigo-registry.sqlite");
const financialSearchPath = path.join(
  projectRoot,
  "app",
  "data",
  "financial-search-index.json",
);
let cachedDb = null;
let lastDbMtime = 0;
let cachedFinancialSearch = [];
let lastFinancialSearchMtime = 0;
let registryRebuilding = false;
let cachedRegistryMetadata = { source: {}, stats: [] };
let registryMetadataMtime = 0;
function getRegistryMetadata() {
  try {
    const metadataPath = path.join(projectRoot, "app", "data", "registry.json");
    const stat = fsSync.statSync(metadataPath);
    if (stat.mtimeMs !== registryMetadataMtime) {
      const registry = JSON.parse(fsSync.readFileSync(metadataPath, "utf8"));
      cachedRegistryMetadata = { source: registry.source, stats: registry.stats };
      registryMetadataMtime = stat.mtimeMs;
    }
  } catch (error) { console.error("Registry metadata unavailable:", error); }
  return cachedRegistryMetadata;
}

function getRegistryDb() {
  if (registryRebuilding) return null;
  try {
    if (fsSync.existsSync(dbPath)) {
      const stat = fsSync.statSync(dbPath);
      if (cachedDb && stat.mtimeMs === lastDbMtime) {
        return cachedDb;
      }
      if (cachedDb) {
        try {
          cachedDb.close();
        } catch {}
      }
      cachedDb = new DatabaseSync(dbPath);
      cachedDb.exec("PRAGMA busy_timeout = 5000");
      lastDbMtime = stat.mtimeMs;
      return cachedDb;
    }
  } catch (err) {
    console.error("Registry DB open error:", err);
  }
  return cachedDb;
}

function closeRegistryDb() {
  if (cachedDb) {
    try {
      cachedDb.close();
    } catch {}
  }
  cachedDb = null;
  lastDbMtime = 0;
}

function getFinancialSearchEntities() {
  try {
    if (!fsSync.existsSync(financialSearchPath)) return [];
    const stat = fsSync.statSync(financialSearchPath);
    if (stat.mtimeMs === lastFinancialSearchMtime)
      return cachedFinancialSearch;
    const payload = JSON.parse(fsSync.readFileSync(financialSearchPath, "utf8"));
    cachedFinancialSearch = Array.isArray(payload?.entities)
      ? payload.entities
      : [];
    lastFinancialSearchMtime = stat.mtimeMs;
  } catch (err) {
    console.error("Financial search index error:", err);
  }
  return cachedFinancialSearch;
}

function formatFinancialSearchEntity(item) {
  const role = String(item.role || "Контрагент ЭСФ");
  return {
    id: String(item.bin || ""),
    name: String(item.name || `Организация ${item.bin || ""}`),
    bin: String(item.bin || ""),
    rnn: "",
    taxpayerFio: "",
    head: "",
    headIin: "",
    headRnn: "",
    city: "Регион определяется по данным источников",
    categories: [role, "Локальные ЭСФ"],
    categoryCodes: ["ESF_COUNTERPARTY"],
    documents: [],
    sourceDate: "По загруженным ЭСФ",
    risk: Number(item.risk) || 35,
    level: String(item.level || "Низкий"),
    signals: 1,
    connections: Number(item.connections) || 0,
    status: role,
    reason: "Организация найдена среди поставщиков или получателей в загруженных ЭСФ.",
  };
}

function normalizeSearch(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("ru")
    .replace(/["'«»“”„`]/g, " ")
    .replace(/[()[\]{}/\\,.;:!?-]/g, " ")
    .replace(/ё/g, "е")
    .replace(/й/g, "и")
    .replace(/қ/g, "к")
    .replace(/ғ/g, "г")
    .replace(/ұ/g, "у")
    .replace(/ү/g, "у")
    .replace(/ң/g, "н")
    .replace(/һ/g, "х")
    .replace(/ө/g, "о")
    .replace(/і/g, "и")
    .replace(/ә/g, "а")
    .replace(/\s+/g, " ")
    .trim();
}

function formatEntityRow(row) {
  let categories = ["Локальные документы"];
  let categoryCodes = ["LOCAL_EVIDENCE"];
  let documents = [
    { category: "Локальные документы", number: "Выгрузка", date: "2024–2026" },
  ];

  try {
    categories = JSON.parse(String(row.categories || "[]"));
  } catch {}
  try {
    categoryCodes = JSON.parse(String(row.category_codes || "[]"));
  } catch {}
  try {
    documents = JSON.parse(String(row.documents || "[]"));
  } catch {}

  return {
    id: String(row.id || row.bin || ""),
    name: String(row.name || ""),
    bin: String(row.bin || ""),
    rnn: "",
    taxpayerFio: "",
    head: String(row.head || ""),
    headIin: String(row.head_iin || ""),
    headRnn: "",
    city: String(row.city || "Карагандинская область"),
    categories,
    categoryCodes,
    documents,
    sourceDate: "2024–2026",
    risk: Number(row.risk) || 35,
    level: String(row.level || "Низкий"),
    signals: Number(row.signals) || 1,
    connections: Number(row.connections) || 0,
    status: String(row.status || ""),
    reason: String(row.reason || ""),
  };
}

function searchEntities(
  query,
  risk = "Все уровни",
  category = "Все списки",
  page = 1,
  limit = 80,
) {
  const db = getRegistryDb();
  if (!db) {
    throw new Error("Локальная база данных недоступна");
  }

  query = String(query || "").replace(/^(?:бин|иин|рнн|руководитель|статус|документ)\s*:\s*/iu, "").trim();
  const cleanQ = normalizeSearch(query);
  const terms = cleanQ.split(" ").filter(Boolean);

  let entities = [];
  let total = 0;

  if (!query && risk === "Все уровни" && category === "Все списки") {
    const countRow = db.prepare("SELECT count(*) as count FROM entities").get();
    total = countRow.count;
    const stmt = db.prepare(`
      SELECT id, bin, name, head, head_iin, city, categories, category_codes,
             documents, risk, level, signals, connections, status, reason
      FROM entities
      ORDER BY risk DESC
      LIMIT ? OFFSET ?
    `);
    const rows = stmt.all(limit, (page - 1) * limit);
    entities = rows.map(formatEntityRow);
  } else if (query) {
    const ftsQuery = terms
      .map((t) => `${t.replace(/[*"]/g, "")}*`)
      .join(" AND ");
    let whereExtra = "";
    const extraParams = [];
    if (risk !== "Все уровни") {
      whereExtra += " AND e.level = ?";
      extraParams.push(risk);
    }
    if (category !== "Все списки") {
      whereExtra += " AND e.category_codes LIKE ?";
      extraParams.push(`%${category}%`);
    }

    try {
      const countStmt = db.prepare(`
        SELECT count(*) as count
        FROM entities_fts f
        JOIN entities e ON e.rowid = f.rowid
        WHERE entities_fts MATCH ? ${whereExtra}
      `);
      total = countStmt.get(ftsQuery, ...extraParams).count;

      const stmt = db.prepare(`
        SELECT e.id, e.bin, e.name, e.head, e.head_iin, e.city, e.categories,
               e.category_codes, e.documents, e.risk, e.level, e.signals,
               e.connections, e.status, e.reason
        FROM entities_fts f
        JOIN entities e ON e.rowid = f.rowid
        WHERE entities_fts MATCH ? ${whereExtra}
        ORDER BY (e.bin = ?) DESC, (e.name LIKE ?) DESC, e.risk DESC
        LIMIT ? OFFSET ?
      `);
      const rows = stmt.all(
        ftsQuery,
        ...extraParams,
        cleanQ,
        `%${cleanQ}%`,
        limit,
        (page - 1) * limit,
      );
      entities = rows.map(formatEntityRow);
      if (!total) throw new Error("Use substring search when FTS has no matches");
    } catch {
      let sql = "FROM entities WHERE 1=1";
      const params = [];
      for (const t of terms) {
        sql += " AND (bin LIKE ? OR search_text LIKE ?)";
        params.push(`%${t}%`, `%${t}%`);
      }
      if (risk !== "Все уровни") {
        sql += " AND level = ?";
        params.push(risk);
      }
      if (category !== "Все списки") {
        sql += " AND category_codes LIKE ?";
        params.push(`%${category}%`);
      }

      const countRow = db
        .prepare(`SELECT count(*) as count ${sql}`)
        .get(...params);
      total = countRow.count;

      const selectStmt = db.prepare(`
        SELECT id, bin, name, head, head_iin, city, categories, category_codes,
               documents, risk, level, signals, connections, status, reason
        ${sql}
        ORDER BY risk DESC
        LIMIT ? OFFSET ?
      `);
      const rows = selectStmt.all(...params, limit, (page - 1) * limit);
      entities = rows.map(formatEntityRow);
    }
  } else {
    let sql = "FROM entities WHERE 1=1";
    const params = [];
    if (risk !== "Все уровни") {
      sql += " AND level = ?";
      params.push(risk);
    }
    if (category !== "Все списки") {
      sql += " AND category_codes LIKE ?";
      params.push(`%${category}%`);
    }
    const countRow = db
      .prepare(`SELECT count(*) as count ${sql}`)
      .get(...params);
    total = countRow.count;

    const selectStmt = db.prepare(`
      SELECT id, bin, name, head, head_iin, city, categories, category_codes,
             documents, risk, level, signals, connections, status, reason
      ${sql}
      ORDER BY risk DESC
      LIMIT ? OFFSET ?
    `);
    const rows = selectStmt.all(...params, limit, (page - 1) * limit);
    entities = rows.map(formatEntityRow);
  }

  if (query && risk === "Все уровни" && category === "Все списки") {
    const registryTotal = total;
    const existsStatement = db.prepare(
      "SELECT 1 AS present FROM entities WHERE bin = ? LIMIT 1",
    );
    const financialOnly = getFinancialSearchEntities()
      .filter((item) => {
        const haystack = normalizeSearch(
          `${item.bin || ""} ${item.name || ""} ${item.role || ""}`,
        );
        return terms.every((term) => haystack.includes(term));
      })
      .filter(
        (item) =>
          /^\d{12}$/.test(String(item.bin || "")) &&
          !existsStatement.get(String(item.bin))?.present,
      )
      .sort((left, right) => {
        const leftExact =
          String(left.bin) === cleanQ || normalizeSearch(left.name) === cleanQ;
        const rightExact =
          String(right.bin) === cleanQ || normalizeSearch(right.name) === cleanQ;
        return Number(rightExact) - Number(leftExact) ||
          String(left.name).localeCompare(String(right.name), "ru");
      });
    const offset = (page - 1) * limit;
    if (offset >= registryTotal) {
      entities = financialOnly
        .slice(offset - registryTotal, offset - registryTotal + limit)
        .map(formatFinancialSearchEntity);
    } else if (offset + limit > registryTotal) {
      const remaining = limit - entities.length;
      entities.push(
        ...financialOnly.slice(0, remaining).map(formatFinancialSearchEntity),
      );
    }
    total = registryTotal + financialOnly.length;
  }

  const totalEntitiesCount = db
    .prepare("SELECT count(*) as count FROM entities")
    .get().count;
  const highRiskCount = db
    .prepare("SELECT count(*) as count FROM entities WHERE level = 'Высокий'")
    .get().count;
  const needsReviewCount = db
    .prepare("SELECT count(*) as count FROM entities WHERE level != 'Низкий'")
    .get().count;

  return {
    entities,
    total,
    page,
    limit,
    metrics: {
      entities: totalEntitiesCount,
      highRisk: highRiskCount,
      needsReview: needsReviewCount,
      links: db.prepare(`SELECT COALESCE(SUM(n*(n-1)/2),0) AS count FROM
        (SELECT COUNT(*) AS n FROM entities WHERE head_iin IS NOT NULL AND head_iin!=''
          GROUP BY head_iin HAVING COUNT(*)>1)`).get().count,
    },
    source: getRegistryMetadata().source,
    sourceStats: getRegistryMetadata().stats,
  };
}

function findEntitiesByBins(bins) {
  const db = getRegistryDb();
  if (!db) return [];
  const cleanBins = [
    ...new Set(
      bins
        .map((value) => String(value ?? "").replace(/\D/g, ""))
        .filter((value) => /^\d{12}$/.test(value)),
    ),
  ];
  const result = [];
  for (let offset = 0; offset < cleanBins.length; offset += 500) {
    const chunk = cleanBins.slice(offset, offset + 500);
    if (!chunk.length) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const rows = db
      .prepare(
        `
      SELECT id, bin, name, head, head_iin, city, categories, category_codes,
             documents, risk, level, signals, connections, status, reason
      FROM entities
      WHERE bin IN (${placeholders})
    `,
      )
      .all(...chunk);
    result.push(...rows.map(formatEntityRow));
  }
  return result;
}


function send(response, status, contentType, body, headers = {}) {
  response.writeHead(status, {
    "content-type": contentType,
    "access-control-allow-origin": siteOrigin,
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type, x-file-name",
    ...headers,
  });
  response.end(body);
}

function sendJson(response, status, value) {
  send(
    response,
    status,
    "application/json; charset=utf-8",
    JSON.stringify(value),
    { "cache-control": "no-store" },
  );
}

let refreshStatus = {
  state: "idle",
  startedAt: "",
  finishedAt: "",
  currentStep: "",
  message: "Обновление ещё не запускалось.",
  steps: [],
};

function compactOutput(value) {
  return String(value ?? "")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-2)
    .join(" · ")
    .slice(0, 700);
}

function runCommand(script, args = []) {
  return new Promise((resolve) => {
    const child = spawn(
      pythonExecutable,
      [...pythonPrefixArgs, path.join(codeRoot, "scripts", script), ...args],
      {
        cwd: projectRoot,
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-20_000);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-20_000);
    });
    child.on("error", (error) =>
      resolve({ ok: false, message: error.message }),
    );
    child.on("exit", (code) =>
      resolve({
        ok: code === 0,
        output: stdout.trim(),
        message:
          compactOutput(code === 0 ? stdout : stderr || stdout) ||
          (code === 0 ? "Выполнено" : `Код ошибки ${code}`),
      }),
    );
  });
}

async function runRefresh(scope) {
  const definitions = [
    {
      id: "evidence",
      label: "ЭСФ и локальные CSV",
      script: "import_csv_evidence.py",
      args: [path.join(projectRoot, "data", "local-documents")],
    },
    {
      id: "deals",
      label: "Сделки и контрагенты",
      script: "import_deals.py",
      args: [],
    },
    {
      id: "analytics",
      label: "Аналитика, графы и риски",
      script: "rebuild_analytics.py",
      args: [],
    },
  ];
  refreshStatus = {
    state: "running",
    startedAt: new Date().toISOString(),
    finishedAt: "",
    currentStep: definitions[0]?.label ?? "Подготовка",
    message: "Обновляем данные и пересчитываем связи.",
    steps: definitions.map((step) => ({
      id: step.id,
      label: step.label,
      state: "pending",
      message: "",
    })),
  };
  for (const definition of definitions) {
    refreshStatus.currentStep = definition.label;
    const item = refreshStatus.steps.find((step) => step.id === definition.id);
    item.state = "running";
    if (definition.id === "evidence") {
      registryRebuilding = true;
      closeRegistryDb();
    }
    const result = await runCommand(definition.script, definition.args);
    if (definition.id === "evidence") registryRebuilding = false;
    item.state = result.ok ? "done" : "warning";
    item.message = result.message;
    if (definition.id === "kgd" && result.output) {
      try {
        const sync = JSON.parse(result.output);
        const failures = sync.results.filter((entry) => entry.status !== "updated");
        item.message = `КГД: загружено ${sync.updatedFiles} из ${sync.results.length} списков.` +
          failures.map((entry) => ` ${entry.file}: ${entry.message}`).join("");
      } catch { /* Keep the command diagnostic if it is not JSON. */ }
    }
  }
  const completed = refreshStatus.steps.filter(
    (step) => step.state === "done",
  ).length;
  const warnings = refreshStatus.steps.length - completed;
  refreshStatus.state =
    completed === refreshStatus.steps.length
      ? "success"
      : completed
        ? "partial"
        : "failed";
  refreshStatus.finishedAt = new Date().toISOString();
  refreshStatus.currentStep = "";
  refreshStatus.message = warnings
    ? `Обновление завершено частично: ${completed} из ${refreshStatus.steps.length} этапов.`
    : `Все ${completed} этапа обновления завершены.`;
  await markPreparedUploadsAsImported(refreshStatus.state === "success");
}

async function readUploadLog() {
  try {
    const value = JSON.parse(await fs.readFile(uploadLogPath, "utf8"));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

async function writeUploadLog(uploads) {
  const temporary = `${uploadLogPath}.tmp`;
  await fs.mkdir(path.dirname(uploadLogPath), { recursive: true });
  await fs.writeFile(temporary, JSON.stringify(uploads, null, 2), "utf8");
  await fs.rename(temporary, uploadLogPath);
}

async function saveUploadLog(record) {
  const uploads = await readUploadLog();
  const updated = [record, ...uploads.filter((item) => item.id !== record.id)];
  await writeUploadLog(updated);
}

async function markPreparedUploadsAsImported(ok) {
  const uploads = await readUploadLog();
  let changed = false;
  const updated = uploads.map((record) => {
    if (record.status !== "Файл подготовлен. Ожидает общего пересчёта базы.")
      return record;
    changed = true;
    return {
      ...record,
      status: ok
        ? "Импортировано в единую базу"
        : "Файл сохранён, но пересчёт завершён частично",
    };
  });
  if (!changed) return;
  await writeUploadLog(updated);
}

function parseCommandJson(output) {
  const lines = String(output ?? "").trim().split(/\r?\n/).reverse();
  for (const line of lines) {
    try {
      return JSON.parse(line);
    } catch {}
  }
  return {};
}

function safeChildPath(directory, fileName) {
  const root = path.resolve(directory);
  const target = path.resolve(root, path.basename(String(fileName ?? "")));
  return target.startsWith(`${root}${path.sep}`) ? target : null;
}

async function deleteUploadedDocument(record) {
  const uploadsDirectory = path.dirname(uploadLogPath);
  const localDocumentsDirectory = path.join(projectRoot, "data", "local-documents");
  const storedName = record.storedName || record.name;
  const sourcePath = safeChildPath(uploadsDirectory, storedName);
  if (sourcePath) await fs.rm(sourcePath, { force: true });

  const generated = Array.isArray(record.generated) ? record.generated : [];
  if (generated.length) {
    for (const fileName of generated) {
      const generatedPath = safeChildPath(localDocumentsDirectory, fileName);
      if (generatedPath) await fs.rm(generatedPath, { force: true });
    }
  } else {
    const extension = path.extname(storedName).toLowerCase();
    if (extension === ".csv") {
      const csvPath = safeChildPath(localDocumentsDirectory, storedName);
      if (csvPath) await fs.rm(csvPath, { force: true });
    } else {
      const prefix = path
        .basename(storedName, extension)
        .replace(/[^\p{L}\p{N}_.-]+/gu, "_")
        .replace(/^[._]+|[._]+$/g, "");
      const entries = await fs.readdir(localDocumentsDirectory).catch(() => []);
      for (const fileName of entries.filter((name) => name.startsWith(`${prefix}__`))) {
        const generatedPath = safeChildPath(localDocumentsDirectory, fileName);
        if (generatedPath) await fs.rm(generatedPath, { force: true });
      }
    }
  }

  if (record.mode === "deals" || String(record.name).toLowerCase() === "сделки.xlsx") {
    const dealsPath = path.join(projectRoot, "data", "source-documents", "Сделки.xlsx");
    await fs.rm(dealsPath, { force: true });
  }
}

async function buildWorkbook(options) {
  // Portable exporter: standard Python/openpyxl + native DrawingML shapes.
  const python=process.env.VESTIGO_PYTHON || (process.platform==="win32"?"py":"python3");
  const args=process.env.VESTIGO_PYTHON||process.platform!=="win32"?[]:["-3.12"];
  const bytes=await new Promise((resolve,reject)=>{
    const child=spawn(python,[...args,path.join(codeRoot,"scripts/export_editable_scheme.py")],{cwd:codeRoot,env:{...process.env,PYTHONIOENCODING:"utf-8"},windowsHide:true,stdio:["pipe","pipe","pipe"]});
    const chunks=[];let length=0,error="",stopped=false;
    const timer=setTimeout(()=>{stopped=true;child.kill();reject(new Error("Превышено время экспорта схемы"));},120000);
    child.stdout.on("data",chunk=>{length+=chunk.length;if(length>64*1024*1024){stopped=true;clearTimeout(timer);child.kill();reject(new Error("Файл схемы превышает 64 МБ"));}else chunks.push(chunk);});
    child.stderr.on("data",chunk=>{error=(error+chunk.toString("utf8")).slice(-4000);});
    child.on("error",reason=>{clearTimeout(timer);reject(reason);});
    child.on("close",code=>{clearTimeout(timer);if(stopped)return;if(code!==0)return reject(new Error(error||"Ошибка экспорта"));resolve(Buffer.concat(chunks));});
    child.stdin.on("error",()=>{});child.stdin.end(JSON.stringify(options));
  });
  return {bytes};
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? "/", `http://${host}:${port}`);
  // Local readiness probe contains no data and intentionally does not require
  // the per-process internal secret. All business endpoints remain protected.
  if (requestUrl.pathname === "/health" && request.method === "GET")
    return sendJson(response, 200, { status: "ok", platform: "vestigo", installationId: createHash("sha256").update(codeRoot).digest("hex").slice(0,16) });
  if (!process.env.VESTIGO_INTERNAL_SECRET || request.headers["x-vestigo-internal"] !== process.env.VESTIGO_INTERNAL_SECRET)
    return sendJson(response, 403, { error: "Доступ к внутреннему сервису закрыт" });
  if (request.method === "OPTIONS")
    return send(response, 204, "text/plain", "");
  if (requestUrl.pathname === "/entities" && request.method === "GET") {
    const query = String(requestUrl.searchParams.get("q") ?? "").trim();
    const risk = String(requestUrl.searchParams.get("risk") ?? "Все уровни");
    const category = String(
      requestUrl.searchParams.get("category") ?? "Все списки",
    );
    const page = Math.max(1, Number(requestUrl.searchParams.get("page") ?? 1));
    const limit = Math.min(
      200,
      Math.max(20, Number(requestUrl.searchParams.get("limit") ?? 80)),
    );
    if (!Number.isSafeInteger(page) || !Number.isSafeInteger(limit))
      return sendJson(response, 400, { error: "Некорректные параметры страницы" });
    try {
      const result = searchEntities(query, risk, category, page, limit);
      return sendJson(response, 200, result);
    } catch (error) {
      console.error("Registry search failed:", error);
      return sendJson(response, 503, { error: "Локальная база временно недоступна. Повторите запрос." });
    }
  }

  if (requestUrl.pathname === "/entity-names" && request.method === "GET") {
    const bins = String(requestUrl.searchParams.get("bins") ?? "").split(",");
    return sendJson(response, 200, { entities: findEntitiesByBins(bins) });
  }

  if (requestUrl.pathname === "/imports" && request.method === "GET") {
    const bin = String(requestUrl.searchParams.get("bin") || "").replace(/\D/g, "");
    if (!/^\d{12}$/.test(bin)) return sendJson(response, 400, { error: "Некорректный БИН/ИИН" });
    const db = getRegistryDb();
    let records = [];
    if (db?.prepare("SELECT 1 FROM sqlite_master WHERE name='evidence_records'").get()) {
      records = db.prepare(`SELECT r.* FROM evidence_records r JOIN evidence_identifiers i ON i.record_id=r.id
        WHERE i.bin=? ORDER BY r.file_name,r.id`).all(bin).map((row) => ({
        id: row.id, fileName: row.file_name,
        bins: db.prepare("SELECT bin FROM evidence_identifiers WHERE record_id=?").all(row.id).map((item) => item.bin),
        fields: JSON.parse(row.fields_json),
      }));
    }
    const snapshot = JSON.parse(await fs.readFile(path.join(projectRoot, "app/data/local-evidence.json"), "utf8").catch(() => '{}'));
    return sendJson(response, 200, { records, total: records.length, source: snapshot.source || "Документы Vestigo", importedAt: snapshot.importedAt || "",
      relations: (snapshot.relations || []).filter((relation) => relation.objectBin === bin || relation.counterpartyBin === bin) });
  }

  if (requestUrl.pathname === "/uploads" && request.method === "GET")
    return sendJson(response, 200, { uploads: await readUploadLog() });
  if (requestUrl.pathname === "/upload" && request.method === "DELETE") {
    if (refreshStatus.state === "running")
      return sendJson(response, 409, {
        error: "Дождитесь завершения текущего обновления данных.",
      });
    const uploadId = String(requestUrl.searchParams.get("id") ?? "");
    const uploads = await readUploadLog();
    const record = uploads.find((item) => item.id === uploadId);
    if (!record)
      return sendJson(response, 404, { error: "Файл не найден в журнале загрузок." });
    await deleteUploadedDocument(record);
    await writeUploadLog(uploads.filter((item) => item.id !== uploadId));
    void runRefresh("rebuild");
    return sendJson(response, 202, {
      deleted: { id: record.id, name: record.name },
      refresh: refreshStatus,
    });
  }
  if (requestUrl.pathname === "/refresh" && request.method === "GET")
    return sendJson(response, 200, refreshStatus);
  if (requestUrl.pathname === "/refresh" && request.method === "POST") {
    if (refreshStatus.state !== "running")
      void runRefresh(
        requestUrl.searchParams.get("scope") === "rebuild" ? "rebuild" : "all",
      );
    return sendJson(response, 202, refreshStatus);
  }
  if (requestUrl.pathname === "/upload" && request.method === "POST") {
    if (refreshStatus.state === "running")
      return sendJson(response, 409, {
        error: "Дождитесь завершения текущего обновления данных.",
      });
    let originalName = "";
    try {
      originalName = decodeURIComponent(
        String(request.headers["x-file-name"] ?? ""),
      );
    } catch {
      originalName = "";
    }
    const extension = path.extname(originalName).toLowerCase();
    if (
      !originalName ||
      ![".csv", ".json", ".xlsx", ".xls"].includes(extension)
    )
      return sendJson(response, 400, {
        error: "Поддерживаются CSV, JSON, XLSX и XLS.",
      });
    const baseName = path
      .basename(originalName)
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
    const chunks = [];
    let uploadSize = 0;
    for await (const chunk of request) {
      uploadSize += chunk.length;
      if (uploadSize > maxUploadBody)
        return sendJson(response, 413, { error: "Файл превышает 150 МБ." });
      chunks.push(chunk);
    }
    if (!uploadSize)
      return sendJson(response, 400, { error: "Получен пустой файл." });
    const uploadHash = createHash("sha256").update(Buffer.concat(chunks)).digest("hex");
    const previousUpload = (await readUploadLog()).find((item) => item.sha256 === uploadHash && item.name === originalName);
    if (previousUpload && previousUpload.status === "Импортировано в единую базу")
      return sendJson(response, 200, { upload: previousUpload, duplicate: true });
    const safeName = `${path.basename(baseName, extension)}__${uploadHash.slice(0, 16)}${extension}`;
    const incomingDirectory = path.join(
      projectRoot,
      "data",
      "source-documents",
      "uploads",
    );
    const incomingFile = path.join(incomingDirectory, safeName);
    await fs.mkdir(incomingDirectory, { recursive: true });
    await fs.writeFile(incomingFile, Buffer.concat(chunks));
    const prepare = await runCommand("prepare_upload.py", [incomingFile]);
    if (!prepare.ok)
      return sendJson(response, 422, {
        error: prepare.message || "Не удалось распознать структуру файла.",
      });
    const prepared = parseCommandJson(prepare.output);
    const deferRebuild = requestUrl.searchParams.get("defer") === "1";
    if (deferRebuild) {
      const uploadRecord = {
        id: randomUUID(),
        sha256: uploadHash,
        name: originalName,
        size: `${(uploadSize / 1024).toFixed(1)} КБ`,
        status: "Файл подготовлен. Ожидает общего пересчёта базы.",
        importedAt: new Date().toISOString(),
        storedName: safeName,
        mode: prepared.mode || "evidence",
        generated: Array.isArray(prepared.generated) ? prepared.generated : [],
      };
      await saveUploadLog(uploadRecord);
      return sendJson(response, 200, {
        upload: uploadRecord,
        deferred: true,
        steps: { prepare: prepare.message },
      });
    }
    const dealsMode = prepared.mode === "deals";
    registryRebuilding = true;
    closeRegistryDb();
    const importResult = await runCommand("import_csv_evidence.py", [path.join(projectRoot, "data", "local-documents")]);
    if (dealsMode) {
      const dealsImport = await runCommand("import_deals.py");
      if (!dealsImport.ok) { importResult.ok = false; importResult.message = dealsImport.message; }
    }
    const analyticsResult = await runCommand("rebuild_analytics.py");
    registryRebuilding = false;
    const ok = importResult.ok && analyticsResult.ok;
    const uploadRecord = {
      id: randomUUID(),
      sha256: uploadHash,
      name: originalName,
      size: `${(uploadSize / 1024).toFixed(1)} КБ`,
      status: ok
        ? "Импортировано в единую базу"
        : "Файл сохранён, но пересчёт завершён частично",
      importedAt: new Date().toISOString(),
      storedName: safeName,
      mode: prepared.mode || (dealsMode ? "deals" : "evidence"),
      generated: Array.isArray(prepared.generated) ? prepared.generated : [],
    };
    await saveUploadLog(uploadRecord);
    return sendJson(response, ok ? 200 : 500, {
      upload: uploadRecord,
      steps: {
        prepare: prepare.message,
        import: importResult.message,
        analytics: analyticsResult.message,
      },
      error: ok
        ? undefined
        : "Файл сохранён, но один из этапов пересчёта завершился с ошибкой.",
    });
  }
  if (request.method !== "POST" || requestUrl.pathname !== "/export")
    return sendJson(response, 404, { error: "not found" });
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBody)
      return send(
        response,
        413,
        "application/json; charset=utf-8",
        JSON.stringify({ error: "Схема слишком большая." }),
      );
    chunks.push(chunk);
  }
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (
      !isPartyKey(String(input?.focusBin ?? "")) ||
      !Array.isArray(input?.payload?.nodes) ||
      !Array.isArray(input?.payload?.edges) ||
      !Array.isArray(input?.diagramPayload?.nodes) ||
      !Array.isArray(input?.diagramPayload?.edges) ||
      !input?.diagramLayout?.positions ||
      !Array.isArray(input?.diagramLayout?.labels)
    )
      throw new Error("Некорректные данные схемы");
    const result = await buildWorkbook(input);
    send(
      response,
      200,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      result.bytes,
      {
        "content-disposition": `attachment; filename="vestigo-flow-${String(input.focusBin).replace(/[^A-Za-z0-9_-]/g,"-")}.xlsx"`,
        "cache-control": "no-store",
      },
    );
  } catch (error) {
    console.error("excel export", error);
    send(
      response,
      500,
      "application/json; charset=utf-8",
      JSON.stringify({ error: "Не удалось сформировать Excel." }),
    );
  }
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.log(`Excel export уже запущен: http://${host}:${port}`);
    process.exit(1);
  }
  throw error;
});
server.listen(port, host, () =>
  console.log(`Excel export: http://${host}:${port}`),
);
