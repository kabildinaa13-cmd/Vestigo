"""Evidence-preserving bank statement normalization. No name-based identity guesses."""
import re
import datetime as dt
from statistics import median
from financial_normalization import currency as normalize_currency, norm, explicit_currency

BANK_ALIASES={
 "date":["Дата транзакции","Күні / Дата"],
 "number":["Құжат № /№ Документа"],
 "currency":["Валютасы /Валюта"],
 "purpose":["Төлем мақсаты / Назначение платежа"],
 "bankName":["Наименование банка","Банк выписки","bank_name"],
 "ownerId":["БИН владельца счета","ИИН владельца счета","БИН/ИИН владельца счета","ИИН/БИН владельца счета","БИН/ИИН клиента","БИН клиента","ИИН/БИН клиента","owner_id","owner_bin","Account holder BIN","Client BIN"],
 "ownerName":["Наименование владельца счета","Наименование клиента","Клиент","owner_name"],
 "ownerAccount":["Лицевой счет","Лицевой счёт","Счет владельца","Счёт владельца","Счет клиента","Счет выписки","Номер счета","ИИК (IBAN)","ИИК клиента","ИИК владельца счета","IBAN","account","owner_account","Account number","Счёт клиента"],
 "counterpartyAccount":["Счет-корреспондент","Счёт-корреспондент","ИИК Отправителя/Бенефициара","Корресп. Есепшоты / Счет-корреспондент","Счет контрагента","Счёт контрагента","ИИК контрагента","counterparty_account","counterparty_iban"],
 "senderAccount":["Счет отправителя","ИИК отправителя","sender_account"],
 "recipientAccount":["Счет получателя","ИИК получателя","recipient_account"],
 "counterpartyId":["БИН/ИИН Отправителя/Бенефициара","ИИН/БИН Отправителя/Бенефициара","БИН контрагента","ИИН/БИН контрагента","ИИН контрагента","counterparty_id","Counterparty BIN"],
 "counterpartyName":["Наименование Отправителя/Бенефициара","Контрагент. атауы / Наименование контрагента","Наименование контрагента","Контрагент","counterparty_name","Counterparty"],
 "counterpartyBlock":["Счет, наименование БИН/ИИН","Счёт, наименование БИН/ИИН"],
 "fee":["Комиссия","Комиссия банка","Сумма комиссии","Банковская комиссия","bank_fee","fee","commission"],
 "feeMode":["Учет комиссии","Учёт комиссии","Способ учета комиссии","fee_mode"],
 "transactionId":["ID транзакции","Уникальный идентификатор операции","Идентификатор транзакции","transaction_id","bank_transaction_id"],
 "feeReference":["Комиссия за операцию","Номер операции комиссии","fee_for","fee_reference"],
 "transactionType":["Вид операции","Тип операции","Направление операции","transaction_type","direction","Тип движения"],
 "signedAmount":["Сумма со знаком","signed_amount"],
 "debit":["Деб. оборот","Расходы","Дебет","Дебет айналымы / Дебетовый оборот","Расход","Списание","Сумма списания","Debit","withdrawal","outgoing"],
 "credit":["Кред. оборот","Поступления","Кредит","Кредит айналымы / Кредитовый оборот","Приход","Зачисление","Сумма зачисления","Credit","deposit","incoming"],
 "amount":["Всего по счету, стоимость товаров, работ, услуг с учетом косвенных налогов","Общая сумма с НДС","Сумма с НДС","Сумма документа","Итого к оплате","Сумма платежа","Сумма перевода","Сумма","amount","total","Всего по счету, размер оборота по реализации"],
}
MODES={"separate","debit_includes_fee","credit_after_fee","unknown"}

def normalize(value):
    return re.sub(r"\s+"," ",str(value or "").lower().replace("ё","е")).strip()

def iban(value):
    value=re.sub(r"\s+","",str(value or "")).upper()
    if not re.fullmatch(r"[A-Z]{2}\d{2}[A-Z0-9]{11,30}",value) or (value.startswith("KZ") and len(value)!=20):
        return ""
    number="".join(str(ord(c)-55) if c.isalpha() else c for c in value[4:]+value[:4])
    return value if int(number)%97==1 else ""

def party(identifier,account):
    return identifier or ("IBAN:"+account if account else "")

def fee_kind(purpose,operation_type=""):
    value=normalize(operation_type)
    purpose=normalize(purpose)
    if value in {"refund","возврат оплаты","возврат платежа"} or re.match(r"^возврат\s+(?:оплаты|платежа|денежных\s+средств)\b",purpose):
        return "refund"
    if value in {"fee_refund","возврат комиссии"} or re.match(r"^(?:возврат|возмещение)\s+(?:банковской\s+)?комиссии\b",purpose):
        return "fee_refund"
    if value in {"fee","bank_fee","комиссия","комиссия банка","банковская комиссия"} or re.match(r"^(?:комиссия\s+банка|банковская\s+комиссия|комиссионное\s+вознаграждение|списание\s+комиссии|удержание\s+комиссии)\b",purpose):
        return "fee"
    return "transfer"

def statement_context(text,tables,options,filename_owner,identifier):
    # Only explicit labels from the preamble; arbitrary numbers in the body are not owners.
    preamble="\n".join(str(cell or "") for _,values in tables for row in values[:4] for cell in row)
    prefix=(str(text or "")[:2500]+"\n"+preamble[:2500])
    # A filename is never evidence of bank-account ownership.
    owner=identifier(options.get("ownerId"))
    if not owner:
        found=set(re.findall(r"(?:БИН владельца счета|БИН клиента|ИИН/БИН клиента|owner_id)\s*[:：]?\s*(\d{12})(?!\d)",prefix,re.I))
        found={v for v in found if identifier(v)}
        if len(found)==1:
            owner=found.pop()
    account=iban(options.get("ownerAccount"))
    if not account:
        found={iban(match) for match in re.findall(r"(?:Номер счета|Счет клиента|Счет владельца|IBAN)\s*[:：]?\s*([A-Z]{2}\d{2}[A-Z0-9 ]{11,38})",prefix,re.I)}
        found.discard("")
        if len(found)==1:
            account=found.pop()
    labelled_owners=set(re.findall(r"(?:БИН владельца счета|БИН клиента|ИИН/БИН клиента|owner_id)\s*[:：]?\s*(\d{12})(?!\d)",prefix,re.I))
    labelled_accounts=set()
    labelled_currencies=set()
    owner_labels={norm(x) for x in BANK_ALIASES["ownerId"]}
    account_labels={norm(x) for x in BANK_ALIASES["ownerAccount"]}
    currency_labels={norm(x) for x in ("Код валюты счета","Валюта","Валютасы / Валюта","Валюта счета","Валюта счёта","Account currency","Currency")}
    name_labels={norm(x) for x in BANK_ALIASES['ownerName']}|{norm('Клиент/Клиент')}
    preamble_rows=[]
    for _,values in tables:
        for row in values:
            cells=[re.sub(r"\s+"," ",str(v)).strip() for v in row if v is not None and str(v).strip()]
            if len(cells)==1 and re.search(r'[:：]',cells[0]):
                label,value=re.split(r'[:：]',cells[0],maxsplit=1)
                cells=[label.strip(),value.strip()]
            preamble_rows.append(cells)
    # Statement headings are evidence, filenames and the bank's own BIN are not.
    statement_owner_names=set()
    statement_start=next((i for i,r in enumerate(preamble_rows) if re.search(r'выписка по (?:(?:лицевому|карт|карточному) )?сч[её]ту',' '.join(r),re.I)),None)
    if statement_start is not None:
        for row in preamble_rows[statement_start:]:
            line=' '.join(row)
            heading=re.search(r'выписка по (?:(?:лицевому|карт|карточному) )?сч[её]ту\s+(?:карты\s+)?[:：№]?\s*([A-Z]{2}\d{2}[A-Z0-9]{16})(?![A-Z0-9])(?:\s*\(([A-Z]{3})\))?',line,re.I)
            if heading:
                if iban(heading[1]):labelled_accounts.add(iban(heading[1]))
                if heading[2] and normalize_currency(heading[2])!='UNKNOWN':labelled_currencies.add(normalize_currency(heading[2]))
            if re.match(r'^(?:Клиент\s*/\s*Клиент|Клиент|ТОО\b|ИП\b|АО\b)',line,re.I):
                match=re.search(r'\b(?:БИН|ИИН|БСН)\s*[/\\]?\s*(?:ИИН|БИН)?\s*[:：-]?\s*(\d{12})(?!\d)',line,re.I)
                if match:
                    labelled_owners.add(match[1])
                    if re.match(r'^(?:ТОО|ИП|АО)\b',line,re.I):statement_owner_names.add(line[:match.start()].strip())
            account_label=re.search(r'(?:номер сч[её]та|ИИК\s*\(IBAN\))\s*[:：]\s*([A-Z]{2}\d{2}[A-Z0-9]{16})(?![A-Z0-9])',line,re.I)
            if account_label and iban(account_label[1]):labelled_accounts.add(iban(account_label[1]))
    has_client=any(norm(next((v for v in row if v),'' ).rstrip(':：')) in name_labels for row in preamble_rows)
    if has_client:owner_labels.update({norm('ИИН/БИН'),norm('БИН/ИИН'),norm('ИИН'),norm('БИН')})
    owner_names=set(statement_owner_names)
    for values in [preamble_rows]:
        for row in values:
            if not row:continue
            nonempty=[str(v).strip() for v in row if v is not None and str(v).strip()]
            if not nonempty:continue
            key=norm(nonempty[0].rstrip(':：'))
            value=' '.join(nonempty[1:])
            if key in name_labels and value:owner_names.add(re.sub(r'\s+(?:БИН|ИИН|БСН/ЖСН|БСН/БИН)\s*[:：-]?\s*\d{12}\s*$','',value,flags=re.I).strip())
            if key in name_labels:
                ids=set(re.findall(r'(?<![\dA-Z])\d{12}(?![\dA-Z])',value,re.I))
                if len(ids)==1:labelled_owners.update(ids)
            if key in owner_labels and identifier(value):labelled_owners.add(identifier(value))
            if key in account_labels and iban(value):labelled_accounts.add(iban(value))
            if key in currency_labels and normalize_currency(value)!="UNKNOWN":labelled_currencies.add(normalize_currency(value))
    issues=[]
    labelled_owners={v for v in labelled_owners if identifier(v)}
    if len(labelled_owners)>1:issues.append("В шапке таблицы указаны разные БИН/ИИН владельца счёта")
    if len(labelled_accounts)>1:issues.append("В шапке таблицы указаны разные IBAN владельца счёта")
    if len(labelled_currencies)>1:issues.append("В шапке таблицы указаны разные валюты счёта")
    if len(owner_names)>1:issues.append("В шапке указаны разные наименования владельца счёта")
    explicit_owner=next(iter(labelled_owners)) if len(labelled_owners)==1 else ''
    explicit_account=next(iter(labelled_accounts)) if len(labelled_accounts)==1 else ''
    if options.get('ownerId') and explicit_owner and identifier(options['ownerId'])!=explicit_owner:issues.append("Владелец в настройках не совпадает с БИН/ИИН шапки")
    if options.get('ownerAccount') and explicit_account and iban(options['ownerAccount'])!=explicit_account:issues.append("IBAN в настройках не совпадает со счётом шапки")
    context_currency=next(iter(labelled_currencies)) if len(labelled_currencies)==1 else 'UNKNOWN'
    if options.get('defaultCurrency') and context_currency!='UNKNOWN' and normalize_currency(options['defaultCurrency'])!=context_currency:issues.append("Валюта в настройках не совпадает с валютой шапки")
    # Only a statement-period label anchors a short transaction year. A client's
    # registration date or the date the report was printed is not that period.
    period_rows=[' '.join(row) for row in preamble_rows if re.search(r'период|statement period|period from|\bс\s+\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\s+по\b',' '.join(row),re.I)]
    preamble_text=' '.join(period_rows)
    # Short years must be anchored to a four-digit date in the preamble or an
    # employee-supplied year. Never use today's year or Python's century pivot.
    years={int(y) for y in re.findall(r'\b\d{1,2}[./-]\d{1,2}[./-]((?:19|20|21)\d{2})\b',preamble_text)}
    if re.fullmatch(r'(?:19|20|21)\d{2}',str(options.get('bankYear',''))):
        confirmed_year=int(options['bankYear'])
        if years and confirmed_year not in years:issues.append('Год в настройках не совпадает с явным периодом выписки')
        years={confirmed_year}
    return {"ownerId":identifier(options.get('ownerId')) or explicit_owner or owner,"ownerAccount":iban(options.get('ownerAccount')) or explicit_account or account,"ownerName":next(iter(owner_names)) if len(owner_names)==1 else '',"currency":context_currency,"dateYears":sorted(years),"issues":issues}

def bank_date(value,context,parse_date):
    raw=str(value or '').strip()
    # Excel text dates may include a clock. Validate it before retaining the source day.
    for fmt in ('%d.%m.%Y %H:%M:%S','%d.%m.%Y %H:%M'):
        try:return dt.datetime.strptime(raw,fmt).date().isoformat()
        except ValueError:pass
    short=re.fullmatch(r'(\d{1,2})\.(\d{1,2})\.(\d{2})',raw)
    if not short:return parse_date(value)
    candidates={parse_date(f'{short[1]}.{short[2]}.{year}') for year in context.get('dateYears',[]) if year%100==int(short[3])}
    candidates.discard('')
    return next(iter(candidates)) if len(candidates)==1 else ''

def bank_service_row(cells,mapping,headers):
    column=mapping.get('date')
    if column not in headers:return ''
    index=headers.index(column);label=normalize(cells[index] if index<len(cells) else '')
    lead=normalize(' '.join(str(c or '') for c in cells[:3]))
    if not re.match(r'^\d{1,4}[./-]\d{1,2}[./-]\d{1,4}',label):
        if re.search(r'(?:исходящий остаток|исх[.]? остаток|входящий остаток|выходящий остаток|итого оборот|обороты за|барлығы|кіріс қалдық|шығыс қалдық|в нац[.]?\s*эквиваленте)',lead):return 'total'
        if re.match(r'^(?:дата формирования|дата последнего|количество сформированных|қолы|орындаушы|руководитель|исполнитель|ответ[.]? исполнитель|место штампа|курс\s+\d)',lead):return 'note'
        # Empty account statements sometimes contain only zero-valued balances.
        economic=[mapping.get(k) for k in ('date','number','counterpartyId','counterpartyAccount','counterpartyBlock','purpose')]
        if not any(c in headers and str(cells[headers.index(c)] or '').strip() for c in economic if c):
            numeric=[str(c or '').replace('\u00a0','').replace(' ','').strip('()') for c in cells]
            if all(not c or re.fullmatch(r'[-+]?0+(?:[.,]0+)?',c) for c in numeric):return 'total'
    if re.match(r'^(?:входящий остаток|исходящий остаток|остаток по счету|оборот по счету|обороты по счету)(?:\s|:|$)',label):return 'total'
    if re.match(r'^(?:руководитель\s*/\s*исполнитель|орындаушы\s*/|подпись\s*/)(?:\s|:|$)',label):return 'note'
    return ''

def bank_record(raw,mapping,options,context,money,date,identifier):
    value=lambda key:raw.get(mapping.get(key),"") or ""
    owner_id=identifier(value("ownerId")) or context["ownerId"]
    owner_account=iban(value("ownerAccount")) or context["ownerAccount"]
    owner=party(owner_id,owner_account)
    sender_id,recipient_id=identifier(value("senderId")),identifier(value("recipientId"))
    sender_account,recipient_account=iban(value("senderAccount")),iban(value("recipientAccount"))
    counterparty_id=identifier(value("counterpartyId"))
    counterparty_account=iban(value("counterpartyAccount"))
    block=str(value('counterpartyBlock') or value('counterpartyAccount')).strip()
    counterparty_name=value('counterpartyName')
    # A known combined column: account token, optional standalone BIN, name.
    # Numeric account tokens are never mistaken for BIN; invalid IBAN stays raw.
    combined=re.fullmatch(r'([A-Z]{2}\d{2}[A-Z0-9]{11,30}|\d{20})\s+(?:(?:(?:БИН\s*/\s*ИИН|ИИН\s*/\s*БИН|БИН|ИИН)\s*[:：]?\s*)?(\d{12})(?!\d)\s+)?(.+)',block,re.I)
    if combined:
        counterparty_account=counterparty_account or iban(combined[1])
        counterparty_id=counterparty_id or identifier(combined[2])
        counterparty_name=counterparty_name or combined[3].strip()
    sender,recipient=party(sender_id,sender_account),party(recipient_id,recipient_account)
    sender_name,recipient_name=value("senderName"),value("recipientName")
    debit,credit=money(value("debit")),money(value("credit"))
    signed=money(value("signedAmount"))
    amount=money(value("amount"))
    purpose=value("purpose")
    kind=fee_kind(purpose,value("transactionType"))
    issues=list(context.get('issues',[]))
    if value('ownerId') and context.get('ownerId') and identifier(value('ownerId'))!=context['ownerId']:issues.append("Противоречие БИН/ИИН владельца в строке и шапке")
    if value('ownerAccount') and context.get('ownerAccount') and iban(value('ownerAccount'))!=context['ownerAccount']:issues.append("Противоречие IBAN владельца в строке и шапке")
    direction=""
    # A row with two nonzero sides is not silently assigned to either side.
    if debit not in (None,0) and credit not in (None,0):
        issues.append("В строке одновременно есть списание и зачисление")
    elif debit is not None and debit<0 or credit is not None and credit<0:
        issues.append("Отрицательный дебет/кредит: необходим явный формат суммы со знаком")
    elif debit not in (None,0):
        direction,amount="outgoing",debit
    elif credit not in (None,0):
        direction,amount="incoming",credit
    elif signed not in (None,0):
        direction,amount=("outgoing" if signed<0 else "incoming"),abs(signed)
    else:
        label=normalize(value("transactionType"))
        if label in {"расход","списание","исходящий","outgoing","debit","withdrawal"}:
            direction="outgoing"
        elif label in {"приход","зачисление","входящий","incoming","credit","deposit"}:
            direction="incoming"
        elif owner and sender==owner and recipient:
            direction="outgoing"
        elif owner and recipient==owner and sender:
            direction="incoming"
    if direction and not owner_id:
        owner_id=sender_id if direction=="outgoing" else recipient_id
        owner=party(owner_id,owner_account)
    party_conflict=False
    if direction and owner and (counterparty_id or counterparty_account):
        counterparty=party(counterparty_id,counterparty_account)
        expected_ids=(owner_id,counterparty_id) if direction=="outgoing" else (counterparty_id,owner_id)
        expected_accounts=(owner_account,counterparty_account) if direction=="outgoing" else (counterparty_account,owner_account)
        party_conflict=any(actual and expected and actual!=expected for actual,expected in zip((sender_id,recipient_id),expected_ids)) or any(actual and expected and actual!=expected for actual,expected in zip((sender_account,recipient_account),expected_accounts))
        if party_conflict:
            issues.append("Противоречие явных реквизитов отправителя/получателя и владельца/контрагента; стороны не подменены")
        elif direction=="outgoing":
            sender,recipient=owner,counterparty
            sender_id,sender_account=owner_id,owner_account
            recipient_id,recipient_account=counterparty_id,counterparty_account
            sender_name=value("ownerName") or context.get('ownerName') or sender_name
            recipient_name=counterparty_name or recipient_name
        else:
            sender,recipient=counterparty,owner
            recipient_id,recipient_account=owner_id,owner_account
            sender_id,sender_account=counterparty_id,counterparty_account
            recipient_name=value("ownerName") or context.get('ownerName') or recipient_name
            sender_name=counterparty_name or sender_name
    if direction and owner and not (counterparty_id or counterparty_account):
        actual=sender if direction=='outgoing' else recipient
        if actual and actual!=owner:
            party_conflict=True;issues.append('Противоречие стороны владельца и направления строки')
        elif direction=='outgoing':
            sender=owner;sender_id=owner_id;sender_account=owner_account;sender_name=value('ownerName') or context.get('ownerName') or sender_name
        else:
            recipient=owner;recipient_id=owner_id;recipient_account=owner_account;recipient_name=value('ownerName') or context.get('ownerName') or recipient_name
    fee=money(value("fee"))
    if value("fee") and (fee is None or fee<0):
        issues.append("Некорректная или отрицательная комиссия в столбце")
        fee=None
    mode=normalize(value("feeMode") or options.get("bankFeeMode") or "unknown")
    mode={"отдельно":"separate","включена в списание":"debit_includes_fee","зачисление за вычетом комиссии":"credit_after_fee"}.get(mode,mode)
    if mode not in MODES:
        issues.append("Неизвестный способ учета комиссии")
        mode="unknown"
    if not fee:
        mode="separate"
    # "Сумма перевода" explicitly denotes the principal; generic "Сумма" does not.
    if fee and mode=="unknown" and normalize(mapping.get("amount"))=="сумма перевода" and debit in (None,0) and credit in (None,0):
        mode="separate"
    principal=amount
    if fee and kind=="transfer":
        if mode=="debit_includes_fee" and direction=="outgoing":
            if amount is None or fee>amount:
                issues.append("Комиссия больше общей суммы списания")
                principal=None
            else:
                principal=amount-fee
        elif mode=="credit_after_fee" and direction=="incoming":
            principal=amount+fee if amount is not None else None
        elif mode=="unknown":
            issues.append("Не указано, входит ли комиссия в сумму движения")
            principal=None
        elif mode!="separate":
            issues.append("Способ учета комиссии не соответствует направлению строки")
            principal=None
    if kind!="transfer" and fee:
        # A fee row itself must not produce a second fee merely because it repeats the amount in a fee column.
        fee=None
    if issues and any("одновременно" in message or "Отрицательный дебет" in message for message in issues):
        principal=None
    if party_conflict:
        principal=None
    if context.get('issues') or any('Противоречие' in issue for issue in issues):
        principal=None
    if principal is not None and principal<0:
        issues.append("Сумма перевода не может быть отрицательной без направления")
        principal=None
    normalized_date=bank_date(value('date'),context,date)
    if re.fullmatch(r'\d{1,2}\.\d{1,2}\.\d{2}',str(value('date'))) and not normalized_date:issues.append('Двузначный год даты: подтвердите четырёхзначный год периода выписки')
    if not owner:issues.append('Не подтверждён владелец счёта: проверьте шапку или задайте БИН/ИИК владельца')
    resolved_currency=normalize_currency(value('currency') or options.get('defaultCurrency') or context.get('currency'))
    # A currency suffix on the actual debit/credit cell is source evidence.
    # Never use a cashback banner or the separate transaction-currency amount.
    currency_values={explicit_currency(value(k)) for k in ('debit','credit') if money(value(k)) not in (None,0)}
    currency_values.discard('UNKNOWN')
    if len(currency_values)>1 or currency_values and resolved_currency!='UNKNOWN' and resolved_currency not in currency_values:
        issues.append('Валюта суммы движения не совпадает с валютой счёта')
        principal=None
    elif resolved_currency=='UNKNOWN' and len(currency_values)==1:
        resolved_currency=next(iter(currency_values))
    missing=[key for key,known in [('owner',owner),('sender',sender),('recipient',recipient),('date',normalized_date),('amount',principal is not None),('direction',direction),('currency',resolved_currency!='UNKNOWN')] if not known]
    partial=bool(normalized_date and principal is not None and direction and missing)
    return {
        "senderId":sender,"recipientId":recipient,"senderName":sender_name,"recipientName":recipient_name,
        "amountMinor":principal,"date":normalized_date,"purpose":purpose,
        "currency":resolved_currency,
        "number":value("number") or value("transactionId"),"reference":value("reference"),
        "inferredOwner":bool(owner and counterparty_id or owner and counterparty_account),
        "bank":{"version":"bank-parser-1.2","layoutId":"combined-correspondent" if mapping.get('counterpartyBlock') else "card-movements" if normalize(mapping.get('debit'))=='расходы' and normalize(mapping.get('credit'))=='поступления' else "account-ledger","kind":kind,"direction":direction,"ownerId":owner,"ownerBin":owner_id,"ownerAccount":owner_account,
                "bankName":value("bankName"),"ownerName":value("ownerName") or context.get('ownerName',''),"rawDate":str(value('date')),"missingFields":missing,"normalizationStatus":'partial' if partial else 'needs_confirmation' if missing or principal is None else 'normalized',"dateBasis":'explicit-period-year' if re.fullmatch(r'\d{1,2}\.\d{1,2}\.\d{2}',str(value('date'))) and normalized_date else 'source-date',
                "senderAccount":sender_account,"recipientAccount":recipient_account,"senderBin":sender_id,"recipientBin":recipient_id,"unresolvedCounterpartyName":counterparty_name,"counterpartyAccountToken":combined[1] if combined else '',
                "transactionId":value("transactionId"),"feeReference":value("feeReference"),"feeMinor":fee,
                "feeMode":mode,"rawAmountMinor":amount,"rawDebitMinor":debit,"rawCreditMinor":credit,
                "principalAvailable":principal is not None,"issues":issues}
    }

def pdf_bank_tables(pages,infer):
    output=[]
    for page in pages:
        candidates=[]
        layout=page.get("tableText","")
        if layout:
            lines=[re.split(r"\s{2,}|\t|\s*\|\s*",line.strip()) for line in layout.splitlines() if line.strip()]
            candidates.append(lines)
        # Local OCR preserves word boxes; reconstruct columns only from a recognizable header.
        words=[word for line in page.get("ocr",{}).get("lines",[]) for word in line.get("words",[]) if str(word.get("text","")).strip() and all(key in word for key in ("x","y","w","h"))]
        if words:
            bands=[]
            tolerance=max(5,median(word["h"] for word in words)*.55)
            for word in sorted(words,key=lambda word:(word["y"]+word["h"]/2,word["x"])):
                center=word["y"]+word["h"]/2
                if not bands or abs(center-bands[-1][0])>tolerance:
                    bands.append((center,[word]))
                else:
                    bands[-1][1].append(word)
            for header_index,(_,band) in enumerate(bands[:30]):
                groups=[]
                for word in sorted(band,key=lambda word:word["x"]):
                    if groups and word["x"]-(groups[-1][-1]["x"]+groups[-1][-1]["w"])<max(14,tolerance*1.4):
                        groups[-1].append(word)
                    else:
                        groups.append([word])
                headers=[" ".join(word["text"] for word in group) for group in groups]
                mapping=infer(headers,{})
                if "date" not in mapping or not ("debit" in mapping or "credit" in mapping or "signedAmount" in mapping):
                    continue
                starts=[group[0]["x"] for group in groups]
                rows=[headers]
                for _,data in bands[header_index+1:]:
                    cells=[""]*len(headers)
                    for word in sorted(data,key=lambda word:word["x"]):
                        column=max((i for i,x in enumerate(starts) if word["x"]>=x-tolerance),default=0)
                        cells[column]+=(" " if cells[column] else "")+word["text"]
                    rows.append(cells)
                candidates.append(rows)
                break
        for values in candidates:
            for index,row in enumerate(values[:30]):
                mapping=infer(row,{})
                if "date" in mapping and ("debit" in mapping or "credit" in mapping or "signedAmount" in mapping) and any(key in mapping for key in ("counterpartyId","counterpartyAccount","senderId","recipientId")):
                    output.append((f"PDF bank {page['page']}",values[index:]))
                    break
            else:
                continue
            break
    return output
