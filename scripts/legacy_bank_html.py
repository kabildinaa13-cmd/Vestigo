"""Read legacy HTML exports named .xls without executing scripts or fetching URLs."""
import re
from lxml import html
from table_layout import SourceRows


def is_html_xls(data):
    return bool(re.match(br'\s*(?:\xef\xbb\xbf)?\s*<(?:!doctype\s+html|html|head|table)\b',data[:1024],re.I))


def read_html_xls(data):
    parser=html.HTMLParser(no_network=True,remove_comments=True)
    root=html.fromstring(data,parser=parser)
    for node in root.xpath('//script|//style|//iframe|//object|//embed'):
        node.drop_tree()
    # Browser spreadsheets often split heading, column bands and movements
    # into consecutive tables. Keep their physical TR order in one source.
    values,merges,occupied=[],[],{}
    occupied_budget=0
    for tr in root.xpath('//table/tr|//table/thead/tr|//table/tbody/tr|//table/tfoot/tr'):
        if len(tr.xpath('ancestor::table'))!=1:
            raise ValueError('Вложенные HTML-таблицы: сохраните банковскую выгрузку в XLSX')
        number=len(values)+1;row=[];col=1
        for cell in tr.xpath('./th|./td'):
            while (number,col) in occupied:
                row.append('');col+=1
            try:rs,cs=int(cell.get('rowspan','1')),int(cell.get('colspan','1'))
            except ValueError:raise ValueError('Некорректные границы HTML-ячейки')
            if not 1<=rs<=100030 or not 1<=cs<=500 or col+cs-1>500 or number+rs-1>100030:
                raise ValueError('HTML-таблица превышает допустимые границы')
            occupied_budget+=rs*cs
            if occupied_budget>1000000:raise ValueError('Более 1 млн ячеек HTML-таблицы')
            text=' '.join(cell.text_content().replace('\u00a0',' ').split())
            if len(text)>1000000:raise ValueError('Слишком длинная HTML-ячейка')
            row.extend([text]+['']*(cs-1))
            if rs>1 or cs>1:
                merges.append((number,col,number+rs-1,col+cs-1))
                for r in range(number,number+rs):
                    for c in range(col,col+cs):
                        if (r,c)!=(number,col):occupied[(r,c)]=True
            col+=cs
        values.append(row)
        if len(values)>100030:raise ValueError('Более 100 030 строк HTML-таблицы')
    if not values:raise ValueError('В HTML-выгрузке XLS не найдена таблица')
    # Preserve a non-table statement heading as context without inventing Excel cells.
    heading='\n'.join(t.strip() for t in root.xpath('//text()[not(ancestor::table)]') if t.strip())
    return [('HTML-выгрузка XLS',SourceRows(values,merges))],heading
