import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sitePort = process.env.VESTIGO_SITE_PORT || "3200";
const servicePort = process.env.VESTIGO_SERVICE_PORT || "4418";
const venv = path.join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const env = { ...process.env, VESTIGO_SITE_PORT: sitePort, VESTIGO_SERVICE_PORT: servicePort,
  VESTIGO_INTERNAL_SECRET: randomBytes(32).toString("hex"),
  VESTIGO_PYTHON: process.env.VESTIGO_PYTHON || (fs.existsSync(venv) ? venv : "python"),
  NODE_OPTIONS: "--max-old-space-size=4096" };
const service = spawn(process.execPath, [path.join(root, "scripts/excel-export-server.mjs")], { cwd: root, env, stdio: "inherit", windowsHide: true });
const site = spawn(process.execPath, [path.join(root, "node_modules/vinext/dist/cli.js"), "dev", "--port", sitePort], { cwd: root, env, stdio: "inherit", windowsHide: true });
let stopping = false;
let processor;
function startProcessor(){if(stopping)return;processor=spawn(process.execPath,[path.join(root,"scripts/processing-worker.mjs")],{cwd:root,env,stdio:"inherit",windowsHide:true});processor.on("error",()=>console.error("Background processor could not start"));processor.on("exit",()=>{if(!stopping)setTimeout(startProcessor,3000);});}
startProcessor();
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  service.kill(); site.kill();processor?.kill();
  process.exitCode = code;
}
for (const child of [service, site]) {
  child.on("error", (error) => { console.error(error); stop(1); });
  child.on("exit", (code) => { if (!stopping) stop(code || 1); });
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
