"use client";

import {
  ChangeEvent,
  FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useContext } from "react";
import { CaseScopeContext, analyticsFetch, CaseFinancialSummary } from "./case-scope";
import CaseAnalysisPanel from "@/app/components/case-analysis-panel";
import {CaseGraphEmpty} from "@/app/components/analysis-center-panel";
import PlatformSidebar, {UiIcon} from "@/app/components/platform-sidebar";
import {ThemeToggle} from "@/app/components/theme-provider";
import {CaseEsfSummary,CaseGraphFilters,CaseGraphDiagnostics,CaseEdgeInvoices,CaseBankEdgeDetails,CaseFlowReconciliation,minorText,type EsfSummary,type EsfInvoice,type EsfDiagnostic} from "@/app/components/esf-graph-panels";
import { exportFlowWorkbook } from "@/app/lib/flow-excel";
import {
  buildFlowSearchIndex,
  searchFlowIndex,
  type FlowSearchScope,
} from "@/app/lib/flow-search";

type RiskLevel = "Высокий" | "Средний" | "Низкий";

type RegistryEntity = {
  id: string;
  name: string;
  bin: string;
  rnn: string;
  taxpayerFio: string;
  head: string;
  headIin: string;
  headRnn: string;
  city: string;
  categories: string[];
  categoryCodes: string[];
  documents: { category: string; number: string; date: string }[];
  sourceDate: string;
  risk: number;
  level: RiskLevel;
  signals: number;
  connections: number;
  status: string;
  reason: string;
};

type SourceRecord = {
  id: string;
  name: string;
  url: string;
  region: string;
  categoriesCount: number;
  status: string;
  badge?: string;
  access?: string;
  fields?: string;
  refresh?: string;
};

type SourceStat = {
  code: string;
  label: string;
  file: string;
  rows: number;
  updated: string;
  status: "complete" | "partial" | "unavailable";
  message?: string;
};
type Metrics = {
  entities: number;
  highRisk: number;
  needsReview: number;
  links: number;
};
type LeaderRecord = { iin: string; name: string; entities: RegistryEntity[] };
type RegistrySource = {
  name: string;
  url: string;
  region: string;
  updated: string;
  lastSync?: string;
  syncStatus?: string;
  syncFiles?: number;
};
type OpenRecordsResult = {
  checkedAt: string;
  rsp:
    | {
        status: "found";
        name: string;
        activity: string;
        employees: string;
        businessCategory: string;
      }
    | { status: "not-found" | "unavailable" };
  dfo:
    | { status: "found"; summary: string }
    | { status: "not-found" | "unavailable" };
};
type DealRecord = {
  id: string;
  supplier: { bin: string; name: string };
  buyer: { bin: string; name: string };
  amount: number;
  vat: number;
  periodFrom: string;
  periodTo: string;
  claimNumber: string;
  claimDate: string;
  courtDecision: string;
  courtDate: string;
  reason: string;
};
type DealsResult = {
  deals: DealRecord[];
  stats: { count: number; total: number; counterparties: number };
  source: { name: string; file: string };
};
type RisksPayload = {
  leaders: (LeaderRecord & {
    highRisk: number;
    maxRisk: number;
    score: number;
  })[];
  counterpartyObjects: {
    entity: RegistryEntity;
    counterparties: number;
    operations: number;
    amount: number;
    score: number;
  }[];
  multiListObjects: {
    entity: RegistryEntity;
    matches: number;
    score: number;
  }[];
  summary: {
    leaders: number;
    maxLeaderObjects: number;
    highCounterpartyObjects: number;
    multiListObjects: number;
  };
};
type ChainNeighbor = {
  bin: string;
  name: string;
  head: string;
  headIin: string;
  knownObject: boolean;
  risk: number | null;
  level: string;
  connections: number;
  operations: number;
  amount: number;
  sources: string[];
  relations: string[];
};
type ChainPayload = {
  node: {
    bin: string;
    name: string;
    head: string;
    headIin: string;
    knownObject: boolean;
    risk: number | null;
    level: string;
  } | null;
  neighbors: ChainNeighbor[];
  componentSize: number;
  audit?: {
    uniqueNodes: number;
    uniqueEdges: number;
    duplicateDealsRemoved: number;
  };
};
type FlowNode = {
  bin: string;
  name: string;
  address: string;
  head: string;
  headIin: string;
  risk: number | null;
  level: string;
  knownObject: boolean;
  levelIndex: number;
  rnn?: string;
  taxpayerFio?: string;
  oked?: string;
  okedName?: string;
  role?: string;
  status?: string;
  reason?: string;
  categories?: string[];
  documents?: { category: string; number: string; date: string }[];
  attributes?: unknown;
};
type FlowEdge = {
  bankTransfers?: Record<string,any>[];
  invoices?: EsfInvoice[];
  id: string;
  from: string;
  to: string;
  amount: number;
  vat: number;
  dealAmount: number;
  operations: number;
  years: number[];
  goods: { name: string; amount: number }[];
  sources: string[];
  relations: string[];
  cycle: boolean;
  descriptions?: string[];
  contracts?: string[];
  paymentPurposes?: string[];
  dates?: string[];
  comments?: string[];
  attributes?: unknown;
};
type FlowPayload = {
  financial?: Record<string,any>;
  esfSummary?: EsfSummary;
  root: { bin: string; name: string } | null;
  nodes: FlowNode[];
  edges: FlowEdge[];
  audit: {
    diagnostics?: EsfDiagnostic;
    totalNodes: number;
    totalEdges: number;
    shownNodes: number;
    shownEdges: number;
    directTotal: number;
    scope: string;
    depth: number;
  };
  rule: string;
};
const flowSearchScopeOptions: { value: FlowSearchScope; label: string }[] = [
  { value: "all", label: "Все" },
  { value: "organizations", label: "Организации" },
  { value: "people", label: "Физлица" },
  { value: "edges", label: "Связи" },
  { value: "deals", label: "Сделки/договоры" },
  { value: "addresses", label: "Адреса" },
  { value: "identifiers", label: "БИН/ИИН" },
];
type RefreshStatus = {
  state: "idle" | "running" | "success" | "partial" | "failed";
  startedAt: string;
  finishedAt: string;
  currentStep: string;
  message: string;
  steps: {
    id: string;
    label: string;
    state: "pending" | "running" | "done" | "warning";
    message: string;
  }[];
};

type FinancialYear = Record<string, number> & {
  year: number;
  invoiceCount?: number;
  submissions?: number;
};
type FinancialCounterparty = {
  bin: string;
  name: string;
  invoiceCount: number;
  turnover: number;
  vat: number;
  share: number;
  years: { year: number; turnover: number }[];
};
type FinancialGood = {
  name: string;
  code: string;
  turnover: number;
  quantity: number;
  invoiceCount: number;
};
type FinancialEsfSide = {
  invoiceCount: number;
  turnover: number;
  vat: number;
  total: number;
  excludedInvoices: number;
  statuses: Record<string, number>;
  years: FinancialYear[];
  counterparties: FinancialCounterparty[];
  counterpartyCount: number;
  goods: FinancialGood[];
};
type FinancialSignal = {
  severity: "high" | "medium" | "low";
  code: string;
  title: string;
  detail: string;
  value: number;
};
type FinancialEntity = {
  bin: string;
  name: string;
  esf: { purchases: FinancialEsfSide; sales: FinancialEsfSide };
  form100: { years: FinancialYear[]; submissions: number };
  form300: {
    years: FinancialYear[];
    quarters: (Record<string, number | string> & {
      period: string;
      submissions: number;
    })[];
    submissions: number;
  };
  form328: {
    applications: number;
    imports: number;
    vatBase: number;
    vat: number;
    sellers: FinancialCounterparty[];
    goods: FinancialGood[];
  };
  signals: FinancialSignal[];
  reconciliation: {
    year: number;
    esfSales: number;
    vatTurnover: number;
    delta: number;
    deltaPct: number;
  }[];
};
type FinancialPayload = {
  entity: FinancialEntity | null;
  generatedAt: string;
  methodology: { esf: string; declarations: string; warning: string };
  audit: { profiles: number; uniqueEsfInvoices: number; sourceFiles: number };
};

const kgdCategories = [
  { code: "LOCAL_EVIDENCE", label: "Загруженные документы" },
  { code: "LOCAL_TAX_REPORTING", label: "Налоговая отчётность" },
  { code: "ESF_COUNTERPARTY", label: "Контрагенты ЭСФ" },
];

const okedTitles: Record<string, string> = {
  "09900":
    "Предоставление услуг, способствующих добыче других полезных ископаемых",
  "41201": "Строительство жилых зданий",
  "46909":
    "Оптовая торговля широким ассортиментом товаров без какой-либо конкретизации",
  "62011": "Разработка программного обеспечения",
  "68202":
    "Аренда (субаренда) и управление бизнес-центром, офисными помещениями, административным зданием",
};

function parseOkedCodes(value: string) {
  return value
    .split(/[,;\s]+/)
    .map((code) => code.trim())
    .filter((code) => /^\d{5}$/.test(code));
}

type ImportedEvidence = {
  id: string;
  fileName: string;
  bins: string[];
  fields: Record<string, string>;
  importedAt: string;
  relationship?: Omit<ImportedRelation, "operations" | "files">;
};

type ImportedRelation = {
  objectBin: string;
  objectName: string;
  objectRole: string;
  counterpartyBin: string;
  counterpartyName: string;
  counterpartyRole: string;
  relationType: string;
  confidence: number;
  operations: number;
  files: string[];
};

type RelationFilter = "all" | "counterparty" | "seller" | "buyer";

type UploadedFile = {
  id?: string;
  name: string;
  size: string;
  status: string;
  records?: number;
  matches?: number;
  importedAt?: string;
  storedName?: string;
  mode?: string;
  generated?: string[];
};

type UploadStage = "pending" | "uploading" | "processing" | "success" | "error";

type QueueFile = {
  id: string;
  file: File;
  name: string;
  sizeFormatted: string;
  sizeBytes: number;
  progress: number;
  stage: UploadStage;
  statusText: string;
  error?: string;
};

function uploadFileWithProgress(
  file: File,
  onProgress: (percent: number) => void,
  onProcessing: () => void,
  deferRebuild = false,
): Promise<{
  upload?: { id?: string; name?: string; size?: string; status?: string };
  error?: string;
}> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(
      "POST",
      `/local-service/upload${deferRebuild ? "?defer=1" : ""}`,
    );
    xhr.setRequestHeader(
      "content-type",
      file.type || "application/octet-stream",
    );
    xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name));

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        const percent = Math.min(
          99,
          Math.round((event.loaded / event.total) * 100),
        );
        onProgress(percent);
      }
    };

    xhr.upload.onload = () => {
      onProgress(100);
      onProcessing();
    };

    xhr.onload = () => {
      try {
        const json = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(json);
        } else {
          reject(new Error(json.error || `Ошибка сервера: ${xhr.status}`));
        }
      } catch {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve({ upload: { status: "Импортировано в единую базу" } });
        } else {
          reject(new Error(`Ошибка сервера: ${xhr.status}`));
        }
      }
    };

    xhr.onerror = () => {
      reject(
        new Error(
          "Локальный сервис Vestigo не отвечает. Убедитесь, что Vestigo запущен.",
        ),
      );
    };

    xhr.onabort = () => {
      reject(new Error("Загрузка файла отменена."));
    };

    xhr.send(file);
  });
}

type LocalImportBatch = {
  id: string;
  file: UploadedFile;
  evidence: ImportedEvidence[];
};

const LOCAL_IMPORTS_DB = "vestigo-local-imports";
const LOCAL_IMPORTS_STORE = "batches";
function openLocalImportsDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(LOCAL_IMPORTS_DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(LOCAL_IMPORTS_STORE))
        request.result.createObjectStore(LOCAL_IMPORTS_STORE, {
          keyPath: "id",
        });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readLocalImportBatches() {
  const database = await openLocalImportsDb();
  return await new Promise<LocalImportBatch[]>((resolve, reject) => {
    const request = database
      .transaction(LOCAL_IMPORTS_STORE, "readonly")
      .objectStore(LOCAL_IMPORTS_STORE)
      .getAll();
    request.onsuccess = () => {
      database.close();
      resolve(request.result as LocalImportBatch[]);
    };
    request.onerror = () => {
      database.close();
      reject(request.error);
    };
  });
}

async function saveLocalImportBatch(batch: LocalImportBatch) {
  const database = await openLocalImportsDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(LOCAL_IMPORTS_STORE, "readwrite");
    transaction.objectStore(LOCAL_IMPORTS_STORE).put(batch);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error);
    };
  });
}

function splitCsvLine(line: string, separator: string) {
  const values: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (character === separator && !quoted) {
      values.push(value.trim());
      value = "";
    } else value += character;
  }
  values.push(value.trim());
  return values;
}

function identifiersIn(values: string[]) {
  return [
    ...new Set(values.flatMap((value) => value.match(/\b\d{12}\b/g) ?? [])),
  ];
}

function identifiersFromFields(fields: Record<string, string>) {
  const values = Object.entries(fields)
    .filter(([key]) => /бин|иин|bin|iin/i.test(key))
    .map(([, value]) => value);
  return identifiersIn(values);
}

function parseLocalImport(fileName: string, text: string): ImportedEvidence[] {
  const timestamp = new Date().toISOString();
  if (fileName.toLowerCase().endsWith(".json")) {
    const parsed = JSON.parse(text) as unknown;
    const rows = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object"
        ? (Object.values(parsed).find(Array.isArray) ?? [parsed])
        : [];
    return (rows as unknown[]).flatMap((row, rowIndex) => {
      if (!row || typeof row !== "object") return [];
      const fields = Object.fromEntries(
        Object.entries(row as Record<string, unknown>)
          .map(([key, value]) => [
            key,
            typeof value === "string" ? value.trim() : String(value ?? ""),
          ])
          .filter(([, value]) => value),
      );
      const bins = identifiersFromFields(fields);
      return bins.length
        ? [
            {
              id: `${fileName}-${rowIndex}-${crypto.randomUUID()}`,
              fileName,
              bins,
              fields,
              importedAt: timestamp,
            },
          ]
        : [];
    });
  }

  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim());
  if (lines.length < 2) return [];
  const separators = [";", ",", "\t"];
  const separator = separators.reduce(
    (best, candidate) =>
      lines[0].split(candidate).length > lines[0].split(best).length
        ? candidate
        : best,
    ";",
  );
  const headings = splitCsvLine(lines[0], separator).map(
    (value, index) => value || `Колонка ${index + 1}`,
  );
  return lines.slice(1).flatMap((line, rowIndex) => {
    const cells = splitCsvLine(line, separator);
    const fields = Object.fromEntries(
      headings
        .map((heading, index) => [heading, cells[index] ?? ""])
        .filter(([, value]) => value),
    );
    const bins = identifiersFromFields(fields);
    return bins.length
      ? [
          {
            id: `${fileName}-${rowIndex}-${crypto.randomUUID()}`,
            fileName,
            bins,
            fields,
            importedAt: timestamp,
          },
        ]
      : [];
  });
}

const initialSources: SourceRecord[] = [];

const navItems = [
  "Обзор",
  "Объекты",
  "Риски",
  "Связи",
  "Источники",
  "Загрузки",
];
const emptyMetrics: Metrics = {
  entities: 0,
  highRisk: 0,
  needsReview: 0,
  links: 0,
};

function formatNumber(value: number) {
  return new Intl.NumberFormat("ru-RU").format(value);
}

function formatMoney(value: number) {
  const scopedCurrency = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("caseId") ? new URLSearchParams(window.location.search).get("currency") || "KZT" : "KZT";
  return (
    new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(value) +
    (scopedCurrency === "KZT" ? " ₸" : ` ${scopedCurrency}`)
  );
}

function riskClass(level: RiskLevel) {
  if (level === "Высокий") return "risk-high";
  if (level === "Средний") return "risk-medium";
  return "risk-low";
}

function formatSourceDate(value: string) {
  if (!value) return "дата не указана";
  const parts = value.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!parts) return value;
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(Number(parts[3]), Number(parts[2]) - 1, Number(parts[1])));
}

function Icon({ name }: { name: string }) {
  return <span className="ui-icon" aria-hidden="true"><UiIcon name={name}/></span>;
}
export function PlatformDashboard({
  userName,
  userEmail,
  isAdmin,
}: {
  userName: string;
  userEmail: string;
  isAdmin: boolean;
}) {
  const caseScope = useContext(CaseScopeContext);
  const [caseRevision,setCaseRevision] = useState(0);
  const [active, setActive] = useState("Обзор");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const params = new URLSearchParams(window.location.search), bin=params.get("bin");
    if(params.get('view')==='connections')setActive('Связи');
    if (bin) {
      setActive("Связи");
      setQuery(bin);
    }
  }, []);
  const [riskFilter, setRiskFilter] = useState("Все уровни");
  const [categoryFilter, setCategoryFilter] = useState("Все списки");
  const [page, setPage] = useState(1);
  const [entities, setEntities] = useState<RegistryEntity[]>([]);
  const [selected, setSelected] = useState<RegistryEntity | null>(null);
  const [detailsEntity, setDetailsEntity] = useState<RegistryEntity | null>(
    null,
  );
  const [total, setTotal] = useState(0);
  const [metrics, setMetrics] = useState<Metrics>(emptyMetrics);
  const [sourceStats, setSourceStats] = useState<SourceStat[]>([]);
  const [leaders, setLeaders] = useState<LeaderRecord[]>([]);
  const [leadersOpen, setLeadersOpen] = useState(false);
  const [leadersLoading, setLeadersLoading] = useState(false);
  const [leadersError, setLeadersError] = useState("");
  const [selectedLeader, setSelectedLeader] = useState<LeaderRecord | null>(
    null,
  );
  const [registrySource, setRegistrySource] = useState<RegistrySource | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [sources, setSources] = useState<SourceRecord[]>(initialSources);
  const [showSourceForm, setShowSourceForm] = useState(false);
  const [sourceMessage, setSourceMessage] = useState("");
  const [uploadMessage, setUploadMessage] = useState("");
  const [toast, setToast] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [queueFiles, setQueueFiles] = useState<QueueFile[]>([]);
  const [importedEvidence, setImportedEvidence] = useState<ImportedEvidence[]>(
    [],
  );
  const [importingFiles, setImportingFiles] = useState(false);
  const [refreshStatus, setRefreshStatus] = useState<RefreshStatus | null>(
    null,
  );
  const refreshPollRef = useRef<number | null>(null);
  const refreshCompletionHandled = useRef(false);
  const pageSize = 80;

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({
          q: query,
          risk: riskFilter,
          category: categoryFilter,
          page: String(page),
          limit: String(pageSize),
        });
        const response = await analyticsFetch(`/api/entities?${params}`, {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!response.ok)
          throw new Error("Не удалось прочитать локальный реестр");
        const payload = (await response.json()) as {
          entities: RegistryEntity[];
          total: number;
          metrics: Metrics;
          sourceStats: SourceStat[];
          source: RegistrySource;
        };
        if (controller.signal.aborted) return;
        setEntities(payload.entities);
        setTotal(payload.total);
        setMetrics(payload.metrics);
        setSourceStats(payload.sourceStats);
        setRegistrySource(payload.source);
        setSelected(
          (current) =>
            payload.entities.find((entity) => entity.id === current?.id) ??
            payload.entities[0] ??
            null,
        );
        setLoadError("");
      } catch (error) {
        if ((error as Error).name !== "AbortError")
          setLoadError("Локальный реестр временно недоступен или пересобирается. Дождитесь завершения обновления и повторите поиск.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 180);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [categoryFilter, page, query, riskFilter, caseRevision]);

  useEffect(() => {
    function handleKeyboard(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchInputRef.current?.focus();
      }
      if (event.key === "Escape") setDetailsEntity(null);
    }
    window.addEventListener("keydown", handleKeyboard);
    return () => window.removeEventListener("keydown", handleKeyboard);
  }, []);

  useEffect(() => {
    if (caseScope) return;
    readLocalImportBatches()
      .then((batches) => {
        const ordered = batches.sort((left, right) =>
          (right.file.importedAt ?? "").localeCompare(
            left.file.importedAt ?? "",
          ),
        );
        if (ordered.length)
          setUploadedFiles((current) => [
            ...ordered.map((batch) => batch.file),
            ...current.filter(
              (item) => !ordered.some((batch) => batch.file.name === item.name),
            ),
          ]);
        setImportedEvidence(ordered.flatMap((batch) => batch.evidence));
      })
      .catch(() =>
        setUploadMessage(
          "Локальное хранилище загрузок пока недоступно в этом браузере.",
        ),
      );
  }, []);

  useEffect(() => {
    if (caseScope) return;
    analyticsFetch("/local-service/uploads", { cache: "no-store" })
      .then((response) =>
        response.ok
          ? (response.json() as Promise<{ uploads: UploadedFile[] }>)
          : null,
      )
      .then((payload) => {
        if (payload?.uploads) setUploadedFiles(payload.uploads);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (caseScope) return;
    analyticsFetch("/api/sources", { cache: "no-store" })
      .then((response) =>
        response.ok
          ? (response.json() as Promise<{ sources: SourceRecord[] }>)
          : null,
      )
      .then((payload) => {
        if (!payload?.sources?.length) return;
        setSources((current) => {
          const savedUrls = new Set(
            payload.sources.map((source) => source.url),
          );
          return [
            ...payload.sources,
            ...current.filter((source) => !savedUrls.has(source.url)),
          ];
        });
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (caseScope) return;
    let active = true;
    analyticsFetch("/local-service/refresh", { cache: "no-store" })
      .then((response) =>
        response.ok ? (response.json() as Promise<RefreshStatus>) : null,
      )
      .then((status) => {
        if (!active || !status || status.state !== "running") return;
        setRefreshStatus(status);
        pollRefreshStatus();
      })
      .catch(() => undefined);
    return () => {
      active = false;
      if (refreshPollRef.current) window.clearTimeout(refreshPollRef.current);
    };
  }, []);

  const importedCodes = useMemo(
    () =>
      new Set(
        sourceStats
          .filter((item) => item.status === "complete")
          .map((item) => item.code),
      ),
    [sourceStats],
  );
  const partialCodes = useMemo(
    () =>
      new Set(
        sourceStats
          .filter((item) => item.status === "partial")
          .map((item) => item.code),
      ),
    [sourceStats],
  );
  const unavailableStats = useMemo(
    () =>
      new Map(
        sourceStats
          .filter((item) => item.status === "unavailable")
          .map((item) => [
            item.code,
            item.message ?? "Выгрузка временно недоступна у документов",
          ]),
      ),
    [sourceStats],
  );
  const importedRows = sourceStats.reduce((sum, item) => sum + item.rows, 0);
  const dataDate = formatSourceDate(registrySource?.updated ?? "");
  const dataMeta = registrySource?.updated
    ? `Данные документов на ${dataDate}`
    : "Дата файлов документов уточняется";
  const initials = userName
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();

  function notify(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 3200);
  }

  function pollRefreshStatus() {
    if (refreshPollRef.current) window.clearTimeout(refreshPollRef.current);
    refreshPollRef.current = window.setTimeout(async () => {
      try {
        const response = await analyticsFetch("/local-service/refresh", {
          cache: "no-store",
        });
        if (!response.ok) throw new Error("Refresh status unavailable");
        const status = (await response.json()) as RefreshStatus;
        setRefreshStatus(status);
        if (status.state === "running") {
          pollRefreshStatus();
          return;
        }
        if (!refreshCompletionHandled.current) {
          refreshCompletionHandled.current = true;
          if (status.state === "success" || status.state === "partial") {
            notify(
              status.state === "success"
                ? "Все данные обновлены. Перезагружаем платформу…"
                : "Доступные данные обновлены. Один из источников временно не ответил.",
            );
            window.setTimeout(() => window.location.reload(), 1500);
          } else
            notify(
              "Обновление не выполнено. Проверьте сообщения по этапам и повторите попытку.",
            );
        }
      } catch {
        setRefreshStatus((current) =>
          current
            ? {
                ...current,
                state: "failed",
                currentStep: "",
                message: "Локальный сервис обновления недоступен.",
              }
            : null,
        );
        notify("Не удалось получить состояние обновления.");
      }
    }, 1200);
  }

  async function handleRefreshAll() {
    if (refreshStatus?.state === "running") return;
    refreshCompletionHandled.current = false;
    try {
      const response = await analyticsFetch("/local-service/refresh", {
        method: "POST",
      });
      if (!response.ok) throw new Error("Refresh unavailable");
      const status = (await response.json()) as RefreshStatus;
      setRefreshStatus(status);
      notify("Обновление запущено. Платформу можно продолжать просматривать.");
      pollRefreshStatus();
    } catch {
      notify(
        "Сервис обновления не запущен. Перезапустите локальную платформу и повторите.",
      );
    }
  }

  function changeQuery(value: string) {
    setQuery(value);
    setPage(1);
    if (value.trim() && active !== "Объекты") setActive("Объекты");
  }
  function changeRisk(value: string) {
    setRiskFilter(value);
    setPage(1);
  }
  function changeCategory(value: string) {
    setCategoryFilter(value);
    setPage(1);
  }
  function openDetails(entity: RegistryEntity) {
    setSelectedLeader(null);
    setSelected(entity);
    setDetailsEntity(entity);
  }

  async function openLeaders() {
    setLeadersOpen(true);
    if (leaders.length || leadersLoading) return;
    setLeadersLoading(true);
    try {
      const response = await analyticsFetch("/api/leaders", { cache: "no-store" });
      if (!response.ok) throw new Error("Leaders unavailable");
      const payload = (await response.json()) as { leaders: LeaderRecord[] };
      setLeaders(payload.leaders);
      setLeadersError("");
    } catch {
      setLeadersError(
        "Не удалось получить список руководителей из локального реестра.",
      );
    } finally {
      setLeadersLoading(false);
    }
  }

  function openLeaderGraph(leader: LeaderRecord) {
    setSelectedLeader(leader);
    setSelected(leader.entities[0] ?? null);
    setLeadersOpen(false);
    setActive("Связи");
  }

  function addFilesToQueue(files: File[]) {
    if (!files.length) return;
    const allowed = files.filter((file) =>
      /\.(xlsx|xls|csv|json)$/i.test(file.name),
    );
    if (!allowed.length) {
      notify("Поддерживаются только форматы XLSX, XLS, CSV и JSON.");
      return;
    }
    const newItems: QueueFile[] = allowed.map((file) => ({
      id: crypto.randomUUID(),
      file,
      name: file.name,
      sizeFormatted: `${(file.size / 1024).toFixed(1)} КБ`,
      sizeBytes: file.size,
      progress: 0,
      stage: "pending",
      statusText: "Готов к загрузке",
    }));

    setQueueFiles((current) => {
      const existingNames = new Set(newItems.map((item) => item.name));
      return [
        ...current.filter((item) => !existingNames.has(item.name)),
        ...newItems,
      ];
    });

    setUploadMessage(
      `Выбрано файлов для импорта: ${newItems.length}. Нажмите «Начать импорт» для передачи и пересчёта базы.`,
    );
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    if (!files.length) return;
    addFilesToQueue(files);
    event.target.value = "";
  }

  function removeQueueItem(id: string) {
    setQueueFiles((current) => current.filter((item) => item.id !== id));
  }

  function clearQueue() {
    setQueueFiles([]);
  }

  async function handleStartImport() {
    const pendingItems = queueFiles.filter(
      (item) => item.stage === "pending" || item.stage === "error",
    );
    if (!pendingItems.length || importingFiles) return;

    setImportingFiles(true);
    let successCount = 0;

    for (const item of pendingItems) {
      setQueueFiles((current) =>
        current.map((q) =>
          q.id === item.id
            ? {
                ...q,
                stage: "uploading",
                progress: 0,
                statusText: "Загрузка 0%…",
              }
            : q,
        ),
      );

      try {
        const payload = await uploadFileWithProgress(
          item.file,
          (percent) => {
            setQueueFiles((current) =>
              current.map((q) =>
                q.id === item.id
                  ? {
                      ...q,
                      progress: percent,
                      statusText: `Передача файла: ${percent}%`,
                    }
                  : q,
              ),
            );
          },
          () => {
            setQueueFiles((current) =>
              current.map((q) =>
                q.id === item.id
                  ? {
                      ...q,
                      progress: 100,
                      stage: "processing",
                      statusText:
                        "Файл передан (100%). Проверяем структуру и сохраняем в очередь…",
                    }
                  : q,
              ),
            );
          },
          true,
        );

        setQueueFiles((current) =>
          current.map((q) =>
            q.id === item.id
              ? {
                  ...q,
                  progress: 100,
                  stage: "processing",
                  statusText:
                    payload.upload?.status ||
                    "Файл подготовлен. Ожидает общего пересчёта базы.",
                }
              : q,
          ),
        );

        const newRecord: UploadedFile = {
          id: item.id,
          name: item.name,
          size: item.sizeFormatted,
          status:
            payload.upload?.status ||
            "Файл подготовлен. Ожидает общего пересчёта базы.",
          importedAt: new Date().toISOString(),
        };
        setUploadedFiles((current) => [
          newRecord,
          ...current.filter((f) => f.name !== item.name),
        ]);
        successCount += 1;
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : "Не удалось импортировать файл";
        setQueueFiles((current) =>
          current.map((q) =>
            q.id === item.id
              ? {
                  ...q,
                  stage: "error",
                  statusText: errorMessage,
                  error: errorMessage,
                }
              : q,
          ),
        );
      }
    }

    if (successCount > 0) {
      setUploadMessage(
        `Передано файлов: ${formatNumber(successCount)}. Запускаем один общий пересчёт реестра, графов и рисков…`,
      );
      refreshCompletionHandled.current = false;
      try {
        const response = await analyticsFetch(
          "/local-service/refresh?scope=rebuild",
          { method: "POST" },
        );
        if (!response.ok) throw new Error("Rebuild unavailable");
        const status = (await response.json()) as RefreshStatus;
        setRefreshStatus(status);
        notify(
          `Все ${formatNumber(successCount)} файл(ов) сохранены. Выполняется общий пересчёт данных.`,
        );
        pollRefreshStatus();
      } catch {
        setUploadMessage(
          `Файлы сохранены (${formatNumber(successCount)}), но общий пересчёт не запустился. Нажмите «Обновить все данные».`,
        );
        notify("Файлы сохранены. Для завершения нажмите «Обновить все данные».");
      }
    } else {
      setUploadMessage(
        "Файлы не импортированы. Проверьте формат и наличие столбцов с БИН/ИИН.",
      );
    }
    setImportingFiles(false);
  }

  async function handleDeleteUpload(file: UploadedFile) {
    if (!file.id) {
      notify("Этот файл отсутствует в журнале локального сервиса.");
      return;
    }
    if (
      !window.confirm(
        `Удалить «${file.name}» из платформы? После удаления реестр, графы и риски будут пересчитаны.`,
      )
    )
      return;

    setUploadMessage(`Удаляем «${file.name}» и пересчитываем связанные данные…`);
    try {
      const response = await analyticsFetch(
        `/local-service/upload?id=${encodeURIComponent(file.id)}`,
        { method: "DELETE" },
      );
      const payload = (await response.json()) as {
        error?: string;
        refresh?: RefreshStatus;
      };
      if (!response.ok)
        throw new Error(payload.error || "Не удалось удалить файл");
      setUploadedFiles((current) =>
        current.filter((item) => item.id !== file.id),
      );
      if (payload.refresh) setRefreshStatus(payload.refresh);
      refreshCompletionHandled.current = false;
      notify(`Файл «${file.name}» удалён. Пересчитываем данные.`);
      pollRefreshStatus();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Не удалось удалить файл";
      setUploadMessage(message);
      notify(message);
    }
  }

  async function handleSourceSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const name = String(form.get("name") ?? "").trim();
    const url = String(form.get("url") ?? "").trim();
    if (!name || !url) return;
    try {
      const response = await analyticsFetch("/api/sources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          url,
          region: String(form.get("region") ?? "По загруженным документам"),
          categoriesCount: 0,
          status: "Ожидает настройки импорта",
        }),
      });
      const payload = (await response.json()) as {
        source?: SourceRecord;
        existing?: boolean;
        error?: string;
      };
      if (!response.ok || !payload.source)
        throw new Error(payload.error || "Не удалось сохранить источник");
      const savedSource = payload.source;
      setSources((current) => [
        savedSource,
        ...current.filter((source) => source.url !== savedSource.url),
      ]);
      setSourceMessage(
        payload.existing
          ? "Этот источник уже был в каталоге."
          : "Источник сохранён в локальном каталоге.",
      );
      setShowSourceForm(false);
      formElement.reset();
    } catch (error) {
      setSourceMessage(
        error instanceof Error
          ? error.message
          : "Не удалось сохранить источник.",
      );
    }
  }

  return (
    <div className="app-shell">
      <PlatformSidebar items={navItems.filter(item=>!caseScope||!["Источники","Загрузки"].includes(item)).map(item=>({label:item,icon:["overview","objects","risks","graph","source","upload"][navItems.indexOf(item)],active:active===item,onClick:()=>setActive(item),badge:item==="Объекты"?formatNumber(metrics.entities):undefined}))} profile={{name:userName,detail:userEmail}}/>

      <main className="main">
        <header className="topbar">
          <ThemeToggle/>
          <div className="search-shell">
            <div
              className={
                searchFocused ? "global-search focused" : "global-search"
              }
            >
              <Icon name="search" />
              <input
                ref={searchInputRef}
                value={query}
                onChange={(event) => changeQuery(event.target.value)}
                onFocus={() => setSearchFocused(true)}
                onBlur={() =>
                  window.setTimeout(() => setSearchFocused(false), 120)
                }
                placeholder="Название, БИН/ИИН, РНН, руководитель, статус или документ…"
                aria-label="Глобальный поиск"
              />
              {query && (
                <button
                  className="search-clear"
                  aria-label="Очистить поиск"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => changeQuery("")}
                >
                  ×
                </button>
              )}
              <kbd>Ctrl K</kbd>
            </div>
            {(searchFocused || query) && (
              <div className="search-assistant">
                <div>
                  <strong>
                    {query
                      ? `Найдено: ${formatNumber(total)}`
                      : "Расширенный поиск"}
                  </strong>
                  <span>
                    Можно вводить несколько слов — будут найдены записи,
                    содержащие все условия.
                  </span>
                </div>
                <div className="search-prefixes">
                  {[
                    "бин",
                    "иин",
                    "рнн",
                    "руководитель",
                    "статус",
                    "документ",
                  ].map((prefix) => (
                    <button
                      key={prefix}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        changeQuery(`${prefix}:`);
                        searchInputRef.current?.focus();
                      }}
                    >
                      {prefix}:
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <button
            className="icon-button"
            aria-label="Уведомления"
            onClick={() =>
              notify(
                `В реестр импортировано ${formatNumber(importedRows)} строк документов.`,
              )
            }
          >
            <Icon name="bell" />
            <span />
          </button>
          <button
            className="refresh-all-button"
            onClick={caseScope ? () => window.location.reload() : handleRefreshAll}
            disabled={refreshStatus?.state === "running"}
          >
            <Icon name="refresh" />{" "}
            {refreshStatus?.state === "running"
              ? refreshStatus.currentStep || "Обновляем…"
              : "Обновить все данные"}
          </button>
          <button
            className="primary-button"
            onClick={() => caseScope ? window.location.assign(`/?caseId=${caseScope.id}&tab=Документы`) : setActive("Загрузки")}
          >
            <Icon name="upload" /> Загрузить данные
          </button>
          <a className="ghost-button" href={caseScope ? `/?caseId=${caseScope.id}` : "/"}>Дела и документы</a>
        </header>

        <div className="content">
          {refreshStatus && refreshStatus.state !== "idle" && (
            <section
              className={`refresh-banner ${refreshStatus.state}`}
              role="status"
            >
              <div>
                <span className="section-kicker">ОБНОВЛЕНИЕ ДАННЫХ</span>
                <strong>
                  {refreshStatus.state === "running"
                    ? refreshStatus.currentStep
                    : refreshStatus.message}
                </strong>
                <small>
                  {refreshStatus.state === "running"
                    ? "После завершения платформа автоматически перезагрузит реестр, графы и риски."
                    : "Результат последней операции"}
                </small>
              </div>
              <div className="refresh-steps">
                {refreshStatus.steps.map((step) => (
                  <span className={step.state} key={step.id}>
                    {step.state === "done"
                      ? "✓"
                      : step.state === "warning"
                        ? "!"
                        : step.state === "running"
                          ? "↻"
                          : "·"}{" "}
                    {step.label}
                  </span>
                ))}
              </div>
            </section>
          )}
          {loadError && <div className="notice">{loadError}</div>}
          {active === "Обзор" && (
            <Overview
              entities={entities}
              selected={selected}
              onOpenDetails={openDetails}
              onOpenLeaders={openLeaders}
              total={total}
              metrics={metrics}
              riskFilter={riskFilter}
              setRiskFilter={changeRisk}
              setActive={setActive}
              loading={loading}
              importedCount={importedCodes.size}
              partialCount={partialCodes.size}
              dataMeta={dataMeta}
            />
          )}
          {active === "Объекты" && (
            <ObjectsView
              entities={entities}
              selected={selected}
              onOpenDetails={openDetails}
              total={total}
              page={page}
              setPage={setPage}
              pageSize={pageSize}
              riskFilter={riskFilter}
              setRiskFilter={changeRisk}
              categoryFilter={categoryFilter}
              setCategoryFilter={changeCategory}
              loading={loading}
              dataMeta={dataMeta}
            />
          )}
          {active === "Риски" && (caseScope ? <CaseAnalysisPanel cases={[{id:caseScope.id,caseNumber:caseScope.number,status:caseScope.status}]} caseId={caseScope.id} onCaseChange={() => {}} mode="risks" onUpdated={async () => {setCaseRevision(v=>v+1);}}/> :
            <RisksView
              onOpenLeader={openLeaderGraph}
              onOpenDetails={openDetails}
              onOpenGraph={(entity) => {
                setSelectedLeader(null);
                setSelected(entity);
                setActive("Связи");
              }}
            />
          )}
          {active === "Связи" && (
            <ConnectionsView
              selected={selected}
              leader={selectedLeader}
              notify={notify}
              onOpen={() => selected && setDetailsEntity(selected)}
              onOpenEntity={openDetails}
            />
          )}
          {active === "Источники" && (
            <SourcesView
              sources={sources}
              sourceStats={sourceStats}
              importedCodes={importedCodes}
              partialCodes={partialCodes}
              unavailableStats={unavailableStats}
              showForm={showSourceForm}
              setShowForm={setShowSourceForm}
              onSubmit={handleSourceSubmit}
              message={sourceMessage}
              notify={notify}
              dataDate={dataDate}
              syncStatus={registrySource?.syncStatus}
            />
          )}
          {active === "Загрузки" && (
            <UploadsView
              files={uploadedFiles}
              queue={queueFiles}
              importing={importingFiles}
              message={uploadMessage}
              onChange={handleFileChange}
              onDropFiles={addFilesToQueue}
              onStartImport={handleStartImport}
              onRemoveQueueItem={removeQueueItem}
              onClearQueue={clearQueue}
              onDeleteUpload={handleDeleteUpload}
              notify={notify}
            />
          )}
        </div>
      </main>
      {detailsEntity && (
        <EntityDossier
          entity={detailsEntity}
          onClose={() => setDetailsEntity(null)}
          onGraph={() => {
            setSelected(detailsEntity);
            setActive("Связи");
            setDetailsEntity(null);
          }}
          notify={notify}
        />
      )}
      {leadersOpen && (
        <LeadersModal
          leaders={leaders}
          loading={leadersLoading}
          error={leadersError}
          onClose={() => setLeadersOpen(false)}
          onOpenLeader={openLeaderGraph}
        />
      )}
      {queueFiles.some(
        (f) =>
          f.stage === "pending" ||
          f.stage === "uploading" ||
          f.stage === "processing",
      ) && (
        <button
          className="import-floating primary-button"
          onClick={handleStartImport}
          disabled={importingFiles}
        >
          {importingFiles
            ? "Идёт импорт и пересчёт…"
            : `Импортировать выбранные (${queueFiles.filter((f) => f.stage === "pending").length})`}
        </button>
      )}
      {toast && (
        <div className="action-toast" role="status">
          <Icon name="check" /> {toast}
        </div>
      )}
    </div>
  );
}

function PageHeading({
  eyebrow,
  title,
  text,
  meta = "Локальный реестр документов",
}: {
  eyebrow: string;
  title: string;
  text: string;
  meta?: string;
}) {
  return (
    <div className="page-heading">
      <div>
        <span>{eyebrow}</span>
        <h1>{title}</h1>
        <p>{text}</p>
      </div>
      <div className="heading-meta">
        <Icon name="clock" /> {meta}
      </div>
    </div>
  );
}

function Overview({
  entities,
  selected,
  onOpenDetails,
  onOpenLeaders,
  total,
  metrics,
  riskFilter,
  setRiskFilter,
  setActive,
  loading,
  importedCount,
  partialCount,
  dataMeta,
}: {
  entities: RegistryEntity[];
  selected: RegistryEntity | null;
  onOpenDetails: (entity: RegistryEntity) => void;
  onOpenLeaders: () => void;
  total: number;
  metrics: Metrics;
  riskFilter: string;
  setRiskFilter: (value: string) => void;
  setActive: (value: string) => void;
  loading: boolean;
  importedCount: number;
  partialCount: number;
  dataMeta: string;
}) {
  const caseScope = useContext(CaseScopeContext);
  return (
    <>
      <PageHeading
        eyebrow="АНАЛИТИЧЕСКИЙ ЦЕНТР"
        title="Обзор данных"
        text="Организации, участники и связи из загруженных документов."
        meta={dataMeta}
      />
      <section className="metrics" aria-label="Ключевые показатели">
        <Metric
          label="Уникальных объектов"
          value={formatNumber(metrics.entities)}
          delta="после объединения по БИН/ИИН"
          tone="blue"
        />
        <Metric
          label="Высокий приоритет"
          value={formatNumber(metrics.highRisk)}
          delta="по аналитическим сигналам"
          tone="red"
        />
        <Metric
          label="Требуют проверки"
          value={formatNumber(metrics.needsReview)}
          delta="средний и высокий уровень"
          tone="amber"
        />
        <Metric
          label={caseScope ? "Связей по операциям" : "Связей по руководителям"}
          value={formatNumber(metrics.links)}
          delta={caseScope ? "Типы документов показаны раздельно" : "Нажмите: список совпадающих ИИН"}
          tone="green"
          onClick={caseScope ? () => setActive("Связи") : onOpenLeaders}
        />
      </section>
      <section className="dashboard-grid">
        <div className="card queue-card">
          <div className="card-header">
            <div>
              <span className="section-kicker">РЕЕСТР ОБЪЕКТОВ</span>
              <h2>Объекты для проверки</h2>
            </div>
            <RiskSelect value={riskFilter} onChange={setRiskFilter} />
          </div>
          <div className="entity-list">
            {loading ? (
              <div className="empty-state">Читаем локальный реестр…</div>
            ) : (
              entities.slice(0, 20).map((entity) => (
                <button
                  key={entity.id}
                  className={
                    selected?.id === entity.id
                      ? "entity-row selected"
                      : "entity-row"
                  }
                  onClick={() => onOpenDetails(entity)}
                  aria-label={`Открыть полное досье: ${entity.name}`}
                >
                  <span className={`risk-score ${riskClass(entity.level)}`}>
                    {entity.risk}
                  </span>
                  <span className="entity-main">
                    <strong>{entity.name}</strong>
                    <small>
                      БИН/ИИН {entity.bin} ·{" "}
                      {entity.head || "руководитель не указан"}
                    </small>
                  </span>
                  <span className="entity-stats">
                    <b>{entity.signals}</b>
                    <small>категорий</small>
                  </span>
                  <span className="entity-stats">
                    <b>{entity.connections}</b>
                    <small>связей</small>
                  </span>
                  <span className="row-action">Подробнее →</span>
                </button>
              ))
            )}
            {!loading && !entities.length && (
              <div className="empty-state">
                По заданным условиям записи не найдены.
              </div>
            )}
          </div>
          <button className="text-button" onClick={() => setActive("Объекты")}>
            Показать результаты: {formatNumber(total)} <Icon name="arrow" />
          </button>
        </div>
        {selected ? (
          <RiskProfile
            entity={selected}
            onOpen={() => onOpenDetails(selected)}
          />
        ) : (
          <EmptyCard text="Выберите объект в реестре." />
        )}
      </section>
      <section className="bottom-grid">
        <div className="card graph-card">
          <div className="card-header">
            <div>
              <span className="section-kicker">ГРАФ СВЯЗЕЙ</span>
              <h2>Связи выбранного объекта</h2>
            </div>
            <button className="ghost-button" onClick={() => setActive("Связи")}>
              Открыть граф
            </button>
          </div>
          {selected ? (
            <MiniGraph entity={selected} />
          ) : (
            <div className="empty-state">Объект не выбран.</div>
          )}
        </div>
        {caseScope ? <div className="card source-health"><h2>Документы выбранного дела</h2><p>Источники, полнота обработки и исходные строки доступны в карточке дела.</p><p>Приоритет 75 / 50 / 0 соответствует максимальной серьёзности открытого вопроса (высокая / средняя / прочая). Это не вероятность нарушения.</p><a href={`/?caseId=${caseScope.id}&tab=Документы`}>Открыть документы дела →</a></div> : <div className="card source-health">
          <div className="card-header">
            <div>
              <span className="section-kicker">ИСТОЧНИК</span>
              <h2>Документы Vestigo</h2>
            </div>
            <span className="status-online">
              <i /> {importedCount} обработано · {partialCount} требуют проверки
            </span>
          </div>
          <div className="source-line">
            <div className="source-logo">V</div>
            <div>
              <strong>Данные из загруженных файлов</strong>
              <small>Excel · По загруженным документам</small>
            </div>
            <span>{dataMeta.replace("Данные документов на ", "")}</span>
          </div>
          <div className="progress-label">
            <span>Обработано файлов</span>
            <b>{importedCount}</b>
          </div>
          <div className="progress">
            <span style={{ width: importedCount ? "100%" : "0%" }} />
          </div>
          <button
            className="text-button"
            onClick={() => setActive("Источники")}
          >
            Открыть источник <Icon name="arrow" />
          </button>
        </div>}
      </section>
    </>
  );
}

function Metric({
  label,
  value,
  delta,
  tone,
  onClick,
}: {
  label: string;
  value: string;
  delta: string;
  tone: string;
  onClick?: () => void;
}) {
  const content = (
    <>
      <div className={`metric-icon ${tone}`}>
        <UiIcon name={tone==="red"?"risks":tone==="green"?"graph":tone==="amber"?"review":"objects"}/>
      </div>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        <small>{delta}</small>
      </div>
      <div className={`spark ${tone}`}>
        <i />
        <i />
        <i />
        <i />
        <i />
      </div>
    </>
  );
  return onClick ? (
    <button
      className="metric-card metric-button"
      onClick={onClick}
      aria-label="Открыть список связей по руководителям"
    >
      {content}
    </button>
  ) : (
    <div className="metric-card">{content}</div>
  );
}

function RiskSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)}>
      <option>Все уровни</option>
      <option>Высокий</option>
      <option>Средний</option>
      <option>Низкий</option>
    </select>
  );
}

function RiskProfile({
  entity,
  onOpen,
}: {
  entity: RegistryEntity;
  onOpen: () => void;
}) {
  const circumference = 2 * Math.PI * 46;
  const offset = circumference - (entity.risk / 100) * circumference;
  return (
    <div className="card risk-profile">
      <span className="section-kicker">КАРТОЧКА ОБЪЕКТА</span>
      <div className="profile-title">
        <div>
          <h2>{entity.name}</h2>
          <p>
            {entity.bin} · {entity.categories.join(" · ")}
          </p>
        </div>
        <span className={`level-badge ${riskClass(entity.level)}`}>
          {entity.level}
        </span>
      </div>
      <div className="risk-summary">
        <div className="risk-ring">
          <svg
            viewBox="0 0 112 112"
            role="img"
            aria-label={`Приоритет ${entity.risk} из 100`}
          >
            <circle cx="56" cy="56" r="46" className="ring-track" />
            <circle
              cx="56"
              cy="56"
              r="46"
              className="ring-value"
              style={{
                strokeDasharray: circumference,
                strokeDashoffset: offset,
              }}
            />
          </svg>
          <div>
            <strong>{entity.risk}</strong>
            <span>из 100</span>
          </div>
        </div>
        <div className="risk-copy">
          <span>Приоритет проверки</span>
          <p>{entity.reason}</p>
          <small>Не является выводом о нарушении</small>
        </div>
      </div>
      <ul className="signal-list" aria-label="Признаки риска">
        {entity.categories.map((category) => (
          <li className="signal" key={category}>{category}</li>
        ))}
      </ul>
      <button className="secondary-button" onClick={onOpen}>
        Открыть полное досье <Icon name="arrow" />
      </button>
    </div>
  );
}

function MiniGraph({ entity }: { entity: RegistryEntity }) {
  const caseScope = useContext(CaseScopeContext);
  const document = entity.documents.find((item) => item.number || item.date);
  return (
    <div className="mini-graph" aria-label="Связи по данным документов">
      <div className="graph-line line-a" />
      <div className="graph-line line-b" />
      <GraphNode
        className="node-center high"
        label={entity.name}
        meta={`Приоритет ${entity.risk}`}
      />
      {entity.head && (
        <GraphNode
          className="node-person"
          label={entity.head}
          meta="Руководитель"
        />
      )}
      {document && (
        <GraphNode
          className="node-right"
          label={document.number || "Документ документов"}
          meta={document.date || document.category}
        />
      )}
      {entity.head && <span className="graph-caption caption-a">руководитель</span>}
      {document && <span className="graph-caption caption-c">{caseScope ? "документ дела" : "документ источника"}</span>}
    </div>
  );
}

function GraphNode({
  className,
  label,
  meta,
}: {
  className: string;
  label: string;
  meta: string;
}) {
  return (
    <div className={`graph-node ${className}`}>
      <span>{label.slice(0, 1)}</span>
      <strong>{label}</strong>
      <small>{meta}</small>
    </div>
  );
}

function LeadersModal({
  leaders,
  loading,
  error,
  onClose,
  onOpenLeader,
}: {
  leaders: LeaderRecord[];
  loading: boolean;
  error: string;
  onClose: () => void;
  onOpenLeader: (leader: LeaderRecord) => void;
}) {
  const [query, setQuery] = useState(()=>typeof window!=="undefined"?new URLSearchParams(window.location.search).get("bin")||"":"");
  const normalized = query.trim().toLocaleLowerCase("ru");
  const visible = leaders.filter(
    (leader) =>
      !normalized ||
      `${leader.name} ${leader.iin}`
        .toLocaleLowerCase("ru")
        .includes(normalized),
  );
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="leaders-modal card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="leaders-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <span className="section-kicker">СОВПАДЕНИЯ ПО ИИН</span>
            <h2 id="leaders-title">Руководители со связями</h2>
            <p>
              Выберите руководителя, чтобы построить граф всех связанных с ним
              организаций.
            </p>
          </div>
          <button
            className="modal-close"
            onClick={onClose}
            aria-label="Закрыть"
          >
            ×
          </button>
        </div>
        <input
          className="leaders-search"
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="ФИО или ИИН руководителя"
          aria-label="Поиск руководителя"
        />
        {loading && (
          <div className="empty-state">Подготавливаем список связей…</div>
        )}
        {error && <div className="empty-state">{error}</div>}
        {!loading && !error && (
          <div className="leaders-list">
            {visible.map((leader) => (
              <button
                key={leader.iin}
                className="leader-row"
                onClick={() => onOpenLeader(leader)}
              >
                <span className="leader-avatar">{leader.name.slice(0, 1)}</span>
                <span>
                  <strong>{leader.name}</strong>
                  <small>ИИН {leader.iin}</small>
                </span>
                <span className="leader-count">
                  <b>{leader.entities.length}</b>
                  <small>организаций</small>
                </span>
                <span className="row-action">Граф →</span>
              </button>
            ))}
            {!visible.length && (
              <div className="empty-state">Совпадения не найдены.</div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function ObjectsView({
  entities,
  selected,
  onOpenDetails,
  total,
  page,
  setPage,
  pageSize,
  riskFilter,
  setRiskFilter,
  categoryFilter,
  setCategoryFilter,
  loading,
  dataMeta,
}: {
  entities: RegistryEntity[];
  selected: RegistryEntity | null;
  onOpenDetails: (entity: RegistryEntity) => void;
  total: number;
  page: number;
  setPage: (page: number) => void;
  pageSize: number;
  riskFilter: string;
  setRiskFilter: (value: string) => void;
  categoryFilter: string;
  setCategoryFilter: (value: string) => void;
  loading: boolean;
  dataMeta: string;
}) {
  const maxPage = Math.max(1, Math.ceil(total / pageSize));
  const tableGridStyle = {
    gridTemplateColumns:
      "135px minmax(260px, 1.65fr) minmax(140px, 0.85fr) minmax(160px, 0.9fr) 90px minmax(120px, 0.75fr)",
    gap: "18px",
  };
  return (
    <>
      <PageHeading
        eyebrow="ЕДИНЫЙ РЕЕСТР"
        title="Налогоплательщики"
        text="Записи из загруженных Excel- и CSV-файлов по загруженным документам."
        meta={dataMeta}
      />
      <div className="toolbar card">
        <div className="filter-group">
          <button className="filter active">
            Объекты <b>{formatNumber(total)}</b>
          </button>
          <button
            className="filter"
            onClick={() => {
              setRiskFilter("Все уровни");
              setCategoryFilter("Все списки");
            }}
          >
            Сбросить фильтры
          </button>
        </div>
        <div className="registry-filters">
          <select
            value={categoryFilter}
            onChange={(event) => setCategoryFilter(event.target.value)}
            aria-label="Фильтр по категории"
          >
            <option value="Все списки">Все категории</option>
            {kgdCategories.map((category) => (
              <option key={category.code} value={category.code}>
                {category.label}
              </option>
            ))}
          </select>
          <RiskSelect value={riskFilter} onChange={setRiskFilter} />
        </div>
      </div>
      <div className="card table-card">
        <div className="data-table table-head" style={tableGridStyle}>
          <span style={{ whiteSpace: "nowrap", paddingRight: "12px" }}>
            Приоритет
          </span>
          <span style={{ whiteSpace: "nowrap" }}>Налогоплательщик</span>
          <span>Категории и сигналы</span>
          <span>Руководитель</span>
          <span>Связи</span>
          <span>Данные на</span>
        </div>
        {loading ? (
          <div className="empty-state">Загрузка записей…</div>
        ) : (
          entities.map((entity) => (
            <button
              key={entity.id}
              className={
                selected?.id === entity.id ? "data-table active" : "data-table"
              }
              style={tableGridStyle}
              onClick={() => onOpenDetails(entity)}
              aria-label={`Открыть полное досье: ${entity.name}`}
            >
              <span>
                <i className={`score-dot ${riskClass(entity.level)}`}>
                  {entity.risk}
                </i>
              </span>
              <span>
                <strong>{entity.name}</strong>
                <small>
                  БИН/ИИН {entity.bin} · РНН {entity.rnn || "не указан"}
                </small>
              </span>
              <span>
                <em className="plain-status">{entity.categories[0]}</em>
              </span>
              <span>
                <strong>{entity.head || "Не указан"}</strong>
                <small>
                  {entity.headIin ? `ИИН ${entity.headIin}` : "ИИН не указан"}
                </small>
              </span>
              <span>
                <strong>{entity.connections}</strong>
                <small>связанных организаций</small>
              </span>
              <span>
                {entity.sourceDate}
                <span className="table-more">Подробнее →</span>
              </span>
            </button>
          ))
        )}
        {!loading && !entities.length && (
          <div className="empty-state">
            Записи не найдены. Измените запрос или сбросьте фильтры.
          </div>
        )}
      </div>
      <div className="pagination">
        <button
          className="ghost-button"
          disabled={page <= 1}
          onClick={() => setPage(page - 1)}
        >
          ← Назад
        </button>
        <span>
          Страница {page} из {maxPage} · найдено {formatNumber(total)}
        </span>
        <button
          className="ghost-button"
          disabled={page >= maxPage}
          onClick={() => setPage(page + 1)}
        >
          Вперёд →
        </button>
      </div>
    </>
  );
}

function RisksView({
  onOpenLeader,
  onOpenDetails,
  onOpenGraph,
}: {
  onOpenLeader: (leader: LeaderRecord) => void;
  onOpenDetails: (entity: RegistryEntity) => void;
  onOpenGraph: (entity: RegistryEntity) => void;
}) {
  const [data, setData] = useState<RisksPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"leaders" | "counterparties" | "lists">(
    "leaders",
  );
  const [query, setQuery] = useState(()=>typeof window!=="undefined"?new URLSearchParams(window.location.search).get("bin")||"":"");
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    analyticsFetch("/api/risks", { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error("Risks unavailable");
        return response.json() as Promise<RisksPayload>;
      })
      .then((payload) => {
        if (!cancelled) {
          setData(payload);
          setError("");
        }
      })
      .catch(() => {
        if (!cancelled)
          setError("Не удалось рассчитать группы риска из локальных данных.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [retryCount]);

  const normalized = query.trim().toLocaleLowerCase("ru");
  const leaders = (data?.leaders ?? []).filter(
    (leader) =>
      !normalized ||
      `${leader.name} ${leader.iin} ${leader.entities.map((entity) => `${entity.name} ${entity.bin}`).join(" ")}`
        .toLocaleLowerCase("ru")
        .includes(normalized),
  );
  const counterparties = (data?.counterpartyObjects ?? []).filter(
    (item) =>
      !normalized ||
      `${item.entity.name} ${item.entity.bin} ${item.entity.head} ${item.entity.headIin}`
        .toLocaleLowerCase("ru")
        .includes(normalized),
  );
  const multiLists = (data?.multiListObjects ?? []).filter(
    (item) =>
      !normalized ||
      `${item.entity.name} ${item.entity.bin} ${item.entity.head} ${item.entity.headIin} ${item.entity.categories.join(" ")}`
        .toLocaleLowerCase("ru")
        .includes(normalized),
  );

  return (
    <>
      <PageHeading
        eyebrow="АВТОМАТИЧЕСКИЙ АНАЛИЗ"
        title="Риски и совпадения"
        text="Группы формируются автоматически по связям руководителей, числу контрагентов и совпадениям в реестрах."
        meta="Не является выводом о нарушении"
      />
      {data && (
        <section className="risk-metrics" aria-label="Сводка рисков">
          <article className="card">
            <span>Руководителей с несколькими объектами</span>
            <strong>{formatNumber(data.summary.leaders)}</strong>
            <small>
              максимум {data.summary.maxLeaderObjects} объектов у одного ИИН
            </small>
          </article>
          <article className="card">
            <span>Объектов с множеством контрагентов</span>
            <strong>
              {formatNumber(data.summary.highCounterpartyObjects)}
            </strong>
            <small>порог — от 5 уникальных БИН</small>
          </article>
          <article className="card">
            <span>Совпадений в нескольких списках</span>
            <strong>{formatNumber(data.summary.multiListObjects)}</strong>
            <small>совпадения в нескольких категориях</small>
          </article>
        </section>
      )}
      <div className="card risk-toolbar">
        <div>
          {(
            [
              ["leaders", "Общие руководители", data?.summary.leaders ?? 0],
              [
                "counterparties",
                "Много контрагентов",
                data?.summary.highCounterpartyObjects ?? 0,
              ],
              [
                "lists",
                "Несколько категорий",
                data?.summary.multiListObjects ?? 0,
              ],
            ] as [typeof tab, string, number][]
          ).map(([value, label, count]) => (
            <button
              key={value}
              className={tab === value ? "filter active" : "filter"}
              onClick={() => setTab(value)}
            >
              {label}
              <b>{formatNumber(count)}</b>
            </button>
          ))}
        </div>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="ФИО, ИИН, название или БИН…"
          aria-label="Поиск в рисках"
        />
      </div>
      {loading && (
        <div className="card empty-state">
          Сопоставляем руководителей, объекты и связи…
        </div>
      )}
      {error && (
        <div
          className="notice"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span>{error}</span>
          <button
            className="secondary-button"
            style={{ width: "auto", minHeight: "32px", padding: "0 14px" }}
            onClick={() => setRetryCount((c) => c + 1)}
          >
            Повторить расчёт
          </button>
        </div>
      )}
      {!loading && !error && (
        <section className="card risk-results">
          {tab === "leaders" && (
            <>
              {leaders.map((leader, index) => (
                <article className="risk-result" key={leader.iin}>
                  <span className="risk-rank">{index + 1}</span>
                  <div className="risk-result-main">
                    <h3>{leader.name}</h3>
                    <p>ИИН {leader.iin}</p>
                    <div className="risk-object-preview">
                      {leader.entities.slice(0, 4).map((entity) => (
                        <span key={entity.bin}>
                          {entity.name} · {entity.bin}
                        </span>
                      ))}
                      {leader.entities.length > 4 && (
                        <span>и ещё {leader.entities.length - 4}</span>
                      )}
                    </div>
                  </div>
                  <div className="risk-result-count">
                    <strong>{leader.entities.length}</strong>
                    <span>объектов</span>
                    <small>{leader.highRisk} высокого приоритета</small>
                  </div>
                  <button
                    className="secondary-button"
                    onClick={() => onOpenLeader(leader)}
                  >
                    Открыть граф →
                  </button>
                </article>
              ))}
              {!leaders.length && (
                <div className="empty-state">По запросу группы не найдены.</div>
              )}
            </>
          )}
          {tab === "counterparties" && (
            <>
              {counterparties.map((item, index) => (
                <article className="risk-result" key={item.entity.bin}>
                  <span className="risk-rank">{index + 1}</span>
                  <div className="risk-result-main">
                    <span className="risk-kind">
                      МНОГО УНИКАЛЬНЫХ КОНТРАГЕНТОВ
                    </span>
                    <h3>{item.entity.name}</h3>
                    <p>
                      БИН {item.entity.bin}
                      {item.entity.head ? ` · ${item.entity.head}` : ""}
                    </p>
                  </div>
                  <div className="risk-result-count">
                    <strong>{formatNumber(item.counterparties)}</strong>
                    <span>контрагентов</span>
                    <small>
                      {formatNumber(item.operations)} операций
                      {item.amount ? ` · ${formatMoney(item.amount)}` : ""}
                    </small>
                  </div>
                  <div className="risk-actions">
                    <button
                      className="ghost-button"
                      onClick={() => onOpenDetails(item.entity)}
                    >
                      Карточка
                    </button>
                    <button
                      className="secondary-button"
                      onClick={() => onOpenGraph(item.entity)}
                    >
                      Граф →
                    </button>
                  </div>
                </article>
              ))}
              {!counterparties.length && (
                <div className="empty-state">
                  По запросу объекты не найдены.
                </div>
              )}
            </>
          )}
          {tab === "lists" && (
            <>
              {multiLists.map((item, index) => (
                <article className="risk-result" key={item.entity.bin}>
                  <span className="risk-rank">{index + 1}</span>
                  <div className="risk-result-main">
                    <span className="risk-kind">
                      СОВПАДЕНИЕ В НЕСКОЛЬКИХ СПИСКАХ
                    </span>
                    <h3>{item.entity.name}</h3>
                    <p>
                      БИН {item.entity.bin} ·{" "}
                      {item.entity.head || "руководитель не указан"}
                    </p>
                    <div className="risk-tags">
                      {item.entity.categories.map((category) => (
                        <span key={category}>{category}</span>
                      ))}
                    </div>
                  </div>
                  <div className="risk-result-count">
                    <strong>{item.matches}</strong>
                    <span>категории</span>
                    <small>приоритет {item.entity.risk} из 100</small>
                  </div>
                  <button
                    className="secondary-button"
                    onClick={() => onOpenDetails(item.entity)}
                  >
                    Открыть карточку →
                  </button>
                </article>
              ))}
              {!multiLists.length && (
                <div className="empty-state">
                  По запросу объекты не найдены.
                </div>
              )}
            </>
          )}
        </section>
      )}
    </>
  );
}

function ConnectionsView({
  selected,
  leader,
  notify,
  onOpen,
  onOpenEntity,
}: {
  selected: RegistryEntity | null;
  leader: LeaderRecord | null;
  notify: (message: string) => void;
  onOpen: () => void;
  onOpenEntity: (entity: RegistryEntity) => void;
}) {
  const [filter, setFilter] = useState("Цепочки");
  const [zoom, setZoom] = useState(1);
  const [relations, setRelations] = useState<ImportedRelation[]>([]);
  const [graphDeals, setGraphDeals] = useState<DealRecord[]>([]);
  const selectedBin = selected?.bin ?? "";
  useEffect(() => {
    let cancelled = false;
    setFilter("Цепочки");
    setZoom(1);
    setRelations([]);
    setGraphDeals([]);
    if (!selectedBin) {
      return;
    }
    Promise.all([
      analyticsFetch(`/api/imports?bin=${encodeURIComponent(selectedBin)}`, {
        cache: "no-store",
      })
        .then((response) =>
          response.ok
            ? (response.json() as Promise<{ relations: ImportedRelation[] }>)
            : { relations: [] },
        )
        .catch(() => ({ relations: [] as ImportedRelation[] })),
      analyticsFetch(`/api/deals?bin=${encodeURIComponent(selectedBin)}`, {
        cache: "no-store",
      })
        .then((response) =>
          response.ok
            ? (response.json() as Promise<DealsResult>)
            : ({ deals: [] } as unknown as DealsResult),
        )
        .catch(() => ({ deals: [] }) as unknown as DealsResult),
    ]).then(([importPayload, dealsPayload]) => {
      if (cancelled) return;
      setRelations(importPayload.relations ?? []);
      setGraphDeals(dealsPayload.deals ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedBin]);
  const counterparties = useMemo(() => {
    if (!selectedBin) return [];
    const grouped = new Map<
      string,
      {
        bin: string;
        name: string;
        role: string;
        selectedRoles: Set<string>;
        operations: number;
        amount: number;
        relationTypes: Set<string>;
        sources: Set<string>;
      }
    >();
    relations.forEach((relation) => {
      const selectedIsObject = relation.objectBin === selectedBin;
      const bin = selectedIsObject
        ? relation.counterpartyBin
        : relation.objectBin;
      if (!bin || bin === selectedBin) return;
      const current = grouped.get(bin) ?? {
        bin,
        name: selectedIsObject
          ? relation.counterpartyName
          : relation.objectName,
        role: selectedIsObject
          ? relation.counterpartyRole
          : relation.objectRole,
        selectedRoles: new Set<string>(),
        operations: 0,
        amount: 0,
        relationTypes: new Set<string>(),
        sources: new Set<string>(),
      };
      current.operations += relation.operations;
      current.selectedRoles.add(
        selectedIsObject ? relation.objectRole : relation.counterpartyRole,
      );
      current.relationTypes.add(relation.relationType);
      current.sources.add("Загруженные CSV");
      grouped.set(bin, current);
    });
    graphDeals.forEach((deal) => {
      const selectedIsSupplier = deal.supplier.bin === selectedBin;
      const party = selectedIsSupplier ? deal.buyer : deal.supplier;
      if (!party.bin || party.bin === selectedBin) return;
      const current = grouped.get(party.bin) ?? {
        bin: party.bin,
        name: party.name,
        role: selectedIsSupplier ? "Покупатель" : "Поставщик",
        selectedRoles: new Set<string>(),
        operations: 0,
        amount: 0,
        relationTypes: new Set<string>(),
        sources: new Set<string>(),
      };
      if (!current.name && party.name) current.name = party.name;
      current.operations += 1;
      current.amount += deal.amount;
      current.selectedRoles.add(
        selectedIsSupplier ? "Поставщик" : "Покупатель",
      );
      current.relationTypes.add("Сделка");
      current.sources.add("Сделки.xlsx");
      grouped.set(party.bin, current);
    });
    return [...grouped.values()].sort(
      (a, b) =>
        b.operations - a.operations || a.name.localeCompare(b.name, "ru"),
    );
  }, [graphDeals, relations, selectedBin]);
  if (leader)
    return (
      <LeaderConnectionsView
        leader={leader}
        notify={notify}
        onOpenEntity={onOpenEntity}
      />
    );
  if (!selected)
    return (
      <>
        <PageHeading
          eyebrow="ГРАФОВЫЙ АНАЛИЗ"
          title="Карта связей"
          text="Выберите объект в реестре, чтобы построить схему."
        />
        <EmptyCard text="Объект не выбран." />
      </>
    );
  const document = selected.documents.find((item) => item.number || item.date);
  const showCounterparties = filter === "Все связи" || filter === "Контрагенты";
  const showLeader = filter === "Все связи" || filter === "Руководитель";
  const showDocument = filter === "Все связи" || filter === "Документы";
  function saveScheme() {
    const blob = new Blob(
      [JSON.stringify({ selected, counterparties }, null, 2)],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const link = window.document.createElement("a");
    link.href = url;
    link.download = `vestigo-${selected?.bin || "graph"}.json`;
    link.click();
    URL.revokeObjectURL(url);
    notify("Схема сохранена в JSON на этом компьютере.");
  }
  return (
    <>
      <PageHeading
        eyebrow="ГРАФОВЫЙ АНАЛИЗ"
        title="Карта связей"
        text="Интерактивное исследование прямых и косвенных связей между объектами."
      />
      <div className="graph-toolbar card">
        <div>
          {[
            "Цепочки",
          ].map((item) => (
            <button
              key={item}
              className={filter === item ? "filter active" : "filter"}
              onClick={() => setFilter(item)}
            >
              {item}
              {item === "Контрагенты" && <b>{counterparties.length}</b>}
            </button>
          ))}
        </div>
        {filter !== "Цепочки" && (
          <div>
            <button className="ghost-button" onClick={saveScheme}>
              Сохранить схему
            </button>
          </div>
        )}
      </div>
      {filter === "Цепочки" ? (
        <ChainExplorer
          root={selected}
          notify={notify}
          onOpenEntity={onOpenEntity}
        />
      ) : (
        <div className="connections-layout">
          <div className="card large-graph entity-graph">
            <div className="graph-grid" />
            <EntityNetwork
              selected={selected}
              counterparties={showCounterparties ? counterparties : []}
              leader={showLeader ? selected.head : ""}
              leaderIin={selected.headIin}
              document={showDocument ? document : undefined}
              zoom={zoom}
              notify={notify}
            />
            <div className="zoom-controls">
              <button
                onClick={() => setZoom((value) => Math.min(1.35, value + 0.1))}
              >
                ＋
              </button>
              <button
                onClick={() => setZoom((value) => Math.max(0.75, value - 0.1))}
              >
                −
              </button>
              <button onClick={() => setZoom(1)}>⌖</button>
            </div>
          </div>
          <aside className="card graph-inspector">
            <span className="section-kicker">ВЫБРАННЫЙ ОБЪЕКТ</span>
            <h2>{selected.name}</h2>
            <p>{selected.bin} · По загруженным документам</p>
            <div className="inspector-score">
              <strong>{selected.risk}</strong>
              <span>
                Приоритет проверки
                <br />
                <b>{selected.level}</b>
              </span>
            </div>
            <dl>
              <div>
                <dt>Контрагентов</dt>
                <dd>{counterparties.length}</dd>
              </div>
              <div>
                <dt>Операций</dt>
                <dd>
                  {formatNumber(
                    counterparties.reduce(
                      (sum, item) => sum + item.operations,
                      0,
                    ),
                  )}
                </dd>
              </div>
              <div>
                <dt>Сумма сделок</dt>
                <dd>
                  {formatMoney(
                    counterparties.reduce((sum, item) => sum + item.amount, 0),
                  )}
                </dd>
              </div>
              <div>
                <dt>Связей по руководителю</dt>
                <dd>{selected.connections}</dd>
              </div>
              <div>
                <dt>Документов</dt>
                <dd>{selected.documents.length}</dd>
              </div>
            </dl>
            <h3>Основание</h3>
            <p className="reason-box">{selected.reason}</p>
            <button className="secondary-button" onClick={onOpen}>
              Открыть карточку <Icon name="arrow" />
            </button>
            <div className="legend">
              <h3>Обозначения</h3>
              <span>
                <i className="legend-company" /> Выбранная организация
              </span>
              <span>
                <i className="legend-counterparty" /> Контрагент
              </span>
              <span>
                <i className="legend-person" /> Руководитель
              </span>
              <span>
                <i className="legend-data" /> Документ
              </span>
            </div>
          </aside>
        </div>
      )}
    </>
  );
}

function ChainExplorer({
  root,
  notify,
  onOpenEntity,
}: {
  root: RegistryEntity;
  notify: (message: string) => void;
  onOpenEntity: (entity: RegistryEntity) => void;
}) {
  const caseScope = useContext(CaseScopeContext);
  const [payload, setPayload] = useState<FlowPayload | null>(null);
  const [graphFilters,setGraphFilters]=useState<Record<string,string>>({});
  const [debouncedFilters,setDebouncedFilters]=useState<Record<string,string>>({});
  const [selectedInvoices,setSelectedInvoices]=useState<EsfInvoice[]|null>(null);
  const [selectedBank,setSelectedBank]=useState<FlowEdge|null>(null);
  useEffect(()=>{const p=new URLSearchParams(window.location.search);if(p.get('documents'))setGraphFilters({documents:p.get('documents')!});},[]);
  const filterQuery=new URLSearchParams(Object.entries(debouncedFilters).filter(([,v])=>v)).toString();
  useEffect(()=>{const timer=setTimeout(()=>setDebouncedFilters(graphFilters),250);return()=>clearTimeout(timer);},[graphFilters]);
  const [retryCount, setRetryCount] = useState(0);
  const [scope, setScope] = useState<"significant" | "all">("significant");
  const [depth, setDepth] = useState(3);
  const [focusBin, setFocusBin] = useState(root.bin);
  useEffect(()=>{setGraphPage(0);setSelectedInvoices(null);setSelectedBank(null);},[filterQuery,focusBin]);
  const [graphPage, setGraphPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [searchScopes, setSearchScopes] = useState<FlowSearchScope[]>(["all"]);
  const [activeResultIndex, setActiveResultIndex] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setFocusBin(root.bin);
    setScope("significant");
    setDepth(3);
    setGraphPage(0);
    setSearchQuery("");
    setDebouncedQuery("");
  }, [root.bin]);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(searchQuery), 250);
    return () => window.clearTimeout(timer);
  }, [searchQuery]);
  useEffect(() => {
    setGraphPage(0);
  }, [depth, focusBin, scope]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    analyticsFetch(
      `/api/flow?bin=${encodeURIComponent(focusBin)}&scope=${scope}&depth=${depth}&${caseScope?filterQuery:""}`,
      { cache: "no-store" },
    )
      .then((response) =>
        response.ok
          ? (response.json() as Promise<FlowPayload>)
          : Promise.reject(new Error("flow unavailable")),
      )
      .then((result) => {
        if (active) {
          setPayload(result);
          setError("");
        }
      })
      .catch(() => {
        if (active) {
          setPayload(null);
          setError("Не удалось построить финансовую цепочку.");
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [depth, focusBin, scope, retryCount,filterQuery,caseScope]);

  const display = useMemo(() => {
    if (!payload || scope === "significant") return payload;
    const pageSize = 60;
    const rootNode = payload.nodes.find((node) => node.bin === focusBin);
    const others = payload.nodes
      .filter((node) => node.bin !== focusBin)
      .sort(
        (left, right) =>
          Math.abs(left.levelIndex) - Math.abs(right.levelIndex) ||
          left.levelIndex - right.levelIndex ||
          left.name.localeCompare(right.name, "ru"),
      );
    const pageNodes = others.slice(
      graphPage * pageSize,
      (graphPage + 1) * pageSize,
    );
    const visibleBins = new Set([
      focusBin,
      ...pageNodes.map((node) => node.bin),
    ]);
    return {
      ...payload,
      nodes: [...(rootNode ? [rootNode] : []), ...pageNodes],
      edges: payload.edges.filter(
        (edge) => visibleBins.has(edge.from) && visibleBins.has(edge.to),
      ),
    };
  }, [focusBin, graphPage, payload, scope]);

  const searchIndex = useMemo(
    () =>
      buildFlowSearchIndex(
        (payload?.nodes ?? []) as unknown as Record<string, unknown>[],
        (payload?.edges ?? []) as unknown as Record<string, unknown>[],
      ),
    [payload],
  );
  const searchResults = useMemo(
    () => searchFlowIndex(searchIndex, debouncedQuery, searchScopes),
    [debouncedQuery, searchIndex, searchScopes],
  );
  const activeResult = searchResults[activeResultIndex] ?? null;
  const directNodeMatches = useMemo(
    () =>
      new Set(
        searchResults
          .filter((item) => item.kind === "node")
          .map((item) => item.nodeBin!),
      ),
    [searchResults],
  );
  const matchedEdgeIds = useMemo(
    () =>
      new Set(
        searchResults
          .filter((item) => item.kind === "edge")
          .map((item) => item.edgeId!),
      ),
    [searchResults],
  );
  const highlightedNodeBins = useMemo(() => {
    const bins = new Set(directNodeMatches);
    for (const result of searchResults) {
      if (result.kind === "edge") {
        if (result.from) bins.add(result.from);
        if (result.to) bins.add(result.to);
      }
    }
    return bins;
  }, [directNodeMatches, searchResults]);
  const activeNodeBins = useMemo(() => {
    const bins = new Set<string>();
    if (activeResult?.nodeBin) bins.add(activeResult.nodeBin);
    if (activeResult?.from) bins.add(activeResult.from);
    if (activeResult?.to) bins.add(activeResult.to);
    return bins;
  }, [activeResult]);
  const searchActive = Boolean(debouncedQuery.trim());

  useEffect(() => {
    setActiveResultIndex(0);
  }, [debouncedQuery, searchScopes]);
  useEffect(() => {
    if (activeResultIndex >= searchResults.length)
      setActiveResultIndex(Math.max(0, searchResults.length - 1));
  }, [activeResultIndex, searchResults.length]);
  useEffect(() => {
    if (scope !== "all" || !activeResult || !payload) return;
    const targetBin =
      activeResult.nodeBin || activeResult.from || activeResult.to;
    if (!targetBin || targetBin === focusBin) return;
    const others = payload.nodes
      .filter((node) => node.bin !== focusBin)
      .sort(
        (left, right) =>
          Math.abs(left.levelIndex) - Math.abs(right.levelIndex) ||
          left.levelIndex - right.levelIndex ||
          left.name.localeCompare(right.name, "ru"),
      );
    const targetIndex = others.findIndex((node) => node.bin === targetBin);
    if (targetIndex >= 0) setGraphPage(Math.floor(targetIndex / 60));
  }, [activeResult, focusBin, payload, scope]);

  const layout = useMemo(() => {
    const nodes = display?.nodes ?? [];
    const edges = display?.edges ?? [];
    const cardWidth = 360;
    const cardHeight = 152;
    const horizontalGap = 84;
    const verticalGap = 142;
    const maxPerBand = scope === "all" ? 10 : 8;
    const levels = new Map<number, FlowNode[]>();
    const edgeWeight = new Map<string, number>();
    edges.forEach((edge) => {
      const weight =
        Math.max(edge.amount, edge.dealAmount) + edge.operations * 100000;
      edgeWeight.set(edge.from, (edgeWeight.get(edge.from) ?? 0) + weight);
      edgeWeight.set(edge.to, (edgeWeight.get(edge.to) ?? 0) + weight);
    });
    nodes.forEach((node) => {
      const group = levels.get(node.levelIndex) ?? [];
      group.push(node);
      levels.set(node.levelIndex, group);
    });
    levels.forEach((group) =>
      group.sort(
        (left, right) =>
          (edgeWeight.get(right.bin) ?? 0) - (edgeWeight.get(left.bin) ?? 0) ||
          left.name.localeCompare(right.name, "ru"),
      ),
    );
    // Financial chains are read from the bottom upwards: a supplier is placed
    // below its recipient, so every supplier -> recipient arrow points up.
    const orderedLevels = [...levels.keys()].sort((a, b) => b - a);
    const stageWidth = Math.max(
      1160,
      Math.min(
        maxPerBand,
        Math.max(1, ...[...levels.values()].map((items) => items.length)),
      ) *
        (cardWidth + horizontalGap) +
        180,
    );
    const positions = new Map<
      string,
      { x: number; y: number; width: number; height: number }
    >();
    const estimatedCardHeight = (node: FlowNode) => {
      const nameLines = Math.max(
        1,
        Math.ceil(String(node.name || "").length / 37),
      );
      const headLines = node.head
        ? Math.max(
            1,
            Math.ceil(
              `Руководитель: ${node.head}${node.headIin ? ` · ${node.headIin}` : ""}`
                .length / 43,
            ),
          )
        : 0;
      const addressLines = node.address
        ? Math.max(1, Math.ceil(String(node.address).length / 48))
        : 0;
      return Math.min(
        330,
        Math.max(
          cardHeight,
          78 + nameLines * 22 + headLines * 19 + addressLines * 18,
        ),
      );
    };
    let cursorY = 58;
    for (const level of orderedLevels) {
      const group = levels.get(level) ?? [];
      const rows = Math.max(1, Math.ceil(group.length / maxPerBand));
      for (let row = 0; row < rows; row += 1) {
        const items = group.slice(row * maxPerBand, (row + 1) * maxPerBand);
        const rowWidth =
          items.length * cardWidth +
          Math.max(0, items.length - 1) * horizontalGap;
        const startX = (stageWidth - rowWidth) / 2;
        const rowHeight = Math.max(
          cardHeight,
          ...items.map(estimatedCardHeight),
        );
        items.forEach((node, index) =>
          positions.set(node.bin, {
            x: startX + index * (cardWidth + horizontalGap),
            y: cursorY,
            width: cardWidth,
            height: estimatedCardHeight(node),
          }),
        );
        cursorY += rowHeight + 44;
      }
      cursorY += verticalGap;
    }
    const stageHeight = Math.max(620, cursorY - verticalGap + 70);
    const labels = edges.flatMap((edge, index) => {
      const from = positions.get(edge.from);
      const to = positions.get(edge.to);
      if (!from || !to) return [];
      const upward = to.y < from.y;
      const sourceX = from.x + from.width / 2;
      const sourceY = upward ? from.y : from.y + from.height;
      const targetX = to.x + to.width / 2;
      const targetY = upward ? to.y + to.height : to.y;
      const labelWidth = 228;
      const labelHeight = 78;
      const offset = ((index % 3) - 1) * 42;
      return [
        {
          edge,
          x: Math.max(
            8,
            Math.min(
              stageWidth - labelWidth - 8,
              (sourceX + targetX) / 2 - labelWidth / 2 + offset,
            ),
          ),
          y: Math.max(8, (sourceY + targetY) / 2 - labelHeight / 2),
          width: labelWidth,
          height: labelHeight,
        },
      ];
    });
    return {
      positions,
      labels,
      stageWidth,
      stageHeight,
      cardWidth,
      cardHeight,
    };
  }, [display, scope]);

  useEffect(() => {
    if (!activeResult || !scrollRef.current) return;
    const nodeBin =
      activeResult.nodeBin || activeResult.from || activeResult.to;
    const nodePosition = nodeBin ? layout.positions.get(nodeBin) : undefined;
    const edgePosition = activeResult.edgeId
      ? layout.labels.find((item) => item.edge.id === activeResult.edgeId)
      : undefined;
    const target = nodePosition
      ? {
          x: nodePosition.x + nodePosition.width / 2,
          y: nodePosition.y + nodePosition.height / 2,
        }
      : edgePosition
        ? {
            x: edgePosition.x + edgePosition.width / 2,
            y: edgePosition.y + edgePosition.height / 2,
          }
        : null;
    if (!target) return;
    const frame = window.requestAnimationFrame(() => {
      const viewport = scrollRef.current;
      if (!viewport) return;
      viewport.scrollTo({
        left: Math.max(0, target.x - viewport.clientWidth / 2),
        top: Math.max(0, target.y - viewport.clientHeight / 2),
        behavior: "smooth",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeResult, graphPage, layout]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !display) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 1.25);
    canvas.width = Math.round(layout.stageWidth * ratio);
    canvas.height = Math.round(layout.stageHeight * ratio);
    canvas.style.width = `${layout.stageWidth}px`;
    canvas.style.height = `${layout.stageHeight}px`;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, layout.stageWidth, layout.stageHeight);
    display.edges.forEach((edge) => {
      const from = layout.positions.get(edge.from);
      const to = layout.positions.get(edge.to);
      if (!from || !to) return;
      const vertical = Math.abs(to.y - from.y) > 24;
      const upward = vertical && to.y < from.y;
      const leftToRight = !vertical && to.x >= from.x;
      const startX = vertical
        ? from.x + from.width / 2
        : leftToRight
          ? from.x + from.width
          : from.x;
      const startY = vertical
        ? upward
          ? from.y
          : from.y + from.height
        : from.y + from.height / 2;
      const endX = vertical
        ? to.x + to.width / 2
        : leftToRight
          ? to.x
          : to.x + to.width;
      const endY = vertical
        ? upward
          ? to.y + to.height
          : to.y
        : to.y + to.height / 2;
      const control = Math.max(58, Math.abs(endY - startY) * 0.42);
      const matched = matchedEdgeIds.has(edge.id);
      const active = activeResult?.edgeId === edge.id;
      context.save();
      context.globalAlpha = searchActive && !matched ? 0.14 : 1;
      context.strokeStyle = active
        ? "#e43b24"
        : matched
          ? "#ef8a17"
          : edge.cycle
            ? "#c6544f"
            : caseScope&&edge.bankTransfers?.length
              ? getComputedStyle(canvas).getPropertyValue('--ui-success-text').trim()||'#7a8289'
              : caseScope&&edge.invoices?.length
                ? getComputedStyle(canvas).getPropertyValue('--ui-accent').trim()||'#7a8289'
                : "#7a8289";
      context.fillStyle = context.strokeStyle;
      context.lineWidth = active ? 6 : matched ? 4.5 : edge.cycle ? 3 : 2.5;
      context.setLineDash(edge.cycle ? [5, 7] : caseScope&&edge.bankTransfers?.length ? [] : [12, 9]);
      context.beginPath();
      context.moveTo(startX, startY);
      if (vertical)
        context.bezierCurveTo(
          startX,
          startY + (upward ? -control : control),
          endX,
          endY + (upward ? control : -control),
          endX,
          endY + (upward ? 10 : -10),
        );
      else
        context.bezierCurveTo(
          startX + (leftToRight ? 110 : -110),
          startY,
          endX + (leftToRight ? -110 : 110),
          endY,
          endX + (leftToRight ? -9 : 9),
          endY,
        );
      context.stroke();
      context.setLineDash([]);
      const angle = vertical
        ? upward
          ? -Math.PI / 2
          : Math.PI / 2
        : leftToRight
          ? 0
          : Math.PI;
      const tipX = vertical ? endX : endX + (leftToRight ? -3 : 3);
      const tipY = vertical ? endY + (upward ? 3 : -3) : endY;
      context.beginPath();
      context.moveTo(tipX, tipY);
      context.lineTo(
        tipX - 13 * Math.cos(angle - Math.PI / 6),
        tipY - 13 * Math.sin(angle - Math.PI / 6),
      );
      context.lineTo(
        tipX - 13 * Math.cos(angle + Math.PI / 6),
        tipY - 13 * Math.sin(angle + Math.PI / 6),
      );
      context.closePath();
      context.fill();
      context.restore();
    });
  }, [activeResult, display, layout, matchedEdgeIds, searchActive]);

  async function saveFlow() {
    if (!payload || !display || exporting) return;
    const selectedCurrency = new URLSearchParams(window.location.search).get("currency") || "KZT";
    if (selectedCurrency !== "KZT") { notify("Редактируемый Excel этой версии использует тенге. Экспорт другой валюты заблокирован, чтобы не подписать суммы неверно."); return; }
    setExporting(true);
    try {
      await exportFlowWorkbook({
        payload,
        diagramPayload: display,
        diagramLayout: {
          positions: Object.fromEntries(layout.positions),
          labels: layout.labels.map(({ edge, x, y, width, height }) => ({
            edgeId: edge.id,
            x,
            y,
            width,
            height,
          })),
          stageWidth: layout.stageWidth,
          stageHeight: layout.stageHeight,
        },
        focusBin,
        scopeLabel: caseScope ? "Материалы выбранного дела" : scope === "all" ? "Все связи" : "Значимые цепочки",
        depth,
        pageLabel:
          scope === "all"
            ? `лист ${graphPage + 1} из ${allPages}`
            : "все показанные связи",
      });
      notify(
        "Редактируемая схема и полные таблицы связей сохранены в Excel на этом компьютере.",
      );
    } catch (exportError) {
      console.error(exportError);
      notify(
        "Не удалось сохранить Excel. Повторите экспорт после полной загрузки схемы.",
      );
    } finally {
      setExporting(false);
    }
  }

  function toggleSearchScope(value: FlowSearchScope) {
    if (value === "all") {
      setSearchScopes(["all"]);
      return;
    }
    setSearchScopes((current) => {
      const specific = current.filter((item) => item !== "all");
      const next = specific.includes(value)
        ? specific.filter((item) => item !== value)
        : [...specific, value];
      return next.length ? next : ["all"];
    });
  }

  function clearFlowSearch() {
    setSearchQuery("");
    setDebouncedQuery("");
    setSearchScopes(["all"]);
    setActiveResultIndex(0);
  }

  function moveSearchResult(direction: number) {
    if (!searchResults.length) return;
    setActiveResultIndex(
      (current) =>
        (current + direction + searchResults.length) % searchResults.length,
    );
  }

  async function openFlowNodeCard(bin: string) {
    if (bin === root.bin) {
      onOpenEntity(root);
      return;
    }
    try {
      const response = await analyticsFetch(
        `/api/entities?q=${encodeURIComponent(bin)}&limit=10`,
        { cache: "no-store" },
      );
      if (response.ok) {
        const result = (await response.json()) as {
          entities?: RegistryEntity[];
        };
        const exact = result.entities?.find((entity) => entity.bin === bin);
        if (exact) {
          onOpenEntity(exact);
          return;
        }
      }
    } catch {
      // Для контрагента без полной записи открывается карточка из данных графа.
    }
    const node = payload?.nodes.find((item) => item.bin === bin);
    if (!node) return;
    onOpenEntity({
      id: node.bin,
      name: node.name,
      bin: node.bin,
      rnn: node.rnn ?? "",
      taxpayerFio: node.taxpayerFio ?? "",
      head: node.head ?? "",
      headIin: node.headIin ?? "",
      headRnn: "",
      city: node.address || "Адрес не указан",
      categories: node.categories?.length
        ? node.categories
        : [node.role || "Контрагент графа"],
      categoryCodes: [],
      documents: node.documents ?? [],
      sourceDate: "данные текущей схемы",
      risk: node.risk ?? 35,
      level: (["Высокий", "Средний", "Низкий"].includes(node.level)
        ? node.level
        : "Низкий") as RiskLevel,
      signals: node.categories?.length ?? 1,
      connections: 0,
      status: node.status ?? "Объект найден в текущей граф-схеме",
      reason:
        node.reason ?? "Карточка сформирована по сведениям текущей граф-схемы.",
    });
  }

  function openActiveSearchResult() {
    if (!activeResult) return;
    const bin = activeResult.nodeBin || activeResult.from || activeResult.to;
    if (bin) void openFlowNodeCard(bin);
  }

  const incomingCounts = new Map<string, number>();
  const outgoingCounts = new Map<string, number>();
  display?.edges.forEach((edge) => {
    incomingCounts.set(edge.to, (incomingCounts.get(edge.to) ?? 0) + 1);
    outgoingCounts.set(edge.from, (outgoingCounts.get(edge.from) ?? 0) + 1);
  });
  const allPageSize = 60;
  const allOtherNodes = Math.max(0, (payload?.nodes.length ?? 1) - 1);
  const allPages = Math.max(1, Math.ceil(allOtherNodes / allPageSize));
  return (
    <section className="card flow-panel">
      <div className="flow-summary">
        <div>
          <span className="section-kicker">
            {caseScope?"ЦЕПОЧКА ПОСТАВОК И ОПЕРАЦИЙ":"НАПРАВЛЕННАЯ ФИНАНСОВАЯ ЦЕПОЧКА"}
          </span>
          <strong>{payload?.root?.name ?? root.name}</strong>
          <small>{focusBin.startsWith("IBAN:")?"IBAN "+focusBin.slice(5):"БИН "+focusBin}</small>
        </div>
        <div>
          <span>{scope === "all" ? "Загружено / на листе" : "Показано"}</span>
          <b>
            {scope === "all"
              ? `${formatNumber(payload?.audit.shownNodes ?? 0)} / ${formatNumber(display?.nodes.length ?? 0)} узлов`
              : `${formatNumber(payload?.audit.shownNodes ?? 0)} узлов · ${formatNumber(payload?.audit.shownEdges ?? 0)} связей`}
          </b>
        </div>
        <div>
          <span>Правило направления</span>
          <b>{caseScope ? "ЭСФ: поставщик → покупатель; оплата: плательщик → получатель" : "Поставщик → получатель"}</b>
        </div>
        <div className="flow-summary-actions">
          <button
            className="ghost-button"
            onClick={saveFlow}
            disabled={!payload || loading || exporting}
          >
            {exporting
              ? "Создаём Excel…"
              : "Сохранить редактируемую схему в Excel"}
          </button>
          {focusBin !== root.bin && (
            <button
              className="ghost-button"
              onClick={() => setFocusBin(root.bin)}
            >
              К исходному объекту
            </button>
          )}
        </div>
      </div>
      {caseScope&&<><CaseGraphFilters filters={graphFilters} setFilters={setGraphFilters} diagnostics={payload?.audit.diagnostics}/>{payload?.financial&&<CaseFlowReconciliation data={payload.financial} caseId={caseScope.id}/>} {payload?.esfSummary&&payload.esfSummary.purchaseCount+payload.esfSummary.saleCount>0&&<CaseEsfSummary summary={payload.esfSummary}/>} {payload?.audit.diagnostics&&<CaseGraphDiagnostics diagnostics={payload.audit.diagnostics}/>}</>}
      {caseScope&&selectedInvoices&&<CaseEdgeInvoices invoices={selectedInvoices} caseId={caseScope.id} onClose={()=>setSelectedInvoices(null)}/>}
      {caseScope&&selectedBank&&<CaseBankEdgeDetails edge={selectedBank} caseId={caseScope.id} onClose={()=>setSelectedBank(null)}/>}
      {caseScope&&!loading&&payload&&!payload.edges.length&&<CaseGraphEmpty caseId={caseScope.id} onSelect={setFocusBin}/>}
      <div className="flow-controls">
        <div>
          <button
            className={scope === "significant" ? "active" : ""}
            onClick={() => setScope("significant")}
          >
            {caseScope ? "Схема без разбиения" : "Значимые цепочки"}
          </button>
          <button
            className={scope === "all" ? "active" : ""}
            onClick={() => setScope("all")}
          >
            {caseScope ? "Постранично" : "Все связи"}{" "}
            {payload?.audit.directTotal
              ? `(${formatNumber(payload.audit.directTotal)})`
              : ""}
          </button>
        </div>
        <label>
          Глубина
          <select
            value={depth}
            onChange={(event) => setDepth(Number(event.target.value))}
          >
            <option value={1}>1 уровень</option>
            <option value={2}>2 уровня</option>
            <option value={3}>3 уровня</option>
            <option value={4}>4 уровня</option>
          </select>
        </label>
      </div>
      <div className="flow-search-panel">
        <div className="flow-search-row">
          <label className="flow-search-input">
            <span aria-hidden="true">⌕</span>
            <input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Поиск по схеме"
              aria-label="Поиск по содержимому граф-схемы"
            />
          </label>
          {searchActive && (
            <strong className="flow-search-count" aria-live="polite">
              Найдено: {formatNumber(searchResults.length)}
            </strong>
          )}
          {(searchQuery || searchScopes[0] !== "all") && (
            <button className="flow-search-clear" onClick={clearFlowSearch}>
              Очистить поиск
            </button>
          )}
        </div>
        <div className="flow-search-filters">
          <b>Искать в:</b>
          {flowSearchScopeOptions.map((option) => (
            <label key={option.value}>
              <input
                type="checkbox"
                checked={searchScopes.includes(option.value)}
                onChange={() => toggleSearchScope(option.value)}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
        {searchActive && searchResults.length > 0 && activeResult && (
          <div className="flow-search-navigation">
            <button onClick={() => moveSearchResult(-1)}>← Предыдущий</button>
            <button
              className="flow-search-current"
              onClick={openActiveSearchResult}
              title="Открыть карточку найденного объекта"
            >
              <span>
                {activeResultIndex + 1} из {searchResults.length}
              </span>
              <strong>
                {activeResult.kind === "edge" ? "Связь: " : "Объект: "}
                {activeResult.label}
              </strong>
            </button>
            <button onClick={() => moveSearchResult(1)}>Следующий →</button>
            {activeResult.kind === "edge" && (
              <div className="flow-search-endpoints">
                <button
                  onClick={() => void openFlowNodeCard(activeResult.from!)}
                >
                  Карточка отправителя
                </button>
                <button onClick={() => void openFlowNodeCard(activeResult.to!)}>
                  Карточка получателя
                </button>
              </div>
            )}
          </div>
        )}
        {searchActive && searchResults.length === 0 && (
          <div className="flow-search-empty" aria-live="polite">
            Совпадений в текущей граф-схеме не найдено.
          </div>
        )}
      </div>
      {scope === "all" && allPages > 1 && (
        <div className="flow-pagination">
          <button
            disabled={graphPage === 0}
            onClick={() => setGraphPage((value) => Math.max(0, value - 1))}
          >
            ← Предыдущие
          </button>
          <span>
            Лист {graphPage + 1} из {allPages} · связи{" "}
            {formatNumber(graphPage * allPageSize + 1)}–
            {formatNumber(
              Math.min(allOtherNodes, (graphPage + 1) * allPageSize),
            )}{" "}
            из {formatNumber(allOtherNodes)}
          </span>
          <button
            disabled={graphPage >= allPages - 1}
            onClick={() =>
              setGraphPage((value) => Math.min(allPages - 1, value + 1))
            }
          >
            Следующие →
          </button>
        </div>
      )}
      <p className="flow-rule">
        {payload?.rule ??
          "Один БИН отображается одним узлом; повторные операции объединяются в одну направленную связь."}
      </p>
      {error && (
        <div
          className="notice"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span>{error}</span>
          <button
            className="secondary-button"
            style={{ width: "auto", minHeight: "32px", padding: "0 14px" }}
            onClick={() => setRetryCount((c) => c + 1)}
          >
            Повторить расчёт
          </button>
        </div>
      )}
      {loading && (
        <div className="flow-loading">Строим цепочку по документам дела…</div>
      )}
      {!loading && payload && (
        <div className="flow-scroll" ref={scrollRef}>
          <div
            className="flow-stage"
            style={{ width: layout.stageWidth, height: layout.stageHeight }}
          >
            <div className="flow-grid" />
            <canvas ref={canvasRef} className="flow-lines" aria-hidden="true" />
            {layout.labels.map(({ edge, x, y, width, height }) => {
              const amount = edge.amount || edge.dealAmount;
              const esfAmounts=edge.attributes as {invoiceMinor?:string;paymentMinor?:string;currency?:string;bankKind?:string}|undefined;
              const amountLabel=caseScope&&edge.invoices?.length
                ? minorText(esfAmounts?.invoiceMinor||"0",esfAmounts?.currency||caseScope.currency)
                : caseScope&&edge.bankTransfers?.length?minorText(esfAmounts?.paymentMinor||'0',esfAmounts?.currency||caseScope.currency)
                : amount?formatMoney(amount):`${formatNumber(edge.operations)} операций`;
              const years = edge.years.length
                ? edge.years.length === 1
                  ? String(edge.years[0])
                  : `${edge.years[0]}–${edge.years.at(-1)}`
                : "период не указан";
              const goods =
                edge.goods[0]?.name ||
                edge.relations.join(" · ") ||
                "Финансовая связь";
              const edgeMatched = matchedEdgeIds.has(edge.id);
              const edgeActive = activeResult?.edgeId === edge.id;
              const edgeSearchClass = searchActive
                ? edgeActive
                  ? "search-active"
                  : edgeMatched
                    ? "search-match"
                    : "search-dim"
                : "";
              return (
                <button
                  className={`flow-edge-label ${caseScope?(edge.bankTransfers?.length?'flow-bank-edge':edge.invoices?.length?'flow-invoice-edge':''):''} ${edge.cycle ? "cycle" : ""} ${edgeSearchClass}`}
                  key={edge.id}
                  style={{ left: x, top: y, width, minHeight: height }}
                  onClick={() => {
                    if(caseScope&&edge.invoices?.length)setSelectedInvoices(edge.invoices);
                    else if(caseScope&&edge.bankTransfers?.length)setSelectedBank(edge);
                    else if (searchActive && edgeMatched)
                      void openFlowNodeCard(edge.from);
                    else
                      notify(
                        `${formatMoney(amount)} · ${edge.operations} операций · ${goods}`,
                      );
                  }}
                >
                  <strong>
                    {amountLabel}
                  </strong>
                  <span>
                    {years} · {formatNumber(edge.operations)} {edge.invoices?.length?'ЭСФ':edge.bankTransfers?.length?'банковских записей':'операций'}
                  </span>
                  <small>{goods}</small>
                </button>
              );
            })}
            {display?.nodes.map((node) => {
              const position = layout.positions.get(node.bin);
              if (!position) return null;
              const isRoot = node.bin === focusBin;
              const terminal =
                (incomingCounts.get(node.bin) ?? 0) > 1 &&
                !(outgoingCounts.get(node.bin) ?? 0);
              const className = isRoot
                ? "root"
                : terminal || (node.risk ?? 0) >= 90
                  ? "terminal"
                  : "linked";
              const nodeMatched = directNodeMatches.has(node.bin);
              const nodeHighlighted = highlightedNodeBins.has(node.bin);
              const nodeActive = activeNodeBins.has(node.bin);
              const nodeSearchClass = searchActive
                ? nodeActive
                  ? "search-active"
                  : nodeMatched
                    ? "search-match"
                    : nodeHighlighted
                      ? "search-related"
                      : "search-dim"
                : "";
              return (
                <button
                  key={node.bin}
                  className={`flow-node ${className} ${nodeSearchClass}`}
                  style={{
                    left: position.x,
                    top: position.y,
                    width: position.width,
                    minHeight: position.height,
                  }}
                  onClick={() => {
                    if (searchActive && nodeHighlighted)
                      void openFlowNodeCard(node.bin);
                    else if (!isRoot) setFocusBin(node.bin);
                  }}
                >
                  <span>
                    {isRoot
                      ? "ВЫБРАННЫЙ ОБЪЕКТ"
                      : terminal
                        ? "КОНЕЧНЫЙ УЗЕЛ"
                        : node.knownObject
                          ? "СВЯЗАННЫЙ ОБЪЕКТ"
                          : "КОНТРАГЕНТ"}
                  </span>
                  <strong>{node.name}</strong>
                  <b>{node.bin.startsWith("IBAN:")?"IBAN "+node.bin.slice(5):"БИН/ИИН "+node.bin}</b>
                  {node.head && (
                    <small>
                      Руководитель: {node.head}
                      {node.headIin ? ` · ${node.headIin}` : ""}
                    </small>
                  )}
                  {node.address && <em>{node.address}</em>}
                </button>
              );
            })}
          </div>
        </div>
      )}
      <div className="flow-legend">
        <span>
          <i className="root" /> выбранный объект
        </span>
        <span>
          <i className="linked" /> организация или контрагент
        </span>
        <span>
          <i className="terminal" /> конечный/высокорисковый узел
        </span>
        <span>
          <i className="line" /> {caseScope?"направление поставки / операции":"направление денег/реализации"}
        </span>
      </div>
      {!caseScope && scope === "significant" && (
        <p className="chain-note">
          Режим «Значимые цепочки» показывает до четырёх крупнейших входящих и
          исходящих связей каждого узла. Переключите на «Все связи», чтобы
          отобразить полный компонент без ограничения количества.
        </p>
      )}
    </section>
  );
}

function EntityNetwork({
  selected,
  counterparties,
  leader,
  leaderIin,
  document,
  zoom,
  notify,
}: {
  selected: RegistryEntity;
  counterparties: {
    bin: string;
    name: string;
    role: string;
    operations: number;
    amount: number;
    relationTypes: Set<string>;
    sources: Set<string>;
  }[];
  leader: string;
  leaderIin: string;
  document?: { category: string; number: string; date: string };
  zoom: number;
  notify: (message: string) => void;
}) {
  const displayCounterparties = counterparties.slice(0, 24);
  const counterpartyTop = 180;
  const rowHeight = 86;
  const rows = Math.max(1, Math.ceil(displayCounterparties.length / 2));
  const stageHeight = Math.max(620, counterpartyTop + rows * rowHeight + 40);
  const coreY = 112;
  const address = selected.city || "По загруженным документам";
  return (
    <div
      className="entity-network-stage"
      style={{ height: stageHeight, transform: `scale(${zoom})` }}
    >
      <svg
        className="entity-network-lines"
        viewBox={`0 0 1000 ${stageHeight}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {leader && <line x1="500" y1={coreY} x2="170" y2="52" />}
        {document && <line x1="500" y1={coreY} x2="830" y2="52" />}
        {displayCounterparties.length === 0 && address && (
          <line x1="500" y1={coreY} x2="500" y2="280" />
        )}
        {displayCounterparties.map((counterparty, index) => (
          <line
            key={counterparty.bin}
            x1="500"
            y1={coreY}
            x2={index % 2 === 0 ? "170" : "830"}
            y2={counterpartyTop + Math.floor(index / 2) * rowHeight + 32}
          />
        ))}
      </svg>
      <button
        className="network-node entity-core"
        onClick={() => notify(selected.name)}
      >
        <span>{selected.risk}</span>
        <strong>{selected.name}</strong>
        <small>БИН {selected.bin}</small>
      </button>
      {displayCounterparties.map((counterparty, index) => (
        <button
          key={counterparty.bin}
          className="network-node counterparty-node"
          style={{
            ...(index % 2 === 0 ? { left: "3%" } : { right: "3%" }),
            top: counterpartyTop + Math.floor(index / 2) * rowHeight,
          }}
          onClick={() =>
            notify(
              `${counterparty.name} · БИН ${counterparty.bin} · ${counterparty.operations} операций${counterparty.amount ? ` · ${formatMoney(counterparty.amount)}` : ""}`,
            )
          }
        >
          <span>К</span>
          <strong>{counterparty.name || "Контрагент"}</strong>
          <small>
            {counterparty.role} · {formatNumber(counterparty.operations)}{" "}
            операций
            {counterparty.amount
              ? ` · ${formatMoney(counterparty.amount)}`
              : ""}
          </small>
        </button>
      ))}
      {displayCounterparties.length === 0 && address && (
        <button
          className="network-node counterparty-node"
          style={{ left: "50%", top: 280, transform: "translateX(-50%)" }}
          onClick={() => notify(address)}
        >
          <span>А</span>
          <strong>{address}</strong>
          <small>Юридический адрес / регион</small>
        </button>
      )}
      {leader && (
        <button
          className="network-node entity-leader"
          onClick={() => notify(`Руководитель: ${leader}`)}
        >
          <span>Л</span>
          <strong>{leader}</strong>
          <small>{leaderIin ? `ИИН ${leaderIin}` : "ИИН не указан"}</small>
        </button>
      )}
      {document && (
        <button
          className="network-node entity-document"
          onClick={() =>
            notify(
              `${document.number || "Документ"} · ${document.date || "дата не указана"}`,
            )
          }
        >
          <span>Д</span>
          <strong>{document.number || "Документ документов"}</strong>
          <small>{document.date || document.category}</small>
        </button>
      )}
      {counterparties.length > 24 && (
        <div className="graph-overflow-note">
          Показаны первые 24 из {counterparties.length} контрагентов ·
          переключите на вкладку «Контрагенты» для полного реестра
        </div>
      )}
    </div>
  );
}

function LeaderConnectionsView({
  leader,
  notify,
  onOpenEntity,
}: {
  leader: LeaderRecord;
  notify: (message: string) => void;
  onOpenEntity: (entity: RegistryEntity) => void;
}) {
  const visibleEntities = leader.entities.slice(0, 6);
  const positions = [
    { left: "10%", top: "18%" },
    { left: "67%", top: "15%" },
    { left: "8%", top: "57%" },
    { left: "68%", top: "54%" },
    { left: "37%", top: "76%" },
    { left: "40%", top: "4%" },
  ];
  function saveScheme() {
    const blob = new Blob([JSON.stringify(leader, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = window.document.createElement("a");
    link.href = url;
    link.download = `vestigo-leader-${leader.iin}.json`;
    link.click();
    URL.revokeObjectURL(url);
    notify("Схема руководителя сохранена на этом компьютере.");
  }
  return (
    <>
      <PageHeading
        eyebrow="ГРАФОВЫЙ АНАЛИЗ"
        title="Граф связей руководителя"
        text="Организации объединены по общему руководителю в официальных списках документов."
      />
      <div className="graph-toolbar card">
        <div>
          <button className="filter active">ИИН {leader.iin}</button>
          <button
            className="filter"
            onClick={() =>
              notify(
                `${leader.entities.length} организаций с совпадающим ИИН руководителя.`,
              )
            }
          >
            Всего организаций: {leader.entities.length}
          </button>
        </div>
        <button className="ghost-button" onClick={saveScheme}>
          Сохранить схему
        </button>
      </div>
      <div className="connections-layout">
        <LeaderNetwork
          leader={leader}
          entities={visibleEntities}
          positions={positions}
          onOpenEntity={onOpenEntity}
        />
        <aside className="card graph-inspector">
          <span className="section-kicker">РУКОВОДИТЕЛЬ</span>
          <h2>{leader.name}</h2>
          <p>ИИН {leader.iin}</p>
          <div className="inspector-score">
            <strong>{leader.entities.length}</strong>
            <span>
              организаций
              <br />
              <b>в группе</b>
            </span>
          </div>
          <h3>Связанные организации</h3>
          <div className="leader-entities">
            {leader.entities.map((entity) => (
              <button key={entity.id} onClick={() => onOpenEntity(entity)}>
                <span className={`score-dot ${riskClass(entity.level)}`}>
                  {entity.risk}
                </span>
                <span>
                  <strong>{entity.name}</strong>
                  <small>
                    БИН {entity.bin} · {entity.categories.length} признака
                  </small>
                </span>
              </button>
            ))}
          </div>
        </aside>
      </div>
    </>
  );
}

function LeaderNetwork({
  leader,
  entities,
  positions,
  onOpenEntity,
}: {
  leader: LeaderRecord;
  entities: RegistryEntity[];
  positions: { left: string; top: string }[];
  onOpenEntity: (entity: RegistryEntity) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hubRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    const hub = hubRef.current;
    if (!container || !canvas || !hub) return;
    const draw = () => {
      const bounds = container.getBoundingClientRect();
      const scale = window.devicePixelRatio || 1;
      canvas.width = Math.round(bounds.width * scale);
      canvas.height = Math.round(bounds.height * scale);
      canvas.style.width = `${bounds.width}px`;
      canvas.style.height = `${bounds.height}px`;
      const context = canvas.getContext("2d");
      if (!context) return;
      context.setTransform(scale, 0, 0, scale, 0, 0);
      context.clearRect(0, 0, bounds.width, bounds.height);
      const hubBox = hub.getBoundingClientRect();
      const startX = hubBox.left - bounds.left + hubBox.width / 2;
      const startY = hubBox.top - bounds.top + hubBox.height / 2;
      context.strokeStyle = "#6c9dba";
      context.fillStyle = "#6c9dba";
      context.lineWidth = 1.5;
      for (const entity of entities) {
        const node = nodeRefs.current[entity.id];
        if (!node) continue;
        const nodeBox = node.getBoundingClientRect();
        const endX = nodeBox.left - bounds.left + nodeBox.width / 2;
        const endY = nodeBox.top - bounds.top + nodeBox.height / 2;
        const angle = Math.atan2(endY - startY, endX - startX);
        const arrowX = endX - Math.cos(angle) * 18;
        const arrowY = endY - Math.sin(angle) * 18;
        context.beginPath();
        context.moveTo(startX, startY);
        context.lineTo(arrowX, arrowY);
        context.stroke();
        context.beginPath();
        context.moveTo(arrowX, arrowY);
        context.lineTo(
          arrowX - 8 * Math.cos(angle - Math.PI / 6),
          arrowY - 8 * Math.sin(angle - Math.PI / 6),
        );
        context.lineTo(
          arrowX - 8 * Math.cos(angle + Math.PI / 6),
          arrowY - 8 * Math.sin(angle + Math.PI / 6),
        );
        context.closePath();
        context.fill();
      }
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(container);
    window.addEventListener("resize", draw);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", draw);
    };
  }, [entities]);

  return (
    <div
      className="card large-graph leader-graph leader-network"
      ref={containerRef}
    >
      <div className="graph-grid" />
      <canvas ref={canvasRef} className="leader-lines" aria-hidden="true" />
      <div className="leader-hub" ref={hubRef}>
        <span>Л</span>
        <strong>{leader.name}</strong>
        <small>ИИН {leader.iin}</small>
      </div>
      {entities.map((entity, index) => (
        <button
          key={entity.id}
          ref={(node) => {
            nodeRefs.current[entity.id] = node;
          }}
          className="network-node leader-company"
          style={positions[index]}
          onClick={() => onOpenEntity(entity)}
        >
          <span>{entity.risk}</span>
          <strong>{entity.name}</strong>
          <small>БИН {entity.bin}</small>
        </button>
      ))}
    </div>
  );
}

function SourcesView({
  sources,
  sourceStats,
  importedCodes,
  partialCodes,
  unavailableStats,
  showForm,
  setShowForm,
  onSubmit,
  message,
  notify,
  dataDate,
  syncStatus,
}: {
  sources: SourceRecord[];
  sourceStats: SourceStat[];
  importedCodes: Set<string>;
  partialCodes: Set<string>;
  unavailableStats: Map<string, string>;
  showForm: boolean;
  setShowForm: (value: boolean) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  message: string;
  notify: (message: string) => void;
  dataDate: string;
  syncStatus?: string;
}) {
  const syncLabel =
    syncStatus === "updated"
      ? "Синхронизация выполнена"
      : syncStatus === "partial"
        ? "Частичная синхронизация"
        : "Ожидает синхронизацию";
  return (
    <>
      <div className="page-heading sources-heading">
        <div>
          <span>КАТАЛОГ ДАННЫХ</span>
          <h1>Источники</h1>
          <p>Официальные выгрузки и добавленные вами ссылки.</p>
        </div>
        <button
          className="primary-button"
          onClick={() => setShowForm(!showForm)}
        >
          ＋ Добавить источник
        </button>
      </div>
      {message && (
        <div className="notice success">
          <Icon name="check" /> {message}
        </div>
      )}
      {showForm && (
        <form className="card source-form" onSubmit={onSubmit}>
          <div>
            <label>
              Название источника
              <input
                name="name"
                required
                placeholder="Например, открытый реестр"
              />
            </label>
            <label>
              Ссылка
              <input name="url" type="url" required placeholder="https://…" />
            </label>
          </div>
          <div>
            <label>
              Регион
              <input name="region" defaultValue="По загруженным документам" />
            </label>
            <label>
              Режим обновления
              <select name="schedule">
                <option>Вручную</option>
                <option>Ежедневно</option>
                <option>Еженедельно</option>
              </select>
            </label>
          </div>
          <div className="form-actions">
            <button
              type="button"
              className="ghost-button"
              onClick={() => setShowForm(false)}
            >
              Отмена
            </button>
            <button className="primary-button">Сохранить источник</button>
          </div>
        </form>
      )}
      <div className="source-summary">
        <div className="card">
          <span>Источников</span>
          <strong>{sources.length}</strong>
          <small>локальный каталог</small>
        </div>
        <div className="card">
          <span>Получено файлов</span>
          <strong>
            {sourceStats.filter((item) => item.status !== "unavailable").length}
            /11
          </strong>
          <small>
            {formatNumber(
              sourceStats.reduce((sum, item) => sum + item.rows, 0),
            )}{" "}
            строк и совпадений
          </small>
        </div>
        <div className="card">
          <span>Регион</span>
          <strong className="region-value">По материалам</strong>
          <small>загруженных файлов</small>
        </div>
      </div>
      {sources.map((source) => (
        <article className="card source-detail" key={source.id}>
          <div className="source-detail-head">
            <div className="source-logo large">{source.badge ?? "Р"}</div>
            <div>
              <span className="section-kicker">
                КАТАЛОГ ИСТОЧНИКОВ
              </span>
              <h2>{source.name}</h2>
              <a href={source.url} target="_blank" rel="noreferrer">
                {source.url}
              </a>
            </div>
            <div className="source-actions">
              <span className="status-ready">
                <i />{" "}
                {source.id === "kgd-unreliable" ? syncLabel : source.status}
              </span>
              <a
                className="ghost-button"
                href={source.url}
                target="_blank"
                rel="noreferrer"
              >
                Открыть источник ↗
              </a>
            </div>
          </div>
          <div className="source-meta">
            <span>
              <b>Регион</b>
              {source.region}
            </span>
            <span>
              <b>Доступ</b>
              {source.access ?? "Публичный источник"}
            </span>
            <span>
              <b>Сведения</b>
              {source.fields ?? "Настраивается"}
            </span>
            <span>
              <b>Обновление</b>
              {source.id === "kgd-unreliable"
                ? dataDate
                : (source.refresh ?? "по источнику")}
            </span>
          </div>
          {source.id === "kgd-unreliable" && (
            <div className="category-grid">
              {kgdCategories.map((category, index) => {
                const ready = importedCodes.has(category.code);
                const partial = partialCodes.has(category.code);
                const unavailable = unavailableStats.get(category.code);
                return (
                  <div
                    key={category.code}
                    className={
                      ready
                        ? "category-ready"
                        : partial
                          ? "category-partial"
                          : unavailable
                            ? "category-unavailable"
                            : "category-waiting"
                    }
                  >
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <p>{category.label}</p>
                    <span
                      title={
                        ready
                          ? "Excel получен"
                          : partial
                            ? "Только подтверждённые совпадения по региональным БИН/ИИН"
                            : unavailable
                              ? `документов не отдал файл: ${unavailable}. Повторная попытка — в следующий рабочий день.`
                              : "Ожидает выгрузку"
                      }
                    >
                      {ready ? "✓" : partial ? "≈" : unavailable ? "!" : "◷"}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </article>
      ))}
    </>
  );
}

function UploadsView({
  files,
  queue,
  importing,
  message,
  onChange,
  onDropFiles,
  onStartImport,
  onRemoveQueueItem,
  onClearQueue,
  onDeleteUpload,
  notify,
}: {
  files: UploadedFile[];
  queue: QueueFile[];
  importing: boolean;
  message: string;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onDropFiles: (files: File[]) => void;
  onStartImport: () => void;
  onRemoveQueueItem: (id: string) => void;
  onClearQueue: () => void;
  onDeleteUpload: (file: UploadedFile) => void;
  notify: (message: string) => void;
}) {
  const [isDragging, setIsDragging] = useState(false);
  const pendingCount = queue.filter(
    (item) => item.stage === "pending" || item.stage === "error",
  ).length;

  return (
    <>
      <PageHeading
        eyebrow="ЦЕНТР ЗАГРУЗКИ"
        title="Документы и выгрузки"
        text="Добавляйте разрешённые файлы по согласованным шаблонам (XLSX, XLS, CSV, JSON)."
      />
      {message && (
        <div className="notice">
          <Icon name="check" /> {message}
        </div>
      )}

      <label
        className={`upload-zone card ${isDragging ? "drag-active" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          setIsDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragging(false);
          const dropped = Array.from(e.dataTransfer.files ?? []);
          if (dropped.length) onDropFiles(dropped);
        }}
      >
        <input
          type="file"
          multiple
          accept=".xlsx,.xls,.csv,.json"
          onChange={onChange}
        />
        <span className="upload-symbol">⇧</span>
        <h2>
          {isDragging
            ? "Отпустите файлы для добавления в очередь"
            : "Перетащите файлы сюда или выберите на компьютере"}
        </h2>
        <p>
          Excel (.xlsx, .xls), CSV или JSON · поддерживаются файлы до 150 МБ
        </p>
        <span className="primary-button">Выбрать файлы</span>
      </label>

      {queue.length > 0 && (
        <section className="card upload-queue-card">
          <div className="card-header">
            <div>
              <span className="section-kicker">ОЧЕРЕДЬ ЗАГРУЗКИ</span>
              <h2>Выбранные файлы ({queue.length})</h2>
            </div>
            <div className="queue-header-actions">
              <button
                className="ghost-button"
                onClick={onClearQueue}
                disabled={importing}
              >
                Очистить список
              </button>
              <button
                className="primary-button"
                onClick={onStartImport}
                disabled={importing || pendingCount === 0}
              >
                <Icon name="upload" />{" "}
                {importing ? "Импортируем…" : `Начать импорт (${pendingCount})`}
              </button>
            </div>
          </div>

          <div className="queue-items-list">
            {queue.map((item) => {
              const ext = item.name.split(".").pop()?.toUpperCase() ?? "FILE";
              return (
                <article
                  className={`queue-file-card ${item.stage}`}
                  key={item.id}
                >
                  <div className="queue-file-main">
                    <div className={`queue-file-badge ${ext.toLowerCase()}`}>
                      {ext}
                    </div>
                    <div className="queue-file-details">
                      <strong>{item.name}</strong>
                      <small>
                        {item.sizeFormatted} · {item.statusText}
                      </small>
                    </div>
                    <div className="queue-file-status-tag">
                      {item.stage === "pending" && (
                        <span className="status-tag pending">⏳ Готов</span>
                      )}
                      {item.stage === "uploading" && (
                        <span className="status-tag uploading">
                          🔄 Загрузка {item.progress}%
                        </span>
                      )}
                      {item.stage === "processing" && (
                        <span className="status-tag processing">
                          ⚙️ Обработка…
                        </span>
                      )}
                      {item.stage === "success" && (
                        <span className="status-tag success">✓ Загружен</span>
                      )}
                      {item.stage === "error" && (
                        <span className="status-tag error">✕ Ошибка</span>
                      )}
                    </div>
                    {(item.stage === "pending" || item.stage === "error") &&
                      !importing && (
                        <button
                          className="queue-file-remove"
                          onClick={() => onRemoveQueueItem(item.id)}
                          aria-label="Удалить из очереди"
                        >
                          ×
                        </button>
                      )}
                  </div>

                  <div className="queue-file-progress-bar">
                    <div
                      className={`queue-file-progress-fill ${item.stage}`}
                      style={{
                        width: `${Math.max(item.stage === "pending" ? 0 : 2, item.progress)}%`,
                      }}
                    />
                  </div>
                  <div className="queue-file-progress-label">
                    <span>
                      {item.stage === "uploading"
                        ? `Передача файла в локальную базу: ${item.progress}%`
                        : item.stage === "processing"
                          ? "Файл передан. Идёт структурирование, проверка БИН и пересчёт связей…"
                          : item.stage === "success"
                            ? "Файл успешно сохранён и сопоставлен с реестром"
                            : item.stage === "error"
                              ? item.error || "Ошибка при обработке"
                              : "Ожидает запуска"}
                    </span>
                    <b>{item.progress}%</b>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      )}

      <div className="upload-layout">
        <section className="card recent-uploads">
          <div className="card-header">
            <div>
              <span className="section-kicker">ЖУРНАЛ</span>
              <h2>История загрузок</h2>
            </div>
            <button
              className="ghost-button"
              onClick={() =>
                notify(
                  files.length
                    ? `Всего загружено файлов: ${files.length}`
                    : "Новых загрузок нет.",
                )
              }
            >
              Всего: {files.length}
            </button>
          </div>
          {files.length === 0 ? (
            <div className="empty-upload">
              <span>▤</span>
              <strong>Новых загрузок нет</strong>
              <p>Загрузите таблицы, чтобы построить реестр объектов и их связей.</p>
            </div>
          ) : (
            <div className="recent-files-list">
              {files.map((file, index) => {
                const ext = file.name.split(".").pop()?.toUpperCase() ?? "FILE";
                return (
                  <div className="file-row" key={`${file.name}-${index}`}>
                    <div className={`file-icon ${ext.toLowerCase()}`}>
                      {ext}
                    </div>
                    <div>
                      <strong>{file.name}</strong>
                      <small>{file.size} · локальный файл</small>
                    </div>
                    <span className="file-status-badge">
                      <Icon name="check" /> {file.status}
                    </span>
                    <button
                      className="file-delete-button"
                      aria-label={`Удалить файл ${file.name}`}
                      title="Удалить файл и пересчитать данные"
                      onClick={() => onDeleteUpload(file)}
                    >
                      Удалить
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <aside className="card template-card">
          <span className="section-kicker">ПОРЯДОК ОБРАБОТКИ</span>
          <h2>Как работает импорт</h2>
          <ol>
            <li>
              <span>1</span>
              <div>
                <strong>Передача файла (0–100%)</strong>
                <p>Безопасная передача в локальное хранилище</p>
              </div>
            </li>
            <li>
              <span>2</span>
              <div>
                <strong>Проверка структуры</strong>
                <p>
                  Определение колонок с БИН/ИИН, суммами, ролями и документами
                </p>
              </div>
            </li>
            <li>
              <span>3</span>
              <div>
                <strong>Сопоставление с реестром</strong>
                <p>Связывание с базой документов и построение контрагентов</p>
              </div>
            </li>
            <li>
              <span>4</span>
              <div>
                <strong>Пересчёт графов и рисков</strong>
                <p>Обновление финансовых цепочек, ЭСФ и сигналов</p>
              </div>
            </li>
          </ol>
        </aside>
      </div>
    </>
  );
}

function ImportedEvidenceSection({ entity }: { entity: RegistryEntity }) {
  const [records, setRecords] = useState<ImportedEvidence[]>([]);
  const [relations, setRelations] = useState<ImportedRelation[]>([]);
  const [relationFilter, setRelationFilter] = useState<RelationFilter>("all");

  useEffect(() => {
    let active = true;
    setRelationFilter("all");
    const identifiers = new Set([entity.bin, entity.headIin].filter(Boolean));
    Promise.all([
      analyticsFetch(`/api/imports?bin=${encodeURIComponent(entity.bin)}`, {
        cache: "no-store",
      })
        .then((response) =>
          response.ok
            ? (response.json() as Promise<{
                records: ImportedEvidence[];
                relations: ImportedRelation[];
              }>)
            : { records: [], relations: [] },
        )
        .catch(() => ({
          records: [] as ImportedEvidence[],
          relations: [] as ImportedRelation[],
        })),
      readLocalImportBatches()
        .then((batches) =>
          batches
            .flatMap((batch) => batch.evidence)
            .filter((record) =>
              record.bins.some((bin) => identifiers.has(bin)),
            ),
        )
        .catch(() => [] as ImportedEvidence[]),
    ]).then(([projectPayload, browserRecords]) => {
      if (!active) return;
      const unique = new Map<string, ImportedEvidence>();
      [...projectPayload.records, ...browserRecords].forEach((record) =>
        unique.set(`${record.fileName}-${record.id}`, record),
      );
      setRecords([...unique.values()]);
      setRelations(projectPayload.relations ?? []);
    });
    return () => {
      active = false;
    };
  }, [entity.bin, entity.headIin]);

  const relationViews = useMemo(
    () =>
      relations.map((relation) => {
        const selectedIsObject = relation.objectBin === entity.bin;
        return {
          relation,
          selectedIsObject,
          selectedRole: selectedIsObject
            ? relation.objectRole
            : relation.counterpartyRole,
        };
      }),
    [entity.bin, relations],
  );
  const relationCounts = useMemo(
    () => ({
      all: relationViews.length,
      counterparty: relationViews.filter((item) => !item.selectedIsObject)
        .length,
      seller: relationViews.filter((item) => item.selectedRole === "Поставщик")
        .length,
      buyer: relationViews.filter((item) => item.selectedRole === "Получатель")
        .length,
    }),
    [relationViews],
  );
  const filteredRelations = useMemo(
    () =>
      relationViews.filter((item) => {
        if (relationFilter === "counterparty") return !item.selectedIsObject;
        if (relationFilter === "seller")
          return item.selectedRole === "Поставщик";
        if (relationFilter === "buyer")
          return item.selectedRole === "Получатель";
        return true;
      }),
    [relationFilter, relationViews],
  );
  const recordsByRelation = useMemo(() => {
    const grouped = new Map<string, ImportedEvidence[]>();
    records.forEach((record) => {
      const relationship = record.relationship;
      if (!relationship) return;
      const key = `${relationship.objectBin}|${relationship.counterpartyBin}|${relationship.relationType}`;
      const current = grouped.get(key) ?? [];
      if (!current.some((item) => item.id === record.id)) current.push(record);
      grouped.set(key, current);
    });
    return grouped;
  }, [records]);
  const linkedRecordIds = useMemo(
    () =>
      new Set(
        [...recordsByRelation.values()].flatMap((items) =>
          items.map((item) => item.id),
        ),
      ),
    [recordsByRelation],
  );
  const unlinkedRecords = useMemo(
    () => records.filter((record) => !linkedRecordIds.has(record.id)),
    [linkedRecordIds, records],
  );

  if (!records.length && !relations.length) return null;
  return (
    <div className="dossier-section imported-evidence">
      <div className="dossier-section-title">
        <div>
          <span className="section-kicker">ЛОКАЛЬНЫЕ ЗАГРУЗКИ</span>
          <h3>Сведения из добавленных файлов</h3>
        </div>
        <span>{records.length}</span>
      </div>
      <p>Совпадение найдено по БИН/ИИН организации или руководителя.</p>
      {relations.length > 0 && (
        <>
          <div
            className="relation-filters"
            role="group"
            aria-label="Фильтр роли организации"
          >
            {(
              [
                ["all", "Все связи"],
                ["counterparty", "Как контрагент"],
                ["seller", "Продавец"],
                ["buyer", "Покупатель"],
              ] as [RelationFilter, string][]
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={relationFilter === value ? "active" : ""}
                aria-pressed={relationFilter === value}
                onClick={() => setRelationFilter(value)}
              >
                {label}
                <span>{relationCounts[value]}</span>
              </button>
            ))}
          </div>
          <div className="relation-filter-summary">
            Показано {Math.min(filteredRelations.length, 30)} из{" "}
            {filteredRelations.length}
          </div>
          {filteredRelations.length > 0 ? (
            <div className="imported-relations">
              {filteredRelations
                .slice(0, 30)
                .map(({ relation, selectedIsObject }) => {
                  const relationKey = `${relation.objectBin}|${relation.counterpartyBin}|${relation.relationType}`;
                  const relatedRecords =
                    recordsByRelation.get(relationKey) ?? [];
                  return (
                    <section className="relation-bundle" key={relationKey}>
                      <article className="relation-summary">
                        <div>
                          <span className="relation-role object">
                            ОБЪЕКТ · {relation.objectRole}
                          </span>
                          <strong>
                            {relation.objectName || "Наименование не указано"}
                          </strong>
                          <small>БИН/ИИН {relation.objectBin}</small>
                        </div>
                        <span className="relation-arrow">
                          {relation.relationType} →
                        </span>
                        <div>
                          <span className="relation-role counterparty">
                            КОНТРАГЕНТ · {relation.counterpartyRole}
                          </span>
                          <strong>
                            {relation.counterpartyName ||
                              "Наименование не указано"}
                          </strong>
                          <small>БИН/ИИН {relation.counterpartyBin}</small>
                        </div>
                        <em>
                          {relation.operations} операций · уверенность{" "}
                          {relation.confidence}%
                          {!selectedIsObject
                            ? " · карточка открыта со стороны контрагента"
                            : ""}
                        </em>
                      </article>
                      {relatedRecords.length > 0 ? (
                        <div className="relation-source-records">
                          {relatedRecords.slice(0, 3).map((record) => (
                            <article
                              className="relation-source-record"
                              key={record.id}
                            >
                              <div className="relation-source-head">
                                <div>
                                  <strong>{record.fileName}</strong>
                                  <small>
                                    БИН/ИИН: {record.bins.join(", ")}
                                  </small>
                                </div>
                                <span>Строка источника</span>
                              </div>
                              <dl>
                                {Object.entries(record.fields)
                                  .slice(0, 12)
                                  .map(([label, value]) => (
                                    <div key={label}>
                                      <dt>{label}</dt>
                                      <dd>{value}</dd>
                                    </div>
                                  ))}
                              </dl>
                            </article>
                          ))}
                        </div>
                      ) : (
                        <div className="relation-source-missing">
                          Источник связи: {relation.files.join(", ")} ·
                          подробная строка не вошла в локальный индекс.
                        </div>
                      )}
                    </section>
                  );
                })}
            </div>
          ) : (
            <div className="relation-empty">
              По выбранной роли связей не найдено.
            </div>
          )}
        </>
      )}
      {unlinkedRecords.length > 0 && (
        <details className="unlinked-evidence">
          <summary>
            Другие сведения из файлов ({unlinkedRecords.length})
          </summary>
          <div className="evidence-list">
            {unlinkedRecords.slice(0, 30).map((record) => (
              <article key={record.id}>
                <strong>{record.fileName}</strong>
                <small>БИН/ИИН: {record.bins.join(", ")}</small>
                <dl>
                  {Object.entries(record.fields)
                    .slice(0, 12)
                    .map(([label, value]) => (
                      <div key={label}>
                        <dt>{label}</dt>
                        <dd>{value}</dd>
                      </div>
                    ))}
                </dl>
              </article>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function FinancialAnalysis({ bin }: { bin: string }) {
  const caseScope = useContext(CaseScopeContext);
  return caseScope ? <CaseFinancialSummary bin={bin}/> : <LegacyFinancialAnalysis bin={bin}/>;
}
function LegacyFinancialAnalysis({ bin }: { bin: string }) {
  const [payload, setPayload] = useState<FinancialPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<
    "overview" | "declarations" | "esf" | "counterparties" | "signals"
  >("overview");
  const [side, setSide] = useState<"sales" | "purchases">("sales");
  const [counterpartyQuery, setCounterpartyQuery] = useState("");
  const [counterpartyLimit, setCounterpartyLimit] = useState(50);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setTab("overview");
    setCounterpartyQuery("");
    setCounterpartyLimit(50);
    analyticsFetch(`/api/financials?bin=${encodeURIComponent(bin)}`, {
      cache: "no-store",
    })
      .then((response) =>
        response.ok ? (response.json() as Promise<FinancialPayload>) : null,
      )
      .then((result) => {
        if (active) setPayload(result);
      })
      .catch(() => {
        if (active) setPayload(null);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [bin]);

  if (loading)
    return (
      <div className="dossier-section finance-analysis finance-loading">
        Сопоставляем ЭСФ и декларации по БИН…
      </div>
    );
  const data = payload?.entity;
  if (!data) return null;
  const hasFinancials =
    data.esf.sales.invoiceCount +
      data.esf.purchases.invoiceCount +
      data.form100.submissions +
      data.form300.submissions +
      data.form328.applications >
    0;
  if (!hasFinancials) return null;

  const years = [
    ...new Set([
      ...data.esf.sales.years.map((item) => item.year),
      ...data.esf.purchases.years.map((item) => item.year),
      ...data.form100.years.map((item) => item.year),
      ...data.form300.years.map((item) => item.year),
    ]),
  ].sort((a, b) => a - b);
  const yearSeries = years.map((year) => ({
    year,
    sales:
      data.esf.sales.years.find((item) => item.year === year)?.turnover ?? 0,
    purchases:
      data.esf.purchases.years.find((item) => item.year === year)?.turnover ??
      0,
  }));
  const maxYearValue = Math.max(
    1,
    ...yearSeries.flatMap((item) => [item.sales, item.purchases]),
  );
  const firstYear = years[0];
  const lastYear = years.at(-1);
  const tabs = [
    ["overview", "Обзор"],
    ["declarations", "Декларации"],
    ["esf", "ЭСФ"],
    ["counterparties", "Контрагенты"],
    ["signals", `Сигналы ${data.signals.length}`],
  ] as const;
  const sideData = data.esf[side];
  const filteredCounterparties = sideData.counterparties.filter((item) => {
    const query = counterpartyQuery.trim().toLocaleLowerCase("ru-RU");
    return (
      !query ||
      item.bin.includes(query) ||
      item.name.toLocaleLowerCase("ru-RU").includes(query)
    );
  });
  const field = (row: FinancialYear, name: string) => Number(row[name] ?? 0);
  const percent = (value: number) => `${Math.min(100, Math.max(2, value))}%`;

  return (
    <section className="dossier-section finance-analysis">
      <div className="finance-heading">
        <div>
          <span className="section-kicker">
            СОПОСТАВЛЕНИЕ ЗАГРУЖЕННЫХ ФАЙЛОВ
          </span>
          <h3>Налоги, декларации и ЭСФ</h3>
          <p>
            Единая аналитика по БИН {bin}
            {firstYear && lastYear ? ` · период ${firstYear}–${lastYear}` : ""}
          </p>
        </div>
        <div className="finance-audit">
          <b>{formatNumber(payload?.audit.uniqueEsfInvoices ?? 0)}</b>
          <span>уникальных ЭСФ в индексе</span>
        </div>
      </div>
      <div
        className="finance-tabs"
        role="tablist"
        aria-label="Раздел финансовой аналитики"
      >
        {tabs.map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={tab === value ? "active" : ""}
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <>
          <div className="finance-kpis">
            <article>
              <span>Реализация по ЭСФ</span>
              <strong>{formatMoney(data.esf.sales.turnover)}</strong>
              <small>
                {formatNumber(data.esf.sales.invoiceCount)} счетов ·{" "}
                {formatNumber(data.esf.sales.counterpartyCount)} покупателей
              </small>
            </article>
            <article>
              <span>Приобретения по ЭСФ</span>
              <strong>{formatMoney(data.esf.purchases.turnover)}</strong>
              <small>
                {formatNumber(data.esf.purchases.invoiceCount)} счетов ·{" "}
                {formatNumber(data.esf.purchases.counterpartyCount)} поставщиков
              </small>
            </article>
            <article>
              <span>Начисленный НДС по ЭСФ</span>
              <strong>{formatMoney(data.esf.sales.vat)}</strong>
              <small>по активным счетам-фактурам</small>
            </article>
            <article>
              <span>Входящий НДС по ЭСФ</span>
              <strong>{formatMoney(data.esf.purchases.vat)}</strong>
              <small>по приобретениям</small>
            </article>
          </div>
          <div className="finance-overview-grid">
            <article className="finance-chart-panel">
              <div className="finance-panel-title">
                <div>
                  <h4>Динамика оборота по ЭСФ</h4>
                  <p>Реализация и приобретения без НДС, по годам</p>
                </div>
                <div className="finance-legend">
                  <span>
                    <i className="sales" />
                    Реализация
                  </span>
                  <span>
                    <i className="purchases" />
                    Приобретения
                  </span>
                </div>
              </div>
              <div
                className="finance-bars"
                aria-label="Динамика оборота по годам"
              >
                {yearSeries.map((item) => (
                  <div className="finance-year" key={item.year}>
                    <div className="finance-bar-area">
                      <i
                        className="sales"
                        style={{
                          height: percent((item.sales / maxYearValue) * 100),
                        }}
                        title={`Реализация: ${formatMoney(item.sales)}`}
                      />
                      <i
                        className="purchases"
                        style={{
                          height: percent(
                            (item.purchases / maxYearValue) * 100,
                          ),
                        }}
                        title={`Приобретения: ${formatMoney(item.purchases)}`}
                      />
                    </div>
                    <b>{item.year}</b>
                    <small>
                      {formatMoney(Math.max(item.sales, item.purchases))}
                    </small>
                  </div>
                ))}
              </div>
            </article>
            <article className="finance-summary-panel">
              <span className="section-kicker">КРАТКИЙ ВЫВОД</span>
              <h4>{data.name}</h4>
              <ul>
                <li>
                  В анализ вошло{" "}
                  <b>
                    {formatNumber(
                      data.esf.sales.invoiceCount +
                        data.esf.purchases.invoiceCount,
                    )}
                  </b>{" "}
                  активных ЭСФ.
                </li>
                <li>
                  Деклараций: форма 100 — <b>{data.form100.submissions}</b>,
                  форма 300 — <b>{data.form300.submissions}</b>
                  {data.form328.applications
                    ? `, форма 328 — ${data.form328.applications}`
                    : ""}
                  .
                </li>
                <li>
                  Найдено контрольных сигналов: <b>{data.signals.length}</b>.
                  Они требуют проверки первичных документов.
                </li>
              </ul>
              {data.signals[0] && (
                <div
                  className={`finance-main-signal ${data.signals[0].severity}`}
                >
                  <b>{data.signals[0].title}</b>
                  <span>{data.signals[0].detail}</span>
                </div>
              )}
            </article>
          </div>
          {data.reconciliation.length > 0 && (
            <article className="finance-table-panel">
              <div className="finance-panel-title">
                <div>
                  <h4>Сопоставление ЭСФ и формы 300.00</h4>
                  <p>
                    Контроль оборота реализации; расхождение не является
                    самостоятельным доказательством нарушения
                  </p>
                </div>
              </div>
              <div className="finance-table">
                <div className="finance-row head">
                  <span>Год</span>
                  <span>Реализация по ЭСФ</span>
                  <span>Оборот в 300.00</span>
                  <span>Разница</span>
                  <span>Отклонение</span>
                </div>
                {data.reconciliation.map((item) => (
                  <div className="finance-row" key={item.year}>
                    <b>{item.year}</b>
                    <span>{formatMoney(item.esfSales)}</span>
                    <span>{formatMoney(item.vatTurnover)}</span>
                    <strong
                      className={Math.abs(item.deltaPct) >= 20 ? "warn" : ""}
                    >
                      {formatMoney(item.delta)}
                    </strong>
                    <span>
                      {item.deltaPct.toLocaleString("ru-RU", {
                        maximumFractionDigits: 1,
                      })}
                      %
                    </span>
                  </div>
                ))}
              </div>
            </article>
          )}
        </>
      )}

      {tab === "declarations" && (
        <div className="finance-declarations">
          <article className="finance-table-panel">
            <div className="finance-panel-title">
              <div>
                <h4>Форма 100.00 — КПН</h4>
                <p>Годовые значения после учёта дополнительных деклараций</p>
              </div>
              <b>{data.form100.submissions} подач</b>
            </div>
            {data.form100.years.length ? (
              <div className="finance-table wide">
                <div className="finance-row form100 head">
                  <span>Год</span>
                  <span>Доход от реализации</span>
                  <span>Совокупный доход</span>
                  <span>Вычеты</span>
                  <span>Налогооблагаемый доход / убыток</span>
                  <span>КПН</span>
                </div>
                {data.form100.years.map((item) => (
                  <div className="finance-row form100" key={item.year}>
                    <b>{item.year}</b>
                    <span>{formatMoney(field(item, "field_100_00_001"))}</span>
                    <span>{formatMoney(field(item, "field_100_00_018"))}</span>
                    <span>{formatMoney(field(item, "field_100_00_040"))}</span>
                    <strong>
                      {formatMoney(field(item, "field_100_00_044"))}
                    </strong>
                    <span>
                      {formatMoney(
                        field(item, "field_100_00_062") ||
                          field(item, "field_100_00_059"),
                      )}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="finance-empty">
                Форма 100.00 для этого БИН не загружена.
              </div>
            )}
          </article>
          <article className="finance-table-panel">
            <div className="finance-panel-title">
              <div>
                <h4>Форма 300.00 — НДС</h4>
                <p>Свод по квартальным декларациям</p>
              </div>
              <b>{data.form300.submissions} подач</b>
            </div>
            {data.form300.years.length ? (
              <div className="finance-table wide">
                <div className="finance-row form300 head">
                  <span>Год</span>
                  <span>Оборот реализации</span>
                  <span>НДС начисленный</span>
                  <span>Оборот приобретений</span>
                  <span>НДС в зачёт</span>
                  <span>К уплате</span>
                </div>
                {data.form300.years.map((item) => (
                  <div className="finance-row form300" key={item.year}>
                    <b>{item.year}</b>
                    <span>{formatMoney(field(item, "field_300_00_006"))}</span>
                    <span>{formatMoney(field(item, "field_300_00_012"))}</span>
                    <span>{formatMoney(field(item, "field_300_00_021"))}</span>
                    <span>{formatMoney(field(item, "field_300_00_023"))}</span>
                    <strong>
                      {formatMoney(field(item, "field_300_00_030_01"))}
                    </strong>
                  </div>
                ))}
              </div>
            ) : (
              <div className="finance-empty">
                Форма 300.00 для этого БИН не загружена.
              </div>
            )}
          </article>
          {data.form328.applications > 0 && (
            <article className="finance-import-panel">
              <div>
                <span>Форма 328.00</span>
                <strong>
                  {formatNumber(data.form328.applications)} заявлений
                </strong>
                <small>
                  {formatNumber(data.form328.imports)} товарных позиций
                </small>
              </div>
              <div>
                <span>Облагаемый импорт</span>
                <strong>{formatMoney(data.form328.vatBase)}</strong>
              </div>
              <div>
                <span>НДС по импорту</span>
                <strong>{formatMoney(data.form328.vat)}</strong>
              </div>
            </article>
          )}
        </div>
      )}

      {tab === "esf" && (
        <div className="finance-esf-layout">
          <article className="finance-table-panel">
            <div className="finance-panel-title">
              <div>
                <h4>ЭСФ по годам</h4>
                <p>Суммы без НДС; один регистрационный номер — один счёт</p>
              </div>
            </div>
            <div className="finance-table">
              <div className="finance-row esf head">
                <span>Год</span>
                <span>Реализация</span>
                <span>Счетов</span>
                <span>Приобретения</span>
                <span>Счетов</span>
              </div>
              {yearSeries.map((item) => {
                const sales = data.esf.sales.years.find(
                  (row) => row.year === item.year,
                );
                const purchases = data.esf.purchases.years.find(
                  (row) => row.year === item.year,
                );
                return (
                  <div className="finance-row esf" key={item.year}>
                    <b>{item.year}</b>
                    <span>{formatMoney(item.sales)}</span>
                    <span>{formatNumber(sales?.invoiceCount ?? 0)}</span>
                    <span>{formatMoney(item.purchases)}</span>
                    <span>{formatNumber(purchases?.invoiceCount ?? 0)}</span>
                  </div>
                );
              })}
            </div>
          </article>
          <article className="finance-products">
            <div>
              <h4>Основные позиции реализации</h4>
              {data.esf.sales.goods.slice(0, 8).map((good) => (
                <div
                  className="finance-product"
                  key={`${good.code}-${good.name}`}
                >
                  <span>
                    <b>{good.name || "Наименование не указано"}</b>
                    <small>
                      {good.code ? `Код ${good.code} · ` : ""}$
                      {formatNumber(good.invoiceCount)} ЭСФ
                    </small>
                  </span>
                  <strong>{formatMoney(good.turnover)}</strong>
                </div>
              ))}
            </div>
            <div>
              <h4>Основные позиции приобретений</h4>
              {data.esf.purchases.goods.slice(0, 8).map((good) => (
                <div
                  className="finance-product"
                  key={`${good.code}-${good.name}`}
                >
                  <span>
                    <b>{good.name || "Наименование не указано"}</b>
                    <small>
                      {good.code ? `Код ${good.code} · ` : ""}$
                      {formatNumber(good.invoiceCount)} ЭСФ
                    </small>
                  </span>
                  <strong>{formatMoney(good.turnover)}</strong>
                </div>
              ))}
            </div>
          </article>
          <p className="finance-method">{payload?.methodology.esf}</p>
        </div>
      )}

      {tab === "counterparties" && (
        <>
          <div className="finance-counterparty-tools">
            <div className="finance-side-toggle">
              <button
                className={side === "sales" ? "active" : ""}
                onClick={() => {
                  setSide("sales");
                  setCounterpartyLimit(50);
                }}
              >
                Покупатели · {formatNumber(data.esf.sales.counterpartyCount)}
              </button>
              <button
                className={side === "purchases" ? "active" : ""}
                onClick={() => {
                  setSide("purchases");
                  setCounterpartyLimit(50);
                }}
              >
                Поставщики ·{" "}
                {formatNumber(data.esf.purchases.counterpartyCount)}
              </button>
            </div>
            <input
              value={counterpartyQuery}
              onChange={(event) => {
                setCounterpartyQuery(event.target.value);
                setCounterpartyLimit(50);
              }}
              placeholder="Найти контрагента по названию или БИН…"
              aria-label="Поиск контрагента"
            />
          </div>
          <p className="finance-counterparty-count">
            Найдено: {formatNumber(filteredCounterparties.length)}. Список
            отсортирован по сумме оборота.
          </p>
          <div className="finance-counterparties">
            {filteredCounterparties
              .slice(0, counterpartyLimit)
              .map((counterparty, index) => (
                <article key={`${counterparty.bin}-${index}`}>
                  <span className="finance-rank">{index + 1}</span>
                  <div>
                    <strong>
                      {counterparty.name || "Наименование не указано"}
                    </strong>
                    <small>
                      БИН/ИИН {counterparty.bin} ·{" "}
                      {formatNumber(counterparty.invoiceCount)} ЭСФ
                    </small>
                    <i>
                      <em style={{ width: percent(counterparty.share) }} />
                    </i>
                  </div>
                  <div>
                    <b>
                      {counterparty.share.toLocaleString("ru-RU", {
                        maximumFractionDigits: 2,
                      })}
                      %
                    </b>
                    <strong>{formatMoney(counterparty.turnover)}</strong>
                  </div>
                </article>
              ))}
          </div>
          {counterpartyLimit < filteredCounterparties.length && (
            <button
              className="finance-show-more"
              onClick={() => setCounterpartyLimit((value) => value + 100)}
            >
              Показать ещё 100
            </button>
          )}
        </>
      )}

      {tab === "signals" && (
        <div className="finance-signals">
          <div className="finance-warning">
            <b>Это контрольные сигналы, а не вывод о нарушении.</b>
            <span>{payload?.methodology.warning}</span>
          </div>
          {data.signals.length ? (
            data.signals.map((signal, index) => (
              <article
                className={signal.severity}
                key={`${signal.code}-${index}`}
              >
                <span>
                  {signal.severity === "high"
                    ? "Высокий"
                    : signal.severity === "medium"
                      ? "Средний"
                      : "Низкий"}
                </span>
                <div>
                  <strong>{signal.title}</strong>
                  <p>{signal.detail}</p>
                </div>
              </article>
            ))
          ) : (
            <div className="finance-empty">
              По загруженному набору автоматические сигналы не выявлены.
            </div>
          )}
          <p className="finance-method">{payload?.methodology.declarations}</p>
        </div>
      )}
    </section>
  );
}

function EntityDossier({
  entity,
  onClose,
  onGraph,
  notify,
}: {
  entity: RegistryEntity;
  onClose: () => void;
  onGraph: () => void;
  notify: (message: string) => void;
}) {
  const caseScope = useContext(CaseScopeContext);
  const [openRecords, setOpenRecords] = useState<OpenRecordsResult | null>(
    null,
  );
  const [checkingOpenRecords, setCheckingOpenRecords] = useState(false);
  const [deals, setDeals] = useState<DealsResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDeals(null);
    analyticsFetch(`/api/deals?bin=${encodeURIComponent(entity.bin)}`, {
      cache: "no-store",
    })
      .then((response) =>
        response.ok ? (response.json() as Promise<DealsResult>) : null,
      )
      .then((payload) => {
        if (!cancelled) setDeals(payload);
      })
      .catch(() => {
        if (!cancelled) setDeals(null);
      });
    return () => {
      cancelled = true;
    };
  }, [entity.bin]);

  async function checkOpenRecords() {
    setCheckingOpenRecords(true);
    try {
      const response = await analyticsFetch(
        `/api/open-records?bin=${encodeURIComponent(entity.bin)}`,
        { cache: "no-store" },
      );
      if (!response.ok) throw new Error("lookup failed");
      setOpenRecords((await response.json()) as OpenRecordsResult);
    } catch {
      notify("Не удалось получить сведения из открытых реестров.");
    } finally {
      setCheckingOpenRecords(false);
    }
  }

  async function copyValue(value: string, label: string) {
    if (!value) {
      notify(`${label} не указан.`);
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      notify(`${label} скопирован.`);
    } catch {
      notify(`Не удалось скопировать ${label.toLowerCase()}.`);
    }
  }

  function downloadDossier() {
    const blob = new Blob([JSON.stringify(entity, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = window.document.createElement("a");
    link.href = url;
    link.download = `vestigo-dossier-${entity.bin}.json`;
    link.click();
    URL.revokeObjectURL(url);
    notify("Досье сохранено на компьютере.");
  }

  return (
    <div
      className="dossier-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="dossier-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dossier-title"
      >
        <header className="dossier-header">
          <div>
            <span className="section-kicker">ПОЛНОЕ ДОСЬЕ ОБЪЕКТА</span>
            <h2 id="dossier-title">{entity.name}</h2>
            <p>По загруженным документам · данные документов на {entity.sourceDate}</p>
          </div>
          <button
            className="dossier-close"
            onClick={onClose}
            aria-label="Закрыть досье"
          >
            ×
          </button>
        </header>

        <div className="dossier-actions">
          <button className="primary-button" onClick={onGraph}>
            <Icon name="graph" /> Открыть карту связей
          </button>
          <button
            className="ghost-button"
            onClick={() => copyValue(entity.bin, "БИН/ИИН")}
          >
            Копировать БИН/ИИН
          </button>
          {entity.headIin && (
            <button
              className="ghost-button"
              onClick={() => copyValue(entity.headIin, "ИИН руководителя")}
            >
              Копировать ИИН руководителя
            </button>
          )}
          <button className="ghost-button" onClick={downloadDossier}>
            Скачать JSON
          </button>
          <a
            className="ghost-button dossier-source-link"
            href={caseScope ? `/?caseId=${caseScope.id}&tab=Документы` : "/#documents"}
            target="_blank"
            rel="noreferrer"
          >
            Документы дела ↗
          </a>
        </div>

        <FinancialAnalysis bin={entity.bin} />
        <ImportedEvidenceSection entity={entity} />
        {!caseScope && <div className="dossier-section dossier-open-sources">
          <div className="dossier-section-title">
            <div>
              <span className="section-kicker">ОТКРЫТЫЕ ПРОВЕРКИ</span>
              <h3>Сопоставление по БИН/ИИН</h3>
            </div>
            <span>8</span>
          </div>
          <p>
            РСП и ДФО можно проверить прямо из карточки. Остальные источники
            будут добавляться по мере настройки официального формата выгрузки.
          </p>
          <button
            className="secondary-button"
            onClick={checkOpenRecords}
            disabled={checkingOpenRecords}
          >
            {checkingOpenRecords
              ? "Проверяем открытые реестры…"
              : "Проверить РСП и ДФО"}
          </button>
          {openRecords && (
            <div className="open-record-results">
              <article>
                <strong>РСП — зарегистрированные виды деятельности</strong>
                {openRecords.rsp.status === "found" ? (
                  <>
                    <dl>
                      <div>
                        <dt>Наименование</dt>
                        <dd>{openRecords.rsp.name}</dd>
                      </div>
                      <div>
                        <dt>Сотрудники</dt>
                        <dd>{openRecords.rsp.employees || "Не указано"}</dd>
                      </div>
                      <div>
                        <dt>Категория бизнеса</dt>
                        <dd>
                          {openRecords.rsp.businessCategory || "Не указана"}
                        </dd>
                      </div>
                    </dl>
                    <div className="oked-list">
                      {parseOkedCodes(openRecords.rsp.activity).map((code) => (
                        <div key={code}>
                          <b>{code}</b>
                          <span>
                            {okedTitles[code] ??
                              "Наименование отсутствует в подключённой части справочника"}
                          </span>
                        </div>
                      ))}
                      {!parseOkedCodes(openRecords.rsp.activity).length && (
                        <p>ОКЭД не указан в ответе реестра.</p>
                      )}
                    </div>
                  </>
                ) : (
                  <p>
                    {openRecords.rsp.status === "not-found"
                      ? "По БИН/ИИН запись не найдена."
                      : "Источник временно недоступен."}
                  </p>
                )}
              </article>
              <article>
                <strong>Депозитарий финансовой отчётности</strong>
                {openRecords.dfo.status === "found" ? (
                  <p>{openRecords.dfo.summary}</p>
                ) : (
                  <p>
                    {openRecords.dfo.status === "not-found"
                      ? "Открытая запись по БИН не найдена."
                      : "Источник временно недоступен."}
                  </p>
                )}
              </article>
            </div>
          )}
          <div className="activity-layers">
            <div className="activity-layer ready">
              <span>01</span>
              <div>
                <b>Зарегистрированная деятельность</b>
                <p>
                  РСП: ОКЭД, сотрудники и категория бизнеса — проверяются по БИН
                  прямо в карточке.
                </p>
              </div>
            </div>
            <div className="activity-layer waiting">
              <span>02</span>
              <div>
                <b>Разрешённая деятельность</b>
                <p>
                  eLicense: лицензии и разрешения. Автопроверка не включена, так
                  как публичная форма требует CAPTCHA.
                </p>
              </div>
            </div>
            <div className="activity-layer waiting">
              <span>03</span>
              <div>
                <b>Фактическая деятельность</b>
                <p>
                  Госзакупки: товары, работы и услуги по договорам. Автопроверка
                  не включена без OWS‑токена.
                </p>
              </div>
            </div>
          </div>
          <div className="dossier-source-links">
            <a href="https://data.egov.kz/" target="_blank" rel="noreferrer">
              eGov Data ↗
            </a>
            <a href="https://goszakup.gov.kz/" target="_blank" rel="noreferrer">
              Госзакупки ↗
            </a>
            <a
              href="https://rsp.gov.kz/ru/rsp"
              target="_blank"
              rel="noreferrer"
            >
              РСП ↗
            </a>
            <a href="https://elicense.kz/" target="_blank" rel="noreferrer">
              eLicense ↗
            </a>
            <a href="https://opi.dfo.kz/" target="_blank" rel="noreferrer">
              ДФО ↗
            </a>
            <a href="https://nationalbank.kz/" target="_blank" rel="noreferrer">
              Нацбанк ↗
            </a>
          </div>
        </div>

        }
        <div className="dossier-summary-grid">
          <article className="dossier-score-card">
            <span>Приоритет проверки</span>
            <strong className={riskClass(entity.level)}>{entity.risk}</strong>
            <b>{entity.level}</b>
            <small>
              Расчёт по аналитическим сигналам; не является выводом о нарушении
            </small>
          </article>
          <article>
            <span>Идентификаторы</span>
            <dl>
              <div>
                <dt>БИН/ИИН</dt>
                <dd>{entity.bin}</dd>
              </div>
              <div>
                <dt>РНН</dt>
                <dd>{entity.rnn || "Не указан"}</dd>
              </div>
              <div>
                <dt>ФИО налогоплательщика</dt>
                <dd>{entity.taxpayerFio || "Не указано"}</dd>
              </div>
            </dl>
          </article>
          <article>
            <span>Руководитель</span>
            <dl>
              <div>
                <dt>ФИО</dt>
                <dd>{entity.head || "Не указан"}</dd>
              </div>
              <div>
                <dt>ИИН</dt>
                <dd>{entity.headIin || "Не указан"}</dd>
              </div>
              <div>
                <dt>РНН</dt>
                <dd>{entity.headRnn || "Не указан"}</dd>
              </div>
            </dl>
          </article>
          <article>
            <span>Связи и сведения</span>
            <dl>
              <div>
                <dt>Связанных организаций</dt>
                <dd>{entity.connections}</dd>
              </div>
              <div>
                <dt>Списков документов</dt>
                <dd>{entity.signals}</dd>
              </div>
              <div>
                <dt>Документов</dt>
                <dd>{entity.documents.length}</dd>
              </div>
            </dl>
          </article>
        </div>

        {deals && deals.stats.count > 0 && (
          <div className="dossier-section deals-section">
            <div className="dossier-section-title">
              <div>
                <span className="section-kicker">ЛОКАЛЬНАЯ ВЫГРУЗКА</span>
                <h3>Сделки и контрагенты</h3>
              </div>
              <span>{deals.stats.count}</span>
            </div>
            <div className="deal-summary">
              <span>
                <b>{formatMoney(deals.stats.total)}</b> общая сумма сделок
              </span>
              <span>
                <b>{deals.stats.counterparties}</b> уникальных контрагентов
              </span>
              <span>Источник: {deals.source.file}</span>
            </div>
            <div className="deals-table">
              <div className="deal-row deal-head">
                <span>Контрагент</span>
                <span>Роль и сумма</span>
                <span>Иск / решение</span>
              </div>
              {deals.deals.slice(0, 20).map((deal) => {
                const supplier = deal.supplier.bin === entity.bin;
                const counterparty = supplier ? deal.buyer : deal.supplier;
                return (
                  <div key={deal.id} className="deal-row">
                    <span>
                      <strong>
                        {counterparty.name || "Наименование не указано"}
                      </strong>
                      <small>БИН/ИИН {counterparty.bin}</small>
                    </span>
                    <span>
                      <b>{supplier ? "Поставщик" : "Покупатель"}</b>
                      <strong>{formatMoney(deal.amount)}</strong>
                      <small>НДС {formatMoney(deal.vat)}</small>
                    </span>
                    <span>
                      <strong>
                        {deal.claimNumber ||
                          deal.courtDecision ||
                          "Реквизиты не указаны"}
                      </strong>
                      <small>
                        {deal.courtDate ||
                          deal.claimDate ||
                          deal.periodTo ||
                          deal.periodFrom ||
                          "Дата не указана"}
                      </small>
                    </span>
                  </div>
                );
              })}
            </div>
            {deals.stats.count > 20 && (
              <p className="deals-note">
                Показаны первые 20 из {deals.stats.count} сделок для этого
                объекта.
              </p>
            )}
          </div>
        )}

        <div className="dossier-section">
          <div className="dossier-section-title">
            <div>
              <span className="section-kicker">ОСНОВАНИЯ</span>
              <h3>Статусы в перечнях документов</h3>
            </div>
            <span>{entity.categories.length}</span>
          </div>
          <div className="dossier-statuses">
            {entity.categories.map((category) => (
              <span key={category}>
                <Icon name="check" /> {category}
              </span>
            ))}
          </div>
        </div>

        <div className="dossier-section">
          <div className="dossier-section-title">
            <div>
              <span className="section-kicker">ПЕРВИЧНЫЕ СВЕДЕНИЯ</span>
              <h3>Документы и решения</h3>
            </div>
            <span>{entity.documents.length}</span>
          </div>
          <div className="dossier-documents">
            <div className="dossier-document dossier-document-head">
              <span>Категория</span>
              <span>Номер документа</span>
              <span>Дата</span>
            </div>
            {entity.documents.map((document, index) => (
              <div
                className="dossier-document"
                key={`${document.category}-${document.number}-${index}`}
              >
                <span>{document.category}</span>
                <strong>{document.number || "Номер не указан"}</strong>
                <span>{document.date || "Дата не указана"}</span>
              </div>
            ))}
            {!entity.documents.length && (
              <div className="empty-state">
                В исходном Excel документ не указан.
              </div>
            )}
          </div>
        </div>

        <footer className="dossier-footer">
          <span>Основание приоритета: {entity.reason}</span>
          <button className="secondary-button" onClick={onClose}>
            Закрыть
          </button>
        </footer>
      </section>
    </div>
  );
}

function EmptyCard({ text }: { text: string }) {
  return (
    <div className="card registry-placeholder">
      <strong>Нет данных</strong>
      <p>{text}</p>
    </div>
  );
}
