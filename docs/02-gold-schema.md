# 金标准层级 JSON Schema（需求 7）

> 生成器：`tools/gold_normalize.mjs` ｜ Schema 定义：`tools/gold_schema.mjs`
> 输出：`build/gold/<year>.json`（11 个文件，2015–2025，**共 225 篇文章**）
> **`Datas/` 全程只读**，归一化结果只写入 `build/`。

## 1. 统一规范 schema 的依据

**结论：一套 schema 覆盖全部 11 个年份（2015–2025）。** 依据来自实测（`build/gold_inspect/HEADERS.txt`、`_labelsets.json`、`UNIFORMITY.txt`）：

1. **Sheet3 的 151 个编码列在所有年份逐列一致** —— 首列 `STUDYID`、末列 `FRDCONUM`，
   顺序完全不变。这是最硬的证据。
2. **Sheet1 的 91 个字段名与顺序一致**，2020 起只是**表头整体右移 1 列**（锚点 B→A）。
3. Sheet2 在 2020 起由 12 列变 10 列（去掉一个空列），且部分标签改名：
   `非疼痛症状类结局`→`非疼痛症状类`、`功能类结局`→`功能类` 等。

因此 **归一化绝不按列号硬编码，而是按标签锚定**。

> 用户已确认：2021–22 Sheet1 的"366 列"后面是空白，实际内容格式相同 → 统一 schema。

## 2. 三层粒度（与金标准三大 Sheet 一一对应）

```
article       YYYY-NN        每篇 1 条     ← Sheet1 文章级字段 + Sheet2（合并）
comparison    YYYY-NN-K      试验/对照配对  ← Sheet1 每行
outcome       YYYY-NN-K      结局 × 时点    ← Sheet3 每行
```

含 K 个比较组的文章在 comparison/outcome 层展开为 K 份，但在 article 层归约为 1 条。

## 3. 字段三元组

每个字段都是 `{ code, raw, legend }`：

| 键 | 含义 |
|---|---|
| `raw` | 原始单元格值，**永不失真**（评分与人工核对的基础） |
| `code` | 当值形如 `1`、`2/5`、`1/3` 时给出（受控编码） |
| `legend` | 该列的编码图例（来自 Table1 图例行），用于解释 code |

例：
```json
"control_type_converted": { "raw": "2/5", "code": "2/5", "legend": "1=Penetrating needle sham 2=Non-penetrating needle sham ..." }
```

## 4. 顶层结构

```jsonc
{
  "schema_version": "GOLD/1.0",
  "generated_from": "2015-6篇-0813.xlsx",
  "year": "2015",
  "level": "article+comparison+outcome",
  "counts": { "articles": 6, "comparisons": 9, "studies": 6, "outcomes": 22, "orphan_outcomes": 0 },
  "field_definitions": { /* 字段定义（唯一真源，全 JSON 只存一份） */ },
  "column_map": { "sheet1": {...}, "sheet2Offset": 0, "sheet3": {...} },
  "data_quality": [ /* 源表完整性问题 */ ],
  "articles": [
    {
      "article_id": "2015-01",
      "article": { /* 文章级字段 */ },
      "study":   { /* Sheet2 结局分类 */ },
      "comparisons": [ { "study_id": "2015-01", "article_id": "2015-01", "intervention": {...}, ... } ],
      "outcomes": [ /* 结局级，见下 */ ]
    }
  ],
  "warnings": []
}
```

## 5. 结局级（Sheet3）的层级展开

152 个平铺编码列收敛为可读结构 —— 这是本次归一化的核心价值：

```jsonc
{
  "literature_code": { "raw": "EN009-1" },   // Sheet3 的「STUDYID」列实为文献编号+结局序号
  "article_id":      { "raw": "2015-01" },   // 真实文章号（来自 Sheet3 的 A 列）
  "arm_number":      { "raw": "1", "code": "1" },
  "outcome": {
    "construct_code": {...}, "subconstruct_code": {...},
    "p_value_range": {...}, "p_value": { "raw": "0.001" },
    "name": { "raw": "fibromyalgia" }, "instrument": { "raw": "VAS" },
    "measurement_range": { "raw": "0-100" }, "measurement_direction": {...},
    "measurement_type": {...}, "baseline_adjusted": {...},
    "primary_outcome_timepoint": {...}, "special_category": {...}
  },
  "follow_up": { "description": {...}, "value": {...}, "unit": {...} },
  "timepoints": {
    "baseline":          { "continuous": {...}, "binary": {...}, "categorical": {...} },
    "end_of_treatment":  { "continuous": {
        "estimate_type": {...}, "variance_type": {...},
        "experimental": { "estimate": {"raw":"-41"}, "ci_lower": {"raw":"-47.2"}, "ci_upper": {"raw":"-34.8"}, "n": {"raw":"78"} },
        "control":      { "estimate": {"raw":"-27.1"}, "ci_lower": {"raw":"-33.2"}, "ci_upper": {"raw":"-20.9"}, "n": {"raw":"81"} }
    } },
    "follow_up_end": { "continuous": { /* 同上 */ } }
  }
}
```

- 每个时点块内含 **continuous / binary / categorical** 三组（对应金标准的
  连续型变量 / 二分类变量 / 等级资料）。
- 空块**自动省略**（例如 `2015-01` 的 PainVAS 没有基线绝对值，`baseline` 就不出现），
  这本身就是有意义的信息：可选性由数据决定。

## 6. 锚定策略（为什么不会随时间漂移）

| Sheet | 锚定方式 |
|---|---|
| Sheet3 | 找含 `STUDYID` 的行 → 从该列起**顺序消费**非空编码，映射到 151 个已知编码名 |
| Sheet1 | 字段名行（锚点 `题目`）+ 图例行（上一行）；重复标签段（试验组/对照组 各出现 4 次）用 `group + groupIndex` |
| Sheet2 | 字段名行（锚点 `文献编号`），标签支持**多别名**（兼容 2020 改名） |

**列偏移的自动校准**：Sheet1 表头有合并单元格，导致「文献编号」「提取人姓名」两个标签
位于 B/C 列而数据在 A/B 列；**其余 89 列是对齐的**。归一化器用
「表头标签所在列 vs ID 实际所在列」比对来判定，不靠猜（Sheet1 得 −1，Sheet2 得 0）。

## 7. 已验证的正确性

以 `2015-01`（纤维肌痛针刺 RCT）为例，归一化数值与金标准原始单元格逐项吻合：

| 字段 | 归一化输出 | 金标准原始 |
|---|---|---|
| 疗程结束·试验组 | `-41`, CI `-47.2/-34.8`, n=78 | `3 \| 2 \| -41 \| -47.2 \| -34.8 \| 78` |
| 疗程结束·对照组 | `-27.1`, CI `-33.2/-20.9`, n=81 | `-27.1 \| -33.2 \| -20.9 \| 81` |
| 随访结束·试验组 | `-19.9`, CI `-24.6/-15.1`, n=80 | 与摘要「12 months: −19.9%」一致 |
| 基线块 | 正确省略 | 该结局基线列为空 |

## 8. 源表数据质量问题（`data_quality`，非解析错误）

9/11 个年份完全干净。**2022 与 2024 存在跨年份 ID 笔误**，已定位到根因并实现可审计的自愈。

### 8.1 结论：2022 表中的 `2024-05` / `2024-06` 确实是 `2022-05` / `2022-06` 的 ID 笔误

**四条独立证据构成闭环：**

| # | 证据 | 内容 |
|---|---|---|
| 1 | **PDF 交叉验证** | `2022/2022-05.pdf` 首页标题 = "Auricular Acupressure for **Hemodialysis** Patients with **Insomnia**"；`2022/2022-06.pdf` = "Acupuncture vs Sham… **Aromatase Inhibitor**–Related Joint Pain" |
| 2 | **Sheet2 未写错** | 同一文件 Sheet2 里是 `2022-05` / `2022-06`，标题与 Sheet1 中那两个「2024-XX」**完全一致** |
| 3 | **序号缺口** | Sheet1 序号正好跳过 05、06（04 → 07），说明这两行本该是 05/06 |
| 4 | **ID 已被占用** | 2024 文件里 `2024-05` / `2024-06` 是**另外两篇**（CLL 疲劳 / 儿童静脉穿刺疼痛），且 2024 文件夹也有各自对应的 PDF |

**根因**：2022 表是从 2024 表复制而来，改内容时漏改 A 列 ID。

### 8.2 另外 4 处是「复制残留」而非笔误

| 年份 | ID | 判定 | 依据 |
|---|---|---|---|
| 2022 | `2020-14`（3 行结局） | 剔除 | 无文章级记录；2020 文件已收录同 ID（Auriculotherapy…nausea and vomiting in pregnancy） |
| 2022 | `2021-18-02`（5 行结局） | 剔除 | 同上；2021 文件已收录（self-acupressure…pregnancy-related constipation） |
| 2024 | `2025-26`（5 行结局） | 剔除 | 同上；2025 文件已收录 |
| 2024 | `2025-27`（1 行结局） | 剔除 | 同上 |

这些只有 Sheet3 结局行、没有文章级记录，且目标年份已收录同 ID → 判定为早年表复制后残留。

### 8.3 自愈机制（可审计、不丢信息）

修正映射由 `tools/gold_reconcile.mjs` 依据上述证据**自动推导**，写入 `build/gold/_reconcile.json`：

```json
"id_remap": [
  { "file_year": "2022", "from": "2020-14",    "to": null,      "evidence": "stale_duplicate_of_other_year" },
  { "file_year": "2022", "from": "2024-05",    "to": "2022-05", "evidence": "same_title_within_file" },
  { "file_year": "2022", "from": "2024-06",    "to": "2022-06", "evidence": "same_title_within_file" },
  { "file_year": "2024", "from": "2025-26",    "to": null,      "evidence": "stale_duplicate_of_other_year" }
]
```

三步链路（**避免循环依赖**）：

```bash
node tools/gold_normalize.mjs                  # 1) 朴素结果 + 审计基线 build/gold/naive/
node tools/gold_reconcile.mjs                  # 2) 基于 naive/ 推导修正映射
node tools/gold_normalize.mjs --apply-reconcile # 3) 产出规范结果
```

> ⚠️ **为什么要有 `naive/` 基线**：核对工具必须读「未修正」的结果。否则修正一旦生效，异常就消失了，
> 下次核对会得出不同结论（这一点在实现时真实踩到过）。因此无论是否应用修正，
> `build/gold/naive/<year>.json` 始终保存朴素结果。

**行为保证**：
- 默认**不修改**任何 ID（保持源表原貌）；
- `--apply-reconcile` 时才修正，且修正动作**记录在 `data_quality` 里**，不静默；
- 源 `Datas/` 始终只读。

### 8.4 修复结果

| 年份 | 修复前文章数 | 修复后 | 文件声明 |
|---|---|---|---|
| 2022 | 24（含 4 个跨年条目） | **20** | 20 ✅ |
| 2024 | 31（含 2 个跨年条目） | **29** | 29 ✅ |

`2022-05`（21 字段 + 1 比较组 + 8 结局）与 `2022-06`（21 字段 + 2 比较组 + 12 结局）
现已与 Sheet2 记录正确合并。

> **给源表维护者的建议**：2022 表的 `2024-05`→`2022-05`、`2024-06-01/02`→`2022-06-01/02`；
> 删除 2022 表的 `2020-14`、`2021-18-02` 结局行与 2024 表的 `2025-26`、`2025-27` 结局行。

## 9. 各年份统计（修复后）

| 年份 | 文章 | 比较组 | Sheet2 | 结局行 |
|---|---|---|---|---|
| 2015 | 6 | 9 | 6 | 22 |
| 2016 | 15 | 22 | 15 | 45 |
| 2017 | 17 | 24 | 17 | 40 |
| 2018 | 12 | 17 | 12 | 39 |
| 2019 | 19 | 25 | 19 | 72 |
| 2020 | 20 | 27 | 20 | 132 |
| 2021 | 23 | 33 | 23 | 122 |
| 2022 | 20 | 26 | 20 | 121 |
| 2023 | 31 | 40 | 31 | 168 |
| 2024 | 29 | 38 | 29 | 187 |
| 2025 | 32 | 40 | 32 | 166 |
| **合计** | **224** | **301** | **224** | **1114** |

**文章数逐年与文件名声明完全吻合**（6/15/17/12/19/20/23/20/31/29/33），
可作为归一化正确性的一个强校验。

