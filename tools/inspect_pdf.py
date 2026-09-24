#!/usr/bin/env python
"""Inspect the 2015 PDFs: layout, text layer, and what a parser must survive.

Read-only with respect to Datas/. Writes reports + page renders under build/pdf_inspect/.
"""
import json
import re
import sys
from pathlib import Path

import fitz  # PyMuPDF

ROOT = Path(__file__).resolve().parent.parent
ART = ROOT / "Datas" / "articles" / "2015"
OUT = ROOT / "build" / "pdf_inspect"
OUT.mkdir(parents=True, exist_ok=True)

DOI_RE = re.compile(r"10\.\d{4,9}/[-._;()/:A-Za-z0-9]+")
URL_RE = re.compile(r"https?://[^\s)>\]]+")

rows = []
for pdf in sorted(ART.glob("*.pdf")):
    doc = fitz.open(pdf)
    meta = doc.metadata or {}
    pages = []
    all_text = []
    for i, page in enumerate(doc):
        text = page.get_text("text")
        all_text.append(text)
        d = page.get_text("dict")
        # column split heuristic: cluster text block x-centres
        blocks = [b for b in d["blocks"] if b.get("type") == 0]
        x0s = [b["bbox"][0] for b in blocks]
        n_fonts = len({s["font"] for b in blocks for l in b.get("lines", []) for s in l.get("spans", [])})
        pages.append({
            "page": i + 1,
            "chars": len(text),
            "words": len(text.split()),
            "text_blocks": len(blocks),
            "image_blocks": sum(1 for b in d["blocks"] if b.get("type") == 1),
            "drawings": len(page.get_drawings()),
            "fonts": n_fonts,
            "width": round(page.rect.width, 1),
            "height": round(page.rect.height, 1),
            "replacement_chars": text.count("\ufffd"),
            "x0_min": round(min(x0s), 1) if x0s else None,
            "x0_max": round(max(x0s), 1) if x0s else None,
        })
    full = "\n".join(all_text)
    dois = sorted(set(m.rstrip(".,;") for m in DOI_RE.findall(full)))
    urls = sorted(set(URL_RE.findall(full)))[:10]
    rows.append({
        "file": pdf.name,
        "pages": len(doc),
        "title_meta": meta.get("title"),
        "author_meta": meta.get("author"),
        "subject_meta": meta.get("subject"),
        "keywords_meta": meta.get("keywords"),
        "producer": meta.get("producer"),
        "creator": meta.get("creator"),
        "has_toc": bool(doc.get_toc()),
        "total_chars": len(full),
        "total_images": sum(p["image_blocks"] for p in pages),
        "dois": dois[:6],
        "urls": urls[:6],
        "pages_detail": pages,
    })

    # save page 1 text + full text for closer reading
    stem = pdf.stem.replace("-", "").replace(" ", "") or "doc"
    (OUT / f"{stem}_page1.txt").write_text(all_text[0], encoding="utf-8")
    (OUT / f"{stem}_full.txt").write_text(full, encoding="utf-8")
    # render page 1 and the page with most images
    for pno in {0, max(range(len(pages)), key=lambda i: pages[i]["image_blocks"])}:
        pix = doc[pno].get_pixmap(dpi=110)
        pix.save(str(OUT / f"{stem}_p{pno + 1}.png"))
    doc.close()

(OUT / "_pdf_summary.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")

# ---- console summary ----
for r in rows:
    print("=" * 100)
    print(f"{r['file']}  pages={r['pages']}  chars={r['total_chars']}  images={r['total_images']}")
    print(f"  meta.title   : {r['title_meta']!r}")
    print(f"  meta.author  : {(r['author_meta'] or '')[:90]!r}")
    print(f"  meta.subject : {(r['subject_meta'] or '')[:90]!r}")
    print(f"  meta.keywords: {(r['keywords_meta'] or '')[:90]!r}")
    print(f"  producer     : {r['producer']!r}  creator={r['creator']!r}  toc={r['has_toc']}")
    print(f"  dois         : {r['dois']}")
    print(f"  urls         : {r['urls'][:4]}")
    multi = sum(1 for p in r["pages_detail"] if p["x0_max"] and p["x0_min"] is not None and (p["x0_max"] - p["x0_min"]) > 400)
    print(f"  pages with wide x-spread (likely 2-col): {multi}/{r['pages']}")
    print(f"  page detail  : " + ", ".join(
        f"p{p['page']}(c={p['chars']},img={p['image_blocks']},dr={p['drawings']},f={p['fonts']})"
        for p in r["pages_detail"]))
print("\nwritten:", OUT)
