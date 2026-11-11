"""Local report export from the authenticated server's evidence-backed snapshot. No network."""
import io
import json
import os
import sys
from decimal import Decimal
from pathlib import Path
from xml.sax.saxutils import escape

def text(value):
    return "Нет данных" if value is None else str(value)

def money(value):
    return None if value is None else Decimal(str(value)) / Decimal(100)

def location(s):
    return f"{s.get('name','Оригинал')}: " + (f"страница {s['page']}" if s.get('page') else f"{s.get('sheet','')}, строка {s.get('row','не указана')}")

def sources(items):
    return "\n".join(dict.fromkeys(location(s) for s in items))

LABELS={"purchase":"Приобретение по ЭСФ","sale":"Реализация по ЭСФ","supply":"Поставки по ЭСФ","purchaseVat":"НДС приобретения","saleVat":"НДС реализации","vat":"НДС из источников","bankIncoming":"Банковские поступления","bankOutgoing":"Банковские списания","bankFees":"Известные банковские комиссии","bankRefundIncoming":"Возвраты полученные","bankRefundOutgoing":"Возвраты выплаченные","bankCredited":"Зачисление по столбцу выписки"}

def sections(report):
    if 'customSections' in report:
        def cell(v):
            if isinstance(v, dict) and 'moneyMinor' in v:
                return money(v['moneyMinor'])
            return v
        for s in report['customSections']:
            yield s['title'], s['headers'], [[cell(v) for v in row] for row in s['rows']]
        return
    metrics=[]
    for key,label in LABELS.items():
        values=report['summary'].get(key,{})
        metrics.extend([[label,c,money(v)] for c,v in values.items()] or [[label,"",None]])
    counts=report['counts']
    metrics.extend([[label,"",counts.get(key)] for key,label in [("invoices","Действующих ЭСФ"),("sourceInvoiceRows","Исходных строк ЭСФ"),("goodsRows","Товарных строк выбранной версии"),("physicalFiles","Файлов с операциями"),("contracts","Выделенных договоров"),("contractReferences","Ссылок на договоры"),("documentedDeals","Документально установленных сделок")]])
    yield 'Показатели',['Показатель','Валюта','Значение'],metrics
    yield 'ЭСФ',['ЭСФ и дата','Поставщик и покупатель','Валюта','Сумма','Без НДС','НДС','Договор','Источники'],[[f"{i.get('number','')}\n{i.get('date','')}",f"{i.get('senderName','')} ({i.get('senderId','')})\n{i.get('recipientName','')} ({i.get('recipientId','')})",i['currency'],money(i['amountMinor']),money(i.get('netMinor')),money(i.get('vatMinor')),i.get('contractRef') or None,sources(i['sources'])] for i in report['invoices']]
    yield 'Товары и услуги',['ЭСФ','Оригинальное наименование','Категория','Количество','Единица','Цена без НДС','Стоимость строки','НДС строки','Валюта','Источник'],[[l.get('invoiceNumber'),l['name'],l['category'],l['quantity'],l['unit'],money(l['unitPriceWithoutVatMinor']),money(l['amountMinor']),money(l['vatMinor']),l['currency'],location(l['source'])] for l in report['lines']]
    yield 'Банковские операции',['Дата и номер','Отправитель','Получатель','Назначение','Класс','Валюта','Сумма операции','Комиссия в строке','Зачислено по выписке','Счета','Источники'],[[f"{e['date']}\n{e['transactionId']}",e['senderId'],e['recipientId'],e['purpose'],e['classification'],e['currency'],money(e['amountMinor']),money(e['feeMinor']),money(e['creditedMinor']),f"{e['senderAccount']}\n{e['recipientAccount']}",sources(e['sources'])] for e in report['bank']]
    yield 'Сверка',['ЭСФ','Валюта','Сумма ЭСФ','Подтверждено сотрудником','Разница','Статус','Источники'],[[x['invoice']['number'],x['invoice']['currency'],money(x['invoice']['amountMinor']),money(x['confirmedMinor']),money(x['differenceMinor']),x['status'],sources(x['invoice']['sources'])] for x in report['reconciliation']['items']]
    invoice_names={x['invoice']['id']:x['invoice']['number'] for x in report['reconciliation']['items']}
    payment_names={p['id']:p['number'] for p in [*report['reconciliation']['payments'],*report['reconciliation'].get('linkedPayments',[])]}
    yield 'Распределения',['ЭСФ','Платёж','Распределённая сумма','Метод','Обоснование'],[[invoice_names.get(a['invoiceId'],'ЭСФ вне фильтра'),payment_names.get(a['paymentId'],'Платёж вне фильтра'),money(a['amountMinor']),a['method'],a['explanation']] for a in report['reconciliation']['allocations']]
    yield 'Категории',['Категория','Исходные наименования','Валюта','Известная стоимость строк','Приобретение','Реализация','Строк','Строк без стоимости','Источники'],[[c['name'],'; '.join(c['originalNames']),c['currency'],money(c['amountMinor']),money(c['purchaseMinor']),money(c['saleMinor']),c['rows'],c['missingAmounts'],sources(c['sources'])] for c in report['categories']]
    yield 'Динамика',['Месяц','Валюта','Стоимость ЭСФ','Количество ЭСФ','Источники'],[[p['period'],p['currency'],money(p['amountMinor']),p['invoices'],sources(p['sources'])] for p in report['periods']]
    yield 'Вопросы проверки',['Описание','Правило','Статус','Источники'],[[r.get('description'),r.get('rule'),r.get('status'),sources(r.get('evidence',[]))] for r in report['risks']]
    yield 'Охват документов',['Файл','Статус чтения','Ошибка','Исключён'],[[d['name'],d['status'],d.get('error') or None,'Да' if d.get('excluded') else 'Нет'] for d in report['documents']]
    original_sources={}
    for entry in [*report['invoices'],*report['bank']]:
        for s in entry.get('sources',[]):original_sources[(s.get('documentId'),s.get('sheet'),s.get('row'),s.get('page'))]=s
    from urllib.parse import urlencode
    def source_url(s):
        base=report.get('sourceBaseUrl','')
        return base+'/api/documents/'+s['documentId']+'?'+urlencode({'caseId':report['caseId'],'inline':'1'})+(f"#page={s['page']}" if s.get('page') else '') if base and s.get('documentId') else None
    yield 'Источники',['Файл','Лист','Строка','Страница','Оригинал'],[[s.get('name'),s.get('sheet'),s.get('row'),s.get('page') or None,source_url(s)] for s in original_sources.values()]

def narratives(r):
    if 'customSections' in r:
        return r['narrative']
    f=r.get('filters',{})
    return [f"Дело {r['caseNumber']}. Период: {f.get('from') or 'все представленные даты'} — {f.get('to') or 'все представленные даты'}. Участник: {f.get('identifier') or 'все участники'}. Валюта: {f.get('currency') or 'раздельно по источникам'}.",*r['conclusions'],r['taxes']['note'],r['reconciliation']['methodology'],*r['notes'],f"Файлов в области: {r['coverage']['files']}; с ошибками: {len(r['coverage']['failed'])}; частично прочитано: {len(r['coverage']['partial'])}; ЭСФ без однозначного НДС: {r['coverage']['missingVat']}; банковских переводов без сведений о комиссии: {r['coverage']['missingFees']}."]

def export_xlsx(r):
    # Reuses the platform's installed openpyxl exporter stack; never evaluates input formulas.
    from openpyxl import Workbook
    from openpyxl.styles import Font,PatternFill,Alignment
    from openpyxl.utils import get_column_letter
    wb=Workbook();wb.remove(wb.active)
    intro=wb.create_sheet('Сводка');intro.append([r['title']]);intro['A1'].font=Font(name='Arial',size=18,bold=True)
    for p in narratives(r):intro.append([p]);intro.cell(intro.max_row,1).alignment=Alignment(wrap_text=True,vertical='top');intro.row_dimensions[intro.max_row].height=max(32,min(200,16*(len(p)//105+1)))
    intro.column_dimensions['A'].width=115
    for title,headers,rows in sections(r):
        if not rows:continue
        ws=wb.create_sheet(title[:31]);ws.append(headers);ws.freeze_panes='A2';ws.auto_filter.ref=f'A1:{get_column_letter(len(headers))}{max(1,len(rows)+1)}'
        for i,header in enumerate(headers,1):c=ws.cell(1,i);c.font=Font(name='Arial',bold=True,color='FFFFFF');c.fill=PatternFill('solid',fgColor='243A57');c.alignment=Alignment(wrap_text=True,vertical='center')
        ws.row_dimensions[1].height=38
        for row in rows:
            ws.append([None]*len(row));index=ws.max_row
            for col,v in enumerate(row,1):
                c=ws.cell(index,col);c.value='Нет данных' if v is None else v
                if isinstance(v,str) and len(v)>32000:c.value=v[:31000]+'\nСписок сокращён из-за лимита ячейки Excel. Полные реквизиты строк см. на листе Источники и в исходном документе.'
                if isinstance(v,Decimal):
                    if len(str(abs(v*100)).replace('.',''))>15:c.value=format(v,'.2f')
                    else:c.number_format='#,##0.00'
                elif isinstance(v,str):c.data_type='s'
                if isinstance(v,str) and v.startswith(('http://','https://')):c.hyperlink=v
                c.font=Font(name='Arial',size=11);c.alignment=Alignment(wrap_text=True,vertical='top')
            ws.row_dimensions[index].height=max(32,min(240,16*max((str(text(v)).count('\n')+len(str(text(v)))//45+1 for v in row),default=1)))
        for i,h in enumerate(headers,1):ws.column_dimensions[get_column_letter(i)].width=48 if any(t in h.lower() for t in ['источник','наименование','назначение','основание','описание']) else 24
        ws.sheet_view.showGridLines=False;ws.sheet_properties.pageSetUpPr.fitToPage=True;ws.page_setup.orientation='landscape';ws.page_setup.paperSize=ws.PAPERSIZE_A3;ws.page_setup.fitToWidth=1;ws.page_setup.fitToHeight=0;ws.print_title_rows='1:1'
    out=io.BytesIO();wb.save(out);return out.getvalue()

def export_docx(r):
    from docx import Document
    from docx.shared import Inches,Pt,RGBColor
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    doc=Document();section=doc.sections[0];section.page_width=Inches(8.5);section.page_height=Inches(11);section.top_margin=section.bottom_margin=Inches(.7);section.left_margin=section.right_margin=Inches(.7)
    normal=doc.styles['Normal'];normal.font.name='Arial';normal.font.size=Pt(11);normal.paragraph_format.space_after=Pt(8)
    for style in ['Title','Heading 1','Heading 2']:doc.styles[style].font.color.rgb=RGBColor(0,0,0)
    doc.add_paragraph(r['title'],style='Title')
    for p in narratives(r):doc.add_paragraph(p)
    for title,headers,rows in sections(r):
        if not rows:continue
        doc.add_heading(title,level=1)
        if not rows:doc.add_paragraph('Нет данных в выбранном массиве.');continue
        # Wide source ledgers become individual records so text remains readable on printed pages.
        if len(headers)>4:
            for n,row in enumerate(rows,1):
                doc.add_heading(f'Запись {n}',level=2)
                for k,v in zip(headers,row):p=doc.add_paragraph();p.add_run(k+': ').bold=True;p.add_run(text(v))
        else:
            table=doc.add_table(rows=1,cols=len(headers));table.style='Table Grid'
            for c,h in zip(table.rows[0].cells,headers):c.text=h
            trpr=table.rows[0]._tr.get_or_add_trPr();repeat=OxmlElement('w:tblHeader');trpr.append(repeat)
            for row in rows:
                for c,v in zip(table.add_row().cells,row):c.text=text(v)
            for row in table.rows:
                for c in row.cells:
                    for p in c.paragraphs:
                        for run in p.runs:run.font.size=Pt(10)
    out=io.BytesIO();doc.save(out);return out.getvalue()

def export_pdf(r):
    from reportlab.platypus import SimpleDocTemplate,Paragraph,Spacer,Table,TableStyle,CondPageBreak
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.lib import colors
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    fonts=[Path(os.environ.get('WINDIR','C:/Windows'))/'Fonts/arial.ttf',Path('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')]
    font=next((f for f in fonts if f.is_file()),None)
    if not font:raise ValueError('Для PDF нужен локальный шрифт Arial или DejaVu Sans с кириллицей')
    pdfmetrics.registerFont(TTFont('VestigoText',str(font)));styles=getSampleStyleSheet()
    for name in ['Normal','Title','Heading1','Heading2']:styles[name].fontName='VestigoText'
    styles['Normal'].fontSize=10.5;styles['Normal'].leading=15;styles['Title'].fontSize=20;styles['Title'].leading=26
    styles['Heading1'].keepWithNext=False;styles['Heading2'].keepWithNext=True
    p=lambda value:Paragraph(escape(text(value)).replace('\n','<br/>'),styles['Normal'])
    out=io.BytesIO();doc=SimpleDocTemplate(out,pagesize=(612,792),leftMargin=48,rightMargin=48,topMargin=44,bottomMargin=44,title=r['title'],author='Vestigo');flow=[Paragraph(escape(r['title']),styles['Title']),Spacer(1,14)]
    for value in narratives(r):flow.extend([p(value),Spacer(1,8)])
    for title,headers,rows in sections(r):
        if not rows:continue
        flow.extend([CondPageBreak(90),Paragraph(title,styles['Heading1'])])
        if not rows:flow.extend([p('Нет данных в выбранном массиве.'),Spacer(1,8)]);continue
        if len(headers)>4:
            for n,row in enumerate(rows,1):
                flow.append(Paragraph(f'Запись {n}',styles['Heading2']))
                for k,v in zip(headers,row):flow.extend([p(k+': '+text(v)),Spacer(1,4)])
                flow.append(Spacer(1,8))
        else:
            table=Table([[p(v) for v in headers]]+[[p(v) for v in row] for row in rows],colWidths=[516/len(headers)]*len(headers),repeatRows=1,hAlign='LEFT',splitInRow=1)
            table.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),colors.HexColor('#E8EEF5')),('GRID',(0,0),(-1,-1),.4,colors.HexColor('#D9D9D9')),('VALIGN',(0,0),(-1,-1),'TOP'),('TOPPADDING',(0,0),(-1,-1),8),('BOTTOMPADDING',(0,0),(-1,-1),8),('LEFTPADDING',(0,0),(-1,-1),8),('RIGHTPADDING',(0,0),(-1,-1),8)]));flow.extend([table,Spacer(1,12)])
    doc.build(flow);return out.getvalue()

if __name__=='__main__':
    payload=json.load(sys.stdin);kind=sys.argv[1] if len(sys.argv)>1 else ''
    exporters={'xlsx':export_xlsx,'docx':export_docx,'pdf':export_pdf}
    if kind not in exporters:raise ValueError('Неподдерживаемый формат')
    sys.stdout.buffer.write(exporters[kind](payload))
