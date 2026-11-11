// Percentages describe confirmed pipeline milestones, never elapsed-time estimates.
export const DOCUMENT_STAGES = {
  waiting:{percent:0,label:"Ожидает начала чтения"},
  reading:{percent:10,label:"Платформа читает документ"},
  classifying:{percent:55,label:"Определяем вид документа"},
  extracting:{percent:70,label:"Извлекаем и уточняем данные"},
  analyzing:{percent:80,label:"Анализируем содержимое документа"},
  matching:{percent:90,label:"Сопоставляем данные и проверяем риски"},
  done:{percent:100,label:"Чтение и анализ завершены"},
};
export function documentProgress(job){
  if(job.state==="completed"){
    const summary=job.result?.summary||{};
    if(summary.status==="needs_ocr")return {percent:null,label:"Текст не распознан — требуется проверка",attention:true};
    if(summary.pageAudit?.pagesWithoutText?.length)return {percent:null,label:"Часть страниц не прочитана — требуется проверка",attention:true};
    const attention=summary.status==="needs_mapping"||(summary.status==="review"&&!summary.contextOnly)||summary.classificationStatus==="unclassified"||summary.documentProfile?.requiresFactReview||(summary.documentAnalysis?.unresolved??(summary.documentAnalysis?1:0))>0||summary.unparsedRows>0;
    return {...DOCUMENT_STAGES.done,attention:!!attention,label:attention?"Документ прочитан — проверьте результат":DOCUMENT_STAGES.done.label};
  }
  if(job.state==="failed")return {percent:null,label:"Не удалось завершить анализ",attention:true};
  if(job.state==="retry")return {percent:0,label:"Повторяем чтение после временной ошибки",attention:false};
  if(job.state==="queued")return {...DOCUMENT_STAGES.waiting,attention:false};
  return {...(DOCUMENT_STAGES[job.phase]||DOCUMENT_STAGES.reading),attention:false};
}
export function transferPercent(sentBytes,loaded,total,fileBytes,batchBytes){
  if(!Number.isFinite(batchBytes)||batchBytes<=0||!Number.isFinite(total)||total<=0)return null;
  const transferred=Math.max(0,sentBytes)+Math.max(0,fileBytes)*Math.min(1,Math.max(0,loaded)/total);
  return Math.min(100,Math.max(0,Math.floor(100*transferred/batchBytes)));
}
export function analysisSummary(jobs){
  const done=jobs.filter(j=>j.state==="completed").length,failed=jobs.filter(j=>j.state==="failed").length;
  const active=jobs.length-done-failed;
  const percent=jobs.length?Math.floor(jobs.reduce((sum,j)=>sum+(documentProgress(j).percent??0),0)/jobs.length):0;
  return {total:jobs.length,done,failed,active,percent};
}
