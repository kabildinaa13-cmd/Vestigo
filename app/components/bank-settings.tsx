"use client";
export type BankSettingsValue={ownerId:string;ownerAccount:string;defaultCurrency:string;bankFeeMode:string;bankYear?:string};
export const emptyBankSettings:BankSettingsValue={ownerId:"",ownerAccount:"",defaultCurrency:"",bankFeeMode:"unknown"};
export default function BankSettings({value,onChange,disabled}:{value:BankSettingsValue;onChange:(v:BankSettingsValue)=>void;disabled?:boolean}){
  return <details className="full bank-settings"><summary>Реквизиты банковской выписки — если их нет в файле</summary><p className="muted">Применяются к загружаемой пачке. Для разных владельцев загружайте файлы отдельно. Пустые поля определяются только из явных реквизитов документа.</p><div className="form-grid">
    <label>БИН/ИИН владельца счёта<input value={value.ownerId} maxLength={12} inputMode="numeric" disabled={disabled} onChange={e=>onChange({...value,ownerId:e.target.value.replace(/\D/g,"")})}/></label>
    <label>IBAN владельца счёта<input value={value.ownerAccount} maxLength={34} disabled={disabled} onChange={e=>onChange({...value,ownerAccount:e.target.value.replace(/\s/g,"").toUpperCase()})}/></label>
    <label>Год периода для дат ДД.ММ.ГГ, если не установлен по шапке<input value={value.bankYear||''} inputMode="numeric" maxLength={4} placeholder="Например, 2026 — подтвердите по оригиналу" disabled={disabled} onChange={e=>onChange({...value,bankYear:e.target.value.replace(/\D/g,'')})}/></label>
    <label>Валюта, если отсутствует в документе<select value={value.defaultCurrency} disabled={disabled} onChange={e=>onChange({...value,defaultCurrency:e.target.value})}><option value="">Не предполагать</option>{["KZT","USD","EUR","RUB"].map(v=><option key={v}>{v}</option>)}</select></label>
    <label>Комиссия в отдельном столбце<select value={value.bankFeeMode} disabled={disabled} onChange={e=>onChange({...value,bankFeeMode:e.target.value})}><option value="unknown">Неизвестно — не угадывать сумму перевода</option><option value="separate">Сумма перевода без комиссии; комиссия отдельно</option><option value="debit_includes_fee">Комиссия уже входит в сумму списания</option><option value="credit_after_fee">Зачисление показано за вычетом комиссии</option></select></label>
  </div></details>;
}
