# LLM 接入与 2015 年首轮实测（DeepSeek）

> 目标：把 DeepSeek 接成 `LlmInvoker`，先在 2015 年的 6 篇上跑通并**量化**每个层级的抽取质量，
> 再据此调整。本文记录：怎么跑、测得多少、发现并修掉了什么、下一步该动哪里。

## 1. 怎么跑

```bash
# 1) 配置（密钥只存在本地 runtime/，不进产物、不进日志）
#    runtime/llm.local.json: { apiKey, baseUrl, model, maxOutputTokens... }
#    也可用环境变量：DEEPSEEK_API_KEY / AA_LLM_BASE_URL / AA_LLM_MODEL

pnpm llm:run --year 2015                 # 跑 6 篇（内含 pnpm -r build）
pnpm llm:run --only 2015-01 --skill comparison   # 单篇 / 单 SKILL（调提示词时用）
pnpm llm:run --year 2015 --fresh         # 忽略缓存，强制重新请求
pnpm llm:eval --year 2015                # 对照金标准打分
pnpm fields:coverage                     # 金标准列 × 规范字段清单 的覆盖审计
```

产物：

| 位置 | 内容 |
|---|---|
| `build/extraction/<year>/<id>.json` | 抽取结果（AA_EXTRACTION/1.0） |
| `build/extraction/<year>/_run.json` | 每次运行的耗时 / token / issue 汇总 |
| `build/llm-cache/<key>.json` | **模型原始响应**（含 prompt），请求指纹命中即复用 |
| `build/eval/<year>.json` | 逐字段命中/错/漏/多 的评测报告 |
| `build/coverage.json` | 覆盖审计结果 |

**缓存**：请求指纹 = `tag + system + user + model`。改提示词会自动失效，
同一份材料重复运行不重复付费；缓存里存的是原始响应，因此评测可离线复现。

## 2. 实测（2015 六篇）

第二轮（两个上游规划 SKILL + 逐组/逐结局拆分之后）：

```
6/6 篇成功｜证据违规 0｜error 级 issue 0｜无截断、无 JSON 解析失败
```

| 层级 | 准确率 | 命中 | 错 | 漏 | 多 |
|---|---|---|---|---|---|
| 文章级 | 70.4% | 76 | 32 | 0 | 11 |
| Sheet2 结局分类 | 47.5% | 19 | 21 | 0 | — |
| 比较组级 | **65.1%** | 375 | 195 | **6** | 70 |
| 结局级 | 24.1% | 187 | 207 | 382 | 597 |

逐轮变化（同一批 6 篇）：

| 层级 | 第一轮 | 第二轮 | 第三/四轮 |
|---|---|---|---|
| 文章级 | 70.4% | 70.4% | **75.9%**（补 funding/acknowledgements 材料） |
| Sheet2 | 45.0% | 45.0% | **47.5%** |
| 比较组 | 50.2% → 57.5% | 61.6% | **65.1%**（漏 121 → 53 → 6） |
| 结局 | 17.8% → 18.6% | 22.3% | **24.1%**（行覆盖率 **77%**） |

准确率 = (命中 + 编码命中) / (命中 + 编码命中 + 错 + 漏)；「多」不计入分母，单列以示多抽。

### 2.1 两个上游规划 SKILL 的实际表现

| 文章 | 规划比较组 / 金标准 | 规划结局条数 / 金标准 |
|---|---|---|
| 2015-01 | 1 / 1 ✅ | 10 / 4 ❌ |
| 2015-02 | 1 / 1 ✅ | 5 / 3 ❌ |
| 2015-03 | 1 / 1 ✅ | 4 / 3 ❌ |
| 2015-04 | 2 / 2 ✅ | 5 / 3 ❌（已去重 1 条重复的 FSS） |
| 2015-05 | 3 / 2 ❌ | 2 / 1 ❌ |
| 2015-06 | 2 / 2 ✅ | 4 / 2 ❌ |

比较组数 5/6 与金标准一致。结局条数**系统性偏多**——这是当前最大的单点问题，见 §5。

### 2.2 发表年份：DOI 时间优先（按需求）

实测同一篇论文里三个"年份"互不相同：页脚引文 `Acupunct Med 2016;34:257–266`（卷期年）、
页脚 `Accepted 23 December 2015`、DOI `10.1136/acupmed-2015-010950`，而金标准填 2015。
Crossref 对这篇只有 created 2016-02-15 / issued 2016-08，**没有 2015**——
所以"Crossref 优先"会答 2016，与金标准不符。

最终规则：**DOI 字符串里的年份 > Crossref issued 年 > PDF 正文/页脚年份**。
依据：DOI 的年份是出版商注册时写入、与稿件绑定；Crossref 的 issued 是卷期出版时间，会因在线优先晚一年。
Crossref 在其余元信息（title / journal / first author）上仍按"最高置信度来源"直接覆盖 PDF 值，
且 PDF 原值保留在 `external.comparisons[].pdfValue` 里可复核。

结果：6 篇中 **5 篇年份与金标准一致**。唯一不符的是 2015-05
（DOI `…contraception.2018.11.016`、页脚 © 2018，按规则答 2018，金标准填 2015）——
按需求规则我们的答案是对的，金标准是异常值，已记录在案。

## 3. 修掉的 7 个真实缺陷（每一个都先有症状、再有证据）

| # | 症状 | 根因 | 修法 |
|---|---|---|---|
| 1 | `journal`/`publicationYear`/`doi`/`authorContact` 全部抽成 NR | MinerU 把首页**页眉/页脚/脚注**放进 `discarded_blocks`，而期刊名、卷期年、DOI、通讯作者邮箱恰好全在那里 | `ingest` 保留前 2 页的页眉/页脚（页码丢弃、重复页脚去重）为 `section='metadata'` |
| 2 | Sheet2 七个字段恒为 0% | 字段只在规范清单里，既没进文章级提示词模板，也没进 `FIELD_MAP` → 模型就算返回也被静默丢弃 | 提示词加 Sheet2 段落；`FIELD_MAP` 登记 7 个 `studyOutcomes.*` |
| 3 | 结局层整层丢失（`finish_reason=length`） | 一次调用要输出「N 结局 × 3 时点 × 10 字段」上百个带 quote 的对象，撞上输出上限，截断的 JSON 无法解析 | 结局改**两阶段**：先只列「名称+工具」（响应 ~500 tok），再逐个结局取值；材料放前面以便命中上下文缓存 |
| 4 | 40 次调用里 5 次 JSON 解析失败 | 模型把多行 quote 原样粘进字符串（裸换行），JSON 规范禁止 | `escapeControlCharsInStrings()` 只转义字符串内部的控制字符；解析失败再追加「格式修正」提示重试一次 |
| 5 | 比较组 15 个字段恒为 0%/漏 | 金标准有这些列，规范清单里没有 → 提示词从没要求过 | `tools/field_coverage.mjs` 审计出全部缺口并补齐（含二分类/等级资料的时点字段） |
| 6 | 跨接错位：`randomizedNExperimental` 匹不上 `randomized_n_experimental` | `camelToSnake` 遇到连续大写断不开（→ `randomized_nexperimental`），评测与审计**同时**算错 | 抽成 `tools/lib/keys.mjs` 共用一份实现 |
| 7 | 时点数值字段被静默丢弃 | 模板改成按类型分组（`<时点>.continuous.<字段>`）后，路径映射的键没带类型这一层 | 路径映射统一由 `addTimepointPaths()` 生成，键含类型层 |

另外修掉两个**评测侧**的误判：`auditEvidence` 曾把 `unresolved` 候选（有意 `evidence: []`）算成缺证据；
结局按下标硬对（金标准 4 条 / 流水线 12 条时每字段都判错）改为按「名称+工具」相似度贪心配对。

### 3.1 第七轮：**编码集审计**查出的字段定义缺陷（影响最大的一类）

症状：`missing_data_handling` 9 条错 9、`primary_analysis` 9 条错 7——不是模型乱答，而是**答不出**。

根因：规范清单里这两个字段的取值表**抄漏了**（我最初从批注里只提取到一部分）：

| 字段 | 规范清单原有 | 真实批注 | 后果 |
|---|---|---|---|
| `missingDataHandling` | 5 个（且语义有误：把 3/4 写成 Single/Multiple imputation） | **13 个**（1…13，含 3=Mean imputation、4=LOCF、6=Multiple imputation、12=No missing data、**13=No explicit statement**） | 金标准里出现最多的是 **13（×119）**，流水线永远答不出 |
| `primaryAnalysis` | 3 个 | **4 个**（补 4=No explicit statement） | 金标准有 4（×52），同样答不出 |

修法：
1. 按批注**逐字**补全两张取值表（`tools/canonical-field-map.mjs`）；
2. 给 `tools/field_coverage.mjs` 增加**编码集审计**：把「金标准里实际出现过的 code/raw ⊆ 规范清单的 codes」
   也纳入检查（原来只查字段名，查不出这类"字段在、值域缺"的缺陷）；
3. 审计里把 `a/b` 多选、自由文本（散文）区分开——前者是合法的多选写法，后者多是**金标准列错位**。

效果：`missing_data_handling` 0/9 → **6/9**、`primary_analysis` 2/9 → **7/9**、比较组 64.1% → **65.1%**。
2015 年现在**字段缺口 0、编码缺口 0**。

顺带记录金标准侧的两类问题（不改数据）：

- **列错位**：`deqi` 列里出现 `23 mm (real), <10 mm (sham)`（进针深度）、`stimulation_intensity` 里出现
  `20min`/`30 minutes`（留针时间）、`funding_1` 里出现 `7(×38)`（funding_2 的"未报告"码）——
  这些列的值明显属于别的列，评测时应对这些字段的得分打折看待；
- **写散文而非编码**：如 `blinding_participants` 出现 `2 (CON unblinded; ACU/SHAM blinded)`。

### 3.2 Sheet2 的写法规约（第七轮）

金标准的 Sheet2 结局分类字段是「**量表专有名 + 简短限定**」的索引，不是方法学句子：

```
金: PainVAS 0-100 mm          | 我(改前): change in pain intensity, measured on a visual analogue scale (PainVAS 0–100 mm), at 10 weeks
金: PainVAS (pain intensity)  | 我(改前): change in pain intensity, measured on a visual analogue scale (PainVAS 0–100 mm); chan…
```

已在提示词里写死：只填「工具/量表 + 简短限定」，**不许抄整句、不许带时间点、不许带 `change in` 前缀**，每条 ≤15 词。
Sheet2 45.0% → **47.5%**。

## 3.3 第八轮：语义判定 + 错位金标准排除（按需求）

需求两条：① Sheet2/Sheet3 的金标准是**无法标准化的自然语言结局信息**，不要用严格字符匹配判对错，
改由 LLM 判定「完全一致 / 含义一致 / 包含正确信息 / 存在错误 / 完全不一致」；
② **疑似错位的金标准先不参与评分，并记录下来**。

### 3.3.1 LLM 语义判定（`tools/lib/judge.mjs`）

- 判定类别与权重：完全一致=1、含义一致=1、包含正确信息=0.5、存在错误=0、完全不一致=0、未判定=单列；
- **批量**（默认 8 组/次）把调用数压到 1/8；**结果缓存**在 `build/judge-cache.json`（按 `字段+金标准+抽取` 指纹），
  重复评分不再付费，且缓存跨轮有效（判定与提示词无关）；
- 只对 **Sheet2（`study.*`）与 Sheet3（`outcome.*` 及其时点块）的自然语言字段**启用；
  纯数值/编码/哨兵值仍走严格比较（可判定，不必花判定费）；
- 调用/解析失败 → `unknown`，评分时单列"未判定"，不计入对错。

2015 六篇实测（110 组）：

| 判定 | 组数 | 占比 |
|---|---|---|
| 完全一致 | 9 | 8% |
| 含义一致 | 27 | 25% |
| 包含正确信息 | 11 | 10% |
| 存在错误 | 17 | 15% |
| 完全不一致 | 46 | **42%** |

**加权得分 37.7%**（严格口径下这些字段几乎全判错，语义口径下 33% 属完全/含义一致）。

> 42% "完全不一致"是有用信号：金标准的结局名称/工具写法与模型输出差异很大
> （如金标准 `PainVAS (pain intensity)` vs 抽取 `change in pain intensity, measured on …`），
> 说明这两个字段的**措辞规约**仍需继续对齐，而不是字段抽取本身错了。

### 3.3.2 错位金标准排除（`tools/gold_anomalies.mjs`）

检测四类形态（都是实测看到的，不是猜测）：编码列写成自由文本、编码值超出该列取值表、
数值列写成散文、年份非 4 位数字。产物 `build/gold_anomalies.json`，评分时按
`(articleId, scope, field)` 排除并单独列出。

```
全局 260 处（2015 年 0 处）：
  99  编码超出取值表（允许 1,2）
  68  code列写成了自由文本（疑似列错位）
  40  编码超出取值表（允许 1,2,3）
  22  数值列写成了自由文本（疑似列错位）
  …
按字段：funding_1 52 | stimulation_intensity 46 | needle_retention_class 32 | needle_angle_class 16 …
```

**2015 年恰好没有错位**（这也解释了为什么 2015 的评测一直是可信的）；
其他年份若参与评分，需先跑 `pnpm gold:anomalies`，评测会自动排除并打印被排除的条目。

### 3.3.3 措辞规约（从 `same_meaning` 样本反推，第九轮）

把「含义一致但写法不同」的样本导出（`node tools/judge_report.mjs`，产物 `build/judge-report.md`），
逐条看下来规律高度集中：**8/21 例只差「缩写 vs 全称」这一件事**。据此定下四条写法规约并写进提示词：

| # | 规约 | 依据（金标准实际写法） |
|---|---|---|
| 1 | `instrument` **固定写成 `缩写: 全称` 两段式** | `HDRS: Hamilton Depression Rating hetero-evaluation Scal`、`MBI: Modified Barthel Index;`、`FSS: The Fatigue Severity Scale`、`SSA: standardized swallowing assessment`、`3. BDI, Beck depression inventory;`、`SWAL- QOL: Swallowing-Related Quality of Life` |
| 2 | 分量表把维度写在冒号后 | `SF12:①Physical` → `SF-12: Physical component summary` |
| 3 | **去掉原文序号与前缀**（`1.`/`3.`/`4.`、尾部分号逗号），缩写内不插空格 | `1. swallowing,`、`4. quality of life`、`SWAL- QOL` |
| 4 | `outcomeName` 用**名词短语**（≤6 词）说明"测什么"；不带时间点、不带 `change in` 前缀 | `pain intensity`、`level of depression`、`quality of life`、`fatigue level` |

效果（同一批字段）：

| 指标 | 规约前 | 规约后 |
|---|---|---|
| 完全一致 | 10 组（8%） | **13 组（13%）** |
| 含义一致 | 27（25%） | 26（26%） |
| 存在错误 | 17（15%） | 10（10%） |
| **加权得分** | 38.2% | **41.6%** |

规格化后的 `instrument` 实测形态：`PainVAS: Visual Analogue Scale`、
`HDRS: Hamilton Depression Rating Scale`、`SF-12: Physical component summary`、`FIQ: Fibromyalgia Impact Questionnaire`。

> 注：金标准自身的写法**并不统一**（同一批里既有 `VAS` 这种纯缩写，也有 `HDRS: 全称` 这种两段式），
> 所以两段式只能对齐其中的主导形式；剩余差异属标注风格，不宜继续过度拟合。

### 3.3.4 「存在错误」的根因（第十轮，按用户要求优先排查）

13 组 `has_error` 逐条归类（`pnpm judge:report` 可复现）：

| 根因 | 组数 | 典型 |
|---|---|---|
| **多述或遗漏**（一个分类字段里漏了该类工具、或混入别类指标） | 6 | 金 `Fatigue (FSS, NRS), depression (BDI)` / 我 `FSS; SRI; BDI`（混入 SRI、漏 NRS）；金 `PainVAS (pain intensity)` / 我 `PainVAS 0-100 mm; pain threshold and number of tender points` |
| **分类归属分歧**（金标准填 NR，我们强行归类） | 4 | 金 `NR` / 我 `NRS`、`SF-12 …`、`SSA; DOSS`、`0.01` |
| **漏抽**（金标准有值、我们 NR） | 3 | `measurement_range` 金 `44-220` / 我 NR；`followUp.value/unit` 金 `4` / 我 NR |
| **字段内部不一致**（同一字段自相矛盾） | — | `followUpDescription="13 weeks"` 而 `followUpValue/Unit=NR` |

**已修**：

1. **`followUp` 三件套确定性补全**（`packages/skills/src/outcome.ts` 的 `normalizeFollowUp()`）：
   描述里能解析出「数值 + 单位」而 value/unit 缺失时，就地补全
   （单位按 canonical 映射 1=天/2=月/3=年/4=周/5=小时），并记 `FOLLOWUP_DERIVED_FROM_DESCRIPTION` 审计。
   实测 2015 的 followUp 三件套现在 **23/23 一致**。
2. **Sheet2 六类判据表 + 四条填写规则**（`tools/prompt_gen.mjs`）：
   ① 一个字段列出该类**全部**工具、用 `;` 分隔；② 不混入别类指标；③ 该类没有对应结局时填 `NR`，
   不要强行归类；④ 同一量表只归一个类（SF-12 physical → 功能类）。

效果：**存在错误 13 → 10 组**，加权得分 41.6% → **42.0%**。

### 3.3.5 「含义一致」里同样藏着问题

用户提醒得对——`same_meaning` 有两类，性质完全不同：

- **无害**：我们写得更规范（补全缩写/全称、去掉原文序号），如金 `1. swallowing,` → 我 `swallowing ability`；
- **有害（概念粒度被放大或缩小）**：金 `quality of life` → 我 `health-related quality of life`（放大）；
  金 `Bladder balance (ability to empty bladder with residual <100ml…)` → 我 `residual urine volume`（缩小成子指标）。
  后者与 `has_error` 里的"多述/遗漏"是同一类毛病：**抽取停在了比金标准更细或更粗的层级**。
  提示词已要求"用论文的指标名称、按六类判据归类"，剩余差异需人工按节核对（`build/judge-report.md`）。

### 3.3.6 两个"最差字段"的根因（第十一轮）

**① `measurement_range` 15 组全 0% ——根因不在提示词，在材料。**

先加了一版强制规则（"范围常跟在量表名后，不要因为表格里没写就填 NR"），**仍然全 NR**。
真正原因是：量表的取值范围写在**方法学**里（`measured on a visual analogue scale (PainVAS 0–100 mm)`），
而结局 SKILL 的材料只取 `['results','abstract']` + 表格——**那句话根本不在材料里**。
把 `sections` 改成 `['results','abstract','methods']` 后 → `measurement_range` **0% → 40%**。

> 教训：字段抽不出来时先问"这句话在材料里吗"，再改提示词。

**② 随访时间：金标准值可能**根本不在论文里**。**

对 `follow_up` / `max_followup` 这类"数字+单位"的金标准值做了**取证式审计**
（`tools/gold_vs_paper.mjs`：全文找该"数字+单位"组合，找不到才报告），2015 六篇查 24 个值，得：

| 文章 | 金标准 | 论文里的实际情况 |
|---|---|---|
| 2015-01 | `42 weeks`（结局层与比较组层都写这个） | 全文**没有 42 weeks**；随访时点是 10 weeks(T1) / 6 months(T2) / **12 months(T3)** |
| 2015-04 | `7 weeks` | 论文写的是 **13 weeks** |

42 周 ≈ 9.7 个月，与"12 个月"既非同一位置、也非同一定义——**更根本的是它在论文里不存在**，
所以模型答 `12 months`（正确）反而被判错。这类已按需求**记录并排除评分**：
`build/gold_anomalies.json` 记 33 处（2015），评测输出里会单列"不参与评分"的字段。

**效果**：语义判定口径 **48.2% → 57.0%**（79 组；完全一致 19% + 含义一致 33% + 包含正确信息 10%），
结局层严格口径 24.7% → **31.4%**。

## 3.4 第十二轮：Sheet3 子问题修复 + 事后验证 SKILL

### 3.4.1 Sheet3 的两个子问题

**① 例数 `n` 找错了地方。** 实测 449 个金标准 Sheet3 数值的来源分布
（`pnpm sheet3:sources`）：

| 字段 | 出自表格 | 出自正文 |
|---|---|---|
| `estimate` / `ci_lower` | 83–85% | 13–26% |
| `ci_upper` | 75–88% | 50% |
| **`n`（例数）** | **49–55%** | **86–88%** |

效应量与 CI 高依赖表格，而**例数主要写在正文**（`A total of 164 participants…`、CONSORT 流程描述）。
提示词已明确"表格里没有就到结果段落/流程描述里找"。

**② 时点块"四件套"不完整。** 2015 年 `ci_upper` **命中 0**、随访时点 `n` **命中 0 / 漏 20**——
病因是"只填了一半"。提示词加了四件套要求，`outcome.ts` 加了**确定性校验**：
有 `estimate` 却缺 `n` → `TIMEPOINT_MISSING_N`；CI 只有一半 → `CI_INCOMPLETE`。

效果：`follow_up_end.continuous.n` 命中 0 → 2、`ci_upper` 命中 0 → 2，
Sheet3 漏 355 → 313。

### 3.4.2 事后验证 SKILL：`outcome-audit`（查漏补缺）

按需求"在所有信息都提取完成后，再加一个验证 SKILL 专门检查是否有错和遗漏"实现，
**两段式**（先确定性、后 LLM，最便宜的一批问题不花判定费）：

```
① 确定性核查（0 成本）
   扫已抽取的结局层：没有时点数值 / 有 estimate 缺 n / CI 只填一半
   → 产出「重点核查清单」（2015 实测 48+ 处），既是要补的清单，也是给 LLM 的提示

② LLM 核查（1 次调用/篇）
   输入 = 论文材料（结果+方法+摘要+表格） + 已抽取结果的**紧凑摘要** + 上面的清单
   要求**只报差异**：gaps（漏掉的结局/时点/数值）+ suspects（与原文不符的值），每条必须带逐字 quote
   → quote 经 groundField 定位校验后：
       · 目标位置当前为空 → **就地补上**（provenance='model'，证据来自 quote）
       · 目标已有值 / 定位失败 → **只报告，绝不静默改写**
```

实测（2015 六篇）：

| 文章 | 补漏 | 只报告 | 结构性缺陷 |
|---|---|---|---|
| 2015-01 | 2 | — | 8 |
| 2015-02 | 8 | — | 12 |
| 2015-03 | 10 | — | 14 |
| 2015-04 | **24** | 16 | 48 |
| 2015-05 | 3 | — | 9 |
| 2015-06 | 0 | — | 4 |

补的多是**例数**（如 `baseline.experimentalN = 49`）——正是 §3.4.1 说的"漏在正文里"的那批。

### 3.4.3 三张表的准确率（当前口径）

| 工作表 | 准确率 | 构成 |
|---|---|---|
| Sheet1（文章级 + 比较组） | **66.8%** | 严格 455/681，漏 6，多 81 |
| Sheet2（结局分类） | **75.0%** | 严格 19/19 + 语义 11.0/21 |
| Sheet3（结局 × 时点） | **33.6%** | 严格 214/651 + 语义 35.0/90，漏 313，多 604 |

> 语义判定口径的分母会随"填上的字段变多"而变大（更多字段进入语义比较），
> 因此看趋势时应同时看**漏/错的绝对数**：Sheet3 漏 355 → 313、错 117 → 124。

## 3.5 第十三轮：数值准确率专项（Sheet3 数值类 26.3% → 58.7%）

按需求"**针对数值提取专门设计一个 SKILL**，避免提示词太臃肿影响其他字段"，
这一轮把数值部分从结局层拆出来，并顺带修掉四个真实缺陷。**每一步都只改一处、实测一次**：

| # | 改了什么 | 症状（改前） | 数值类准确率 | Sheet3 整体 |
|---|---|---|---|---|
| 0 | 起点 | — | 26.3%（71/39/160，共 270） | 31.4% |
| 1 | **结局行对齐**（`tools/lib/align.mjs`） | 金标准 `fibromyalgia/VAS` 那行被我们的 FIQ 行抢走 | 28.9% | 34.9% |
| 2 | **表格不再受章节过滤**（`materials.ts`） | 核心结果表被 MinerU 判成 `discussion` 整块滤掉 | 43.9% | 42.2% |
| 3 | **变异值语义**（`ciLower/ciUpper` 是"变异值"不是"CI"） | 62 组 SD 被整块丢掉 | 56.9% | 44.6% |
| 4 | **拆出 `outcome-values` SKILL** | 数值规则与字段图例互相挤占 | 58.7% | 52.5% |
| 5 | **`binary` 块 = 组间效应量容器** | 39 个"两组之差"全漏（当成二分类了） | 66.6% | 55.9% |
| 6 | **媒体保真**（`eTable` 补充表不再被丢） | 2015-02 的结局数据表整张消失 | 71.5% | 54.6% |
| 7 | **逐「结局 × 比较组」取数** | 三臂试验里比较组 2 复制了比较组 1 的值 | **81.2%**（233/47/7，共 287） | **58.3%** |

### 3.5.1 四个缺陷的根因（每个都有可复现的证据）

**① 对齐：金标准那一行的结局名是"自然语言原样抄"**
2015-01 金标准把疼痛 VAS 行的名字写成 `fibromyalgia`、工具写 `VAS`，我们抽的是
`pain intensity` / `PainVAS: Visual Analogue Scale`。分词不切驼峰时 `PainVAS` 是单个 token
`painvas`，与 `vas` 永不相交，于是该行被"名字里有 fibromyalgia"的 FIQ 行以 0.33 分抢走——
**estimate/CI 明明已经抽对（−41.0 / −47.2~−34.8）却整行判错**。
修法：分词切开驼峰与字母数字边界（`PainVAS`→pain+vas、`SF12`→sf+12），
并加"数值佐证"（≥2 个效应量/CI 完全相同才加分）。⚠️ 数值佐证会用到被评分的值本身，
因此每次评测都**单独披露**"靠数值配上的对数"（`report.outcomeAlignment`）。

**② 表格被章节过滤掉：模型根本看不到结果表**
2015-01 的 `Table 2 Evaluation of outcome measures`（全部结局的效应量与 95%CI）
在 MinerU 阅读顺序里排在 `DISCUSSION` 标题**之后**，`section` 成了 `discussion`，
被 `sections:['results','methods','abstract']` 整块滤掉 → SF-12 / HDRS 的疗程结束值只能答 `NR`；
事后审计技能再"核对"一遍，仍然只能说"正文中仅以文字描述方向性结果，未给出具体数值"
（它同样看不到那张表），最后 6 个金标准数值全判漏。
修法：**表格是内容，不受章节过滤**（只排除 references/funding/acknowledgements 这类明显不是内容的章节）。

**③ `ciLower`/`ciUpper` 装的是"变异值"，不是"95%CI"**
金标准里这两个键叫「试验组**变异值**下限/上限」（列名 `ILVARI`/`IUVARI`），
填什么由 `varianceType` 决定：SE/SD/P/QR 是**单值**（只有下限），95%CI/IQR/全距才是**双边界**。
实测 2015 年 94 组带变异值的时点块里 **62 组是 SD 单值**（如 `MBI 52.3 (15.7)` 该填 `ciLower=15.7`），
我们只填了 `estimate`、把括号里的 SD 整个丢掉。
修法：提示词给出"论文写法 → varianceType → ciLower/ciUpper"对照表；
校验改成按类型判定（`SINGLE_VALUE_VARIANCE` / `TWO_BOUND_VARIANCE`），
`ESTIMATE_OUTSIDE_CI` 只在 `varianceType=2` 时才判定（否则 SD 会触发假报警，2015-04 一次误报 10 条）。

**④ 提示词臃肿：数值规则把字段图例挤掉了**
原先一次调用要同时讲"编码图例 + 量表范围/方向/单位 + 取数列规则"，
结果 `measurementRange` / `subconstruct` 这类字段长期低分，数值列规则也没执行到位。

### 3.5.2 拆分方案：`outcome` 与 `outcome-values` 各管一半

```
outcome-plan ──▶ outcome ──▶ outcome-values ──▶ outcome-audit
                 (结局自身字段)   (结局 × 时点数值)    (查漏补缺)
                 3708 字符提示词   3553 字符提示词
```

| SKILL | 负责 | 提示词 |
|---|---|---|
| `outcome` | 名称/工具/编码/范围/方向/单位/类型/基线调整/随访时间 | `outcome` 10567 → **3708** 字符；`outcomeItemTask` 6444 → **2560** |
| `outcome-values` | 三个时点块（效应量/变异值/例数/事件数/等级人数） | `outcomeValue` **3553** + `outcomeValueTask` **5263** |

合并语义（`tools/llm_run.mjs`）：`outcome-values` 只写 `rowIndex` 对应的 `timepoints`，
**不动结局自身字段**；两边各写一半、互不覆盖，任何一边局部重跑都不会把另一边冲掉。
同一结局指标在多个比较组下会各占一行，数值是同一份 → **按 `名称|工具` 去重，只调用一次**，
结果复制到其他行（`dedupedFrom` 记录来源，便于排查"为什么调用数变少了"）。

实测收益（同一年份、同一评测口径）：

| 指标 | 拆分前 | 拆分后 |
|---|---|---|
| 数值类命中 | 157 | **203** |
| 数值类漏 | 74 | **27** |
| `baseline` 数值 | 41.2% | **68.9%** |
| `end_of_treatment` 数值 | 41.1% | **59.7%** |
| `follow_up_end` 数值 | 50.0% | **74.2%** |
| `ci_lower` | 26.5% | **78.7%** |
| `difference_*`（两组之差） | 0% | **61.5%** |
| `binary` 块 | 6.4% | **57.4%** |
| `n` | 32.1% | **46.5%** |
| `continuous` | 51.2% | **68.2%** |
| `outcome` 调用输出 token | 51.9k | **18.9k**（响应更小 = 更不容易被截断） |

### 3.5.3 `binary` 块的真实语义：它是**组间效应量容器**，不是"二分类"

金标准 Sheet3 的时点块分三组容器，但第二组 `binary` 的名字有严重误导性——
它装的**不只是二分类事件数**，而是**一切"两组之间"的效应量**：

| 容器 | 金标准列 | 实际装什么 |
|---|---|---|
| `continuous` | `IESTI/ILVARI/IUVARI/ININTE`、`CESTI/…` | 各组**自己的**估计值与变异值（试验组 / 对照组各一套） |
| `binary` | `DEST/DLVAR/DUVAR` | **两组之差**（mean difference / 率差）及其 95%CI |
| `binary` | `OR/RR/HR` + `CIL/CIU` | 效应量 OR / RR / HR 及其 95%CI |
| `binary` | `INEVE/INUM`、`CNEVE/CNUM` | 事件数 / 例数（真正的"二分类"部分） |
| `categorical` | `RADACLA`、`RDINFRI…RDINSIX`、`RDCOFRI…` | 等级资料的划分方法与各等级人数 |

**实测（2015 六篇）**：13 个非空 `binary` 块**全部**只装了 `DEST/DLVAR/DUVAR`，
而且对象多是**连续型量表**（BDI 抑郁、EQ-5D 生活质量、FSS 疲劳）——原文长这样：

```
Table 2  MMRM analysis of full analysis set (FAS)
Outcome  Group  Baseline        5 weeks                              13 weeks
                Mean (SD)       Mean (SD)   P      LSMD (95% CI)     Mean (SD)   P      LSMD (95% CI)
BDI      A      16.41 (8.36)    9.02 (6.92) 0.252  −1.56 (−3.94, 0.83)  9.63 (6.39) 0.231  −1.68 (−4.16, 0.81)
         B      15.00 (7.67)    8.88 (7.66) 0.052  −2.34 (−4.70, 0.02)  7.89 (7.15) 0.007  −3.25 (−5.71, −0.80)
         C      15.30 (7.05)   13.36 (6.39)        （对照组该格为空）      14.28 (8.54)
```

`LSMD (95% CI)` 这一列 = **最小二乘均数差**，即"该臂 vs 对照组"，金标准把它放在 `binary` 块里。
我们原来的提示词把这一块描述成"事件数/人数型（如有效/无效、发生/未发生）"，
模型于是对"两组之差"整列视而不见 —— **39 个数值一次都没填（0/39）**。

修法（一行提示词改动）：把该块改称「二分类**/组间效应量**」，并写明**任何结局类型**只要报告了
两组之差及 95%CI，就必须填 `binary.differenceEstimate/differenceCiLower/differenceCiUpper`，
**不得**塞进 `experimentalEstimate`/`controlEstimate`（那两格是各组自己的值）。
→ 该块 6.4% → **84.8%**，`difference_*` 0% → **91.7%**。

### 3.5.4 三臂试验：一行表格装两个比较组（第 7 步）

上表里 `Group = A / B / C` 是**三个臂**（body acupuncture / Sa-am acupuncture / usual care），
而金标准 Sheet3 是 **(比较组 × 结局)** 一行 —— 于是同一张表的 A 行与 B 行要分别送给
两个比较组：

| 金标准行 | 比较组 | 应取的行 | EoT 差值 | 随访差值 |
|---|---|---|---|---|
| #1 depression | body acupuncture vs usual care | **A** | −1.56 (−3.94, 0.83) | −1.68 (−4.16, 0.81) |
| #2 depression | sa-am acupuncture vs usual care | **B** | −2.34 (−4.70, 0.02) | −3.25 (−5.71, −0.80) |

我们在数值层曾经按「名称|工具」去重（想省调用："同一结局的数值是同一份"）——
这在多臂试验上是**静默错误**：比较组 2 直接复制了比较组 1 的值
（金标准要 B 行 −2.34，我们给了 A 行 −1.56，两行数字一模一样）。

修法：
1. **逐「结局 × 比较组」行调用**，不再跨比较组去重；
2. 把该行的**干预 vs 对照**写进提示词（`{{COMPARISON}}`），模型才能在多臂表里定位到对应行；
3. 提示词新增多臂规则：表格只写 `A/B/C`，**必须回方法学查字母含义**；
   对照组那一行的差值格是空的、不要取；多张分析表时取**主要分析**（MMRM + FAS），
   不取敏感性分析（ANCOVA）或 per-protocol 表。

→ 数值类 71.5% → **81.2%**，`binary` 57.4% → 84.8%，`difference_*` 61.5% → 91.7%。

### 3.5.5 仍然没解决的两块（下一步）

| 缺口 | 数量 | 现状 |
|---|---|---|
| `n` 错 25 | 25 | 金标准在同篇里**口径不一致**：2015-01 疗程结束取 PP 行的 n（78/81）、随访取 ITT 表头的 n（80/82），两个数原文都有；我们统一取 ITT 表头（80/82），于是疗程结束那格判错。属金标准侧口径问题，已记录 |
| Sheet3「多」725 | — | 结局行粒度是 (比较组 × 结局指标)，我们的行数常多于金标准（金标准 22 行 / 我们 35 行），多出来的进 `extra`（不计入分母，但需人工裁） |

## 3.6 第十四轮：结局枚举与分类编码（Sheet3 64.6% → 72.5%）

按"先完成这两步"的要求做两件事：**① 结局枚举改用论文自己的量表名**、**② 分类编码对齐**。
过程中查出一个比预想严重得多的**自身缺陷**。

### 3.6.1 一个确定性校验误杀了整条结局（2015-02 的 85 个漏）

原以为 2015-02 的问题只是"名称自造"，追下去发现是**校验器误杀**：

```
声明句：Secondary outcomes were QoL, global change, SAR-related medication usage, and adverse events.
模型给的结局名：quality of life
→ OUTCOME_NOT_ANCHORED：名称既没出现在声明句里，anchor 也不落在声明句所在段落 → 整条丢弃
```

`quality of life` 与句子里的缩写 `QoL` 用朴素子串匹配永远对不上（`qol` ≠ `quality`），
于是**该篇唯一的生活质量结局被整条丢掉**——85 个漏（当年全部漏的 91%）全部源于此。

修法两条（都在 `packages/skills/src/outcome-plan.ts`）：

1. **缩写 ↔ 全称匹配**：取名称的**首字母缩写**（`quality of life` → `qol`、
   `health-related quality of life` → `hrqol`），按**词边界**在声明句里找
   （按词边界是必须的，否则 `qol` 会命中 `protocol` 之类的子串）；
2. **补上"anchor 落在声明段落"这条兜底**——错误信息里一直承诺它，
   代码里 `anchorBlock` 却是**死变量**、从未参与判定。

防回归测试见 `packages/skills/src/__tests__/outcome-plan.test.ts`（同时锁住"不能因此放松到什么都收"）。

另外补了提示词规则：`outcomeName` **用论文自己的指标名，不要自造上位词**
（论文写 `Juniper 4 point symptom scores`，就别概括成 `SAR symptom severity`——
后者会让金标准那一行对不上）。

### 3.6.2 分类编码：把"能从自己产出推出来"的编码交给代码

| 字段 | 错例 | 判据/修法 |
|---|---|---|
| `measurementType` | **2015-04 的 BDI 两行填了 `differenceEstimate` 却写 1（估计值）** | 这类"数值 ↔ 编码"自洽性**不该交给模型**：见下 |
| `baselineAdjusted` | 一律填 2（否），金标准多是 1（是）或 3（不清楚） | 提示词改为：做了 ANCOVA/MMRM/回归/协变量调整 → 1；**确实写明未调整** → 2；看不出 → 3 |
| `measurementDirection` | 2015-06 焦虑 VAS 填 1（应为 0） | 症状量表（疼痛/焦虑/恶心…）越小越好=0；功能/生活质量量表越大越好=1 |
| `specialDataFlag` | 等级量表填 1（无法确定数据） | 有序等级量表一律 2 或 3（二分过→3，未二分→2），不要填 1 |
| `subconstruct` | 15 个里 8 个填 13 | 给了"系统 → 编码"对照表（呼吸 8 / 耳鼻喉 9 / 泌尿 6 / 神经 3 / 精神 4 / 肌骨 2…），13 只留给确实归不进任何系统 |
| `construct` | SF-12 填 4（生活质量），金标准 3（功能） | 给了 1/2/3/4 的判别顺序 |

**`measurementType` 改为确定性推导**（`inferMeasurementType` + `applyMeasurementType`，见 `timepoints.ts`）：

```
有等级资料块 → 8；有事件数（binary.experimental.events）→ 3；有组间差值 → 2；否则保持模型的 1
```

三条实测教训写进了实现：

1. **事件数在规范结构里是嵌套的** `binary.experimental.events`（不是 JSON 模板的扁平键
   `experimentalEvents`）——读错键会让事件数永远检测不到，把 2015-06 的膀胱平衡行误判成"没有事件数"；
2. **差值必须带 95%CI 才算**：2015-05 的 `differenceEstimate=31.5` 其实是把**试验组自己的估计值**
   抄进了差值格；据此另加校验 `DIFFERENCE_EQUALS_GROUP_ESTIMATE`；
3. **覆盖必须可回退**：第一版覆盖时没存模型原答案，判据收紧后（见第 2 条）那 3 行被误标的 `2`
   再也退不回来 —— 现在覆盖时把原答案存进 `alternatives`，判据不成立时自动回退。
   已抽取产物可按现有数值重放该规则、无需重新花钱跑流水线：
   `node tools/reapply_consistency.mjs --year 2015`。

### 3.6.3 本轮结果

| 指标 | 本轮前 | 本轮后 |
|---|---|---|
| Sheet3（结局×时点） | 64.6% | **72.5%**（严格 436/594，漏 52，多 655） |
| 2015-02（最弱一篇） | 21.7% | **54.7%**（漏 85 → 42） |
| 2015-01 / 03 / 04 / 05 / 06 | 82.5 / 82.8 / 75.7 / 63.8 / 50.0 | 84.8 / **87.5** / 76.1 / **67.2** / **57.1** |
| Sheet3 数值类 | 81.5% | **81.6%**（命中 248 / 错 46 / 漏 10） |
| 编码类错例合计（7 个字段） | 54 | **39** |

### 3.6.4 2015-02 剩下的 42 个漏属金标准侧"部分选行"

金标准只收录了 RQLQ(S) 的**一个域**（`③sleep domain`）+ RQLQ(S) 总体 + Juniper sneezing score，
而论文按 7 个域逐个报告。我们现在的三行（症状严重度 / RQLQ(S) / global change）已能对上其中两行；
再进一步就得猜"金标准为什么只挑第 ③ 个域"——属过度拟合，不做。
判据始终是那两条硬标准：**值能否在原文找到 + 金标准自身是否自相矛盾**。

## 4. 顺带查出的金标准缺陷（不改数据，只记录）

**列名与批注不符**：Sheet1 里「试验组/对照组」这组表头重复出现 4 次，归一化时按出现顺序命名，
但每列真正的语义写在批注里：

| 金标准键 | 该列批注（真实语义） |
|---|---|
| `sex_experimental` / `sex_control` | 性别（男/女） ✅ 一致 |
| `prior_acupuncture_experimental` / `_control` | **随机例数（治疗前例数）** ❌ 键名不符 |
| `randomized_n_experimental` / `_control` | **主要结局时点样本量** ❌ 键名不符 |
| `analyzed_n_experimental` / `_control` | **脱落人数** ❌ 键名不符 |

处理方式：**键名沿用金标准**（否则评测无法对齐），把批注语义写进规范清单的 `desc` ——
模型按 desc 抽取、评测按同名对齐。彻底修正需同时改金标准与规范清单，属未决事项。

另有两处数据事实（不是缺陷，但影响打分）：
- `publication_year` 用的是**语料年份**而非印刷年份：2015-01 页脚写 `Acupunct Med 2016;34`、
  2015-05 写 `© 2018`，金标准都填 2015。包含页脚后模型会答印刷年份 → 这 2 篇该字段判错。
- 结局行的粒度是 **(比较组 × 结局指标)**：2015-05 金标准 2 行其实是「2 个比较组 × 同 1 个结局」。

## 5. 结局层：口径已按需求收敛为「六类」

**需求（第五轮明确）**：结局只找六类 —— 疼痛类 / 非疼痛症状类 / 功能类 / 生活质量类 /
重要事件类 / 死亡率；**归不进六类的照样记录，交人工判断是否纳入**。

落地方式（`outcome-plan` SKILL）：

| 类别码 | 类别 | 归宿 |
|---|---|---|
| 1 | 疼痛类 | `outcomes` → 逐条自动抽数值 |
| 2 | 非疼痛症状类结局 | 同上 |
| 3 | 功能类结局 | 同上 |
| 4 | 生活质量类结局 | 同上 |
| 5 | 重要事件类结局 | 同上 |
| 6 | 死亡率 | 同上 |
| 0 / 空 | 归不进六类（合并用药、就诊次数、成本、依从性…） | **`otherOutcomes`**：记录名称/工具/出处，**不自动抽数值**，交人工判断 |

- 每条结局都要给出 `outcomeClass`；模型把候选分成 `outcomes` 与 `otherOutcomes` 两处输出；
- 资源使用类（合并用药/就诊次数/成本/依从性）即使被强行归了类也不进六类；
- 另有两道仍然生效的守门规则：**锚定校验**（必须能对上 primary/secondary 声明句）
  与**句级排除**（`Subsequent outcomes measured were…`、回归模型句等不算声明）。

实测（2015 六篇）：六类条数 7 / 2 / 4 / 5 / 2 / 3，另有 2 / 2 / 0 / 1 / 1 / 1 条进 `otherOutcomes`。
2015-01 的七条类别为 `1,2,4,4,3,1,2`（疼痛×2、非疼痛×2、功能、生活质量×2）——
其中 FIQ / 压痛阈 / 压痛点按需求属"功能/疼痛/非疼痛"类，**保留是符合口径的**
（金标准当时没收它们，属标注取舍差异，已记录）。

### 5.1 金标准取舍的不可判定性（已查明，不再反推）

论文自己那句 `Secondary outcomes included …` 是 **549 字符长句**，按分号列了 7 个指标，
金标准只收其中 3 个 + primary 的疼痛 VAS。**同一句声明里收哪些不收哪些没有文本依据**
（FIQ 是患者重要结局却被排除；合并用药写在声明句里也被排除）。
因此改用「六类」这一可执行口径，并**并行报告覆盖率**：
金标准结局行覆盖率 **17/22 = 77%**（2015-04 6/6、2015-05 2/2、2015-01 3/4、2015-03 2/3、
2015-06 2/4、2015-02 0/3）。多抽的可人工裁掉，漏抽的才是硬伤。

### 5.2 金标准侧的两处事实（已核实，非流水线缺陷）

- 2015-06 的金标准结局行混进了**另一篇论文**的结局（`EN016-xxx` 属避孕针刺那篇），覆盖率天然只能 2/4；
- 2015-02 金标准用 `RQLQ / RQLQ(S) / Juniper sneezing score`，提示词已要求**必须填量表专有名**
  （这条把覆盖率从 68% 提到 73%）。

### 5.3 前几轮修的两个"定位"缺陷（影响所有层级）

| 症状 | 根因 | 修法 |
|---|---|---|
| 结局名称/工具大量"quote 无法在文档中定位"→ 整片字段丢 | PDF 跨行断词：MinerU 还原成 `depres-\nsion`，模型给的是拼好的 `depression` | `locateEvidence` 增加第三级匹配：**去连字符 + 去标点**后比对（≥8 字符，避免短串误命中） |
| 文本明明逐字（如 `HDRS,28`）却定位失败 | MinerU 内联标记 `<sup>28</sup>`；模型"逐字引用"时把标记去掉了 → `thehdrsup28supat10weeks` ≠ `thehdrs28at10weeks` | 宽容匹配前先 `untag()` 去内联标签 |

这两个修完，2015-01 的规划条目从"6 条因定位失败被丢弃"变成全部落地。

## 6. SKILL 分层结构（当前）

```
  study-plan    「几个组、各组定位、几个比较组、谁 vs 谁」   材料：摘要+方法学（无表格）
  outcome-plan  「论文自己声明了哪些结局指标」每条带声明句锚  材料：摘要+方法学（无表格）
        │
        ├─ article-meta   文章级 20+ 字段；Crossref 覆盖 title/journal/作者；
        │                 发表年份 = DOI 年份 > Crossref issued > PDF 文本
        ├─ comparison     逐**比较组**抽取（每组一次调用，次数由 study-plan 决定）
        │                 材料：方法学+结果+表格
        ├─ outcome        逐**结局**抽「结局自身字段」（名称/编码/范围/方向/单位/类型/随访时间）
        │                 清单由 outcome-plan 决定；材料：结果+表格
        ├─ outcome-values 逐**结局**抽「结局 × 时点数值」（效应量/变异值/例数/事件数）
        │                 按「名称|工具」去重后一次调用；只写 timepoints，不动结局字段
        └─ outcome-audit  查漏补缺（确定性清单 + 1 次 LLM 核查），只填空位、绝不覆盖
                          最后由 llm_run 按比较组数扇出成多行
```

设计原则（实测得来）：
- **结构判断与细节抽取分开**：一次调用既数条数又填字段，必然数错或填漏。
- **两套长规则不共处一次调用**（第十三轮）：数值取列规则与字段图例都很长，合在一起会互相挤占
  ——拆成 `outcome` + `outcome-values` 后，数值类命中 157 → 179（见 §3.5）。
- **材料按阶段裁剪**：枚举/规划阶段只看摘+方法（不含表格）——表格会把模型引去数行，
  实测导致结局条数翻两三倍。但**表格本身不受章节过滤**（见 §3.5.1②）。
- **单次响应要小**：一个响应里的"带 quote 对象"超过 ~100 个就会撞输出上限并整层丢失
  （结局层与比较组层都栽过），因此按组/按结局拆分调用。
- **材料在前、任务在后**：同一篇的多次调用共享前缀，命中服务端上下文缓存（省时省钱）。

## 7. 与其它组件的衔接

- **前端**：`/api/fields` 现在读 `build/gold/<year>.json`。接流水线只需把数据源换成
  `build/extraction/<year>/<id>.json`（字段路径已与契约对齐：`comparisons.<i>.<k>`、
  `outcomes.<i>.timepoints.<tp>.continuous.<k>`），人工框选与覆盖层逻辑不用改。
- **Crossref**：`article-meta` 里已接线，本轮 6 篇全部返回 `CROSSREF_ERROR: HTTP 400`——
  待查（`resolveAndVerify` 的请求参数或 mailto 被 Crossref 拒绝），当前会降级为「未校验」，不影响其它字段。
- **密钥**：只从 `runtime/llm.local.json` / 环境变量读取；错误信息与观测回调都经过
  `redact()`（实测有网关会在报错时原样回显 Authorization，直接拼进日志就泄露了）。

## 7. 测试与可复现

```
pnpm check        205 测试 / 11 文件通过，5 个 typecheck 目标全绿
pnpm fields:coverage  11 个年份的金标准列 100% 被规范清单覆盖（未覆盖 0）
pnpm llm:eval --year 2015  逐字段报告 → build/eval/2015.json
```

离线测试覆盖了本轮所有修复点：裸换行 JSON、格式修正重试、密钥屏蔽、页眉页脚保留与去重、
两阶段结局调用与单条失败隔离、路径映射的类型层、模板键与映射表同步（防静默丢弃）。
