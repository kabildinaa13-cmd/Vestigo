"""Build Vestigo analytics only from its own local documents. No network access."""
from __future__ import annotations
import csv
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
from datetime import datetime
import build_financial_analytics as financial

ROOT = Path(os.environ.get("VESTIGO_ANALYTICS_ROOT", Path(__file__).resolve().parents[1]))
OUTPUT = ROOT / "app/data"

def write_json(name, payload):
    OUTPUT.mkdir(parents=True, exist_ok=True)
    target = OUTPUT / name
    temporary = target.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    temporary.replace(target)

def main():
    # The base registry importer uses the snapshot as input; discard the previous derived snapshot
    # there, rather than re-seeding removed files as if they were independent evidence.
    financial.main()
    analytics = json.loads((OUTPUT / "financial-analytics.json").read_text(encoding="utf-8"))
    conn = sqlite3.connect(ROOT / "data/vestigo-registry.sqlite")
    conn.row_factory = sqlite3.Row
    stamp = datetime.now().astimezone().isoformat(timespec="seconds")
    for bin_value, item in analytics["entities"].items():
        signals = item.get("signals", [])
        risk = 75 if any(s["severity"] == "high" for s in signals) else 50 if signals else 35
        level = "Высокий" if risk >= 70 else "Средний" if risk >= 45 else "Низкий"
        connections = len({c["bin"] for side in ["sales", "purchases"] for c in item["esf"][side]["counterparties"]})
        conn.execute("UPDATE entities SET risk=?,level=?,connections=?,signals=? WHERE bin=?", (risk, level, connections, len(signals), bin_value))
    conn.executescript("""
      CREATE TABLE IF NOT EXISTS evidence_records(id TEXT PRIMARY KEY,file_name TEXT NOT NULL,fields_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS evidence_identifiers(bin TEXT NOT NULL,record_id TEXT NOT NULL,PRIMARY KEY(bin,record_id));
      CREATE INDEX IF NOT EXISTS evidence_identifiers_bin ON evidence_identifiers(bin);
      DELETE FROM evidence_identifiers; DELETE FROM evidence_records;
    """)
    files = sorted((ROOT / "data/local-documents").glob("*.csv"))
    records_preview = []
    file_stats = []
    total_records = 0
    for file in files:
        headers, rows = financial.rows(file)
        stored = 0
        for index, row in enumerate(rows):
            fields = {str(key): str(value) for key, value in zip(headers, row) if str(value).strip()}
            bins = sorted(set(re.findall(r"(?<!\d)\d{12}(?!\d)", " ".join(fields.values()))))
            if not bins:
                continue
            identity = hashlib.sha256((file.name + str(index) + json.dumps(fields, ensure_ascii=False)).encode()).hexdigest()
            conn.execute("INSERT OR IGNORE INTO evidence_records VALUES(?,?,?)", (identity, file.name, json.dumps(fields, ensure_ascii=False)))
            conn.executemany("INSERT OR IGNORE INTO evidence_identifiers VALUES(?,?)", [(value, identity) for value in bins])
            if len(records_preview) < 200:
                records_preview.append({"id": identity, "fileName": file.name, "bins": bins, "fields": fields})
            stored += 1
        total_records += stored
        file_stats.append({"name": file.name, "rows": len(rows), "matches": stored, "status": "complete"})
    entities = []
    for row in conn.execute("SELECT * FROM entities ORDER BY bin"):
        def array(column):
            try: return json.loads(row[column] or "[]")
            except ValueError: return []
        entities.append({"id": row["id"], "bin": row["bin"] or "", "name": row["name"], "head": row["head"] or "",
            "headIin": row["head_iin"] or "", "headRnn": "", "rnn": "", "taxpayerFio": "",
            "city": row["city"] or "", "address": row["address"] or "", "oked": row["oked"] or "", "okedName": row["oked_name"] or "",
            "categories": array("categories"), "categoryCodes": array("category_codes"), "documents": array("documents"),
            "sourceDate": stamp[:10], "risk": row["risk"], "level": row["level"], "signals": row["signals"],
            "connections": row["connections"], "status": row["status"] or "", "reason": row["reason"] or ""})
    conn.commit()
    conn.close()
    profiles = {}
    invoices = financial.parse_esf([p for p in files if financial.is_esf_file(p)], profiles)
    relations = {}
    names = {e["bin"]: e["name"] for e in entities}
    for invoice in invoices.values():
        if invoice["status"].upper() in financial.EXCLUDED_ESF_STATUSES: continue
        supplier, buyer = invoice["supplierBin"], invoice["buyerBin"]
        if not supplier or not buyer or supplier == buyer: continue
        owner = supplier
        for source in invoice["sources"]:
            match = re.search(r"\d{12}", source)
            if match and match.group() in [supplier,buyer]: owner = match.group(); break
        buying = owner == buyer
        cp = supplier if buying else buyer
        key = f"{owner}|{cp}|{buying}"
        relation = relations.setdefault(key, {"objectBin": owner, "objectName": names.get(owner,""), "objectRole": "Получатель" if buying else "Поставщик",
            "counterpartyBin": cp, "counterpartyName": names.get(cp,""), "counterpartyRole": "Поставщик" if buying else "Получатель",
            "relationType": "Приобретение" if buying else "Реализация", "confidence": 1, "recognitionRule": "Реквизиты поставщика и получателя ЭСФ",
            "operations": 0, "files": set()})
        relation["operations"] += 1
        relation["files"].update(invoice["sources"])
    for relation in relations.values(): relation["files"] = sorted(relation["files"])
    write_json("registry.json", {"source": {"name": "Документы Vestigo", "url": "/", "region": "По загруженным материалам", "updated": stamp[:10] if files else "",
        "lastSync": stamp, "syncStatus": "local", "syncFiles": len(files)},
        "stats": [{"code": "LOCAL_EVIDENCE", "label": f["name"], "file": f["name"], "rows": f["rows"], "updated": stamp[:10], "status": "complete"} for f in file_stats], "entities": entities})
    write_json("local-evidence.json", {"source": "Загруженные документы Vestigo", "importedAt": stamp, "files": file_stats,
        "records": records_preview, "recordsTotal": total_records, "entitiesTotal": len(entities), "indexMode": "sqlite",
        "entities": [{"bin": e["bin"], "name": e["name"], "role": e["status"], "head": e["head"], "headIin": e["headIin"],
            "records": 0, "totalAmount": 0, "files": [d["number"] for d in e["documents"]], "counterparties": []} for e in entities],
        "relations": list(relations.values())})
    print(json.dumps({"entities": len(entities), "records": total_records, "relations": len(relations)}, ensure_ascii=False))

if __name__ == "__main__": main()
