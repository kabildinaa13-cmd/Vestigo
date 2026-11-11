import {withAuthenticatedApi} from "@/app/lib/auth-request.mjs";
export const GET=withAuthenticatedApi(GETHandler);
import { handleCaseAnalytics } from "@/app/lib/case-analytics.mjs";
import { NextRequest, NextResponse } from "next/server";
import { loadRegistry } from "@/app/lib/analytics-data";
import { loadEvidence } from "@/app/lib/analytics-data";
import { loadDeals } from "@/app/lib/analytics-data";

type Edge = {
  a: string;
  b: string;
  operations: number;
  amount: number;
  sources: Set<string>;
  relations: Set<string>;
};

function buildGraph() {
const registry = loadRegistry();
const localEvidence = loadEvidence();
const dealsData = loadDeals();
const names = new Map<string, string>();
const knownObjects = new Map<string, { risk: number; level: string; head: string; headIin: string }>();
const adjacency = new Map<string, Set<string>>();
const edges = new Map<string, Edge>();

function rememberName(bin: string, name: string) {
  const cleanName = String(name ?? "").trim();
  if (bin && cleanName && (!names.has(bin) || names.get(bin)?.includes("Наименование не указано"))) names.set(bin, cleanName);
}

function addEdge(from: string, to: string, operations: number, amount: number, source: string, relation: string) {
  if (!from || !to || from === to) return;
  const [a, b] = from < to ? [from, to] : [to, from];
  const key = `${a}|${b}`;
  const edge = edges.get(key) ?? { a, b, operations: 0, amount: 0, sources: new Set<string>(), relations: new Set<string>() };
  edge.operations += operations;
  edge.amount += amount;
  edge.sources.add(source);
  edge.relations.add(relation);
  edges.set(key, edge);
  const fromLinks = adjacency.get(from) ?? new Set<string>();
  const toLinks = adjacency.get(to) ?? new Set<string>();
  fromLinks.add(to);
  toLinks.add(from);
  adjacency.set(from, fromLinks);
  adjacency.set(to, toLinks);
}

for (const entity of registry.entities) {
  rememberName(entity.bin, entity.name);
  knownObjects.set(entity.bin, { risk: entity.risk, level: entity.level, head: entity.head ?? "", headIin: entity.headIin ?? "" });
}
for (const entity of localEvidence.entities) {
  rememberName(entity.bin, entity.name);
  if (!knownObjects.has(entity.bin)) knownObjects.set(entity.bin, { risk: 35, level: "Низкий", head: "", headIin: "" });
}
for (const relation of localEvidence.relations) {
  rememberName(relation.objectBin, relation.objectName);
  rememberName(relation.counterpartyBin, relation.counterpartyName);
  addEdge(relation.objectBin, relation.counterpartyBin, relation.operations, 0, "Загруженные CSV", relation.relationType);
}

const dealIdentity = (deal: (typeof dealsData.deals)[number]) => JSON.stringify([
  deal.supplier.bin, deal.buyer.bin, deal.supplier.name.trim().toLocaleLowerCase("ru"), deal.buyer.name.trim().toLocaleLowerCase("ru"),
  deal.amount, deal.vat, deal.periodFrom, deal.periodTo, deal.claimNumber, deal.claimDate, deal.courtDecision, deal.courtDate, deal.reason,
]);
const uniqueDeals = new Map<string, (typeof dealsData.deals)[number]>();
for (const deal of dealsData.deals) uniqueDeals.set(dealIdentity(deal), deal);
for (const deal of uniqueDeals.values()) {
  rememberName(deal.supplier.bin, deal.supplier.name);
  rememberName(deal.buyer.bin, deal.buyer.name);
  addEdge(deal.supplier.bin, deal.buyer.bin, 1, deal.amount, "Сделки.xlsx", "Сделка");
}

function componentSize(root: string) {
  const visited = new Set([root]);
  const queue = [root];
  while (queue.length) {
    const current = queue.shift()!;
    for (const next of adjacency.get(current) ?? []) {
      if (visited.has(next)) continue;
      visited.add(next);
      queue.push(next);
    }
  }
  return visited.size;
}


return { names, knownObjects, adjacency, edges, componentSize, duplicateDealsRemoved: dealsData.deals.length - uniqueDeals.size };
}

async function GETHandler(request: NextRequest) {
  const scoped = handleCaseAnalytics(request, "chains"); if (scoped) return scoped;
  const { names, knownObjects, adjacency, edges, componentSize, duplicateDealsRemoved } = buildGraph();
  const bin = request.nextUrl.searchParams.get("bin")?.replace(/\D/g, "") ?? "";
  if (!/^\d{12}$/.test(bin)) return NextResponse.json({ node: null, neighbors: [], componentSize: 0 });
  const neighborBins = [...(adjacency.get(bin) ?? [])];
  const neighbors = neighborBins.map((neighborBin) => {
    const [a, b] = bin < neighborBin ? [bin, neighborBin] : [neighborBin, bin];
    const edge = edges.get(`${a}|${b}`)!;
    const object = knownObjects.get(neighborBin);
    return {
      bin: neighborBin,
      name: names.get(neighborBin) || "Наименование не указано",
      head: object?.head ?? "",
      headIin: object?.headIin ?? "",
      knownObject: Boolean(object),
      risk: object?.risk ?? null,
      level: object?.level ?? "",
      connections: adjacency.get(neighborBin)?.size ?? 0,
      operations: edge.operations,
      amount: edge.amount,
      sources: [...edge.sources].sort(),
      relations: [...edge.relations].sort(),
    };
  }).sort((left, right) => right.connections - left.connections || right.operations - left.operations || left.name.localeCompare(right.name, "ru"));
  const object = knownObjects.get(bin);
  return NextResponse.json(
    {
      node: { bin, name: names.get(bin) || "Наименование не указано", head: object?.head ?? "", headIin: object?.headIin ?? "", knownObject: Boolean(object), risk: object?.risk ?? null, level: object?.level ?? "" },
      neighbors,
      componentSize: componentSize(bin),
      audit: {
        uniqueNodes: names.size,
        uniqueEdges: edges.size,
        duplicateDealsRemoved,
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
}
