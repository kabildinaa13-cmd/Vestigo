import {withAuthenticatedApi} from "@/app/lib/auth-request.mjs";
export const GET=withAuthenticatedApi(GETHandler);
import { handleCaseAnalytics } from "@/app/lib/case-analytics.mjs";
import { NextRequest, NextResponse } from "next/server";
import { loadRegistry } from "@/app/lib/analytics-data";
import { loadEvidence } from "@/app/lib/analytics-data";
import { loadFinancials } from "@/app/lib/analytics-data";
import { loadDeals } from "@/app/lib/analytics-data";

type FlowNode = {
  bin: string;
  name: string;
  address: string;
  head: string;
  headIin: string;
  risk: number | null;
  level: string;
  knownObject: boolean;
  rnn?: string;
  taxpayerFio?: string;
  oked?: string;
  okedName?: string;
  role?: string;
  status?: string;
  reason?: string;
  categories?: string[];
  documents?: unknown[];
  attributes?: unknown;
};
type FlowEdge = {
  from: string;
  to: string;
  amount: number;
  vat: number;
  dealAmount: number;
  operations: number;
  years: Set<number>;
  goods: Map<string, number>;
  sources: Set<string>;
  relations: Set<string>;
  descriptions: Set<string>;
  contracts: Set<string>;
  paymentPurposes: Set<string>;
  dates: Set<string>;
  comments: Set<string>;
};

function buildGraph() {
const registry = loadRegistry();
const localEvidence = loadEvidence();
const financialAnalytics = loadFinancials();
const dealsData = loadDeals();
const nodes = new Map<string, FlowNode>();
const edges = new Map<string, FlowEdge>();
const incoming = new Map<string, Set<string>>();
const outgoing = new Map<string, Set<string>>();

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function isBetterName(oldName: string, newName: string) {
  if (!newName || newName === "Наименование не указано") return false;
  if (!oldName || oldName === "Наименование не указано") return true;
  const nLow = newName.toLowerCase().trim();
  const oLow = oldName.toLowerCase().trim();
  if (
    nLow === "товарищество с ограни" ||
    nLow.endsWith(" с ограни") ||
    nLow === "товарищество с ограниченной"
  )
    return false;
  if (
    oLow === "товарищество с ограни" ||
    oLow.endsWith(" с ограни") ||
    oLow === "товарищество с ограниченной"
  )
    return true;
  const oldHasQuotes = /["'«»]/.test(oldName);
  const newHasQuotes = /["'«»]/.test(newName);
  if (newHasQuotes && !oldHasQuotes) return true;
  if (!newHasQuotes && oldHasQuotes) return false;
  return newName.length > oldName.length;
}

function rememberNode(bin: string, patch: Partial<FlowNode>) {
  if (!/^\d{12}$/.test(bin)) return;
  const current = nodes.get(bin) ?? {
    bin,
    name: "Наименование не указано",
    address: "",
    head: "",
    headIin: "",
    risk: null,
    level: "",
    knownObject: false,
  };
  const next = { ...current };
  if (patch.name && isBetterName(current.name, patch.name)) {
    next.name = patch.name;
  }
  for (const key of [
    "address",
    "head",
    "headIin",
    "level",
    "rnn",
    "taxpayerFio",
    "oked",
    "okedName",
    "role",
    "status",
    "reason",
  ] as const)
    if (patch[key] && !next[key]) next[key] = patch[key] as never;
  if (patch.categories?.length)
    next.categories = [
      ...new Set([...(next.categories ?? []), ...patch.categories]),
    ];
  if (patch.documents?.length) next.documents = patch.documents;
  if (patch.attributes) next.attributes = patch.attributes;
  if (typeof patch.risk === "number") next.risk = patch.risk;
  if (patch.knownObject) next.knownObject = true;
  nodes.set(bin, next);
}

function edgeKey(from: string, to: string) {
  return `${from}|${to}`;
}
function ensureEdge(from: string, to: string) {
  const key = edgeKey(from, to);
  const edge = edges.get(key) ?? {
    from,
    to,
    amount: 0,
    vat: 0,
    dealAmount: 0,
    operations: 0,
    years: new Set<number>(),
    goods: new Map<string, number>(),
    sources: new Set<string>(),
    relations: new Set<string>(),
    descriptions: new Set<string>(),
    contracts: new Set<string>(),
    paymentPurposes: new Set<string>(),
    dates: new Set<string>(),
    comments: new Set<string>(),
  };
  edges.set(key, edge);
  const out = outgoing.get(from) ?? new Set<string>();
  out.add(key);
  outgoing.set(from, out);
  const inc = incoming.get(to) ?? new Set<string>();
  inc.add(key);
  incoming.set(to, inc);
  return edge;
}

for (const entity of registry.entities)
  rememberNode(entity.bin, {
    name: entity.name,
    address: entity.city ?? "",
    head: entity.head ?? "",
    headIin: entity.headIin ?? "",
    risk: entity.risk,
    level: entity.level,
    knownObject: true,
    rnn: entity.rnn ?? "",
    taxpayerFio: entity.taxpayerFio ?? "",
    status: entity.status ?? "",
    reason: entity.reason ?? "",
    categories: entity.categories ?? [],
    documents: entity.documents ?? [],
    attributes: {
      categoryCodes: entity.categoryCodes ?? [],
      headRnn: entity.headRnn ?? "",
      sourceDate: entity.sourceDate ?? "",
    },
  });
for (const entity of localEvidence.entities)
  rememberNode(entity.bin, {
    name: entity.name,
    knownObject: true,
    risk: 35,
    level: "Низкий",
    role: entity.role,
    attributes: {
      files: entity.files,
      records: entity.records,
      totalAmount: entity.totalAmount,
      counterparties: entity.counterparties,
    },
  });

type AnalyticsEntity = {
  bin: string;
  name: string;
  esf: {
    sales: {
      counterparties: {
        bin: string;
        name: string;
        invoiceCount: number;
        turnover: number;
        vat: number;
        years: { year: number; turnover: number }[];
        goods?: { name: string; turnover: number }[];
      }[];
    };
  };
};
for (const entity of Object.values(
  financialAnalytics.entities as Record<string, AnalyticsEntity>,
)) {
  rememberNode(entity.bin, { name: entity.name });
  for (const counterparty of entity.esf.sales.counterparties) {
    if (!/^\d{12}$/.test(counterparty.bin) || counterparty.bin === entity.bin)
      continue;
    rememberNode(counterparty.bin, { name: counterparty.name });
    const edge = ensureEdge(entity.bin, counterparty.bin);
    edge.amount = Number(counterparty.turnover) || 0;
    edge.vat = Number(counterparty.vat) || 0;
    edge.operations = Math.max(
      edge.operations,
      Number(counterparty.invoiceCount) || 0,
    );
    counterparty.years.forEach((item) => edge.years.add(item.year));
    counterparty.goods?.forEach((item) =>
      edge.goods.set(
        item.name,
        (edge.goods.get(item.name) ?? 0) + (Number(item.turnover) || 0),
      ),
    );
    edge.sources.add("ЭСФ");
    edge.relations.add("Реализация");
  }
}

for (const relation of localEvidence.relations) {
  const objectIsSupplier = relation.objectRole === "Поставщик";
  const counterpartyIsSupplier = relation.counterpartyRole === "Поставщик";
  const from = objectIsSupplier
    ? relation.objectBin
    : counterpartyIsSupplier
      ? relation.counterpartyBin
      : relation.objectBin;
  const to = objectIsSupplier
    ? relation.counterpartyBin
    : counterpartyIsSupplier
      ? relation.objectBin
      : relation.counterpartyBin;
  rememberNode(relation.objectBin, { name: relation.objectName });
  rememberNode(relation.counterpartyBin, { name: relation.counterpartyName });
  if (!from || !to || from === to) continue;
  const edge = ensureEdge(from, to);
  if (!edge.sources.has("ЭСФ")) edge.operations += relation.operations;
  edge.sources.add("Загруженные CSV");
  edge.relations.add(relation.relationType);
  relation.files?.forEach((value) => edge.descriptions.add(clean(value)));
  edge.descriptions.add(
    `${relation.objectRole} → ${relation.counterpartyRole}`,
  );
}

const dealIds = new Set<string>();
for (const deal of dealsData.deals) {
  const identity = JSON.stringify([
    deal.supplier.bin,
    deal.buyer.bin,
    deal.amount,
    deal.vat,
    deal.periodFrom,
    deal.periodTo,
    deal.claimNumber,
    deal.courtDecision,
  ]);
  if (dealIds.has(identity)) continue;
  dealIds.add(identity);
  rememberNode(deal.supplier.bin, { name: deal.supplier.name });
  rememberNode(deal.buyer.bin, { name: deal.buyer.name });
  if (
    !deal.supplier.bin ||
    !deal.buyer.bin ||
    deal.supplier.bin === deal.buyer.bin
  )
    continue;
  const edge = ensureEdge(deal.supplier.bin, deal.buyer.bin);
  edge.dealAmount += Number(deal.amount) || 0;
  if (!edge.sources.has("ЭСФ")) edge.operations += 1;
  for (const value of [
    deal.periodFrom,
    deal.periodTo,
    deal.claimDate,
    deal.courtDate,
  ]) {
    const cleaned = clean(value);
    const match = cleaned.match(/20\d{2}/);
    if (match) edge.years.add(Number(match[0]));
    if (cleaned) edge.dates.add(cleaned);
  }
  edge.sources.add("Сделки.xlsx");
  edge.relations.add("Сделка");
  for (const value of [deal.claimNumber, deal.courtDecision])
    if (clean(value)) edge.contracts.add(clean(value));
  if (clean(deal.reason)) edge.comments.add(clean(deal.reason));
}

function edgeScore(edge: FlowEdge) {
  return Math.max(edge.amount, edge.dealAmount) + edge.operations * 100_000;
}
function connectedEdgeKeys(
  bin: string,
  direction: "in" | "out",
  scope: string,
) {
  const keys = [
    ...((direction === "in" ? incoming.get(bin) : outgoing.get(bin)) ?? []),
  ];
  keys.sort(
    (left, right) => edgeScore(edges.get(right)!) - edgeScore(edges.get(left)!),
  );
  return scope === "all" ? keys : keys.slice(0, 4);
}

function walk(
  root: string,
  direction: "in" | "out",
  maxDepth: number,
  scope: string,
  levels: Map<string, number>,
  includedEdges: Set<string>,
) {
  const queue: { bin: string; depth: number }[] = [{ bin: root, depth: 0 }];
  const visited = new Set([root]);
  while (queue.length) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) continue;
    for (const key of connectedEdgeKeys(current.bin, direction, scope)) {
      const edge = edges.get(key)!;
      const next = direction === "in" ? edge.from : edge.to;
      includedEdges.add(key);
      const nextLevel =
        direction === "in" ? -(current.depth + 1) : current.depth + 1;
      if (
        !levels.has(next) ||
        Math.abs(nextLevel) < Math.abs(levels.get(next)!)
      )
        levels.set(next, nextLevel);
      if (!visited.has(next)) {
        visited.add(next);
        queue.push({ bin: next, depth: current.depth + 1 });
      }
    }
  }
}


return { nodes, edges, incoming, outgoing, walk, rememberNode, clean };
}

async function GETHandler(request: NextRequest) {
  const scoped = handleCaseAnalytics(request, "flow"); if (scoped) return scoped;
  const { nodes, edges, incoming, outgoing, walk, rememberNode, clean } = buildGraph();
  const bin = clean(request.nextUrl.searchParams.get("bin")).replace(/\D/g, "");
  if (!/^\d{12}$/.test(bin))
    return NextResponse.json({
      root: null,
      nodes: [],
      edges: [],
      audit: { totalNodes: nodes.size, totalEdges: edges.size },
    });
  const scope =
    request.nextUrl.searchParams.get("scope") === "all" ? "all" : "significant";
  const depth = Math.min(
    4,
    Math.max(1, Number(request.nextUrl.searchParams.get("depth")) || 3),
  );
  const levels = new Map<string, number>([[bin, 0]]);
  const includedEdges = new Set<string>();
  walk(bin, "in", Math.min(2, depth), scope, levels, includedEdges);
  walk(bin, "out", depth, scope, levels, includedEdges);
  const includedNodes = new Set(levels.keys());
  try {
    const lookup = new URL(`http://127.0.0.1:${process.env.VESTIGO_SERVICE_PORT || "4418"}/entity-names`);
    lookup.searchParams.set("bins", [...includedNodes].join(","));
    const response = await fetch(lookup, { cache: "no-store", headers: { "x-vestigo-internal": process.env.VESTIGO_INTERNAL_SECRET || "" } });
    if (response.ok) {
      const payload = (await response.json()) as {
        entities?: Array<{
          bin: string;
          name: string;
          city?: string;
          head?: string;
          headIin?: string;
          risk?: number;
          level?: string;
        }>;
      };
      for (const entity of payload.entities ?? [])
        rememberNode(entity.bin, {
          name: entity.name,
          address: entity.city ?? "",
          head: entity.head ?? "",
          headIin: entity.headIin ?? "",
          risk: typeof entity.risk === "number" ? entity.risk : undefined,
          level: entity.level ?? "",
          knownObject: true,
        });
    }
  } catch {
    // Статические графовые данные остаются рабочим резервом, если локальная БД недоступна.
  }
  for (const [key, edge] of edges)
    if (includedNodes.has(edge.from) && includedNodes.has(edge.to))
      includedEdges.add(key);
  const resultEdges = [...includedEdges].map((key) => {
    const edge = edges.get(key)!;
    const goods = [...edge.goods.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 3)
      .map(([name, amount]) => ({ name, amount }));
    return {
      id: key,
      from: edge.from,
      to: edge.to,
      amount: edge.amount,
      vat: edge.vat,
      dealAmount: edge.dealAmount,
      operations: edge.operations,
      years: [...edge.years].sort(),
      goods,
      sources: [...edge.sources].sort(),
      relations: [...edge.relations].sort(),
      descriptions: [...edge.descriptions],
      contracts: [...edge.contracts],
      paymentPurposes: [...edge.paymentPurposes],
      dates: [...edge.dates],
      comments: [...edge.comments],
      cycle: (levels.get(edge.to) ?? 0) <= (levels.get(edge.from) ?? 0),
    };
  });
  const resultNodes = [...includedNodes].map((nodeBin) => ({
    ...(nodes.get(nodeBin) ?? {
      bin: nodeBin,
      name: "Наименование не указано",
      address: "",
      head: "",
      headIin: "",
      risk: null,
      level: "",
      knownObject: false,
    }),
    levelIndex: levels.get(nodeBin) ?? 0,
  }));
  const directTotal =
    (incoming.get(bin)?.size ?? 0) + (outgoing.get(bin)?.size ?? 0);
  return NextResponse.json(
    {
      root: nodes.get(bin) ?? { bin, name: "Наименование не указано" },
      nodes: resultNodes,
      edges: resultEdges,
      audit: {
        totalNodes: nodes.size,
        totalEdges: edges.size,
        shownNodes: resultNodes.length,
        shownEdges: resultEdges.length,
        directTotal,
        scope,
        depth,
      },
      rule: "Поставщик → получатель; один БИН — один узел; суммы ЭСФ не дублируются по товарным строкам.",
    },
    { headers: { "cache-control": "no-store" } },
  );
}
