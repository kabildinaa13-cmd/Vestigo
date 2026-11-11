import AnalyticsWorkspace from "./analytics-workspace";
import {openDatabase,getCase,listCases} from "@/app/lib/vestigo-db.mjs";
import "./analytics.css";
import "../case-analysis.css";
import "./case-scope.css";
export const dynamic="force-dynamic";
export default async function AnalyticsPage({searchParams}:{searchParams:Promise<Record<string,string|undefined>>}){
  const params=await searchParams;
  if(params?.scope==="legacy")return <div className="analytics-workspace"><p className="legacy-warning">Старый общий набор. Эти материалы не привязаны к делам. <a href="/analytics">Вернуться к выбору дела</a></p><AnalyticsWorkspace scope={null}/></div>;
  const db=openDatabase();
  try{
    const parent=params?.caseId?getCase(db,params.caseId):null;
    if(!parent){const cases:{id:string;caseNumber:string}[]=params?.caseId?[]:listCases(db);return <main className="analytics-case-choice"><h1>Аналитика материалов дела</h1><p>{params?.caseId?"Указанное дело недоступно. Общие данные вместо него не подставляются.":"Выберите дело. Карточки, граф и вопросы проверки будут построены по его документам."}</p>{cases.map(c=><p key={c.id}><a href={`/analytics?caseId=${c.id}`}>{c.caseNumber} →</a></p>)}<a href="/">Дела и документы</a><details><summary>Старые аналитические загрузки</summary><p>Сохранены отдельно. Не включаются в дело автоматически.</p><a href="/analytics?scope=legacy">Открыть общий архив</a></details></main>;}
    const currency=["KZT","USD","EUR","RUB","UNKNOWN"].includes(params.currency||"")?params.currency!:"KZT";
    return <div className="analytics-workspace"><AnalyticsWorkspace scope={{id:parent.id,number:parent.caseNumber,status:parent.status,currency}}/></div>;
  }finally{db.close();}
}
