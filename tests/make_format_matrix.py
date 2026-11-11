"""Generate real synthetic Office/PDF/image files for the HTTP integration test."""
import sys,io,json,base64,zipfile,datetime
from pathlib import Path
from xml.sax.saxutils import escape
from openpyxl import Workbook
import xlwt
from pypdf import PdfWriter
from pypdf.generic import DictionaryObject,NameObject,DecodedStreamObject
from PIL import Image,ImageDraw,ImageFont

def packed(name,content,**extra):return {"name":name,"base64":base64.b64encode(content).decode("ascii"),**extra}
headers=["БИН поставщика","БИН получателя","Сумма с НДС","Дата","Номер ЭСФ","Валюта"]
row=lambda number,date="01.10.2026":["990000000001","990000000002","123,45",date,number,"KZT"]
files=[]
book=Workbook();sheet=book.active;sheet.title="Первые 50";sheet.append(headers)
formats=["2026-10-01","01.10.2026","01/10/2026","2026/10/01"]
for n in range(1,101):
    if n==51:sheet=book.create_sheet("Остальные 50");sheet.append(headers)
    sheet.append(row(f"ESF-XLSX-{n}",formats[n%4]))
buffer=io.BytesIO();book.save(buffer);files.append(packed("100-operations.xlsx",buffer.getvalue(),expected=100))
book=xlwt.Workbook();sheet=book.add_sheet("Настоящий XLS")
for c,h in enumerate(headers):sheet.write(0,c,h)
for r in range(1,101):
    for c,v in enumerate(row(f"ESF-XLS-{r}")):sheet.write(r,c,v)
buffer=io.BytesIO();book.save(buffer);files.append(packed("legacy-100.xls",buffer.getvalue(),expected=100))
csv=";".join(headers)+"\n"+";".join(row("ESF-CSV-1"))
files.append(packed("invoice.csv",csv.encode("utf-8"),expected=1))
files.append(packed("invoice.json",json.dumps([dict(zip(headers,row("ESF-JSON-1")))],ensure_ascii=False).encode("utf-8"),expected=1))
xml="<rows><row>"+"".join(f"<{key}>{escape(value)}</{key}>" for key,value in zip(["sender_id","recipient_id","amount","date","number","currency"],row("ESF-XML-1")))+"</row></rows>"
files.append(packed("invoice.xml",xml.encode("utf-8"),expected=1))
def docx(text):
    buffer=io.BytesIO()
    with zipfile.ZipFile(buffer,"w",zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml",'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>')
        archive.writestr("word/document.xml",'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'+"".join('<w:p><w:r><w:t>'+escape(line)+'</w:t></w:r></w:p>' for line in text.splitlines())+'</w:body></w:document>')
    return buffer.getvalue()
contract="Договор поставки № 15\nБИН поставщика: 990000000001\nБИН получателя: 990000000002\nНаименование поставщика: ТОО Альфа\nНаименование получателя: ТОО Бета\nДата документа: 01.10.2026\nОбщая сумма документа: 12000000,00\nВалюта: KZT"
files.append(packed("contract.docx",docx(contract),expected=1,group="contract",kind="supply_agreement"))
files.append(packed("empty.docx",docx(""),expected=0,empty=True,group="contract",kind="supply_agreement"))
files.append(packed("contract.txt",contract.replace("№ 15","№ 16").encode("utf-8"),expected=1,group="contract",kind="supply_agreement"))
writer=PdfWriter()
for n in range(1,4):
    page=writer.add_blank_page(600,800)
    font=DictionaryObject({NameObject("/Type"):NameObject("/Font"),NameObject("/Subtype"):NameObject("/Type1"),NameObject("/BaseFont"):NameObject("/Helvetica")})
    page[NameObject("/Resources")]=DictionaryObject({NameObject("/Font"):DictionaryObject({NameObject("/F1"):writer._add_object(font)})})
    stream=DecodedStreamObject();stream.set_data(f"BT /F1 16 Tf 40 740 Td (SYNTHETIC-PAGE-{n}) Tj ET".encode());page[NameObject("/Contents")]=writer._add_object(stream)
buffer=io.BytesIO();writer.write(buffer);files.append(packed("three-pages.pdf",buffer.getvalue(),expected=3,pages=3,contextOnly=True,group="correspondence",kind="cover_letter"))
image=Image.new("RGB",(1600,1500),"white");draw=ImageDraw.Draw(image)
font=ImageFont.truetype("C:/Windows/Fonts/arial.ttf",34)
for i,line in enumerate(contract.splitlines()+["Қазақстан Республикасы", "BANK PAYMENT INVOICE"]):draw.text((40,40+i*90),line,font=font,fill="black")
buffer=io.BytesIO();image.save(buffer,format="PDF",resolution=150);files.append(packed("scan.pdf",buffer.getvalue(),expected=1,ocr=True,group="contract",kind="supply_agreement"))
for extension,format in [("png","PNG"),("jpg","JPEG"),("tiff","TIFF")]:
    buffer=io.BytesIO();image.save(buffer,format=format,**({"compression":"tiff_deflate"} if format=="TIFF" else {}));files.append(packed("scan."+extension,buffer.getvalue(),expected=1,ocr=True,group="contract",kind="supply_agreement"))
archive=io.BytesIO()
with zipfile.ZipFile(archive,"w",zipfile.ZIP_DEFLATED) as zip:
    zip.writestr("nested/inside.csv",csv.replace("ESF-CSV-1","ESF-ZIP-1"))
files.append(packed("synthetic.zip",archive.getvalue(),expected=1,group="primary",kind="invoice"))
files.append(packed("broken.json",b"{broken",expected=0,failed=True))
print(json.dumps({"files":files}))
