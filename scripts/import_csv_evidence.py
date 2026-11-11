import csv
import json
import os
import re
import sqlite3
import sys
import time
from uuid import uuid4
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(os.environ.get("VESTIGO_ANALYTICS_ROOT", Path(__file__).resolve().parents[1]))
DB_PATH = ROOT / "data" / "vestigo-registry.sqlite"
LOCAL_DOCS = ROOT / "data" / "local-documents"
KGD_PATH = ROOT / "app" / "data" / "registry.json"
BIN_PATTERN = re.compile(r"(?<!\d)(\d{12})(?!\d)")

def normalize(value: object) -> str:
    s = str(value or "").lower()
    s = re.sub(r'["\'«»“”„`]', " ", s)
    s = re.sub(r"[()\[\]{}/\\,.;:!?-]", " ", s)
    s = s.replace("ё", "е")
    s = s.replace("й", "и")
    s = s.replace("қ", "к").replace("ғ", "г").replace("ұ", "у").replace("ү", "у")
    s = s.replace("ң", "н").replace("һ", "х").replace("ө", "о").replace("і", "и").replace("ә", "а")
    return re.sub(r"\s+", " ", s).strip()

def format_money(amount: float) -> str:
    if amount >= 1_000_000_000:
        return f"{amount / 1_000_000_000:.1f} млрд ₸"
    if amount >= 1_000_000:
        return f"{amount / 1_000_000:.1f} млн ₸"
    if amount > 0:
        return f"{round(amount):,} ₸".replace(",", " ")
    return ""

def parse_amount(value: str) -> float:
    if not value:
        return 0.0
    cleaned = re.sub(r"[^\d.,]", "", value).replace(" ", "").replace(",", ".")
    try:
        return float(cleaned)
    except ValueError:
        return 0.0

def read_text(path: Path) -> str:
    raw = path.read_bytes()
    if raw.startswith(b"\xff\xfe") or raw.startswith(b"\xfe\xff"):
        return raw.decode("utf-16", errors="replace")
    
    candidates = ["utf-8-sig", "utf-8", "cp1251"]
    best_text = ""
    best_score = -1
    for enc in candidates:
        try:
            txt = raw.decode(enc)
            sample = txt[:8000]
            score = sum(1 for c in sample if "\u0400" <= c <= "\u04ff")
            score -= sample.count("\ufffd") * 100
            if score > best_score:
                best_score = score
                best_text = txt
        except UnicodeDecodeError:
            pass
    return best_text or raw.decode("cp1251", errors="replace")

def detect_delimiter(sample: str) -> str:
    return max(("\t", ";", ","), key=sample.count)

def clean(value: object) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()

def build_database():
    start_time = time.time()
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    # Build separately: a failed import must never erase the working registry.
    building_path = DB_PATH.with_name(f".vestigo-registry-{uuid4().hex}.sqlite")
    conn = sqlite3.connect(str(building_path))
    cur = conn.cursor()
    cur.execute("PRAGMA journal_mode = DELETE;")
    cur.execute("PRAGMA synchronous = NORMAL;")

    cur.execute("""
    CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        bin TEXT,
        name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        role TEXT,
        head TEXT,
        head_iin TEXT,
        city TEXT,
        address TEXT,
        oked TEXT,
        oked_name TEXT,
        categories TEXT,
        category_codes TEXT,
        documents TEXT,
        risk INTEGER DEFAULT 35,
        level TEXT DEFAULT 'Низкий',
        signals INTEGER DEFAULT 1,
        connections INTEGER DEFAULT 0,
        status TEXT,
        reason TEXT,
        total_amount REAL DEFAULT 0,
        source_file TEXT,
        search_text TEXT NOT NULL
    );
    """)

    cur.execute("CREATE INDEX IF NOT EXISTS idx_entities_bin ON entities(bin);")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_entities_norm_name ON entities(normalized_name);")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_entities_level ON entities(level);")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_entities_risk ON entities(risk);")

    all_entities = {}

    def upsert_entity(bin_val, name, role, category_title, category_code, file_name,
                      head="", head_iin="", city="Не указан", address="",
                      oked="", oked_name="", risk=35, level="Низкий", amount=0.0,
                      status="", reason="", counterparty=""):
        if not name and not bin_val and not head:
            return
        name = clean(name) or (f"Организация {bin_val}" if bin_val else clean(head))
        bin_val = clean(bin_val)
        key = bin_val if (bin_val and len(bin_val) == 12) else f"{bin_val}:{name}"

        if key not in all_entities:
            all_entities[key] = {
                "id": bin_val or f"org-{len(all_entities)+1}",
                "bin": bin_val,
                "name": name,
                "role": role,
                "head": head,
                "head_iin": head_iin,
                "city": city,
                "address": address,
                "oked": oked,
                "oked_name": oked_name,
                "categories": {category_title, "Локальные документы"},
                "category_codes": {category_code, "LOCAL_EVIDENCE"},
                "documents": {file_name} if file_name else set(),
                "risk": risk,
                "level": level,
                "signals": 1,
                "connections": 0,
                "status": status or role,
                "reason": reason or "",
                "total_amount": amount,
                "counterparties": {counterparty} if counterparty else set(),
                "source_files": {file_name} if file_name else set(),
                "records_count": 1,
            }
        else:
            e = all_entities[key]
            if name and (len(name) > len(e["name"]) or e["name"].startswith("Организация")):
                e["name"] = name
            if head and not e["head"]:
                e["head"] = head
            if head_iin and not e["head_iin"]:
                e["head_iin"] = head_iin
            if address and not e["address"]:
                e["address"] = address
            if oked and not e["oked"]:
                e["oked"] = oked
            if oked_name and not e["oked_name"]:
                e["oked_name"] = oked_name
            if category_title:
                e["categories"].add(category_title)
            if category_code:
                e["category_codes"].add(category_code)
            if file_name:
                e["documents"].add(file_name)
                e["source_files"].add(file_name)
            if counterparty:
                e["counterparties"].add(counterparty)
            e["total_amount"] += amount
            e["records_count"] += 1
            if risk > e["risk"]:
                e["risk"] = risk
                e["level"] = level

    # Vestigo rebuilds only from its own source files, never from the derived snapshot.
    if False:
        kgd = json.loads(KGD_PATH.read_text(encoding="utf-8"))
        for item in kgd.get("entities", []):
            b = item.get("bin", "")
            n = item.get("name", "")
            key = b or n
            all_entities[key] = {
                "id": item.get("id", b),
                "bin": b,
                "name": n,
                "role": "Реестр рисков КГД",
                "head": item.get("head", ""),
                "head_iin": item.get("headIin", ""),
                "city": item.get("city", "Караганда"),
                "address": "",
                "oked": "",
                "oked_name": "",
                "categories": set(item.get("categories", ["Реестр рисков КГД"])),
                "category_codes": set(item.get("categoryCodes", ["KGD_RISK"])),
                "documents": {d.get("number", "") for d in item.get("documents", []) if d.get("number")},
                "risk": item.get("risk", 70),
                "level": item.get("level", "Высокий" if item.get("risk", 70) >= 70 else "Средний"),
                "signals": item.get("signals", 1),
                "connections": item.get("connections", 0),
                "status": item.get("status", ""),
                "reason": item.get("reason", ""),
                "total_amount": 0.0,
                "counterparties": set(),
                "source_files": {"registry.json"},
                "records_count": 1,
            }

    csv_files = sorted(LOCAL_DOCS.glob("*.csv"))
    for f in csv_files:
        text = read_text(f)
        lines = [l for l in text.splitlines() if l.strip()]
        if len(lines) < 2:
            continue
        delim = detect_delimiter(lines[0])
        reader = csv.reader(lines, delimiter=delim)
        headers = [clean(h).casefold() for h in next(reader, [])]
        stem = f.stem.casefold()

        is_goszakup = any("заказчик" in h for h in headers) and any("поставщик" in h for h in headers)
        is_samruk = "самрук" in stem or any("id участника" in h for h in headers) or "zakup_sk" in stem
        is_esf = any("регистрационный номер эсф" in h for h in headers) and any("наименование поставщика" in h for h in headers) and any("наименование получателя" in h for h in headers)
        is_stat_registry = any(h in ("бин", "иин/бин", "иин", "бизнес-идентификационный номер") for h in headers) and any("наименование" in h or "атауы" in h for h in headers)

        file_bin_match = BIN_PATTERN.search(f.stem)
        file_bin = file_bin_match.group(1) if file_bin_match else ""

        def first_index(predicate, start=0):
            return next((index for index, header in enumerate(headers[start:], start=start) if predicate(header)), -1)

        supplier_name_index = first_index(lambda h: "наименование поставщика" in h and "ис эсф" in h)
        if supplier_name_index < 0:
            supplier_name_index = first_index(lambda h: "наименование поставщика" in h)
        recipient_name_index = first_index(lambda h: "наименование получателя" in h and "ис эсф" in h)
        if recipient_name_index < 0:
            recipient_name_index = first_index(lambda h: "наименование получателя" in h)
        supplier_bin_index = first_index(lambda h: h in ("иин/бин", "бин/иин", "бин", "иин"))
        recipient_bin_index = first_index(
            lambda h: h in ("иин/бин", "бин/иин", "бин", "иин"),
            max(0, recipient_name_index + 1),
        )
        supplier_address_index = first_index(lambda h: "адрес места нахождения" in h, max(0, supplier_name_index + 1))
        recipient_address_index = first_index(lambda h: "адрес места нахождения" in h, max(0, recipient_bin_index + 1))

        for raw_row in reader:
            row = [clean(v) for v in raw_row]
            if not any(row):
                continue
            row_dict = {headers[i]: row[i] for i in range(min(len(headers), len(row)))}

            if is_esf and file_bin and ("реал" in stem or "приоб" in stem):
                def value_at(index):
                    return row[index] if 0 <= index < len(row) else ""

                supplier_bin = value_at(supplier_bin_index)
                supplier_name = value_at(supplier_name_index)
                supplier_address = value_at(supplier_address_index)
                recipient_bin = value_at(recipient_bin_index)
                recipient_name = value_at(recipient_name_index)
                recipient_address = value_at(recipient_address_index)

                if "реал" in stem:
                    object_name = supplier_name
                    object_address = supplier_address
                    counterparty_name = recipient_name
                    role = "Поставщик по ЭСФ (реализация)"
                else:
                    object_name = recipient_name
                    object_address = recipient_address
                    counterparty_name = supplier_name
                    role = "Получатель по ЭСФ (приобретение)"

                upsert_entity(
                    file_bin,
                    object_name,
                    role,
                    "Электронные счета-фактуры",
                    "LOCAL_ESF",
                    f.name,
                    address=object_address,
                    counterparty=counterparty_name,
                )

            elif is_goszakup:
                cust_key = next((k for k in row_dict if "заказчик" in k), "")
                supp_key = next((k for k in row_dict if "поставщик" in k), "")
                cont_key = next((k for k in row_dict if "договор" in k or "номер договора" in k), "")
                amt_key = next((k for k in row_dict if "сумм" in k), "")

                cust_name = row_dict.get(cust_key, "")
                supp_name = row_dict.get(supp_key, "")
                cont_val = row_dict.get(cont_key, "")
                amt_val = parse_amount(row_dict.get(amt_key, ""))

                bins = BIN_PATTERN.findall(cont_val + " " + cust_name + " " + supp_name)
                cust_bin = bins[0] if bins else ""
                supp_bin = bins[1] if len(bins) > 1 else ""

                if cust_name:
                    upsert_entity(cust_bin, cust_name, "Заказчик госзакупок", "Заказчик государственных закупок", "GOSZAKUP_CONTRACT", f.name, amount=amt_val, counterparty=supp_name)
                if supp_name:
                    upsert_entity(supp_bin, supp_name, "Поставщик госзакупок", "Поставщик государственных закупок", "GOSZAKUP_CONTRACT", f.name, amount=amt_val, counterparty=cust_name)

            elif is_samruk:
                bin_key = next((k for k in row_dict if "бин" in k or "иин" in k), "")
                name_key = next((k for k in row_dict if "наименование" in k or "атауы" in k), "")
                addr_key = next((k for k in row_dict if "адрес" in k or "мекен" in k), "")
                city_key = next((k for k in row_dict if "пункт" in k or "город" in k), "")

                b = row_dict.get(bin_key, "")
                n = row_dict.get(name_key, "")
                addr = row_dict.get(addr_key, "")
                city = row_dict.get(city_key, "Карагандинская область")

                if b or n:
                    upsert_entity(b, n, "Поставщик Самрук-Қазына", "Поставщики фонда Самрук-Қазына", "SAMRUK_SUPPLIER", f.name, city=city, address=addr)

            elif is_stat_registry:
                bin_key = next((k for k in row_dict if k in ("бин", "иин/бин", "иин", "бизнес-идентификационный номер")), "")
                name_ru_key = next((k for k in row_dict if "полное наименование" in k or "наименование на русском" in k or k == "наименование"), "")
                name_kz_key = next((k for k in row_dict if "толық атауы" in k or "атауы" in k), "")
                head_key = next((k for k in row_dict if "руководител" in k or "басшы" in k or "фио" in k), "")
                addr_key = next((k for k in row_dict if "адрес" in k or "мекен-жай" in k or "мекен" in k), "")
                city_key = next((k for k in row_dict if "пункт" in k or "қала" in k or "елді мекен" in k), "")
                oked_key = next((k for k in row_dict if k == "окэд"), "")
                oked_name_key = next((k for k in row_dict if "основного вида деятельности" in k or "қызмет түрінің атауы" in k), "")

                b = row_dict.get(bin_key, "")
                n = row_dict.get(name_ru_key, "") or row_dict.get(name_kz_key, "")
                h = row_dict.get(head_key, "")
                addr = row_dict.get(addr_key, "")
                city = row_dict.get(city_key, "Карагандинская область")
                ok = row_dict.get(oked_key, "")
                ok_n = row_dict.get(oked_name_key, "")

                role = "Юридическое лицо"
                cat = "Юридические лица Карагандинской области"
                cat_code = "LEGAL_ENTITY"
                if "ип" in stem:
                    role = "Индивидуальный предприниматель"
                    cat = "Индивидуальные предприниматели (ИП)"
                    cat_code = "INDIVIDUAL_ENTREPRENEUR"
                elif "филиал" in stem:
                    role = "Филиал организации"
                    cat = "Филиалы и представительства"
                    cat_code = "BRANCH"
                elif "кх" in stem or "пт" in stem:
                    role = "Крестьянское хозяйство / ПТ"
                    cat = "Крестьянские хозяйства и ПТ"
                    cat_code = "FARM_PARTNERSHIP"
                elif "иностр" in stem:
                    role = "Филиал иностранной компании"
                    cat = "Иностранные компании и филиалы"
                    cat_code = "FOREIGN_BRANCH"

                if b or n or h:
                    upsert_entity(b, n, role, cat, cat_code, f.name, head=h, address=addr, city=city, oked=ok, oked_name=ok_n)

            else:
                bin_matches = BIN_PATTERN.findall(" ".join(row))
                owner_bin = bin_matches[0] if bin_matches else ""
                name_val = next((v for k, v in row_dict.items() if any(t in k for t in ("payer_name", "наименование", "заказчик", "поставщик")) and v), "")
                head_val = next((v for k, v in row_dict.items() if "head_name" in k and v), "")
                head_iin = next((v for k, v in row_dict.items() if k == "iin" and len(v) == 12), "")

                if owner_bin or name_val:
                    upsert_entity(owner_bin, name_val, "Налогоплательщик", "Локальная налоговая отчётность", "LOCAL_TAX_REPORTING", f.name, head=head_val, head_iin=head_iin)

    print(f"Total merged entities: {len(all_entities)}. Inserting into SQLite...")

    rows_to_insert = []
    for e in all_entities.values():
        norm_name = normalize(e["name"])
        norm_head = normalize(e["head"])
        norm_bin = e["bin"] or ""
        norm_oked = e["oked"] or ""
        norm_oked_n = normalize(e["oked_name"])
        norm_addr = normalize(e["address"])
        cps = list(e["counterparties"])[:5]
        norm_cps = " ".join(normalize(c) for c in cps)

        search_text = f"{norm_bin} {norm_name} {norm_head} {e['head_iin']} {norm_oked} {norm_oked_n} {norm_addr} {norm_cps}"

        status_text = e["status"]
        if not status_text or status_text == e["role"]:
            if e["records_count"] > 1:
                status_text = f"{e['role']}: {e['records_count']} записей"
            else:
                status_text = e["role"]

        reason_text = e["reason"]
        if not reason_text:
            amt_text = f" на сумму {format_money(e['total_amount'])}" if e["total_amount"] > 0 else ""
            head_text = f" (Руководитель: {e['head']})" if e["head"] else ""
            oked_text = f" · ОКЭД {e['oked']} ({e['oked_name']})" if e["oked"] else ""
            reason_text = f"{e['role']}: {e['records_count']} записей{amt_text}{head_text}{oked_text}"

        cats = sorted(e["categories"])
        cat_codes = sorted(e["category_codes"])
        docs = [{"category": cats[0] if cats else "Локальные документы", "number": d, "date": ""} for d in sorted(e["documents"])]

        rows_to_insert.append((
            e["id"],
            e["bin"],
            e["name"],
            norm_name,
            e["role"],
            e["head"],
            e["head_iin"],
            e["city"],
            e["address"],
            e["oked"],
            e["oked_name"],
            json.dumps(cats, ensure_ascii=False),
            json.dumps(cat_codes, ensure_ascii=False),
            json.dumps(docs, ensure_ascii=False),
            e["risk"],
            e["level"],
            e["signals"],
            len(e["counterparties"]) or e["connections"],
            status_text,
            reason_text,
            e["total_amount"],
            next(iter(e["source_files"]), ""),
            search_text
        ))

    cur.executemany("""
    INSERT INTO entities (
        id, bin, name, normalized_name, role, head, head_iin, city, address, oked, oked_name,
        categories, category_codes, documents, risk, level, signals, connections, status,
        reason, total_amount, source_file, search_text
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    """, rows_to_insert)

    cur.execute("""
    CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
        bin, name, head, oked, oked_name, search_text,
        content='entities',
        content_rowid='rowid'
    );
    """)

    cur.execute("""
    INSERT INTO entities_fts(rowid, bin, name, head, oked, oked_name, search_text)
    SELECT rowid, bin, normalized_name, head, oked, oked_name, search_text FROM entities;
    """)

    conn.commit()
    conn.close()
    building_path.replace(DB_PATH)

    elapsed = time.time() - start_time
    db_size_mb = DB_PATH.stat().st_size / (1024 * 1024)
    print(f"DONE in {elapsed:.2f}s! SQLite database created at {DB_PATH} ({db_size_mb:.1f} MB, {len(rows_to_insert):,} rows with FTS5)")

if __name__ == "__main__":
    build_database()
