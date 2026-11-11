type ExportNode = {
  bin: string;
  name: string;
  address: string;
  head: string;
  headIin: string;
  risk: number | null;
  level: string;
  knownObject: boolean;
  levelIndex: number;
};

type ExportEdge = {
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
};

type ExportPayload = {
  root: { bin: string; name: string } | null;
  nodes: ExportNode[];
  edges: ExportEdge[];
  audit: {
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

type ExportDiagramLayout = {
  positions: Record<string, { x: number; y: number; width: number; height: number }>;
  labels: { edgeId: string; x: number; y: number; width: number; height: number }[];
  stageWidth: number;
  stageHeight: number;
};

export async function exportFlowWorkbook(options: {
  payload: ExportPayload;
  diagramPayload: ExportPayload;
  diagramLayout: ExportDiagramLayout;
  focusBin: string;
  scopeLabel: string;
  depth: number;
  pageLabel?: string;
}) {
  const response = await fetch("/local-service/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(options),
  });
  if (!response.ok) throw new Error(`Excel export failed: ${response.status}`);
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = `vestigo-схема-${options.focusBin}.xlsx`;
  link.click();
  URL.revokeObjectURL(url);
}
