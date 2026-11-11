import {createAuthenticatedFetch,TEST_SETUP_TOKEN} from "./authenticated-fetch.mjs";
const fetch=createAuthenticatedFetch();
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";

test("аналитика Qaztin в Vestigo: документ → ЭСФ → поиск → риски → граф → Excel", { timeout: 180000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vestigo-analytics-test-"));
  const child = spawn(process.execPath, ["scripts/vestigo-run.mjs"], { cwd: process.cwd(), windowsHide: true,
    env: { ...process.env,VESTIGO_SETUP_TOKEN:TEST_SETUP_TOKEN, VESTIGO_ANALYTICS_ROOT: directory, VESTIGO_DATA_DIR: path.join(directory,"data"),
      VESTIGO_SITE_PORT: "3298", VESTIGO_SERVICE_PORT: "4498" }, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  child.stdout.on("data", (value) => { logs = (logs + value).slice(-12000); });
  child.stderr.on("data", (value) => { logs = (logs + value).slice(-12000); });
  const base = "http://localhost:3298";
  const json = (route, body) => fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    let ready = false;
    for (let i=0;i<35;i++) {
      if (child.exitCode !== null) throw new Error(logs);
      try { if ((await fetch(`${base}/api/dashboard`, { signal: AbortSignal.timeout(1500) })).ok) { ready = true; break; } } catch {}
      await new Promise((resolve) => setTimeout(resolve,350));
    }
    assert.ok(ready, logs);
    const makeCsv = (extra = false) => {
      const headers = ["REGISTRATION_NUMBER","Статус ЭСФ","Дата выписки","Дата совершения оборота","IIN_SELLER",
        "Наименование поставщика по данным ИС ЭСФ","IIN_CUSTOMER","Наименование получателя по данным ИС ЭСФ",
        "Всего по счету, размер оборота по реализации","Всего по счету, сумма НДС",
        "Всего по счету, стоимость товаров, работ, услуг с учетом косвенных налогов","Наименование ТРУ","Порядковый номер ТРУ"];
      const rows = extra ? [8] : [2,3,4,5,6,7];
      const lines = rows.map((i) => [`SYNTHETIC-ESF-${i}`,"CREATED","2026-10-01","2026-10-01","990000000001",
        "ТОО Синтетический поставщик",`99000000000${i}`,`ТОО Синтетический покупатель ${i}`,2600000,312000,2912000,"Поставка оборудования",1].join(";"));
      if (!extra) lines.push(lines[0]); // Same invoice and goods row must not double the turnover.
      return [headers.join(";"),...lines].join("\n");
    };
    const created = await json("/api/cases",{caseNumber:"SYNTHETIC-ANALYTICS"});
    const caseId = (await created.json()).case.id;
    const body = new FormData();
    body.set("file",new Blob([makeCsv()]),"таблица.csv"); body.set("caseId",caseId);
    body.set("groupId","primary"); body.set("typeId","invoice");
    const saved = await fetch(`${base}/api/documents`,{method:"POST",body});
    assert.equal(saved.status,201,await saved.clone().text());
    const document = await saved.json();
    const processed = await json(`/api/documents/${document.id}/analyze`,{caseId,publishAnalytics:true});
    assert.equal(processed.status,200,`${await processed.clone().text()}\n${logs}`);
    const search = await (await fetch(`${base}/api/entities?q=${encodeURIComponent("Синтетический")}`)).json();
    assert.equal(search.total,7, JSON.stringify(search));
    assert.equal(search.metrics.links,0);
    const profile = await (await fetch(`${base}/api/financials?bin=990000000001`)).json();
    assert.equal(profile.entity.esf.sales.invoiceCount,6);
    assert.equal(profile.entity.esf.sales.turnover,15600000);
    const evidence = await (await fetch(`${base}/api/imports?bin=990000000001`)).json();
    assert.equal(evidence.total,7); // Original rows retained, financial aggregation deduplicated.
    assert.equal(evidence.relations.length,6);
    const graph = await (await fetch(`${base}/api/flow?bin=990000000001&scope=all&depth=3`)).json();
    assert.equal(graph.nodes.length,7); assert.equal(graph.edges.length,6);
    assert.equal(graph.root.name,"ТОО Синтетический поставщик");
    const risks = await (await fetch(`${base}/api/risks`)).json();
    assert.ok(risks.counterpartyObjects.some((item) => item.entity.bin === "990000000001"));
    const chain = await (await fetch(`${base}/api/chains?bin=990000000001`)).json();
    assert.equal(chain.neighbors.length,6);
    const listing = await (await fetch(`${base}/api/documents?caseId=${caseId}`)).json();
    assert.equal(listing.documents[0].analytics.status,"completed");
    const repeat = await json(`/api/documents/${document.id}/analyze`,{caseId,publishAnalytics:true});
    assert.equal(repeat.status,200); assert.equal((await repeat.json()).duplicate,true);
    const second = await fetch(`${base}/local-service/upload`,{method:"POST",headers:{"x-file-name":encodeURIComponent("дополнение.csv")},body:makeCsv(true)});
    assert.equal(second.status,200,await second.clone().text());
    const freshGraph = await (await fetch(`${base}/api/flow?bin=990000000001&scope=all&depth=3`)).json();
    assert.equal(freshGraph.nodes.length,8); assert.equal(freshGraph.edges.length,7);
    const layout = {positions:Object.fromEntries(graph.nodes.map((node,i)=>[node.bin,{x:(i%3)*400+50,y:Math.floor(i/3)*230+50,width:340,height:160}])),
      labels:graph.edges.map((edge,i)=>({edgeId:edge.id,x:50,y:i*150+180,width:300,height:100})),stageWidth:1400,stageHeight:1600};
    const exported = await json("/local-service/export",{payload:graph,diagramPayload:graph,diagramLayout:layout,focusBin:"990000000001",scopeLabel:"Все связи",depth:3});
    assert.equal(exported.status,200,`${await exported.clone().text()}\n${logs}`);
    const xlsx = Buffer.from(await exported.arrayBuffer());
    assert.equal(xlsx.subarray(0,2).toString(),"PK");
    const exportFile = path.join(directory,"test-export.xlsx");
    fs.writeFileSync(exportFile,xlsx);
    const inspected = spawnSync(path.resolve(".venv/Scripts/python.exe"),["-c",
      "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); names=z.namelist(); assert any(n.startswith('xl/drawings/drawing') and n.endswith('.xml') for n in names); xml=''.join(z.read(n).decode('utf8') for n in names if n.startswith('xl/drawings/') and n.endswith('.xml')); assert 'Синтетический' in xml; assert '<xdr:sp>' in xml or ':sp ' in xml or ':sp>' in xml; print('Editable Excel shapes verified')",exportFile],{encoding:"utf8",windowsHide:true});
    assert.equal(inspected.status,0,inspected.stderr);
    const refresh = await json("/local-service/refresh",{});
    assert.equal(refresh.status,202);
    let state;
    for (let i=0;i<80;i++) {
      state = await (await fetch(`${base}/local-service/refresh`)).json();
      if (state.state !== "running") break;
      await new Promise((resolve)=>setTimeout(resolve,500));
    }
    assert.equal(state.state,"success",JSON.stringify(state));
    assert.ok(state.steps.every((step)=>step.id !== "kgd"));
    const finalGraph=await (await fetch(`${base}/api/flow?bin=990000000001&scope=all`)).json();
    assert.equal(finalGraph.nodes.length,8);
    const uploadLog=await (await fetch(`${base}/local-service/uploads`)).json();
    const addition=uploadLog.uploads.find((upload)=>upload.name==="дополнение.csv");
    const removed=await fetch(`${base}/local-service/upload?id=${addition.id}`,{method:"DELETE"});
    assert.equal(removed.status,202);
    for(let i=0;i<80;i++){
      state=await (await fetch(`${base}/local-service/refresh`)).json();
      if(state.state!=="running")break;
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    assert.equal(state.state,"success");
    const remaining=await (await fetch(`${base}/api/flow?bin=990000000001&scope=all`)).json();
    assert.equal(remaining.nodes.length,7);
    assert.equal(remaining.edges.length,6);
    const sources=await json("/api/sources",{name:"Тестовый каталог",url:"https://example.org/source",region:"Синтетический"});
    assert.equal(sources.status,201);
  } finally {
    if(child.exitCode===null){
      const closed=once(child,"exit");
      if(process.platform==="win32") spawnSync("taskkill",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});
      else child.kill("SIGTERM");
      await Promise.race([closed,new Promise((resolve)=>setTimeout(resolve,3000))]);
    }
    fs.rmSync(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
});
