import sys,io,tempfile,unittest,os
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
from extract_case_document import extract
import xlwt
from openpyxl import Workbook

class AuditFormatTests(unittest.TestCase):
    @unittest.skipUnless(os.environ.get("VESTIGO_TEST_OCR")=="1","opt-in real multilingual OCR")
    def test_real_russian_kazakh_english_ocr(self):
        from PIL import Image,ImageDraw,ImageFont
        import local_ocr
        image=Image.new("RGB",(2100,900),"white");draw=ImageDraw.Draw(image);font=ImageFont.truetype("C:/Windows/Fonts/arial.ttf",64)
        lines=["ДОГОВОР ПОСТАВКИ","Қазақстан Республикасы ҚҰЖАТ АҚША","BANK PAYMENT INVOICE"]
        for i,text in enumerate(lines):draw.text((80,80+i*220),text,font=font,fill="black")
        with tempfile.TemporaryDirectory(prefix="vestigo-language-audit-") as folder:
            from unittest.mock import patch
            with patch.dict(os.environ,{"VESTIGO_OCR_CACHE":folder}):result=local_ocr.recognize(image)
        for text in lines:self.assertIn(text,result["text"])
        self.assertEqual(result["languages"],["rus","kaz","eng"])

    def test_xls_100_rows_preserves_explicit_zero_formatted_identifiers(self):
        with tempfile.TemporaryDirectory(prefix="vestigo-xls-audit-") as folder:
            source=Path(folder)/"synthetic.xls";book=xlwt.Workbook();sheet=book.add_sheet("Операции")
            headers=["БИН поставщика","БИН получателя","Сумма с НДС","Дата","Номер ЭСФ","Валюта"]
            for col,label in enumerate(headers):sheet.write(0,col,label)
            style=xlwt.easyxf(num_format_str="000000000000")
            for row in range(1,101):
                sheet.write(row,0,10740002706,style);sheet.write(row,1,"990000000002");sheet.write(row,2,"123,45");sheet.write(row,3,"01.10.2026");sheet.write(row,4,f"ESF-{row}");sheet.write(row,5,"KZT")
            book.save(str(source));result=extract(source,source.name,{"groupId":"primary","typeId":"invoice"})
            self.assertEqual(len(result["rows"]),100);self.assertEqual(result["rows"][0]["senderId"],"010740002706");self.assertEqual(result["unparsedRows"],0)

    def test_xlsx_zero_formatted_identifier_is_not_dropped(self):
        with tempfile.TemporaryDirectory(prefix="vestigo-xlsx-audit-") as folder:
            source=Path(folder)/"synthetic.xlsx";book=Workbook();sheet=book.active
            sheet.append(["БИН поставщика","БИН получателя","Сумма с НДС","Дата","Номер ЭСФ","Валюта"]);sheet.append([10740002706,"990000000002","123,45","01.10.2026","ESF-1","KZT"]);sheet["A2"].number_format="000000000000";book.save(source)
            self.assertEqual(extract(source,source.name,{"groupId":"primary","typeId":"invoice"})["rows"][0]["senderId"],"010740002706")

    def test_contradictory_explicit_bank_parties_not_overwritten_by_owner_context(self):
        with tempfile.TemporaryDirectory(prefix="vestigo-bank-conflict-") as folder:
            source=Path(folder)/"synthetic.csv"
            source.write_text("Дата;БИН владельца счета;БИН отправителя;БИН получателя;БИН контрагента;Дебет;Валюта\n01.10.2026;990000000001;990000000003;990000000002;990000000002;123,45;KZT",encoding="utf-8")
            row=extract(source,source.name,{"groupId":"bank","typeId":"statement"})["rows"][0]
            self.assertEqual(row["senderId"],"990000000003");self.assertIsNone(row["amountMinor"]);self.assertTrue(any("Противореч" in issue for issue in row["bank"]["issues"]))

if __name__=="__main__":unittest.main()
