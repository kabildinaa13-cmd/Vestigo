"""Local, deterministic document extraction. Never executes Office formulas or uses network."""
import csv
import calendar
import datetime as dt
import io
import json
import re
import sys
import zipfile
import posixpath
from decimal import Decimal, InvalidOperation
from contextlib import contextmanager
from pathlib import Path
from xml.etree import ElementTree as ET
sys.path.insert(0, str(Path(__file__).resolve().parent))
from financial_normalization import clean, norm, money, identifier, date, currency, explicit_currency
from table_layout import SourceRows, discover, merged_values, service_row
from extraction_quality import create_quality, issue as quality_issue, skipped as quality_skipped, assess as assess_quality
from legacy_bank_html import is_html_xls, read_html_xls

MAX_ROWS = 100000
MAX_TEXT = 8_000_000
MAX_UNZIPPED = 250 * 1024 * 1024


class ExcelNumeric(str):
    """A numeric source cell, kept distinct until column semantics are known."""


def formatted_identifier_value(value, number_format):
    # Preserve an explicit Excel display format, never guess missing digits in General cells.
    if isinstance(value,(int,float)) and not isinstance(value,bool) and re.fullmatch(r"0{12}",str(number_format or "")) and 0<=value<10**12 and value==int(value):
        return f"{int(value):012d}"
    return ExcelNumeric(clean(value)) if isinstance(value,(int,float)) and not isinstance(value,bool) else clean(value)


def decode(data):
    for encoding in ("utf-8-sig", "utf-16", "cp1251"):
        try:
            result = data.decode(encoding)
            if "\x00" not in result:
                return result
        except UnicodeError:
            pass
    raise ValueError("Не удалось определить кодировку. Сохраните текст в UTF-8.")


def unique_json_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("В JSON повторяется ключ одного объекта. Устраните неоднозначность в исходной выгрузке.")
        result[key] = value
    return result


ALIASES = {
    "vatAmount": ["Всего по счету, сумма НДС", "Сумма НДС", "НДС сумма", "vat_amount", "VAT amount"],
    "vatTotal": ["Всего по счету, сумма НДС", "НДС по документу", "vat_total"],
    "lineVatAmount": ["НДС строки", "Сумма НДС по строке", "line_vat_amount", "Сумма НДС"],
    "vatRate": ["Ставка НДС", "vat_rate", "VAT rate"],
    "taxpayerId": ["БИН налогоплательщика", "ИИН налогоплательщика", "taxpayer_id"],
    "taxType": ["Вид налога", "tax_type"],
    "taxAccrued": ["Начислено налога", "tax_accrued"],
    "taxPaid": ["Уплачено налога", "tax_paid"],
    "taxOffset": ["Зачтено налога", "tax_offset"],
    "taxRefund": ["Возвращено налога", "tax_refund"],
    "taxArrears": ["Недоимка", "tax_arrears"],
    "taxOverpayment": ["Переплата налога", "tax_overpayment"],
    "contractRef": ["Номер договора (контракта) на поставку ТРУ", "Номер договора основания", "Договор основание", "contract_ref"],
    "invoiceKind": ["Вид счет-фактуры", "Вид счета-фактуры", "invoice_kind"],
    "baseInvoiceNumber": ["Регистрационный номер", "Регистрационный номер исходной ЭСФ", "base_invoice_number"],
    "baseInvoiceDate": ["Дата выписки СФ, к которому выписывается исправленный/дополнительный СФ", "base_invoice_date"],
    "issueDate": ["Дата выписки", "Дата выписки ЭСФ", "issue_date"],
    "goodsName": ["Наименование ТРУ", "Наименование товара", "goods_name"],
    "unitPriceWithoutVat": ["Цена (тариф) за единицу ТРУ без косвенных налогов", "unit_price_without_vat"],
    "paymentRef": ["Номер подтверждающего платежа", "payment_ref"],
    "itemCode": ["Код товара", "Артикул", "item_code"],
    "quantity": ["Количество", "Кол-во (объем)", "Кол-во (объём)", "Кол-во", "Количество ТРУ", "quantity"],
    "unit": ["Единица измерения", "Ед. изм.", "unit"],
    "unitPrice": ["Цена с НДС", "unit_price_with_vat"],
    "opening": ["Начальный остаток", "opening_balance"],
    "incoming": ["Поступления", "incoming_amount"],
    "outgoing": ["Выбытия", "outgoing_amount"],
    "closing": ["Конечный остаток", "closing_balance"],
    "openingQuantity": ["Начальное количество", "opening_quantity"],
    "receivedQuantity": ["Поступило количество", "received_quantity"],
    "issuedQuantity": ["Выбыло количество", "issued_quantity"],
    "closingQuantity": ["Конечное количество", "closing_quantity"],
    "periodFrom": ["Период с", "period_from"],
    "periodTo": ["Период по", "period_to"],
    "taxBase": ["Всего по счету, размер оборота по реализации", "Оборот без НДС", "Задекларированный оборот без НДС", "tax_base"],
    "taxBasis": ["База сравнения", "tax_basis"],
    "senderId": ["IIN_SELLER", "SELLER_TIN", "БИН поставщика", "ИИН/БИН поставщика", "БИН плательщика", "БИН отправителя", "ИИН отправителя", "sender_id", "supplier_bin"],
    "recipientId": ["IIN_CUSTOMER", "CUSTOMER_TIN", "БИН получателя", "ИИН/БИН получателя", "БИН покупателя", "ИИН получателя", "recipient_id", "buyer_bin"],
    "senderName": ["Наименование поставщика по данным ИС ЭСФ", "Наименование поставщика", "Наименование плательщика", "Отправитель", "Плательщик", "sender_name", "supplier_name"],
    "recipientName": ["Наименование получателя по данным ИС ЭСФ", "Наименование получателя", "Наименование покупателя", "Получатель", "Покупатель", "recipient_name", "buyer_name"],
    "amount": ["Всего по счету, стоимость товаров, работ, услуг с учетом косвенных налогов", "Общая сумма с НДС", "Сумма с НДС", "Сумма документа", "Итого к оплате", "Сумма платежа", "Сумма", "amount", "total"],
    "lineAmount": ["Стоимость товаров, работ, услуг с учетом косвенных налогов", "Сумма строки", "line_amount"],
    "lineNumber": ["Порядковый номер ТРУ", "Номер строки", "line_number"],
    "date": ["Дата совершения оборота", "Дата операции", "Дата платежа", "Дата выписки", "Дата документа", "Дата", "occurred_at", "date"],
    "number": ["REGISTRATION_NUMBER", "Регистрационный номер ЭСФ", "Номер ЭСФ", "Номер платежного поручения", "Номер платежа", "Номер документа", "Номер договора", "document_number", "number"],
    "reference": ["Номер связанного документа", "Основание", "Договор", "Договор основание", "Номер счета-фактуры", "reference", "contract_number"],
    "purpose": ["Назначение платежа", "Предмет договора", "Наименование ТРУ", "Наименование товара", "Описание", "purpose", "description"],
    "currency": ["Валюта", "Код валюты", "currency"],
    "status": ["Статус ЭСФ", "Статус", "status"],
    "debit": ["Дебет", "Расход", "Списание", "debit"],
    "credit": ["Кредит", "Приход", "Зачисление", "credit"],
    "counterpartyId": ["БИН контрагента", "ИИН/БИН контрагента", "ИИН контрагента", "counterparty_id"],
    "counterpartyName": ["Наименование контрагента", "Контрагент", "counterparty_name"],
}


from bank_parser import BANK_ALIASES, bank_record, statement_context, pdf_bank_tables, bank_service_row
for field,aliases in BANK_ALIASES.items():
    # New date/name wrappers must not outrank existing invoice semantics.
    ALIASES[field]=list(dict.fromkeys(ALIASES.get(field,[])+aliases if field in ('date','number','currency','purpose') else aliases+ALIASES.get(field,[])))
EXTRA_ALIASES={
    "senderId":["Supplier BIN","Seller BIN","Supplier TIN","Поставщик БИН","Поставщик ИИН/БИН","Отправитель БИН","Сатушы БСН","Жеткізуші БСН"],
    "recipientId":["Buyer BIN","Customer BIN","Buyer TIN","Покупатель БИН","Получатель БИН","Покупатель ИИН/БИН","Сатып алушы БСН","Алушы БСН"],
    "senderName":["Supplier name","Seller name","Поставщик Наименование","Отправитель Наименование"],
    "recipientName":["Buyer name","Customer name","Покупатель Наименование","Получатель Наименование"],
    "amount":["Total amount","Document total","Invoice total","Сумма, тенге","Сумма (KZT)"],
    "lineAmount":["Line amount","Line total","Стоимость строки с НДС"],
    "date":["Transaction date","Booking date","Value date","Invoice date","Дата проводки","Дата валютирования","Операция күні"],
    "number":["Invoice number","Invoice no","Document no","Payment no","Номер операции","№ ЭСФ","№ документа"],
    "purpose":["Payment details","Payment purpose","Назначение","Описание операции","Төлем мақсаты"],
    "currency":["Currency code","Валюта счета","Валюта счёта","Валюта операции","Валюта платежа"],
    "goodsName":["Product name","Goods name","Service name","Наименование услуги","Товар/услуга"],
    "quantity":["Qty","Quantity of goods"],"unit":["UOM"],
    "vatTotal":["VAT total","Document VAT"],"lineVatAmount":["Line VAT"],"vatRate":["VAT %"],
    "status":["Invoice status"],"contractRef":["Contract no","Contract number"],
    "closing":["Balance","Остаток на счете","Остаток на счёте","Текущий остаток"],
}
for field,aliases in EXTRA_ALIASES.items():
    ALIASES[field]=list(dict.fromkeys(ALIASES.get(field,[])+aliases))
NORMALIZED_ALIASES={field:[norm(alias) for alias in aliases] for field,aliases in ALIASES.items()}

def columns(header):
    result, counts = [], {}
    for i, item in enumerate(header):
        label = clean(item) or f"Столбец {i + 1}"
        counts[label] = counts.get(label, 0) + 1
        result.append(label if counts[label] == 1 else f"{label} [#{counts[label]}]")
    return result


def infer(headers, custom):
    result = {}
    normalized={norm(h):h for h in headers}
    for field, aliases in NORMALIZED_ALIASES.items():
        for alias in aliases:
            found = normalized.get(alias)
            if found:
                result[field] = found
                break
        if field not in result and field in ("number", "senderName", "recipientName"):
            found = next((h for h in headers if any(norm(h).startswith(a) for a in aliases if len(a) > 15)), None)
            if found:
                result[field] = found
    # Repeated IIN/BIN can precede OR follow its party name. Resolve the nearby
    # semantic party block, never the absolute Excel letter or occurrence count.
    generic = [i for i, h in enumerate(headers) if norm(re.sub(r" \[#\d+\]$", "", h)) in ("иинбин", "биниин", "iinbin")]
    used = {headers.index(result[f]) for f in ("senderId","recipientId") if f in result}
    for id_field, name_field in (("senderId", "senderName"), ("recipientId", "recipientName")):
        if id_field not in result and name_field in result:
            idx = headers.index(result[name_field])
            nearby = [i for i in generic if 0 < abs(idx-i) <= 3 and i not in used]
            if nearby:
                chosen = min(nearby,key=lambda i:(abs(idx-i),i>idx))
                result[id_field] = headers[chosen]
                used.add(chosen)
    for field, header in custom.items():
        if field not in ALIASES:
            continue
        if header == "":
            result.pop(field, None)
        elif header in headers:
            result[field] = header
        else:
            raise ValueError(f"Столбец «{header}» отсутствует в таблице")
    # The combined role header is one counterparty block, never two parties.
    for target,other in [('senderId','counterpartyId'),('recipientId','counterpartyId'),('senderName','counterpartyName'),('recipientName','counterpartyName'),('senderAccount','counterpartyAccount'),('recipientAccount','counterpartyAccount')]:
        if target not in custom and result.get(target)==result.get(other) and 'отправителябенефициара' in norm(result.get(other,'')):
            result.pop(target,None)
    return result

infer.known_labels={label for labels in NORMALIZED_ALIASES.values() for label in labels}


def zip_checked(source):
    archive = zipfile.ZipFile(source)
    if sum(x.file_size for x in archive.infolist()) > MAX_UNZIPPED:
        archive.close()
        raise ValueError("Распакованный документ слишком велик (более 250 МБ)")
    return archive


def safe_xml(data):
    if re.search(br"<!\s*(DOCTYPE|ENTITY)", data, re.I):
        raise ValueError("XML с DTD/ENTITY не допускается")
    return ET.fromstring(data)


@contextmanager
def xlsx_workbook(source, *, data_only):
    from openpyxl import load_workbook
    # Uploaded originals have opaque storage names, not Office extensions.
    # Keep an independent binary stream open for each lazy workbook reader.
    with open(source, "rb") as stream:
        book = load_workbook(stream, read_only=True, data_only=data_only)
        try:
            yield book
        finally:
            book.close()


def xlsx_merges(source):
    from openpyxl.utils.cell import range_boundaries
    ns={"m":"http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    relationship="{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
    result={}
    with zip_checked(source) as archive:
        workbook=safe_xml(archive.read("xl/workbook.xml"))
        relationships=safe_xml(archive.read("xl/_rels/workbook.xml.rels"))
        targets={r.attrib.get("Id"):r.attrib.get("Target","") for r in relationships if r.attrib.get("TargetMode")!="External"}
        for sheet in workbook.findall("m:sheets/m:sheet",ns):
            target=targets.get(sheet.attrib.get(relationship),"")
            location=target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join("xl",target))
            if not location.startswith("xl/") or ".." in location.split("/"):
                raise ValueError("Некорректный путь листа Office")
            payload=archive.read(location)
            if re.search(br"<!\s*(DOCTYPE|ENTITY)",payload,re.I):
                raise ValueError("XML с DTD/ENTITY не допускается")
            ranges=[]
            for _,element in ET.iterparse(io.BytesIO(payload),events=("end",)):
                if element.tag.endswith("}mergeCell"):
                    c1,r1,c2,r2=range_boundaries(element.attrib["ref"])
                    if r2>MAX_ROWS+30 or c2>500 or len(ranges)>=10000:
                        raise ValueError("Объединённые ячейки выходят за допустимые границы таблицы")
                    ranges.append((r1,c1,r2,c2))
                element.clear()
            result[sheet.attrib["name"]]=ranges
    return result


def tables_from_file(source, name, options=None):
    options = options or {}
    ext = Path(name).suffix.lower()
    tables, text, pages = [], "", []
    if ext in (".png", ".jpg", ".jpeg", ".tif", ".tiff"):
        try:
            from PIL import Image
            from local_ocr import recognize
            if options.get("ocrEnabled") is False:
                return [], "", [], "needs_ocr"
            with Image.open(source) as image:
                if image.width * image.height > 40_000_000:
                    raise ValueError("Изображение превышает 40 млн пикселей")
                if getattr(image, "n_frames", 1) > 1:
                    raise ValueError("Многостраничный TIFF: преобразуйте все кадры в PDF, чтобы не потерять страницы.")
                result = recognize(image)
            page = {"page": 1, "text": result["text"], "ocr": result, "textSource": "ocr"}
            return [], result["text"], [page], "review" if result["text"].strip() else "needs_ocr"
        except Exception as error:
            return [], "", [{"page": 1, "text": "", "ocrError": str(error)[:500]}], "needs_ocr"
    if ext in (".csv", ".txt"):
        text = decode(source.read_bytes())
        try:
            dialect = csv.Sniffer().sniff(text[:65536], delimiters=";,\t|")
            values = list(csv.reader(io.StringIO(text), dialect, strict=True))
            if len(values) > 1 and max(map(len, values)) > 1:
                tables.append(("Текстовая таблица", values))
        except csv.Error:
            best=None
            for delimiter in (';',',','\t','|'):
                try:values=list(csv.reader(io.StringIO(text),delimiter=delimiter,strict=True))
                except csv.Error:continue
                if sum(len(row)>1 for row in values)<2:continue
                known=max((sum(norm(v) in infer.known_labels for v in row) for row in values),default=0)
                score=(known,sum(len(row)>1 for row in values))
                if best is None or score>best[0]:best=(score,values)
            if best:tables.append(('Текстовая таблица',best[1]))
    elif ext in (".xlsx", ".xls"):
        if ext=='.xls' and is_html_xls(source.read_bytes()[:1024]):
            tables,text=read_html_xls(source.read_bytes())
            return tables,text,[],"extracted"
        if ext == ".xlsx":
            with zip_checked(source):
                pass
        if ext == ".xlsx":
            merges=xlsx_merges(source)
            with xlsx_workbook(source, data_only=True) as book:
                for sheet in book:
                    if sheet.max_column and sheet.max_column > 500:
                        raise ValueError("Более 500 столбцов. Сократите диапазон таблицы.")
                    values = []
                    for row in sheet.iter_rows():
                        values.append([formatted_identifier_value(c.value,c.number_format) for c in row])
                        if len(values) > MAX_ROWS + 30:
                            raise ValueError("Более 100 000 строк. Разделите файл.")
                    tables.append((sheet.title, SourceRows(values,merges.get(sheet.title,[]))))
        else:
            import xlrd
            book = xlrd.open_workbook(source, on_demand=True, formatting_info=True)
            try:
                for sheet in book.sheets():
                    if sheet.nrows > MAX_ROWS + 30 or sheet.ncols > 500:
                        raise ValueError("Таблица превышает 100 000 строк или 500 столбцов. Разделите файл.")
                    values = []
                    for i in range(sheet.nrows):
                        values.append([xlrd.xldate_as_datetime(c.value, book.datemode).isoformat() if c.ctype == xlrd.XL_CELL_DATE else formatted_identifier_value(c.value,book.format_map.get(book.xf_list[c.xf_index].format_key).format_str if c.ctype==xlrd.XL_CELL_NUMBER and book.format_map.get(book.xf_list[c.xf_index].format_key) else "") for c in sheet.row(i)])
                    tables.append((sheet.name, SourceRows(values,[(r1+1,c1+1,r2,c2) for r1,r2,c1,c2 in sheet.merged_cells])))
            finally:
                book.release_resources()
    elif ext == ".json":
        data = json.loads(decode(source.read_bytes()), parse_float=str, object_pairs_hook=unique_json_object)
        if isinstance(data, dict):
            candidates = [(k, v) for k, v in data.items() if isinstance(v, list)]
            if not candidates:
                candidates = [("JSON", [data])]
        else:
            candidates = [("JSON", data)]
        for label, rows in candidates:
            if isinstance(rows, list) and rows and all(isinstance(r, dict) for r in rows):
                headers = list(dict.fromkeys(key for row in rows for key in row))
                tables.append((label, [headers] + [[json.dumps(r.get(h), ensure_ascii=False) if isinstance(r.get(h), (dict, list)) else clean(r.get(h)) for h in headers] for r in rows]))
        text = json.dumps(data, ensure_ascii=False, indent=2)
    elif ext == ".xml":
        tree = safe_xml(source.read_bytes())
        groups = {}
        for parent in tree.iter():
            children = list(parent)
            if len(children) >= 2 and all(len(list(c)) == 0 for c in children):
                headers = tuple(c.tag.split("}")[-1] for c in children)
                groups.setdefault(headers, []).append([clean(c.text) for c in children])
        for i, (headers, rows) in enumerate(groups.items()):
            tables.append((f"XML {i + 1}", [list(headers)] + rows))
        text = "\n".join(clean(e.text) for e in tree.iter() if clean(e.text))
    elif ext == ".docx":
        with zip_checked(source) as archive:
            tree = safe_xml(archive.read("word/document.xml"))
        ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
        content = lambda el: "".join(t.text or "" for t in el.findall(".//w:t", ns))
        text = "\n".join(content(p) for p in tree.findall(".//w:p", ns))
        for i, table in enumerate(tree.findall(".//w:tbl", ns)):
            tables.append((f"Таблица Word {i + 1}", [[content(c) for c in r.findall("w:tc", ns)] for r in table.findall("w:tr", ns)]))
    elif ext == ".pdf":
        try:
            from pypdf import PdfReader
        except ImportError:
            raise ValueError("Для PDF установите pypdf из requirements.txt")
        reader = PdfReader(source)
        if reader.is_encrypted and not reader.decrypt(""):
            raise ValueError("PDF защищён паролем. Загрузите разрешённую незашифрованную копию.")
        if len(reader.pages) > 1000:
            raise ValueError("PDF содержит более 1000 страниц. Разделите файл.")
        for i, page in enumerate(reader.pages):
            extracted = page.extract_text() or ""
            pages.append({"page": i + 1, "text": extracted, "textSource": "native"})
            if extracted.strip():
                try:
                    pages[-1]["tableText"]=page.extract_text(extraction_mode="layout") or ""
                except Exception:
                    pass
            if not extracted.strip():
                try:
                    resources = page.get("/Resources")
                    resources = resources.get_object() if resources else {}
                    objects = resources.get("/XObject", {})
                    objects = objects.get_object() if hasattr(objects, "get_object") else objects
                    sizes = [(obj.get_object().get("/Width"), obj.get_object().get("/Height")) for obj in objects.values()]
                    sizes = [(int(w), int(h)) for w, h in sizes if w and h]
                    pages[-1]["sourceImagesPixels"] = sizes
                    pages[-1]["lowSourceResolution"] = bool(sizes and max(max(pair) for pair in sizes) < 1800)
                except Exception:
                    pass
            if sum(len(p["text"]) for p in pages) > MAX_TEXT:
                raise ValueError("Текст документа слишком велик. Разделите файл.")
        from local_ocr import read_pdf_pages
        pages = read_pdf_pages(source, pages, enabled=options.get("ocrEnabled") is not False,reuse_pages=options.get("reuseReadPages"))
        text = "\n\n".join(p["text"] for p in pages)
        tables.extend(pdf_bank_tables(pages,infer))
        if not text.strip():
            return [], "", pages, "needs_ocr"
    else:
        raise ValueError("Формат не поддерживается для извлечения")
    return tables, text, pages, "extracted"


def formula_audit(source, name):
    result = {"errorCount": 0, "errors": [], "formulaCount": 0,
              "periodMismatchCount": 0, "periodMismatches": [], "sourceFormulas": [], "missingCacheCount":0,"missingCaches":[]}
    if Path(name).suffix.lower() != ".xlsx":
        return result
    from openpyxl.utils.cell import column_index_from_string
    with xlsx_workbook(source, data_only=False) as formulas, xlsx_workbook(source, data_only=True) as cached:
        for sheet in formulas:
            energy_columns = None
            # Only the explicit monthly consumption layout is eligible. A random /24/N formula is not.
            for header in cached[sheet.title].iter_rows(max_row=min(30, sheet.max_row or 30), values_only=True):
                labels = [norm(v) for v in header]
                quantity = next((i for i, v in enumerate(labels) if v in ("колвообъем", "количествообъем")), None)
                billing = next((i for i, v in enumerate(labels) if v == "датасовершенияоборота"), None)
                if quantity is not None and billing is not None and "наименованиетру" in labels and "квтчас" in labels:
                    energy_columns = (quantity, billing)
                    break
            for row, values in zip(sheet.iter_rows(), cached[sheet.title].iter_rows()):
                for cell, value in zip(row, values):
                    if cell.data_type == "f":
                        result["formulaCount"] += 1
                        result["sourceFormulas"].append({"sheet": sheet.title, "cell": cell.coordinate,
                            "row": cell.row, "column": cell.column, "formula": clean(cell.value), "cached": clean(value.value)})
                        if value.value is None:
                            result["missingCacheCount"]+=1
                            if len(result["missingCaches"])<200:result["missingCaches"].append({"sheet":sheet.title,"cell":cell.coordinate,"row":cell.row,"column":cell.column,"formula":clean(cell.value)})
                    if energy_columns and cell.data_type == "f":
                        match = re.fullmatch(r"=\s*\$?([A-Za-z]{1,3})\$?(\d+)\s*/\s*24\s*/\s*(\d{1,2})\s*", clean(cell.value))
                        quantity, billing = energy_columns
                        billing_date = date(values[billing].value) if billing < len(values) else ""
                        if match and int(match[2]) == cell.row and column_index_from_string(match[1]) == quantity + 1 and billing_date:
                            parsed = dt.date.fromisoformat(billing_date)
                            days, divisor = calendar.monthrange(parsed.year, parsed.month)[1], int(match[3])
                            if divisor != days:
                                result["periodMismatchCount"] += 1
                                if len(result["periodMismatches"]) < 200:
                                    result["periodMismatches"].append({"sheet": sheet.title, "cell": cell.coordinate, "row": cell.row,
                                        "formula": clean(cell.value), "billingDate": billing_date, "formulaDays": divisor, "calendarDays": days})
                    if cell.data_type == "e" or value.data_type == "e":
                        result["errorCount"] += 1
                        if len(result["errors"]) < 200:
                            result["errors"].append({"sheet": sheet.title, "cell": cell.coordinate, "formula": clean(cell.value) if cell.data_type == "f" else "", "error": clean(value.value)})
    return result


def document_profile(options, text, tables):
    kind, group = options.get("typeId"), options.get("groupId")
    activity_header={'времядействия','типдействия','типпользователя'}
    if any(activity_header <= {norm(v) for v in row} for _,values in tables for row in values[:20]):
        return {"kind":"bank_activity_log","requiresFactReview":False,
                "note":"Журнал действий интернет-банка прочитан как контекст: входы, просмотр и действия пользователей не являются банковскими переводами. Для движения денег загрузите выписку по счёту."}
    if group == "tax" and kind == "cameral_notices":
        return {"kind": "cameral_notices", "requiresFactReview": False,
                "note": "Реестр уведомлений камерального контроля прочитан как налоговый контекст. Сумма по уведомлению не является оборотом, оплатой, установленной недоимкой или ущербом. Денежные операции не создаются."}
    if group == "tax" and kind == "tax_account_statement":
        return {"kind": "tax_account_statement", "requiresFactReview": True,
                "note": "Налоговый лицевой счёт сохранён отдельно от денежных операций. Начисления, платежи, зачёты и возвраты не складываются между периодами и версиями без проверки."}
    if group == "accounting" and kind == "reconciliation_act":
        return {"kind": "reconciliation_act", "requiresFactReview": True,
                "note": "Акт сверки — свод взаиморасчётов, а не самостоятельный платёж. Остатки, обороты, поставки и перечисления из него не создают повторные денежные операции. Проверьте период, стороны, валюту и ссылки на первичные документы."}
    if group == "unclassified" and kind == "mixed_bundle":
        return {"kind": "mixed_bundle", "requiresFactReview": True,
                "note": "Файл отмечен как составной пакет. Проверьте предложенные границы и виды в постраничном разборе; многостраничный договор не следует делить на независимые операции. OCR не подтверждает правильность реквизитов."}
    if group == "tax" and kind in ("declaration_100", "declaration_220", "declaration_300"):
        # PDF checkbox positions and boxed digits are not reconstructed from reading order.
        return {"kind": "tax_declaration", "forms": sorted(set(re.findall(r"(?<![\d.])(?:100|220|300)\.00(?!\d)", text))),
                "requiresFactReview": True,
                "note": "Распознан вид декларации. БИН/ИИН, период, вид (очередная/дополнительная) и суммы нужно сверить с оригиналом. Пустая клетка не означает ноль; декларация не является платежом."}
    if group == "tax" and kind == "registration_data":
        return {"kind": "registration_data", "requiresFactReview": True,
                "note": "Регистрационные сведения сохранены отдельно от операций. Идентификатор организации, руководителя и учредителей нельзя подменять друг другом; связи требуют проверки по оригиналу."}
    if group == "expert" and kind == "mining_calculation":
        sections = []
        for label, values in tables:
            headers = " ".join(clean(v).lower() for row in values[:3] for v in row)
            role = "equipment" if "hashrate" in headers and "потребление" in headers else "expected_reward" if "difficulty" in headers and "награда" in headers else "wallet_receipts" if "receivingaddress" in norm(headers) else "energy" if "наименование тру" in headers and "квт" in headers else "exchange_rates" if "usd/kzt" in headers and "btc/kzt" in headers else "supporting"
            sections.append({"sheet": label, "role": role})
        return {"kind": "mining_calculation", "requiresFactReview": True, "sections": sections,
                "note": "Оборудование, энергопотребление, ожидаемая награда, строки поступлений на кошельки и курсы хранятся раздельно. Расчётная награда не равна фактическому доходу или ущербу. Формулы и внешние источники не исполняются и не проверяются автоматически."}
    return None


def extract(source, name, options):
    tables, text, pages, status = tables_from_file(source, name, options)
    if len(text) > MAX_TEXT:
        raise ValueError("Более 8 млн символов. Разделите документ на части.")
    result = {"version": 1, "status": status, "text": text if pages or not tables or Path(name).suffix.lower() in (".docx", ".txt") else "", "pages": pages,
              "tables": [], "rows": [], "warnings": [], "unparsedRows": 0, "formulaAudit": formula_audit(source, name)}
    if pages:
        # Text presence is coverage only, not proof of successful field recognition. Never call a blank scan a zero-value record.
        unread = [p["page"] for p in pages if not p.get("text", "").strip()]
        ocr_pages = [p["page"] for p in pages if p.get("textSource") == "ocr"]
        result["pageAudit"] = {"totalPages": len(pages), "pagesWithText": len(pages) - len(unread), "pagesWithoutText": unread,
                               "ocrPerformed": bool(ocr_pages), "ocrPages": ocr_pages,
                               "qualityPages": [p["page"] for p in pages if p.get("lowSourceResolution") or p.get("ocr", {}).get("qualityReviewRequired")],
                               "errors": [{"page": p["page"], "error": p["ocrError"]} for p in pages if p.get("ocrError")]}
        if result["pageAudit"]["qualityPages"]:
            result["warnings"].append("Есть страницы с низким разрешением исходного растра или низким диагностическим качеством OCR. Наличие текста не означает точность цифр; при возможности получите скан лучшего качества.")
        if ocr_pages:
            result["warnings"].append("Выполнено локальное OCR. Возможны ошибки букв, цифр и порядка колонок. Сверьте реквизиты с оригиналом.")
            if any(not p.get("ocr", {}).get("kazakhAvailable") for p in pages if p.get("textSource") == "ocr"):
                result["warnings"].append("Казахский языковой пакет OCR недоступен. Распознавание казахского текста, ФИО и адресов требует особой проверки.")
        if unread:
            result["warnings"].append(f"Без извлекаемого текста: {len(unread)} из {len(pages)} страниц. Это могут быть сканы, пустые страницы или графика. Содержимое этих страниц не распознано. Не считайте файл полностью прочитанным.")
    kind = options.get("typeId", "")
    result["documentProfile"] = document_profile(options, text, tables)
    result["contextOnly"] = options.get("groupId") == "correspondence" or result["documentProfile"] is not None
    operation_type = "context" if options.get("groupId") in ("correspondence", "unclassified") or result["contextOnly"] else "invoice" if kind == "invoice" else "payment" if options.get("groupId") == "bank" else "contract" if options.get("groupId") == "contract" else "primary" if options.get("groupId") == "primary" else "reimbursement" if options.get("groupId") == "reimbursement" else "claim" if options.get("groupId") == "victim" else "accounting"
    custom = options.get("mapping", {})
    if not isinstance(custom, dict):
        raise ValueError("Некорректная настройка столбцов")
    filename_owner = re.search(r"(?<!\d)(\d{12})(?!\d)", name)
    owner = identifier(options.get("ownerId")) or (filename_owner.group(1) if filename_owner and operation_type!='payment' else "")
    # Bank ownership is resolved below from each table's preamble, not the
    # entire workbook body or the filename.
    result["bankStatementTables"]=bool(pages and any(label.startswith("PDF bank ") for label,_ in tables))
    direction = clean(options.get("direction")) or ("purchase" if "приоб" in name.lower() else "sale" if "реал" in name.lower() else "")
    manual = options.get("documentFields")
    if manual and not tables and text.strip():
        if not options.get("manualConfirmed"):
            raise ValueError("Подтвердите сверку введённых реквизитов с оригиналом")
        if not identifier(manual.get("senderId")) or not identifier(manual.get("recipientId")) or money(manual.get("amount")) is None or not date(manual.get("date")) or not re.fullmatch(r"[A-Z]{3}", clean(manual.get("currency")).upper()):
            raise ValueError("Для реквизитов документа нужны обе стороны, сумма, дата и валюта")
        headers = [ALIASES[key][0] for key in manual if key in ALIASES]
        table_values = [manual[key] for key in manual if key in ALIASES]
        tables = [("Реквизиты, введённые специалистом", [headers, table_values])]
    settings=options.get('tableSettings',[])
    if not isinstance(settings,list) or len(settings)>200:
        raise ValueError('Некорректная настройка отдельных таблиц')
    keys=set()
    for setting in settings:
        if not isinstance(setting,dict) or set(setting)-{'sheet','headerRow','headerDepth','endRow','mapping','dateOrder'} or not isinstance(setting.get('sheet'),str) or not isinstance(setting.get('headerRow'),int) or isinstance(setting.get('headerRow'),bool) or setting['headerRow']<1 or not isinstance(setting.get('headerDepth',1),int) or setting.get('headerDepth',1) not in (1,2,3) or 'endRow' in setting and (not isinstance(setting['endRow'],int) or setting['endRow']<1) or setting.get('dateOrder','') not in ('','DMY','MDY','YMD'):
            raise ValueError('Укажите лист, строку заголовка и допустимые границы таблицы')
        if not isinstance(setting.get('mapping',{}),dict) or any(k not in ALIASES or not isinstance(v,str) or len(v)>1000 for k,v in setting.get('mapping',{}).items()):
            raise ValueError('Некорректное соответствие столбцов таблицы')
        key=(setting['sheet'],setting['headerRow'])
        if key in keys:raise ValueError('Повторная настройка одной таблицы')
        keys.add(key)
    if any(s['sheet'] not in {label for label,_ in tables} for s in settings):
        raise ValueError('Лист из настройки отсутствует в документе')
    quality=create_quality(tables)
    quality['read']=status!='needs_ocr' and bool(tables or text.strip())
    result['quality']=quality
    plans=[]
    if sum(len(v) for _,v in tables)>100030:
        raise ValueError('Более 100 030 исходных строк. Разделите документ; частичный импорт не выполнен.')
    for sheet_number,(label,values) in enumerate(tables,1):
        regions=discover(label,values,infer,settings)
        if result['documentProfile'] and result['documentProfile']['kind']=='bank_activity_log':
            activity_row=next((i for i,row in enumerate(values,1) if {'времядействия','типдействия','типпользователя'} <= {norm(v) for v in row}),None)
            if activity_row:regions=discover(label,values,infer,[{'sheet':label,'headerRow':activity_row}])
        base_preamble=values[:regions[0]['headerRow']-1] if regions else []
        active_preamble=base_preamble
        for table_number,region in enumerate(regions,1):
            region.update({'values':values,'sheetNumber':sheet_number,'tableId':f'S{sheet_number}R{region["headerRow"]}'})
            context_start=regions[table_number-2]['dataStart']-1 if table_number>1 else 0
            context_labels={norm(v) for key in ('ownerId','ownerAccount','ownerName') for v in BANK_ALIASES[key]}|{'валюта','валютасчета','accountcurrency','currency','иинбин','биниин','периодвыписки','период'}
            local=[row for row in values[context_start:region['headerRow']-1] if row and norm(row[0]) in context_labels]
            if local and table_number>1:active_preamble=local
            region['preamble']=active_preamble
            plans.append(region)
    all_headers={h for p in plans for h in p['columns']}
    if any(v and v not in all_headers for v in custom.values()):raise ValueError('Столбец из общей настройки отсутствует в документе')
    formulas={(f['sheet'],f['row'],f['column']):f for f in result['formulaAudit']['sourceFormulas']}
    for plan in plans:
        label,values,headers=plan['sheet'],plan['values'],plan['columns']
        local_custom={k:v for k,v in custom.items() if not v or v in headers}
        local_custom.update(plan['settings'].get('mapping',{}))
        mapping=infer(headers,local_custom)
        if operation_type == "invoice" and mapping.get("amount") and (
            mapping["amount"] == mapping.get("taxBase") or norm(re.sub(r" \[#\d+\]$", "", mapping["amount"])) in NORMALIZED_ALIASES["taxBase"]
        ):
            del mapping["amount"]
        slash_orders=set()
        if mapping.get('date') in headers:
            col=headers.index(mapping['date'])
            for source_row in values[plan['dataStart']-1:plan['endRow']]:
                raw_date=clean(source_row[col]) if col<len(source_row) else ''
                # An explicit day-first format in this table supplies a convention,
                # not an invented date. Conflicting conventions remain unresolved.
                if re.fullmatch(r'\d{1,2}[.-]\d{1,2}[.-]\d{4}',raw_date) and date(raw_date):slash_orders.add('DMY')
                part=re.fullmatch(r'(\d{1,2})/(\d{1,2})/(\d{4})',raw_date)
                if part:
                    a,b=int(part[1]),int(part[2])
                    if 12<a<=31 and 1<=b<=12:slash_orders.add('DMY')
                    if 12<b<=31 and 1<=a<=12:slash_orders.add('MDY')
        date_order=plan['settings'].get('dateOrder') or (next(iter(slash_orders)) if len(slash_orders)==1 else '')
        def table_date(value):
            raw=clean(value)
            slash=re.fullmatch(r'(\d{1,2})/(\d{1,2})/(\d{4})',raw)
            if slash:
                a,b=int(slash[1]),int(slash[2])
                if not date_order and a<=12 and b<=12 and a!=b:return ''
                order=date_order or ('MDY' if b>12 else 'DMY')
                if order=='YMD':return ''
                try:return dt.datetime.strptime(raw,'%m/%d/%Y' if order=='MDY' else '%d/%m/%Y').date().isoformat()
                except ValueError:return ''
            return date(value)
        base_names={h:norm(re.sub(r' \[#\d+\]$','',h)) for h in headers}
        ambiguous={f:[h for h in headers if base_names[h]==base_names[column]] for f,column in mapping.items() if f not in local_custom and sum(base_names[h]==base_names[column] for h in headers)>1}
        for id_field,name_field in (('senderId','senderName'),('recipientId','recipientName')):
            if id_field in ambiguous and name_field in mapping and base_names[mapping[id_field]] in ('иинбин','биниин','iinbin'):
                other_field='recipientId' if id_field=='senderId' else 'senderId'
                candidates=[h for h in ambiguous[id_field] if h!=mapping.get(other_field)]
                origin=headers.index(mapping[name_field]);distances=[(abs(headers.index(h)-origin),h) for h in candidates]
                if not distances:continue
                nearest=min(d for d,_ in distances)
                if nearest<=3 and sum(d==nearest for d,_ in distances)==1:ambiguous.pop(id_field)
        context_text=pages[int(label.split()[-1])-1].get('text','') if label.startswith('PDF bank ') else text if not tables or label=='HTML-выгрузка XLS' else ''
        bank_context=statement_context(context_text,[(label,plan['preamble'])],options,owner,identifier)
        table_info={k:plan[k] for k in ('sheet','sheetNumber','tableId','headerRow','headerDepth','endRow')}
        table_info.update({'columns':headers,'mapping':mapping,'ambiguousFields':ambiguous,'dataRows':0,'dateOrder':date_order,'manualMapping':bool(local_custom),'unrecognized':bool(plan.get('unrecognized'))})
        result['tables'].append(table_info)
        quality['tables'].append(table_info.copy())
        result.setdefault('sourceTables',[]).append({'sheet':label,'sheetNumber':plan['sheetNumber'],'headerRow':plan['headerRow'],'columns':headers,'rows':[{'row':n,'values':[clean(v) for v in values[n-1]]} for n in range(plan['sourceStart'],plan['endRow']+1)]})
        for n in range(plan['sourceStart'],plan['dataStart']):quality_skipped(quality,label,n,'header' if n>=plan['headerRow'] else 'preamble',plan['tableId'])
        bank_footer=False
        for index in range(plan['dataStart'],plan['endRow']+1):
            original_cells=values[index-1]
            if operation_type=='payment' and bank_footer:
                quality_skipped(quality,label,index,'note',plan['tableId'])
                continue
            ignored=service_row(original_cells) or (bank_service_row(original_cells,mapping,headers) if operation_type=='payment' else '')
            if ignored:
                if operation_type=='payment' and ignored=='note' and re.match(r'^(?:руководитель|орындаушы|ответ[.]?\s*исполнитель|место\s+штампа)', ' '.join(clean(v) for v in original_cells[:3]).strip(),re.I):bank_footer=True
                quality_skipped(quality,label,index,ignored,plan['tableId'])
                continue
            cells,anchors=merged_values(values,index,plan['merges'])
            raw = {h: clean(original_cells[i]) if i < len(original_cells) else "" for i, h in enumerate(headers)}
            effective = {h:clean(cells[i]) if i<len(cells) else '' for i,h in enumerate(headers)}
            value = lambda field: effective.get(mapping.get(field), "")
            def party_identifier(field):
                column=mapping.get(field)
                source=cells[headers.index(column)] if column in headers and headers.index(column)<len(cells) else None
                if isinstance(source,ExcelNumeric) and re.fullmatch(r"\d{1,12}(?:\.0)?",source):
                    numeric=int(Decimal(source))
                    if numeric>0:return str(numeric).zfill(12)
                return identifier(value(field))
            sender, recipient = party_identifier("senderId"), party_identifier("recipientId")
            sender_name, recipient_name = value("senderName"), value("recipientName")
            inferred = False
            if owner and direction == "purchase" and sender and not recipient:
                recipient, inferred = owner, True
            elif owner and direction == "sale" and recipient and not sender:
                sender, inferred = owner, True
            document_amount, line_amount = value("amount"), value("lineAmount")
            amount = money(document_amount)
            amount_basis = "document_total"
            if amount is None and "lineAmount" in mapping and (operation_type != "invoice" or not document_amount):
                amount, amount_basis = money(line_amount), "line"
            invalid_invoice_total = operation_type == "invoice" and bool(document_amount) and amount is None
            debit, credit = money(value("debit")), money(value("credit"))
            if operation_type == "payment" and owner and identifier(value("counterpartyId")) and (bool(debit) != bool(credit)):
                if debit:
                    sender, recipient = owner, identifier(value("counterpartyId"))
                    recipient_name = value("counterpartyName")
                else:
                    recipient, sender = owner, identifier(value("counterpartyId"))
                    sender_name = value("counterpartyName")
                amount, inferred = abs(debit or credit), True
            amount_column = 'lineAmount' if amount_basis == 'line' else 'amount'
            currency_evidence=[currency(value('currency')) if value('currency') else 'UNKNOWN',explicit_currency(value(amount_column)),explicit_currency(mapping.get(amount_column,''))]
            if operation_type=='invoice' and line_amount:
                currency_evidence.append(explicit_currency(line_amount))
            if operation_type=='payment':currency_evidence.append(bank_context.get('currency','UNKNOWN'))
            known_currencies={c for c in currency_evidence if c!='UNKNOWN'}
            resolved_currency=currency(value('currency')) if value('currency') else next((c for c in currency_evidence if c!='UNKNOWN'),currency(options.get('defaultCurrency')))
            row = {"sheet": label, "row": index, "raw": raw, "type": operation_type,
                   "groupId": options.get("groupId"), "documentType": kind, "contractRef": value("contractRef"),
                   "senderId": sender, "recipientId": recipient, "senderName": sender_name, "recipientName": recipient_name,
                   "amountMinor": amount, "amountBasis": amount_basis, "date": table_date(value("date")) or (table_date(value("issueDate")) if operation_type=="invoice" else ""),
                   "currency": resolved_currency, "number": value("number"),
                   "reference": value("reference"), "purpose": value("purpose"), "status": value("status").upper(),
                   "inferredOwner": inferred, "lineNumber": value("lineNumber"),
                   "registrationNumber": norm(mapping.get("number", "")).startswith(("registrationnumber", "регистрационныйномерэсф")) or value("number").upper().startswith("ESF-")}
            row["attributes"] = {"itemCode": value("itemCode"), "quantity": value("quantity"), "unit": value("unit"),
                "unitPriceMinor": money(value("unitPrice")), "priceBasis": "WITH_VAT" if value("unitPrice") else "", "vatMinor": money(value("vatAmount")), "vatRate": value("vatRate"),
                "openingMinor": money(value("opening")), "incomingMinor": money(value("incoming")), "outgoingMinor": money(value("outgoing")), "closingMinor": money(value("closing")),
                "openingQuantity": value("openingQuantity"), "receivedQuantity": value("receivedQuantity"), "issuedQuantity": value("issuedQuantity"), "closingQuantity": value("closingQuantity"),
                "periodFrom": table_date(value("periodFrom")), "periodTo": table_date(value("periodTo")), "taxBaseMinor": money(value("taxBase")), "taxBasis": value("taxBasis"), "paymentRef": value("paymentRef")}
            row["manualSource"] = label == "Реквизиты, введённые специалистом"
            if options.get("groupId") == "tax":
                row["attributes"]["taxpayerId"] = identifier(value("taxpayerId"))
                row["attributes"]["taxType"] = value("taxType")
                for field in ("taxAccrued", "taxPaid", "taxOffset", "taxRefund", "taxArrears", "taxOverpayment"):
                    row["attributes"][field + "Minor"] = money(value(field))
            if operation_type=="invoice":
                row["esf"]={"kind":value("invoiceKind"),"baseNumber":value("baseInvoiceNumber"),"baseDate":table_date(value("baseInvoiceDate")),"issueDate":table_date(value("issueDate")),"goodsName":value("goodsName"),"lineAmountMinor":money(value("lineAmount")),"lineVatMinor":money(value("lineVatAmount")),"vatTotalMinor":money(value("vatTotal")),"quantity":value("quantity"),"unitPriceWithoutVatMinor":money(value("unitPriceWithoutVat")),"contractRef":value("contractRef")}
            if operation_type=="payment":
                bank_values=effective.copy()
                for field in ('senderId','recipientId','ownerId','counterpartyId'):
                    if field in mapping and party_identifier(field):bank_values[mapping[field]]=party_identifier(field)
                row.update(bank_record(bank_values,mapping,{**options,'defaultCurrency':row['currency'] if row['currency']!='UNKNOWN' else options.get('defaultCurrency','')},bank_context,money,table_date,identifier))
                row["automaticSource"]=not row["manualSource"]
                if label.startswith("PDF bank "):
                    row["attributes"]["sourcePage"]=int(label.split()[-1])
            # A line is retained even when incomplete; it never silently becomes a confirmed operation.
            provenance={}
            for field,column in mapping.items():
                if field=="date" and operation_type=="invoice" and not table_date(value("date")) and table_date(value("issueDate")):
                    column=mapping["issueDate"]
                column_index=headers.index(column)+1 if column in headers else 0
                letters=""
                number=column_index
                while number:
                    number,remainder=divmod(number-1,26)
                    letters=chr(65+remainder)+letters
                normalized_key={"amount":"amountMinor","vatAmount":"vatMinor","taxBase":"taxBaseMinor","unitPrice":"unitPriceMinor",**{name:name+"Minor" for name in ("taxAccrued","taxPaid","taxOffset","taxRefund","taxArrears","taxOverpayment")}}.get(field,field)
                normalized=row.get(normalized_key,row["attributes"].get(normalized_key))
                esf_key={"invoiceKind":"kind","baseInvoiceNumber":"baseNumber","baseInvoiceDate":"baseDate","issueDate":"issueDate","goodsName":"goodsName","unitPriceWithoutVat":"unitPriceWithoutVatMinor","vatTotal":"vatTotalMinor","lineVatAmount":"lineVatMinor"}.get(field)
                if esf_key and row.get("esf"):normalized=row["esf"].get(esf_key)
                provenance[field]={"raw":raw.get(column,""),"normalized":normalized,"sheet":label,"row":index,"column":column,
                    "cell":f"{letters}{index}" if Path(name).suffix.lower() in (".xlsx",".xls") and letters else "",
                    "page":row["attributes"].get("sourcePage"),"method":"ocr-table-column" if label.startswith("PDF bank ") and pages and pages[int(label.split()[-1])-1].get("textSource")=="ocr" else "table-column","confidence":None}
                if field in ("senderId","recipientId") and normalized and normalized!=raw.get(column,""):
                    source=cells[column_index-1] if column_index and column_index<=len(cells) else None
                    provenance[field]["method"]="excel-numeric-bin-iin-12-digit-schema" if isinstance(source,ExcelNumeric) else "identifier-text-normalization"
                if column_index-1 in anchors:
                    anchor_row,anchor_col=anchors[column_index-1]
                    from openpyxl.utils.cell import get_column_letter
                    provenance[field].update({'method':'excel-merged-cell','anchorCell':f'{get_column_letter(anchor_col)}{anchor_row}'})
                formula=formulas.get((label,index,column_index))
                if formula:provenance[field].update({'formula':formula['formula'],'method':'excel-formula-cache'})
            row["attributes"]["fieldSources"]=provenance
            conflicts=['currency'] if len(known_currencies)>1 else []
            for field,choices in ambiguous.items():
                source_values=[effective.get(h,'') for h in choices if effective.get(h,'')!='']
                comparable=[money(v) if field in ('amount','lineAmount','vatAmount','vatTotal','fee','debit','credit') else identifier(v) if field.endswith('Id') else table_date(v) if field in ('date','issueDate') else currency(v) if field=='currency' else clean(v) for v in source_values]
                if len(set(comparable))>1:conflicts.append(field)
            missing_formula=[field for field,column in mapping.items() if (label,index,headers.index(column)+1) in formulas and not formulas[(label,index,headers.index(column)+1)]['cached']]
            row['attributes']['extractionIssues']=[]
            if invalid_invoice_total:
                row['attributes']['invalidInvoiceTotal']=True
                row['attributes']['extractionIssues'].append({'code':'INVALID_INVOICE_TOTAL','message':'Итог ЭСФ не распознан. Сумма строки не заменяет ошибочный итог документа.','fields':['amount']})
            elif operation_type=='invoice' and amount_basis=='line' and line_amount and amount is None:
                row['attributes']['extractionIssues'].append({'code':'INVALID_INVOICE_LINE_AMOUNT','message':'Сумма товарной строки не распознана. Строка требует проверки.','fields':['lineAmount']})
            if re.fullmatch(r'\d{1,2}/\d{1,2}/\d{4}',value('date')) and not table_date(value('date')) and not date_order:
                row['attributes']['extractionIssues'].append({'code':'AMBIGUOUS_DATE_ORDER','message':'Неоднозначный порядок дня и месяца. Выберите ДД/ММ/ГГГГ или ММ/ДД/ГГГГ в настройках таблицы.','fields':['date']})
            if conflicts:
                row['attributes']['conflictingFields']=conflicts
                row['attributes']['extractionIssues'].append({'code':'CONFLICTING_CURRENCY' if len(known_currencies)>1 else 'AMBIGUOUS_COLUMNS','message':'Явные источники содержат разные валюты.' if len(known_currencies)>1 else 'Одинаковые заголовки содержат разные реквизиты. Выберите столбец явно.','fields':conflicts})
                row['amountMinor']=None
            if missing_formula:
                row['attributes']['extractionIssues'].append({'code':'MISSING_FORMULA_CACHE','message':'Нет сохранённого результата формулы Excel. Пересчитайте и сохраните разрешённую копию в Excel; формула не исполнялась.','fields':missing_formula})
                if any(f in {'amount','lineAmount','date','issueDate','senderId','recipientId','currency','debit','credit','signedAmount'} for f in missing_formula):row['amountMinor']=None
            row['tableId']=plan['tableId']
            table_info['dataRows']+=1
            quality['tables'][-1]['dataRows']+=1
            result["rows"].append(row)
            if assess_quality(quality,row,plan['tableId']):
                result["unparsedRows"] += 1
    if result["documentProfile"] and status != "needs_ocr":
        result["status"] = "extracted"
        result["unparsedRows"] = 0
        result["warnings"].append(result["documentProfile"]["note"])
    elif options.get("groupId") == "correspondence" and status != "needs_ocr":
        result["status"] = "extracted"
        result["unparsedRows"] = 0
        result["warnings"].append("Служебная переписка сохранена как контекст. Упомянутые реквизиты и суммы не становятся денежными операциями.")
    elif status == "needs_ocr":
        result["warnings"].append("Нужен OCR: текст не извлечён. Оригинал сохранён, операции не созданы.")
    elif result["rows"] and all(not r["senderId"] and not r["recipientId"] and r["amountMinor"] is None for r in result["rows"]):
        result["status"] = "needs_mapping"
        result["warnings"].append("Не распознаны основные поля. Настройте соответствие столбцов; операции не подтверждены.")
    elif not result['rows'] and operation_type=='payment' and plans and all('date' in t['mapping'] and ('debit' in t['mapping'] or 'credit' in t['mapping']) for t in result['tables']):
        result['status']='extracted'
        result['emptyBankStatement']=True
        result['warnings'].append('Таблица выписки прочитана. Платёжные строки не обнаружены; остатки и служебные строки сохранены в первоисточнике.')
    elif not result["rows"]:
        result["status"] = "review"
        result["warnings"].append("Текст прочитан. Надёжно выделить операции автоматически не удалось: требуется проверка специалистом.")
    if result["unparsedRows"]:
        if result['status']=='extracted':result['status']='review'
        result["warnings"].append(f"Неполные реквизиты в строках: {result['unparsedRows']}. См. исходные строки; суммы и стороны не выдумываются.")
    return result


if __name__ == "__main__":
    try:
        options = json.loads(sys.stdin.read() or "{}")
        output = extract(Path(sys.argv[1]), sys.argv[2], options)
        sys.stdout.reconfigure(encoding="utf-8")
        json.dump(output, sys.stdout, ensure_ascii=False, allow_nan=False)
    except Exception as error:
        sys.stderr.reconfigure(encoding="utf-8")
        print(str(error), file=sys.stderr)
        sys.exit(1)
