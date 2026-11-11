"""Import the locally supplied workbook of transactions into Vestigo.

The source workbook remains on the user's computer.  This script extracts the
machine-readable transaction rows and writes a local JSON index used only by
the local platform.
"""

from __future__ import annotations

import os
import json
import re
import sys
from datetime import datetime
from pathlib import Path

import pandas as pd


ROOT = Path(os.environ.get("VESTIGO_ANALYTICS_ROOT", Path(__file__).resolve().parents[1]))
INPUT = Path(sys.argv[1]).expanduser().resolve() if len(sys.argv) > 1 else ROOT / "data" / "source-documents" / "Сделки.xlsx"
OUTPUT = ROOT / "app" / "data" / "deals.json"


def clean(value: object) -> str:
    if value is None or pd.isna(value):
        return ""
    return re.sub(r"\s+", " ", str(value)).strip()


def bin_value(value: object) -> str:
    digits = re.sub(r"\D", "", clean(value))
    return digits if len(digits) == 12 else ""


def value_at(row: list[object], index: int | None) -> str:
    return clean(row[index]) if index is not None and index < len(row) else ""


def column_index(headers: list[str], phrase: str, occurrence: int = 0) -> int | None:
    matches = [index for index, header in enumerate(headers) if phrase.casefold() in header.casefold()]
    return matches[occurrence] if len(matches) > occurrence else None


def record_from_row(row: list[object], sheet: str, number: int, columns: dict[str, int | None]) -> dict | None:
    supplier_bin = bin_value(value_at(row, columns["supplier_bin"]))
    buyer_bin = bin_value(value_at(row, columns["buyer_bin"]))
    if not supplier_bin or not buyer_bin:
        return None
    amount_raw = value_at(row, columns["amount"])
    vat_raw = value_at(row, columns["vat"])
    try:
        amount = float(amount_raw.replace(" ", "").replace(",", ".")) if amount_raw else 0
    except ValueError:
        amount = 0
    try:
        vat = float(vat_raw.replace(" ", "").replace(",", ".")) if vat_raw else 0
    except ValueError:
        vat = 0
    return {
        "id": f"{sheet}-{number}-{supplier_bin}-{buyer_bin}",
        "sheet": sheet,
        "supplier": {"bin": supplier_bin, "name": value_at(row, columns["supplier_name"])},
        "buyer": {"bin": buyer_bin, "name": value_at(row, columns["buyer_name"])},
        "amount": amount,
        "vat": vat,
        "periodFrom": value_at(row, columns["period_from"]),
        "periodTo": value_at(row, columns["period_to"]),
        "claimNumber": value_at(row, columns["claim"]),
        "claimDate": value_at(row, columns["claim_date"]),
        "courtDecision": value_at(row, columns["decision"]),
        "courtDate": value_at(row, columns["decision_date"]),
        "reason": value_at(row, columns["reason"]),
    }


def header_columns(headers: list[str]) -> dict[str, int | None]:
    company_columns = [index for index, header in enumerate(headers) if "наименование компании" in header.casefold()]
    bin_columns = [index for index, header in enumerate(headers) if "бин/иин" in header.casefold()]
    return {
        "supplier_name": company_columns[0] if company_columns else None,
        "supplier_bin": bin_columns[0] if bin_columns else None,
        "buyer_name": column_index(headers, "наименование покупателя"),
        "buyer_bin": bin_columns[1] if len(bin_columns) > 1 else None,
        "amount": column_index(headers, "сумма взаиморасчетов"),
        "vat": column_index(headers, "сумма ндс"),
        "period_from": column_index(headers, "начальная дата"),
        "period_to": column_index(headers, "конечная дата"),
        "claim": column_index(headers, "номер иска"),
        "claim_date": column_index(headers, "дата иска"),
        "decision": column_index(headers, "номер решения суда"),
        "decision_date": column_index(headers, "дата решения суда"),
        "reason": column_index(headers, "причина подачи иска"),
    }


def main() -> None:
    if not INPUT.exists():
        payload = {
            "source": {
                "name": "Сделки",
                "file": "",
                "importedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
            },
            "stats": {"deals": 0, "participants": 0, "amount": 0, "duplicatesRemoved": 0},
            "deals": [],
        }
        OUTPUT.parent.mkdir(parents=True, exist_ok=True)
        temporary_output = OUTPUT.with_suffix(f"{OUTPUT.suffix}.tmp")
        temporary_output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary_output.replace(OUTPUT)
        print(json.dumps(payload["stats"], ensure_ascii=False))
        return
    workbook = pd.ExcelFile(INPUT)
    deals: list[dict] = []
    for sheet in workbook.sheet_names:
        frame = pd.read_excel(INPUT, sheet_name=sheet, header=None, dtype=object).fillna("")
        if frame.empty:
            continue
        rows = frame.values.tolist()
        header_index = next((index for index, row in enumerate(rows[:10]) if any("бин/иин" in clean(cell).casefold() for cell in row)), None)
        if header_index is None:
            # Лист 4 uses the template layout from the preceding sheet but has
            # no repeated header row.
            if len(rows[0]) >= 19:
                columns = {
                    "supplier_name": 3, "supplier_bin": 4, "buyer_name": 5, "buyer_bin": 6,
                    "amount": 7, "vat": 8, "period_from": 9, "period_to": 10,
                    "claim": 14, "claim_date": 15, "reason": 16, "decision": 17, "decision_date": 18,
                }
                data_rows = rows
            else:
                continue
        else:
            columns = header_columns([clean(cell) for cell in rows[header_index]])
            data_rows = rows[header_index + 1:]
        for number, row in enumerate(data_rows, start=1):
            record = record_from_row(row, sheet, number, columns)
            if record:
                deals.append(record)

    # A row number is not a transaction identifier: the same operation may be
    # copied to another row or sheet.  Remove only fully identical business
    # records; similar amounts between the same parties remain separate.
    def identity(item: dict) -> tuple:
        return (
            item["supplier"]["bin"], item["buyer"]["bin"],
            clean(item["supplier"]["name"]).casefold(), clean(item["buyer"]["name"]).casefold(),
            item["amount"], item["vat"], item["periodFrom"], item["periodTo"],
            item["claimNumber"], item["claimDate"], item["courtDecision"],
            item["courtDate"], item["reason"],
        )

    unique: dict[tuple, dict] = {}
    for item in deals:
        unique.setdefault(identity(item), item)
    ordered = sorted(unique.values(), key=lambda item: (item["supplier"]["bin"], item["buyer"]["bin"], item["id"]))
    bins = {item["supplier"]["bin"] for item in ordered} | {item["buyer"]["bin"] for item in ordered}
    payload = {
        "source": {"name": "Сделки", "file": INPUT.name, "importedAt": datetime.now().astimezone().isoformat(timespec="seconds")},
        "stats": {
            "deals": len(ordered),
            "participants": len(bins),
            "amount": round(sum(item["amount"] for item in ordered), 2),
            "duplicatesRemoved": len(deals) - len(ordered),
        },
        "deals": ordered,
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    temporary_output = OUTPUT.with_suffix(f"{OUTPUT.suffix}.tmp")
    temporary_output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary_output.replace(OUTPUT)
    print(json.dumps(payload["stats"], ensure_ascii=False))


if __name__ == "__main__":
    main()
