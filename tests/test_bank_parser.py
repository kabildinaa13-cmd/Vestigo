import sys,tempfile,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
from bank_parser import iban,fee_kind,pdf_bank_tables
from extract_case_document import extract,infer
from openpyxl import Workbook

class BankTests(unittest.TestCase):
    def parse(self,rows,options=None,xlsx=False):
        with tempfile.TemporaryDirectory(prefix="vestigo-bank-test-") as directory:
            file=Path(directory)/("bank.xlsx" if xlsx else "bank.csv")
            if xlsx:
                book=Workbook()
                for row in rows: book.active.append(row)
                book.save(file)
            else:
                import csv
                with file.open("w",encoding="utf-8",newline="") as stream: csv.writer(stream,delimiter=";").writerows(rows)
            return extract(file,file.name,{"groupId":"bank","typeId":"statement","ownerId":"990000000001","defaultCurrency":"KZT",**(options or {})})

    def test_debit_credit_and_fee(self):
        result=self.parse([["Дата","БИН контрагента","Наименование контрагента","Дебет","Кредит","Комиссия","Номер документа","Назначение платежа"],["01.10.2026","990000000002","ТОО Поставка","1000,50","0","0,50","PAY-1","Оплата договора D-1"],["02.10.2026","990000000003","ТОО Покупатель","0","2000,01","","PAY-2","Аренда"]],{"bankFeeMode":"debit_includes_fee"})
        self.assertEqual(result["rows"][0]["amountMinor"],100000)
        self.assertEqual(result["rows"][0]["bank"]["feeMinor"],50)
        self.assertEqual(result["rows"][0]["senderId"],"990000000001")
        self.assertEqual(result["rows"][1]["senderId"],"990000000003")
        self.assertEqual(result["rows"][1]["amountMinor"],200001)

    def test_xlsx_signed_amount_and_unknown_commission(self):
        result=self.parse([["Дата","БИН контрагента","Сумма со знаком","Комиссия"],["01.10.2026","990000000002","-1000","10"]],xlsx=True)
        self.assertIsNone(result["rows"][0]["amountMinor"])
        self.assertEqual(result["rows"][0]["bank"]["direction"],"outgoing")
        self.assertTrue(result["rows"][0]["bank"]["issues"])

    def test_fee_refund_and_transfer_not_confused(self):
        self.assertEqual(fee_kind("Комиссия банка за перевод"),"fee")
        self.assertEqual(fee_kind("Возврат банковской комиссии"),"fee_refund")
        self.assertEqual(fee_kind("Оплата по договору без комиссии"),"transfer")

    def test_invalid_sides_and_iban(self):
        row=self.parse([["Дата","БИН контрагента","Дебет","Кредит"],["01.10.2026","990000000002","100","100"]])["rows"][0]
        self.assertIsNone(row["amountMinor"])
        self.assertEqual(iban("KZ86125KZT5004100100"),"KZ86125KZT5004100100")
        self.assertFalse(iban("KZ00125KZT5004100100"))

    def test_native_pdf_columns(self):
        table=pdf_bank_tables([{"page":1,"tableText":"Дата        БИН контрагента        Дебет        Кредит\n01.10.2026  990000000002            1000,50      0"}],infer)
        self.assertEqual(len(table),1)
        self.assertEqual(table[0][1][1][1],"990000000002")

    def test_explicit_vat_is_preserved_not_inferred_from_total(self):
        result=self.parse([["Дата","БИН поставщика","БИН получателя","Сумма с НДС","Сумма НДС","Ставка НДС"],["01.10.2026","990000000001","990000000002","1120,00","120,00","12%"]],{"groupId":"primary","typeId":"invoice"},xlsx=True)
        self.assertEqual(result["rows"][0]["attributes"]["vatMinor"],12000)
        self.assertEqual(result["rows"][0]["attributes"]["fieldSources"]["vatAmount"]["cell"],"E2")
        self.assertEqual(result["rows"][0]["attributes"]["fieldSources"]["vatAmount"]["normalized"],12000)

if __name__=="__main__": unittest.main()
