import test from "node:test";
import assert from "node:assert/strict";
import {encodeUploadMetadata,decodeUploadMetadata} from "../app/lib/upload-protocol.mjs";
test("метаданные двоичной загрузки сохраняют русский и казахский текст",()=>{
  const metadata={name:"Құжат приложение (1).zip",caseId:"test-id",source:"Ответ на запрос"};
  assert.deepEqual(decodeUploadMetadata(encodeUploadMetadata(metadata)),metadata);
  for(const value of [{},{name:"a.txt",caseId:"x",unknown:"x"},{name:"a.txt",caseId:"x",source:"a".repeat(2001)}])assert.throws(()=>encodeUploadMetadata(value));
  for(const value of ["bad!",btoa("null"),"a".repeat(13000)])assert.throws(()=>decodeUploadMetadata(value));
});
