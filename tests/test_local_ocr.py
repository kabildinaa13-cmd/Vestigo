import io
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
from pypdf import PdfWriter
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import local_ocr


class LocalOcrTests(unittest.TestCase):
    def source(self):
        writer = PdfWriter()
        writer.add_blank_page(500, 500)
        writer.add_blank_page(500, 500)
        output = io.BytesIO()
        writer.write(output)
        return output

    def test_native_text_not_ocr_and_scan_preserves_provenance(self):
        pages = [{"page": 1, "text": "native"}, {"page": 2, "text": ""}]
        with patch.object(local_ocr, "recognize", return_value={"text": "Договор поставки", "rotation": 90, "engine": "test", "lines": [], "kazakhAvailable": False}) as engine:
            result = local_ocr.read_pdf_pages(self.source(), pages)
        self.assertEqual(engine.call_count, 1)
        self.assertEqual(result[0]["text"], "native")
        self.assertEqual(result[1]["textSource"], "ocr")
        self.assertEqual(result[1]["ocr"]["rotation"], 90)

    def test_page_limit_and_failure_are_visible_not_success(self):
        with patch.dict(os.environ, {"VESTIGO_OCR_MAX_PAGES": "1"}), patch.object(local_ocr, "recognize", side_effect=RuntimeError("test timeout")):
            result = local_ocr.read_pdf_pages(self.source(), [{"page": 1, "text": ""}, {"page": 2, "text": ""}])
        self.assertIn("timeout", result[0]["ocrError"])
        self.assertIn("предел", result[1]["ocrError"])
        self.assertTrue(all(not p["text"] for p in result))

    def test_table_lines_are_removed_without_mutating_original(self):
        from PIL import Image, ImageDraw
        image = Image.new("RGB", (800, 500), "white")
        draw = ImageDraw.Draw(image)
        draw.line((10, 100, 790, 100), fill="black", width=3)
        draw.line((400, 10, 400, 490), fill="black", width=3)
        draw.text((50, 150), "TEST 123", fill="black")
        before = image.tobytes()
        output, audit = local_ocr.prepare_scan(image)
        self.assertTrue(audit["available"])
        self.assertTrue(audit["tableLinesRemoved"])
        self.assertEqual(image.tobytes(), before)
        self.assertEqual(output.size, image.size)
        self.assertGreater(sum(output.getpixel((x, 100))[0] for x in range(20, 300)), 60000)

    def test_cached_pages_do_not_consume_the_next_ocr_batch_limit(self):
        with patch.dict(os.environ, {"VESTIGO_OCR_MAX_PAGES":"1"}), patch.object(local_ocr,"recognize",side_effect=[{"text":"cached","cached":True},{"text":"new","cached":False}]):
            result=local_ocr.read_pdf_pages(self.source(),[{"page":1,"text":""},{"page":2,"text":""}])
        self.assertEqual([page["text"] for page in result],["cached","new"])
        self.assertTrue(all("ocrError" not in page for page in result))

    def test_continuation_reads_only_previously_unread_pages(self):
        pages=[{"page":1,"text":""},{"page":2,"text":""}]
        prior=[{"page":1,"text":"Saved source text","textSource":"ocr","ocr":{"engine":"test"}},{"page":2,"text":"","ocrError":"budget"}]
        with patch.object(local_ocr,"recognize",return_value={"text":"New source text","cached":False}) as engine:
            result=local_ocr.read_pdf_pages(self.source(),pages,reuse_pages=prior)
        self.assertEqual(engine.call_count,1)
        self.assertTrue(result[0]["reusedText"])
        self.assertEqual(result[1]["text"],"New source text")

    @unittest.skipUnless(os.environ.get("VESTIGO_TEST_OCR") == "1", "opt-in real local OCR integration")
    def test_real_local_windows_ocr(self):
        from PIL import Image, ImageDraw, ImageFont
        image = Image.new("RGB", (1700, 800), "white")
        draw = ImageDraw.Draw(image)
        font = ImageFont.truetype(r"C:\Windows\Fonts\arial.ttf", 64)
        draw.text((100, 100), "ДОГОВОР ПОСТАВКИ", font=font, fill="black")
        draw.text((100, 230), "Номер 42", font=font, fill="black")
        result = local_ocr.recognize(image)
        self.assertIn("поставки", result["text"].lower())
        self.assertEqual(result["rotation"], 0)
        self.assertIsInstance(result["confidenceAvailable"], bool)


if __name__ == "__main__":
    unittest.main()
