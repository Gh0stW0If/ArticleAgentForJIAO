# 影响因子（2019）：从 IF-SCI-2019.xlsx 查表

> 用户口径：**影响因子从 `Datas/IF-SCI-2019.xlsx` 查询**。
> 本文记为什么这么做、怎么查、以及查表后暴露出的金标准问题。

## 1. 为什么要查表

影响因子是**论文里根本没有的数**——让模型凭记忆答，实测结果很难看：

| | 旧做法（模型凭记忆答） |
|---|---|
| 222 篇里答对 | 50 篇，其中**几乎全是"双方都填 NR"** |
| 答错 | 172 篇 |

即模型没有这个知识，只是在"看起来合理"地编。改成查表后，同一期刊的答案稳定、可追溯到具体表格行。

## 2. 表结构（实测）

`Datas/IF-SCI-2019.xlsx`，单表 `DJR_7955`，9366 条有效条目（2019 年 SCIE 全刊）：

| 行 | 内容 |
|---|---|
| 1~2 | 导出说明（`Journal Data Filtered By: Selected JCR Year: 2019 Selected Editions: SCIE …`） |
| **3** | **表头**：Rank \| Full Journal Title \| Total Cites \| (空) \| Journal Impact Factor \| Eigenfactor Score |
| 4~ | 数据（列 B = 刊名全称，列 E = 影响因子） |

⚠️ 表头不在第 1 行。按"首行即表头"解析会读出 0 条（`tools/lib/if.mjs` 里按关键词在**前 12 行**里找表头）。

## 3. 检索口径（宁缺勿错）

顺序：**归一后精确相等 → 带别名的精确相等 → 唯一缩写匹配 → 否则查不到**。

归一化（`normJournal`）：去括号/问号后的补充说明（`BJU International (BJUI)`、`Journal of ...? (not specified)`）、
大写、`&`→and、去标点、去虚词（the/of/and/for/a/an）、压空白。

**唯一缩写匹配**是解决"论文首页印缩写、表里是全称"的关键：
`Int J Clin Exp Med` → `International Journal of Clinical and Experimental Medicine`（0.166）、
`Menopause` → `MENOPAUSE-THE JOURNAL OF THE NORTH AMERICAN MENOPAUSE SOCIETY`（3.305）、
`EXPLORE` → `Explore-The Journal of Science and Healing`（1.485）。
但**必须唯一命中**才采纳：`PAIN` 会同时套上 PAIN / PAIN MEDICINE / PAIN PRACTICE …，一律拒绝。

别名白名单只放**确定无歧义**的：`JAMA` → `JAMA-JOURNAL OF THE AMERICAN MEDICAL ASSOCIATION`（45.540）、
`BMJ` → `BMJ-British Medical Journal`（30.313）、`Plus one`（语料里的错拼）→ `PLoS One`（2.740）。
按前缀猜 `JAMA` 会同时命中 JAMA Oncology / Psychiatry / Surgery 等六种，猜错=填错刊。

**查不到就填 0**：表是 SCIE 全刊表，查不到即"该刊 2019 年未进 SCIE"（中文刊、ESCI 刊都在此列），
而工作表对这一类的约定就是 0。实测金标准里"填 0"的 59 处正是这类期刊。

## 4. 落在流水线的哪一步

| 位置 | 作用 |
|---|---|
| `tools/lib/if.mjs` | 纯函数：解析 xlsx、建索引、查表（工具与流水线**共用同一实现**，避免两处口径漂移） |
| `tools/if_index.mjs` | CLI：生成 `build/if-2019.json`；`--measure` 用金标准核对，`--gaps` 只列查不到的刊 |
| `packages/skills/src/article-meta.ts` 步骤 8 | 确定性填 `impactFactor2019`（`provenance: 'external'`，证据写明"IF-SCI-2019.xlsx：<刊名> = <值>"），记 `IF_FROM_TABLE` / `IF_NOT_IN_TABLE` |
| `tools/llm_run.mjs` | 启动时载入索引（缺失则现算）并注入 SKILL |
| `tools/canonical-field-map.mjs` | 该字段 `source` 从 `llm` 改为 `gold_meta` → **提示词不再要求模型输出它**（省 token，也避免它继续编） |

期刊名有两个来源，**两个都试**：Crossref 的 `container-title`（权威全称）与 PDF 里抽到的刊名。
但 Crossref 判定 `mismatch` 时说明 DOI 指的不是这篇，它的刊名不可信 → 只用 PDF 的刊名。

## 5. 查表暴露出的金标准问题（124 + 6 条）

期刊名能在表里对上的 185 篇里：**完全一致 61 篇**、数值不同 54 篇、金标准填 0/NR 而表里有值 70 篇
（另有 36 篇期刊名不在表里、3 篇期刊列夹着人工批注）。

按"以表为准"的口径，这些不一致**记录为疑似金标准问题、不参与评分**
（`tools/if_gold_anomalies.mjs` → `build/gold_anomalies.json`，两类 reason）：

1. **`影响因子与 IF-SCI-2019.xlsx 不一致（以表为准）`**（124 条）：期刊名对得上、数值对不上，例如
   `Acupuncture in Medicine` 表值 2.129 / 金标准 2.485；`Clinical Rehabilitation` 2.599 / 3.477；
   `Nature and Science of Sleep` 4.375 / 2.129；`Cancer` 5.772 / 5.742。
   差异多呈"整体偏高"，提示金标准可能来自**另一个年度的 JCR**，需你们确认以哪年为准。
2. **`金标准期刊名不在 IF-SCI-2019.xlsx 中…`**（6 条）：金标准的期刊列本身有问题——
   如把学会名当刊名（`International Association for the Study of Pain`）、
   或串成了别的文章的刊名（2017-15 金标准写 `Nephro-Urology Monthly`，论文实为 `JAMA Internal Medicine`）。

**影响因子字段的成绩**：计分 94 处中 **76 对 / 18 错（80.9%）**，另有 128 处按政策不计分。
旧做法是 22.5%。剩下 18 处是"金标准的期刊名与论文实际期刊都不在表里"这类无法用表裁决的情况。

## 6. 复现

```bash
pnpm if:index          # 生成/更新 build/if-2019.json（并打印条目数）
pnpm if:gaps           # 列出"表里查不到"的期刊名，便于人工确认是不是缩写/写错
node tools/if_index.mjs --measure   # 用金标准核对查表效果
pnpm if:gold           # 把与表冲突的金标准值记录为疑似问题（--dry 只看不写）
```
