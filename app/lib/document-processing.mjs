import {getCase} from "./vestigo-db.mjs";
import {documentOriginal,classificationStatus} from "./documents.mjs";
import {classifyDocument} from "./document-classifier.mjs";
import {documentType} from "./document-types.mjs";
import {assertBankPreview} from './bank-reanalysis.mjs';
import {analyzePdfResult} from "./pdf-analysis.mjs";
import {analyzeStandaloneText} from "./document-facts.mjs";
import {extractOriginal,migrateCaseAnalysis,storeExtraction} from "./case-analysis.mjs";
import {migrateProcessingQueue,assertProcessingLease,reserveSynchronousProcessing,failProcessing,renewProcessing,updateProcessingPhase,enqueueProcessing} from "./processing-queue.mjs";
export function shouldContinueOcr(result,attempt=0){return Number.isInteger(attempt)&&attempt>=0&&attempt<2&&!!result.pages?.some(page=>!page.text?.trim()&&/предел|превысило время/i.test(page.ocrError||""));}
export async function processCaseDocument(db,caseId,id,body={},context={},lease=null){
  assertBankPreview(db,caseId,id,body,context);
  const own=!lease;if(own)lease=reserveSynchronousProcessing(db,caseId,id,context);
  const heartbeat=own?setInterval(()=>{try{renewProcessing(db,lease.id,lease.token);}catch{}},10000):null;
  try{return await processWithLease(db,caseId,id,body,context,lease);}
  catch(error){if(own)failProcessing(db,lease.id,lease.token,error);throw error;}
  finally{if(heartbeat)clearInterval(heartbeat);}
}
async function processWithLease(db,caseId,id,body,context,lease){
  const parent=getCase(db,caseId,context.departmentId);
  if(!parent)throw new Error("Дело не найдено");if(parent.status==="archived")throw new Error("Дело находится в архиве");
  documentOriginal(db,id,caseId,{...context,purpose:"analysis"});migrateCaseAnalysis(db);migrateProcessingQueue(db);
  if(lease){const j=assertProcessingLease(db,lease.id,lease.token);if(j.case_id!==caseId||j.document_id!==id)throw new Error("Задание не относится к документу");}
  const previous=db.prepare("SELECT options_json FROM case_extractions WHERE case_id=? AND document_id=?").get(caseId,id),priorOptions=JSON.parse(previous?.options_json||"{}");
  let decision;
  if(body.classification){const {groupId,typeId,note}=body.classification;
    if(typeof groupId!=="string"||typeof typeId!=="string"||!documentType(groupId,typeId)||typeof note!=="string"||!note.trim()||note.length>4000)throw new Error("Выберите группу, вид и укажите обоснование изменения (до 4000 символов)");
    decision={mode:"manual",status:"manual",groupId,typeId,note:note.trim(),version:"manual-1.0",explanation:"Вид выбран специалистом; автоматическое правило не заменяет это решение."};}
  const running=db.prepare("SELECT document_id FROM case_extractions WHERE case_id=? AND status='running' AND updated_at>? LIMIT 1").get(caseId,new Date(Date.now()-600000).toISOString());
  if(running)throw new Error("В этом деле уже обрабатывается документ. Дождитесь завершения.");
  db.prepare("INSERT INTO case_extractions(case_id,document_id,status,updated_at) VALUES(?,?,'running',?) ON CONFLICT(case_id,document_id) DO UPDATE SET status='running',updated_at=excluded.updated_at,error=''").run(caseId,id,new Date().toISOString());
  try{
    const options={mapping:body.mapping??priorOptions.mapping??{},tableSettings:body.tableSettings??priorOptions.tableSettings??[],ownerId:String(body.ownerId??priorOptions.ownerId??""),ownerAccount:String(body.ownerAccount??priorOptions.ownerAccount??""),bankFeeMode:String(body.bankFeeMode??priorOptions.bankFeeMode??"unknown"),bankYear:String(body.bankYear??priorOptions.bankYear??""),direction:String(body.direction??priorOptions.direction??""),defaultCurrency:String(body.defaultCurrency??priorOptions.defaultCurrency??""),documentFields:body.documentFields??priorOptions.documentFields,manualConfirmed:body.manualConfirmed??priorOptions.manualConfirmed,ocrEnabled:body.ocrEnabled??priorOptions.ocrEnabled??true,segmentReviews:body.segmentReviews??priorOptions.segmentReviews,segmentReviewDigest:body.segmentReviewDigest??priorOptions.segmentReviewDigest};
    if(body.resetSegmentReviews===true){delete options.segmentReviews;delete options.segmentReviewDigest;}
    options.ocrContinuation=Number(body.ocrContinuation||0);
    if(lease)updateProcessingPhase(db,lease.id,lease.token,"reading");
    let {result,settings}=await extractOriginal(db,caseId,id,{...options,...(decision?{classificationOverride:decision}:{})},context);
    if(lease)updateProcessingPhase(db,lease.id,lease.token,"classifying");
    if(!decision&&classificationStatus(db,caseId,id)?.mode==="auto"){
      const original=documentOriginal(db,id,caseId,{...context,purpose:"analysis"}),proposal=classifyDocument({name:original.name,text:result.text||"",tables:result.tables||[]});
      decision={...proposal,mode:"auto"};if(settings.groupId!==proposal.groupId||settings.typeId!==proposal.typeId){
        if(result.pages?.length&&!result.bankStatementTables)settings={...settings,groupId:proposal.groupId,typeId:proposal.typeId};
        else {if(lease)updateProcessingPhase(db,lease.id,lease.token,"extracting");({result,settings}=await extractOriginal(db,caseId,id,{...options,classificationOverride:proposal},context));}
      }
    }
    if(lease)updateProcessingPhase(db,lease.id,lease.token,"analyzing");
    if(result.pages?.length&&!result.bankStatementTables&&!(settings.manualConfirmed&&settings.documentFields)){
      result=analyzePdfResult(result,options);
      const kinds=new Set(result.documentAnalysis.segments.map(s=>`${s.groupId}:${s.typeId}`));
      if(decision?.mode==="auto"&&kinds.size>1){decision={...decision,groupId:"unclassified",typeId:"mixed_bundle",status:"review",explanation:"По страницам найдены разные виды документов; границы и реквизиты требуют сверки."};settings={...settings,groupId:"unclassified",typeId:"mixed_bundle"};}
    }
    if(!result.pages?.length&&!(settings.manualConfirmed&&settings.documentFields))result=analyzeStandaloneText(result,settings);
    const message=result.status==="needs_ocr"?"Оригинал сохранён. Текст не распознан; проверьте ошибки локального OCR.":result.documentAnalysis?`Выполнен постраничный разбор: ${result.documentAnalysis.total} фрагментов, ${result.documentAnalysis.ocrPages} страниц OCR. Откройте «Что прочитано из файла» для сверки.`:result.documentProfile?"Вид материала распознан; проверьте реквизиты и замечания в «Что прочитано из файла». Расчёты и справочные сведения не превращены в платежи.":settings.groupId==="correspondence"?"Служебное письмо сохранено как контекст дела; денежные операции не создаются.":settings.groupId==="unclassified"?"Вид файла требует ручной проверки; денежные операции не создаются.":result.status==="needs_mapping"?"Файл прочитан. Настройте столбцы.":`Документ прочитан: ${result.rows.length} строк. Проверьте операции и риски выбранного дела.`;
    if(lease)updateProcessingPhase(db,lease.id,lease.token,"matching");
    const summary=storeExtraction(db,caseId,id,result,{...settings,...(decision?{classificationDecision:decision}:{}),...(lease?{processingLease:lease,processingMessage:message}:{})},context);
    let continuation=null;
    if(shouldContinueOcr(result,options.ocrContinuation)&&!options.segmentReviews?.some(segment=>segment.approved)){
      try{const allowed=["mapping","tableSettings","ownerId","ownerAccount","bankFeeMode","bankYear","direction","defaultCurrency","documentFields","manualConfirmed","classification"],nextOptions=Object.fromEntries(Object.entries(body).filter(([key])=>allowed.includes(key)));
        continuation=enqueueProcessing(db,{caseId,documentId:id,options:{...nextOptions,ocrContinuation:options.ocrContinuation+1},force:true},context);
      }catch(error){console.error("OCR continuation was not queued:",String(error.message||error));continuation={error:"Продолжение OCR не поставлено в очередь. Прочитанные результаты сохранены."};}
    }
    let shared={},sharedPublication=null;
    if(body.publishAnalytics===true&&lease.kind==="sync"){
      try{
      const original=documentOriginal(db,id,caseId,{...context,purpose:"analysis"});if(!/\.(csv|xlsx|xls|json)$/i.test(original.name))throw new Error("Общая аналитика принимает только таблицы. Данные дела сохранены.");
      const response=await fetch(`http://127.0.0.1:${process.env.VESTIGO_SERVICE_PORT||"4418"}/upload`,{method:"POST",headers:{"x-vestigo-internal":process.env.VESTIGO_INTERNAL_SECRET||"","x-file-name":encodeURIComponent(original.name),"content-type":original.mediaType},body:new Uint8Array(original.bytes),signal:AbortSignal.timeout(300000)});
      shared=await response.json();if(!response.ok)throw new Error(String(shared.error||"Ошибка общей аналитики; данные дела сохранены"));
      db.prepare("INSERT INTO document_analytics(case_id,document_id,status,updated_at,details_json) VALUES(?,?,'completed',?,?) ON CONFLICT(case_id,document_id) DO UPDATE SET status='completed',updated_at=excluded.updated_at,details_json=excluded.details_json,error=''").run(caseId,id,new Date().toISOString(),JSON.stringify(shared));
        sharedPublication={status:"completed"};
      }catch(error){
        const message=String(error.message||error).slice(0,2000);
        db.prepare("INSERT INTO document_analytics(case_id,document_id,status,updated_at,details_json,error) VALUES(?,?,'failed',?,'{}',?) ON CONFLICT(case_id,document_id) DO UPDATE SET status='failed',updated_at=excluded.updated_at,error=excluded.error").run(caseId,id,new Date().toISOString(),message);
        shared={};sharedPublication={status:"failed",error:message};
      }
    }
    return {...shared,summary,classification:decision||classificationStatus(db,caseId,id)?.result,message:sharedPublication?.status==="failed"?message+" Анализ дела сохранён, но публикация в общий реестр не выполнена: "+sharedPublication.error:message,continuation,...(sharedPublication?{sharedPublication}:{})};
  }catch(error){
    let owned=true;if(lease){try{assertProcessingLease(db,lease.id,lease.token);}catch{owned=false;}}
    if(owned)db.prepare("UPDATE case_extractions SET status='failed',updated_at=?,error=? WHERE case_id=? AND document_id=?").run(new Date().toISOString(),String(error.message||error).slice(0,4000),caseId,id);
    throw error;
  }
}
