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

test("реальный скан → OCR → автоматическая предварительная операция → сверка без повторов",{skip:process.env.VESTIGO_TEST_OCR!=="1"},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"vestigo-ocr-flow-")),db=openDatabase({dataDirectory:directory});
  try{
    const python=process.env.VESTIGO_PYTHON||path.join(process.cwd(),".venv",process.platform==="win32"?"Scripts/python.exe":"bin/python");
    const bytes=execFileSync(python,["-c",String.raw`
import io,sys
from PIL import Image,ImageDraw,ImageFont
from pypdf import PdfWriter
from pypdf.generic import DictionaryObject,NameObject,NumberObject,DecodedStreamObject
image=Image.new('RGB',(1700,1100),'white');draw=ImageDraw.Draw(image);font=ImageFont.truetype(r'C:\Windows\Fonts\arial.ttf',54)
for y,line in enumerate(['ДОГОВОР ПОСТАВКИ № CON-1','БИН поставщика: 990000000001','БИН получателя: 990000000002','Дата документа: 20.10.2026','Общая сумма документа: 1000,00','Валюта: KZT']):draw.text((80,70+y*140),line,font=font,fill='black')
writer=PdfWriter();page=writer.add_blank_page(850,550);bitmap=DecodedStreamObject();bitmap.set_data(image.tobytes());bitmap.update({NameObject('/Type'):NameObject('/XObject'),NameObject('/Subtype'):NameObject('/Image'),NameObject('/Width'):NumberObject(1700),NameObject('/Height'):NumberObject(1100),NameObject('/ColorSpace'):NameObject('/DeviceRGB'),NameObject('/BitsPerComponent'):NumberObject(8)})
page[NameObject('/Resources')]=DictionaryObject({NameObject('/XObject'):DictionaryObject({NameObject('/Im0'):writer._add_object(bitmap)})});content=DecodedStreamObject();content.set_data(b'q 850 0 0 550 0 0 cm /Im0 Do Q');page[NameObject('/Contents')]=writer._add_object(content);out=io.BytesIO();writer.write(out);sys.stdout.buffer.write(out.getvalue())
`],{maxBuffer:12*1024*1024,windowsHide:true});
    const parent=createCase(db,{caseNumber:"OCR-FLOW"}),doc=saveDocument(db,{caseId:parent.id,name:"synthetic-scan.pdf",bytes,groupId:"unclassified",typeId:"unclassified",classificationMode:"auto"});
    const first=await processCaseDocument(db,parent.id,doc.id);
    assert.equal(first.summary.documentAnalysis.ocrPages,1);assert.equal(first.summary.documentAnalysis.segments[0].typeId,"supply_agreement");assert.equal(caseAnalysis(db,parent.id).operationCount,1);assert.equal(caseAnalysis(db,parent.id).operations[0].confirmed,false);
    const definitions=first.summary.documentAnalysis.segments.map(s=>({...s,approved:true,note:"Сверено с синтетическим оригиналом",fields:{...s.fields,senderId:"990000000001",recipientId:"990000000002",date:"2026-10-20",amount:"1000,00",currency:"KZT",number:"CON-1"}}));
    await processCaseDocument(db,parent.id,doc.id,{segmentReviewDigest:first.summary.documentAnalysis.sourceDigest,segmentReviews:definitions});
    assert.equal(caseAnalysis(db,parent.id).operationCount,1);assert.equal(caseAnalysis(db,parent.id).operations[0].confirmed,false);
    await processCaseDocument(db,parent.id,doc.id);assert.equal(caseAnalysis(db,parent.id).operationCount,1);
  }finally{db.close();fs.rmSync(directory,{recursive:true,force:true});}
});
