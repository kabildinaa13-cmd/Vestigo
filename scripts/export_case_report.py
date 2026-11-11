"""Local case snapshot -> real XLSX. Untrusted strings never become formulas."""
import sys,json,io
from decimal import Decimal
from openpyxl import Workbook
from openpyxl.styles import Font,PatternFill,Alignment

def export_report(report):
    book=Workbook();book.remove(book.active)
    def sheet(title,headers,rows):
        page=book.create_sheet(title);page.append(headers)
        for row in rows:
            page.append([str(v) if v is not None else "" for v in row])
            for cell in page[page.max_row]: cell.data_type="s"
        for cell in page[1]: cell.font=Font(bold=True,color="FFFFFF");cell.fill=PatternFill("solid",fgColor="17365D")
        page.freeze_panes="A2";page.auto_filter.ref=page.dimensions
        for col in page.columns: page.column_dimensions[col[0].column_letter].width=min(70,max(16,max(len(str(c.value or "")) for c in col[:200])+2))
        for row in page:
            for cell in row: cell.alignment=Alignment(vertical="top",wrap_text=True)
    sheet("Сводка",["Параметр","Значение"],[["Дело",report["case"]["caseNumber"]],["Версия",report["version"]],["Создано",report["generatedAt"]],["Правила",report["ruleVersion"]],["Ограничение",report["warning"]]])
    sheet("Документы",["ID","Файл","Статус","Строки","Исключён","Ошибка"],[[d["id"],d["name"],d["status"],d["rows"],d["excluded"],d.get("error","")] for d in report["documents"]])
    sheet('Факты документов',['Документ','Исключён из анализа','Реквизит','Исходное значение','Нормализованное значение','Валюта','Страница','Строка текста','Интерпретация'],[[d['name'],d['excluded'],f['label'],f['raw'],f.get('normalized'),f.get('currency'),f.get('page'),f.get('line'),f['interpretation']] for d in report['documents'] for f in d.get('facts',[])])
    sheet("Операции",["ID","Вид","Дата","Номер","Отправитель","Получатель","Сумма","Валюта","Копейки точно","Подтверждено","Назначение"],[[o["id"],o["type"],o["date"],o.get("number",""),o["senderId"],o["recipientId"],str(Decimal(o["amountMinor"])/100),o["currency"],str(o["amountMinor"]),o["confirmed"],o.get("purpose","")] for o in report["operations"]])
    sheet("Источники",["ID операции","ID документа","Файл","Лист / страница","Строка"],[[o["id"],s["documentId"],s["name"],s.get("sheet",""),s.get("row","")] for o in report["operations"] for s in o["sources"]])
    sheet("Сопоставление",["Документ / операция 1","Документ / операция 2","Метод","Обоснование"],[[m["leftId"],m["rightId"],m["method"],m["explanation"]] for m in report["matches"]])
    sheet("Вопросы проверки",["ID","Код","Вид","Статус","Описание","Правило","Расчёт","Источники"],[[r["id"],r["code"],r.get("kind",""),r["status"],r["description"],r["rule"],json.dumps(r.get("calculation",{}),ensure_ascii=False),json.dumps(r["evidence"],ensure_ascii=False)] for r in report["risks"]])
    sheet("Расчёты",["ID","Версия","Метод","Формула","Плюс, копейки","Минус, копейки","Разница, копейки","Валюта","Обоснование","SHA256 входа"],[[c["id"],c["version"],c["method"],c["formula"],c["positiveMinor"],c["negativeMinor"],c["differenceMinor"],c["currency"],c["rationale"],c["inputSha256"]] for c in report["calculations"]])
    workflow=report.get('workflow')
    if workflow:
        names={p['id']:p['name'] for p in workflow['participants']}
        episodes={e['id']:e['title'] for e in workflow['episodes']}
        sheet('Участники', ['ID','ФИО / организация','БИН/ИИН','Роль'],[[p['id'],p['name'],p['identifier'],p['role']] for p in workflow['participants']])
        sheet('Потерпевшие и остаток',['Потерпевший','Эпизод','Валюта','Исходная сумма, минимальные ед.','Возврат, минимальные ед.','Остаток, минимальные ед.','Возврат сверх расчёта'],[[names.get(b['victimId'],''),episodes.get(b['episodeId'],'Всё дело'),b['currency'],b['originalMinor'],b['returnedMinor'],b['remainingMinor'] if b['remainingMinor'] is not None else 'Не установлен',b['excessMinor'] if b['excessMinor'] is not None else 'Не установлен'] for b in workflow['balances']])
        sheet('Расчёт по потерпевшим',['ID','Потерпевший','Эпизод','Версия','Метод','Формула','Исходная сумма','Исполнение','Разница','Валюта','Решение','Включён в итог','Обоснование','Источники','SHA256'],[[l['id'],l['victimName'],episodes.get(l['episodeId'],'Всё дело'),l['version'],l['method'],l['formula'],l['grossMinor'],l['fulfilledMinor'],l['originalMinor'],l['currency'],l['status'],l['usable'],l['note'],json.dumps(l['sources'],ensure_ascii=False),l['inputSha256']] for l in workflow['losses']])
        sheet('Возмещение',['ID','Потерпевший','Эпизод','Вид','Дата','Сумма, минимальные ед.','Валюта','Статус','Включён в итог','Обоснование','Источники'],[[r['id'],names.get(r['victimId'],''),episodes.get(r['episodeId'],'Всё дело'),r['kind'],r['date'],r['amountMinor'],r['currency'],r['status'],r['usable'],r['note'],json.dumps(r['sources'],ensure_ascii=False)] for r in workflow['returns']])
        sheet('Документальные события',['Вид','Дата','Передаёт / исполняет','Получает','Эпизод','Описание','Стоимость, минимальные ед.','Валюта','Статус','Обоснование','Источник'],[[e['kind'],e['date'],names.get(e['senderId'],''),names.get(e['recipientId'],''),episodes.get(e['episodeId'],'Всё дело'),e['description'],e['amountMinor'] if e['amountMinor'] is not None else 'Не установлена',e['currency'],e['status'],e['note'],json.dumps(e['source'],ensure_ascii=False)] for e in workflow.get('materialEvents',[])])
        sheet('Имущество отдельно',['Описание','Статус','Оценка, минимальные ед.','Валюта','Примечание'],[[a['name'],a['status'],a['amountMinor'],a['currency'],'Не уменьшает невозмещённый остаток'] for a in workflow['assets']])
        sheet('Недостающие материалы',['Категория','Документ','Причина'],[[m['category'],m.get('name',''),m['reason']] for m in workflow['missing']])
    output=io.BytesIO();book.save(output);return output.getvalue()
if __name__=="__main__":
    try: sys.stdout.buffer.write(export_report(json.load(sys.stdin)))
    except Exception:
        print("Не удалось сформировать Excel-сводку. Проверьте зависимости обработчика.",file=sys.stderr);sys.exit(1)
