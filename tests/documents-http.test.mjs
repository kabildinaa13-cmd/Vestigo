import {createAuthenticatedFetch,TEST_SETUP_TOKEN} from "./authenticated-fetch.mjs";
const fetch=createAuthenticatedFetch();
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import {zipSync,strToU8} from "fflate";
import {encodeUploadMetadata,UPLOAD_METADATA_HEADER} from "../app/lib/upload-protocol.mjs";

test("HTTP: загрузка, повтор, скачивание и защита хранилища на отдельной тестовой базе", { timeout: 90000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vestigo-http-"));
  const child = spawn(process.execPath, [path.resolve("node_modules/vinext/dist/cli.js"), "dev", "--port", "3299"], {
    cwd: process.cwd(), env: { ...process.env,VESTIGO_SETUP_TOKEN:TEST_SETUP_TOKEN, VESTIGO_DATA_DIR: directory }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (data) => { logs = (logs + data).slice(-6000); });
  child.stderr.on("data", (data) => { logs = (logs + data).slice(-6000); });
  const base = "http://localhost:3299";
  const json = (url, data) => fetch(`${base}${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 35; attempt++) {
      if (child.exitCode !== null) throw new Error(`Тестовый сервер завершился: ${logs}`);
      try { const response = await fetch(`${base}/api/dashboard`, { signal: AbortSignal.timeout(1500) }); if (response.ok) { ready = true; break; } }
      catch {}
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
    assert.ok(ready, logs);
    const created = await json("/api/cases", { caseNumber: "SYNTHETIC-HTTP-ONLY" });
    assert.equal(created.status, 201);
    const caseId = (await created.json()).case.id;
    const ep = await json("/api/episodes", { caseId, title: "Синтетический эпизод" });
    assert.equal(ep.status, 201);
    const episodeId = (await ep.json()).episode.id;
    const bytes = Buffer.from("Синтетическое подтверждение возврата для проверки API");
    const form = () => {
      const body = new FormData();
      body.set("file", new Blob([bytes], { type: "text/plain" }), "подтверждение.txt");
      body.set("caseId", caseId); body.set("episodeId", episodeId);
      body.set("groupId", "reimbursement"); body.set("typeId", "refund");
      body.set("source", "Синтетический тест"); body.set("receivedAt", "2026-10-19");
      return body;
    };
    const uploaded = await fetch(`${base}/api/documents`, { method: "POST", body: form() });
    assert.equal(uploaded.status, 201, await uploaded.clone().text());
    const document = await uploaded.json();
    const duplicate = await fetch(`${base}/api/documents`, { method: "POST", body: form() });
    assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json()).id, document.id);
    const listed = await (await fetch(`${base}/api/documents?caseId=${caseId}`)).json();
    assert.equal(listed.documents.length, 1);
    assert.equal(listed.documents[0].groupId, "reimbursement");
    assert.equal(listed.documents[0].typeId, "refund");
    assert.equal(listed.documents[0].episodes[0].id, episodeId);
    const original = await fetch(`${base}/api/documents/${document.id}?caseId=${caseId}`);
    assert.equal(original.status, 200);
    assert.match(original.headers.get("content-disposition"), /^attachment;/);
    assert.equal(original.headers.get("x-document-sha256"), createHash("sha256").update(bytes).digest("hex"));
    assert.deepEqual(Buffer.from(await original.arrayBuffer()), bytes);
    assert.equal((await fetch(`${base}/api/documents/${document.id}?caseId=missing`)).status, 404);
    assert.equal((await fetch(`${base}/api/documents`, { method: "POST", headers: { origin: "https://other.example" }, body: form() })).status, 403);
    assert.equal((await fetch(`${base}/data/vestigo.sqlite?raw`)).status, 403);
    const stats = await (await fetch(`${base}/api/dashboard`)).json();
    assert.equal(stats.documents, 1);
    // Real HTTP request larger than the framework's default 1 MB action limit.
    const binaryUpload=async(name,bytes,extra={})=>fetch(`${base}/api/documents`,{method:"POST",headers:{"content-type":"application/octet-stream",[UPLOAD_METADATA_HEADER]:encodeUploadMetadata({name,caseId,groupId:"unclassified",typeId:"unclassified",classificationMode:"auto",...extra})},body:bytes});
    const largeBytes=Buffer.alloc(2*1024*1024,65);
    const large=await binaryUpload("Большой файл.txt",largeBytes);assert.equal(large.status,201,await large.clone().text());
    const largeId=(await large.json()).id;
    const largeDownload=await fetch(`${base}/api/documents/${largeId}?caseId=${caseId}`);assert.deepEqual(Buffer.from(await largeDownload.arrayBuffer()),largeBytes);
    const packageBytes=Buffer.from(zipSync({"folder/a.txt":strToU8("Synthetic archive document A"),"b.txt":strToU8("Synthetic archive document B")},{level:0}));
    const packageResponse=await binaryUpload("Пакет.zip",packageBytes,{processInBackground:"true"});assert.equal(packageResponse.status,201,await packageResponse.clone().text());
    const packageSaved=await packageResponse.json();assert.equal(packageSaved.archive.documents.length,2);assert.ok(packageSaved.archive.documents.every(d=>d.processing.job.state==="queued"));
    const packageAgain=await binaryUpload("Копия пакета.zip",packageBytes,{processInBackground:"true"});assert.equal(packageAgain.status,200);assert.equal((await packageAgain.json()).id,packageSaved.id);
    const archiveListing=await (await fetch(`${base}/api/documents?caseId=${caseId}`)).json();assert.equal(archiveListing.documents.find(d=>d.id===packageSaved.id).archiveMembers.length,2);
    const wrongMetadata=await fetch(`${base}/api/documents`,{method:"POST",headers:{"content-type":"application/octet-stream",[UPLOAD_METADATA_HEADER]:"malformed!"},body:"x"});assert.equal(wrongMetadata.status,400);
    const readText=await json(`/api/documents/${document.id}/analyze`,{caseId});
    assert.equal(readText.status,200,await readText.clone().text());
    assert.equal((await readText.json()).summary.status,"review");
    const preview=await (await fetch(`${base}/api/case-analysis?caseId=${caseId}&documentId=${document.id}`)).json();
    assert.match(preview.text,/Синтетическое подтверждение/);
    const uploadTable=async(name,content,groupId,typeId)=>{
      const body=new FormData();body.set("file",new Blob([content]),name);body.set("caseId",caseId);body.set("groupId",groupId);body.set("typeId",typeId);
      const response=await fetch(`${base}/api/documents`,{method:"POST",body});assert.equal(response.status,201,await response.clone().text());
      const saved=await response.json();const analyzed=await json(`/api/documents/${saved.id}/analyze`,{caseId});assert.equal(analyzed.status,200,await analyzed.clone().text());return saved;
    };
    const invoice=await uploadTable("invoice.csv","БИН поставщика;БИН покупателя;Сумма;Дата;Номер ЭСФ;Валюта\n990000000001;990000000002;1000,01;2026-10-01;ESF-HTTP-1;KZT","primary","invoice");
    await uploadTable("bank.csv","БИН плательщика;БИН получателя;Сумма;Дата операции;Номер документа;Назначение платежа;Валюта\n990000000002;990000000001;900,01;2026-10-02;PAY-HTTP-1;Оплата ESF-HTTP-1;KZT","bank","statement");
    const analysis=await (await fetch(`${base}/api/case-analysis?caseId=${caseId}`)).json();
    assert.equal(analysis.operationCount,2);assert.equal(analysis.matches.length,1);assert.ok(analysis.risks.some(r=>r.code==="PAYMENT_AMOUNT_DIFFERENCE"));
    const filtered=await (await fetch(`${base}/api/case-analysis?caseId=${caseId}&q=990000000001&type=invoice`)).json();assert.equal(filtered.total,1);
    const sourceRow=await (await fetch(`${base}/api/case-analysis?caseId=${caseId}&documentId=${invoice.id}&sourceSheet=${encodeURIComponent("Текстовая таблица")}&sourceRow=2`)).json();
    assert.equal(sourceRow.rows.length,1);assert.equal(sourceRow.rows[0].amountMinor,100001);
    const secondCase=await json("/api/cases",{caseNumber:"SYNTHETIC-OTHER-CASE"});const otherId=(await secondCase.json()).case.id;
    assert.equal((await (await fetch(`${base}/api/case-analysis?caseId=${otherId}`)).json()).operationCount,0);
    assert.equal((await json(`/api/documents/${invoice.id}/analyze`,{caseId:otherId})).status,422);
    const scopedSearch=await (await fetch(`${base}/api/entities?caseId=${caseId}&q=990000000001`)).json();assert.equal(scopedSearch.total,1);
    const scopedGraph=await (await fetch(`${base}/api/flow?caseId=${caseId}&bin=990000000001&scope=all&depth=3`)).json();assert.equal(scopedGraph.nodes.length,2);assert.equal(scopedGraph.edges.length,2);
    const scopedEvidence=await (await fetch(`${base}/api/imports?caseId=${caseId}&bin=990000000001`)).json();assert.equal(scopedEvidence.total,2);
    const scopedRisks=await (await fetch(`${base}/api/risks?caseId=${caseId}`)).json();assert.ok(scopedRisks.risks.some(r=>r.code==="PAYMENT_AMOUNT_DIFFERENCE"));
    const emptyGraph=await (await fetch(`${base}/api/flow?caseId=${otherId}&bin=990000000001`)).json();assert.equal(emptyGraph.nodes.length,0);
    assert.equal((await fetch(`${base}/api/entities?caseId=missing`)).status,404);
    const unifiedPage=await fetch(`${base}/analytics?caseId=${caseId}`);assert.equal(unifiedPage.status,200);assert.match(await unifiedPage.text(),/Один набор документов/);
    const chooser=await fetch(`${base}/analytics`);assert.equal(chooser.status,200);assert.match(await chooser.text(),/Выберите дело/);
    const reviewed=await fetch(`${base}/api/case-analysis`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({caseId,kind:"operation",id:filtered.operations[0].id,status:"confirmed",note:"Проверено по синтетическому оригиналу"})});assert.equal(reviewed.status,200);
    const invalid=await fetch(`${base}/api/case-analysis`,{method:"POST",headers:{"content-type":"application/json",origin:"https://other.example"},body:JSON.stringify({caseId})});assert.equal(invalid.status,403);
    const automaticUpload=async(name,content)=>{
      const body=new FormData();body.set("file",new Blob([content]),name);body.set("caseId",caseId);body.set("groupId","unclassified");body.set("typeId","unclassified");body.set("classificationMode","auto");
      const saved=await fetch(`${base}/api/documents`,{method:"POST",body});assert.equal(saved.status,201,await saved.clone().text());const doc=await saved.json();
      const response=await json(`/api/documents/${doc.id}/analyze`,{caseId});assert.equal(response.status,200,await response.clone().text());return {doc,payload:await response.json()};
    };
    const autoInvoice=await automaticUpload("unknown-name.csv","БИН поставщика;БИН покупателя;Сумма;Дата;Номер ЭСФ;Валюта\n990000000001;990000000002;200,01;2026-10-01;ESF-AUTO-1;KZT");assert.equal(autoInvoice.payload.classification.status,"automatic");assert.equal(autoInvoice.payload.classification.typeId,"invoice");
    const cover=await automaticUpload("opaque.txt","Сопроводительное письмо\nНаправляем материалы для изучения.");assert.equal(cover.payload.classification.typeId,"cover_letter");
    const unknown=await automaticUpload("something.txt","Исходные материалы для ознакомления");assert.equal(unknown.payload.classification.status,"unclassified");
    const afterAuto=await (await fetch(`${base}/api/case-analysis?caseId=${caseId}`)).json();assert.equal(afterAuto.operationCount,3);assert.ok(afterAuto.risks.some(r=>r.code==="DOCUMENT_CLASSIFICATION_REQUIRED"));
    const corrected=await json(`/api/documents/${cover.doc.id}/analyze`,{caseId,classification:{groupId:"correspondence",typeId:"response",note:"Сверено специалистом"}});assert.equal(corrected.status,200,await corrected.clone().text());
    await json(`/api/documents/${cover.doc.id}/analyze`,{caseId});const finalListing=await (await fetch(`${base}/api/documents?caseId=${caseId}`)).json();const correctedItem=finalListing.documents.find(d=>d.id===cover.doc.id);assert.equal(correctedItem.typeId,"response");assert.equal(correctedItem.classification.mode,"manual");
    const contract=await automaticUpload("contract.txt","Договор аренды № HTTP-CON-1\nБИН поставщика: 990000000001\nБИН получателя: 990000000002\nДата документа: 20.10.2026\nОбщая сумма документа: 100,00\nВалюта: KZT\nПредмет договора: аренда помещения");
    assert.equal(contract.payload.summary.automaticFacts.eligible,true);
    const workspace=await (await fetch(`${base}/api/case-workspace?caseId=${caseId}`)).json();assert.equal(workspace.operations,4);
    const textSearch=await (await fetch(`${base}/api/case-workspace?caseId=${caseId}&q=${encodeURIComponent("АРЕНДА")}`)).json();assert.equal(textSearch.total,1);assert.equal(textSearch.results[0].documentId,contract.doc.id);
    assert.equal((await (await fetch(`${base}/api/case-workspace?caseId=${otherId}&q=${encodeURIComponent("аренда")}`)).json()).total,0);
    assert.equal((await fetch(`${base}/api/case-workspace?caseId=missing&q=test`)).status,400);
    assert.equal((await fetch(`${base}/api/case-workspace`,{method:"POST",headers:{"content-type":"application/json",origin:"https://other.example"},body:JSON.stringify({caseId,action:"refresh"})})).status,403);
  } finally {
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
