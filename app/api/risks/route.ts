import {withAuthenticatedApi} from "@/app/lib/auth-request.mjs";
export const GET=withAuthenticatedApi(GETHandler);
import { handleCaseAnalytics } from "@/app/lib/case-analytics.mjs";
import { NextResponse } from "next/server";
import { loadRegistry } from "@/app/lib/analytics-data";
import { loadEvidence } from "@/app/lib/analytics-data";
import { loadDeals } from "@/app/lib/analytics-data";
import { loadFinancials } from "@/app/lib/analytics-data";

type Entity = import("@/app/lib/analytics-data").AnalyticsEntity;

async function GETHandler(request: Request) {
  const scoped = handleCaseAnalytics(request, "risks"); if (scoped) return scoped;
const registry = loadRegistry();
const localEvidence = loadEvidence();
const dealsData = loadDeals();
const financialAnalytics = loadFinancials();

  const entities = registry.entities as Entity[];
  const entityByBin = new Map(entities.map((entity) => [entity.bin, entity]));
  for (const entity of localEvidence.entities) {
    if (!entityByBin.has(entity.bin)) {
      entityByBin.set(entity.bin, {
        id: entity.bin,
        name: entity.name || "Организация из локальной выгрузки",
        bin: entity.bin,
        rnn: "",
        taxpayerFio: "",
        head: entity.head,
        headIin: entity.headIin,
        headRnn: "",
        city: "Не указан",
        categories: ["Локальная налоговая отчётность"],
        categoryCodes: ["LOCAL_TAX_REPORTING"],
        documents: entity.files.map((file) => ({ category: "Локальная налоговая отчётность", number: file, date: "2021–2024" })),
        sourceDate: "2021–2024",
        risk: 35,
        level: "Низкий",
        signals: 1,
        connections: 0,
        status: "Локальная налоговая отчётность",
        reason: `Загружено ${entity.records} строк`,
      } as Entity);
    }
  }

  for (const [bin, profile] of Object.entries(financialAnalytics.entities)) {
    if (entityByBin.has(bin)) continue;
    const item = profile as any;
    const signals = Array.isArray(item.signals) ? item.signals : [];
    const severities = new Set(signals.map((signal: any) => signal.severity));
    const risk = severities.has("high") ? 75 : severities.has("medium") ? 50 : 35;
    const level = risk >= 70 ? "Высокий" : risk >= 45 ? "Средний" : "Низкий";
    const purchases = item.esf?.purchases?.counterparties ?? [];
    const sales = item.esf?.sales?.counterparties ?? [];
    const connections = new Set(
      [...purchases, ...sales].map((counterparty: any) => counterparty.bin).filter(Boolean),
    ).size;
    entityByBin.set(bin, {
      id: bin,
      name: item.name || `Организация ${bin}`,
      bin,
      rnn: "",
      taxpayerFio: "",
      head: "",
      headIin: "",
      headRnn: "",
      city: "Регион определяется по данным источников",
      categories: ["Электронные счета-фактуры"],
      categoryCodes: ["ESF_COUNTERPARTY"],
      documents: [],
      sourceDate: financialAnalytics.generatedAt,
      risk,
      level,
      signals: Math.max(1, signals.length),
      connections,
      status: signals[0]?.title || "Участник ЭСФ",
      reason: signals.length
        ? signals.map((signal: any) => signal.title).join("; ")
        : "Участник найден в загруженных ЭСФ.",
    } as Entity);
  }

  const allEntities = [...entityByBin.values()];

  const leaderGroups = new Map<string, { iin: string; name: string; entities: Entity[] }>();
  for (const entity of allEntities) {
    if (!entity.headIin || !entity.head) continue;
    const group = leaderGroups.get(entity.headIin) ?? { iin: entity.headIin, name: entity.head, entities: [] };
    group.entities.push(entity);
    leaderGroups.set(entity.headIin, group);
  }
  const leaders = [...leaderGroups.values()]
    .filter((leader) => leader.entities.length > 1)
    .map((leader) => {
      const ordered = leader.entities.sort((a, b) => b.risk - a.risk || a.name.localeCompare(b.name, "ru"));
      const highRisk = ordered.filter((entity) => entity.level === "Высокий").length;
      return {
        ...leader,
        entities: ordered,
        highRisk,
        maxRisk: Math.max(...ordered.map((entity) => entity.risk)),
        score: Math.min(100, 45 + ordered.length * 3 + highRisk * 2),
      };
    })
    .sort((a, b) => b.entities.length - a.entities.length || b.score - a.score || a.name.localeCompare(b.name, "ru"));

  const links = new Map<string, Set<string>>();
  const operations = new Map<string, number>();
  const amounts = new Map<string, number>();
  const addLink = (bin: string, counterparty: string, count: number, amount = 0) => {
    if (!entityByBin.has(bin) || !counterparty || bin === counterparty) return;
    const set = links.get(bin) ?? new Set<string>();
    set.add(counterparty);
    links.set(bin, set);
    operations.set(bin, (operations.get(bin) ?? 0) + count);
    amounts.set(bin, (amounts.get(bin) ?? 0) + amount);
  };
  for (const relation of localEvidence.relations) {
    addLink(relation.objectBin, relation.counterpartyBin, relation.operations);
    addLink(relation.counterpartyBin, relation.objectBin, relation.operations);
  }
  for (const deal of dealsData.deals) {
    addLink(deal.supplier.bin, deal.buyer.bin, 1, deal.amount);
    addLink(deal.buyer.bin, deal.supplier.bin, 1, deal.amount);
  }
  for (const [bin, profile] of Object.entries(financialAnalytics.entities)) {
    const sales = (profile as any).esf?.sales?.counterparties ?? [];
    for (const counterparty of sales) {
      addLink(
        bin,
        counterparty.bin,
        Number(counterparty.invoiceCount) || 0,
        Number(counterparty.turnover) || 0,
      );
      addLink(
        counterparty.bin,
        bin,
        Number(counterparty.invoiceCount) || 0,
        Number(counterparty.turnover) || 0,
      );
    }
  }
  const counterpartyObjects = [...links.entries()]
    .map(([bin, counterparties]) => {
      const entity = entityByBin.get(bin)!;
      return {
        entity,
        counterparties: counterparties.size,
        operations: operations.get(bin) ?? 0,
        amount: amounts.get(bin) ?? 0,
        score: Math.min(100, 35 + Math.round(Math.log2(counterparties.size + 1) * 9)),
      };
    })
    .filter((item) => item.counterparties >= 5)
    .sort((a, b) => b.counterparties - a.counterparties || b.operations - a.operations);

  const multiListObjects = allEntities
    .filter((entity) => entity.categories.length > 1)
    .map((entity) => ({
      entity,
      matches: entity.categories.length,
      score: Math.min(100, entity.risk + Math.max(0, entity.categories.length - 1) * 3),
    }))
    .sort((a, b) => b.matches - a.matches || b.score - a.score || a.entity.name.localeCompare(b.entity.name, "ru"));

  return NextResponse.json(
    {
      leaders,
      counterpartyObjects,
      multiListObjects,
      summary: {
        leaders: leaders.length,
        maxLeaderObjects: leaders[0]?.entities.length ?? 0,
        highCounterpartyObjects: counterpartyObjects.length,
        multiListObjects: multiListObjects.length,
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
}
