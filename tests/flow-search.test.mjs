import assert from "node:assert/strict";
import test from "node:test";
import { buildFlowSearchIndex, normalizeFlowSearch, searchFlowIndex } from "../app/lib/flow-search.ts";

const nodes = [
  { bin: "123456789012", name: "ТОО «Альфа»", head: "Иванов Иван", headIin: "900101000001", address: "Караганда, улица Абая", oked: "68202", okedName: "Аренда помещений" },
  { bin: "123456789013", name: "ТОО «Бета»", head: "Петров Пётр", address: "Караганда, улица Бухар-Жырау" },
];
const edges = [
  { id: "alpha-beta", from: "123456789012", to: "123456789013", relations: ["Договор аренды"], descriptions: ["Аренда помещения"], goods: [{ name: "Поставка оборудования", amount: 25_000_000 }], contracts: ["Договор № 17"], dates: ["01.09.2026"], amount: 25_000_000 },
];

test("graph search is case-insensitive and supports partial matches", () => {
  const index = buildFlowSearchIndex(nodes, edges);
  assert.equal(normalizeFlowSearch("АРЕНДА"), "аренда");
  assert.equal(searchFlowIndex(index, "АРЕ", ["all"]).length, 2);
  assert.equal(searchFlowIndex(index, "поставка", ["deals"]).length, 1);
  assert.equal(searchFlowIndex(index, "иванов", ["people"]).length, 1);
  assert.equal(searchFlowIndex(index, "68202", ["organizations"]).length, 1);
});

test("an edge result preserves both endpoint identifiers for highlighting", () => {
  const [result] = searchFlowIndex(buildFlowSearchIndex(nodes, edges), "договор аренды", ["edges"]);
  assert.equal(result.kind, "edge");
  assert.equal(result.from, "123456789012");
  assert.equal(result.to, "123456789013");
});
