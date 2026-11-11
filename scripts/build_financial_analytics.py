"""Build auditable tax-return and ESF analytics for the local Vestigo registry.

The source CSV files remain unchanged in data/local-documents.  This script
deduplicates ESF invoices by registration number, aggregates signed declaration
corrections, and writes only compact analytical results for the web interface.
"""

from __future__ import annotations

import os
import csv
import json
import math
import re
import sqlite3
from collections import Counter, defaultdict
from datetime import datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path


ROOT = Path(os.environ.get("VESTIGO_ANALYTICS_ROOT", Path(__file__).resolve().parents[1]))
SOURCE_DIR = ROOT / "data" / "local-documents"
OUTPUT = ROOT / "app" / "data" / "financial-analytics.json"
SEARCH_OUTPUT = ROOT / "app" / "data" / "financial-search-index.json"
REGISTRY_DB = ROOT / "data" / "vestigo-registry.sqlite"
BIN_RE = re.compile(r"(?<!\d)(\d{12})(?!\d)")
EXCLUDED_ESF_STATUSES = {"REVOKED", "CANCELLED", "CANCELED", "ANNULLED", "DELETED", "REJECTED"}


def read_text(path: Path) -> str:
    raw = path.read_bytes()
    if raw.startswith((b"\xff\xfe", b"\xfe\xff")):
        return raw.decode("utf-16")
    utf8 = raw.decode("utf-8-sig", errors="replace")
    return raw.decode("cp1251", errors="replace") if utf8.count("�") > 2 else utf8


def rows(path: Path) -> tuple[list[str], list[list[str]]]:
    lines = [line for line in read_text(path).splitlines() if line.strip()]
    if not lines:
        return [], []
    delimiter = max(("\t", ";", ","), key=lines[0].count)
    reader = csv.reader(lines, delimiter=delimiter)
    return next(reader), list(reader)


def clean(value: object) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def number(value: object) -> float:
    raw = clean(value).replace("\xa0", "").replace(" ", "")
    if not raw:
        return 0.0
    if "," in raw and "." in raw:
        raw = raw.replace(".", "").replace(",", ".")
    else:
        raw = raw.replace(",", ".")
    raw = re.sub(r"[^0-9eE+\-.]", "", raw)
    try:
        value_float = float(raw)
        return value_float if math.isfinite(value_float) else 0.0
    except ValueError:
        return 0.0


def identifier(value: object) -> str:
    raw = clean(value)
    match = BIN_RE.search(raw)
    if match:
        return match.group(1)
    try:
        parsed = Decimal(raw.replace(" ", "").replace(",", "."))
        if parsed == parsed.to_integral_value():
            digits = str(int(parsed))
            return digits.zfill(12) if len(digits) <= 12 else ""
    except (InvalidOperation, ValueError):
        pass
    return ""


def parse_year(value: str) -> int | None:
    match = re.search(r"(20\d{2})", value or "")
    return int(match.group(1)) if match else None


def index_exact(headers: list[str], label: str, start: int = 0) -> int | None:
    return next((index for index in range(start, len(headers)) if clean(headers[index]) == label), None)


def index_any(headers: list[str], *labels: str) -> int | None:
    normalized = {clean(label).casefold() for label in labels}
    return next((index for index, header in enumerate(headers) if clean(header).casefold() in normalized), None)


def at(row: list[str], index: int | None) -> str:
    return clean(row[index]) if index is not None and index < len(row) else ""


def compact_name(value: str) -> str:
    normalized = clean(value).casefold().replace("ё", "е")
    normalized = re.sub(r"[«»\"'()№.,]", " ", normalized)
    normalized = re.sub(r"\b(товарищество|с|ограниченной|ответственностью|тоо|ао|ип|ргп|гкп)\b", " ", normalized)
    return re.sub(r"\s+", " ", normalized).strip()


def normalize_search(value: object) -> str:
    normalized = clean(value).casefold().replace("ё", "е").replace("й", "и")
    normalized = normalized.translate(str.maketrans({
        "қ": "к", "ғ": "г", "ұ": "у", "ү": "у", "ң": "н",
        "һ": "х", "ө": "о", "і": "и", "ә": "а",
    }))
    normalized = re.sub(r'["\'«»“”„`()\[\]{}/\\,.;:!?-]', " ", normalized)
    return re.sub(r"\s+", " ", normalized).strip()


def profile(store: dict[str, dict], bin_value: str, name: str = "") -> dict:
    item = store.setdefault(bin_value, {
        "bin": bin_value,
        "name": name,
        "esf": {"purchases": {}, "sales": {}},
        "form100": {"years": {}, "submissions": 0},
        "form300": {"quarters": {}, "submissions": 0},
        "form328": {"applications": 0, "imports": 0.0, "vatBase": 0.0, "vat": 0.0, "sellers": {}, "goods": {}},
    })
    if name and (not item["name"] or "не указано" in item["name"].casefold()):
        item["name"] = name
    return item


def esf_bucket() -> dict:
    return {
        "invoiceCount": 0, "turnover": 0.0, "vat": 0.0, "total": 0.0,
        "excludedInvoices": 0, "statuses": Counter(), "years": defaultdict(lambda: {"invoiceCount": 0, "turnover": 0.0, "vat": 0.0, "total": 0.0}),
        "counterparties": defaultdict(lambda: {"name": "", "invoiceCount": 0, "turnover": 0.0, "vat": 0.0, "years": defaultdict(float), "goods": defaultdict(float)}),
        "goods": defaultdict(lambda: {"name": "", "code": "", "turnover": 0.0, "quantity": 0.0, "invoices": set()}),
    }


def parse_esf(files: list[Path], profiles: dict[str, dict]) -> dict[str, dict]:
    invoices: dict[str, dict] = {}
    for path in files:
        headers, data = rows(path)
        if not headers:
            continue
        reg_i = index_any(headers, "Регистрационный номер ЭСФ (08/07/2026)", "REGISTRATION_NUMBER")
        if reg_i is None:
            reg_i = 0
        status_i = index_exact(headers, "Статус ЭСФ")
        issue_i = index_any(headers, "Дата выписки", "INVOICE_DATE")
        turnover_date_i = index_any(headers, "Дата совершения оборота", "TURNOVER_DATE")
        updated_i = index_exact(headers, "Дата обновления СФ")
        supplier_name_i = index_any(headers, "Наименование поставщика по данным ИС ЭСФ", "Поставщик")
        supplier_bin_i = index_any(headers, "IIN_SELLER")
        if supplier_bin_i is None:
            supplier_bin_i = max((i for i, h in enumerate(headers[: supplier_name_i or 0]) if clean(h) == "ИИН/БИН"), default=None)
        buyer_name_i = index_any(headers, "Наименование получателя по данным ИС ЭСФ", "Покупатель")
        buyer_bin_i = index_any(headers, "IIN_CUSTOMER", "ИИН/БИН2")
        if buyer_bin_i is None:
            buyer_bin_i = index_exact(headers, "ИИН/БИН", (buyer_name_i or 0) + 1)
        item_no_i = index_exact(headers, "Порядковый номер ТРУ")
        item_name_i = index_exact(headers, "Наименование ТРУ")
        item_code_i = index_any(headers, "Код товара (ТН ВЭД)", "ТН ВЭД")
        quantity_i = index_exact(headers, "Кол-во (объем)")
        line_turnover_i = index_any(headers, "Стоимость товаров, работ, услуг без учета косвенных налогов", "Стоимость")
        total_turnover_i = index_exact(headers, "Всего по счету, размер оборота по реализации")
        total_no_vat_i = index_exact(headers, "Всего по счету, стоимость товаров, работ, услуг без учета косвенных налогов")
        total_vat_i = index_any(headers, "Всего по счету, сумма НДС", "Сумма НДС")
        total_with_vat_i = index_any(headers, "Всего по счету, стоимость товаров, работ, услуг с учетом косвенных налогов", "Общая сумма")
        for row in data:
            reg = at(row, reg_i)
            if not reg:
                continue
            current = invoices.setdefault(reg, {
                "id": reg, "status": "", "issueDate": "", "turnoverDate": "", "updated": "",
                "supplierBin": "", "supplierName": "", "buyerBin": "", "buyerName": "",
                "turnover": 0.0, "vat": 0.0, "total": 0.0, "sources": set(), "items": {},
            })
            current["sources"].add(path.name)
            candidate_updated = at(row, updated_i)
            if not current["updated"] or candidate_updated >= current["updated"]:
                current.update({
                    "status": at(row, status_i), "issueDate": at(row, issue_i), "turnoverDate": at(row, turnover_date_i), "updated": candidate_updated,
                    "supplierBin": identifier(at(row, supplier_bin_i)), "supplierName": at(row, supplier_name_i),
                    "buyerBin": identifier(at(row, buyer_bin_i)), "buyerName": at(row, buyer_name_i),
                })
                owner = BIN_RE.search(path.stem)
                if owner and "приоб" in path.stem.casefold() and not current["buyerBin"]:
                    current["buyerBin"] = owner.group(1)
                if owner and "реал" in path.stem.casefold() and not current["supplierBin"]:
                    current["supplierBin"] = owner.group(1)
            invoice_turnover = number(at(row, total_turnover_i)) or number(at(row, total_no_vat_i))
            if invoice_turnover or not current["turnover"]:
                current["turnover"] = invoice_turnover
            invoice_vat = number(at(row, total_vat_i))
            if invoice_vat or not current["vat"]:
                current["vat"] = invoice_vat
            invoice_total = number(at(row, total_with_vat_i))
            if invoice_total or not current["total"]:
                current["total"] = invoice_total
            item_name = at(row, item_name_i)
            item_turnover = number(at(row, line_turnover_i))
            item_key = "|".join((at(row, item_no_i), item_name, at(row, item_code_i), str(item_turnover), at(row, quantity_i)))
            if item_name and item_key not in current["items"]:
                current["items"][item_key] = {"name": item_name, "code": at(row, item_code_i), "turnover": item_turnover, "quantity": number(at(row, quantity_i))}
    for invoice in invoices.values():
        if not invoice["turnover"]:
            invoice["turnover"] = sum(item["turnover"] for item in invoice["items"].values())
        if not invoice["total"]:
            invoice["total"] = invoice["turnover"] + invoice["vat"]
        for bin_value, name, direction, other_bin, other_name in (
            (invoice["supplierBin"], invoice["supplierName"], "sales", invoice["buyerBin"], invoice["buyerName"]),
            (invoice["buyerBin"], invoice["buyerName"], "purchases", invoice["supplierBin"], invoice["supplierName"]),
        ):
            if not bin_value:
                continue
            target = profile(profiles, bin_value, name)
            bucket = target["esf"].get(direction)
            if not bucket or "statuses" not in bucket:
                bucket = esf_bucket()
                target["esf"][direction] = bucket
            status = invoice["status"] or "Не указан"
            bucket["statuses"][status] += 1
            if status.upper() in EXCLUDED_ESF_STATUSES:
                bucket["excludedInvoices"] += 1
                continue
            year = parse_year(invoice["turnoverDate"] or invoice["issueDate"])
            bucket["invoiceCount"] += 1
            for key in ("turnover", "vat", "total"):
                bucket[key] += invoice[key]
            if year:
                annual = bucket["years"][year]
                annual["invoiceCount"] += 1
                for key in ("turnover", "vat", "total"):
                    annual[key] += invoice[key]
            cp = None
            if other_bin:
                cp = bucket["counterparties"][other_bin]
                cp["name"] = other_name or cp["name"]
                cp["invoiceCount"] += 1
                cp["turnover"] += invoice["turnover"]
                cp["vat"] += invoice["vat"]
                if year:
                    cp["years"][year] += invoice["turnover"]
            for item in invoice["items"].values():
                good_key = f'{item["code"]}|{item["name"]}'
                good = bucket["goods"][good_key]
                good["name"], good["code"] = item["name"], item["code"]
                good["turnover"] += item["turnover"]
                good["quantity"] += item["quantity"]
                good["invoices"].add(invoice["id"])
                if cp is not None and item["name"]:
                    cp["goods"][item["name"]] += item["turnover"]
    return invoices


def parse_declarations(files: list[Path], profiles: dict[str, dict]) -> None:
    for path in files:
        headers, data = rows(path)
        if not headers:
            continue
        header_index = {clean(header): index for index, header in enumerate(headers)}
        form = "100" if path.name.startswith("100.00") else "300"
        for row in data:
            bin_value = identifier(at(row, header_index.get("ИИН/БИН")))
            if not bin_value:
                continue
            name = "".join(at(row, header_index.get(f"payer_name{index}")) for index in (1, 2, 3))
            target = profile(profiles, bin_value, name)
            if form == "100":
                year = parse_year(at(row, header_index.get("Отчетный год")) or at(row, header_index.get("period_year")))
                if not year:
                    continue
                annual = target["form100"]["years"].setdefault(year, defaultdict(float))
                for key in ("field_100_00_001", "field_100_00_018", "field_100_00_040", "field_100_00_044", "field_100_00_054", "field_100_00_055", "field_100_00_056", "field_100_00_057", "field_100_00_058", "field_100_00_059", "field_100_00_062"):
                    if key in header_index:
                        if key == "field_100_00_056":
                            annual[key] = number(at(row, header_index[key])) or annual[key]
                        else:
                            annual[key] += number(at(row, header_index[key]))
                annual["submissions"] += 1
                target["form100"]["submissions"] += 1
            else:
                year = parse_year(at(row, header_index.get("period_year")) or at(row, header_index.get("Налоговый период - ФНО")))
                quarter = int(number(at(row, header_index.get("period_quarter")) or at(row, header_index.get("Отчетный квартал"))))
                if not year or quarter not in (1, 2, 3, 4):
                    continue
                period = f"{year}-Q{quarter}"
                quarterly = target["form300"]["quarters"].setdefault(period, defaultdict(float))
                for key in ("field_300_00_001_A", "field_300_00_001_B", "field_300_00_006", "field_300_00_012", "field_300_00_013_A", "field_300_00_013_B", "field_300_00_021", "field_300_00_023", "field_300_00_025_01", "field_300_00_030_01", "field_300_00_030_02"):
                    if key in header_index:
                        quarterly[key] += number(at(row, header_index[key]))
                quarterly["submissions"] += 1
                target["form300"]["submissions"] += 1


def resolve_known_bin(raw_id: str, name: str, profiles: dict[str, dict], name_index: dict[str, str]) -> str:
    exact = identifier(raw_id)
    if exact in profiles:
        return exact
    compact = compact_name(name)
    if compact in name_index:
        return name_index[compact]
    return exact


def parse_form328(files: list[Path], profiles: dict[str, dict]) -> None:
    compact_bins: dict[str, set[str]] = defaultdict(set)
    for bin_value, item in profiles.items():
        normalized = compact_name(item["name"])
        if normalized:
            compact_bins[normalized].add(bin_value)
    name_index = {name: next(iter(bins)) for name, bins in compact_bins.items() if len(bins) == 1}
    for path in files:
        headers, data = rows(path)
        if not headers:
            continue
        def idx(label: str, start: int = 0) -> int | None:
            return index_exact(headers, label, start)
        seller_name_i = idx("Наименование продавца")
        seller_bin_i = idx("Идентификационный код (номер) продавца")
        buyer_name_i = idx("Наименование покупателя")
        buyer_bin_i = idx("Идентификационный код (номер) покупателя")
        reg_i = 0
        product_i = idx("Наименование товара")
        code_i = idx("Код товара ТНВЭД")
        value_i = idx("Стоимость товара")
        vat_base_i = idx("Налоговая база (НДС)")
        vat_i = idx("Суммы налогов (НДС)")
        applications: dict[str, set[str]] = defaultdict(set)
        for row in data:
            buyer_name = at(row, buyer_name_i)
            buyer_bin = resolve_known_bin(at(row, buyer_bin_i), buyer_name, profiles, name_index)
            if not buyer_bin:
                continue
            target = profile(profiles, buyer_bin, buyer_name)
            app = target["form328"]
            reg = at(row, reg_i)
            applications[buyer_bin].add(reg)
            value = number(at(row, value_i))
            vat_base = number(at(row, vat_base_i))
            vat = number(at(row, vat_i))
            app["imports"] += value
            app["vatBase"] += vat_base
            app["vat"] += vat
            seller_name = at(row, seller_name_i)
            seller_bin = resolve_known_bin(at(row, seller_bin_i), seller_name, profiles, name_index)
            seller_key = seller_bin or seller_name
            seller = app["sellers"].setdefault(seller_key, {"bin": seller_bin, "name": seller_name, "amount": 0.0, "vat": 0.0})
            seller["amount"] += value
            seller["vat"] += vat
            product = at(row, product_i)
            if product:
                good_key = f"{at(row, code_i)}|{product}"
                good = app["goods"].setdefault(good_key, {"code": at(row, code_i), "name": product, "amount": 0.0})
                good["amount"] += value
        for bin_value, regs in applications.items():
            profiles[bin_value]["form328"]["applications"] += len(regs)


def round_amount(value: float) -> int | float:
    return int(round(value)) if abs(value - round(value)) < 0.01 else round(value, 2)


def finalize_esf(bucket: dict) -> dict:
    if not bucket or "statuses" not in bucket:
        bucket = esf_bucket()
    total = bucket["turnover"]
    counterparties = []
    for bin_value, item in bucket["counterparties"].items():
        top_goods = sorted(item["goods"].items(), key=lambda value: (-value[1], value[0]))[:3]
        counterparties.append({
            "bin": bin_value, "name": item["name"], "invoiceCount": item["invoiceCount"],
            "turnover": round_amount(item["turnover"]), "vat": round_amount(item["vat"]),
            "share": round(item["turnover"] / total * 100, 2) if total else 0,
            "years": [{"year": year, "turnover": round_amount(amount)} for year, amount in sorted(item["years"].items())],
            "goods": [{"name": name, "turnover": round_amount(amount)} for name, amount in top_goods],
        })
    counterparties.sort(key=lambda item: (-item["turnover"], item["name"]))
    goods = [{
        "name": item["name"], "code": item["code"], "turnover": round_amount(item["turnover"]),
        "quantity": round_amount(item["quantity"]), "invoiceCount": len(item["invoices"]),
    } for item in bucket["goods"].values()]
    goods.sort(key=lambda item: (-item["turnover"], item["name"]))
    return {
        "invoiceCount": bucket["invoiceCount"], "turnover": round_amount(bucket["turnover"]), "vat": round_amount(bucket["vat"]), "total": round_amount(bucket["total"]),
        "excludedInvoices": bucket["excludedInvoices"], "statuses": dict(bucket["statuses"]),
        "years": [{"year": year, **{key: round_amount(value) for key, value in annual.items()}} for year, annual in sorted(bucket["years"].items())],
        "counterparties": counterparties, "counterpartyCount": len(counterparties), "goods": goods,
    }


def annual_form300(quarters: dict[str, dict]) -> list[dict]:
    annual: dict[int, defaultdict] = defaultdict(lambda: defaultdict(float))
    for period, values in quarters.items():
        year = int(period[:4])
        for key, value in values.items():
            annual[year][key] += value
    return [{"year": year, **{key: round_amount(value) for key, value in values.items()}} for year, values in sorted(annual.items())]


def risk_signals(item: dict) -> tuple[list[dict], list[dict]]:
    sales = item["esf"]["sales"]
    purchases = item["esf"]["purchases"]
    signals: list[dict] = []
    reconciliation: list[dict] = []
    top_sales = sales["counterparties"][0] if sales["counterparties"] else None
    top_purchases = purchases["counterparties"][0] if purchases["counterparties"] else None
    for direction, top, total in (("реализации", top_sales, sales["turnover"]), ("приобретений", top_purchases, purchases["turnover"])):
        if top and total > 1_000_000 and top["share"] >= 50:
            signals.append({"severity": "medium", "code": "CONCENTRATION", "title": f"Высокая концентрация {direction}", "detail": f'{top["share"]:.1f}% суммы приходится на «{top["name"]}».', "value": top["share"]})
    for direction, payload in (("реализации", sales), ("приобретения", purchases)):
        years = payload["years"]
        for previous, current in zip(years, years[1:]):
            base = abs(previous["turnover"])
            if base >= 1_000_000 and abs(current["turnover"] - previous["turnover"]) / base >= 2:
                change = (current["turnover"] / previous["turnover"] - 1) * 100 if previous["turnover"] else 0
                signals.append({"severity": "medium", "code": "ABRUPT_CHANGE", "title": f"Резкое изменение объёма {direction}", "detail": f'{previous["year"]} → {current["year"]}: {change:+.0f}%. Требуется сверка периода и корректировочных ЭСФ.', "value": round(change, 1)})
    sales_by_year = {row["year"]: row for row in sales["years"]}
    form300_by_year = {row["year"]: row for row in item["form300"]["years"]}
    for year in sorted(set(sales_by_year) & set(form300_by_year)):
        esf_value = sales_by_year[year]["turnover"]
        declared = form300_by_year[year].get("field_300_00_006", 0)
        delta = esf_value - declared
        ratio = abs(delta) / max(abs(esf_value), abs(declared), 1)
        reconciliation.append({"year": year, "esfSales": esf_value, "vatTurnover": declared, "delta": round_amount(delta), "deltaPct": round(ratio * 100, 2)})
        if abs(delta) >= 1_000_000 and ratio >= 0.3:
            signals.append({"severity": "high", "code": "ESF_VAT_MISMATCH", "title": f"Расхождение ЭСФ и формы 300.00 за {year} год", "detail": f"Оборот по ЭСФ отличается от задекларированного оборота на {ratio * 100:.1f}%. Это контрольный сигнал, а не вывод о нарушении.", "value": round_amount(delta)})
    status_total = sales["invoiceCount"] + sales["excludedInvoices"] + purchases["invoiceCount"] + purchases["excludedInvoices"]
    excluded = sales["excludedInvoices"] + purchases["excludedInvoices"]
    if status_total and excluded / status_total >= 0.1:
        signals.append({"severity": "medium", "code": "REVOKED_ESF", "title": "Значительная доля исключённых ЭСФ", "detail": f"{excluded} из {status_total} счетов-фактур имеют отменённый или отозванный статус.", "value": round(excluded / status_total * 100, 1)})
    if purchases["turnover"] > 1_000_000 and sales["turnover"] > 0 and purchases["turnover"] / sales["turnover"] >= 2:
        signals.append({"severity": "medium", "code": "PURCHASE_SALES_GAP", "title": "Приобретения существенно выше реализации", "detail": f'Соотношение приобретений к реализации: {purchases["turnover"] / sales["turnover"]:.1f}×. Следует проверить остатки, период и дальнейшее движение товара.', "value": round(purchases["turnover"] / sales["turnover"], 2)})
    return signals, reconciliation


def finalize(profiles: dict[str, dict]) -> dict:
    result: dict[str, dict] = {}
    for bin_value, item in profiles.items():
        item["esf"]["purchases"] = finalize_esf(item["esf"].get("purchases", {}))
        item["esf"]["sales"] = finalize_esf(item["esf"].get("sales", {}))
        form100_years = []
        for year, values in sorted(item["form100"]["years"].items()):
            form100_years.append({"year": year, **{key: round_amount(value) for key, value in values.items()}})
        item["form100"]["years"] = form100_years
        quarters = item["form300"]["quarters"]
        item["form300"]["years"] = annual_form300(quarters)
        item["form300"]["quarters"] = [{"period": period, **{key: round_amount(value) for key, value in values.items()}} for period, values in sorted(quarters.items())]
        imports = item["form328"]
        imports["imports"], imports["vatBase"], imports["vat"] = map(round_amount, (imports["imports"], imports["vatBase"], imports["vat"]))
        imports["sellers"] = sorted(imports["sellers"].values(), key=lambda value: -value["amount"])
        imports["goods"] = sorted(imports["goods"].values(), key=lambda value: -value["amount"])
        for values in imports["sellers"] + imports["goods"]:
            for key in ("amount", "vat"):
                if key in values:
                    values[key] = round_amount(values[key])
        signals, reconciliation = risk_signals(item)
        item["signals"] = signals
        item["reconciliation"] = reconciliation
        result[bin_value] = item
    return result


def merge_financial_entities_into_registry(search_entities: list[dict], generated_at: str) -> int:
    """Add every ESF participant to the common object registry, once per BIN/IIN."""
    if not REGISTRY_DB.exists():
        return 0

    conn = sqlite3.connect(str(REGISTRY_DB), timeout=60)
    try:
        cur = conn.cursor()
        cur.execute("PRAGMA busy_timeout = 60000")
        rows = []
        for item in search_entities:
            bin_value = clean(item.get("bin"))
            if not re.fullmatch(r"\d{12}", bin_value):
                continue

            name = clean(item.get("name")) or f"Организация {bin_value}"
            role = clean(item.get("role")) or "Участник ЭСФ"
            categories = json.dumps([role, "Электронные счета-фактуры"], ensure_ascii=False)
            category_codes = json.dumps(["ESF_COUNTERPARTY", "LOCAL_ESF"], ensure_ascii=False)
            documents = json.dumps([{
                "category": "Электронные счета-фактуры",
                "number": "Свод по загруженным ЭСФ",
                "date": generated_at[:10],
            }], ensure_ascii=False)
            reason = "Участник найден среди поставщиков или получателей в загруженных ЭСФ."
            search_text = " ".join(filter(None, (
                bin_value,
                normalize_search(name),
                normalize_search(role),
                "эсф электронные счета фактуры поставщик получатель контрагент",
            )))
            rows.append((
                bin_value, bin_value, name, normalize_search(name), role,
                "", "", "Регион определяется по данным источников", "", "", "",
                categories, category_codes, documents,
                int(item.get("risk") or 35), clean(item.get("level")) or "Низкий", 1,
                int(item.get("connections") or 0), role, reason, 0.0,
                "Загруженные ЭСФ", search_text,
            ))

        before = conn.total_changes
        cur.executemany("""
        INSERT OR IGNORE INTO entities (
            id, bin, name, normalized_name, role, head, head_iin, city, address, oked, oked_name,
            categories, category_codes, documents, risk, level, signals, connections, status,
            reason, total_amount, source_file, search_text
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, rows)
        inserted = conn.total_changes - before

        if inserted:
            cur.execute("INSERT INTO entities_fts(entities_fts) VALUES('rebuild')")
            cur.execute("PRAGMA optimize")
        conn.commit()
        return inserted
    finally:
        conn.close()


def is_esf_file(path: Path) -> bool:
    with path.open("rb") as handle:
        sample = handle.read(131072)
    if sample.startswith((b"\xff\xfe", b"\xfe\xff")):
        text = sample.decode("utf-16", errors="ignore")
    else:
        text = sample.decode("utf-8-sig", errors="replace")
        if text.count("�") > 2: text = sample.decode("cp1251", errors="replace")
    return ("регистрационный номер эсф" in text.casefold() or "registration_number" in text.casefold() or
        any(term in path.stem.casefold() for term in ["приоб", "реал", "эсф"]))


def main() -> None:
    files = sorted(SOURCE_DIR.glob("*.csv"))
    profiles: dict[str, dict] = {}
    declaration_files = [path for path in files if path.name.startswith(("100.00", "300.00"))]
    esf_files = [path for path in files if is_esf_file(path)]
    form328_files = [path for path in files if path.name.startswith("328.00")]
    invoices = parse_esf(esf_files, profiles)
    parse_declarations(declaration_files, profiles)
    parse_form328(form328_files, profiles)
    finalized_entities = finalize(profiles)
    payload = {
        "generatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "methodology": {
            "esf": "Одна ЭСФ считается один раз по регистрационному номеру; товарные строки не умножают итог счета. Отозванные и отменённые ЭСФ исключены из сумм.",
            "declarations": "Очередные и дополнительные формы суммируются как подписанные значения за период; отрицательные корректировки уменьшают итог.",
            "warning": "Расхождения и риск-сигналы предназначены для приоритизации ручной проверки и сами по себе не подтверждают нарушение.",
        },
        "sources": [path.name for path in files],
        "audit": {"profiles": len(profiles), "uniqueEsfInvoices": len(invoices), "sourceFiles": len(files)},
        "entities": finalized_entities,
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    temporary_output = OUTPUT.with_suffix(f"{OUTPUT.suffix}.tmp")
    temporary_output.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    temporary_output.replace(OUTPUT)

    search_entities = []
    for item in finalized_entities.values():
        purchases = item["esf"]["purchases"]
        sales = item["esf"]["sales"]
        purchase_count = purchases["invoiceCount"] + purchases["excludedInvoices"]
        sales_count = sales["invoiceCount"] + sales["excludedInvoices"]
        if purchase_count and sales_count:
            role = "Контрагент ЭСФ · покупатель и поставщик"
        elif purchase_count:
            role = "Контрагент ЭСФ · покупатель"
        elif sales_count:
            role = "Контрагент ЭСФ · поставщик"
        else:
            role = "Участник локальных документов"
        counterparties = {
            value.get("bin", "")
            for side in (purchases, sales)
            for value in side.get("counterparties", [])
            if value.get("bin")
        }
        severities = {signal.get("severity", "") for signal in item.get("signals", [])}
        if "high" in severities:
            risk, level = 75, "Высокий"
        elif "medium" in severities:
            risk, level = 50, "Средний"
        else:
            risk, level = 35, "Низкий"
        search_entities.append({
            "bin": item["bin"],
            "name": item["name"],
            "role": role,
            "connections": len(counterparties),
            "risk": risk,
            "level": level,
        })
    search_payload = {
        "generatedAt": payload["generatedAt"],
        "entities": search_entities,
    }
    temporary_search = SEARCH_OUTPUT.with_suffix(f"{SEARCH_OUTPUT.suffix}.tmp")
    temporary_search.write_text(json.dumps(search_payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    temporary_search.replace(SEARCH_OUTPUT)
    registry_inserted = merge_financial_entities_into_registry(search_entities, payload["generatedAt"])
    payload["audit"]["registryParticipantsAdded"] = registry_inserted
    print(json.dumps(payload["audit"], ensure_ascii=False))


if __name__ == "__main__":
    main()
