"""Portable Excel export. Uses openpyxl and standard DrawingML, no embedded third-party runtime."""
from __future__ import annotations
import io
import json
import math
import re
import sys
import zipfile
from datetime import datetime
from xml.etree import ElementTree as ET
from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.worksheet.table import Table, TableStyleInfo
from openpyxl.worksheet.page import PageMargins
from openpyxl.utils import get_column_letter

XDR="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"
A="http://schemas.openxmlformats.org/drawingml/2006/main"
R="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
S="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
PKG="http://schemas.openxmlformats.org/package/2006/relationships"
CT="http://schemas.openxmlformats.org/package/2006/content-types"
ET.register_namespace("xdr",XDR)
ET.register_namespace("a",A)
ET.register_namespace("r",R)
NAVY="0B315C"
PALE="EAF3FC"
EMU=9525

def tag(parent,namespace,local_name,**attributes):
    return ET.SubElement(parent,"{"+namespace+"}"+local_name,{key:str(value) for key,value in attributes.items()})

def identifier_label(value):
    value=str(value or "")
    return "IBAN "+value[5:] if value.startswith("IBAN:") else "БИН/ИИН "+value

def text(value):
    return re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", str(value or ""))

def number(value,default=0):
    try:
        result=float(value)
        return result if math.isfinite(result) else default
    except (ValueError,TypeError):
        return default

def cell_value(cell,value):
    # Every external string is literal data, including strings beginning with "=".
    cell.value=text(value) if isinstance(value,str) else value
    if isinstance(value,str):
        cell.data_type="s"

def title(sheet,title_text,columns,subtitle=""):
    sheet.sheet_view.showGridLines=False
    sheet.merge_cells(start_row=1,start_column=1,end_row=2,end_column=columns)
    cell_value(sheet.cell(1,1),title_text)
    sheet.cell(1,1).font=Font(name="Arial",size=17,bold=True,color="FFFFFF")
    sheet.cell(1,1).fill=PatternFill("solid",fgColor=NAVY)
    sheet.cell(1,1).alignment=Alignment(vertical="center",wrap_text=True)
    if subtitle:
        sheet.merge_cells(start_row=3,start_column=1,end_row=3,end_column=columns)
        cell_value(sheet.cell(3,1),subtitle)
        sheet.cell(3,1).fill=PatternFill("solid",fgColor=PALE)
        sheet.cell(3,1).font=Font(name="Arial",size=11,color="5F7289")

def data_table(sheet,headers,rows,name,widths):
    for col,header in enumerate(headers,1):
        cell=sheet.cell(5,col)
        cell_value(cell,header)
        cell.font=Font(name="Arial",bold=True,color="FFFFFF")
        cell.fill=PatternFill("solid",fgColor=NAVY)
        sheet.column_dimensions[get_column_letter(col)].width=widths.get(col,17)
    for row_index,row in enumerate(rows,6):
        for col,value in enumerate(row,1):
            cell=sheet.cell(row_index,col)
            cell_value(cell,value)
            cell.font=Font(name="Arial",size=11,color="102A4C")
            cell.alignment=Alignment(vertical="top",wrap_text=True)
            cell.border=Border(bottom=Side(style="hair",color="C9D9EA"))
    sheet.row_dimensions[5].height=32
    sheet.freeze_panes="A6"
    if rows:
        table=Table(displayName=name,ref=f"A5:{get_column_letter(len(headers))}{len(rows)+5}")
        table.tableStyleInfo=TableStyleInfo(name="TableStyleMedium2",showRowStripes=True)
        sheet.add_table(table)

def drawing(options):
    payload=options.get("diagramPayload") or options["payload"]
    nodes=payload.get("nodes",[])
    edges=payload.get("edges",[])
    layout=options.get("diagramLayout") or {}
    positions=layout.get("positions") or {}
    root=ET.Element("{"+XDR+"}wsDr")
    origin_x,origin_y=44,154
    node_ids={text(node.get("bin")):i+100 for i,node in enumerate(nodes)}
    next_id=len(nodes)+100

    def position(identifier):
        p=positions.get(identifier)
        if not isinstance(p,dict):
            return None
        return (max(0,number(p.get("x")))+origin_x,max(0,number(p.get("y")))+origin_y,max(260,number(p.get("width"),360)),max(110,number(p.get("height"),160)))

    def anchor(x,y,w,h):
        element=tag(root,XDR,"oneCellAnchor")
        start=tag(element,XDR,"from")
        for key,value in [("col",int(max(0,x)//22)),("colOff",int(max(0,x)%22*EMU)),("row",int(max(0,y)//22)),("rowOff",int(max(0,y)%22*EMU))]:
            tag(start,XDR,key).text=str(value)
        tag(element,XDR,"ext",cx=max(1,int(w*EMU)),cy=max(1,int(h*EMU)))
        return element

    def shape(identifier,name,box,content,fill,line="D5302E",font_color="C90000"):
        x,y,w,h=box
        parent=anchor(x,y,w,h)
        sp=tag(parent,XDR,"sp")
        nv=tag(sp,XDR,"nvSpPr")
        tag(nv,XDR,"cNvPr",id=identifier,name=name)
        tag(nv,XDR,"cNvSpPr")
        prop=tag(sp,XDR,"spPr")
        transform=tag(prop,A,"xfrm")
        tag(transform,A,"off",x=int(x*EMU),y=int(y*EMU))
        tag(transform,A,"ext",cx=int(w*EMU),cy=int(h*EMU))
        tag(tag(prop,A,"prstGeom",prst="rect"),A,"avLst")
        tag(tag(prop,A,"solidFill"),A,"srgbClr",val=fill)
        stroke=tag(prop,A,"ln",w="19050")
        tag(tag(stroke,A,"solidFill"),A,"srgbClr",val=line)
        body=tag(sp,XDR,"txBody")
        properties=tag(body,A,"bodyPr",anchor="ctr",wrap="square",lIns="76200",rIns="76200",tIns="76200",bIns="76200")
        tag(properties,A,"normAutofit")
        tag(body,A,"lstStyle")
        for line_text in text(content).split("\n"):
            paragraph=tag(body,A,"p")
            tag(paragraph,A,"pPr",algn="ctr")
            run=tag(paragraph,A,"r")
            run_props=tag(run,A,"rPr",lang="ru-RU",sz="1100" if len(text(content))>230 else "1200",b="1")
            tag(tag(run_props,A,"solidFill"),A,"srgbClr",val=font_color)
            tag(run_props,A,"latin",typeface="Arial")
            tag(run,A,"t").text=line_text
            tag(paragraph,A,"endParaRPr",lang="ru-RU")
        tag(parent,XDR,"clientData")

    for edge in edges:
        source=position(text(edge.get("from")))
        destination=position(text(edge.get("to")))
        if not source or not destination:
            continue
        sx,sy,sw,sh=source
        dx,dy,dw,dh=destination
        vertical=abs(dy-sy)>24
        upward=vertical and dy<sy
        rightward=not vertical and dx>=sx
        x1=sx+sw/2 if vertical else sx+sw if rightward else sx
        y1=sy if upward else sy+sh if vertical else sy+sh/2
        x2=dx+dw/2 if vertical else dx if rightward else dx+dw
        y2=dy+dh if upward else dy if vertical else dy+dh/2
        parent=anchor(min(x1,x2),min(y1,y2),max(2,abs(x2-x1)),max(2,abs(y2-y1)))
        connector=tag(parent,XDR,"cxnSp")
        nv=tag(connector,XDR,"nvCxnSpPr")
        next_id+=1
        tag(nv,XDR,"cNvPr",id=next_id,name=f"Связь {edge.get('from')} → {edge.get('to')}")
        connections=tag(nv,XDR,"cNvCxnSpPr")
        tag(connections,A,"stCxn",id=node_ids[text(edge.get("from"))],idx=0 if upward else 2 if vertical else 3 if rightward else 1)
        tag(connections,A,"endCxn",id=node_ids[text(edge.get("to"))],idx=2 if upward else 0 if vertical else 1 if rightward else 3)
        prop=tag(connector,XDR,"spPr")
        transform=tag(prop,A,"xfrm",flipH="1" if x2<x1 else "0",flipV="1" if y2<y1 else "0")
        tag(transform,A,"off",x=int(min(x1,x2)*EMU),y=int(min(y1,y2)*EMU))
        tag(transform,A,"ext",cx=max(1,int(abs(x2-x1)*EMU)),cy=max(1,int(abs(y2-y1)*EMU)))
        tag(tag(prop,A,"prstGeom",prst="line"),A,"avLst")
        stroke=tag(prop,A,"ln",w="23812")
        tag(tag(stroke,A,"solidFill"),A,"srgbClr",val="C6544F" if edge.get("cycle") else "7A8289")
        tag(stroke,A,"prstDash",val="dash")
        tag(stroke,A,"tailEnd",type="triangle",w="med",len="med")
        tag(parent,XDR,"clientData")

    by_edge={text(edge.get("id")):edge for edge in edges}
    for label in layout.get("labels") or []:
        edge=by_edge.get(text(label.get("edgeId")))
        if not edge:
            continue
        value=number(edge.get("amount")) or number(edge.get("dealAmount"))
        years="–".join(map(str,edge.get("years") or [])) or "период не указан"
        goods=edge.get("goods") or []
        description=goods[0].get("name","") if goods else " · ".join(edge.get("relations") or [])
        content=f"{value:,.0f} ₸\n{years} · {edge.get('operations',0)} оп.\n{description}"
        next_id+=1
        box=(number(label.get("x"))+origin_x,number(label.get("y"))+origin_y,max(180,number(label.get("width"),240)),max(74,number(label.get("height"),90)))
        shape(next_id,"Подпись связи",box,content,"FFF5F4" if edge.get("cycle") else "FFFFFF","52575C","102A4C")

    incoming={}
    outgoing={}
    for edge in edges:
        incoming[text(edge.get("to"))]=incoming.get(text(edge.get("to")),0)+1
        outgoing[text(edge.get("from"))]=outgoing.get(text(edge.get("from")),0)+1
    for node in nodes:
        identifier=text(node.get("bin"))
        box=position(identifier)
        if not box:
            continue
        selected=identifier==text(options.get("focusBin"))
        terminal=not selected and ((incoming.get(identifier,0)>1 and not outgoing.get(identifier,0)) or number(node.get("risk"))>=90)
        role="ВЫБРАННЫЙ ОБЪЕКТ" if selected else "КОНЕЧНЫЙ УЗЕЛ" if terminal else "СВЯЗАННЫЙ ОБЪЕКТ" if node.get("knownObject") else "КОНТРАГЕНТ"
        content=f"{role}\n{node.get('name') or 'Без наименования'}\n{identifier_label(identifier)}"
        if node.get("head"):
            content+=f"\nРуководитель: {node['head']}"
            if node.get("headIin"):
                content+=f" · {node['headIin']}"
        shape(node_ids[identifier],f"{role}: {identifier}",box,content,"FFF318" if selected else "FFE5E5" if terminal else "FFFFFF","1C252D" if selected else "C90000" if terminal else "D5302E")
    return root

def export(options):
    payload=options["payload"]
    nodes=payload.get("nodes",[])
    edges=payload.get("edges",[])
    by_id={text(node.get("bin")):node for node in nodes}
    selected=by_id.get(text(options.get("focusBin"))) or payload.get("root") or {}
    layout=options.get("diagramLayout") or {}
    width=max(1160,min(18000,number(layout.get("stageWidth"),1160)))
    height=max(620,min(30000,number(layout.get("stageHeight"),620)))
    last_col=math.ceil((width+88)/22)+1
    last_row=math.ceil((height+244)/22)
    book=Workbook()
    scheme=book.active
    scheme.title="Схема"
    scheme.sheet_view.showGridLines=False
    scheme.sheet_format.defaultColWidth=2.43
    scheme.sheet_format.defaultRowHeight=16.5
    for col in range(1,last_col+1):
        scheme.column_dimensions[get_column_letter(col)].width=2.43
    thirds=[1,max(9,last_col//3),max(18,last_col*2//3)]
    headings=[
        f"НАПРАВЛЕННАЯ ФИНАНСОВАЯ ЦЕПОЧКА\n{selected.get('name') or options.get('focusBin')}\n{identifier_label(options.get('focusBin'))}",
        f"ПОКАЗАНО\n{len((options.get('diagramPayload') or payload).get('nodes',[]))} узлов\n{options.get('scopeLabel','')}",
        f"ПРАВИЛО НАПРАВЛЕНИЯ\nПоставщик → получатель\n{options.get('pageLabel') or 'все показанные связи'}",
    ]
    for i,start in enumerate(thirds):
        end=thirds[i+1]-1 if i<2 else last_col
        scheme.merge_cells(start_row=1,start_column=start,end_row=3,end_column=end)
        cell=scheme.cell(1,start)
        cell_value(cell,headings[i])
        cell.font=Font(name="Arial",size=12,bold=i==0,color="102A4C")
        cell.alignment=Alignment(wrap_text=True,vertical="center",horizontal="left" if i==0 else "center")
    scheme.merge_cells(start_row=4,start_column=1,end_row=5,end_column=last_col)
    cell_value(scheme["A4"],payload.get("rule") or "Один БИН — один узел; повторные операции объединены.")
    scheme["A4"].alignment=Alignment(wrap_text=True,vertical="center")
    scheme["A4"].fill=PatternFill("solid",fgColor="FFFBEA")
    scheme.freeze_panes="A6"
    scheme.print_area=f"A1:{get_column_letter(last_col)}{last_row}"
    scheme.sheet_properties.pageSetUpPr.fitToPage=True
    scheme.page_setup.orientation="landscape"
    scheme.page_setup.paperSize=scheme.PAPERSIZE_A3
    scheme.page_setup.fitToWidth=1
    scheme.page_setup.fitToHeight=1
    scheme.page_margins=PageMargins(left=.2,right=.2,top=.25,bottom=.25,header=.1,footer=.1)
    scheme.oddFooter.center.text="&P / &N"

    node_sheet=book.create_sheet("Узлы")
    title(node_sheet,f"Узлы схемы: {selected.get('name') or options.get('focusBin')}",10,f"{len(nodes)} уникальных узлов")
    sorted_nodes=sorted(nodes,key=lambda node:(number(node.get("levelIndex")),text(node.get("name"))))
    node_rows=[[node.get("levelIndex"),"Выбранный объект" if text(node.get("bin"))==text(options.get("focusBin")) else "Связанный объект" if node.get("knownObject") else "Контрагент",text(node.get("bin")),node.get("name"),node.get("head"),text(node.get("headIin")),node.get("address"),node.get("risk"),node.get("level"),"Да" if node.get("knownObject") else "Нет"] for node in sorted_nodes]
    data_table(node_sheet,["Уровень","Роль","БИН/ИИН / IBAN","Наименование","Руководитель","ИИН руководителя","Адрес","Риск","Уровень риска","Объект КГД"],node_rows,"VestigoNodes",{4:55,5:36,7:50})
    for row in range(6,len(nodes)+6):
        node_sheet.cell(row,3).number_format="@"
        node_sheet.cell(row,6).number_format="@"

    edge_sheet=book.create_sheet("Связи")
    title(edge_sheet,"Направленные финансовые связи",13,f"{len(edges)} связей · поставщик → получатель")
    edge_rows=[]
    for edge in sorted(edges,key=lambda edge:-max(number(edge.get("amount")),number(edge.get("dealAmount")))):
        goods="; ".join(f"{item.get('name','')} ({number(item.get('amount')):,.0f} ₸)" for item in edge.get("goods") or [])
        edge_rows.append([text(edge.get("from")),by_id.get(text(edge.get("from")),{}).get("name",""),text(edge.get("to")),by_id.get(text(edge.get("to")),{}).get("name",""),edge.get("amount"),edge.get("vat"),edge.get("dealAmount"),edge.get("operations"),"–".join(map(str,edge.get("years") or [])),goods,"; ".join(edge.get("sources") or []),"; ".join(edge.get("relations") or []),"Да" if edge.get("cycle") else "Нет"])
    data_table(edge_sheet,["От БИН","Поставщик","К БИН","Получатель","Сумма ЭСФ","НДС","Сумма сделок","Операций","Период","Товары/услуги","Источники","Тип связи","Цикл"],edge_rows,"VestigoEdges",{2:45,4:45,10:65,11:45,12:45})
    for row in range(6,len(edges)+6):
        for col in (1,3):
            edge_sheet.cell(row,col).number_format="@"
        for col in (5,6,7):
            edge_sheet.cell(row,col).number_format='#,##0.00 "₸"'
    meta=book.create_sheet("Параметры")
    title(meta,"Параметры выгрузки Vestigo",2)
    meta.column_dimensions["A"].width=28
    meta.column_dimensions["B"].width=80
    values=[("Выбранный идентификатор",text(options.get("focusBin"))),("Наименование",selected.get("name","")),("Режим",options.get("scopeLabel","")),("Глубина",options.get("depth")),("Узлов в выгрузке",len(nodes)),("Связей в выгрузке",len(edges)),("Правило",payload.get("rule","")),("Дата формирования",datetime.now()),("Редактирование","Карточки, подписи и соединители — отдельные объекты Excel. Таблицы на соседних листах не меняют текст фигур автоматически."),("Печать","Схема настроена на один лист A3. Для большой схемы выберите подходящий формат и масштаб печати.")]
    for row,(label,value) in enumerate(values,4):
        cell_value(meta.cell(row,1),label)
        cell_value(meta.cell(row,2),value)
        meta.cell(row,1).font=Font(name="Arial",bold=True,color=NAVY)
        meta.cell(row,2).alignment=Alignment(wrap_text=True,vertical="top")
        if isinstance(value,datetime):
            meta.cell(row,2).number_format="yyyy-mm-dd hh:mm"
    intermediate=io.BytesIO()
    book.save(intermediate)
    drawing_xml=ET.tostring(drawing(options),encoding="utf-8",xml_declaration=True)
    output=io.BytesIO()
    with zipfile.ZipFile(intermediate) as source,zipfile.ZipFile(output,"w",zipfile.ZIP_DEFLATED) as target:
        for entry in source.infolist():
            data=source.read(entry.filename)
            if entry.filename=="xl/worksheets/sheet1.xml":
                xml=ET.fromstring(data)
                tag(xml,S,"drawing",**{"{"+R+"}id":"rId1"})
                data=ET.tostring(xml,encoding="utf-8",xml_declaration=True)
            elif entry.filename=="[Content_Types].xml":
                xml=ET.fromstring(data)
                tag(xml,CT,"Override",PartName="/xl/drawings/drawing1.xml",ContentType="application/vnd.openxmlformats-officedocument.drawing+xml")
                data=ET.tostring(xml,encoding="utf-8",xml_declaration=True)
            target.writestr(entry,data)
        relationships=ET.Element("{"+PKG+"}Relationships")
        tag(relationships,PKG,"Relationship",Id="rId1",Type=R+"/drawing",Target="/xl/drawings/drawing1.xml")
        target.writestr("xl/worksheets/_rels/sheet1.xml.rels",ET.tostring(relationships,encoding="utf-8",xml_declaration=True))
        target.writestr("xl/drawings/drawing1.xml",drawing_xml)
    return output.getvalue()

if __name__=="__main__":
    sys.stdout.buffer.write(export(json.load(sys.stdin)))
