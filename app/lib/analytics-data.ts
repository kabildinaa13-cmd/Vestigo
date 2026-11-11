import fs from "node:fs";
import path from "node:path";

export type AnalyticsEntity = {
  id: string; name: string; bin: string; rnn: string; taxpayerFio: string;
  head: string; headIin: string; headRnn: string; city: string; address?: string;
  oked?: string; okedName?: string; categories: string[]; categoryCodes: string[];
  documents: { category: string; number: string; date: string }[];
  sourceDate: string; risk: number; level: string; signals: number;
  connections: number; status: string; reason: string;
};
type EvidenceEntity = { bin: string; name: string; role: string; head: string; headIin: string;
  records: number; totalAmount: number; files: string[]; counterparties: string[] };
type Relation = { objectBin: string; objectName: string; objectRole: string; counterpartyBin: string;
  counterpartyName: string; counterpartyRole: string; relationType: string; confidence: number;
  recognitionRule?: string; operations: number; files: string[] };
type Deal = { id: string; sheet: string; supplier: { bin: string; name: string }; buyer: { bin: string; name: string };
  amount: number; vat: number; periodFrom: string; periodTo: string; claimNumber: string;
  claimDate: string; courtDecision: string; courtDate: string; reason: string };
type Registry = { entities: AnalyticsEntity[]; stats: { code: string; label: string; file: string; rows: number; updated: string; status: string }[];
  source: { name: string; url: string; region: string; updated: string; lastSync: string; syncStatus: string; syncFiles: number } };
type Evidence = { source: string; importedAt: string; recordsTotal: number; entitiesTotal: number;
  files: { name: string; rows: number; matches: number; status: string }[];
  records: { id: string; fileName: string; bins: string[]; fields: Record<string, string> }[];
  entities: EvidenceEntity[]; relations: Relation[] };

const cache = new Map<string, { mtime: number; size: number; value: unknown }>();
function snapshot<T>(name: string, fallback: T): T {
  const root = process.env.VESTIGO_ANALYTICS_ROOT || process.cwd();
  const file = path.resolve(root, "app/data", name);
  try {
    const stat = fs.statSync(file);
    const previous = cache.get(file);
    if (previous?.mtime === stat.mtimeMs && previous?.size === stat.size) return previous.value as T;
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as T;
    cache.set(file, { mtime: stat.mtimeMs, size: stat.size, value });
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

export const loadRegistry = () => snapshot<Registry>("registry.json", {
  entities: [], stats: [], source: { name: "Документы Vestigo", url: "/", region: "По загруженным материалам", updated: "",
    lastSync: "", syncStatus: "local", syncFiles: 0 },
});
export const loadEvidence = () => snapshot<Evidence>("local-evidence.json", {
  source: "Документы Vestigo", importedAt: "", recordsTotal: 0, entitiesTotal: 0, files: [], records: [], entities: [], relations: [],
});
export const loadDeals = () => snapshot<{ deals: Deal[]; source: { name: string; file: string }; stats: { count: number; total: number; counterparties: number } }>("deals.json", {
  deals: [], source: { name: "Сделки", file: "" }, stats: { count: 0, total: 0, counterparties: 0 },
});
export const loadFinancials = () => snapshot<{ entities: Record<string, any>; generatedAt: string; methodology: Record<string, string>; audit: Record<string, number> }>("financial-analytics.json", {
  entities: {}, generatedAt: "", methodology: {}, audit: { profiles: 0, sourceFiles: 0, uniqueEsfInvoices: 0 },
});
