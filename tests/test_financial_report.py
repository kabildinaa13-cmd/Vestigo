import io
import sys
import tempfile
import unittest
from pathlib import Path
from decimal import Decimal
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from export_financial_report import export_xlsx,export_docx,export_pdf
from extract_case_document import extract

def fixture():
    return {'title':'Финансовая сводка дела ТЕСТ','caseNumber':'ТЕСТ','filters':{},'summary':{'supply':{'KZT':'12345'}},'counts':{'invoices':1,'sourceInvoiceRows':2,'goodsRows':2,'physicalFiles':1,'contracts':0,'contractReferences':0,'documentedDeals':None},'conclusions':['По исследованным ЭСФ документально отражены поставки на 123.45 KZT.'],'taxes':{'note':'Налоговые платежи не установлены по ЭСФ.'},'reconciliation':{'methodology':'Подтверждённые решения отделены от кандидатов.','items':[],'payments':[],'allocations':[]},'notes':['Валюты учитываются раздельно.'],'coverage':{'files':1,'failed':[],'partial':[],'missingVat':0,'missingFees':0},'invoices':[],'lines':[],'bank':[],'categories':[],'periods':[],'risks':[],'documents':[{'name':'Тест.xlsx','status':'extracted','excluded':False}]}

class FinancialExports(unittest.TestCase):
    def test_goods_custom_report_exact_cells_and_sources(self):
        from openpyxl import load_workbook
        from docx import Document
        from pypdf import PdfReader
        r={'title':'Товары и услуги — тест','narrative':['Не прибыль и не ущерб.'], 'customSections':[{'title':'Позиции','headers':['Наименование','Сумма','Источник'],'rows':[['=HYPERLINK("https://invalid")',{'moneyMinor':'12345'},'http://localhost:3200/api/documents/test?caseId=synthetic']]}]}
        book=load_workbook(io.BytesIO(export_xlsx(r)),data_only=False)
        self.assertEqual(book['Позиции']['B2'].value,123.45)
        self.assertEqual(book['Позиции']['A2'].data_type,'s')
        self.assertEqual(book['Позиции']['C2'].hyperlink.target,r['customSections'][0]['rows'][0][2])
        self.assertTrue(Document(io.BytesIO(export_docx(r))).tables)
        self.assertTrue(any('Товары и услуги' in (p.extract_text() or '') for p in PdfReader(io.BytesIO(export_pdf(r))).pages))
    def test_xlsx_real_numeric_money_and_no_formula_injection(self):
        from openpyxl import load_workbook
        r=fixture();r['documents'][0]['name']='=HYPERLINK("https://invalid")';book=load_workbook(io.BytesIO(export_xlsx(r)),data_only=False)
        self.assertEqual(next(row[2].value for row in book['Показатели'] if row[0].value=='Поставки по ЭСФ'),123.45)
        self.assertEqual(book['Охват документов']['A2'].data_type,'s')
        self.assertTrue(all(c.data_type!='f' for s in book for row in s for c in row))
    def test_docx_and_pdf_have_readable_cyrillic(self):
        from docx import Document
        from pypdf import PdfReader
        r=fixture();doc=Document(io.BytesIO(export_docx(r)));self.assertTrue(any('Финансовая сводка' in p.text for p in doc.paragraphs))
        pdf=PdfReader(io.BytesIO(export_pdf(r)));self.assertTrue(any('Финансовая' in (p.extract_text() or '') for p in pdf.pages))
    def test_tax_account_is_context_not_new_money(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'tax.csv'
            path.write_text('БИН налогоплательщика;Вид налога;Период с;Период по;Уплачено налога;Валюта\n990000000001;НДС;01.10.2026;31.10.2026;123.45;KZT',encoding='utf-8')
            result=extract(path,'tax.csv',{'groupId':'tax','typeId':'tax_account_statement'})
        self.assertTrue(result['contextOnly']);self.assertEqual(result['rows'][0]['type'],'context');self.assertEqual(result['rows'][0]['attributes']['taxPaidMinor'],12345)

if __name__=='__main__':unittest.main()
