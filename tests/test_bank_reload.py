import sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from bank_parser import statement_context,bank_record,bank_service_row
from extract_case_document import infer
from financial_normalization import identifier,date,money

class ReloadBankTests(unittest.TestCase):
 def test_inline_bilingual_client_and_currency_do_not_use_bank_bin(self):
  rows=[['БИН - 990000000999'],['Выписка по лицевому счету'],['Клиент/Клиент: ТОО SYNTHETIC БСН/ЖСН 990000000001'],['Валютасы / Валюта: KZT']]
  c=statement_context('',[('Sheet',rows)],{},'990000000888',identifier)
  self.assertEqual(c['ownerId'],'990000000001');self.assertEqual(c['currency'],'KZT')
 def test_invalid_heading_iban_does_not_become_account_and_conflicts_block(self):
  rows=[['Выписка по счету KZ00125KZT5004100100 (USD) № 1'],['ТОО SYNTHETIC БИН 990000000001']]
  c=statement_context('',[('Sheet',rows)],{'ownerId':'990000000002'},'',identifier)
  self.assertEqual(c['ownerAccount'],'');self.assertTrue(c['issues'])
 def test_footer_service_labels_do_not_hide_dated_payment_purpose(self):
  headers=['Дата транзакции','Дебет','Кредит','Назначение платежа'];m=infer(headers,{})
  self.assertEqual(bank_service_row(['Исх. остаток с 01/01/2023','0','0',''],m,headers),'total')
  self.assertEqual(bank_service_row(['В нац. эквиваленте','0','0',''],m,headers),'total')
  self.assertEqual(bank_service_row(['2023-01-01','100','0','Входящий остаток по договору'],m,headers),'')
 def test_combined_accounts_do_not_take_twelve_digits_from_inside_twenty(self):
  headers=['Дата транзакции','Счет, наименование БИН/ИИН','Дебет','Кредит'];m=infer(headers,{})
  r=bank_record(dict(zip(headers,['01.01.2023','12345678901234567890 Treasury','100','0'])),m,{}, {'ownerId':'990000000001','ownerAccount':'','ownerName':'SYNTHETIC','currency':'KZT'},money,date,identifier)
  self.assertEqual(r['recipientId'],'');self.assertEqual(r['bank']['counterpartyAccountToken'],'12345678901234567890');self.assertEqual(r['bank']['unresolvedCounterpartyName'],'Treasury')

if __name__=='__main__':unittest.main()
