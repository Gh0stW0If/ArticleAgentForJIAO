"""用 PyMuPDF 取 PDF 原生文字（词级坐标），供 tools/table_fidelity.mjs 对账用。

为什么要单独写：MinerU 的产物里没有"原生文字层"这一路，
要回答"MinerU 有没有把数字读错/漏读"，必须有**独立于 MinerU 的第二来源**。
MinerU 自己就用 PyMuPDF（venv 里已装 1.28），复用它最省事、也最接近"PDF 真值"。

用法：python pdf_words.py <输出 json 路径> <pdf1> [pdf2 ...]
  · 一次传多篇（node 按年分批），避免 224 次解释器启动；
  · **必须走文件输出**：Windows 下 python 的 stdout 默认 cp936，
    管道里遇到中文会 UnicodeEncodeError（实测踩过：表现为"取原生文字失败"）。

输出结构：
  { "<pdf 路径>": { "page_count": N,
      "pages": [ { "page": 1, "width": W, "height": H,
        "words": [ { "t": "52.3", "b": [x0,y0,x1,y1] }, ... ] } ] } }
"""

import json
import sys

import pymupdf  # noqa: N813  (PyMuPDF 的模块名)

out_file = sys.argv[1]
pdfs = sys.argv[2:]

result = {}
for path in pdfs:
    doc = pymupdf.open(path)
    pages = []
    for i, page in enumerate(doc):
        words = [
            {"t": w[4], "b": [round(w[0], 1), round(w[1], 1), round(w[2], 1), round(w[3], 1)]}
            for w in page.get_text("words")
        ]
        pages.append({
            "page": i + 1,
            "width": round(page.rect.width, 1),
            "height": round(page.rect.height, 1),
            "words": words,
        })
    result[path] = {"page_count": doc.page_count, "pages": pages}
    doc.close()

with open(out_file, "w", encoding="utf-8") as fh:
    json.dump(result, fh, ensure_ascii=False)
