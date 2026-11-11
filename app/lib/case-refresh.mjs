import {getCase,DEFAULT_DEPARTMENT_ID} from "./vestigo-db.mjs";
import {documentOriginal} from "./documents.mjs";
import {migrateCaseAnalysis,storeExtraction} from "./case-analysis.mjs";
import {analyzePdfResult} from "./pdf-analysis.mjs";
import {reserveSynchronousProcessing,failProcessing} from "./processing-queue.mjs";
import {analyzeStandaloneText} from "./document-facts.mjs";

export function refreshStoredCaseDocuments(db,caseId,context={}){
  migrateCaseAnalysis(db);
  const parent=getCase(db,caseId,context.departmentId||DEFAULT_DEPARTMENT_ID);
  if(!parent)throw new Error("Дело не найдено");if(parent.status==="archived")throw new Error("Дело находится в архиве");
  if(db.prepare("SELECT 1 FROM case_extractions WHERE case_id=? AND status='running'").get(caseId))throw new Error("Платформа ещё читает документы этого дела. Обновление доступно после завершения чтения.");
  const saved=db.prepare(`SELECT e.*,m.group_code,m.type_code FROM case_extractions e JOIN case_document_metadata m ON m.case_id=e.case_id AND m.document_id=e.document_id WHERE e.case_id=? AND e.status NOT IN ('failed','running')`).all(caseId);
  let automatic=0;
  for(const item of saved){
    const lease=reserveSynchronousProcessing(db,caseId,item.document_id,context);
    try{
    documentOriginal(db,item.document_id,caseId,{...context,purpose:"analysis"});
    const summary=JSON.parse(item.summary_json),pages=JSON.parse(item.pages_json),options=JSON.parse(item.options_json);
    let result={...summary,rows:db.prepare("SELECT record_json FROM case_extracted_rows WHERE case_id=? AND document_id=? ORDER BY sheet,row_number").all(caseId,item.document_id).map(r=>JSON.parse(r.record_json)),text:item.text_content,pages,status:item.status,warnings:[...new Set(summary.warnings||[])]};
    if(!(options.manualConfirmed&&options.documentFields)){
      if(pages.length&&!summary.bankStatementTables)result=analyzePdfResult(result,options);
      else result=analyzeStandaloneText(result,{groupId:item.group_code,typeId:item.type_code});
    }
    result.warnings=[...new Set(result.warnings||[])];
    const updated=storeExtraction(db,caseId,item.document_id,result,{...options,groupId:item.group_code,typeId:item.type_code,processingLease:lease,processingMessage:"Обновлено извлечение и сопоставление по сохранённому тексту"},context);
    automatic+=updated.documentAnalysis?.automaticallyExtracted||0;
    }catch(error){failProcessing(db,lease.id,lease.token,error);throw error;}
  }
  return {documents:saved.length,automaticSegments:automatic};
}
