import {openDatabase,getCase} from "./vestigo-db.mjs";
import {caseAnalysis} from "./case-analysis.mjs";
import {isPartyKey,partyLabel,bankEntryKind,bankPaymentClass,canonicalBankSourceRows} from "./bank-identities.mjs";
import {filterGraphOperations,esfSummary,esfDiagnostics} from "./esf-graph.mjs";
import {markDirectedCycles} from "./directed-cycles.mjs";
import {buildBankLedger} from './bank-analysis.mjs';
import {canonicalBankTransfers} from './financial-flows.mjs';
import {financialReport} from './financial-profile.mjs';
import {graphCoverage} from './graph-coverage.mjs';
const typeLabels={invoice:"ЭСФ",payment:"Платёж",contract:"Договор",primary:"Документ исполнения",accounting:"Учёт",claim:"Требование",reimbursement:"Возврат"};
const clean=v=>String(v??"").toLocaleLowerCase("ru").replace(/ё/g,"е");
export function caseAnalyticsDataset(db,caseId,currency="KZT",filters={}){
  const parent=getCase(db,caseId);if(!parent)throw new Error("Дело не найдено");
  const analysis=caseAnalysis(db,caseId,{all:true,skipChains:true});
  const activeRisks=analysis.risks.filter(r=>!["closed","rejected"].includes(r.status));
  const operations=analysis.operations.filter(o=>o.reviewStatus!=="rejected");
  const risksBySource=new Map(),sourceKey=s=>s.row?`${s.documentId}:${s.sheet}:${s.row}`:s.documentId;
  for(const risk of activeRisks)for(const s of risk.evidence){const key=sourceKey(s);if(!risksBySource.has(key))risksBySource.set(key,new Map());risksBySource.get(key).set(risk.id,risk);}
  const sourceRisks=s=>[...(risksBySource.get(s.documentId)?.values()||[]),...(s.row?risksBySource.get(sourceKey(s))?.values()||[]:[])];
  const rows=canonicalBankSourceRows(db.prepare(`SELECT r.*,d.original_name FROM case_extracted_rows r JOIN documents d ON d.id=r.document_id WHERE r.case_id=? AND NOT EXISTS(SELECT 1 FROM case_document_exclusions z WHERE z.case_id=r.case_id AND z.document_id=r.document_id) ORDER BY r.document_id,r.sheet,r.row_number`).all(caseId));
  const byBin=new Map();
  function participant(bin,name){
    if(!isPartyKey(bin))return null;
    if(!byBin.has(bin))byBin.set(bin,{id:bin,bin,name:name||partyLabel(bin),rnn:"",taxpayerFio:"",head:"",headIin:"",headRnn:"",city:"Не указан",categories:[],categoryCodes:["LOCAL_EVIDENCE"],documents:[],sourceDate:parent.updatedAt,risk:0,level:"Низкий",signals:0,connections:0,status:"Участник материалов дела",reason:"",operations:[],riskMap:new Map(),neighbors:new Set()});
    const e=byBin.get(bin);if(name&&(e.name.startsWith("БИН/ИИН")||e.name.startsWith("IBAN ")))e.name=name;return e;
  }
  // Identified parties in incomplete rows remain searchable, without inventing a transaction.
  for(const r of rows){const row=JSON.parse(r.record_json);if(row.type==="context"&&!Object.keys(row.attributes?.fieldEvidence||{}).length)continue;const s={documentId:r.document_id,sheet:r.sheet,row:r.row_number};for(const [bin,name] of [[row.senderId,row.senderName],[row.recipientId,row.recipientName]]){const e=participant(bin,name);if(e)for(const risk of sourceRisks(s))e.riskMap.set(risk.id,risk);}}
  for(const o of operations)for(const [bin,name] of [[o.senderId,o.senderName],[o.recipientId,o.recipientName]]){
    const e=participant(bin,name);if(!e)continue;
    e.operations.push(o);for(const s of o.sources)for(const risk of sourceRisks(s))e.riskMap.set(risk.id,risk);
    e.neighbors.add(o.senderId===bin?o.recipientId:o.senderId);e.categories.push(typeLabels[o.type]||o.type);
  }
  const entities=[...byBin.values()].map(e=>{
    const list=[...e.riskMap.values()],high=list.some(r=>r.severity==="high"),medium=list.some(r=>r.severity==="medium");
    return {...e,categories:[...new Set(e.categories)],documents:[...new Map(e.operations.flatMap(o=>o.sources.map(s=>[s.documentId,{category:typeLabels[o.type]||o.type,number:s.name,date:o.date}]))).values()],risk:high?75:medium?50:0,level:high?"Высокий":medium?"Средний":"Низкий",signals:list.length,connections:e.neighbors.size,status:list.length?"Есть вопросы проверки":"Нет открытых сигналов реализованных правил",reason:list.map(r=>r.description).join("; "),operations:undefined,riskMap:undefined,neighbors:undefined};
  });
  const entityMap=new Map(entities.map(e=>[e.bin,e]));
  const edgeMap=new Map();
  // Only one monetary layer and currency at a time: no addition of invoice + payment amounts.
  // Read-only presentation of the SAME canonical transfers used by the bank ledger.
  // Opposite statement perspectives must not become two transfers in this map.
  const bankLedger=buildBankLedger(rows.map(r=>({row:JSON.parse(r.record_json),source:{documentId:r.document_id,name:r.original_name,sheet:r.sheet,row:r.row_number}})),operations,analysis.matches);
  const bankTransfers=canonicalBankTransfers(bankLedger.entries).map(e=>({...e,type:'payment',number:e.transactionId,amountMinor:Number(e.amountMinor),reviewStatus:'extracted',bank:{kind:e.kind,senderAccount:e.senderAccount,recipientAccount:e.recipientAccount,transactionId:e.explicitTransactionId},bankTransfer:e}));
  const ledgerOperations=new Set(bankLedger.entries.map(e=>e.operationId).filter(Boolean));
  const otherOperations=operations.filter(o=>o.type!=='payment'||['fee','fee_refund'].includes(bankEntryKind(o))||!o.bank&&!ledgerOperations.has(o.id));
  const graphOperations=filterGraphOperations([...otherOperations,...bankTransfers],currency,filters);
  for(const o of graphOperations){
    const layer=o.type==="payment"?bankEntryKind(o):o.type,label=layer==="fee"?"Комиссия банка":layer==="fee_refund"?"Возврат комиссии":layer==="refund"?"Возврат оплаты":typeLabels[o.type]||o.type;
    const key=`${o.senderId}|${o.recipientId}|${layer}`,e=edgeMap.get(key)||{id:key,from:o.senderId,to:o.recipientId,amount:0,vat:0,dealAmount:0,invoiceMinor:0n,paymentMinor:0n,operations:0,years:new Set(),goods:[],sources:new Set(),relations:[label],descriptions:new Set(),contracts:new Set(),paymentPurposes:new Set(),dates:new Set(),comments:new Set(),cycle:false,attributes:{currency,bankKind:layer,accounts:new Set(),transactionIds:new Set(),operationIds:[],riskIds:new Set(),evidence:[]}};
    // Mixed record types are separate edges; the graph does not expose their sum as income.
    if(!o.conflict&&o.type==="invoice")e.invoiceMinor+=BigInt(o.amountMinor);
    if(!o.conflict&&o.type==="payment")e.paymentMinor+=BigInt(o.amountMinor);
    if(o.bank){for(const a of [o.bank.senderAccount,o.bank.recipientAccount])if(a)e.attributes.accounts.add(a);if(o.bank.transactionId)e.attributes.transactionIds.add(o.bank.transactionId);}
    e.operations++;e.years.add(Number(o.date.slice(0,4)));e.dates.add(o.date);e.descriptions.add(o.purpose||typeLabels[o.type]);
    if(o.type==="invoice"){
      e.relations=["ЭСФ","Реализация ТРУ по ЭСФ"];e.attributes.relationType="Реализация ТРУ по ЭСФ";
if(!e.invoices)e.invoices=[];e.invoices.push({id:o.id,number:o.number,senderId:o.senderId,senderName:o.senderName,recipientId:o.recipientId,recipientName:o.recipientName,date:o.date,issueDate:o.esf?.issueDate||o.date,amountMinor:o.amountMinor,currency:o.currency,conflict:o.conflict,revision:o.esf?.revision||null,sources:o.sources,goods:o.esf?.goods||[]});
      for(const g of o.esf?.goods||[]){e.goods.push({...g,amount:(g.lineAmountMinor||0)/100});if(g.contractRef)e.contracts.add(g.contractRef);}
      if(o.esf?.revision?.note)e.comments.add(o.esf.revision.note);
    }
    if(o.type==="payment"){
      e.paymentPurposes.add(o.purpose);
      if(!e.bankTransfers)e.bankTransfers=[];
      e.bankTransfers.push(o.bankTransfer||{id:o.id,transactionId:o.number,date:o.date,senderId:o.senderId,recipientId:o.recipientId,senderName:o.senderName,recipientName:o.recipientName,amountMinor:String(o.amountMinor),currency:o.currency,purpose:o.purpose,kind:layer,sources:o.sources});
    }
    if(o.type==="contract")e.contracts.add(o.number);
    e.attributes.operationIds.push(o.id);for(const s of o.sources){e.sources.add(s.name);e.attributes.evidence.push(s);for(const r of sourceRisks(s))e.attributes.riskIds.add(r.id);}
    if(o.conflict)e.comments.add("Конфликтующие реквизиты: сумма не агрегирована");if(o.automaticSource&&!o.confirmed)e.comments.add("Автоматически извлечённые предварительные реквизиты; операция не подтверждена");edgeMap.set(key,e);
  }
  for(const edge of edgeMap.values()){
    edge.years=new Set([...edge.years].sort((a,b)=>a-b));
    edge.dates=new Set([...edge.dates].sort());
  }
  const edges=[...edgeMap.values()].map(({invoiceMinor,paymentMinor,...e})=>{const safe=invoiceMinor<=BigInt(Number.MAX_SAFE_INTEGER)&&paymentMinor<=BigInt(Number.MAX_SAFE_INTEGER)&&invoiceMinor>=BigInt(Number.MIN_SAFE_INTEGER)&&paymentMinor>=BigInt(Number.MIN_SAFE_INTEGER);if(!safe)e.comments.add("Итог превышает точность отображения: см. отдельные операции");return {...e,amount:safe?Number(invoiceMinor)/100:0,dealAmount:safe?Number(paymentMinor)/100:0,years:[...e.years],sources:[...e.sources],descriptions:[...e.descriptions],contracts:[...e.contracts],paymentPurposes:[...e.paymentPurposes],dates:[...e.dates],comments:[...e.comments],attributes:{...e.attributes,accounts:[...e.attributes.accounts],transactionIds:[...e.attributes.transactionIds],invoiceMinor:invoiceMinor.toString(),paymentMinor:paymentMinor.toString(),sumDisplayAvailable:safe,riskIds:[...e.attributes.riskIds]}};});
  const nodes=entities.map(e=>({...e,address:"",knownObject:true,levelIndex:0,attributes:{caseId,identifierKind:e.bin.startsWith("IBAN:")?"account":"bin_iin",openRiskIds:[...byBin.get(e.bin).riskMap.keys()]}}));
  const records=rows.map(r=>{const record=JSON.parse(r.record_json);return {id:`${r.document_id}:${r.sheet}:${r.row_number}`,fileName:r.original_name,bins:[...new Set([record.senderId,record.recipientId].filter(Boolean))],fields:record.raw,documentId:r.document_id,sheet:r.sheet,row:r.row_number};});
  const relations=edges.map(e=>({objectBin:e.from,objectName:entityMap.get(e.from)?.name||e.from,objectRole:e.relations[0]==="Платёж"?"Отправитель":"Поставщик / сторона 1",counterpartyBin:e.to,counterpartyName:entityMap.get(e.to)?.name||e.to,counterpartyRole:e.relations[0]==="Платёж"?"Получатель":"Покупатель / сторона 2",relationType:e.relations[0],operations:e.operations,files:e.sources,confidence:1,recognitionRule:"Реквизиты материалов выбранного дела; требуется проверка источников"}));
  const diagnostics=esfDiagnostics(rows,operations,graphOperations,nodes,edges,analysis.documents);
  return {parent,analysis,entities,entityMap,nodes,edges,records,relations,activeRisks,currency,graphOperations,diagnostics,bankLedger};
}
export function flowPayload(data,params,db){
  const bin=params.get("bin")||"",root=data.nodes.find(n=>n.bin===bin)||null;
  if(!root)return {root:null,nodes:[],edges:[],audit:{totalNodes:data.nodes.length,totalEdges:data.edges.length,shownNodes:0,shownEdges:0,directTotal:0,scope:"all",depth:0,diagnostics:data.diagnostics},rule:"Выбранный БИН отсутствует в прочитанных материалах этого дела. Выберите организацию из объектов дела; узел по догадке не создаётся."};
  const depth=Math.min(8,Math.max(1,Number(params.get("depth"))||3)),levels=new Map([[bin,0]]),distances=new Map([[bin,0]]),adjacency=new Map();
  for(const edge of data.edges){for(const id of [edge.from,edge.to]){if(!adjacency.has(id))adjacency.set(id,[]);adjacency.get(id).push(edge);}}
  const queue=[bin];for(let i=0;i<queue.length;i++){const current=queue[i],level=levels.get(current),distance=distances.get(current);if(distance>=depth)continue;
    for(const edge of adjacency.get(current)||[]){const to=edge.from===current?edge.to:edge.from;if(!levels.has(to)){levels.set(to,level+(edge.from===current?1:-1));distances.set(to,distance+1);queue.push(to);}}}
  const nodes=data.nodes.filter(n=>levels.has(n.bin)).map(n=>({...n,levelIndex:levels.get(n.bin)}));
  const edges=data.edges.filter(e=>levels.has(e.from)&&levels.has(e.to));
  // A supply A->B and a payment B->A are NOT a cycle of money.
  const cycleLayer=e=>['transfer','refund'].includes(e.attributes.bankKind)?'bank':e.attributes.bankKind;
  const cycles=new Set();for(const layer of new Set(edges.map(cycleLayer)))for(const e of markDirectedCycles(edges.filter(e=>cycleLayer(e)===layer)))if(e.cycle)cycles.add(e.id);
  for(const e of edges)e.cycle=cycles.has(e.id);
  let financial;
  if(db){
    const report=financialReport(db,data.parent.id,{currency:data.currency,from:params.get('from')||'',to:params.get('to')||''});
    const shownBank=e=>filterGraphOperations([{...e,type:'payment'}],data.currency,Object.fromEntries(params)).length>0;
    report.bank=report.bank.filter(shownBank);
    const selected=new Set(edges.flatMap(e=>(e.invoices||[]).map(i=>i.id))),visible=new Set(nodes.map(n=>n.bin));
    report.invoices=report.invoices.filter(i=>selected.has(i.id));
    report.reconciliation.items=report.reconciliation.items.filter(i=>selected.has(i.invoice.id));
    report.reconciliation.candidates=report.reconciliation.candidates.filter(i=>selected.has(i.invoiceId));
    report.reconciliation.allocations=report.reconciliation.allocations.filter(i=>selected.has(i.invoiceId));
    report.reconciliation.payments=report.reconciliation.payments.filter(p=>(visible.has(p.senderId)||visible.has(p.recipientId))&&shownBank(p));
    const coverage=graphCoverage(report),issues=data.bankLedger.entries.filter(e=>shownBank(e)&&(e.missingFields.length||e.conflict));
    financial={...coverage,bankIncomplete:issues.length,bankMissingDate:issues.filter(e=>!e.dateValid).length,bankMissingParty:issues.filter(e=>!isPartyKey(e.senderId)||!isPartyKey(e.recipientId)).length};
  }
  return {root,nodes,edges,financial,esfSummary:esfSummary(data.graphOperations,bin,data.currency,data.entityMap),audit:{totalNodes:data.nodes.length,totalEdges:data.edges.length,shownNodes:nodes.length,shownEdges:edges.length,directTotal:adjacency.get(bin)?.length||0,scope:"all",depth,diagnostics:data.diagnostics},rule:`Только материалы дела ${data.parent.caseNumber}. Валюта ${data.currency}; ЭСФ — поставщик → покупатель, не денежный перевод. На схеме только связи из документов с учётом фильтров. Если продолжения цепочки нет в исходных данных, оно не добавляется.`,caseId:data.parent.id};
}
export function handleCaseAnalytics(request,kind){
  const url=new URL(request.url);if(!url.searchParams.has("caseId"))return null;
  const caseId=url.searchParams.get("caseId"),db=openDatabase();
  try{
    const params=url.searchParams,bin=params.get("bin")||"",data=caseAnalyticsDataset(db,caseId,params.get("currency")||"KZT",Object.fromEntries(params));
    let result;
    if(kind==="entities"){
      const words=clean(params.get("q")).split(/\s+/).filter(Boolean).map(w=>w.replace(/^(бин|иин|документ|статус|руководитель|рнн):/,""));
      const filtered=data.entities.filter(e=>words.every(w=>clean(JSON.stringify(e)).includes(w))&&(!params.get("risk")||params.get("risk")==="Все уровни"||e.level===params.get("risk"))&&(!params.get("category")||params.get("category")==="Все списки"||e.categoryCodes.includes(params.get("category"))));
      const limit=Math.min(200,Math.max(1,Number(params.get("limit"))||80)),page=Math.max(1,Number(params.get("page"))||1);
      result={entities:filtered.slice((page-1)*limit,page*limit),total:filtered.length,metrics:{entities:data.entities.length,highRisk:data.entities.filter(e=>e.level==="Высокий").length,needsReview:data.entities.filter(e=>e.signals>0).length,links:data.edges.length},sourceStats:[{code:"LOCAL_EVIDENCE",label:"Материалы дела",file:"Документы дела",rows:data.records.length,updated:data.parent.updatedAt,status:"complete"}],source:{name:`Дело ${data.parent.caseNumber}`,url:`/?caseId=${caseId}`,region:"Только документы выбранного дела",updated:data.parent.updatedAt,lastSync:data.parent.updatedAt,syncStatus:"local",syncFiles:data.analysis.documents.length}};
    }else if(kind==="imports"){
      const records=data.records.filter(r=>r.bins.includes(bin));result={records,total:records.length,relations:data.relations.filter(r=>r.objectBin===bin||r.counterpartyBin===bin),files:data.analysis.documents.map(d=>({name:d.name,rows:d.summary.rows||0})),entities:[],source:`Дело ${data.parent.caseNumber}`};
    }else if(kind==="flow")result=flowPayload(data,params,db);
    else if(kind==="chains"){
      const grouped=new Map(),adjacent=new Map();
      for(const e of data.edges){for(const [from,to] of [[e.from,e.to],[e.to,e.from]]){if(!adjacent.has(from))adjacent.set(from,new Set());adjacent.get(from).add(to);}if(e.from!==bin&&e.to!==bin)continue;
        const id=e.from===bin?e.to:e.from,n=data.entityMap.get(id),neighbor=grouped.get(id)||{bin:id,name:n?.name||id,head:n?.head||"",headIin:n?.headIin||"",knownObject:true,risk:n?.risk||0,level:n?.level||"Низкий",connections:n?.connections||0,operations:0,amount:0,sources:new Set(),relations:new Set()};
        neighbor.operations+=e.operations;for(const v of e.sources)neighbor.sources.add(v);for(const v of e.relations)neighbor.relations.add(v);grouped.set(id,neighbor);
      }
      const component=new Set(data.entityMap.has(bin)?[bin]:[]),queue=[...component];for(let i=0;i<queue.length;i++)for(const next of adjacent.get(queue[i])||[])if(!component.has(next)){component.add(next);queue.push(next);}
      const neighbors=[...grouped.values()].map(n=>({...n,sources:[...n.sources],relations:[...n.relations]}));
      result={node:data.entityMap.get(bin)||null,neighbors,componentSize:component.size,audit:{uniqueNodes:data.nodes.length,uniqueEdges:data.edges.length,duplicateDealsRemoved:0}};
    }else if(kind==="deals")result={deals:[],stats:{count:0,total:0,counterparties:0},source:{name:"Договоры и операции доступны в карточке дела",file:""}};
    else if(kind==="financials")result={entity:null,esfSummary:esfSummary(data.graphOperations,bin,data.currency,data.entityMap),caseOperations:data.analysis.operations.filter(o=>o.senderId===bin||o.recipientId===bin),generatedAt:data.parent.updatedAt,methodology:{esf:"Суммы по типам и валютам раздельно",declarations:"Только при сопоставимых исходных показателях",warning:"Не расчёт дохода или ущерба"},audit:{profiles:data.entities.length,uniqueEsfInvoices:data.analysis.operations.filter(o=>o.type==="invoice").length,sourceFiles:data.analysis.documents.length}};
    else if(kind==="leaders")result=params.get("iin")?{leader:null}:{leaders:[],total:0};
    else if(kind==="risks")result={caseId,risks:data.analysis.risks,leaders:[],counterpartyObjects:[],multiListObjects:[],summary:{leaders:0,maxLeaderObjects:0,highCounterpartyObjects:0,multiListObjects:0}};
    else return Response.json({error:"Неизвестный раздел аналитики дела"},{status:400});
    return Response.json(result,{headers:{"cache-control":"no-store"}});
  }catch(error){return Response.json({error:error.message||"Ошибка аналитики дела"},{status:error.status||404});}
  finally{db.close();}
}
