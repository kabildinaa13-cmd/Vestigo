import {documentType} from "./document-types.mjs";

const normalize=value=>String(value||"").normalize("NFKC").toLocaleLowerCase("ru").replace(/ё/g,"е").replace(/\s+/gu," ").trim();

// Searches the selected case's saved records; it does not inspect HTML or alter files.
export function searchSavedDocuments(documents,query,{groupId="",showAll=false,offset=0,limit=25}={}){
  const terms=normalize(query).split(" ").filter(Boolean);
  const active=terms.length>0||!!groupId||showAll;
  const pageSize=Number.isInteger(limit)?Math.max(1,Math.min(100,limit)):25;
  if(!active)return {active:false,items:[],total:0,offset:0,limit:pageSize};
  const found=documents.filter(item=>{
    if(groupId&&item.groupId!==groupId)return false;
    const labels=documentType(item.groupId,item.typeId);
    const text=normalize([item.name,item.source,item.receivedAt,labels?.group.name,labels?.type.name,
      ...(item.episodes||[]).map(episode=>episode.title),
      ...(item.originArchives||[]).map(archive=>`${archive.name} ${archive.path}`)].join(" "));
    return terms.every(term=>text.includes(term));
  });
  const requested=Number.isInteger(offset)?Math.max(0,offset):0;
  const start=Math.min(Math.floor(requested/pageSize)*pageSize,Math.max(0,Math.ceil(found.length/pageSize)-1)*pageSize);
  return {active:true,items:found.slice(start,start+pageSize),total:found.length,offset:start,limit:pageSize};
}

export function savedDocumentStatus(item,processing=false){
  if(item.mediaType==="application/zip")return `Архив · файлов: ${item.archiveMembers?.length||0}`;
  if(processing||item.extraction?.status==="running")return "Анализируется";
  const labels={failed:"Ошибка чтения",needs_ocr:"Текст не распознан",needs_mapping:"Нужны столбцы",review:"Текст прочитан",extracted:"Прочитан"};
  return labels[item.extraction?.status]||"Сохранён";
}
