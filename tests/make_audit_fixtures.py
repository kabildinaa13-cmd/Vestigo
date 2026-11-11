"""Synthetic files only. No investigation materials are read."""
import sys,json,io,zipfile,base64
from xml.sax.saxutils import escape
from openpyxl import Workbook
from pypdf import PdfWriter
def encoded(value): return base64.b64encode(value).decode("ascii")
text="Договор поставки № 15\nБИН поставщика: 990000000001\nБИН получателя: 990000000002\nНаименование поставщика: ТОО Синтетический поставщик\nНаименование получателя: ТОО Синтетический покупатель\nДата документа: 01.10.2026\nОбщая сумма документа: 12000000,00\nВалюта: KZT"
stream=io.BytesIO()
with zipfile.ZipFile(stream,"w",zipfile.ZIP_DEFLATED) as archive:
    archive.writestr("[Content_Types].xml",'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>')
    archive.writestr("word/document.xml",'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'+"".join('<w:p><w:r><w:t>'+escape(line)+'</w:t></w:r></w:p>' for line in text.splitlines())+'</w:body></w:document>')
book=Workbook();book.active.title="ЭСФ"
book.active.append(["БИН поставщика","БИН покупателя","Сумма с НДС","Дата","Номер ЭСФ","Валюта","Номер договора основания"])
book.active.append(["990000000001","990000000002","8000000,00","02.10.2026","ESF-SYNTHETIC-15","KZT","15"])
book.create_sheet("Примечания").append(["Синтетический тест — не материалы дела"])
xlsx=io.BytesIO();book.save(xlsx)
writer=PdfWriter();writer.add_blank_page(200,200);blank=io.BytesIO();writer.write(blank)
writer.encrypt("synthetic-password");encrypted=io.BytesIO();writer.write(encrypted)
print(json.dumps({"contract":encoded(stream.getvalue()),"invoice":encoded(xlsx.getvalue()),"blankPdf":encoded(blank.getvalue()),"encryptedPdf":encoded(encrypted.getvalue())}))
