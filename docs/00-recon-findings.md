# Findings — 2015 gold standard & PDF reconnaissance

> Status: reconnaissance complete for 2015 + full schema sweep across 2015–2025.
> **`Datas/` is strictly read-only.** All tooling writes only to `build/` (gitignored scratch).

## 1. What the gold standard actually is

`Datas/label/*.xlsx` — 11 workbooks, one per publication year 2015–2025.

| Year | File | Papers | Sheet1 rows | Sheet3 rows |
|---|---|---|---|---|
| 2015 | `2015-6篇-0813.xlsx` | 6 | 11 | 33 |
| 2016 | `2016-15篇-0813.xlsx` | 15 | 24 | 50 |
| 2017 | `2017-17篇-0813.xlsx` | 17 | 26 | 45 |
| 2018 | `2018-12篇-0813.xlsx` | 12 | 19 | 44 |
| 2019 | `2019-19篇-0813.xlsx` | 19 | 27 | 77 |
| 2020 | `2020-20篇-0813.xlsx` | 20 | 42 | 137 |
| 2021 | `2021-23篇.xlsx` | 23 | 35 | 127 |
| 2022 | `2022-20篇.xlsx` | 20 | 28 | 134 |
| 2023 | `2023-31篇.xlsx` | 31 | 57 | 175 |
| 2024 | `2024-29篇.xlsx` | 29 | 41 | 198 |
| 2025 | `2025-33篇.xlsx` | 33 | 42 | 171 |

**Total ≈ 225 papers.** Each workbook has exactly three sheets (spelling varies: `Sheet 2` vs `Sheet2`):

| Sheet | Grain | Width | Role |
|---|---|---|---|
| **Sheet1** | article × **comparison** (arm-pair) | 91 (2015–19) → 308–366 (2021–22) | PICO, design, acupuncture protocol, analysis population |
| **Sheet2** | **article** — exactly one row per paper | 12 → 10 (2020-24) → 116 (2025) | title, primary outcome, 5-category outcome classification |
| **Sheet3** | **outcome × timepoint** × comparison | 219–220 | per-timepoint effect estimates, event counts, group sizes |

A paper with K comparisons occupies **K rows** in Sheet1 and Sheet3, but **1 row** in Sheet2. This is why Sheet1/Sheet3 distinct-ID counts exceed Sheet2's.

WPS puts part of the schema in **cell comments** (`xl/comments1.xml`), e.g. `1-Pains 2-Other symptoms... 6-primary outcomes` and the Chinese-journal rules for journal classification. Any reader must ingest comments, not just cells.

## 2. The ID grammar — this is the extraction key

- `STUDYID = YYYY-NN` (article) or `YYYY-NN-K`, **K = 2-digit comparison/arm index**, e.g. `2015-04-01` / `2015-04-02` = one paper, two comparisons.
- Sheet3 adds an **outcome ordinal** in column B, e.g. `EN009-1`, `EN009-2`.
- **Column A is the ID column in all three sheets.** Data starts at row 3 (rows 1–2 are headers in Sheet1/Sheet2; Sheet3 has a 5-row header).

2015 example — 6 papers expand to 9 comparisons:

```
2015-01 2015-02 2015-03 2015-04-01 2015-04-02 2015-05-01 2015-05-02 2015-06-01 2015-06-02
Sheet2:  2015-01 … 2015-06                     (6 rows, no arm suffix)
```

## 3. The single most important design constraint: dual encoding

**Most columns hold a controlled code; the evidence is raw text elsewhere.** Sheet1 carries a legend row (`1=… 2=…`) plus a field-name row. Examples:

| Col | Field | Legend |
|---|---|---|
| D | outliers / influential obs | `1=overall 2=pain 3=non-pain 4=function 0=no OI` |
| S | 疾病系统 disease system | 18 ICD-like categories |
| Z | 对照组类型 control type | 1=空白对照/等待组 … 6=其他 |
| AA | 对照组类型转换 | 1=Penetrating needle sham … 6=Low-intensity control |
| AB | 比较类型 comparison type | 1=针刺vs空白 … 4=针刺+其他 vs 假针+其他 |
| AD | 随机序列产生方法分类 | 1=随机数字表 … 8=未报告 9=其他 |
| AF | 分配隐藏方法分类 | 1=中心隐藏 … 5=未报告 6=其他 |
| AG | 分层或区组随机 | 0=无 1=分层 2=区组 3=分层区组 |
| AH/AI | 盲研究对象 / 盲结局评价者 | 1=是 2=否 3=未报告 |

Sentinels in use: `NR` (not reported), `NA` (not applicable), `0`, and **compound values** like `1/3`, `2/5`, `3/2`.

→ **Every extracted field must be a triple: `code` + `raw_text` + `evidence`.** Only then can we both machine-score against the gold code and show a human the sentence it came from. This is also exactly what makes the "框选提取证据" (box-select evidence) UI meaningful.

## 4. Sheet3 anatomy (outcome level)

Five header rows; **row 5 holds the machine codes** and rows 1–4 the Chinese legends:

```
r1: 文献编号 | construct-type | 1=双臂 2=多臂 3=多试验组 4=多对照组 | 特殊数据情况 |
    construct | subconstruct | P值 | 测量结局 | 测量类型 | 基线是否调整 | 主要结局测量时点 |
    基线期 | 疗程结束时 | 随访时间 | 随访结束时(≥80%数据的最长时间点)
r2: outliers and influential observations | 1=P<0.05 2=P>0.05 |
    连续型变量 | 二分类变量 | 分类方法 | 等级资料 | 连续结局 | 二分类变量 | 分类方法 | 等级资料 | …
r3/r4: sub-column legends (估计值/变异值下限/上限/例数/发生事件数, OR/RR/RD/HR + 95%CI…)
r5: STUDYID | ARMNU | STDATA | CONST | SUBCONST | PVALRAG | PVALNUM | OUTCOM | INSTRU |
    RANGE | MDIRE | MUNIT | MTYPE | IFADJ | POTIMPO | SPECO |
    BTESTI BTVARI | BIESTI BILVARI BIUVARI BNINTE | BCESTI BCLVARI BCUVARI BNCONT |
    BDEST BDLVAR BDUVAR | BINEVE BINUM | BCNEVE BCNUM | BOR BORCIL BORCIU | BRR … | BRD … | BHR … |
    BRADACLA | BRDINFRI..BRDINSIX BRDINNUM | BRDCOFRI..BRDCOSIX BRDCONUM |
    E…  (疗程结束时, same shape) | DC FOLTIM DD FOLTIMN DE FOLTIMU | F… (随访结束时, same shape)
```

So there are **three timepoint blocks** (B = baseline, E = end of treatment, F = follow-up), each split into **continuous / binary / categorical(等级资料)** groups:

- continuous: `*IESTI` (estimate type), `*ILVARI`/`*IUVARI` (CI bounds), `*NINTE` (n), and per-group `*CESTI/*CLVARI/*CU VARI/*NCONT`
- binary: `*INEVE`/`*INUM` (events/n) per group, plus `*OR/*RR/*RD/*HR` + CI
- categorical: `*RADACLA` (classification method), 6 category counts `*DIN{FRI,SEC,THI,FOR,FIF,SIX}` + `*DINNUM`, and per-group `*DCO{FRI..SIX}` + `*DCONUM`

Verified against `2015-01` (fibromyalgia, VAS): `BIESTI=3` (change-from-baseline), `BILVARI/BILUVARI` empty, `BNINTE=78`, `BCESTI=-27.1, BCLVARI=-33.2, BCUVARI=-20.9, BNCONT=81`, `FOLTIMN=42 FOLTIMU=4` (weeks), follow-up `FIESTI=3`, `FCESTI=-6.2 … FNCONT=82`. All consistent with the article's abstract (−41.0% vs −27.1% at 10 weeks).

## 5. What the 2015 PDFs look like

| File | Pages | Chars | Images | Embedded title |
|---|---|---|---|---|
| `-2015-01.pdf` | 11 | 45 388 | 24 | `"untitled"` |
| `-2015-02.pdf` | 9 | 51 606 | 6 | real title |
| `-2015-03.pdf` | 10 | 34 850 | 1 | real title |
| `-2015-04.pdf` | 13 | 64 537 | 2 | real title |
| `-2015-05.pdf` | 5 | 32 230 | 3 | real title |
| `-2015-06.pdf` | 7 | 25 721 | 3 | `null` |

- **All six have a real text layer** → no OCR needed for 2015. Filenames are `-2015-01.pdf` (leading hyphen — a naming bug to tolerate; it maps to `study_id 2015-01`).
- **Embedded metadata is unreliable**: `-2015-01` says `Title="untitled"`, `-2015-06` has none. Where present, `Subject` is a citation string: `"Annals of Allergy, Asthma & Immunology, 115 (2015) 317-325. doi:10.1016/j.anai.2015.05.017"`.
- **Naive DOI harvesting is unsafe**: concatenated text runs produce `10.1136/acupmed-2015-010950group.bmj.com` and `10.1016/j.anai.2015.05.017.References`; `-2015-05.pdf` yields reference DOIs including an unrelated **2018** DOI. → anchor to page 1 and validate through Crossref.
- Registration IDs in text: `ISRCTN60217348`, `ChiCTR-10R-14005249`, `NCT03391986`.
- Note the gold standard records `-2015-05.pdf`'s journal with a **2018** DOI — so the folder year is the *corpus* year, not necessarily the publication year. Never infer metadata from the folder name.

## 6. Prior art embedded in the data (not ours)

`Datas/articles/2015/.article_agent_hybrid/` holds a previous run for `-2015-01.pdf` only: `normalized_document.json` (`NORMALIZED_DOCUMENT/1.0`), `parser_route.json`, `pdf_text_layer.json`.

It is a useful schema precedent — `blocks[]` of `{block_id, page, kind, text, bbox, reading_order, section, parser_backend, detector_backend, confidence, metadata}` — but **it documents the exact failure the project must fix**:

```
preferred_backend: "mineru"
effective_backend: "pymupdf-structured-fallback:mineru"
fallback_used: true
warnings: ["... uses PyMuPDF structured fallback for mineru ..."]
tables: 6 detected, ALL empty  →  rows: [], header: [], html: "<table></table>"
         structure_backend: "deterministic-rows"
         warning: "No model table structure available; regular-cell fallback used"
formulas: 2, status: "unavailable" (parser_backend: "unimernet-unavailable")
```

Also note its metadata was already wrong: it tagged a page-1 author block as `page_type: "figure_dense"` because of the logo images. Text-layer stats claimed `multi_column_pages: 10/11` while our own gutter heuristic found few — column detection needs a real algorithm, not a heuristic guess.

## 7. Environment reality check

- Available: `node v24.20.0`, npm, pnpm, git, `python 3.14.6` + pip.
- **MinerU / magic-pdf NOT installed. No Java, no Tesseract.**
- PyMuPDF **cannot install** on Python 3.14 (no wheel, source build fails) → used `pdfjs-dist` (legacy build; dynamic import on Windows needs a `file://` URL) for the reconnaissance above.
- MinerU typically requires Python ≤3.12 → plan a dedicated venv (`uv` recommended) or a MinerU HTTP service rather than polluting the system Python.

## 8. Tooling built so far (scratch, in `tools/`)

| Tool | Purpose |
|---|---|
| `tools/extract_gold_xlsx.mjs` | dependency-free xlsx reader (ZIP + XML via `node:zlib`) → `build/gold_inspect/*.txt` grid dumps |
| `tools/xlsx_schema.mjs` | aligned per-column schema dump of every sheet |
| `tools/gold_grammar.mjs` | auto-detects ID column, classifies ID shapes per sheet/year → `build/gold_inspect/GRAMMAR.txt` |
| `tools/inspect_pdf.mjs` | pdfjs-dist PDF reconnaissance → `build/pdf_inspect/` |

Note: a correct XML tokenizer must treat tags as `<([^>]*)>`; a "proper" attribute regex with a mandatory `\s+` silently matches nothing for `<tag a="b">`, which is how the first attempt returned zero sheets.
