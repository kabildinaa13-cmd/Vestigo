import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("Карта связей открывает только Цепочки, включая смену объекта; сам граф сохранён",()=>{
  const file=fs.readFileSync("app/analytics/analytics-dashboard.tsx","utf8");
  const start=file.indexOf("function ConnectionsView("),end=file.indexOf("function ChainExplorer(",start);
  assert.ok(start>=0&&end>start);
  const view=file.slice(start,end);
  assert.match(view,/\[filter, setFilter\] = useState\("Цепочки"\)/);
  assert.match(view,/setFilter\("Цепочки"\)/);
  const toolbar=view.slice(view.indexOf('<div className="graph-toolbar card">'),view.indexOf('{filter === "Цепочки" ?'));
  assert.match(toolbar,/\[\s*"Цепочки",?\s*\]\.map/);
  assert.doesNotMatch(toolbar,/"Все связи"|"Контрагенты",|"Руководитель"|"Документы"/);
  assert.match(view,/<ChainExplorer/);
  assert.match(file.slice(end),/Сохранить редактируемую схему в Excel/);
  assert.match(file,/\[active, setActive\] = useState\("Обзор"\)/);
  assert.match(file,/\[query, setQuery\] = useState\(""\)/);
  const dashboardState=file.slice(file.indexOf("export function PlatformDashboard("),file.indexOf("const [riskFilter"));
  assert.doesNotMatch(dashboardState,/useState\([^\n]*window\.location\.search/);
});
