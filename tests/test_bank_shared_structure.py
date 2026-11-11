import sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from extract_case_document import infer
from bank_parser import statement_context,bank_date
from financial_normalization import identifier,date

class SharedBankStructure(unittest.TestCase):
    def test_bilingual_exact_headers_and_invoice_priority(self):
        h=['Күні / Дата','Құжат № /№ Документа','Валютасы /Валюта','Корресп. Есепшоты / Счет-корреспондент','ИИН/БИН контрагента','Контрагент. атауы / Наименование контрагента','Дебет айналымы / Дебетовый оборот','Кредит айналымы / Кредитовый оборот','Төлем мақсаты / Назначение платежа']
        m=infer(h,{})
        for key in ['date','number','currency','counterpartyAccount','counterpartyId','counterpartyName','debit','credit','purpose']:self.assertIn(key,m)
        self.assertEqual(infer(['Дата совершения оборота','Дата транзакции'],{})['date'],'Дата совершения оборота')

    def test_generic_bin_requires_explicit_client_block_and_filename_is_ignored(self):
        no_owner=statement_context('',[('Лист',[['БИН - 990000000999'],['ИИН/БИН:','990000000102']])],{},'990000000101',identifier)
        self.assertEqual(no_owner['ownerId'],'')
        owner=statement_context('',[('Лист',[['БИН - 990000000999'],['Клиент:','ТОО Синтетика'],['ИИН/БИН:','990000000101']])],{},'990000000102',identifier)
        self.assertEqual(owner['ownerId'],'990000000101')

    def test_short_year_is_never_guessed_from_today_or_python_pivot(self):
        self.assertEqual(bank_date('01.10.26',{},date),'')
        self.assertEqual(bank_date('01.10.26',{'dateYears':[2026]},date),'2026-10-01')
        self.assertEqual(bank_date('01.10.26',{'dateYears':[1926,2026]},date),'')
        self.assertEqual(bank_date('31.02.26',{'dateYears':[2026]},date),'')

    def test_zero_bin_in_header_is_not_an_owner(self):
        context=statement_context('',[('Лист',[['БИН клиента','000000000000']])],{},'',identifier)
        self.assertEqual(context['ownerId'],'')

    def test_print_date_does_not_anchor_period_and_contradictory_year_is_blocked(self):
        context=statement_context('',[('Лист',[['Дата формирования:','01.10.2026']])],{},'',identifier)
        self.assertEqual(context['dateYears'],[])
        context=statement_context('',[('Лист',[['Период выписки:','01.10.2026 – 31.10.2026']])],{'bankYear':'2025'},'',identifier)
        self.assertTrue(any('Год' in issue for issue in context['issues']))

if __name__=='__main__':unittest.main()
