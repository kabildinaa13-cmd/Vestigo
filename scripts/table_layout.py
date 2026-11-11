"""Evidence-preserving table regions. Row numbers always refer to the original sheet."""
import re
from financial_normalization import clean, norm


class SourceRows(list):
    def __init__(self, values, merges=None):
        super().__init__(values)
        self.merges = merges or []


def columns(values):
    result, counts = [], {}
    for i, value in enumerate(values):
        label = clean(value) or f"Столбец {i + 1}"
        counts[label] = counts.get(label, 0) + 1
        result.append(label if counts[label] == 1 else f"{label} [#{counts[label]}]")
    return result


def merged_values(values, row, merges, header=False):
    cells = list(values[row - 1])
    anchors = {}
    for r1, c1, r2, c2 in merges:
        if c1 != c2 and not header:
            continue
        if not r1 <= row <= r2:
            continue
        source = values[r1 - 1][c1 - 1] if r1 <= len(values) and c1 <= len(values[r1 - 1]) else ""
        if len(cells) < c2:
            cells.extend([""] * (c2 - len(cells)))
        for col in range(c1 - 1, c2):
            if not clean(cells[col]) and clean(source):
                cells[col] = source
                anchors[col] = (r1, c1)
    return cells, anchors


def header(values, row, depth, merges, width):
    lines = [merged_values(values, n, merges, header=True)[0] for n in range(row, min(len(values), row + depth - 1) + 1)]
    result = []
    for col in range(width):
        parts = []
        for cells in lines:
            value = clean(cells[col]) if col < len(cells) else ""
            if value and norm(value) not in {norm(v) for v in parts}:
                parts.append(value)
        result.append(" ".join(parts))
    return columns(result)


def structural(mapping):
    fields = set(mapping)
    return len(fields) >= 2 and bool(fields & {"amount", "lineAmount", "debit", "credit", "signedAmount", "date", "number", "goodsName", "taxAccrued", "taxPaid"})


def discover(label, values, infer, settings=None):
    if not values:
        return []
    width = max(map(len, values), default=0)
    merges = getattr(values, "merges", [])
    manual = [s for s in settings or [] if s["sheet"] == label]
    candidates = []
    if manual:
        for s in sorted(manual, key=lambda s: s["headerRow"]):
            if s["headerRow"] > len(values) or s.get("endRow", len(values)) > len(values):
                raise ValueError("Настройка таблицы выходит за пределы листа")
            h = header(values, s["headerRow"], s.get("headerDepth", 1), merges, width)
            candidates.append({"headerRow": s["headerRow"], "headerDepth": s.get("headerDepth", 1), "columns": h, "manual": True, "settings": s})
    else:
        skip_until = 0
        for n, cells in enumerate(values, 1):
            if n <= skip_until or not any(clean(v) for v in cells):
                continue
            # Header candidates contain labels, not dates/amounts/identifiers. No fuzzy matching.
            nonempty = [v for v in cells if clean(v)]
            if not any(re.search(r"[^\W\d_]", clean(v), re.UNICODE) for v in nonempty):
                continue
            if not any(norm(v) in infer.known_labels for v in cells) and not any(r1 == n for r1, _, _, _ in merges):
                continue
            single = columns(cells)
            mapping = infer(single, {})
            # Some bank exports repeat the date/number cells in a merged band
            # above debit/credit. The upper band is not a second empty table.
            if n<len(values) and any(norm(v) in {'корреспондент','оборотыввалютесчета'} for v in cells):
                band_mapping=infer(header(values,n,1,merges,width),{})
                next_mapping=infer(header(values,n+1,1,merges,width),{})
                if 'date' in band_mapping and 'date' in next_mapping and not {'debit','credit'} & set(band_mapping) and {'debit','credit'} & set(next_mapping):
                    continue
            best = None
            if structural(mapping):
                best = (len(mapping), 1, header(values, n, 1, merges, width))
            # Only a sparse/merged label band may be combined with the following header line.
            band = any(norm(v) in {"поставщик", "покупатель", "отправитель", "получатель", "supplier", "buyer", "сатушы", "сатыпалушы"} for v in cells)
            if n < len(values) and (any(r1 == n for r1, _, _, _ in merges) or band):
                following = infer(columns(values[n]), {})
                if structural(following) or any(norm(v) in {"бин", "иин", "бсн", "жсн", "наименование", "name"} for v in values[n]):
                    combined = header(values, n, 2, merges, width)
                    score = len(infer(combined, {}))
                    if structural(infer(combined, {})) and (best is None or score > best[0]):
                        best = (score, 2, combined)
            if best:
                _, depth, h = best
                candidates.append({"headerRow": n, "headerDepth": depth, "columns": h, "manual": False, "settings": {}})
                skip_until = n + depth - 1
        if not candidates:
            nonempty = [i for i, row in enumerate(values) if any(clean(v) for v in row)]
            if not nonempty:
                return []
            start = max(nonempty[:100], key=lambda i: len(infer(columns(values[i]), {}))) + 1
            candidates = [{"headerRow": start, "headerDepth": 1, "columns": header(values, start, 1, merges, width), "manual": False, "settings": {}, "unrecognized": True}]
    for n, table in enumerate(candidates):
        next_start = candidates[n + 1]["headerRow"] - 1 if n + 1 < len(candidates) else len(values)
        end = table["settings"].get("endRow", next_start)
        if end > next_start or end < table["headerRow"] + table["headerDepth"] - 1:
            raise ValueError("Границы таблиц пересекаются или предшествуют заголовку")
        table.update({"sheet": label, "endRow": end, "sourceStart": 1 if n == 0 else table["headerRow"], "dataStart": table["headerRow"] + table["headerDepth"], "merges": merges})
    return candidates


def service_row(cells):
    text = [clean(v) for v in cells if clean(v)]
    if not text:
        return "blank"
    first = re.sub(r"[:\s]+$", "", text[0]).strip().lower().replace("ё", "е")
    if len(text)<=3 and norm(first) in {'бинклиента','бинвладельцасчета','иинвладельцасчета','иинбинклиента','clientbin','accountholderbin','номeрсчета','номерсчета','счетклиента','счетвладельца','iban','accountnumber','валюта','валютасчета','accountcurrency','currency'}:
        return 'preamble'
    if re.match(r"^(?:итого|всего|subtotal|grand total|total|жиыны|барлығы)(?:\s|:|$)", first):
        return "total"
    if re.match(r"^(?:примечани[ея]|справочно|note|notes|период выписки|начальный остаток|конечный остаток)(?:\s|:|$)", first):
        return "note"
    return ""
