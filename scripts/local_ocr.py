"""Bounded local OCR. No network requests, Office execution, or document commands."""
import hashlib
import importlib.util
import io
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

VERSION = "local-ocr-1.6"


def refine_currency_tokens(image, lines, models, timeout):
    """Re-read an explicitly labelled currency token in English; never map look-alike letters."""
    if timeout < 1 or not (models / "eng.traineddata").exists():
        return []
    import tesserocr
    from PIL import ImageOps
    refinements = []
    for line in lines:
        if not re.search(r"Валюта|Код валюты", line.get("text", ""), re.I):
            continue
        words = line.get("words", [])
        if not words:
            continue
        word = words[-1]
        before = word["text"].strip()
        # Mixed-language recognition can lose a character (KZT -> КТ).
        # Re-read pixels, not a guessed letter substitution; accept only three
        # high-confidence Latin letters from the independent English pass.
        if not re.fullmatch(r"[A-Za-zА-Яа-я0-9]{2,4}", before) or re.fullmatch(r"[A-Z]{3}", before):
            continue
        x,y,w,h = (word[k] for k in ("x","y","w","h"))
        crop = image.crop((max(0,x-4),max(0,y-4),min(image.width,x+w+4),min(image.height,y+h+4)))
        crop = ImageOps.expand(crop.resize((crop.width*2,crop.height*2)),border=20,fill="white")
        with tesserocr.PyTessBaseAPI(path=str(models),lang="eng",psm=tesserocr.PSM.SINGLE_LINE) as api:
            api.SetVariable("tessedit_char_whitelist", "ABCDEFGHIJKLMNOPQRSTUVWXYZ")
            api.SetImage(crop)
            if not api.Recognize(timeout=int(min(timeout,4)*1000)):
                continue
            code = (api.GetUTF8Text() or "").strip()
            confidence = api.MeanTextConf()
        if re.fullmatch(r"[A-Z]{3}", code) and confidence >= 70:
            line["text"] = line["text"].rsplit(before,1)[0]+code
            word["text"] = code
            refinements.append({"field":"currency","before":before,"value":code,"method":"labelled-token-english-ocr","box":[x,y,w,h],"confidence":confidence})
    return refinements


def prepare_scan(image):
    """Correct slight skew and remove long table rules; never alter the saved original."""
    try:
        import cv2
        import numpy as np
        from PIL import Image
    except ImportError:
        return image, {"available": False}
    gray = np.asarray(image.convert("L"))
    edges = cv2.Canny(gray, 50, 150)
    lines = cv2.HoughLinesP(edges, 1, np.pi/1800, threshold=100, minLineLength=max(100, gray.shape[1]//4), maxLineGap=20)
    angles = []
    if lines is not None:
        for x1,y1,x2,y2 in lines[:,0]:
            if x2 != x1:
                angle = float(np.degrees(np.arctan2(y2-y1,x2-x1)))
                if abs(angle) <= 7:
                    angles.append(angle)
    angle = float(np.median(angles)) if angles else 0.0
    if abs(angle) >= 0.15:
        height,width = gray.shape
        matrix = cv2.getRotationMatrix2D((width/2,height/2),angle,1)
        gray = cv2.warpAffine(gray,matrix,(width,height),flags=cv2.INTER_CUBIC,borderMode=cv2.BORDER_CONSTANT,borderValue=255)
    binary = cv2.threshold(gray,0,255,cv2.THRESH_BINARY_INV|cv2.THRESH_OTSU)[1]
    horizontal = cv2.morphologyEx(binary,cv2.MORPH_OPEN,cv2.getStructuringElement(cv2.MORPH_RECT,(max(40,gray.shape[1]//20),1)))
    vertical = cv2.morphologyEx(binary,cv2.MORPH_OPEN,cv2.getStructuringElement(cv2.MORPH_RECT,(1,max(40,gray.shape[0]//20))))
    mask = cv2.dilate(cv2.bitwise_or(horizontal,vertical),np.ones((2,2),np.uint8))
    cleaned = gray.copy()
    cleaned[mask>0] = 255
    return Image.fromarray(cleaned).convert("RGB"), {"available": True,"deskewDegrees":round(angle,3),"tableLinesRemoved":bool(np.any(mask))}


def windows_recognize(windows, paths, timeout):
    command = [str(windows), "-NoProfile", "-NonInteractive", "-File", str(Path(__file__).with_name("windows_ocr.ps1")), "-Language", "ru"]
    proc = subprocess.run(command, input=json.dumps({"paths": paths}).encode("utf8"), capture_output=True, timeout=timeout, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if proc.returncode:
        raise RuntimeError("Локальное Windows OCR не завершено. Проверьте язык ru и разрешение на запуск scripts/windows_ocr.ps1.")
    return json.loads(proc.stdout.decode("utf-8-sig"))


def score(text):
    words = re.findall(r"[А-Яа-яA-Za-z]{3,}", text)
    anchors = re.findall(r"договор|постав|платеж|платёж|счет|счёт|накладн|получател|подряд|раздел|назначени|бенефициар|отправител|сверки", text.lower())
    identifiers = set(re.findall(r"(?<![\w])\d{12}(?![\w])", text))
    dates = re.findall(r"\b\d{2}[./]\d{2}[./]\d{4}\b", text)
    titles = re.findall(r"платежное поручение|платёжное поручение|счет.?фактура|счёт.?фактура|договор поставки", text.lower())
    return min(len(words), 200) + 30 * len(anchors) + 100 * min(4, len(identifiers)) + 50 * min(4, len(dates)) + 200 * len(titles)


def recognize(image, timeout=45):
    """Returns words with boxes in the corrected image coordinates. Missing engines are explicit."""
    from PIL import ImageOps, ImageFilter
    image = ImageOps.exif_transpose(image).convert("RGB")
    image.thumbnail((2500, 2500))
    windows = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    tesseract = os.environ.get("VESTIGO_TESSERACT") or shutil.which("tesseract")
    models = Path(os.environ.get("VESTIGO_TESSDATA", str(Path(__file__).resolve().parents[1] / "vendor/tessdata")))
    native = importlib.util.find_spec("tesserocr") is not None and (models / "rus.traineddata").exists()
    engine = "tesserocr" if native else "tesseract" if tesseract else "windows-ocr" if os.name == "nt" and windows.exists() else ""
    if not engine:
        raise RuntimeError("Локальный OCR не установлен: нужен Tesseract с языками либо Windows OCR (ru).")
    key = hashlib.sha256(VERSION.encode() + engine.encode() + str(image.size).encode() + image.tobytes()).hexdigest()
    cache_root = Path(os.environ.get("VESTIGO_OCR_CACHE", str(Path(os.environ.get("VESTIGO_DATA_DIR", "data")) / "ocr-cache")))
    cached = cache_root / (key + ".json")
    if cached.exists():
        try:
            data = json.loads(cached.read_text(encoding="utf8"))
            if data.get("version") == VERSION:
                return {**data, "cached": True}
        except (OSError, ValueError):
            pass
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="vestigo-ocr-") as folder:
        paths = []
        for angle in (0, 90, 180, 270):
            target = Path(folder) / f"r{angle}.png"
            image.rotate(angle, expand=True).save(target)
            paths.append(str(target))
        if engine == "tesserocr":
            import tesserocr
            languages = [language for language in ("rus", "kaz", "eng") if (models / f"{language}.traineddata").exists()]
            results = [{"text": "", "lines": []} for _ in paths]
            angles = list(range(4))
            if os.name == "nt" and windows.exists():
                try:
                    orientation = windows_recognize(windows, paths, min(15, timeout))["results"]
                    best = max(range(len(orientation)), key=lambda n: score(orientation[n].get("text", "")))
                    angles = [best]
                except Exception:
                    pass
            with tesserocr.PyTessBaseAPI(path=str(models), lang="+".join(languages), oem=tesserocr.OEM.LSTM_ONLY, psm=tesserocr.PSM.AUTO) as api:
                api.SetVariable("preserve_interword_spaces", "1")
                for index in angles:
                    file = paths[index]
                    from PIL import Image
                    with Image.open(file) as rotated:
                        variants = []
                        enhanced = ImageOps.autocontrast(ImageOps.grayscale(rotated)).filter(ImageFilter.UnsharpMask(radius=1.5, percent=140, threshold=3))
                        cleaned, preparation = prepare_scan(rotated)
                        attempts = [(tesserocr.PSM.AUTO, rotated, "layout")]
                        if preparation.get("available"):
                            attempts.append((tesserocr.PSM.AUTO, cleaned, "deskew-table-lines"))
                        attempts.append((tesserocr.PSM.SPARSE_TEXT, enhanced, "contrast-sharpness"))
                        for mode, candidate, label in attempts:
                            left = timeout - (time.monotonic() - started)
                            if left <= 1:
                                break
                            api.SetPageSegMode(mode)
                            api.SetImage(candidate)
                            if not api.Recognize(timeout=int(left * 1000)):
                                if variants:
                                    break
                                raise RuntimeError("Локальное OCR страницы превысило время обработки.")
                            lines = []
                            iterator = api.GetIterator()
                            if iterator is not None:
                                for item in tesserocr.iterate_level(iterator, tesserocr.RIL.WORD):
                                    if not lines or item.IsAtBeginningOf(tesserocr.RIL.TEXTLINE):
                                        lines.append({"text": (item.GetUTF8Text(tesserocr.RIL.TEXTLINE) or "").strip(), "words": []})
                                    word = item.GetUTF8Text(tesserocr.RIL.WORD) or ""
                                    box = item.BoundingBox(tesserocr.RIL.WORD)
                                    if word and box:
                                        x, y, right, bottom = box
                                        lines[-1]["words"].append({"text": word, "x": x, "y": y, "w": right - x, "h": bottom - y, "confidence": item.Confidence(tesserocr.RIL.WORD)})
                            refinements = refine_currency_tokens(candidate,lines,models,timeout-(time.monotonic()-started))
                            current = {"text": "\n".join(line["text"] for line in lines), "lines": lines, "fieldRefinements":refinements, "preprocessing": label, "preparation": preparation if label=="deskew-table-lines" else {}}
                            variants.append(current)
                            confidences = [word["confidence"] for line in lines for word in line["words"]]
                            # Good layout recognition does not need an expensive second pass.
                            structured = len(set(re.findall(r"(?<![\w])\d{12}(?![\w])", current["text"]))) >= 2 and re.search(r"\d{2}[./]\d{2}[./]\d{4}", current["text"]) and re.search(r"\d+[.,]\d{2}", current["text"])
                            if label == "layout" and structured and len(current["text"].strip()) >= 100 and confidences and sum(confidences)/len(confidences) >= 80:
                                break
                        if variants:
                            best_variant = max(variants, key=lambda v: score(v["text"]))
                            results[index] = {**best_variant, "alternatives": [{"text": v["text"][:40000], "preprocessing": v["preprocessing"]} for v in variants if v is not best_variant]}
        elif engine == "windows-ocr":
            payload = windows_recognize(windows, paths, timeout)
            results = payload["results"]
            languages = payload.get("languages", [])
        else:
            available = subprocess.run([tesseract, "--list-langs"], capture_output=True, timeout=10, text=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).stdout.splitlines()
            languages = [v for v in ("rus", "kaz", "eng") if v in available]
            if not languages or "rus" not in languages:
                raise RuntimeError("Для локального Tesseract установите языковые данные rus; kaz рекомендуется для казахских документов.")
            results = []
            import csv
            for file in paths:
                left = max(1, timeout - (time.monotonic() - started))
                proc = subprocess.run([tesseract, file, "stdout", "-l", "+".join(languages), "--psm", "3", "tsv"], capture_output=True, timeout=left, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                if proc.returncode:
                    raise RuntimeError("Tesseract не завершил локальное распознавание страницы.")
                groups = {}
                for row in csv.DictReader(io.StringIO(proc.stdout.decode("utf8")), delimiter="\t"):
                    if row.get("level") != "5" or not row.get("text", "").strip():
                        continue
                    k = (row["block_num"], row["par_num"], row["line_num"])
                    groups.setdefault(k, []).append({"text": row["text"], "x": int(row["left"]), "y": int(row["top"]), "w": int(row["width"]), "h": int(row["height"])})
                lines = [{"text": " ".join(w["text"] for w in words), "words": words} for words in groups.values()]
                results.append({"text": "\n".join(l["text"] for l in lines), "lines": lines})
        index = max(range(len(results)), key=lambda n: score(results[n].get("text", "")))
        selected = results[index]
        output = {"version": VERSION, "engine": engine, "languages": languages, "rotation": (0, 90, 180, 270)[index],
                  "width": image.height if index % 2 else image.width, "height": image.width if index % 2 else image.height,
                  "text": selected.get("text", ""), "lines": selected.get("lines", []), "alternatives": selected.get("alternatives", []), "fieldRefinements":selected.get("fieldRefinements", []), "preprocessing": selected.get("preprocessing", "original"), "preparation": selected.get("preparation", {}), "confidenceAvailable": engine == "tesserocr",
                  "kazakhAvailable": "kaz" in languages or "kk" in languages, "cached": False}
        confidences = [word["confidence"] for line in output["lines"] for word in line.get("words", []) if "confidence" in word]
        output["meanWordConfidence"] = round(sum(confidences) / len(confidences), 1) if confidences else None
        output["qualityReviewRequired"] = bool(len(output["text"].strip()) < 80 or (confidences and output["meanWordConfidence"] < 60))
        if not output["text"].strip():
            return output
        cache_root.mkdir(parents=True, exist_ok=True)
        temporary = cache_root / (key + f".{os.getpid()}.tmp")
        temporary.write_text(json.dumps(output, ensure_ascii=False), encoding="utf8")
        os.replace(temporary, cached)
        return output


def read_pdf_pages(source, pages, enabled=True, reuse_pages=None):
    """OCR only pages without native text; bounded work and per-page failures remain visible."""
    if enabled and os.environ.get("VESTIGO_OCR_DISABLED") != "1" and isinstance(reuse_pages,list):
        saved = {p.get("page"):p for p in reuse_pages if isinstance(p,dict) and isinstance(p.get("text"),str) and p["text"].strip()}
        for page in pages:
            prior = saved.get(page["page"])
            if prior and not page.get("text", "").strip():
                page.update({**prior,"reusedText":True})
                if page.get("ocr"):
                    page["ocr"]={**page["ocr"],"cached":True}
    pending = [p for p in pages if not p.get("text", "").strip()]
    if not pending or not enabled or os.environ.get("VESTIGO_OCR_DISABLED") == "1":
        return pages
    try:
        import pypdfium2 as pdfium
        document = pdfium.PdfDocument(str(source) if isinstance(source, (str, Path)) else source.getvalue())
    except Exception:
        for p in pending:
            p["ocrError"] = "Недоступен локальный рендерер PDFium; установите зависимости из requirements.txt."
        return pages
    try:
        started = time.monotonic()
        processed = 0
        limit = min(1000, max(1, int(os.environ.get("VESTIGO_OCR_MAX_PAGES", "100"))))
        for index, data in enumerate(pending):
            if processed >= limit or time.monotonic() - started > 480:
                data["ocrError"] = "Достигнут защитный предел OCR (страницы/время); обработка не полная."
                continue
            page = None
            bitmap = None
            try:
                page = document[data["page"] - 1]
                w, h = page.get_size()
                if not w or not h:
                    raise ValueError("Некорректный размер страницы")
                bitmap = page.render(scale=min(3, 2500 / max(w, h)))
                processed += 1
                result = recognize(bitmap.to_pil(), timeout=min(45, max(1, 500 - (time.monotonic() - started))))
                if result.get("cached"):
                    processed -= 1
                data["ocr"] = result
                data["text"] = result["text"]
                data["textSource"] = "ocr"
            except Exception as error:
                data["ocrError"] = str(error)[:500]
            finally:
                if bitmap is not None:
                    bitmap.close()
                if page is not None:
                    page.close()
    finally:
        document.close()
    return pages
