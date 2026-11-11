// Local, versioned rules. Document text is data, never executable instructions.
export const CLASSIFIER_VERSION="document-rules-1.7";
const normalize=s=>String(s||"").normalize("NFKC").toLocaleLowerCase("ru").replace(/ё/g,"е").replace(/\s+/g," ").trim();
const rules=[
  ["tax","tax_account_statement",/выписк[а-я]*\s+из\s+лицевого\s+сч[её]та\s+налогоплательщика/u,"Выписка из налогового лицевого счёта"],
  ["correspondence","cover_letter",/сопроводительн\p{L}*\s+письм|направля[ею]м.{0,100}(материал|информаци|документ)|направляет.{0,100}(материал|информаци|документ)|қосымшаға сәйкес ақпарат жолдайды/u,"Направление информации или материалов"],
  ["correspondence","response",/ответ\s+на\s+(ваш\s+)?запрос|в\s+ответ\s+на\s+(ваш\s+)?(запрос|письмо)/u,"Ответ на запрос"],
  ["correspondence","request",/^(?:запрос|сұрау салу)(?:\s|$)|просим\s+(вас\s+)?предоставить.{0,100}(сведени|документ|информаци)/u,"Запрос сведений"],
  ["correspondence","explanation",/^(?:письменные\s+пояснения|пояснительное\s+письмо|объяснительная\s+записка|түсіндірме\s+хат)(?:\s|$)/u,"Письменные пояснения"],
  ["bank","statement",/выписка\s+(по|из)\s+(банковскому\s+)?счет|выписка\s+по\s+(?:лицевому|карт|карточному)\s+счет/u,"Выписка по счёту"],
  ["bank","payment_order",/платежное\s+поручение/u,"Платёжное поручение"],
  ["bank","receipt",/квитанция\s+(об?\s+оплате|к\s+приходному|о\s+приеме)/u,"Квитанция об оплате"],
  ["contract","addendum",/дополнительное\s+соглашение/u,"Дополнительное соглашение"],
  ["contract","specification",/^(?:спецификация)(?:\s|$)/u,"Спецификация"],
  ["contract","agreement",/^(?:договор|контракт)\s+(?:№|n\b|[0-9]|аренды|поставки|купли|оказания|на\s|подряда|займа)/u,"Заголовок договора"],
  ["contract","supply_agreement",/^договор\s+поставки(?:\s|$)/u,"Договор поставки"],
  ["contract","work_contract",/^договор\s+подряда(?:\s|$)/u,"Договор подряда"],
  ["primary","invoice",/электронн\p{L}*\s+счет[ -]?фактур|^(?:счет[ -]?фактура)(?:\s|$)/u,"Счёт-фактура / ЭСФ"],
  ["primary","delivery_note",/накладная\s+(на\s+отпуск|на\s+передачу|на\s+возврат|товарная)|товарная\s+накладная/u,"Накладная"],
  ["primary","completion_act",/акт\s+(выполненных\s+работ|оказанных\s+услуг)/u,"Акт выполнения / услуг"],
  ["primary","acceptance_act",/акт\s+приема[ -]передачи/u,"Акт приёма-передачи"],
  ["accounting","trial_balance",/оборотно[ -]сальдовая\s+ведомость/u,"Оборотно-сальдовая ведомость"],
  ["accounting","register",/^(?:регистр\s+(бухгалтерского\s+)?учета|карточка\s+счета)/u,"Регистр учёта"],
  ["accounting","cash",/(приходный|расходный)\s+кассовый\s+ордер|кассовая\s+книга/u,"Кассовый документ"],
  ["accounting","inventory",/инвентаризационная\s+опись|акт\s+инвентаризации|сличительная\s+ведомость/u,"Материал инвентаризации"],
  ["accounting","reconciliation_act",/^акт\s+сверки(?:\s|$)/u,"Акт сверки взаиморасчётов"],
  ["tax","declaration",/^(?:налоговая\s+декларация|декларация\s+по\s|форма\s+(?:100|200|300)\.00)/u,"Декларация"],
  ["tax","obligations",/расчет\s+налоговых\s+обязательств/u,"Расчёт обязательств"],
  ["tax","tax_audit",/акт\s+налоговой\s+проверки/u,"Акт налоговой проверки"],
  ["tax","registration_data",/^регистрационные\s+данные\s+(?:юридического\s+лица|налогоплательщика|индивидуального\s+предпринимателя)/u,"Регистрационные данные"],
  ["expert","valuation",/отчет\s+об\s+оценке|отчет\s+оценщика/u,"Отчёт оценщика"],
  ["expert","revision",/акт\s+(документальной\s+)?ревизии/u,"Акт ревизии"],
  ["expert","specialist",/заключение\s+специалиста/u,"Заключение специалиста"],
  ["expert","expert_opinion",/заключение\s+эксперта/u,"Заключение эксперта"],
  ["victim","claimed_damage",/расчет\s+(заявленного\s+)?ущерба/u,"Расчёт заявленного ущерба"],
  ["victim","application",/заявление\s+потерпевшего/u,"Заявление потерпевшего"],
  ["reimbursement","refund",/подтверждение\s+возврата\s+(денег|денежных\s+средств)/u,"Документ возврата денег"],
  ["reimbursement","property_return",/акт\s+возврата\s+имущества/u,"Акт возврата имущества"],
  ["reimbursement","performance",/подтверждение\s+фактического\s+исполнения\s+обязательств/u,"Подтверждение исполнения"],
];
export function classifyDocument({name="",text="",tables=[]}={}){
  // Cover pages outrank the names of attachments mentioned in the body.
  const heading=normalize(text.slice(0,5000)),lines=text.slice(0,5000).split(/\r?\n/).map(normalize).filter(Boolean),filename=normalize(name.replace(/\.[a-z0-9]+$/i,"").replace(/_/g," ")),headers=normalize(tables.flatMap(t=>t.columns||[]).join(" | "));
  const candidates=[];
  const add=(groupId,typeId,score,evidence)=>{const current=candidates.find(c=>c.groupId===groupId&&c.typeId===typeId);if(current){current.score=Math.max(current.score,score);current.evidence.push(evidence);}else candidates.push({groupId,typeId,score,evidence:[evidence]});};
  const covering=rules.filter(([g,,re])=>g==="correspondence"&&(re.test(heading)||lines.some(line=>re.test(line))));
  if(covering.length){for(const [g,t,,label] of covering)add(g,t,100,label+" в тексте письма");}
  else {
    // NFKC changes «№» to «No». A numbered title on the first line is
    // a contract; a reference further down in an act is not.
    if(/^(?:договор|контракт)\s+(?:no\.?|n\.?)(?:\s+|(?=\d))[\p{L}\d]/u.test(lines[0]||""))
      add("contract","agreement",100,"Номер договора в первой строке документа");
    if(lines.slice(0,5).some(line=>/^(?:[^\s]{1,30}\s+)?счет\s*[-«"]?\s*фактур/u.test(line)))add("primary","invoice",100,"Заголовок счёта-фактуры в первых строках документа");
    // Form code AND a declaration heading must occur in the contents, not only in a filename.
    const taxForms=[...heading.matchAll(/(?<![\d.])(100|220|300)\.00(?!\d)/gu)].map(m=>m[1]);
    const specificTax=new Set(taxForms);
    if(/деклараци[яи]/u.test(heading)&&/(?:корпоративному\s+подоходному|индивидуальному\s+подоходному|налогу\s+на\s+добавленную\s+стоимость)/u.test(heading)){
      for(const form of specificTax)add("tax",`declaration_${form}`,110,`Код формы ${form}.00 и заголовок декларации в содержимом`);
    }
    const tableHeaders=tables.map(t=>normalize((t.columns||[]).join(" | ")));
    for(const table of tables){const m=table.mapping||{};
      if(m.number&&/эсф|invoice|registration_number|регистрационный/u.test(normalize(m.number))&&m.senderId&&m.recipientId&&(m.amount||m.lineAmount))add("primary","invoice",110,"Явный номер ЭСФ, стороны и денежные поля сопоставлены по заголовкам таблицы");
      if(m.date&&(m.debit||m.credit||m.signedAmount)&&(m.counterpartyId||m.counterpartyAccount||m.senderId&&m.recipientId))add("bank","statement",105,"По заголовкам определены дата, направление движения и идентификаторы сторон/контрагента");
    }
    if(tableHeaders.some(h=>/код огд/u.test(h)&&/иинбин|иин\/бин/u.test(h)&&/номер документа/u.test(h)&&/сумма нарушения/u.test(h)&&/статус документа/u.test(h)))add("tax","cameral_notices",115,"Столбцы реестра уведомлений: ОГД, налогоплательщик, номер и статус документа, сумма по уведомлению");
    if(tableHeaders.some(h=>/время действия/u.test(h)&&/тип действия/u.test(h)&&/тип пользователя/u.test(h)))add("bank","activity_log",115,"Столбцы журнала действий пользователей интернет-банка; это не выписка переводов");
    const equipment=tableHeaders.some(h=>/hashrate[\s,]*th/u.test(h)&&/потреблени/u.test(h)&&/(?:\bip\b|\btype\b)/u.test(h));
    const energy=tableHeaders.some(h=>/дата совершения оборота/u.test(h)&&/наименование тру/u.test(h)&&/кол-во|количество/u.test(h));
    const reward=tableHeaders.some(h=>/difficulty/u.test(h)&&/hashrate[\s,]*th/u.test(h)&&/ожидаемая\s*награда/u.test(h));
    if(equipment&&energy&&reward)add("expert","mining_calculation",115,"Совместно найдены таблицы оборудования, энергопотребления и ожидаемой награды майнинга");
    if(/(registration_number|регистрационный номер эсф|номер эсф)/u.test(headers)&&/(iin_seller|бин поставщика|иин\/бин поставщика|наименование поставщика)/u.test(headers)&&/(iin_customer|бин покупателя|бин получателя|наименование получателя)/u.test(headers))add("primary","invoice",110,"Набор столбцов ЭСФ: номер ЭСФ и обе стороны");
    if(/(дебет|деб\. оборот|списание|расход)/u.test(headers)&&/(кредит|кред\. оборот|зачисление|приход|поступления)/u.test(headers)&&/(дата операции|назначение платежа)/u.test(headers))add("bank","statement",105,"Столбцы банковской выписки: движения и реквизиты операций");
    if(/дата|\bdate\b/u.test(headers)&&/debit|credit|дебет|кредит|сумма со знаком|signed_amount|тип операции/u.test(headers)&&/контрагент|counterparty|счет владельца|owner_account/u.test(headers))add("bank","statement",105,"Дата, направление движения и реквизиты контрагента банковской выписки");
    for(const [g,t,re,label] of rules.filter(([g])=>g!=="correspondence")){
      if(g==="tax"&&t==="declaration"&&candidates.some(c=>c.groupId==="tax"&&c.typeId.startsWith("declaration_")))continue;
      if(re.test(heading)||lines.some(line=>re.test(line)))add(g,t,100,label+" в начале документа");
    }
  }
  // Filenames alone only produce suggestions, not an automatic assignment.
  for(const [g,t,re,label] of rules){if(re.test(filename))add(g,t,30,label+" в имени файла");}
  for(const match of filename.matchAll(/(?<![\d.])(100|220|300)\.00(?!\d)/gu))add("tax",`declaration_${match[1]}`,30,"Код формы только в имени файла — проверьте содержимое");
  if(/расчет\s+доходности/u.test(filename))add("expert","mining_calculation",30,"Название расчёта — проверьте содержание и назначение");
  if(/\b\d{12}\s+(приоб|реал)/u.test(filename)||/\d{12}.*(?:приоб|реал)/u.test(filename))add("primary","invoice",30,"Имя похоже на выгрузку приобретений / реализации; требуется проверить содержимое");
  // A specific contract heading refines the generic kind, but never suppresses another document kind.
  if(candidates.some(c=>c.groupId==="contract"&&["supply_agreement","work_contract"].includes(c.typeId)&&c.score>=100)){
    const generic=candidates.findIndex(c=>c.groupId==="contract"&&c.typeId==="agreement");if(generic!==-1)candidates.splice(generic,1);
  }
  candidates.sort((a,b)=>b.score-a.score||a.typeId.localeCompare(b.typeId));
  const strong=candidates.filter(c=>c.score>=100),first=candidates[0];
  const automatic=strong.length===1;
  return {version:CLASSIFIER_VERSION,status:automatic?"automatic":first?"review":"unclassified",groupId:automatic?first.groupId:"unclassified",typeId:automatic?first.typeId:"unclassified",candidates,evidence:automatic?first.evidence:[],explanation:automatic?"Распознано по явным признакам содержимого. Проверьте результат; это не подтверждение фактических операций.":first?"Признаки неоднозначны или есть только имя файла. Выберите вид вручную.":"Надёжных признаков вида нет. Документ сохранён без выдуманной классификации."};
}
