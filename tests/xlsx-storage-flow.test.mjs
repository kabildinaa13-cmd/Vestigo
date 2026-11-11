import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {execFileSync} from "node:child_process";
import {openDatabase,createCase} from "../app/lib/vestigo-db.mjs";
import {saveDocument} from "../app/lib/documents.mjs";
import {processCaseDocument} from "../app/lib/document-processing.mjs";
import {caseAnalysis} from "../app/lib/case-analysis.mjs";

test("XLSX upload → opaque original → tables and formula audit → no duplicate operations",async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"vestigo-xlsx-flow-")),db=openDatabase({dataDirectory:directory});
  try{
    const python=process.env.VESTIGO_PYTHON||path.join(process.cwd(),".venv",process.platform==="win32"?"Scripts/python.exe":"bin/python");
    const bytes=execFileSync(python,["-c",String.raw`
import io,sys
from openpyxl import Workbook
book=Workbook();sheet=book.active
sheet.append(['sender_id','recipient_id','amount','date','document_number','currency','error','formula'])
sheet.append(['010740002706','210440002261',1000.01,'2026-10-20','ESF-SYNTHETIC-1','KZT','#N/A','=1+1'])
out=io.BytesIO();book.save(out);sys.stdout.buffer.write(out.getvalue())
`],{windowsHide:true});
    const parent=createCase(db,{caseNumber:"XLSX-STORAGE-REGRESSION"});
    const doc=saveDocument(db,{caseId:parent.id,name:"synthetic.xlsx",bytes,groupId:"primary",typeId:"invoice"});
    assert.ok(fs.readdirSync(path.join(directory,"uploads")).some(name=>name.endsWith(".original")));
    const first=await processCaseDocument(db,parent.id,doc.id);
    assert.equal(first.summary.rows,1);
    assert.equal(first.summary.formulaAudit.errorCount,1);
    assert.equal(first.summary.formulaAudit.formulaCount,1);
    const analysis=caseAnalysis(db,parent.id);
    assert.equal(analysis.operationCount,1);
    assert.equal(analysis.operations[0].senderId,"010740002706");
    assert.equal(analysis.operations[0].amountMinor,100001);
    await processCaseDocument(db,parent.id,doc.id);
    assert.equal(caseAnalysis(db,parent.id).operationCount,1);
  }finally{db.close();fs.rmSync(directory,{recursive:true,force:true});}
});
