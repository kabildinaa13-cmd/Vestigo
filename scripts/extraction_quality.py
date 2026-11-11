"""Exact counts and bounded examples, never a guessed accuracy percentage."""
from collections import Counter
from financial_normalization import clean

LABELS={"senderId":"БИН/ИИН или IBAN отправителя","recipientId":"БИН/ИИН или IBAN получателя","date":"Дата","amountMinor":"Сумма","currency":"Валюта"}


def create_quality(tables):
    return {"version":"extraction-quality-2.0","read":True,"sheets":[{"sheet":label,"physicalRows":len(values),"mergedRanges":len(getattr(values,'merges',[]))} for label,values in tables],"tables":[],"extractedRows":0,"eligibleRows":0,"reviewRows":0,"contextRows":0,"skippedRows":0,"issueCounts":{},"examples":[],"examplesLimit":1000,"examplesTruncated":False}


def issue(quality,sheet,row,code,message,table_id="",fields=None):
    quality['issueCounts'][code]=quality['issueCounts'].get(code,0)+1
    if len(quality['examples'])<quality['examplesLimit']:
        quality['examples'].append({"sheet":sheet,"row":row,"code":code,"message":message,"tableId":table_id,"fields":fields or []})
    else:
        quality['examplesTruncated']=True
        if not code.startswith('IGNORED_'):
            replace=next((i for i,item in enumerate(quality['examples']) if item['code'].startswith('IGNORED_')),None)
            if replace is not None:
                quality['examples'].pop(replace)
                quality['examples'].append({"sheet":sheet,"row":row,"code":code,"message":message,"tableId":table_id,"fields":fields or []})


def skipped(quality,sheet,row,kind,table_id=""):
    quality['skippedRows']+=1
    if kind!='blank':issue(quality,sheet,row,"IGNORED_"+kind.upper(),{"total":"Итоговая строка не является самостоятельной операцией","note":"Примечание или остаток не является самостоятельным переводом","preamble":"Шапка/служебная строка сохранена как источник","header":"Заголовок таблицы сохранён как источник"}.get(kind,kind),table_id)


def assess(quality,row,table_id):
    quality['extractedRows']+=1
    if row['type']=='context':
        quality['contextRows']+=1
        return False
    missing=[field for field in LABELS if row.get(field) is None or row.get(field)=='' or field=='currency' and row.get(field)=='UNKNOWN']
    problems=list(row.get('attributes',{}).get('extractionIssues',[]))
    for field in missing:
        problems.append({"code":"MISSING_"+field.upper(),"message":"Не распознан обязательный реквизит: "+LABELS[field],"fields":[field]})
    for message in row.get('bank',{}).get('issues',[]):
        problems.append({"code":"BANK_CONTEXT","message":message,"fields":[]})
    row.setdefault('attributes',{})['extractionIssues']=problems
    if missing or row['attributes'].get('conflictingFields'):
        row['attributes']['extractionBlocked']=True
        quality['reviewRows']+=1
        for p in problems:issue(quality,row['sheet'],row['row'],p['code'],p['message'],table_id,p.get('fields'))
        return True
    quality['eligibleRows']+=1
    row['attributes']['extractionBlocked']=False
    return False
