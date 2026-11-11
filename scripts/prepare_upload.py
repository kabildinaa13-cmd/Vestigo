"""Prepare a user-uploaded document for the local Vestigo import pipeline."""

from __future__ import annotations

import os
import io
import json
import re
import shutil
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import pandas as pd

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(os.environ.get("VESTIGO_ANALYTICS_ROOT", Path(__file__).resolve().parents[1]))
LOCAL_DOCUMENTS = ROOT / "data" / "local-documents"
SOURCE_UPLOADS = ROOT / "data" / "source-documents" / "uploads"
DEALS_SOURCE = ROOT / "data" / "source-documents" / "Сделки.xlsx"
IDENTIFIER_HEADER = re.compile(r"бин|иин|bin|iin|идентификацион|договор|контракт|заказчик|поставщик", re.IGNORECASE)


def clean(value: object) -> str:
    if value is None or pd.isna(value):
        return ""
    return re.sub(r"\s+", " ", str(value)).strip()


def safe_part(value: str, fallback: str) -> str:
    normalized = re.sub(r"[^\w.-]+", "_", value, flags=re.UNICODE).strip("._")
    return normalized or fallback


def unique_headers(values: list[object]) -> list[str]:
    counts: dict[str, int] = {}
    result: list[str] = []
    for index, value in enumerate(values):
        base = clean(value) or f"Колонка {index + 1}"
        counts[base] = counts.get(base, 0) + 1
        result.append(base if counts[base] == 1 else f"{base} ({counts[base]})")
    return result


def header_row(frame: pd.DataFrame) -> int:
    limit = min(30, len(frame.index))
    for index in range(limit):
        values = [clean(value) for value in frame.iloc[index].tolist()]
        if any(IDENTIFIER_HEADER.search(value) for value in values):
            return index
    for index in range(limit):
        if sum(bool(clean(value)) for value in frame.iloc[index].tolist()) >= 2:
            return index
    return 0


def has_named_columns(frame: pd.DataFrame) -> bool:
    if isinstance(frame.columns, pd.MultiIndex):
        return True
    cols = [clean(c) for c in frame.columns]
    return any(re.search(r"[a-zA-Zа-яА-ЯёЁқғұүңһөі]", c) for c in cols)


def write_frame(frame: pd.DataFrame, target: Path) -> int:
    frame = frame.fillna("")
    if frame.empty:
        return 0

    if has_named_columns(frame):
        if isinstance(frame.columns, pd.MultiIndex):
            headers = unique_headers([" ".join(str(part) for part in col if clean(part)) for col in frame.columns])
        else:
            headers = unique_headers(frame.columns.tolist())
        rows = frame.copy()
        rows.columns = headers
        rows = rows.loc[~rows.apply(lambda row: all(not clean(value) for value in row), axis=1)]
        rows.to_csv(target, index=False, sep=";", encoding="utf-8-sig")
        return len(rows.index)

    first = header_row(frame)
    headers = unique_headers(frame.iloc[first].tolist())
    rows = frame.iloc[first + 1 :].copy()
    rows.columns = headers
    rows = rows.loc[~rows.apply(lambda row: all(not clean(value) for value in row), axis=1)]
    rows.to_csv(target, index=False, sep=";", encoding="utf-8-sig")
    return len(rows.index)


def parse_xml_spreadsheet(text: str) -> list[tuple[str, pd.DataFrame]]:
    """Parse XML Spreadsheet 2003 format (Excel XML)."""
    try:
        root = ET.fromstring(text)
        ns = {"ss": "urn:schemas-microsoft-com:office:spreadsheet"}
        worksheets = root.findall(".//ss:Worksheet", ns) or root.findall(".//Worksheet")
        results = []
        for index, ws in enumerate(worksheets, start=1):
            sheet_name = ws.attrib.get(f"{{{ns['ss']}}}Name", ws.attrib.get("Name", f"Лист{index}"))
            rows_data = []
            for row in ws.findall(".//ss:Row", ns) or ws.findall(".//Row"):
                row_cells = []
                for cell in row.findall(".//ss:Cell", ns) or row.findall(".//Cell"):
                    data_elem = cell.find(".//ss:Data", ns) or cell.find(".//Data")
                    val = clean(data_elem.text) if data_elem is not None and data_elem.text else ""
                    row_cells.append(val)
                if any(row_cells):
                    rows_data.append(row_cells)
            if rows_data:
                max_cols = max(len(r) for r in rows_data)
                padded = [r + [""] * (max_cols - len(r)) for r in rows_data]
                df = pd.DataFrame(padded, dtype=object)
                results.append((sheet_name, df))
        return results
    except Exception:
        return []


def load_excel_tables(source: Path) -> list[tuple[str, pd.DataFrame]]:
    raw = source.read_bytes()
    lower_start = raw[:3000].lower()

    # 1. HTML table disguised as .xls (e.g. Goszakup, eGov, 1C web exports)
    if b"<html" in lower_start or b"<table" in lower_start or b"<!doctype html" in lower_start or b"<body" in lower_start:
        for enc in ("utf-8", "cp1251", "utf-16", "windows-1251"):
            try:
                text = raw.decode(enc)
                tables = pd.read_html(io.StringIO(text), flavor="lxml")
                if tables:
                    return [(f"Лист{i+1}", t.astype(object)) for i, t in enumerate(tables) if not t.empty]
            except Exception:
                continue

        # Check if frameset references sheet001.htm in adjacent .files directory
        match = re.search(r'WorksheetSource\s+HRef="([^"]+)"', raw.decode("utf-8", errors="replace"), re.IGNORECASE)
        if match:
            sheet_rel = match.group(1).replace("\\", "/")
            sheet_path = source.parent / sheet_rel
            if sheet_path.exists():
                sheet_raw = sheet_path.read_bytes()
                for enc in ("utf-8", "cp1251", "utf-16"):
                    try:
                        sheet_text = sheet_raw.decode(enc)
                        tables = pd.read_html(io.StringIO(sheet_text), flavor="lxml")
                        if tables:
                            return [(f"Лист{i+1}", t.astype(object)) for i, t in enumerate(tables) if not t.empty]
                    except Exception:
                        continue

    # 2. XML Spreadsheet 2003
    if b"<?xml" in lower_start and (b"urn:schemas-microsoft-com:office:spreadsheet" in lower_start or b"<workbook" in lower_start):
        for enc in ("utf-8", "cp1251", "utf-16"):
            try:
                text = raw.decode(enc)
                parsed = parse_xml_spreadsheet(text)
                if parsed:
                    return parsed
            except Exception:
                continue

    # 3. Openpyxl / standard ZIP Excel (.xlsx)
    if raw[:4] == b"PK\x03\x04":
        try:
            wb = pd.ExcelFile(source, engine="openpyxl")
            return [(s, pd.read_excel(wb, sheet_name=s, header=None, dtype=object)) for s in wb.sheet_names]
        except Exception:
            pass

    # 4. XLRD / BIFF8 binary (.xls)
    if raw[:8] == b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1":
        try:
            wb = pd.ExcelFile(source, engine="xlrd")
            return [(s, pd.read_excel(wb, sheet_name=s, header=None, dtype=object)) for s in wb.sheet_names]
        except Exception:
            pass

    # 5. Generic pd.ExcelFile
    try:
        wb = pd.ExcelFile(source)
        return [(s, pd.read_excel(wb, sheet_name=s, header=None, dtype=object)) for s in wb.sheet_names]
    except Exception:
        pass

    # 6. Fallback delimited text
    for sep in (";", "\t", ","):
        for enc in ("utf-8-sig", "cp1251", "utf-16"):
            try:
                df = pd.read_csv(source, sep=sep, encoding=enc, header=None, dtype=object)
                if len(df.columns) > 1 and len(df) > 0:
                    return [("Лист1", df)]
            except Exception:
                continue

    raise ValueError(f"Не удалось распознать формат файла Excel: {source.name}")


def prepare_excel(source: Path) -> tuple[list[str], int]:
    prefix = safe_part(source.stem, "upload")
    for previous in LOCAL_DOCUMENTS.glob(f"{prefix}__*.csv"):
        previous.unlink()
    generated: list[str] = []
    rows = 0

    tables = load_excel_tables(source)
    for index, (sheet_name, frame) in enumerate(tables, start=1):
        target = LOCAL_DOCUMENTS / f"{prefix}__{safe_part(sheet_name, f'Лист{index}')}.csv"
        count = write_frame(frame, target)
        if count:
            generated.append(target.name)
            rows += count
        elif target.exists():
            target.unlink()
    return generated, rows


def prepare_json(source: Path) -> tuple[list[str], int]:
    payload = json.loads(source.read_text(encoding="utf-8-sig"))
    if isinstance(payload, list):
        rows = payload
    elif isinstance(payload, dict):
        rows = next((value for value in payload.values() if isinstance(value, list)), [payload])
    else:
        rows = []
    objects = [row for row in rows if isinstance(row, dict)]
    if not objects:
        return [], 0
    frame = pd.json_normalize(objects).fillna("")
    target = LOCAL_DOCUMENTS / f"{safe_part(source.stem, 'upload')}__JSON.csv"
    frame.to_csv(target, index=False, sep=";", encoding="utf-8-sig")
    return [target.name], len(frame.index)


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: prepare_upload.py <file>")
    source = Path(sys.argv[1]).resolve()
    if not source.exists() or not source.is_file():
        raise SystemExit(f"File not found: {source}")

    LOCAL_DOCUMENTS.mkdir(parents=True, exist_ok=True)
    SOURCE_UPLOADS.mkdir(parents=True, exist_ok=True)
    archived = SOURCE_UPLOADS / source.name
    if source != archived:
        shutil.copy2(source, archived)

    suffix = source.suffix.casefold()
    if source.stem.split("__")[0].casefold() == "сделки" and suffix == ".xlsx":
        shutil.copy2(source, DEALS_SOURCE)
        result = {"mode": "deals", "source": source.name, "generated": [DEALS_SOURCE.name], "rows": 0}
    elif suffix == ".csv":
        target = LOCAL_DOCUMENTS / source.name
        if source != target:
            shutil.copy2(source, target)
        result = {"mode": "evidence", "source": source.name, "generated": [target.name], "rows": 0}
    elif suffix in {".xlsx", ".xls"}:
        generated, rows = prepare_excel(source)
        result = {"mode": "evidence", "source": source.name, "generated": generated, "rows": rows}
    elif suffix == ".json":
        generated, rows = prepare_json(source)
        result = {"mode": "evidence", "source": source.name, "generated": generated, "rows": rows}
    else:
        raise SystemExit("Supported formats: CSV, JSON, XLSX and XLS")

    if not result["generated"]:
        raise SystemExit("No data rows were found in the uploaded file")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
