import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import {appearanceBootstrap,THEME_KEY,SIDEBAR_KEY} from "../app/lib/appearance.mjs";
function render({saved,system=false,sidebar,compact=false,denied=false}={}){
  const dataset={};
  vm.runInNewContext(appearanceBootstrap,{document:{documentElement:{dataset}},localStorage:{getItem(key){if(denied)throw new Error("blocked");return key===THEME_KEY?saved:key===SIDEBAR_KEY?sidebar:null;}},matchMedia(query){return {matches:query.includes("color-scheme")?system:compact};}});
  return dataset;
}
test("appearance respects the saved theme before first paint",()=>{
  assert.equal(render({saved:"dark"}).theme,"dark");assert.equal(render({saved:"light",system:true}).theme,"light");
});
test("appearance follows the system only without a valid stored preference",()=>{
  assert.equal(render({system:true}).theme,"dark");assert.equal(render({saved:"invalid",system:false}).theme,"light");
});
test("denied localStorage does not prevent rendering",()=>{
  assert.equal(render({denied:true,system:true}).theme,"dark");
});
test("sidebar remembers selection and defaults to icons on small screens",()=>{
  assert.equal(render({compact:true}).sidebar,"collapsed");assert.equal(render({compact:true,sidebar:"false"}).sidebar,"expanded");
  assert.equal(render({sidebar:"true"}).sidebar,"collapsed");assert.equal(render().sidebar,"expanded");
});
test("retained CSS uses the shared palette rather than embedded colors",()=>{
  for(const file of ["app/globals.css","app/analytics/analytics.css","app/case-analysis.css","app/analytics-entry.css","app/analytics/case-scope.css"]){
    assert.doesNotMatch(fs.readFileSync(file,"utf8"),/#[\da-f]{3,8}\b|rgba?\(/i,file);
  }
  const css=fs.readFileSync("app/design-system.css","utf8");
  assert.match(css,/#080F1D/);assert.match(css,/#F6F8FC/);assert.match(css,/prefers-reduced-motion/);
});
