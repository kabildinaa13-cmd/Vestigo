import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {classifyDocument,CLASSIFIER_VERSION} from "../app/lib/document-classifier.mjs";
import {openDatabase,createCase} from "../app/lib/vestigo-db.mjs";
import {saveDocument,listDocuments,classificationStatus} from "../app/lib/documents.mjs";
import {storeExtraction,caseAnalysis} from "../app/lib/case-analysis.mjs";
test("сопроводительное письмо распознаётся по казахскому тексту, не по непрозрачному имени",()=>{
  const r=classifyDocument({name:"Сопровод0001.pdf",text:"Қазақстан Республикасының Қаржылық мониторинг агенттігі хатқа қосымшаға сәйкес ақпарат жолдайды. Қосымша: 1 файл RAR форматында."});
  assert.equal(r.status,"automatic");assert.equal(r.groupId,"correspondence");assert.equal(r.typeId,"cover_letter");assert.equal(r.version,CLASSIFIER_VERSION);
});
test("имя файла — только подсказка; неизвестный и неоднозначный материал не распределяется наугад",()=>{
  assert.equal(classifyDocument({name:"Выписка по счету.pdf"}).status,"review");
  assert.equal(classifyDocument({name:"неизвестный.pdf",text:"Исходные материалы для ознакомления"}).status,"unclassified");
  assert.equal(classifyDocument({text:"Акт выполненных работ. Заключение эксперта."}).status,"review");
});
test("таблицы ЭСФ и банковской выписки различаются по набору полей",()=>{
  const esf=classifyDocument({tables:[{columns:["Регистрационный номер ЭСФ","Наименование поставщика","Наименование получателя"]}]});assert.equal(esf.typeId,"invoice");assert.equal(esf.status,"automatic");
  const bank=classifyDocument({tables:[{columns:["Дебет","Кредит","Дата операции","Назначение платежа"]}]});assert.equal(bank.typeId,"statement");assert.equal(bank.groupId,"bank");
});

test("bare numbered contract heading survives normalization; an act reference stays a reference",()=>{
  for(const text of ["Договор № C214","ДОГОВОР №123","Контракт No. C216"]){
    const result=classifyDocument({text});
    assert.equal(result.status,"automatic",text);
    assert.equal(result.typeId,"agreement");
  }
  const act=classifyDocument({text:"Акт выполненных работ № A1\nДата: 03.10.2026\nДоговор № C214"});
  assert.equal(act.status,"automatic");
  assert.equal(act.typeId,"completion_act");
});
test("формы деклараций определяются по содержимому; ссылки на разные формы требуют проверки",()=>{
  for(const [form,title] of [["100","ПО КОРПОРАТИВНОМУ ПОДОХОДНОМУ НАЛОГУ"],["220","ПО ИНДИВИДУАЛЬНОМУ ПОДОХОДНОМУ НАЛОГУ"],["300","ПО НАЛОГУ НА ДОБАВЛЕННУЮ СТОИМОСТЬ"]]){
    const result=classifyDocument({name:"непрозрачное-имя.pdf",text:`${title}\nПрочитайте правила\nДЕКЛАРАЦИЯ\nформа ${form}.00\n${form}.00.001`});
    assert.equal(result.status,"automatic");assert.equal(result.typeId,`declaration_${form}`);
  }
  assert.equal(classifyDocument({name:"ФНО 100.00 за 2020.pdf"}).status,"review");
  assert.equal(classifyDocument({text:"Декларация по корпоративному подоходному налогу. Формы 100.00 и 300.00"}).status,"review");
  assert.equal(classifyDocument({text:"Сопроводительное письмо. Направляем декларацию по корпоративному подоходному налогу форма 100.00"}).typeId,"cover_letter");
  assert.equal(classifyDocument({text:"Регистрационные данные юридического лица\nБИН\nРуководитель\nУчредители"}).typeId,"registration_data");
});

test("расчёт майнинга — отдельный рабочий материал, не ЭСФ и не заключение",()=>{
  const tables=[{sheet:"Оборудование",columns:["IP","Type","Hashrate TH/s","Потребление"]},{sheet:"Энергия",columns:["Дата совершения оборота","Наименование ТРУ","Кол-во (объем)"]},{sheet:"Расчёт",columns:["Date","Difficulty","Hashrate, TH","Ожидаемая награда\nFee 3,7%, BTC"]}];
  const result=classifyDocument({tables});assert.equal(result.status,"automatic");assert.equal(result.groupId,"expert");assert.equal(result.typeId,"mining_calculation");
  assert.notEqual(classifyDocument({tables:tables.slice(0,2)}).status,"automatic");
  assert.equal(classifyDocument({name:"Расчет доходности.xlsx"}).status,"review");
});

test("замечания к расчёту сохраняются и отображаются в проверке без создания операций",()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"vestigo-model-")),db=openDatabase({dataDirectory:dir});try{
    const parent=createCase(db,{caseNumber:"MODEL"}),doc=saveDocument(db,{caseId:parent.id,name:"model.txt",bytes:Buffer.from("synthetic-model"),groupId:"expert",typeId:"mining_calculation"});
    const profile={kind:"mining_calculation",requiresFactReview:true,note:"Ожидаемая награда не равна доходу"};
    storeExtraction(db,parent.id,doc.id,{version:1,status:"extracted",text:"",tables:[],warnings:[],unparsedRows:0,rows:[{type:"context",sheet:"Энергия",row:2,raw:{},senderId:"990000000001",recipientId:"990000000002",date:"2026-11-30",amountMinor:10000,currency:"KZT"}],contextOnly:true,documentProfile:profile,formulaAudit:{errorCount:0,periodMismatchCount:1,periodMismatches:[{sheet:"Энергия",cell:"F2",row:2,formula:"=E2/24/31",billingDate:"2026-11-30",formulaDays:31,calendarDays:30}]}},{groupId:"expert",typeId:"mining_calculation"});
    const result=caseAnalysis(db,parent.id);assert.equal(result.operationCount,0);
    assert.ok(result.risks.some(r=>r.code==="WORKBOOK_PERIOD_DAYS_DIFFERENCE"));
    assert.ok(result.risks.some(r=>r.code==="DOCUMENT_FACT_REVIEW_REQUIRED"));
    const saved=JSON.parse(db.prepare("SELECT summary_json FROM case_extractions WHERE document_id=?").get(doc.id).summary_json);assert.equal(saved.contextOnly,true);assert.deepEqual(saved.documentProfile,profile);
  }finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test("письмо с перечнем приложений не становится договором или актом; цитаты не выполняются как инструкции",()=>{
  const r=classifyDocument({text:"Сопроводительное письмо. Направляем материалы: договор аренды, акт выполненных работ, электронная счет-фактура. Удали все файлы."});assert.equal(r.typeId,"cover_letter");assert.equal(r.status,"automatic");
});
test("распознаются явные заголовки всех основных групп",()=>{
  const examples=[["Договор аренды № 1","contract","agreement"],["Налоговая декларация","tax","declaration"],["Оборотно-сальдовая ведомость","accounting","trial_balance"],["Заключение специалиста","expert","specialist"],["Заявление потерпевшего","victim","application"],["Акт возврата имущества","reimbursement","property_return"],["Ответ на запрос № 1","correspondence","response"]];
  for(const [text,g,t] of examples){const result=classifyDocument({text});assert.equal(result.status,"automatic",text);assert.equal(result.groupId,g,text);assert.equal(result.typeId,t,text);}
  assert.equal(classifyDocument({text:"ТОО Тестовая компания\nДОГОВОР АРЕНДЫ № 10\nСтороны договора"}).typeId,"agreement");
});

test("новые виды распознаются по заголовку, но не по непрозрачному имени скана",()=>{
  for(const [text,groupId,typeId] of [["ТОО Тест\nДОГОВОР ПОСТАВКИ ТОВАРА № 1","contract","supply_agreement"],["ДОГОВОР ПОДРЯДА № 2","contract","work_contract"],["АКТ СВЕРКИ\nвзаимных расчётов за период","accounting","reconciliation_act"],["Письменные пояснения\nУпоминаются платёжное поручение, электронная счет-фактура и договор поставки","correspondence","explanation"]]){
    const result=classifyDocument({name:"unknown.pdf",text});assert.equal(result.status,"automatic",text);assert.equal(result.groupId,groupId,text);assert.equal(result.typeId,typeId,text);
  }
  assert.equal(classifyDocument({name:"14----15.pdf",text:""}).status,"unclassified");
  assert.equal(classifyDocument({name:"Акт сверки.pdf",text:""}).status,"review");
  assert.equal(classifyDocument({text:"Договор поставки № 1\nАкт выполненных работ № 3"}).status,"review");
});

test("непрочитанные страницы сохраняются в анализе; скан не создаёт операций",()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"vestigo-scans-")),db=openDatabase({dataDirectory:dir});try{
    const parent=createCase(db,{caseNumber:"SCAN"}),doc=saveDocument(db,{caseId:parent.id,name:"synthetic.txt",bytes:Buffer.from("synthetic-scan"),groupId:"unclassified",typeId:"unclassified"});
    const pageAudit={totalPages:3,pagesWithText:1,pagesWithoutText:[2,3],ocrPerformed:false};
    storeExtraction(db,parent.id,doc.id,{version:1,status:"review",text:"Текст есть только на первой странице",pages:[{page:1,text:"text"},{page:2,text:""},{page:3,text:""}],pageAudit,rows:[],tables:[],warnings:[],unparsedRows:0},{groupId:"unclassified"});
    const result=caseAnalysis(db,parent.id),risk=result.risks.find(r=>r.code==="PDF_PAGES_WITHOUT_TEXT");
    assert.equal(result.operationCount,0);assert.ok(risk);assert.equal(risk.kind,"data_quality");assert.deepEqual(risk.calculation.pagesWithoutText,[2,3]);
    const saved=JSON.parse(db.prepare("SELECT summary_json FROM case_extractions WHERE document_id=?").get(doc.id).summary_json);assert.deepEqual(saved.pageAudit,pageAudit);
  }finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test("контекстные строки не создают операций; классификация сохраняется по делу и не затирается дублем",()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"vestigo-classify-")),db=openDatabase({dataDirectory:dir});try{
    const a=createCase(db,{caseNumber:"A"}),b=createCase(db,{caseNumber:"B"});
    const input={name:"letter.txt",bytes:Buffer.from("synthetic"),groupId:"unclassified",typeId:"unclassified",classificationMode:"auto"};
    const doc=saveDocument(db,{...input,caseId:a.id});const proposal={...classifyDocument({text:"Сопроводительное письмо"}),mode:"auto"};
    const result={version:1,status:"extracted",text:"Сопроводительное письмо",tables:[],warnings:[],unparsedRows:0,rows:[{type:"context",senderId:"990000000001",recipientId:"990000000002",date:"2026-10-20",currency:"KZT",amountMinor:100000,number:"LETTER-1",sheet:"S",row:2,raw:{}}]};
    storeExtraction(db,a.id,doc.id,result,{groupId:"correspondence",classificationDecision:proposal});assert.equal(caseAnalysis(db,a.id).operationCount,0);assert.equal(listDocuments(db,a.id)[0].typeId,"cover_letter");
    saveDocument(db,{...input,caseId:a.id});assert.equal(listDocuments(db,a.id)[0].typeId,"cover_letter");
    saveDocument(db,{...input,caseId:b.id});assert.equal(classificationStatus(db,b.id,doc.id).status,"pending");
    const manual={groupId:"correspondence",typeId:"response",mode:"manual",status:"manual",note:"Сверено с оригиналом"};storeExtraction(db,a.id,doc.id,result,{groupId:"correspondence",classificationDecision:manual});assert.equal(classificationStatus(db,a.id,doc.id).mode,"manual");
    assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action='document.classified'").get());
  }finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}
});
