# 第一篇 · 英文摘要 Methods 段

> 依据：`Datas/design/文章计划 整理 202609/02 三篇文章计划.docx` 的「第一篇：基础信息自动化提取」
> （主题 = 基于 Excel 三 Sheet 框架构建 RCT 信息自动化提取模型并验证准确性；
> 核心方法 = 自动化抽取 + 关键环节 3 处人机协同确认 + 准确性/可靠性验证）。
> 参考体裁：Evi-BERT（*algorithm development and validation*）等四篇参考文献。

---

## 英文（Methods，182 words）

This was an algorithm development and validation study. We assembled 224 randomised
controlled trials (RCTs) of acupuncture published between 2015 and 2025 and constructed
a manually curated reference standard in a three-sheet workbook covering (1) article- and
comparison-level characteristics, (2) outcome classification, and (3) outcome-by-time-point
effect estimates. Extracted variables include effect estimates with confidence intervals,
per-arm sample sizes, and intervention and methodological characteristics.

Each PDF is converted into layout-aware text blocks carrying page and bounding-box
coordinates. A chain of task-specific large language model (LLM) prompts then populates the
three-sheet contract, followed by a rule-based audit. Every extracted value must be paired
with a verbatim quotation and its source coordinates; values that fail these grounding
checks are flagged rather than silently accepted.

Human–machine collaboration was embedded at three decision points: confirmation of
patient-relevant outcomes, of disease category, and of effect estimates. Two reviewers
independently assessed each field; disagreements were not resolved automatically but
referred to a third reviewer for arbitration.

Accuracy was evaluated field by field against the reference standard, with partial credit
for semantically equivalent answers and semantic adjudication of free-text fields.

---

## 中文回译（供核对，不进英文稿）

这是算法开发与验证研究。我们收集了 2015–2025 年发表的 224 项针刺随机对照试验（RCT），
并在一份人工整理的**三 Sheet 工作簿**中建立参考标准，覆盖：①文章级与比较组级特征；
②结局分类；③结局 × 时点的效应量。抽取的变量包括**带置信区间的效应量、各组样本量，
以及干预与方法学特征**。

每篇 PDF 被转成**带页码与包围盒坐标的版面感知文本块**。随后由**一串任务专用的大语言模型
（LLM）提示词**填充三 Sheet 契约，并经一步**规则审计**。每一个抽取值都必须配一段**逐字引文
及其来源坐标**；未通过这种"接地"校验的值会被**标记**，而不是被静默接受。

**人机协同嵌入在三个决策点**：患者相关结局确认、疾病类型确认、效应量确认。每个字段由
**两位核对人独立评估**；分歧**不自动裁定**，而是提交**第三方仲裁**。

准确性按字段逐一对照参考标准评估；语义等价的答案给**部分分**，自由文本字段采用**语义判定**
而非逐字匹配。

---

## 写作说明（为什么这么写）

| 决策 | 理由 |
|---|---|
| 首句用 "algorithm development and validation study" | 与参考体裁（Evi-BERT）一致，摘要第一句就交代研究类型 |
| 把「3 处人机协同」单起一段 | 这是第一篇**区别于纯自动化抽取**的核心卖点（02 文件里单列了表格），不能埋在长句里 |
| 明写「必须配逐字引文 + 坐标、不通过就标记」 | 这是方法学上最容易被审稿人问的点（如何防止幻觉），主动交代 |
| 「分歧不自动裁定、提交第三方」 | 与 02 的「2 个确认 + 不一致第三方确认」一致；也是本项目的设计原则 |
| 结尾一句交代评价方式 | 摘要 Methods 通常以"怎么衡量好坏"收尾，为 Results 的一致率做铺垫 |

## ⚠️ 两个数字请确认后再定稿

1. **224**：这是仓库里金标准实际的篇数（11 年合计，分年 6/15/17/12/19/20/23/20/31/29/32）。
   但 02 文件里另一张表写的是「223 篇研究」（那张是 PRECIS-2 的 `06` 表，覆盖 2015-01 → 2025-32）。
   两处差 1 篇，且 `docs/21` 记录过 2025 年「Excel 叫 33 篇、实际只有 32 个不同编号」的问题。
   **投稿前请以最终纳入的篇数为准。**
2. **"published between 2015 and 2025"**：这是语料年份范围。如果最终按「2015-01 至 2025-32 的编号」
   而不是自然年表述，措辞要跟着改。

## 可替换的同义表述（按目标期刊调整）

- 三 Sheet 工作簿也可写成 *a prespecified three-domain extraction framework*（若不想强调 Excel 形式）
- 人机协同也可写成 *human-in-the-loop verification* / *human–AI collaboration*
- 若期刊要求写清模型与版本，需在 "large language model (LLM)" 后补具体模型名与调用时间
  （02 文件未指定模型；本仓库当前用 `deepseek-chat`，可复现记录见 `docs/26`）
