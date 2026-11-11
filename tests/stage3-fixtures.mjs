// Synthetic identifiers/accounts only. Expected controls are explicit, not
// derived by the application under test.
export const A='990000000021',B='020000000022',C='990000000023',D='990000000024',BANK='990000000099';
export function account(n){const body=String(n).padStart(16,'0'),digits=body+'203500';return 'KZ'+String(98-Number(BigInt(digits)%97n)).padStart(2,'0')+body;}
export const accounts={[A]:account(1),[B]:account(2),[C]:account(3),[D]:account(4),[BANK]:account(99)},B2=account(12);
export const controls={purchaseKZT:'27000',purchaseEUR:'2000',saleKZT:'5000',bankIncomingB:'30000',bankOutgoingB:'27300',feesB:'150',refundIncomingB:'1000',uniqueTransfers:19,transferVolumeKZT:'81000',confirmedI1:'10000',confirmedI2:'5000',unpaidI2:'1000'};
const csv=(headers,rows)=>[headers,...rows].map(row=>row.map(v=>/[;"\r\n]/.test(String(v??''))?'"'+String(v??'').replaceAll('"','""')+'"':v??'').join(';')).join('\n');
const invoices=[['I1',A,B,'100','KZT'],['I2',A,B,'60','KZT'],['I3',A,B,'80','KZT'],['I4',A,B,'30','KZT'],['I5',A,B,'20','EUR'],['I6',B,C,'50','KZT']];
export const invoiceCSV=()=>csv(['Номер ЭСФ','Дата','БИН поставщика','БИН покупателя','Сумма с НДС','Валюта','Наименование товара','Стоимость строки','Номер договора'],invoices.map(([n,a,b,sum,cur])=>[n,'2026-10-01',a,b,sum,cur,'Синтетическая услуга',sum,'CON-'+n]));
export const supportCSV=()=>csv(['Номер документа','Дата','БИН отправителя','БИН получателя','Сумма','Валюта','Назначение платежа'],[['AUTH-I4','2026-09-20',D,B,'30','KZT','Соглашение об оплате I4 третьим лицом за покупателя']]);
export const bankEvents=[
 ['P1','2026-09-25',B,A,'60','Оплата I1'],['P2','2026-10-05',B,A,'40','Оплата I1'],['P3','2026-10-02',B,A,'20','Оплата I2'],['P4','2026-10-03',B,A,'30','Оплата I2'],['P5','2026-10-04',D,A,'30','Оплата I4 за покупателя'],
 ['REF','2026-10-06',A,B,'10','Возврат оплаты I1'],['LOAN','2026-10-01',A,B,'200','Выдача займа'],['TAX','2026-10-07',B,BANK,'10','Уплата налога'],['INTERNAL','2026-10-08',B,B,'15','Внутренний перевод между собственными счетами'],
 ['X','2026-10-10',A,B,'100','Оплата по обязательствам'],['Y','2026-10-11',B,C,'95','Оплата по обязательствам'],['Z','2026-10-12',C,D,'92','Оплата по обязательствам'],['R','2026-10-13',D,A,'90','Оплата по обязательствам'],
 ['REP1','2026-10-20',B,C,'5','Регулярный перевод'],['REP2','2026-10-21',B,C,'5','Регулярный перевод'],['REP3','2026-10-22',B,C,'5','Регулярный перевод'],
 ['H1','2026-07-01',B,C,'1','Историческая операция'],['H2','2026-08-01',B,C,'1','Историческая операция'],['H3','2026-09-01',B,C,'1','Историческая операция']
];
const bankHeaders=['Дата','БИН владельца счета','Счет владельца','БИН контрагента','Наименование контрагента','Счет контрагента','Счет отправителя','Счет получателя','Дебет','Кредит','Номер документа','ID транзакции','Назначение платежа','Валюта'];
export function bankCSV(mirror=false){
  const rows=(mirror?bankEvents.slice(0,1):bankEvents).map(([n,date,sender,recipient,sum,purpose])=>{const owner=mirror?recipient:sender,other=mirror?sender:recipient,to=n==='INTERNAL'?B2:accounts[recipient];return [date,owner,accounts[owner],other,'Синтетический контрагент',mirror?accounts[sender]:to,accounts[sender],to,mirror?'0':sum,mirror?sum:'0',n,'BANK-ID-'+n,purpose,'KZT'];});
  if(!mirror)rows.push(['2026-10-09',B,accounts[B],BANK,'Банк',accounts[BANK],accounts[B],accounts[BANK],'1.50','0','FEE','','Комиссия банка','KZT']);
  return csv(bankHeaders,rows);
}
