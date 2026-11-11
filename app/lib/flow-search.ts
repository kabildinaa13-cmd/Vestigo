export type FlowSearchScope =
  | "all"
  | "organizations"
  | "people"
  | "edges"
  | "deals"
  | "addresses"
  | "identifiers";

export type FlowSearchEntry = {
  id: string;
  kind: "node" | "edge";
  label: string;
  nodeBin?: string;
  edgeId?: string;
  from?: string;
  to?: string;
  allText: string;
  fields: Record<Exclude<FlowSearchScope, "all">, string>;
};

function text(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(text).join(" ");
  if (typeof value === "object")
    return Object.values(value as Record<string, unknown>)
      .map(text)
      .join(" ");
  return String(value);
}

export function normalizeFlowSearch(value: unknown): string {
  return text(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function buildFlowSearchIndex(
  nodes: Record<string, unknown>[],
  edges: Record<string, unknown>[],
): FlowSearchEntry[] {
  const nodeEntries = nodes.map((node) => {
    const bin = String(node.bin ?? "");
    const organizations = text([
      node.name,
      node.role,
      node.status,
      node.categories,
      node.oked,
      node.okedName,
      node.attributes,
    ]);
    const people = text([node.head, node.headIin, node.taxpayerFio, node.role]);
    const addresses = text([node.address, node.city]);
    const identifiers = text([
      node.bin,
      node.headIin,
      node.rnn,
      node.documents,
    ]);
    const fields = {
      organizations: normalizeFlowSearch(organizations),
      people: normalizeFlowSearch(people),
      edges: "",
      deals: "",
      addresses: normalizeFlowSearch(addresses),
      identifiers: normalizeFlowSearch(identifiers),
    };
    return {
      id: `node:${bin}`,
      kind: "node" as const,
      label: String(node.name ?? bin),
      nodeBin: bin,
      allText: normalizeFlowSearch(node),
      fields,
    };
  });
  const edgeEntries = edges.map((edge) => {
    const id = String(edge.id ?? `${edge.from ?? ""}|${edge.to ?? ""}`);
    const relationText = text([
      edge.relations,
      edge.sources,
      edge.descriptions,
      edge.comments,
      edge.attributes,
    ]);
    const dealText = text([
      edge.goods,
      edge.contracts,
      edge.paymentPurposes,
      edge.dates,
      edge.amount,
      edge.vat,
      edge.dealAmount,
      edge.operations,
    ]);
    const fields = {
      organizations: "",
      people: "",
      edges: normalizeFlowSearch(relationText),
      deals: normalizeFlowSearch(dealText),
      addresses: "",
      identifiers: normalizeFlowSearch([edge.from, edge.to]),
    };
    const label = text(
      (Array.isArray(edge.goods) ? edge.goods[0]?.name : "") || edge.relations || edge.descriptions || "Связь",
    );
    return {
      id: `edge:${id}`,
      kind: "edge" as const,
      label,
      edgeId: id,
      from: String(edge.from ?? ""),
      to: String(edge.to ?? ""),
      allText: normalizeFlowSearch(edge),
      fields,
    };
  });
  return [...nodeEntries, ...edgeEntries];
}

export function searchFlowIndex(
  index: FlowSearchEntry[],
  query: string,
  scopes: Iterable<FlowSearchScope>,
): FlowSearchEntry[] {
  const needle = normalizeFlowSearch(query);
  if (!needle) return [];
  const selected = new Set(scopes);
  const searchAll = selected.size === 0 || selected.has("all");
  return index.filter((entry) => {
    if (searchAll) return entry.allText.includes(needle);
    return [...selected].some(
      (scope) => scope !== "all" && entry.fields[scope].includes(needle),
    );
  });
}
