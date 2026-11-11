export const DOCUMENT_GROUPS = [
  { id: "unclassified", name: "Нераспределённые материалы", note: "Требуется определить вид; операции не создаются", types: [
    { id: "unclassified", name: "Вид пока не определён" },
    { id: "mixed_bundle", name: "Составной пакет — несколько документов в одном файле" },
    { id: "archive", name: "ZIP-архив — оригинал пакета документов" },
  ] },
  { id: "correspondence", name: "Служебная переписка", note: "Контекст и происхождение материалов, не подтверждение денежных операций", types: [
    { id: "request", name: "Запрос" },
    { id: "response", name: "Ответ на запрос" },
    { id: "cover_letter", name: "Сопроводительное письмо / направление материалов" },
    { id: "explanation", name: "Письменные пояснения организации / лица" },
  ] },
  { id: "bank", name: "Банковские документы", note: "", types: [
    { id: "activity_log", name: "Журнал действий интернет-банка — не выписка" },
    { id: "statement", name: "Выписка по счёту" },
    { id: "payment_order", name: "Платёжное поручение" },
    { id: "receipt", name: "Квитанция" },
  ] },
  { id: "contract", name: "Договорные документы", note: "", types: [
    { id: "agreement", name: "Договор" },
    { id: "supply_agreement", name: "Договор поставки" },
    { id: "work_contract", name: "Договор подряда" },
    { id: "addendum", name: "Дополнительное соглашение" },
    { id: "specification", name: "Спецификация" },
  ] },
  { id: "primary", name: "Первичные учётные документы", note: "", types: [
    { id: "delivery_note", name: "Накладная" },
    { id: "invoice", name: "Счёт-фактура / ЭСФ" },
    { id: "completion_act", name: "Акт выполненных работ" },
    { id: "acceptance_act", name: "Акт приёма-передачи" },
  ] },
  { id: "accounting", name: "Бухгалтерские материалы", note: "", types: [
    { id: "register", name: "Регистр учёта" },
    { id: "trial_balance", name: "Оборотно-сальдовая ведомость" },
    { id: "cash", name: "Кассовый документ" },
    { id: "inventory", name: "Материал инвентаризации" },
    { id: "reconciliation_act", name: "Акт сверки взаиморасчётов" },
  ] },
  { id: "tax", name: "Налоговые документы", note: "Для соответствующих расчётов", types: [
    { id: "cameral_notices", name: "Реестр уведомлений камерального контроля" },
    { id: "declaration", name: "Декларация" },
    { id: "declaration_100", name: "Декларация 100.00 — корпоративный подоходный налог" },
    { id: "declaration_220", name: "Декларация 220.00 — индивидуальный подоходный налог" },
    { id: "declaration_300", name: "Декларация 300.00 — НДС" },
    { id: "registration_data", name: "Регистрационные данные налогоплательщика" },
    { id: "tax_account_statement", name: "Выписка из лицевого счёта налогоплательщика" },
    { id: "obligations", name: "Расчёт обязательств" },
    { id: "tax_audit", name: "Акт налоговой проверки" },
  ] },
  { id: "expert", name: "Материалы об оценке и исследованиях", note: "При наличии", types: [
    { id: "valuation", name: "Отчёт оценщика" },
    { id: "revision", name: "Акт ревизии" },
    { id: "specialist", name: "Заключение специалиста" },
    { id: "expert_opinion", name: "Заключение эксперта" },
    { id: "mining_calculation", name: "Рабочий расчёт доходности майнинга (не заключение)" },
  ] },
  { id: "victim", name: "Документы потерпевших", note: "", types: [
    { id: "application", name: "Заявление" },
    { id: "claimed_damage", name: "Расчёт заявленного ущерба" },
    { id: "supporting", name: "Подтверждающий материал" },
  ] },
  { id: "reimbursement", name: "Документы о возмещении", note: "", types: [
    { id: "refund", name: "Подтверждение возврата денег" },
    { id: "property_return", name: "Акт возврата имущества" },
    { id: "performance", name: "Документ о фактическом исполнении обязательств" },
  ] },
].map((group) => ({ ...group, types: [...group.types, { id: "other", name: "Другой документ этой группы" }] }));

export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
export const DOCUMENT_ACCEPT = ".pdf,.docx,.xlsx,.xls,.csv,.xml,.json,.txt,.jpg,.jpeg,.png,.tif,.tiff,.zip";

export function documentType(groupId, typeId) {
  const group = DOCUMENT_GROUPS.find((item) => item.id === groupId);
  const type = group?.types.find((item) => item.id === typeId);
  return group && type ? { group, type } : null;
}
