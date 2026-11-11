import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {searchSavedDocuments,savedDocumentStatus} from "../app/lib/saved-document-search.mjs";

const documents=[
  {id:"1",name:"Расчёт доходности.xlsx",source:"Организация Альфа",groupId:"expert",typeId:"mining_calculation",episodes:[{title:"Эпизод майнинг"}],extraction:{status:"review"}},
  {id:"2",name:"14----15.pdf",source:"Банк",groupId:"bank",typeId:"payment_order",receivedAt:"2026-10-21",extraction:{status:"extracted"}},
  {id:"3",name:"Поставка.csv",groupId:"primary",typeId:"invoice",originArchives:[{name:"fwd.zip",path:"ЭСФ/Поставка.csv"}],extraction:{status:"failed"}},
];
test("large document panels are hidden until a saved-document search is requested",()=>{
  assert.equal(searchSavedDocuments(documents,"").active,false);
  assert.deepEqual(searchSavedDocuments(documents," ").items,[]);
  assert.equal(searchSavedDocuments(documents,"",{showAll:true}).total,3);
  const source=fs.readFileSync("app/components/documents-panel.tsx","utf8");
  assert.match(source,/expanded&&<article/);
  assert.match(source,/aria-label="Найденные документы"/);
  assert.doesNotMatch(source,/className="document-list"|visible\.map/);
});
test("saved-document search matches partial names, case, ё, source, type, episode and archive path",()=>{
  for(const query of ["расчет","ДОХОД","АЛЬФА","майнинг","Расчёт альфа"])assert.deepEqual(searchSavedDocuments(documents,query).items.map(d=>d.id),["1"]);
  assert.deepEqual(searchSavedDocuments(documents,"платёжное").items.map(d=>d.id),["2"]);
  assert.deepEqual(searchSavedDocuments(documents,"14----").items.map(d=>d.id),["2"]);
  assert.deepEqual(searchSavedDocuments(documents,"fwd.zip").items.map(d=>d.id),["3"]);
  assert.equal(searchSavedDocuments(documents,"несуществующий").total,0);
  assert.equal(searchSavedDocuments(documents,"альфа",{groupId:"bank"}).total,0);
  assert.deepEqual(searchSavedDocuments(documents,"",{groupId:"bank"}).items.map(d=>d.id),["2"]);
});
test("results are paginated, offsets clamped and original records remain unchanged",()=>{
  const many=Array.from({length:62},(_,i)=>({...documents[1],id:String(i)})),before=JSON.stringify(many);
  assert.equal(searchSavedDocuments(many,"pdf").items.length,25);
  const last=searchSavedDocuments(many,"pdf",{offset:999});assert.equal(last.offset,50);assert.equal(last.items.length,12);
  assert.equal(searchSavedDocuments(many,"pdf",{offset:-10}).offset,0);
  assert.equal(JSON.stringify(many),before);
  assert.equal(searchSavedDocuments([],"pdf").total,0);
});
test("compact statuses do not disguise an unread or failed document as processed",()=>{
  assert.equal(savedDocumentStatus(documents[2]),"Ошибка чтения");
  assert.equal(savedDocumentStatus(documents[1],true),"Анализируется");
  assert.equal(savedDocumentStatus({}),"Сохранён");
  assert.equal(savedDocumentStatus({extraction:{status:"needs_ocr"}}),"Текст не распознан");
});
