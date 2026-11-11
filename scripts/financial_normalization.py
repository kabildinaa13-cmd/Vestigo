"""Strict local normalization: no missing identities, dates or currencies are guessed."""
import datetime as dt
import re
import unicodedata
from functools import lru_cache
from decimal import Decimal, InvalidOperation


def clean(value):
    if value is None:
        return ""
    return value.isoformat() if isinstance(value, (dt.datetime, dt.date)) else str(value).strip()


@lru_cache(maxsize=8192)
def _norm(text):
    return re.sub(r"[\W_]+", "", unicodedata.normalize("NFKC", text).lower().replace("ё", "е"), flags=re.UNICODE)


def norm(value):
    return _norm(clean(value))


def money(value):
    text = unicodedata.normalize("NFKC", clean(value)).replace("−", "-")
    token = r"(?:KZT|USD|EUR|RUB|тенге|руб\.?|₸|€|₽)"
    text = re.sub(r"^"+token+r"\s*|\s*"+token+r"$", "", text, flags=re.I).strip()
    if not text:
        return None
    negative = text.startswith("(") and text.endswith(")")
    if negative:
        text = text[1:-1].strip()
        text = re.sub(r"^"+token+r"\s*|\s*"+token+r"$", "", text, flags=re.I).strip()
    if re.search(r"[\s'’]", text):
        # Only separators in correctly sized thousands groups are removable.
        # Otherwise OCR such as "12 34" would silently become 1234.
        text = re.sub(r"\s+", " ", text).replace("’", "'")
        if not re.fullmatch(r"[+-]?\d{1,3}([ '])\d{3}(?:\1\d{3})*(?:[.,]\d{1,2})?", text):
            return None
        text = re.sub(r"[ ']", "", text)
    if "," in text and "." in text:
        decimal, group = (".", ",") if text.rfind(".") > text.rfind(",") else (",", ".")
        whole, fraction = text.rsplit(decimal, 1)
        if not re.fullmatch(r"[+-]?\d{1,3}(?:" + re.escape(group) + r"\d{3})+", whole):
            return None
        text = whole.replace(group, "") + "." + fraction
    elif text.count(",") > 1 or text.count(".") > 1:
        separator = "," if "," in text else "."
        if not re.fullmatch(r"[+-]?\d{1,3}(?:" + re.escape(separator) + r"\d{3}){2,}", text):
            return None
        text = text.replace(separator, "")
    else:
        text = text.replace(",", ".")
    if not re.fullmatch(r"[+-]?\d+(?:\.\d+)?", text):
        return None
    if '.' in text and len(text.rsplit('.',1)[1])>2:
        return None
    try:
        amount = Decimal(text) * 100
        if not amount.is_finite() or amount != amount.to_integral_value() or abs(amount) > 9_000_000_000_000_000:
            return None
        if negative and amount < 0:
            return None
        return int(-amount if negative else amount)
    except InvalidOperation:
        return None


def identifier(value):
    text = re.sub(r"\s+", "", unicodedata.normalize("NFKC", clean(value)))
    text = re.sub(r"^(?:БИН|ИИН|BIN|IIN|БСН|ЖСН)[:：]?", "", text, flags=re.I)
    if re.fullmatch(r"\d{12}\.0", text):
        text = text[:-2]
    return text if re.fullmatch(r"\d{12}", text) and text!='000000000000' else ""


def date(value):
    if isinstance(value, (dt.datetime, dt.date)):
        return value.date().isoformat() if isinstance(value, dt.datetime) else value.isoformat()
    text = clean(value)
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?", text):
        text = text[:10]
    for fmt in ("%Y-%m-%d", "%d.%m.%Y", "%d/%m/%Y", "%Y/%m/%d", "%d-%m-%Y"):
        try:
            return dt.datetime.strptime(text, fmt).date().isoformat()
        except ValueError:
            pass
    return ""


def currency(value):
    text = unicodedata.normalize("NFKC", clean(value)).upper().strip()
    aliases = {"398": "KZT", "840": "USD", "978": "EUR", "643": "RUB", "₸": "KZT", "ТЕНГЕ": "KZT", "ТГ": "KZT", "ТГ.": "KZT", "€": "EUR", "ЕВРО": "EUR", "₽": "RUB", "РУБ": "RUB", "РУБ.": "RUB", "KZT (ТЕНГЕ)": "KZT"}
    if text in aliases:
        return aliases[text]
    return text if re.fullmatch(r"[A-Z]{3}", text) else "UNKNOWN"


def explicit_currency(text):
    tokens = re.findall(r"(?<![\w])(?:KZT|USD|EUR|RUB|тенге|тг\.?|евро|руб\.?)(?![\w])|[₸€₽]", clean(text), flags=re.I)
    values = {currency(t) for t in tokens} - {"UNKNOWN"}
    return next(iter(values)) if len(values) == 1 else "UNKNOWN"
