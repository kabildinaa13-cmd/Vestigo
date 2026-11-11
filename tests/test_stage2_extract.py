import csv,io,json,os,sys,tempfile,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from extract_case_document import extract,money,date,identifier
from financial_normalization import currency,explicit_currency
FIXTURES=Path(__file__).resolve().parent/'fixtures/stage2'
A='990000000021';B='020000000022'

class Stage2ExtractionTests(unittest.TestCase):
    def parse(self,name,options=None):
        return extract(FIXTURES/name,name,{'groupId':'bank' if name.startswith('bank') else 'primary','typeId':'statement' if name.startswith('bank') else 'invoice',**(options or {})})
    def csv(self,text,options=None):
        with tempfile.TemporaryDirectory(prefix='vestigo-stage2-') as folder:
            p=Path(folder)/'synthetic.csv';p.write_text(text,encoding='utf8');return extract(p,p.name,{'groupId':'primary','typeId':'invoice',**(options or {})})
    def test_multitable_late_multilevel_header_and_multisheet(self):
        r=self.parse('tables-esf.xlsx');self.assertEqual(r['status'],'extracted');self.assertEqual(len(r['tables']),4);self.assertEqual(len(r['rows']),5);self.assertEqual(r['unparsedRows'],0)
        self.assertEqual([(t['headerRow'],t['headerDepth']) for t in r['tables'][:2]],[(44,2),(49,1)])
        documents={v['number']:v['amountMinor'] for v in r['rows']};self.assertEqual(len(documents),4);self.assertEqual(sum(documents.values()),45000)
        self.assertEqual(r['rows'][0]['row'],46);self.assertEqual(r['rows'][0]['senderId'],A);self.assertEqual(r['rows'][0]['recipientId'],B)
        self.assertFalse(any(v['number'] in ('Итого','Всего') for v in r['rows']))
    def test_merged_cells_are_explicit_sources_not_blank_forward_fill(self):
        r=self.parse('tables-esf.xlsx');merged=[v for v in r['rows'] if v['number']=='ESF-MERGED'];self.assertEqual(len(merged),2)
        self.assertEqual(merged[1]['raw']['БИН покупателя'],'');self.assertEqual(merged[1]['recipientId'],B);self.assertEqual(merged[1]['attributes']['fieldSources']['recipientId']['anchorCell'],'D2')
        self.assertEqual(merged[1]['esf']['lineAmountMinor'],8000)
        r=self.csv(f'БИН поставщика;БИН покупателя;Дата;Номер ЭСФ;Сумма;Валюта\n{A};{B};2026-10-28;I1;10;KZT\n;;2026-10-28;I2;20;KZT')
        self.assertEqual(r['quality']['eligibleRows'],1);self.assertEqual(r['rows'][1]['recipientId'],'')
    def test_bank_formats_owner_currency_and_balance(self):
        r=self.parse('bank-structures.xlsx');self.assertEqual(len(r['tables']),3);self.assertEqual(r['quality']['eligibleRows'],5);self.assertEqual(r['unparsedRows'],0)
        by={v['number']:v for v in r['rows']};self.assertEqual(by['BANK-1']['amountMinor'],7000);self.assertEqual(by['BANK-2']['bank']['direction'],'incoming');self.assertEqual(by['BANK-4']['amountMinor'],2000)
        self.assertEqual(by['BANK-1']['bank']['ownerId'],B);self.assertEqual(by['BANK-1']['bank']['ownerAccount'],'KZ86125KZT5004100100');self.assertEqual(by['BANK-1']['attributes']['closingMinor'],93000)
        self.assertIsNone(by['BANK-1']['bank']['feeMinor']);self.assertEqual(by['FEE-1']['bank']['kind'],'fee');self.assertTrue(all(v['currency']=='KZT' for v in r['rows']))
    def test_conflicting_owner_context_does_not_make_payment(self):
        r=self.parse('bank-conflicts.xlsx');self.assertEqual(r['quality']['eligibleRows'],0);self.assertIsNone(r['rows'][0]['amountMinor']);self.assertTrue(any('разные БИН' in m for m in r['rows'][0]['bank']['issues']))
    def test_independent_bank_tables_do_not_share_wrong_owner(self):
        text=f'БИН клиента;{B}\nВалюта счета;KZT\nДата;БИН контрагента;Дебет;Кредит;Номер документа\n2026-10-28;{A};10;0;P1\n\nБИН клиента;990000000023\nВалюта счета;KZT\nДата;БИН контрагента;Дебет;Кредит;Номер документа\n2026-10-28;{A};20;0;P2'
        r=self.csv(text,{'groupId':'bank','typeId':'statement'});self.assertEqual(len(r['rows']),2);self.assertEqual(r['unparsedRows'],0);self.assertEqual(r['rows'][0]['senderId'],B);self.assertEqual(r['rows'][1]['senderId'],'990000000023')
    def test_duplicate_amount_column_is_blocked_then_explicitly_selected(self):
        r=self.parse('quality-and-mapping.xlsx');row=next(v for v in r['rows'] if v['number']=='DUP-COLUMNS');self.assertIsNone(row['amountMinor']);self.assertIn('amount',row['attributes']['conflictingFields'])
        r=self.parse('quality-and-mapping.xlsx',{'tableSettings':[{'sheet':'Дубли заголовка','headerRow':1,'mapping':{'amount':'Сумма [#2]'}}]});row=next(v for v in r['rows'] if v['number']=='DUP-COLUMNS');self.assertEqual(row['amountMinor'],2000)
        self.assertEqual(len(r['tables']),3);self.assertEqual(len(r['rows']),5)
    def test_unknown_table_mapping_does_not_change_other_tables(self):
        mapping={'senderId':'Код А','recipientId':'Код Б','date':'Когда','number':'Документ Х','amount':'Показатель Х','currency':'Деньги Х'}
        r=self.parse('quality-and-mapping.xlsx',{'tableSettings':[{'sheet':'Неизвестные','headerRow':1,'mapping':mapping}]});self.assertEqual(len(r['rows']),5);self.assertEqual(r['quality']['eligibleRows'],1)
        self.assertEqual(next(v for v in r['rows'] if v['number']=='MANUAL-77')['amountMinor'],7700);self.assertIsNone(next(v for v in r['rows'] if v['number']=='DUP-COLUMNS')['amountMinor'])
    def test_formula_cached_value_and_missing_result_are_distinct(self):
        r=self.parse('formulas.xlsx');self.assertEqual(r['formulaAudit']['formulaCount'],2);self.assertEqual(r['formulaAudit']['missingCacheCount'],1)
        self.assertEqual(r['rows'][0]['amountMinor'],3000);self.assertIsNone(r['rows'][1]['amountMinor']);self.assertEqual(r['quality']['eligibleRows'],1);self.assertEqual(r['quality']['reviewRows'],1)
        self.assertTrue(any(x['code']=='MISSING_FORMULA_CACHE' for x in r['rows'][1]['attributes']['extractionIssues']))
    def test_strict_money_identifier_and_currency_normalization(self):
        for raw,expected in [('1\u202f234,56',123456),('1,234.56 USD',123456),('1.234,56',123456),("1'234.56",123456),('(1 234,56 ₸)',-123456),('−10,50',-1050)]:self.assertEqual(money(raw),expected,raw)
        for raw in ['1.2.3,45','NaN','Infinity','10USD20','12.345','1.000','1,000']:self.assertIsNone(money(raw),raw)
        self.assertEqual(identifier('БИН: 020 000 000 022'),B);self.assertEqual(identifier('2E+10'),'');self.assertEqual(currency('398'),'KZT');self.assertEqual(currency('€'),'EUR');self.assertEqual(currency('$'),'UNKNOWN');self.assertEqual(explicit_currency('840'),'UNKNOWN')
    def test_numeric_money_is_not_misread_as_currency_code(self):
        r=self.csv(f'БИН поставщика;БИН покупателя;Дата;Номер ЭСФ;Сумма;Валюта\n{A};{B};2026-10-28;I-840;840;KZT');self.assertEqual(r['rows'][0]['amountMinor'],84000);self.assertEqual(r['quality']['eligibleRows'],1)
    def test_ambiguous_slash_date_requires_order(self):
        text=f'БИН поставщика;БИН покупателя;Дата;Номер ЭСФ;Сумма;Валюта\n{A};{B};10/11/2026;I-DATE;10;KZT'
        r=self.csv(text);self.assertEqual(r['rows'][0]['date'],'');self.assertEqual(r['quality']['reviewRows'],1)
        for order,expected in [('DMY','2026-11-10'),('MDY','2026-10-11')]:
            r=self.csv(text,{'tableSettings':[{'sheet':'Текстовая таблица','headerRow':1,'dateOrder':order,'mapping':{}}]});self.assertEqual(r['rows'][0]['date'],expected);self.assertEqual(r['quality']['eligibleRows'],1)
    def test_unambiguous_dates_provide_table_order_without_guessing(self):
        text=f'БИН поставщика;БИН покупателя;Дата;Номер ЭСФ;Сумма;Валюта\n{A};{B};15/10/2026;I1;10;KZT\n{A};{B};10/11/2026;I2;20;KZT'
        r=self.csv(text);self.assertEqual(r['quality']['eligibleRows'],2);self.assertEqual(r['rows'][1]['date'],'2026-11-10')
    def test_explicit_day_first_format_and_conflicting_order(self):
        header='БИН поставщика;БИН покупателя;Дата;Номер ЭСФ;Сумма;Валюта'
        text=f'{header}\n{A};{B};01.10.2026;I1;10;KZT\n{A};{B};01/10/2026;I2;20;KZT'
        r=self.csv(text);self.assertEqual({v['date'] for v in r['rows']},{'2026-10-01'})
        r=self.csv(text+f'\n{A};{B};10/15/2026;I3;30;KZT');self.assertEqual(r['rows'][1]['date'],'');self.assertEqual(r['quality']['reviewRows'],1)
    def test_short_generic_identifiers_keep_distinct_roles(self):
        r=self.csv(f'Номер ЭСФ;ИИН/БИН;Наименование поставщика;ИИН/БИН;Наименование получателя;Сумма;Дата;Валюта\nI1;{A};Альфа;{B};Бета;1234,56;2026-10-28;KZT')
        self.assertEqual(r['rows'][0]['senderId'],A);self.assertEqual(r['rows'][0]['recipientId'],B);self.assertEqual(r['rows'][0]['amountMinor'],123456);self.assertEqual(r['quality']['eligibleRows'],1)
    def test_single_comma_amount_does_not_make_text_contract_a_table(self):
        r=self.csv(f'Договор поставки № 15\nБИН поставщика: {A}\nБИН получателя: {B}\nДата документа: 01.10.2026\nОбщая сумма документа: 12000000,00\nВалюта: KZT')
        self.assertEqual(r['tables'],[]);self.assertIn('Договор поставки',r['text'])
    def test_incomplete_values_are_retained_with_exact_reasons(self):
        r=self.parse('quality-and-mapping.xlsx');self.assertEqual(r['quality']['extractedRows'],5);self.assertEqual(r['quality']['reviewRows'],5)
        by={v['number']:v for v in r['rows']};self.assertEqual(by['MISSING-BUYER']['recipientId'],'');self.assertEqual(by['BAD-DATE']['date'],'');self.assertEqual(by['NO-CURRENCY']['currency'],'UNKNOWN')
        self.assertTrue(any(x['code']=='MISSING_CURRENCY' for x in r['quality']['examples']));self.assertNotIn('accuracy',r['quality'])
    def test_totals_notes_and_multiple_csv_tables_are_not_transactions(self):
        text=f'БИН поставщика;БИН покупателя;Дата;Номер ЭСФ;Сумма;Валюта\n{A};{B};2026-10-28;I1;10;KZT\nИтого;;;;10;\nПримечание: тест\n\nНомер ЭСФ;Дата;Сумма;Валюта;БИН покупателя;БИН поставщика\nI2;2026-10-28;20;KZT;{B};{A}'
        r=self.csv(text);self.assertEqual(len(r['tables']),2);self.assertEqual(len(r['rows']),2);self.assertEqual(sum(v['amountMinor'] for v in r['rows']),3000)
        source=[v['row'] for t in r['sourceTables'] for v in t['rows']];self.assertEqual(len(source),len(set(source)));self.assertEqual(len(source),7)
    def test_invalid_table_settings_and_overlaps_are_rejected(self):
        for settings in [[{'sheet':'missing','headerRow':1}],[{'sheet':'Стандарт','headerRow':999}],[{'sheet':'Стандарт','headerRow':1,'mapping':{'amount':'MISSING'}}],[{'sheet':'Стандарт','headerRow':1},{'sheet':'Стандарт','headerRow':1}]]:
            with self.assertRaises(ValueError):self.parse('tables-esf.xlsx',{'tableSettings':settings})
    def test_long_preamble_after_row_30_is_detected(self):
        lines=['Служебная строка']*120+[f'БИН поставщика;БИН покупателя;Дата;Номер ЭСФ;Сумма;Валюта',f'{A};{B};2026-10-28;LATE-120;10;KZT']
        r=self.csv('\n'.join(lines));self.assertEqual(r['tables'][0]['headerRow'],121);self.assertEqual(r['rows'][0]['row'],122);self.assertEqual(r['quality']['eligibleRows'],1)

if __name__=='__main__':unittest.main()
