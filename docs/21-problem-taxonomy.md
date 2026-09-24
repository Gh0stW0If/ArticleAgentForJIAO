# 问题分类：排除"金标准漏填"之后还剩什么

> 用户口径：**"金标准漏填"（机器有值、金标准是 NR/NA/空）暂时忽略**。
> 本文回答排除它之后剩下的问题是什么、各占多少、该往哪修。
> 工具：`tools/problem_taxonomy.mjs`（分桶）、`tools/problem_breakdown.mjs`（细分）。

## 0. 一句话

排除"金标准漏填"后，其余未命中 **26,487 条，只有两类**：

| 类别 | 条数 | 占比 | 性质 |
|---|---|---|---|
| **A. 机器漏抽**（金标准有值、机器空/NR） | **13,775** | 52% | 召回问题，**可修** |
| **B. 值不同**（两边都有值但不等） | **12,712** | 48% | 其中语义判定部分 **97% 是自由文本措辞差异**，硬错很少 |

外加两类**结构性问题**（不落在字段级）：比较组数不一致、结局行对齐。

## 1. 分桶总表

| 工作表 | 字段数 | 正确率 | 未命中 | A 漏抽 | B 值不同 | C 多填* |
|---|---|---|---|---|---|---|
| Sheet1（文章级+比较组） | 27,598 | 52.0% | 13,254 | 2,270 | 5,906 | 5,078 |
| Sheet2（结局分类） | 1,592 | 69.0% | 494 | 93 | 291 | 110 |
| Sheet3（结局×时点） | 49,246 | 20.1% | 39,340 | **11,412** | 6,515 | 21,413 |
| **合计** | **78,436** | **32.3%** | 53,088 | **13,775** | **12,712** | 26,601 |

\* C = 机器多填（金标准漏填），按用户口径**暂时忽略**。
**排除 C 后**：分母 51,835、正确 25,348 → **48.9%**（与整体口径一致）。

> ⚠️ **C 桶的构成必须先说清**：26,601 = **25,461 条"机器多抽出来的字段/行"**（严格桶的 `extra`，
> 其中 Sheet3 占 21,283）+ **1,140 条"金标准空/哨兵而机器有值"**（语义判定桶）。
> 也就是说"忽略金标准漏填"这个口径实际放掉的主要是**机器过填**，而"同一字段金标准空、机器有值"
> 只有 1,140 条。这两件事该不该一起忽略，需要用户拍板——只忽略后者的话，分母从 52,975 变 78,436，
> 准确率从 48.9% 掉到 33.1%。

> 严格比对部分（无 gold/pred 原文，无法再细分）：漏 10,944、错 9,866；
> 语义判定部分：A 2,831、B 2,846、C 1,140。

## 2. A 类：机器漏抽 13,775（52%）——最大的一类，且可修

**它不是一个均匀分布的问题，而是几处集中失血：**

| 形态 | 字段 | 条数 | 该怎么修 |
|---|---|---|---|
| **整列没抽** | `comparison.total_sessions_class_b` | 153 | 见 §2.1：**编码表没进提示词**，可修 |
| **整列没抽** | `comparison.analyzed_n_experimental` / `_control` | 116 / 116 | 见 §2.2：**"无脱落填 0" 的口径冲突**，可修 |
| **单篇集中** | `outcome.p_value` | 289（其中 `2024-24` 一篇漏 34+30） | 该篇是已知的材料/解析问题 |
| **单篇集中** | `outcome.measurement_range` | 252 | 量程常写在表头/表注里 |
| **我引入的退步** | `comparison.course_desc` | 91 | ← **可回滚**：见 §5 |
| **我引入的退步** | `comparison.frequency_desc` | 77 | ← **可回滚**：见 §5 |

**结论**：A 类里至少 **168 条（course_desc 91 + frequency_desc 77）是我那条"防硬凑"规则直接造成的**，
回滚即可收回；另有约 **385 条是"整列没抽"**，属于典型的字段级召回问题，加一条定位提示就能改善。

### 2.1 `total_sessions_class_b`：根因是**提示词里没有这张编码表**

用 `tools/_field_full_acc.mjs`（口径 = 严格桶 + 语义判定，`byField` + 顶层 `judged`）核过：

| 字段 | 全口径字段数 | 严格桶 | 语义判定桶 | 合计 |
|---|---|---|---|---|
| `comparison.total_sessions_class_a` | 237 | 212 @ 58% | 25 @ 0% | **51.5%** |
| `comparison.total_sessions_class_b` | **169** | 16 @ 94% | **153 @ 0%** | **8.9%** |
| `comparison.analyzed_n_experimental` | 293 | 177 @ 53% | 116 @ 0% | **32.1%** |
| `comparison.analyzed_n_control` | 291 | 175 @ 54% | 116 @ 0% | **32.3%** |

- 原始 Excel **表头第 1 行**（`build/legend/<year>.json` 的 `headerLabels`）对"治疗总次数分类"写的是
  **`1high 2low`** —— 它是一列**编码**，不是数值；同一行的"治疗总次数治疗分类"写的是
  `1=手术+穴位按压 2=手术+非穴位按压 3=慢性+穴位按压 4=慢性+非穴位按压`。
- 但 `packages/skills` 的提示词把 class B 描述成
  "该列在原始表格里没有对应批注，按原文可判定的分类填写；无法判定填 NR"，
  JSON 模板给的是 `<原文或 NR/NA>`，**没有给编码表**，且 class B 不在 `CODE_TARGETS` 里
  （class A 在）→ 模型 153/153 全部填 `NR`。
- gold 侧取值：`1`=79、`2`=49、**`3`=31**、NA=8、NR=7、空=127。
  ⚠️ **表头只写了 1/2，gold 却有第 3 档** —— 第 3 档的语义未知，属于**金标准定义疑问**（见 §7），
  补编码表前必须向用户确认。

### 2.2 `analyzed_n_experimental` / `_control`：根因是"无脱落时填 0 还是 NR"

- 实测 `analyzed_n_experimental + analyzed_n_control == dropout_total` 在 **245 / 301** 个比较组成立
  → 该列的真实语义是**各组脱落人数**（与提示词里"该列批注为「脱落人数」"一致）。
- gold 分布：`analyzed_n_experimental` 中 **`0` = 137/301**、`analyzed_n_control` 中 **`0` = 131/301**。
  即金标准的约定是"论文说明无脱落/全部完成 → 填 **0**"。
- 我们的提示词写的是"**未报告填 NR**" → 论文没提脱落时模型填 NR、金标准填 0。
  116 条错例里 **gold=0 的占 55 条（47%）**。
- **可修**，但要加边界："仅当论文明确说明无失访/全部完成（或 CONSORT 流程图显示无失访）时填 0"，
  避免把金标准真为 NR 的条目改坏。

## 3. B 类：值不同 12,712（48%）——主要是"措辞"不是"错"

**语义判定部分（2,846 条）的构成**：

| 金标准取值的形态 | 条数 | 占比 |
|---|---|---|
| **自由文本**（措辞/颗粒度差异） | **2,774** | **97%** |
| 编码取值 | 60 | 2% |
| 纯数值 | 62 | 2% |

即：**这一类的性质是"同一件事的两种说法"**——金标准抄整句、机器抄要点
（`docs/11` §4 实测：3,480 组失配里 24% 是一方包含另一方、9% 高度相似）。
它的失分来自**判分口径**，而不是抽取能力。

**最集中的字段**：

| 字段 | B 类条数 | 说明 |
|---|---|---|
| `outcome.name` | 450 | 结局名称（"pain intensity" vs "PainVAS"） |
| `outcome.instrument` | 274 | 量表名（常带/不带版本、缩写 vs 全称） |
| `followUp.description` | 247 | 随访描述 |
| `comparison.intervention` | 181 | 干预名称（提示词已规定 `干预+合并治疗`、全小写、用 `+` 连接） |
| `comparison.randomization_method` | 164 | 随机方法原文 |
| `comparison.control` | 140 | 对照干预名称 |
| `study.primary_outcome` | 131 | 主要结局（Sheet2） |
| `article.condition` | 108 | 疾病名称 |

**严格比对部分（9,866 条错）** 才是真正需要看"值为什么不一样"的地方——
但那部分评测报告里没有留下 gold/pred 原文，要查得重跑带 `--detail` 的评测。

### 3.1 判分口径的直接代价：`contains_correct` = 0.5 分

`tools/_verdict_impact.mjs` 全量统计：语义判定 **10,102** 条里
`completely_different` 4,192、`identical` 1,875、**`contains_correct` 1,234**、`same_meaning` 1,410、`has_error` 1,391。

| 若把 `contains_correct` 记成 | 总分变化 | 整体准确率 |
|---|---|---|
| 0.5（现状） | — | 48.9% |
| 0.75 | **+0.58 点** | 49.5% |
| 1.0 | **+1.16 点** | 50.1% |

即"防硬凑"这一条规则**单独值 0.6~1.2 个点**，而它压掉的所谓"多填"多数是模型对的
（`docs/20` §6.2）。这是**纯口径决策**，不涉及任何抽取能力。

## 4. 结构性问题（不落在字段级）

### 4.1 比较组数不一致：51 / 222 篇（23%）

**但两个方向的后果完全不同**：

| 方向 | 篇数 | 后果 |
|---|---|---|
| 机器**多**出比较组 | **48** | 多出的字段全进"多填"桶 → **按用户口径可忽略**；而且很可能与"金标准漏填"同源（三臂试验金标准只记了 1 个比较组） |
| 机器**少**了比较组 | **3**（`2018-06` 1→0、`2021-11` 4→2、`2025-02` 2→1） | 缺失那组的字段**全部算漏抽** ≈ **434 个字段** ← 不可忽略 |

### 4.2 结局行对齐（Sheet3 的根问题）

Sheet3 是问题总量的最大来源（A+B = 17,927，占 68%），而它的低分**主要不是字段读错**——
`docs/11` §1.1 已查明：金标准结局行 1,110 条里 **344 条（31%）没配上**，
占 Sheet3 全部"漏"的 **85%**。本次评测的对齐方式：纯文本配上 577 对、靠数值佐证 143 对、弱对齐 55 对。

→ **这是对齐/粒度问题**（同一量表被拆成多行、多域），不是抽取能力问题；
按 `docs/14` 的裁定应该用**确定性规则**解决（量表名归一 + 分数/分量表后缀），而不是加 SKILL。

### 4.3 被"对齐错位"直接排除出分母的条目：578 条

`build/eval/<year>.json` 里有一份 `excludedMisaligned`（11 年合计 **578** 条）。
这些金标准字段**既不算对也不算错**，等于被悄悄移出分母。样例：

```
2015-01/max_followup_desc=42 weeks      2015-02/n=78        2016-03/estimate=9.85
2016-03/ci_lower=0.27                   2017-08/impact_factor_2019=0
2017-10/missing_data_handling=11：Worst case scenario, single imputation
```

形态几乎全是**结局数值列**（`n` / `estimate` / `ci_lower` / `description`）——
与 §4.2 的行对齐同源。它们被排除是**合理的**（错位的行拿来比只会产生假错），
但必须在报告口径里写明：**分母 52,975 不含这 578 条**。

### 4.4 逐字段低分榜（口径：严格桶 + 语义判定，样本 ≥ 120）

| 字段 | 字段数 | 严格桶 | 语义桶 | 合计率 |
|---|---|---|---|---|
| `comparison.total_sessions_class_b` | 169 | 16 @ 94% | 153 @ 0% | **8.9%** |
| `outcome.subconstruct_code` | 399 | 399 @ 16% | — | 15.5% |
| `followUp.value` | 347 | 331 @ 25% | 16 @ 0% | 23.6% |
| `followUp.description` | 337 | 3 @ 0% | 334 @ 24% | 23.9% |
| `outcome.p_value` | 773 | 324 @ 49% | 449 @ 6% | 24.1% |
| `comparison.dropout_total` | 290 | 192 @ 36% | 98 @ 0% | 24.1% |
| `article.outliers_influential` | 216 | 216 @ 29% | — | 28.7% |
| `comparison.practitioner_communication` | 293 | 187 @ 49% | 106 @ 0% | 31.1% |
| `comparison.analyzed_n_experimental` | 293 | 177 @ 53% | 116 @ 0% | 32.1% |
| `comparison.analyzed_n_control` | 291 | 175 @ 54% | 116 @ 0% | 32.3% |
| `baseline.continuous.estimate` | 418 | 412 @ 34% | 6 @ 0% | 34.0% |
| `baseline.continuous.ci_lower` | 417 | 417 @ 35% | — | 34.5% |
| `comparison.control_type_converted` | 295 | 295 @ 36% | — | 35.6% |
| `comparison.frequency_value` | 284 | 177 @ 62% | 107 @ 6% | **40.5%** ← 我引入的退步 |
| `comparison.frequency_desc` | 295 | 48 @ 64% | 247 @ 37% | 41.4% |

**注意严格桶也占大头**：`outcome.subconstruct_code`（16%）、`article.outliers_influential`（29%）、
`comparison.control_type_converted`（36%）、`baseline.continuous.*`（34%）这几列**没有语义判定条目**，
说明它们的分全丢在**编码/数值比对**上，属于"能靠规则和编码表修"的一类。

### 4.5 「多填」25,461 条的解剖（不是"字段取值多"，是**行/组多**）

按 `tools/llm_eval.mjs` 的计法（`extra`），拆成三个作用域（`tools/overfill_breakdown.mjs`）：

| 作用域 | 条数 | 占比 | 实质 |
|---|---|---|---|
| **结局级** | **21,283** | **83.6%** | 多出 **704 个结局行** × 每行 ≈30 字段 |
| **比较组级** | **3,735** | **14.7%** | 多出 **≈53 个比较组** × 每组 ≈70 字段 |
| 文章级 | 443 | 1.7% | 多出金标准**没有的列**：`registrationIds` 222 篇、`doi` 209 篇、命名不一致 12 篇 |
| Sheet2 级 | 0 | 0% | — |

**结局行账**（`tools/_overfill_accounting.mjs`，全 222 篇）：
金标准 **1,110** 行、机器 **1,479** 行、配上 **775** 对 → 多出 **704** 行、漏 **335** 行。

- 多出 704 行里，**至少 369 行是真多抽**（1,479 − 1,110），**至多 335 行是"两边都有但没配上"的镜像**
  （对齐失败会**同时**虚增 extra 和 missed：如 `2023-10` 金标准 54 行 / 机器 42 行，只配上 30 对，
  → 12 行"多出" + 24 行"漏"）。所以 **extra 与 missed 是同一枚硬币**，不能分开看。
- 分布：163/222 篇有多出行，**中位 2 行、p90 7 行、max 24 行**；前 5 篇只占 14% → **普遍存在、长尾**，
  不是几篇病态文章造成的。
- 机器每篇中位 5 行 vs 金标准中位 3 行；45 篇机器行数**少于**金标准（共少 222 行）。

**根因是口径**：机器的 `outcome-plan` 提示词要求"列出这篇论文报告的**全部结局指标**"
（还写了"一篇 RCT 通常 2~6 个"），而金标准是**按系统评价需要**每篇只记 1 个到几个。典型：

```
2017-14  金标准 2 行 / 机器 26 行   → 机器把 13 个结局 × 2 个比较组全抽了
         （live birth / ovulation / conception / pregnancy / pregnancy loss /
           multiple pregnancies / hirsutism / acne / QoL×3 / anxiety / depression）
         金标准每个比较组只记 1 行：live births among all women
2021-12  金标准 2 行 / 机器 22 行   → 机器 11 个结局（含 6 项 incidence + MAP/SpO2/HR）× 2 组
2022-14  金标准 0 行 / 机器 16 行   → 8 个结局 × 2 组（金标准一行没记）
2023-10  金标准 54 行 / 机器 42 行  → 机器行更少却多出 12 行：纯对齐失败
```

**结论**：把"多填"当成抽取错误会误判方向——它主要是**结局粒度/范围的口径差异**，
只有 ~335 行是真正需要修的**行对齐**问题。

### 4.6 多出的 704 行里装的是什么（`tools/overfill_show.mjs`）

| 判据 | 行数 | 占比 |
|---|---|---|
| **带论文实测数值**（时点估计值/CI/例数/事件数、p 值、量程） | **682** | **97%** |
| 只有编码/名称、没有任何实测值（空壳） | 22 | 3% |
| **结局名在本篇金标准里完全没有** → 结局**范围**差异 | **600** | **85%** |
| 结局名与金标准某行同名 → 同一结局**多出的行** | 104 | 15% |

即：**多抽的不是编造、也不是空壳，而是论文里真实报告、但金标准没给它建行的那些结局。**
出现最多的多出结局名：`quality of life` 25×、`pain intensity` 22×、`anxiety` 15×、
`depression` 14×、`pain` 12×、`heart rate` 11×、`lung function` 9× —— 典型的次要结局/量表/生理指标。

**逐行对照样例**

`2021-12`（金标准 **2** 行 / 机器 **22** 行）：

```
金标准 g1  nausea｜VAS    p<0.05  量程 0-10     → 机器 p7
金标准 g2  emesis｜VAS    p<0.05  量程 0-100    → 机器 p18

机器多出的 20 行（每行都带真实数值）：
 ✗ nausea incidence｜NR          p=0.00702   exp.n=50  ctl.n=50
 ✗ emesis incidence｜NR          p=0.0133    exp.n=50  ctl.n=50
 ✗ salivation incidence｜NR      p=0.037     exp.n=50  ctl.n=50
 ✗ cough incidence｜NR                       exp.n=50  ctl.n=50
 ✗ restlessness incidence｜NR    p=0.000348  exp.n=50  ctl.n=50
 ✗ breath holding incidence｜NR  p=0.000348  exp.n=50  ctl.n=50
 ✗ rate of successful first-pass intubation｜NR   exp.events=45/50  ctl.events=36/50
 ✗ mean arterial pressure｜MAP   （基线+结束时两套估计值/CI/例数）
 ✗ blood oxygen saturation｜SpO2 （同上）
 ✗ heart rate｜HR                （同上）
   …以上 11 个结局再按第 2 个比较组复制一遍
```

`2017-14`（金标准 **2** 行 / 机器 **26** 行）：金标准两行**内容完全相同**
（`1.Polycystic Ovary Syndrome｜Live births among all women`），机器是 **13 个结局 × 2 组**：

```
✗ ovulation｜NR           exp.events=221/235  ctl.events=218/236  差值 1.7（95%CI -2.9, …）
✗ conception｜NR          exp.events=108/235  ctl.events=106/236  差值 1.0
✗ pregnancy｜NR           p=0.37  exp.events=74/235  ctl.events=70/236
✗ pregnancy loss｜NR      p=0.51  exp.events=38/108  ctl.events=37/106
✗ multiple pregnancies｜NR p=0.36  exp.events=7/74   ctl.events=6/70
✗ hirsutism｜mFG         量程 0-44  基线 3.0（2.6, …）n=250
✗ acne｜NR               量程 0-5
✗ quality of life ×3（PCOSQ / CQOLI / SF-36）  ✗ anxiety｜SAS  ✗ depression｜SDS
```

→ 这些**全是论文表格里明明白白写着的数据**，机器读对了，只是金标准不记它们。

## 5. 该往哪修（按性价比）
| 优先级 | 事项 | 预期收回 | 依据 |
|---|---|---|---|
| 1 | **回滚"防硬凑"规则**（`contains_correct` 记 1.0 或 0.75） | **+0.6~1.2 个点**（1,234 条） | §3.1 |
| 2 | **`total_sessions_class_b` 补编码表**（先问用户第 3 档语义） | 该列 8.9% → 有望 ≥ 50%（对照 class A 51.5%） | §2.1 |
| 3 | **`analyzed_n_*` 加"无脱落填 0"规则** | ≈ 110 条（gold=0 的 47%） | §2.2 |
| 4 | **结局行对齐改确定性代码** | Sheet3 的 85% 漏 | §4.2 |
| 5 | **严格桶低分列**（`outcome.subconstruct_code` 16%、`article.outliers_influential` 29%、`control_type_converted` 36%、`baseline.continuous.*` 34%）——先查编码表/图例是否进了提示词，这一类是"规则可修" | 合计 1,300+ 字段 | §4.4 |
| 6 | **补上 `2018-06` 那类"少比较组"** | ≈ 434 个字段 | §4.1 |
| 7 | **判分口径**：B 类 97% 是措辞差异，考虑对描述字段用更宽的判定 | B 类 2,846 的绝大部分 | §3 |
| 8 | **单篇材料问题**（`2024-24` 一篇就漏 64 个 p 值相关字段） | ≈ 100+ 条 | §2 |

## 6. 金标准自身的定义疑问（**不要擅自改**，需用户裁定）

| 列（原始表头） | 疑问 |
|---|---|
| `治疗总次数分类`（class B） | 表头第 1 行只写 `1high 2low`，gold 却有 **1/2/3 三档**（79/49/31）——第 3 档语义未知 |
| `留针时间分类` | 表头第 1 行写 `1=手术+非穴位按压 2=慢性病+非穴位按压`，与"治疗总次数治疗分类"是同一张表，**语义明显错位**（`build/legend/_audit.json` 已把该列标为 `not_in_canonical`） |
| `analyzed_n_experimental/_control` | **列名说 analyzed N，内容是脱落人数**（245/301 组满足 `exp+ctl==dropout_total`） |
| `total_sessions_class_a` | gold 里出现过一个脏值 `1 (低频次)` |

### 6.1 ⚠️ `2025-02` 是**两篇论文共用一个编号**（已核实）

`Datas/label/2025-33篇.xlsx` 的 Sheet1 第 4、5 行是**两篇完全不同的论文**，编号都写 `2025-02`：

| Sheet1 行 | 题目 | 期刊 | 干预 vs 对照 |
|---|---|---|---|
| 第 4 行 | Acupuncture as adjunctive therapy for **acute cerebral infarction** | Frontiers in Neurology | manual acupuncture (MA) + standard care vs standard care only |
| 第 5 行 | Acupuncture Therapy on **Dysphagia in Parkinson's Disease** | Chinese Journal of Integrative Medicine | acupuncture (filiform + tongue pricking) + routine treatment vs routine treatment |

后果（**不是机器的错**）：

1. Excel 叫「33 篇」、Sheet2 有 33 行，但**只有 32 个不同编号**、`Datas/articles/2025/` 也只有 **32 个 PDF**
   （`2025-02.pdf` 是**帕金森那篇**）→ **梗死那篇没有 PDF 可抽**，永远拿不到分。
2. gold 把两行**合并**成一条 `2025-02`，而且两个层次取自**不同论文**：
   - `article` 段 = **梗死**那篇（`title`/`journal`/`condition` 都是梗死）
   - `study` 段 = **帕金森**那篇（`primary_outcome=NRS`、`outcome_pain=WHOQOL`）
   - `comparisons` 两条各来自一篇（梗死 1 组 + 帕金森 1 组）
   根因：`tools/gold_normalize.mjs` 里 Sheet1 的文章记录是**先到先得**（`if (!articles.has(...))`，line 340），
   而 Sheet2 的 study 记录是**后到覆盖**（`studies.set(id, rec)` 无守卫，line 393）。
3. 评测按**位置**配对比较组 → 机器唯一那组（帕金森）被拿去和金标准第 1 组（梗死）比，
   整篇的比较组字段几乎全错。这正是之前记为「机器少了比较组」的 `2025-02`（2→1）的真正原因。

**待裁定**：给其中一篇改编号（并让它有 PDF），或把两行拆成两个 article_id。

这四条都属于"金标准定义层"的问题：**修列名/图例比调提示词收益更大**，但按用户口径不擅自动金标准，
所以在此列明待裁定。

## 7. 复现命令

```powershell
node tools/problem_taxonomy.mjs            # 分桶总表（含忽略 C 后的口径）
node tools/problem_breakdown.mjs           # A/B 细分、集中度、结构性问题
node tools/accuracy_overview.mjs --by-year # 权威整体口径（52,975 字段 / 48.9%）
node tools/_field_full_acc.mjs             # 逐字段全口径准确率（严格桶 + 语义判定）
node tools/_verdict_impact.mjs             # 判定分布 + contains_correct 的分值影响
node tools/_classb_analyzed_fix.mjs        # 两个"整列没抽"字段的根因证据
node tools/overfill_breakdown.mjs          # 「多填」按作用域/字段/篇拆解
node tools/_overfill_accounting.mjs        # 结局行账：真多抽 vs 对齐失败
node tools/_overfill_spread.mjs            # 多出行的集中度（中位/p90/前 N 篇占比）
node tools/_overfill_examples.mjs 2017-14 2022-14   # 逐行看某篇"多出行"是什么
node tools/overfill_show.mjs 2021-12               # 金标准行 vs 机器行并排（含实测数值）
node tools/overfill_show.mjs --stat --worst 10     # 全库：多出行里装的是什么
node tools/_cmp_count_impact.mjs           # 比较组数不一致的两个方向
node tools/_overfill_listall.mjs           # "金标准漏填"58 例全列（本次忽略，存档备查）
```

> 注意：`_` 前缀是**一次性诊断脚本**，结论已固化在本文，可随时删除。
