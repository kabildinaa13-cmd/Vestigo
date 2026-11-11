import importlib.util
import os
from unittest.mock import patch
import tempfile
import unittest
import zipfile
from pathlib import Path
from openpyxl import Workbook
from pypdf import PdfWriter
from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject

spec = importlib.util.spec_from_file_location("extractor", Path(__file__).resolve().parents[1] / "scripts/extract_case_document.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


@patch.dict(os.environ, {"VESTIGO_OCR_DISABLED": "1"})
class ExtractTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="vestigo-extract-")
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_invoice_tax_base_is_not_gross_and_invalid_gross_is_not_replaced(self):
        file = self.root / "totals.csv"
        file.write_text(
            "Номер ЭСФ;Дата;БИН поставщика;БИН покупателя;Валюта;Всего по счету, размер оборота по реализации;Сумма с НДС;Сумма строки\n"
            "NET;2026-10-01;990000000021;020000000022;KZT;1000,05;;\n"
            "GROSS;2026-10-01;990000000021;020000000022;KZT;1000,05;1120,06;1120,06\n"
            "INVALID;2026-10-01;990000000021;020000000022;KZT;1000,05;12 34;1120,06\n",
            encoding="utf-8",
        )
        rows = {r["number"]: r for r in module.extract(file, file.name, {"groupId": "primary", "typeId": "invoice"})["rows"]}
        self.assertIsNone(rows["NET"]["amountMinor"])
        self.assertEqual(rows["NET"]["attributes"]["taxBaseMinor"], 100005)
        self.assertEqual(rows["GROSS"]["amountMinor"], 112006)
        self.assertIsNone(rows["INVALID"]["amountMinor"])
        self.assertIn("INVALID_INVOICE_TOTAL", [i["code"] for i in rows["INVALID"]["attributes"]["extractionIssues"]])
        self.assertEqual(module.money("1\u202f234\u202f567,89"), 123456789)
        self.assertIsNone(module.money("12 34,56"))

    def test_xml_with_conflicting_amount_fields_never_uses_the_last_value(self):
        file = self.root / "invoice.xml"
        file.write_text(
            "<rows><row><invoice_number>XML-1</invoice_number><date>2026-10-01</date>"
            "<sender_id>990000000021</sender_id><recipient_id>020000000022</recipient_id>"
            "<currency>KZT</currency><amount>10.01</amount><amount>99.01</amount></row></rows>",
            encoding="utf-8",
        )
        row = module.extract(file, file.name, {"groupId": "primary", "typeId": "invoice"})["rows"][0]
        self.assertIsNone(row["amountMinor"])
        self.assertIn("amount", row["attributes"]["conflictingFields"])

    def test_json_rejects_repeated_amount_key(self):
        file = self.root / "invoice.json"
        file.write_text('{"invoice_number":"TEST","amount":10.01,"amount":99.01}', encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "повторяется ключ"):
            module.extract(file, file.name, {"groupId": "primary", "typeId": "invoice"})

    def test_xlsx_all_sheets_and_leading_zero(self):
        file = self.root / "test.xlsx"
        book = Workbook()
        for sheet in [book.active, book.create_sheet("Второй лист")]:
            sheet.append(["БИН поставщика", "БИН получателя", "Сумма", "Дата", "Номер документа"])
            sheet.append(["010740002706", "210440002261", "1000,01", "19.10.2026", "T-1"])
        book.save(file)
        result = module.extract(file, file.name, {"typeId": "invoice"})
        self.assertEqual(len(result["rows"]), 2)
        self.assertEqual(result["rows"][0]["amountMinor"], 100001)
        self.assertEqual(result["rows"][0]["senderId"], "010740002706")

    def test_docx_keeps_text_and_table(self):
        file = self.root / "test.docx"
        with zipfile.ZipFile(file, "w") as archive:
            archive.writestr("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Условия договора: аренда помещения</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Номер документа</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Сумма</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>D-1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>100</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>')
        result = module.extract(file, file.name, {"groupId": "contract"})
        self.assertIn("аренда", result["text"])
        self.assertEqual(len(result["rows"]), 1)
        self.assertEqual(result["unparsedRows"], 1)

    def test_xlsx_opaque_storage_name_reads_tables_and_formula_audit(self):
        file = self.root / "opaque.original"
        book = Workbook()
        for sheet in (book.active, book.create_sheet("Второй лист")):
            sheet.append(["БИН поставщика", "БИН получателя", "Сумма", "Дата", "Номер документа", "Ошибка", "Формула"])
            sheet.append(["010740002706", "210440002261", 1000.01, "2026-10-20", "TEST-1", "#N/A", "=1+1"])
        book.save(file)
        result = module.extract(file, "Расчет до%85%D0%BE.xlsx", {"typeId": "invoice"})
        self.assertEqual(len(result["tables"]), 2)
        self.assertEqual(len(result["rows"]), 2)
        self.assertEqual(result["rows"][0]["senderId"], "010740002706")
        self.assertEqual(result["rows"][0]["amountMinor"], 100001)
        self.assertEqual(result["formulaAudit"]["formulaCount"], 2)
        self.assertEqual(result["formulaAudit"]["errorCount"], 2)
        file.rename(self.root / "released.original")

    def test_invalid_xlsx_opaque_storage_still_rejected(self):
        file = self.root / "invalid.original"
        file.write_bytes(b"not an Office archive")
        with self.assertRaises(zipfile.BadZipFile):
            module.extract(file, "invalid.xlsx", {})
        file.unlink()

    def test_text_pdf_and_blank_scan_need_different_status(self):
        file = self.root / "text.pdf"
        writer = PdfWriter()
        page = writer.add_blank_page(500, 500)
        font = DictionaryObject({NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type1"), NameObject("/BaseFont"): NameObject("/Helvetica")})
        page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): font})})
        stream = DecodedStreamObject()
        stream.set_data(b"BT /F1 12 Tf 30 400 Td (TEST CONTRACT 123) Tj ET")
        page[NameObject("/Contents")] = writer._add_object(stream)
        writer.write(file)
        result = module.extract(file, file.name, {})
        self.assertIn("TEST CONTRACT", result["text"])
        self.assertEqual(result["status"], "review")
        self.assertEqual(result["pageAudit"]["pagesWithText"], 1)
        mixed = self.root / "mixed.pdf"
        writer.add_blank_page(500, 500)
        writer.write(mixed)
        mixed_result = module.extract(mixed, mixed.name, {})
        self.assertEqual(mixed_result["pageAudit"]["totalPages"], 2)
        self.assertEqual(mixed_result["pageAudit"]["pagesWithoutText"], [2])
        self.assertFalse(mixed_result["pageAudit"]["ocrPerformed"])
        self.assertTrue(any("Не считайте файл полностью прочитанным" in w for w in mixed_result["warnings"]))
        blank = self.root / "scan.pdf"
        writer = PdfWriter()
        writer.add_blank_page(500, 500)
        writer.write(blank)
        blank_result = module.extract(blank, blank.name, {})
        self.assertEqual(blank_result["status"], "needs_ocr")
        self.assertEqual(blank_result["pageAudit"]["pagesWithoutText"], [1])
        self.assertEqual(blank_result["rows"], [])

    def test_unknown_mapping_money_precision_and_xml_security(self):
        file = self.root / "unknown.csv"
        file.write_text("А;Б\nвещь;100", encoding="utf8")
        self.assertEqual(module.extract(file, file.name, {})["status"], "needs_mapping")
        self.assertEqual(module.money("1 234,56"), 123456)
        self.assertIsNone(module.money("12.345"))
        self.assertIsNone(module.money("NaN"))
        xml = self.root / "unsafe.xml"
        xml.write_text('<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///secret">]><foo>&xxe;</foo>', encoding="utf8")
        with self.assertRaisesRegex(ValueError, "DTD/ENTITY"):
            module.extract(xml, xml.name, {})

    def test_manual_text_facts_and_provenance(self):
        file = self.root / "contract.txt"
        file.write_text("Договор аренды CON-1, оригинал для сверки", encoding="utf8")
        fields = {"senderId": "990000000001", "recipientId": "990000000002", "amount": "1000,01", "date": "2026-10-01", "currency": "KZT", "number": "CON-1"}
        with self.assertRaisesRegex(ValueError, "Подтвердите"):
            module.extract(file, file.name, {"groupId": "contract", "documentFields": fields})
        result = module.extract(file, file.name, {"groupId": "contract", "documentFields": fields, "manualConfirmed": True})
        self.assertEqual(result["rows"][0]["type"], "contract")
        self.assertTrue(result["rows"][0]["manualSource"])
        self.assertEqual(result["rows"][0]["amountMinor"], 100001)
        self.assertIn("Договор аренды", result["text"])

    def test_explicit_extra_fields_and_excel_formula_errors(self):
        file = self.root / "audit.xlsx"
        book = Workbook()
        sheet = book.active
        sheet.append(["Номер договора основания", "Количество", "Цена с НДС", "Оборот без НДС", "Начальный остаток", "Конечный остаток", "Период с", "Ошибка", "Формула"])
        sheet.append(["CON-1", "3", "100,01", "300", "200", "100", "2026-10-01", "#N/A", "=1+1"])
        book.save(file)
        result = module.extract(file, file.name, {"typeId": "invoice"})
        self.assertEqual(result["rows"][0]["contractRef"], "CON-1")
        self.assertEqual(result["rows"][0]["attributes"]["unitPriceMinor"], 10001)
        self.assertEqual(result["rows"][0]["attributes"]["taxBaseMinor"], 30000)
        self.assertEqual(result["formulaAudit"]["errorCount"], 1)
        self.assertEqual(result["formulaAudit"]["errors"][0]["cell"], "H2")
        self.assertEqual(result["formulaAudit"]["formulaCount"], 1)

    def test_energy_formula_day_check_is_explicit_and_source_located(self):
        file = self.root / "energy.xlsx"
        book = Workbook()
        sheet = book.active
        sheet.title = "Потребление"
        sheet.append(["Дата выписки", "Дата совершения оборота", "Год", "Наименование ТРУ", "Кол-во (объем)", "КВт* час"])
        sheet.append(["2026-12-01", "2026-11-30", "2026", "Электроэнергия", 720, "=E2/24/31"])
        sheet.append(["2026-12-01", "2026-11-30", "2026", "Электроэнергия", 720, "=$E$3 / 24 / 30"])
        sheet.append(["2026-12-01", "2026-11-30", "2026", "Электроэнергия", 720, "=E3/24/31"])
        other = book.create_sheet("Другая таблица")
        other.append(["Дата", "Количество", "Формула"])
        other.append(["2026-11-30", 720, "=B2/24/31"])
        book.save(file)
        result = module.extract(file, file.name, {"groupId": "expert", "typeId": "mining_calculation"})
        self.assertEqual(result["formulaAudit"]["periodMismatchCount"], 1)
        finding = result["formulaAudit"]["periodMismatches"][0]
        self.assertEqual((finding["sheet"], finding["cell"], finding["row"]), ("Потребление", "F2", 2))
        self.assertEqual((finding["formulaDays"], finding["calendarDays"]), (31, 30))
        self.assertTrue(result["contextOnly"])
        self.assertTrue(all(r["type"] == "context" for r in result["rows"]))
        self.assertEqual(result["unparsedRows"], 0)

    def test_declarations_and_registration_are_context_not_payments(self):
        for kind in ("declaration_100", "declaration_220", "declaration_300", "registration_data"):
            file = self.root / f"{kind}.txt"
            file.write_text("ДЕКЛАРАЦИЯ форма 100.00\nПустые клетки и суммы требуют сверки", encoding="utf8")
            result = module.extract(file, file.name, {"groupId": "tax", "typeId": kind})
            self.assertTrue(result["contextOnly"])
            self.assertTrue(result["documentProfile"]["requiresFactReview"])
            self.assertEqual(result["rows"], [])
            self.assertEqual(result["status"], "extracted")
            self.assertNotIn("amountMinor", result["documentProfile"])

    def test_reconciliation_and_mixed_bundle_keep_rows_without_new_transfers(self):
        file = self.root / "synthetic.csv"
        file.write_text("БИН поставщика;БИН получателя;Сумма;Дата;Валюта\n990000000001;990000000002;100;2026-10-20;KZT", encoding="utf8")
        for group, kind in (("accounting", "reconciliation_act"), ("unclassified", "mixed_bundle")):
            result = module.extract(file, file.name, {"groupId": group, "typeId": kind})
            self.assertEqual(result["rows"][0]["type"], "context")
            self.assertEqual(result["rows"][0]["amountMinor"], 10000)
            self.assertTrue(result["contextOnly"])
            self.assertTrue(result["documentProfile"]["requiresFactReview"])


if __name__ == "__main__":
    unittest.main()
