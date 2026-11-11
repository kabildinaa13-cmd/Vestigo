import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("evidence tabs and contents share an inset instead of touching the panel border",()=>{
  const component=fs.readFileSync("app/components/case-evidence-workspace.tsx","utf8");
  const css=fs.readFileSync("app/case-analysis.css","utf8");
  assert.match(component,/className="panel case-evidence-workspace"/);
  assert.match(component,/className="case-evidence-body"/);
  assert.ok(component.indexOf('className="case-evidence-body"')<component.indexOf('className="analysis-toolbar"'));
  assert.match(css,/\.case-evidence-body\s*\{[^}]*padding:\s*20px var\(--evidence-gutter\) 22px/s);
  assert.match(css,/html \.case-evidence-body > \.detail-grid\s*\{[^}]*padding:\s*0/);
  assert.match(css,/--evidence-gutter:\s*16px/);
});
