import {encodeUploadMetadata, UPLOAD_METADATA_HEADER} from "./upload-protocol.mjs";

// Binary requests avoid the framework's unrelated 1 MB multipart/server-action limit.
export function uploadDocument(data:FormData,onProgress:(loaded:number,total:number)=>void):Promise<any>{
  const file=data.get("file");
  if(!file||typeof file==="string")return Promise.reject(new Error("Выберите файл"));
  const metadata:Record<string,string>={name:file.name};
  for(const key of ["caseId","episodeId","groupId","typeId","source","receivedAt","classificationMode","processInBackground","ownerId","ownerAccount","bankFeeMode","defaultCurrency","bankYear"]){
    const value=data.get(key);if(typeof value==="string")metadata[key]=value;
  }
  let header:string;
  try{header=encodeUploadMetadata(metadata);}catch(error){return Promise.reject(error);}
  return new Promise((resolve,reject)=>{
    let attempt=0;
    function send(){
      attempt++;
      const request=new XMLHttpRequest();
      request.open("POST","/api/documents");
      request.setRequestHeader("content-type","application/octet-stream");
      request.setRequestHeader(UPLOAD_METADATA_HEADER,header);
      request.timeout=600000;
      request.upload.onprogress=event=>onProgress(event.loaded,event.lengthComputable?event.total:0);
      request.onload=()=>{
        if(request.status===413){reject(new Error("Размер файла превышает допустимый лимит 50 МБ"));return;}
        if(request.status===503&&attempt<3){setTimeout(send,attempt*1000);return;}
        let payload;
        try{payload=JSON.parse(request.responseText);}catch{reject(new Error(`Не удалось загрузить файл: ответ сервера ${request.status}. Повторите попытку.`));return;}
        if(request.status<200||request.status>=300){reject(new Error(payload.error||"Не удалось загрузить документ"));return;}
        resolve(payload);
      };
      request.onerror=()=>{
        if(attempt<3){setTimeout(send,attempt*400);return;}
        reject(new Error("Соединение с платформой прервано. Повторите загрузку: сохранённые оригиналы не будут продублированы."));
      };
      request.ontimeout=()=>reject(new Error("Превышено время передачи файла. Повторная загрузка не создаст копию уже сохранённого оригинала."));
      request.onabort=()=>reject(new Error("Передача файла прервана"));
      request.send(file);
    }
    send();
  });
}
