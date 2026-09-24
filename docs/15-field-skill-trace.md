# Sheet1 低准确率描述字段 → 归属 SKILL 与提示词溯源

> 问题：Sheet1 里准确率较低的那些**描述性字段**，分别由哪个 SKILL 抽？对应的提示词是哪一段？
> 本文给出可复现的溯源结果（工具：`tools/field_prompt_trace.mjs`），并更正一版**错判的清单**。

## 0. ⚠️ 先更正一版错判的清单

早先口头给出的"**12 个准确率 <35% 的描述字段**"（治疗总次数分类 8.9%、脱落总人数 23.5%、
试验组(CG) 30.1%、对照组(CH) 31.4% …）**是错的**，来自 `tools/sheet1_fields.mjs` 的两个缺陷：

1. **漏掉了全部语义判定字段**：`tools/llm_eval.mjs` 把走语义判定的字段记成 `judged.<scope>.<field>`
   （如 `judged.comparison.frequency_desc`），而工具只认 `/^(article|comparison)\./`，
   于是**所有真正的描述性字段被整批过滤掉**（实测每年漏 49 个键）；
2. **把数值字段错判成描述类**：判据用了"有没有被判过语义"，但 `shouldJudge()` 在**任一侧不是数值/编码**
   时就触发——`analyzed_n_experimental`（金标准 `88`）在机器答 `NR` 时也会走语义判定。
   结果 `analyzed_n_experimental`、`randomized_n`、`dropout_total` 这些**数值字段**被算进了"描述类最低分"。

已修（`tools/sheet1_fields.mjs`）：
- 两个前缀都收（`judged.` 与裸前缀），同一字段的两路统计合并；
- 字段类型**从金标准数据本身判**：扫全库金标准，统计每字段非空取值里"纯数值写法"的占比，
  ≥90% 且样本 ≥3 才是数值类；有取值表的直接算编码类。文章级还要**同时扫 `a.article` 与 `a.study`**
  （metadata 在 `a.article`，只扫 `a.study` 会让 `publication_year` 落回名字启发式并被错判成描述类）。

修正后的 Sheet1 全貌（**加权口径**：`identical`/`same_meaning`=1、`contains_correct`=**0.5**，见 `tools/lib/judge.mjs`）：

| 类别 | 字段数 | 占比 | 准确率 | 占总失分 |
|---|---|---|---|---|
| 编码类 | 11,466 | 50% | 63.7% | 51% |
| **描述类** | **5,079** | 22% | **66.7%** | 16% |
| 数值类 | 6,537 | 28% | 59.1% | 32% |
| 合计 | 23,082 | — | **63.1%** | — |

**结论翻转**：描述类是 Sheet1 **表现最好**的一类（66.7%），最差的是数值类与编码类。
之前"描述部分是主要短板"的印象，是"描述字段被整批漏统计"造成的。

> ⚠️ 还有两个**口径坑**在这里一并修掉了（都会让数字虚高或错位）：
> 1. `sheet1_fields.mjs` 把语义判定的"半分"（`contains_correct`）**当满分**算。
>    实测这让 `author_contact` 从 45.9% 被抬到 46.4%，`intervention` 从 **92.4%** 被压到 76.5%
>    （它有 110 条半分，权重搞错时排序完全乱）。现已改为 0.5 权重，与 `llm_eval` 的
>    `VERDICT_WEIGHT` 对齐。
> 2. `llm_eval.mjs` 用**二分法**分语义判定结果
>    （`judgedOutcome = !startsWith('study.')`），把 `article.*` / `comparison.*` 的语义条目
>    **并进了 Sheet3**——实测 2015 年 Sheet3 的 224 条语义条目里 **158 条（70%）本属 Sheet1**。
>    后果是双重的：Sheet3 被污染，而 Sheet1 的 `judged` 是空数组、只剩严格可比字段。
>    已改为三分（`study.` / `article.|comparison.` / 其余），2015 复算：
>    Sheet1 `den 523→681、rate 79.5%→73.7%`，Sheet3 `den 836→678、rate 68.8%→71.4%`。

## 1. 修正后的清单：描述类准确率最低的 12 个字段

命令：`node tools/sheet1_fields.mjs --kind 描述类 --top 12`

| # | 原始表格列名 | 提取用字段名 | 满分/半/错/漏 | 正确率 | 归属 SKILL |
|---|---|---|---|---|---|
| 1 | 作者联系方式（第 N 列） | `article.author_contact` | 77/26/119/0 | **45.9%** | **article-meta** |
| 2 | 最长随访时间（第 BQ 列） | `comparison.max_followup_desc` | 119/28/142/2 | **50.6%** | **comparison** |
| 3 | 试验组（第 BT 列） | `comparison.sex_experimental` | 155/0/129/10 | **52.7%** | **comparison** |
| 4 | 对照组（第 BU 列） | `comparison.sex_control` | 156/0/126/12 | **53.1%** | **comparison** |
| 5 | 留针时间（单位：分钟, min）（第 BH 列） | `comparison.needle_retention_desc` | 180/14/100/0 | **66.8%** | **comparison** |
| 6 | 疗程（单位：天）（第 AX 列） | `comparison.course_desc` | 170/24/100/0 | **67.4%** | **comparison** |
| 7 | 治疗频次描述（标明单位）（第 AT 列） | `comparison.frequency_desc` | 63/122/108/1 | **72.1%** | **comparison** |
| 8 | 进针深度（单位：毫米, mm）（第 BE 列） | `comparison.insertion_depth_text` | 183/32/77/2 | **76.0%** | **comparison** |
| 9 | 对照组名称（第 Y 列） | `comparison.control` | 154/66/74/0 | **82.0%** | **comparison** |
| 10 | 患者期望值（第 AJ 列） | `comparison.patient_expectation` | 238/3/52/1 | **82.3%** | **comparison** |
| 11 | 期刊名称（第 J 列） | `article.journal` | 198/3/21/0 | **91.1%** | **article-meta** |
| 12 | 干预方法名称（第 X 列） | `comparison.intervention` | 115/110/68/1 | **92.4%** | **comparison** |

**归属很干净：12 个里 10 个由 `comparison` SKILL 抽（比较组级），2 个由 `article-meta` SKILL 抽（文章级）。**

> `comparison.intervention` / `comparison.control` 在 `packages/skills/src/outcome-values.ts` 里也出现，
> 但那是**当输入用**（拼"试验组 VS 对照组"的提示语），不是它抽取的。

## 2. 对应的提示词（原文照录）

提示词由 `tools/prompt_gen.mjs` 生成：字段清单来自 `tools/canonical-field-map.mjs`
（原始表格列名 + 批注 + 填写要求），运行时材料前置、任务后置。

### 2.1 `comparison` SKILL → `build/prompts/comparison.md`

12 个字段里有 11 个在这里，全部落在 **`## 字段定义与填写要求 › #### 需要你抽取的字段`** 一节。

| 提示词行号 | 字段块原文 |
|---|---|
| 77 | `- **intervention（干预方法名称）**：试验组接受的干预（照抄原文，如 acupuncture+usual pharmacological treatment）。` |
| 78 | `- **control（对照组名称）**：对照组接受的干预（照抄原文）。` |
| 88 | `- **randomizationMethod（随机序列产生方法）**：随机序列产生的具体方法原文描述；未报告填 NR。`<br>`  - 依据：单元格批注 AC2` |
| 93 | `- **allocationConcealment（分配隐藏方法）**：分配隐藏的具体方法原文；未报告填 NR。`<br>`  - 依据：单元格批注 AE2` |
| 107 | `- **patientExpectation（患者期望值）**：文中报告的患者期望值（数值或相关描述）；未报告填 NR。`<br>`  - 依据：单元格批注 AJ2` |
| 135 | `- **frequencyDesc（治疗频次描述（标明单位））**：治疗频次的原文描述，如 one per week。未报告填 NR。`<br>`  - 依据：单元格批注 AT2` |
| 145 | `- **courseDesc（疗程）**：疗程原文描述，如 9 weeks。未报告填 NR。`<br>`  - 依据：单元格批注 AX2` |
| 157 | `- **insertionDepthText（进针深度）**：进针深度的原文描述；未报告填 NR；不适用（穴位按压/TEAS/激光针）填 NA。`<br>`  - 依据：单元格批注 BE2` |
| 166 | `- **needleRetentionDesc（留针时间）**：留针时间数值（分钟）。未报告填 NR。`<br>`  - 依据：单元格批注 BH2` |
| 186 | `- **maxFollowupDesc（最长随访时间）**：最长随访时间原文描述；未报告填 NR。`<br>`  - 依据：单元格批注 BQ2` |
| 220 | `- **sexExperimental（试验组性别（男/女））**：试验组的性别分布，按「男/女」填写（如 0/80）。不分组报告时填在试验组一列、对照组填 NA；未报告填 NR。` |
| 221 | `- **sexControl（对照组性别（男/女））**：对照组的性别分布，按「男/女」填写。` |

**统一格式的硬要求**（`## 两组的写法`，第 11–28 行）——直接决定 `intervention` / `control` 的成败：

```
`intervention` / `control` 填 **`干预+合并治疗`** 形式，四条硬要求：
1. **用 `+` 连接**（不要写 plus / combined with / and）；
2. **全小写**；
3. 干预用**通用术语**，不要论文自造的组名或修饰语：
   `acupuncture`（不要 individualised acupuncture / real acupuncture / IA / RA）、
   `electroacupuncture`（不要 EA）、`body acupuncture`、`ear acupuncture`、
   `sa-am acupuncture`、`sham acupuncture`；
4. 合并治疗照抄论文用词（`usual care` / `usual pharmacological treatment` / `swallowing training` /
   `CIC treatment` 等）；没有合并治疗就只写干预本身（如 `acupuncture`）。

示例（左=正确，右=常见错误）：
- ✅ `acupuncture+usual pharmacological treatment` ❌ `individualised acupuncture (IA) based on TCM diagnosis`
- ✅ `electroacupuncture+CIC treatment` ❌ `EA combined with CIC treatment`
- ✅ `ear acupuncture+usual care` ❌ `auricular acupuncture plus usual care`
- ✅ `acupuncture` ❌ `real acupuncture (RA)`
```

**与该清单直接相关的"常见错误"**（第 640–646 行）：

```
- ❌ 把所有比较组的字段合并到一起——必须**逐比较组**输出。
- ❌ 把「试验组干预」和「对照组干预」填成同一个值。
- ❌ 用论文里的组别缩写（IA/SA 等）代替完整干预描述。
- ❌ 选穴方案/针刺类型等编码字段填中文含义而不填编码。
- ❌ 进针深度、留针时间等不适用于电针/激光针/穴位按压时，应填 NA 而不是 NR。
- ❌ 表格里明明有各组例数/性别分布，却填 NR。
```

### 2.2 `article-meta` SKILL → `build/prompts/article.md`

| 提示词行号 | 字段块原文 |
|---|---|
| 28 | `- **authorContact（作者联系方式）**：按优先顺序取一位作者的邮箱：1) 通讯作者 2) 第一作者 3) 未报告填 NR。`<br>`  - 依据：单元格批注 N2` |
| 40 | `- **condition（疾病名称）**：标题或纳入标准中的疾病名称，照抄原文。`<br>`  - 依据：单元格批注 R2` |

`author_contact` 是 Sheet1 描述类**最低分**（46.4%），它的主要来源写在 `## 特别注意：首页页眉/页脚/脚注`（第 297–305 行）：

```
论文首页的**页眉、页脚、脚注**（材料中标记为 `text/metadata` 的块）是若干字段的**主要来源**，务必查阅：

- 引文行（如 `To cite: … Acupunct Med 2016;34:257–266.` 或页脚 `Vas J, et al. … doi:10.1136/…`）
  → `journal`（期刊缩写需还原为期刊全名）、`publicationYear`、`doi`
- 卷期/版权行（如 `Trials (2015) 16:314`、`© 2015 …`）→ `publicationYear`、`journal`
- 脚注里的通讯作者与单位 → `authorContact`（邮箱）、`country`（单位所在国家）
- `Accepted …` / `Published Online First …` 这类日期**不是**发表年份；若与卷期年份冲突，以**卷期/版权行的年份**为准。
```

对应材料侧的实现：`packages/ingest/src/ingest.ts` 把**前 2 页**的 `discarded_blocks`
（页眉/页脚/脚注）保留为 `section='metadata'` 的块，正是为了这几个字段。

## 3. 这些字段为什么低分（与已有诊断对应）

| 现象 | 证据 |
|---|---|
| **答案就在该 SKILL 自己的材料里**（不是没喂） | `materials_coverage`：45% 的 NR 描述字段，答案就在自己的材料里；真漏喂只有 4% |
| **短值定位不了**（`once`、`30 min`、`0/80`） | `short:values`：值太短无法用特征词定位占 41%；文字型 145 组里 43 组只在正文、89 组连字面都查不到（写法归一问题） |
| **判分口径偏严**（同一句不同窗口被判错） | `desc_field_judge`：3,480 组失配里 24% 是一方包含另一方、9% 高度相似；`intervention` 47%、`condition` 69% 属"包含" |
| **多臂试验的比较组编号错位** | `docs/11` §1：比较组编号一错，整组字段连带错；提示词第 38–49 行专门写了口径 |

即：这批字段的瓶颈是**"材料里有、模型没稳定写出来"** + **"写法自由度大、判分口径偏严"**，
不是材料覆盖，也不是缺 SKILL 步骤（见 `docs/14-prompt-vs-skill.md` 的裁定）。

## 4. 复现命令

```powershell
node tools/sheet1_fields.mjs                          # 全量：三类分项 + 失分 Top20
node tools/sheet1_fields.mjs --kind 描述类 --top 12   # 描述类最低分字段
node tools/field_prompt_trace.mjs                     # 上面那 12 个字段 → SKILL / 提示词行号 / 原文
node tools/field_prompt_trace.mjs --full              # 字段块不截断
node tools/field_prompt_trace.mjs --fields comparison.frequency_desc,article.author_contact
```
