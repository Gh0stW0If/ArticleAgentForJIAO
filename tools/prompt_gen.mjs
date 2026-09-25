#!/usr/bin/env node
/**
 * tools/prompt_gen.mjs — 从规范字段清单生成各层级的 LLM 提示词
 *
 * 输入：tools/canonical-field-map.mjs（唯一真源，字段含义/要求/编码）
 * 输出：
 *   - build/prompts/<level>.md      —— 可直接人工审阅的提示词全文
 *   - packages/skills/src/prompts.generated.ts —— 供 SKILL 使用
 *
 * ===== 提示词必须包含什么（按需求）=====
 *   1. **每个 JSON 字段的含义**（desc）
 *   2. **填写要求**（requirement，来自单元格批注）
 *   3. **允许的取值/编码表**（codes）
 *   4. **JSON 模板**（可直接照抄的结构）
 *   5. 输出格式约束（只输出 JSON、必须带 quote、找不到就写 NR 等）
 *
 * 调用：node tools/prompt_gen.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import {
  ARTICLE_FIELDS, COMPARISON_FIELDS, STUDY_OUTCOME_FIELDS,
  OUTCOME_TOP_FIELDS, TIMEPOINT_FIELDS,
} from './canonical-field-map.mjs';

const ROOT = resolve(process.cwd());
const OUT_MD = join(ROOT, 'build', 'prompts');
const OUT_TS = join(ROOT, 'packages', 'skills', 'src', 'prompts.generated.ts');
mkdirSync(OUT_MD, { recursive: true });
mkdirSync(join(ROOT, 'packages', 'skills', 'src'), { recursive: true });

/* ---------------------------- 通用构件 ---------------------------- */

/** 哨兵值约定（写进提示词，统一所有层级的缺失表达）。 */
const SENTINELS = [
  ['NR', '文中未报告（not reported）'],
  ['NA', '不适用（not applicable），例如给 TEAS/激光针/穴位按压填进针深度'],
  ['NE', '文中提到该指标但无法确定数值'],
];

const SENTINEL_BLOCK = SENTINELS.map(([k, v]) => `  - \`"${k}"\` = ${v}`).join('\n');

/** 渲染单个字段的说明块。 */
function renderField(f, indent = '') {
  const lines = [];
  const title = f.label && f.label !== f.key ? `${f.key}（${f.label}）` : f.key;
  lines.push(`${indent}- **${title}**：${f.desc ?? '（未填写说明）'}`);
  if (f.comment) lines.push(`${indent}  - 依据：单元格批注 ${f.comment}`);
  if (f.requirement) lines.push(`${indent}  - ⚠️ 填写要求：${f.requirement}`);
  if (f.codes) {
    const opts = Object.entries(f.codes).map(([c, m]) => `\`${c}\`=${String(m).replace(/\n+/g, ' ')}`).join('；');
    lines.push(`${indent}  - 允许取值（**必须填编码**）：${opts}`);
  }
  if (f.source === 'gold_meta') {
    lines.push(`${indent}  - ❗ 本字段不由你推断，请**不要输出**该键（由数据集/流程填写）`);
  }
  return lines.join('\n');
}

/** 渲染字段清单（按是否要 LLM 抽取分组）。 */
function renderFields(fields) {
  const llm = fields.filter((f) => f.source !== 'gold_meta');
  const meta = fields.filter((f) => f.source === 'gold_meta');
  const out = [];
  out.push('#### 需要你抽取的字段');
  out.push('');
  for (const f of llm) out.push(renderField(f));
  if (meta.length) {
    out.push('');
    out.push('#### 不需要你输出的字段（由流程填写）');
    out.push('');
    for (const f of meta) out.push(`- ~~${f.key}（${f.label}）~~：${f.desc}`);
  }
  return out.join('\n');
}

/** 生成 JSON 模板：每个字段都是 { value, quote, confidence }。 */
function jsonTemplate(fields, opts = {}) {
  const llm = fields.filter((f) => f.source !== 'gold_meta');
  const obj = {};
  for (const f of llm) {
    const hint = f.codes ? `可选值：${Object.keys(f.codes).join('/')}` : '原文或 NR/NA';
    obj[f.key] = { value: `<${hint}>`, quote: '<逐字原文片段>', confidence: 0.95 };
  }
  if (opts.extraHeader) {
    return `${opts.extraHeader}\n${JSON.stringify(obj, null, 2)}`;
  }
  return JSON.stringify(obj, null, 2);
}

/* ---------------------------- 输出格式约束 ---------------------------- */

const OUTPUT_RULES = `## 输出格式（必须严格遵守）

1. **只输出一个 JSON 对象**，不要输出任何解释、前言、Markdown 代码块标记或多余文字。
2. 每个字段的值必须是这样的对象：
   \`\`\`json
   { "value": "<归一化后的值>", "quote": "<逐字来源于材料的原文片段>", "confidence": 0.0-1.0 }
   \`\`\`
3. \`quote\` 必须是**逐字复制**自所给材料的片段（不得改写、翻译、缩写或补全）。
   系统会用它在原文中定位坐标；定位失败的字段会被直接丢弃。
4. \`value\` 填归一化后的结果：
   - 若该字段有「允许取值」，**必须填编码**（如 \`"1"\`），不要填中文含义；
   - 多选时用斜杠连接（如 \`"2/5"\`）；
   - 数值字段填数值本身（如 \`"9"\`、\`"-41"\`）；
   - 描述性字段照抄原文。
4b. **数值归一化口径**：**只改 \`value\`，\`quote\` 一律保留原文**——这两件事不要混。
   - **只填纯数字**：不要带单位、百分号、千分位或空格
     （\`1,234.5\` → \`1234.5\`；\`73.5 %\` → \`73.5\`；\`30 min\` → \`30\`；\`12 周\` → \`12\`）。
   - **复合写法必须拆开**：\`41.75 ± 11.15\` 是"均值 41.75、离散度 11.15"——
     均值字段填 \`41.75\`、离散度字段填 \`11.15\`，**不要把 \`± 11.15\` 一起塞进均值**。
     同理 \`16.41 (8.36)\` = 均值 16.41 / SD 8.36；\`-1.56 (−3.94, 0.83)\` = 差值 −1.56 / 95%CI −3.94~0.83。
   - **补齐前导零**：\`.809\` → \`0.809\`；\`.5\` → \`0.5\`。
   - **统一负号**：\`−41.2\`（U+2212 减号）、\`–41\`、\`—41\` 一律写成 ASCII 的 \`-41.2\`。
   - **全角转半角**：\`１２３\` → \`123\`、\`１.５\` → \`1.5\`。
   - **边界符号不进数字**：\`<0.001\` 的数值填 \`0.001\`（"小于"这件事交给对应的范围/类型字段）；
     \`0.05*\` 的数值填 \`0.05\`（\`*\` 是脚注标记，不是数字的一部分）。
   - **单位不换算**：数值按原文的量纲照填，单位填进该层级的 \`*Unit\` 字段（编码按「允许取值」）。
     例如原文 \`30 min\` → value 填 \`30\`、unit 填"分钟"对应的编码。
     **不要**自己把 min↔h、cm↔mm、天↔周换算——金标准按原文口径记录，换算了反而不一致。
   - \`quote\` **必须逐字复制材料原文**，不得把归一化后的写法当成原文引用：
     - ❌ 材料是 \`41.75 ± 11.15\`，quote 却写 \`"41.75"\`（截断）或 \`"mean 41.75, sd 11.15"\`（自己拼的）；
     - ✅ quote 写 \`"41.75 ± 11.15"\`——**在材料里连续存在**的原样片段。
   - \`quote\` 长度**不少于 6 个字符**且必须能整串命中材料；命中不了的字段会被系统直接丢弃。
5. **不要猜测**。材料中没有的信息，\`value\` 填哨兵值，并在 \`quote\` 里给出能证明"未报告"的原文片段：
${SENTINEL_BLOCK}
6. 只依据所给材料作答。**不得使用你对这篇论文的既有记忆**——即使你认得这篇文献，
   也必须以材料中的文字为准。
7. \`confidence\` 反映你的把握：原文明确写出=0.9~1.0；需要推断=0.5~0.8；把握不大=<0.5。
8. 若某字段确实无法定位到任何材料，**省略该键**，不要编造 quote。`;

const COMMON_PREAMBLE = `你是一名循证医学系统评价的数据抽取员，正在为一项针刺治疗随机对照试验（RCT）的系统评价做数据提取。

你的输出会被程序解析并逐字段核对，因此**格式与证据比速度重要**。`;

/* ---------------------------- 各层级提示词 ---------------------------- */

function articlePrompt() {
  return `${COMMON_PREAMBLE}

## 任务
从所给材料（论文首页、摘要、作者信息、方法学片段）中抽取**文章级元信息**。

## 材料说明
材料按块给出，每块带锚点 \`[[b<块号>|p<页号>]]\`。你可以在 quote 中直接引用原文（不必包含锚点）。

## 字段定义与填写要求

${renderFields(ARTICLE_FIELDS)}

### Sheet2：患者重要结局的分类（描述性文本）

以下是同一篇文章在 Sheet2 里的**结局分类**字段：把论文报告的结局按类别归纳。
它们**不是**结局层的数值记录，而是"这一类用了什么工具"的**索引**，因此写法有固定格式：

- **只填「测量工具/量表专有名 + 简短限定」**，其中量表名**固定写成 \`缩写: 全称\` 两段式**
  （金标准的主导形式；只写一半会被判"含义一致但写法不同"）：
  - \`HDRS: Hamilton Depression Rating Scale\`、\`MBI: Modified Barthel Index\`
  - \`PainVAS 0-100 mm\`（工具 + 范围）
  - \`PainVAS (pain intensity)\`（工具 + 括号里说明测什么）
  - ❌ 不要带原文序号与前缀（\`3. BDI, …;\`、\`SF12:①Physical\`、\`1. swallowing,\`）；
  - ❌ 不要泛化描述（\`4-point scale\`、\`questionnaire\`）；

### ⚠️ 六类的判据与填写规则（实测这几条最容易出错）

| 类别 | 归入什么 | 典型工具 |
|---|---|---|
| 疼痛类 | 疼痛强度/频率的主观评分 | PainVAS、NRS、VRS |
| 非疼痛症状类 | 疼痛以外的症状：抑郁、焦虑、疲劳、睡眠、消化道症状… | HDRS、BDI、FSS、RQLQ 睡眠域 |
| 功能类 | 日常活动能力、躯体功能、吞咽/膀胱等功能指标 | MBI（Barthel）、SSA、SF-12 躯体分量表 |
| 生活质量类 | **总体**健康相关生活质量 | EQ-5D、SWAL-QOL |
| 重要事件类 | 复发、再入院、再插管、并发症、妊娠等事件计数 | — |
| 死亡率 | 死亡及其原因 | — |

1. **一个字段列出该类的全部工具**，用 \`;\` 分隔
   （如 \`Fatigue Severity Scale (FSS); Numeric Rating Scale (NRS)\`）——
   只列一个而漏掉另一个会被判"存在错误"；
2. **不要把别的类的指标混进来**（如把 pain threshold / tender points 塞进疼痛类、
   把 SRI 塞进只有 FSS/BDI 的字段）；
3. **该类在论文里没有对应结局时填 \`NR\`**——不要为了"填满"而强行归类。
   实测 4 例错误正是金标准填 NR、抽取强行归类造成的；
4. 同一量表**只归一个类**（SF-12 physical → 功能类，不要两处都写）。
- ❌ **不要抄方法学的整句**：不要写 \`change in pain intensity, measured on a visual analogue scale (PainVAS 0–100 mm), at 10 weeks\`；
- ❌ **不要带时间点**（\`at 10 weeks\`、\`at 6 months\`）——时点属结局层，不属分类字段；
- ❌ 不要带 \`change in\` 这类叙述前缀；
- 每条尽量 **≤ 15 个词**；该类没有对应结局时填 \`NR\`（金标准里也可能是空——拿不准就填 NR）。

${renderFields(STUDY_OUTCOME_FIELDS)}

${OUTPUT_RULES}

## JSON 模板（照此结构输出，键名必须完全一致）

\`\`\`json
${jsonTemplate([...ARTICLE_FIELDS, ...STUDY_OUTCOME_FIELDS])}
\`\`\`

## 特别注意：首页页眉/页脚/脚注

论文首页的**页眉、页脚、脚注**（材料中标记为 \`text/metadata\` 的块）是若干字段的**主要来源**，务必查阅：

- 引文行（如 \`To cite: … Acupunct Med 2016;34:257–266.\` 或页脚 \`Vas J, et al. Acupunct Med 2016;34:257–266. doi:10.1136/…\`）
  → \`journal\`（期刊缩写需还原为期刊全名，如 Acupunct Med → Acupuncture in Medicine）、\`publicationYear\`、\`doi\`
- 卷期/版权行（如 \`Trials (2015) 16:314\`、\`© 2015 …\`、\`Int J Clin Exp Med 2015;8(10)\`）→ \`publicationYear\`、\`journal\`
- 脚注里的通讯作者与单位 → \`authorContact\`（邮箱）、\`country\`（单位所在国家）
- \`Accepted …\` / \`Published Online First …\` 这类日期**不是**发表年份；若与卷期年份冲突，以**卷期/版权行的年份**为准。

## 常见错误（务必避免）
- ❌ 把参考文献里的 DOI 当成论文自身的 DOI。
- ❌ 忽略首页页脚，把 journal / publicationYear / doi 直接填 NR——先翻到首页页脚再判断。
- ❌ 期刊分类、国家分类填中文含义而不填编码。
- ❌ 疾病系统凭印象归类——必须依据论文中的疾病名称与 ICD-11/附录3 的分类。
- ❌ 漏掉 Sheet2 的结局分类字段（每个都要填，没有对应结局就填 NR）。
`;
}

function comparisonPrompt() {
  return `${COMMON_PREAMBLE}

## 任务
抽取**比较组级**信息：即「试验组 vs 对照组」这一个配对的设计与针刺方案细节。

一篇论文可能有多个比较组（如 2×2 设计、多臂试验）。**每个比较组单独输出一个对象**，
放在 \`comparisons\` 数组里，顺序与材料中出现的顺序一致。

## 两组的写法（⚠️ 金标准有固定格式，务必照办）

\`intervention\` / \`control\` 填 **\`干预+合并治疗\`** 形式，四条硬要求：

1. **用 \`+\` 连接**（不要写 plus / combined with / and）；
2. **全小写**；
3. 干预用**通用术语**，不要论文自造的组名或修饰语：
   \`acupuncture\`（不要 individualised acupuncture / real acupuncture / IA / RA）、
   \`electroacupuncture\`（不要 EA）、\`body acupuncture\`、\`ear acupuncture\`、
   \`sa-am acupuncture\`、\`sham acupuncture\`；
4. 合并治疗照抄论文用词（\`usual care\` / \`usual pharmacological treatment\` / \`swallowing training\` /
   \`CIC treatment\` 等）；没有合并治疗就只写干预本身（如 \`acupuncture\`）。

示例（左=正确，右=常见错误）：
- ✅ \`acupuncture+usual pharmacological treatment\` ❌ \`individualised acupuncture (IA) based on TCM diagnosis\`
- ✅ \`electroacupuncture+CIC treatment\` ❌ \`EA combined with CIC treatment\`
- ✅ \`ear acupuncture+usual care\` ❌ \`auricular acupuncture plus usual care\`
- ✅ \`acupuncture\` ❌ \`real acupuncture (RA)\`

## 需要先判断的事实
- 这篇论文有几个试验组、几个对照组？
- 每个比较组分别是哪两个组？（如 针刺+常规治疗 vs 假针+常规治疗）
- 若只有双臂设计，则只有 1 个比较组。
- **两组的干预描述要写完整**：包括共同给予的合并治疗（如 + usual pharmacological treatment）。
  论文常用缩写指代组别（如 IA = individualised acupuncture、SA = sham acupuncture），
  \`intervention\` / \`control\` 必须填**完整的干预描述**并保留合并疗法，不能只写缩写或组名。

## ⚠️ 比较组的口径（多臂试验最容易数错的地方）

**每个比较组必须是「一个试验组 vs 一个对照组」。**

- 三臂试验（如 A 试验组 / B 安慰针对照 / C 常规治疗对照）应当列出 **2 个**比较组：
  「A vs B」「A vs C」——**都是同一个试验组分别去比不同的对照**；
- ❌ **不要列出「对照组 vs 对照组」**（如「安慰针+常规治疗 vs 常规治疗」）：
  两两组合会多出这一类，它既不是本系统评价的比较组，还会把下游的比较组编号整体后移、
  导致所有结局行错位。**先把每个组标成试验组/对照组，只在"试验组+对照组"之间配对**；
- ❌ 也不要把同一个试验组与同一个对照组重复列两次。

**排序**：先列「试验组 vs 假针/安慰剂对照」，再列「试验组 vs 常规治疗/其他对照」
（即按对照组类型码从小到大）；同一类型时按论文里组别出现的顺序。
金标准就是这个顺序，顺序会影响下游每一行结局的归属。

## 材料构成
材料含方法学与结果章节，并且**包含基线特征表（Table 1 等）**：
性别人数、各组例数、基线均值、既往针刺史等常只出现在表格里——请读表，不要因为没有正文描述就填 NR。

## 一致性的硬要求
- \`randomizationClass\` 必须与 \`randomizationMethod\` 的原文一致：原文提到 computer/software/
  telephone/web-based/central randomisation service → 选 \`2\`（计算机随机）；提到 random number
  table → \`1\`；提到 minimisation → \`7\`。原文写了方法却填「未报告」是错误。
- \`allocationClass\` 同理：central/telephone/web 分配 → \`1\`；opaque sealed envelope → \`2\`。
- \`controlType\` / \`comparisonType\` 要体现**合并疗法**：若两组都同时接受常规治疗，
  则对照形式是「假针+其他疗法」（\`5\`）、比较类型是「针刺+其他疗法 vs 假针/安慰针+其他疗法」（\`4\`）。
- \`deqi\`：文中出现 deqi / 得气 / needling sensation / 酸麻胀重 等描述即填 \`1\`。
- \`practitionerYears\`：填数字；只在确实没有任何从业年限描述时才填 NR。
- 各编码字段的含义可按其字面判断；**但不得因为"需要推断"就直接填 NR**——
  金标准要求填 NR 的只有"文中确实没有报告"的情形。

- \`needleCountText\`：填**用针数目的原文数值或最短表述**（如 \`18\`、\`10\`、\`range 12–23\`、\`The key (common) acupoints\`）。
  ❌ **不要把穴名罗列进来**（如 \`GV20, bilateral GB20, BL11…\` 或 \`5 acupoints (LU8, SP3…)\`）——
  那是选穴信息，不是针数。数值能确定时直接填数值。

## ⚠️ 带单位的三列怎么填（\`*_desc\` / \`*_value\` / \`*_unit\`）

表头已经写死了单位的字段有 4 组，它们各自是**三列分工**，不是让你把同一句话抄三遍：

| 组 | 描述列（原文） | 数值列 | 单位列（**必须填编码**） | 口径 |
|---|---|---|---|---|
| 留针时间 | \`needleRetentionDesc\` | \`needleRetentionValue\` | \`needleRetentionUnit\`：\`1\`=分钟 \`2\`=小时 | **按原文单位**（分钟填 1、小时填 2） |
| 疗程 | \`courseDesc\` | \`courseValue\` | \`courseUnit\`：\`1\`=天 \`2\`=周 | **按原文单位**（天填 1、周填 2） |
| 治疗频次 | \`frequencyDesc\` | \`frequencyValue\` | \`frequencyUnit\`：\`1\`=天 \`2\`=周 \`3\`=1小时 | **按原文的周期**（见下方 ⚠️） |
| 最长随访时间 | \`maxFollowupDesc\` | \`maxFollowupValue\` | \`maxFollowupUnit\`：\`1\`=天 \`2\`=月 \`3\`=年 \`4\`=周 \`5\`=小时 | **按原文单位** |

⚠️ **口径是"按原文怎么写就怎么记"，不是"统一折算成某个单位"。**
只有**原文单位不在该列编码表里**时才换算——例如疗程的编码表只有天/周，
而原文写 \`3 months\`，这时按 **1 月 = 4 周** 换算成 \`12\` / \`2\`。

⚠️ **治疗频次最容易搞反**：它的"数值"是**一个周期内做几次**，"单位"是**那个周期的编码**。
\`once a day\` → \`value=1\`、\`unit=1\`（**天**）；\`3 times per week\` → \`3\` / \`2\`（周）；
\`twice weekly\` → \`2\` / \`2\`。
**不要一律折算成"次/周"**——\`once a day\` 折成 \`7\` / \`2\` 是**错的**（实测踩过：这一条让治疗频次两列掉了 17 个点）。

**三条硬规则：**

1. **描述列照抄原文**（保留论文的原始写法与单位）；**数值列填换算后的数**；
   **单位列填上面那张编码表的编码**。三列指向的是同一个量，但写法各不相同。
2. **换算约定：1 月 = 4 周、1 周 = 7 天、1 天 = 24 小时、1 小时 = 60 分钟。**
   （这是本项目的记录约定，不要用"1 月 ≈ 4.3 周"。）
3. **只有原文给出明确的"数 + 时间单位"时才填数值列与单位列。**
   纯定性描述（\`until delivery\`、\`post-gastroscopy\`、\`during hospitalization\`、
   \`throughout the procedure\`、\`immediately after labor\`）**三列都填 \`NR\`**——
   不要为了让表格"看起来完整"而硬凑一个数。
   ⚠️ **但下面这几种都算"明确"，必须照填**（实测把它们误判成"定性描述"是本层最大的漏抽来源）：
   - **频次短语**：\`3 times per week\`、\`once a day\`、\`twice weekly\`、\`5 days per week\`、
     \`every other day\` → \`value\` 填**次数**、\`unit\` 填**周期**（如 \`3\` / \`2\`）
   - **简写的频次**：\`once\` → \`1\` / \`1\`（次/天）；\`twice\` → \`2\` / \`2\`（次/周）
   - **光有数字、单位由上下文或表头确定**：频次写 \`1\` → \`1\` / \`1\`；
     留针时间写 \`20\` → \`20\` / \`1\`（分钟）

**具体示例**（论文原文 → 三列应填什么）：

| 论文原文 | desc | value | unit | 说明 |
|---|---|---|---|---|
| \`needles were retained for 30 minutes\` | \`30 minutes\` | \`30\` | \`1\` | 原文本就是分钟，直接搬 |
| \`retained for 0.5 h\` | \`0.5 h\` | \`30\` | \`1\` | **小时→分钟** |
| \`a course of 3 months\` | \`3 months\` | \`12\` | \`2\` | **月→周**（3×4） |
| \`treatment lasted 2 weeks\` | \`2 weeks\` | \`2\` | \`2\` | 原文本就是周 |
| \`treated once daily for 10 days\` | \`once daily for 10 days\` | \`7\` | \`2\` | **次/天→次/周**（1×7）；疗程另填 \`10\`/\`1\`（天） |
| \`3 times per week\` | \`3 times per week\` | \`3\` | \`2\` | 频次已是次/周 |
| \`follow-up until delivery\` | \`until delivery\` | \`NR\` | \`NR\` | **定性描述 → 三列都 NR** |
| \`outcomes measured only during hospitalization\` | \`outcomes measured only during hospitalization\` | \`NR\` | \`NR\` | 同上，**不要硬凑** |

## 字段定义与填写要求

${renderFields(COMPARISON_FIELDS)}

${OUTPUT_RULES}

## JSON 模板（照此结构输出）

\`\`\`json
{
  "comparisons": [
${jsonTemplate(COMPARISON_FIELDS).split('\n').map((l, i) => (i === 0 ? l : '    ' + l)).join('\n')}
  ]
}
\`\`\`

## 常见错误（务必避免）
- ❌ 把所有比较组的字段合并到一起——必须**逐比较组**输出。
- ❌ 把「试验组干预」和「对照组干预」填成同一个值。
- ❌ 用论文里的组别缩写（IA/SA 等）代替完整干预描述。
- ❌ 选穴方案/针刺类型等编码字段填中文含义而不填编码。
- ❌ 进针深度、留针时间等不适用于电针/激光针/穴位按压时，应填 NA 而不是 NR。
- ❌ 表格里明明有各组例数/性别分布，却填 NR。
- ❌ **带单位的字段三列抄成一模一样**（\`value\` 抄成 \`"9 weeks"\`、\`unit\` 抄成 \`"周"\`）——
  数值列只填数、单位列只填编码，原文放 \`desc\`。
- ❌ **没有明确数值与单位时硬填**（把 \`until delivery\` 折算成某个数字）——三列都填 \`NR\`。
`;
}

function outcomePrompt() {
  return `${COMMON_PREAMBLE}

## 你的任务（两步走）
结局层分**两次调用**完成，你在每次调用中看到的材料完全相同，只是最后的「本次任务」不同：

1. **枚举**：先列出论文报告的**全部结局指标**（每个量表/分量表一条），只填结局自身的字段，**不填数值**。
2. **取值**：再针对其中**某一个**结局，抽取它**自身**的字段（编码、范围、方向、单位、类型、基线调整、随访时间）。

⚠️ **各时点的数值（效应量、变异值、例数）不在本次职责内**——由下游的专门步骤（outcome-values）负责，
那里有"取哪一列"的完整规则。本次不要输出 \`baseline\`/\`endOfTreatment\`/\`followUpEnd\`。
这样拆分是因为两部分规则都很多，混在一起会互相挤占篇幅、两边都做不好。

## 材料说明
材料按块给出，每块带锚点 \`[[b<块号>|p<页号>]]\`；表格已转为 Markdown 表格。
你可以在 quote 中直接引用原文（不必包含锚点）。

## 结局自身的字段定义与填写要求

${renderFields(OUTCOME_TOP_FIELDS)}

${OUTPUT_RULES}

## 常见错误（务必避免）
- ❌ **漏掉结局指标**：论文报告的每个结局指标都要单独一条，不能只输出主要结局。
- ❌ 把多个量表（如 SF-12 的 physical 与 mental、疼痛 VAS 与抑郁 HDRS）塞进同一条记录。
- ❌ \`construct\`/\`subconstruct\`/\`measurementType\` 等编码字段填中文含义而不填编码。
- ❌ 测量方向填错：数值越大越好=1，越小越好=0。
- ❌ 输出时点数值（\`baseline\`/\`endOfTreatment\`/\`followUpEnd\`）——那是下游步骤的事。
`;
}

/**
 * 数值层（outcome-values）的系统提示词。
 *
 * 只讲数值：时点界定、时点块字段（含 estimateType/varianceType 图例）、输出格式与常见错误。
 * 不含任何结局元信息的图例（那些由 outcome 负责），因此篇幅可控、规则集中。
 */
function outcomeValuePrompt() {
  const tp = TIMEPOINT_FIELDS.map((f) => renderField(f, '    ')).join('\n');
  return `${COMMON_PREAMBLE}

## 你的角色
你正在为一项系统评价抽取**某个指定结局在各个时点上的数值**。材料与「结局字段」步骤完全相同，
但本次**只输出数值**：其余字段（结局名称、测量工具、编码、量表范围/方向等）都已抽过，不要重复输出。

## 材料说明
材料按块给出，每块带锚点 \`[[b<块号>|p<页号>]]\`；表格已转为 Markdown 表格。
数值**优先取自表格**，其次正文，最后摘要。表格里每一列都可能是不同的统计量
（例数 / 效应量 / 变异值 / p 值 / 组间差值），**取数前先把列头数清楚**。
你可以在 quote 中直接引用原文（不必包含锚点）。

## 时点的界定
- \`baseline\`（基线期）：治疗开始前的测量值
- \`end_of_treatment\`（疗程结束时）：治疗结束时的测量值，JSON 键写 \`endOfTreatment\`
- \`follow_up_end\`（随访结束时）：≥80% 数据的最长随访时间点，JSON 键写 \`followUpEnd\`

**每个时点单独输出**。若某时点无数据，省略该键（不要编造）。

## 时点块内的字段（每个时点都适用）

${tp}

> ⚠️ \`experimentalCiLower\`/\`experimentalCiUpper\`（以及对照组的同名键）装的是**变异值**，
> 不一定是 95%CI：SD/SE 这类单值型只填**下限**，上限留空；95%CI/IQR/全距才两个都填。
> 具体由 \`varianceType\`（1=SE 2=95%CI 3=SD 4=IQR 5=全距 6=P 7=QR）决定。

> 说明：以上键名在输出时**按前缀包装**：
> - 基线期：\`baseline: { estimateType, varianceType, experimentalEstimate, ... }\`
> - 疗程结束：\`endOfTreatment: { ... }\`
> - 随访结束：\`followUpEnd: { ... }\`
> 例：基线期的 \`estimateType\` 写成 \`baseline.estimateType\`。

${OUTPUT_RULES}

## 常见错误（务必避免）
- ❌ 输出结局元信息（结局名称、测量工具、construct/measurementType 等编码）——本次只要数值。
- ❌ **变异值类型选取错误**：同时报告 SE 与 95%CI 时只取 SE（按优先级 1→7 依次优选）。
- ❌ 看到 \`Mean (SD)\` 却把括号里的 SD 丢掉（应填进 \`ciLower\`，见任务说明）。
- ❌ 混淆「试验组」与「对照组」的列。
- ❌ 把「组间差值」当成「组内估计值」。
- ❌ 时点归错：6 个月随访属于 \`followUpEnd\` 而非 \`endOfTreatment\`。
- ❌ 只填了 \`baseline\`，漏掉疗程结束/随访时点。
- ❌ 把摘要里的百分比变化当成表格里的组内估计值——优先取表格中的明确数值。
`;
}

/** 阶段 1：只列出结局指标的名称与工具（响应必须很小）。 */
function outcomeListTaskPrompt() {
  return `## 本次任务：只列出结局指标的名称与测量工具

列出这篇论文报告的**全部结局指标**，每个结局指标一个对象，顺序与论文中出现的顺序一致。

判断粒度：**换了测量工具/量表/分量表就是新的一条**。
例如针刺治疗纤维肌痛的论文若报告「疼痛 VAS」「抑郁 HDRS」「SF-12 physical」「SF-12 mental」，
应当输出 **4 条**（同一 construct 用了两个量表也要分开）。

**但要把"结局指标"与"量表条目"区分开**，按下面的顺序判断：

1. **以论文自己声明的结局为准**：先读摘要/方法里「主要结局／次要结局」那句话
   （如 \`The primary outcome was … Secondary outcomes included …\`），**逐条列出**它声明的指标。
   这些就是结局指标。
2. 摘要没有声明时，取**结果章节里做了组间比较**的指标（结果表的主列/主行）。
3. **明确排除**（这些都不是独立结局）：
   - 基线特征表（Table 1）里的变量（年龄、性别、病程等）；
   - 不良反应/退出/依从性计数；
   - 亚组分析、事后分析、相关性分析；
   - 某个量表内部的分项（如 FIQ 的 fatigue / night rest / stiffness，SF-36 的 8 个维度），
     除非论文把该分项**单独作为结局**声明并做了组间比较。

经验值：一篇 RCT 通常 **2~6 个**结局指标；超过 6 个几乎一定是把量表分项也算进来了。
宁可少而准——多列一条会带来几十个错误字段。

本次**只需**给出每个结局的名称与测量工具（外加支撑原文），
其余字段（编码、测量范围/方向/单位/类型、基线调整、时点数值等）会在后续逐条抽取。
**不要**在本次输出中给出任何数值或编码字段。

## JSON 模板（照此结构输出）

\`\`\`json
{
  "outcomes": [
    {
      "outcomeName": { "value": "<**测的是什么**：症状/构造/指标名，如 pain intensity、level of depression、quality of life>", "quote": "<逐字原文片段>", "confidence": 0.95 },
      "instrument": { "value": "<**用什么测**：量表/工具的**简称**，如 VAS、HDRS、SF-12 physical、RQLQ、FSS。不要带取值范围或解释（那些另有字段）>", "quote": "<逐字原文片段>", "confidence": 0.95 }
    }
  ]
}
\`\`\`

> 两者的分工要分清：\`outcomeName\` 回答「测的是什么」，\`instrument\` 回答「用什么测的」。
> 不要两处都填量表名（如 name=PainVAS、instrument=VAS 是错的；
> 应为 name=pain intensity / instrument=PainVAS 或 VAS）。
`;
}

/** 阶段 2：针对某一个结局，抽取它的全部剩余字段（元信息 + 随访 + 各时点数值）。 */
function outcomeItemTaskPrompt() {
  // 名称与测量工具在阶段 1 已确定（并已作为本次任务的身份传入），这里不再重复抽取
  const meta = OUTCOME_TOP_FIELDS.filter(
    (f) => f.source !== 'gold_meta' && f.key !== 'outcomeName' && f.key !== 'instrument',
  );
  return `## 本次任务：抽取**指定结局**的「结局自身字段」

只抽取下面这一个结局指标的**结局自身字段**（编码、范围、方向、单位、类型、基线调整等）：

> 结局名称：{{OUTCOME_NAME}}
> 测量工具：{{INSTRUMENT}}

不要输出其他结局指标的数据；结局名称与测量工具已在上一步确定，本次不必重复输出。

> ⚠️ **本次不要输出任何时点数值**（\`baseline\` / \`endOfTreatment\` / \`followUpEnd\` 一个都不要给）。
> 各时点的效应量、变异值、例数由下游的专门步骤抽取——那里有"取哪一列"的完整规则。
> 本次把注意力全部放在结局自身的字段上。

## ⚠️ 两个"易漏字段"必须主动去找

**\measurementRange\（量表取值范围）**——实测 2015 年 15 组**全部答 NR**，是本层最差字段：

- 范围通常**紧跟在量表名后面**：\`PainVAS 0–100 mm\` → 填 \`0-100\`；\`VAS 0-10\` → \`0-10\`；\`HDRS 0-52\` → \`0-52\`；
- 也可能写在方法学的量表描述里（\`scored from 17 to 46\`）→ 填 \`17-46\`；
- 只写数值区间（如 \`0-100\`），不要带单位；
- ⚠️ **不要因为"表格里没有单独一列写范围"就填 NR**——论文里给了就必须填；
- 确实全篇未给 → \`NR\`；不适用（事件计数、率）→ \`NA\`。

**\measurementUnit\（测量单位）**——同样主动找：\`0-100 mm\` → \`mm\`；无单位 → \`NA\`。

## ⚠️ 编码字段必须填编码，不要填文字

\`construct\` / \`subconstruct\` / \`measurementType\` 等字段的允许取值已在下文图例里给出，
**一律填数字编码**。实测 \`subconstruct\` 长期低分，原因就是把中文/英文含义当成了取值。

### 五个最常错的编码，按这几条判（每条都有实测依据）

**① measurementType（测量类型）——跟着"这一行的数值是怎么报告的"走，不要一律填 1：**

| 该结局的数值形态 | 填 |
|---|---|
| 只有各组自己的估计值（均值/中位数/组内变化值） | \`1\` 估计值 |
| 论文报告的是**两组之差**（LSMD / mean difference / 率差，且你把它填进了 \`differenceEstimate\`） | \`2\` 组间差值 |
| 报告的是**发生人数/例数**（你填了 \`experimentalEvents\`） | \`3\` 发生事件数 |
| 报告 OR / RR / RD / HR | \`4\` / \`5\` / \`6\` / \`7\` |
| 等级资料（治愈/显效/有效/无效…） | \`8\` |

实测 2015-04 全篇 6 行都该填 \`2\`（论文给的是 LSMD），我们全填了 \`1\`——**与我们自己填的
\`differenceEstimate\` 自相矛盾**。判据很简单：**你填了 \`difference*\` 就是 2，填了 \`events\` 就是 3。**

**② baselineAdjusted（基线是否调整）——不要默认填 2（否）：**
论文用了 ANCOVA / MMRM / 回归 / "adjusted for baseline" / 把基线值作为协变量 → \`1\`（是）；
**确实**写明未做基线调整 → \`2\`；文中看不出 → \`3\`（不清楚）。
金标准里 \`1\` 占多数、\`3\` 次之，\`2\` 很少——一律填 2 会成片判错。

**③ measurementDirection（测量方向）——先看量表是"症状"还是"功能/生活质量"：**
症状类量表（疼痛 VAS、焦虑 VAS、恶心、鼻塞、疲劳、抑郁量表…）**数值越小越好 → \`0\`**；
功能/生活质量类量表（MBI 日常生活能力、SF-12、RQLQ(S)、SWAL-QOL、EQ-5D 效用值…）**越大越好 → \`1\`**。
实测 2015-06 的焦虑 VAS 我们填了 1（应为 0）。

**④ subconstruct（结局子类）——不要一律填 13：**
13 是"**确实归不进任何系统**"才用。能对上系统就填对应码：
呼吸系统（鼻炎、鼻塞、哮喘）=\`8\`；耳鼻喉（嗅觉/味觉/咽喉）= \`9\`；
泌尿（排尿、膀胱、尿潴留）=\`6\`；神经功能（吞咽、言语、感觉、反射）=\`3\`；
精神/行为（抑郁、焦虑、睡眠、认知）=\`4\`；肌骨功能（关节活动、肌力、疼痛相关功能）=\`2\`；
皮肤=\`11\`；循环=\`10\`；围产期=\`12\`；术后胃肠=\`5\`；其他功能=\`7\`。
实测我们 15 个结局里 8 个填了 13，而金标准给了具体系统。

**⑤ construct（大类）——\`1\` 疼痛 / \`2\` 其他症状 / \`3\` 功能 / \`4\` 生活质量：**
只有**疼痛**结局才是 1（疼痛 VAS、压痛阈）；鼻塞、喷嚏、疲劳、抑郁、焦虑、排尿异常等
**疼痛之外的症状**归 2；日常生活能力/吞咽/运动等**功能**量表归 3；
专门的生活质量量表（RQLQ(S)、SWAL-QOL、EQ-5D、SF-36 生活质量）归 4。
⚠️ 别只因为结局名里出现 \`quality of life\` 就填 4——**以量表的性质为准**。

## ⚠️ 随访时间（本结局最后一次测量）单独给出

用 \`followUpDescription\` / \`followUpValue\` / \`followUpUnit\` 描述本结局最后一次测量的时间：
照抄原文描述（如 \`42 weeks\`），数值填 \`42\`，单位填编码。未报告 → \`NR\`。

## JSON 模板（照此结构输出）

\`\`\`json
${jsonTemplate(meta)}
\`\`\`
`;
}

/**
 * 数值层（outcome-values）：针对某一个结局，只抽取三个时点块的数值。
 *
 * 为什么独立成一条提示词：数值列的识别规则（ITT vs PP、变异值是 SD 还是 95%CI、
 * 例数在正文里、四件套）篇幅很大，塞进结局字段的提示词里会把图例和字段要求挤掉，
 * 两边都做不好。这里只讲数值，不含任何结局元信息的图例。
 */
function outcomeValueTaskPrompt() {
  return `## 本次任务：抽取**指定结局**的「结局 × 时点」数值

只抽下面这一个结局指标的数值，按 \`baseline\` / \`endOfTreatment\` / \`followUpEnd\` 三个时点给出：

> 结局名称：{{OUTCOME_NAME}}
> 测量工具：{{INSTRUMENT}}
> 测量单位：{{UNIT}}
> **本次比较组：{{COMPARISON}}**

**不要**输出结局名称、测量工具或任何编码字段（construct/measurementType 等）——那些已经抽过了，
本次只输出时点数值块。没有数据的时点**整个省略**。

## ⚠️ 先确认"取哪一对的数值"（多臂试验最容易错的地方）

上面的「本次比较组」决定了本次要的是**哪两组之间的对比**。多臂试验的表格常按**臂**分行，
每行给一个「组间差值（95%CI）」——那个差值是"**该臂 vs 对照组**"，因此**不同比较组要取不同行**：

\`\`\`
Table 2  MMRM analysis of full analysis set (FAS)
Outcome  Group   Baseline        5 weeks                              13 weeks
                 Mean (SD)       Mean (SD)   P      LSMD (95% CI)     Mean (SD)   P      LSMD (95% CI)
BDI      A       16.41 (8.36)    9.02 (6.92) 0.252  −1.56 (−3.94, 0.83)  9.63 (6.39) 0.231  −1.68 (−4.16, 0.81)
         B       15.00 (7.67)    8.88 (7.66) 0.052  −2.34 (−4.70, 0.02)  7.89 (7.15) 0.007  −3.25 (−5.71, −0.80)
         C       15.30 (7.05)   13.36 (6.39)        （对照组这一格是空的）  14.28 (8.54)
\`\`\`

规则：
- 表格只写 \`A\` / \`B\` / \`C\`，**必须回方法学/表注查这些字母是什么组**
  （如 \`The subjects were randomly assigned to group A (body acupuncture), group B (Sa-am acupuncture),
  or group C (usual care)\`）；
- 「A vs C」就取 **A 行**的数值，「B vs C」就取 **B 行**的数值——**不同比较组取不同行，不得两行取同一个**；
- **对照组那一行（上例 C）的差值格子是空的**，别去那里找；各臂自己的 Mean (SD) 仍按
  \`experimentalEstimate\`/\`controlEstimate\` 填（本次比较组里的干预组 = experimental，对照组 = control）；
- 同一结局有多张分析表时（\`MMRM/FAS\` 主要分析、\`ANCOVA\` 敏感性分析、\`PPS\` 符合方案集），
  **取主要分析的 FAS/MMRM 那张**，不要取敏感性分析或 per-protocol 表。

## ⚠️ 数值取哪一列（实测四类高频错误）

**① 同时有 ITT 与 per-protocol（PP）结果时，取 ITT。**
论文常在同一张表里并列 ITT 与 PP 两套结果（表头写 \`Intention-to-treat\` / \`Per protocol\`，或正文分别叙述）。
金标准取的是 **ITT（意向性治疗）**：实测 2015-01 我们取了 PP 列 → \`estimate\` 写成 −35.9（金 −41.0）、
\`n\` 写成 80/82（金 78/81），整条时点块全错。**优先 ITT；只有论文完全没做 ITT 时才用 PP。**

⚠️ 这种表**不是左右两组各占一半**，列顺序要数清楚。实测 2015-01 的 Table 2 长这样：

\`\`\`
                                    Per protocol                    ITT
                    Acupuncture              Sham                Acupuncture n=80        Sham n=82
                    n  MRC(%)  95% CI   n  MRC(%)  95% CI  p      MRC(%)  95% CI      MRC(%)  95% CI     p     Cohen's d
PainVAS (T0–T1)     78  −41.2  −47.6 to −34.9   81  −27.0  −33.2 to −20.8  0.001   −41.0  −47.2 to −34.8  −27.1  −33.2 to −20.9  0.001  0.50
\`\`\`

识别要点：
- \`Per protocol\` 只标注**第一组**列，而 **ITT 组常常直接用随机化例数标注**（\`Acupuncture n=80\`）；
- 一行的列序是「PP: n, 效应量, CI, n, 效应量, CI, p｜ITT: 效应量, CI, 效应量, CI, p｜Cohen's d, 等级」——
  **ITT 组只有效应量与 CI、没有自己的 n 列**；要填例数就用表头里那一组的 n（\`n=80\` / \`n=82\`）；
- 凡是"同一结局出现两个相近的效应量"（−41.2 与 −41.0、39.0 与 39.4），
  **后一个（ITT 组）才是金标准要的**，别把 PP 的那个填进去。

**② 变异值（varianceType 对应的那个数）必须填进 \`ciLower\`/\`ciUpper\`——键名里的 "Ci" 是历史包袱。**
这两个键装的是**变异值**（离散度），不一定是 95%CI，具体填什么由 \`varianceType\` 决定：

| 论文写法 | varianceType | ciLower | ciUpper |
|---|---|---|---|
| \`Mean (SD)\` = \`52.3 (15.7)\` | \`3\` | **15.7** | 留空（单值，没有上限） |
| \`Mean (SE)\` | \`1\` | SE 值 | 留空 |
| \`Mean (95% CI)\` = \`39.4 (29.3 to 49.5)\` | \`2\` | 29.3 | 49.5 |
| \`Median (IQR)\` | \`4\` | Q1 | Q3 |
| 全距 \`(min–max)\` | \`5\` | min | max |

⚠️ **实测 2015 年 94 组带变异值的时点块里，62 组是 SD 单值**，而我们只填了 \`estimate\`、
把括号里的 SD 整个丢掉——这是本层最大的一块漏（2015-03 的 \`52.3 (15.7)\` 就该填
\`ciLower=15.7\`，我们填成了空）。**看到括号里的离散度就必须填，不管它是不是 CI。**

**③ CI 要读该组该时点那一列，不要串到相邻列。**
表里 CI 常与「均数、SD、范围、p 值」并排。实测 2015-03 把别的列当成 CI 下限
（金 19.3 / 我 3.2）。取数时确认列头：**上下限必须来自同一列组的同一个离散度**，
且当它是 95%CI 时应满足 \`下限 < 估计值 < 上限\`——不满足就说明取错了列，请回表核对。

**④ 别把「组间差值」当成「组内估计值」。**
表格里常并排给出「各组自己的变化值」与「两组之差」。\`experimentalEstimate\`/\`controlEstimate\`
填**各组自己的值**；两组之差填 **\`binary\` 块里的 \`differenceEstimate\`**（任何结局类型都要填，
见上面的类型表）。实测 2015 年这批差值我们一次都没填（39 个数值全漏）。

## ⚠️ 时点块必须凑齐「四件套」（实测最常缺的就是这一块）
**例数 \`n\` 主要在正文里，不在表格里。** 实测 449 个金标准 Sheet3 数值的来源：
效应量与 CI 有 83~85% 出自表格，而**例数只有 49~55% 出自表格、86~88% 出自正文**
（\`A total of 164 participants…\`、\`153 participants completed the study\`、
\`78 in the IA group\`、CONSORT 流程描述等）。因此：

- **不要只在表格里找例数**——表格里没有就**到结果段落 / 流程描述里找**；
- 一个时点块只要填了 \`estimate\`，就必须同时尽力给出 \`experimentalN\`、\`controlN\`（例数）
  以及 \`ciLower\`/\`ciUpper\`（**论文给了离散度就必须填**，规则见上面 ②：SD/SE 是单值只填下限，
  95%CI/IQR/全距是双边界两个都填）；
- 数值实在没有 → 填 \`NR\`；不适用 → \`NA\`。**不要因为"表格那一格是空的"就整块留空。**

⚠️ **两种时点常见错误**：
- **只填 baseline**（最常见）：只要论文在结果章节/表格里报告了该结局的组间比较
  （组内变化值、两组均值、率、差值等），就**必须**把它们填进 \`endOfTreatment\`（疗程结束时）
  与 \`followUpEnd\`（随访结束时）；**不得**用 baseline 顶替疗程结束的数据。
- **完全不填 baseline**：论文在结果表或基线表里给出该结局的基线值/基线例数时，也要照填。
  **尤其是"基线只给了各组人数 + 一个组间差值"的情况**（基线均衡性比较表里很常见）：

  \`\`\`
  Table 1  Baseline characteristics        Acupuncture (n=52)   Control (n=52)   Difference (95% CI)
  ACR20 response, n (%)                    12 (23.1)            13 (25.0)        −1.9 (−18.8 to 14.9)
  \`\`\`

  这种也要出 \`baseline\` 块：两组人数填 \`continuous.experimentalN\` / \`controlN\`，
  差值填 \`binary.differenceEstimate\` / \`differenceCiLower\` / \`differenceCiUpper\`。
  实测 2023-27（ACR20/50/70）与 2019-02（术后疼痛）的金标准基线块都是这个形态
  （人数 52/52、49/50 加差值 −1.9、−1.35），我们**整块没给** → 28 个字段全判漏。
  **"基线只有人数和差值"不是省略整块的理由。**

每个时点块**只填适用的那一类数值**，其余整类省略（不要用 NR 把每一类都填满）：

| 类型 | 适用情形 | 要填的键 |
|---|---|---|
| \`continuous\` 连续型 | 均值/中位数/组内差值（如 VAS 评分、量表得分） | estimateType、varianceType、experimentalEstimate/CiLower/CiUpper/N、controlEstimate/CiLower/CiUpper/N |
| \`binary\` 二分类**/组间效应量** | 事件数/人数型（有效/无效、发生/未发生）**或**论文报告了**两组之差**（见下） | experimentalEvents/**N**、controlEvents/**N**、**differenceEstimate/CiLower/CiUpper** |
| \`categorical\` 等级资料 | 等级疗效（如 治愈/显效/有效/无效） | classificationMethod、cat1～cat6 的试验组/对照组人数 |

⚠️ **\`binary\` 块填了事件数就必须同时填例数（分母）——这是实测最大的一块整列漏抽。**
实测 224 篇里，**二分类结局的"每组例数"我们一处都没抽到**（金标准有值 109 处：疗程结束 89、随访 12、基线 8），
而事件数抽得出来。原因是过去只把"四件套"的要求写在了 \`continuous\` 上。规则：

- \`binary.experimentalN\` / \`controlN\` = **该时点该组的总人数（分母）**，**不是事件数**；
- 分母的常见来源，按优先级找：
  1. 表格表头/列头的人数（\`Real acupuncture (n=177)\`、\`placebo (n=176)\`）；
  2. 只给了率与事件数时**用事件数 ÷ 率反推并取整**（\`130 patients (73.5 %)\` → 130/0.735 ≈ **177**）；
  3. 结果正文的流程描述（\`153 participants completed the study\`、\`78 in the IA group\`）；
- 只要填了 \`experimentalEvents\`／\`controlEvents\`，就必须尽力给出对应的 \`experimentalN\`／\`controlN\`；
  真的找不到分母才填 \`NR\`；
- **三个时点都要看**：论文在基线表里给了基线事件数与例数时，\`baseline\` 块也要填（不要只填疗程结束）。

⚠️ **基线也会报告"组间差值"**（基线均衡性比较）。
有的论文在基线表里就给出两组的差值及 95%CI（如 \`baseline difference 17.5 (−18.6 to 51.4)\`）。
**论文在哪里报告，就填在哪个时点**——基线报告的就填 \`baseline.binary.difference*\`，
不要因为"基线不该有疗效差"就整块丢掉。

⚠️ **\`binary\` 块不只是"二分类"**——它同时是**组间效应量**的容器，这是最容易漏的一整块。
**任何结局**（包括 VAS 评分、抑郁量表、生活质量这类连续型量表），只要论文报告了
**两组之差**及其 95%CI，就必须填进 \`binary.differenceEstimate\` / \`differenceCiLower\` / \`differenceCiUpper\`：

\`\`\`
BDI    A   16.41 (8.36)   9.02 (6.92)   0.252   -1.56 (−3.94, 0.83)   ...
             ↑基线            ↑疗程结束      ↑p值    ↑两组之差 (95%CI) ← 这一列要填 difference*
\`\`\`

实测：2015 年 13 个金标准 \`binary\` 块里**全部**是这种"两组之差 (95%CI)"（如 \`-1.56 (−3.94, 0.83)\`），
而我们一次都没填 → 39 个数值全判漏。**别把两组之差当成"二分类"，也别把它填进
\`experimentalEstimate\`/\`controlEstimate\`（那两格是各组自己的值）。**

## JSON 模板（照此结构输出）

\`\`\`json
{
  "baseline": {
    "continuous": {
      "estimateType": { "value": "<1=均数 2=中位数 3=组内差值>", "quote": "<原文>", "confidence": 0.9 },
      "varianceType": { "value": "<1=SE 2=95%CI 3=SD 4=IQR 5=全距 6=P 7=QR>", "quote": "<原文>", "confidence": 0.9 },
      "experimentalEstimate": { "value": "<数值>", "quote": "<原文>", "confidence": 0.9 },
      "experimentalCiLower": { "value": "<变异值下限；SD/SE 等单值型就填这个>", "quote": "<原文>", "confidence": 0.9 },
      "experimentalCiUpper": { "value": "<变异值上限；单值型留空>", "quote": "<原文>", "confidence": 0.9 },
      "experimentalN": { "value": "<例数>", "quote": "<原文>", "confidence": 0.9 },
      "controlEstimate": { "value": "<数值>", "quote": "<原文>", "confidence": 0.9 },
      "controlCiLower": { "value": "<变异值下限>", "quote": "<原文>", "confidence": 0.9 },
      "controlCiUpper": { "value": "<变异值上限>", "quote": "<原文>", "confidence": 0.9 },
      "controlN": { "value": "<例数>", "quote": "<原文>", "confidence": 0.9 }
    },
    "binary": {
      "experimentalEvents": { "value": "<人数>", "quote": "<原文>", "confidence": 0.9 },
      "experimentalN": { "value": "<例数>", "quote": "<原文>", "confidence": 0.9 },
      "controlEvents": { "value": "<人数>", "quote": "<原文>", "confidence": 0.9 },
      "controlN": { "value": "<例数>", "quote": "<原文>", "confidence": 0.9 },
      "differenceEstimate": { "value": "<两组之差；任何结局类型都要填>", "quote": "<原文>", "confidence": 0.9 },
      "differenceCiLower": { "value": "<差值的 95%CI 下限>", "quote": "<原文>", "confidence": 0.9 },
      "differenceCiUpper": { "value": "<差值的 95%CI 上限>", "quote": "<原文>", "confidence": 0.9 }
    }
  },
  "endOfTreatment": { "...同 baseline 结构，无数据则整个省略..." },
  "followUpEnd": { "...同 baseline 结构，无数据则整个省略..." }
}
\`\`\`

> 注：\`continuous\` / \`binary\` / \`categorical\` 三类**只保留适用的那一类**。
> 等级资料用第三类（\`categorical\`，键为 classificationMethod 与 cat1～cat6、试验组/对照组各一组）。
`;
}

/** 比较组层：按上游规划**逐个比较组**抽取时的任务说明（拼在材料之后）。 */
function comparisonTaskPrompt() {
  return `## 本次任务：只抽取**这一个比较组**的全部字段

上游已判定本文的比较组清单，本次只处理其中第 **{{INDEX}}** 个：

> 试验组干预：{{INTERVENTION}}
> 对照组干预：{{CONTROL}}

请只输出**这一个比较组**的设计与针刺方案字段（随机方法、分配隐藏、盲法、针刺参数、例数等），
放在 \`comparison\` 对象里。**不要**输出其他比较组，也不要输出 \`comparisons\` 数组。

## JSON 模板（照此结构输出）

\`\`\`json
{
  "comparison": {
${jsonTemplate(COMPARISON_FIELDS).split('\n').slice(1, -1).join('\n')}
  }
}
\`\`\`
`;
}

/* ---------------------------- 研究设计规划（上游 SKILL） ---------------------------- */

function studyPlanPrompt() {
  return `${COMMON_PREAMBLE}

## 你的角色：先做"研究设计与结局的规划"，再交给下游 SKILL 抽取细节

比较组级与结局级的字段很多（比较组 70 个、结局每个时点 30 余个），
**一次性既判断结构又填细节容易出错**。所以这里只做一件事：**把结构说清楚**。

只在本次回答下列问题，**不要**抽取任何设计细节（随机方法、盲法、针刺参数等都不必填）：

1. 这篇论文一共有几个组？其中试验组几个、对照组几个？
2. 每个组的**定位**是什么？（实验组/对照组，以及它在论文里的名称与干预）
3. 一共有几个**比较组**（= 试验组 × 对照组的配对）？每一对是"谁 vs 谁"？

## 材料说明
只给了摘要与方法学章节（不含表格）。组别与分组方式通常在方法学里写成一段话
（如 \`participants were randomly assigned to group 1 (…) or group 2 (…)\`），据此判断。

## 字段定义

- **groupCount**：总组数（数值）。
- **experimentalGroupCount** / **controlGroupCount**：试验组数 / 对照组数（数值）。
- **comparisonCount**：比较组数量（数值）。双臂设计=1；三臂（1 试验 + 2 对照 或 2 试验 + 1 对照）=2；
  以此类推。**这是下游 SKILL 决定抽几组数据的依据，务必数清楚。**
- **比较组的口径**：每个比较组 = **一个试验组 vs 一个对照组**。
  三臂试验（A 试验组 / B 安慰针对照 / C 常规治疗对照）应列 **2** 个比较组
  ——「A vs B」和「A vs C」，**都是同一个试验组分别去比不同的对照**。
  ❌ **不要列出「对照组 vs 对照组」**（如「安慰针 vs 常规治疗」）：三个组的两两组合会多出这一类，
  它不属于本系统评价的比较组，还会把下游的比较组编号整体后移、让所有结局行错位。
  因此**先把每个组标成试验组/对照组，只在"试验组 + 对照组"之间配对**。
- **排序**：先「试验组 vs 假针/安慰剂对照」，再「试验组 vs 常规治疗/其他对照」；
  同一类型时按论文里组别出现的顺序。金标准就是这个顺序，顺序决定下游每一行结局的归属。
- **groups[]**：每个组一个对象：
  - \`label\`：组在论文里的名称（照抄，如 individualised acupuncture (IA)）；
  - \`role\`：填 \`experimental\`（接受针刺/待评干预）或 \`control\`（对照/假针/等待组）；
  - \`description\`：该组接受的干预（含合并治疗），照抄原文要点。
- **comparisons[]**：每个比较组一个对象：
  - \`label\`：如 \`IA vs SA\`；
  - \`intervention\`：试验组在该比较中的干预（完整描述，含合并治疗）；
  - \`control\`：对照组在该比较中的干预（完整描述，含合并治疗）。

${OUTPUT_RULES}

## JSON 模板（照此结构输出，键名必须完全一致）

\`\`\`json
{
  "groupCount": { "value": "<数值>", "quote": "<原文>", "confidence": 0.95 },
  "experimentalGroupCount": { "value": "<数值>", "quote": "<原文>", "confidence": 0.95 },
  "controlGroupCount": { "value": "<数值>", "quote": "<原文>", "confidence": 0.95 },
  "comparisonCount": { "value": "<数值>", "quote": "<原文>", "confidence": 0.95 },
  "groups": [
    {
      "label": { "value": "<组名，照抄>", "quote": "<原文>", "confidence": 0.95 },
      "role": { "value": "<experimental 或 control>", "quote": "<原文>", "confidence": 0.95 },
      "description": { "value": "<该组干预>", "quote": "<原文>", "confidence": 0.9 }
    }
  ],
  "comparisons": [
    {
      "label": { "value": "<如 IA vs SA>", "quote": "<原文>", "confidence": 0.9 },
      "intervention": { "value": "<试验组干预（完整，含合并治疗）>", "quote": "<原文>", "confidence": 0.9 },
      "control": { "value": "<对照组干预（完整，含合并治疗）>", "quote": "<原文>", "confidence": 0.9 }
    }
  ]
}
\`\`\`

## 常见错误（务必避免）
- ❌ 把臂数当比较组数：三臂试验（IA / SA / 等待组）若论文做了 IA vs SA 与 IA vs 等待 两组比较，
  应填 comparisonCount=2、groups 有 3 个。
- ❌ 列出「对照组 vs 对照组」（如 安慰针 vs 等待组）：这不是比较组，会挤掉下游的行归属。
- ❌ 漏掉"仅参与对照、未与试验组配对"的组。
- ❌ 用缩写代替完整干预描述（IA 要写成 individualised acupuncture 并保留合并治疗）。
- ❌ 顺手把随机方法、盲法等细节也填进来（本次不要，下游 SKILL 会抽）。
`;
}

/* ---------------------------- 结局指标规划（上游 SKILL） ---------------------------- */

function outcomePlanPrompt() {
  return `${COMMON_PREAMBLE}

## 你的角色：只找出论文**自己声明**的结局指标，不抽任何数值

下游 SKILL 会拿着这份清单逐条抽取数值，所以清单必须**忠于论文的声明**：
多列一条会带来几十个错误字段，少列一条会丢掉整个结局。

## 只找这六类结局（**按需求的硬约束**）

结局层**只针对下面六类**患者重要结局；每条都必须能归入其中一类，并给出 \`outcomeClass\`：

| 类别码 | 类别 |
|---|---|
| \`1\` | 疼痛类 |
| \`2\` | 非疼痛症状类结局 |
| \`3\` | 功能类结局 |
| \`4\` | 生活质量类结局 |
| \`5\` | 重要事件类结局（复发、再入院、再插管、妊娠、并发症等） |
| \`6\` | 死亡率 |

- 能归入六类的 → 放进 \`outcomes\`，\`outcomeClass\` 填上表类别码；
- **归不进任何一类**的指标（合并用药、就诊次数、成本、依从性、无法归类的量表分项等）
  → 放进 \`otherOutcomes\`（字段结构相同，\`outcomeClass\` 填 0）。
  这些会**被记录下来交人工判断是否纳入**，不参与自动数值抽取。
- 两处都要列全；拿不准时倾向于放进 \`otherOutcomes\`（宁可交人工，不要污染六类）。

## 判定依据（只认这两处）

1. **主要结局声明**：如 \`The primary outcome was …\`；
2. **次要结局声明**：如 \`Secondary outcomes included …\` / \`Secondary outcome measures were …\`。

这两处通常在**摘要或方法学章节**。

## 收哪些、不收哪些（**本 SKILL 的关键判断**）

**要收**：主要结局与次要结局里，**有明确测量量表/工具**的指标
（如 PainVAS、HDRS、SF-12、FIQ、RQLQ 这类有名字的量表）。

**不要收**（实测这些正是"多列"的来源）：

- \`Subsequent outcomes measured were …\` / \`Other outcomes\` / \`Exploratory\` / \`Post hoc\` /
  \`Secondary analysis\` 引出的指标——它们**不是** primary/secondary outcome；
- **资源使用类**指标：合并用药、就诊次数、住院天数、成本、依从性——
  没有测量量表，属过程/卫生经济学指标（除非它被明确写成 primary outcome）；
- 结果表/正文里额外报告的**量表分项**（FIQ 的 fatigue、night rest、stiffness…；SF-36 的 8 个维度）；
- 基线特征、不良事件、退出/依从性；亚组分析、相关性分析。

判断口诀：**"这句是 primary/secondary 声明吗？这个指标有量表吗？"**
两个都 yes 才收。

## 输出字段

- **outcomes[]**：能归入上述六类的结局，每个一个对象：
  - \`outcomeName\`：测的是**什么**（症状/构造/指标名，如 pain intensity、level of depression、health-related quality of life）；
  - \`instrument\`：用**什么**测。**固定写成 \`缩写: 全称\` 两段式**——金标准的主导形式就是这个，
    只写一半会被判"含义一致但写法不同"（实测 21 组措辞差异里 8 组只差这一件事）：
    - ✅ \`HDRS: Hamilton Depression Rating Scale\`
    - ✅ \`MBI: Modified Barthel Index\`、\`FSS: Fatigue Severity Scale\`、\`SSA: Standardized Swallowing Assessment\`
    - ✅ \`VAS: Visual Analogue Scale\`、\`EQ-5D: EuroQol-5 Dimension\`、\`BDI: Beck Depression Inventory\`
    - ✅ 分量表把维度写在冒号后：\`SF-12: Physical component summary\` / \`SF-12: Mental component summary\`
    - ❌ 只写缩写（\`HDRS\`）或只写全称（\`Modified Barthel Index\`）
    - ❌ 带原文的序号与前缀：\`3. BDI, Beck depression inventory;\`、\`SF12:①Physical\`、\`1. swallowing,\`
    - ❌ 缩写里插空格（\`SWAL- QOL\` → \`SWAL-QOL\`）
    - ❌ 泛化描述（\`4-point scale\`、\`questionnaire\`）
  - \`outcomeName\`：**名词短语**（≤6 个词）说明"测的是什么"（如 \`pain intensity\`、\`level of depression\`、
    \`quality of life\`、\`fatigue severity\`）。不要整句、不要时间点（\`at 10 weeks\`）、不要 \`change in\` 前缀；
    **用论文自己的指标名，不要自造上位词**：
    - ✅ 论文写 \`Juniper 4 point symptom scores\` / \`sneezing score\` → 名称就用 \`sneezing score\` 这类论文自己的叫法；
    - ❌ 把它概括成 \`SAR symptom severity\`（论文里没有这个说法）——自造名会让金标准那一行对不上，
      实测 2015-02 因此整篇错位（85 个数值全判漏）；
  - \`outcomeClass\`：上表的类别码（1~6）；
  - \`anchor\`：**声明它的那句原文**（逐字复制 primary/secondary outcome 那句话，可截取相关片段）。
    下游会用这句话核对"该结局确实是被声明的"；**给不出声明句的条目会被丢弃**。
    ⚠️ 声明句里常**用缩写**列举（\`Secondary outcomes were QoL, global change, …\`）——
    此时按缩写对应的全称逐条展开（\`QoL\` → 生活质量（RQLQ(S)）），**不要因为它们只是缩写就漏掉**。
- **otherOutcomes[]**：归不进六类的候选（同样填 outcomeName/instrument/anchor，outcomeClass 填 0）。
- **declarationFound**：是否找到了明确的 primary/secondary outcome 声明句（true/false）。

${OUTPUT_RULES}

## JSON 模板（照此结构输出，键名必须完全一致）

\`\`\`json
{
  "declarationFound": { "value": "true 或 false", "quote": "<声明句原文；没有就填 NR 并给摘要里最接近的句子>", "confidence": 0.95 },
  "outcomes": [
    {
      "outcomeName": { "value": "<测的是什么>", "quote": "<原文>", "confidence": 0.95 },
      "instrument": { "value": "<用什么测，量表专有名>", "quote": "<原文>", "confidence": 0.95 },
      "outcomeClass": { "value": "<1~6>", "quote": "<原文>", "confidence": 0.95 },
      "anchor": { "value": "<primary/secondary outcome 声明句，逐字>", "quote": "<同左>", "confidence": 0.95 }
    }
  ],
  "otherOutcomes": [
    {
      "outcomeName": { "value": "<归不进六类的指标>", "quote": "<原文>", "confidence": 0.9 },
      "instrument": { "value": "<量表或测量方式>", "quote": "<原文>", "confidence": 0.9 },
      "outcomeClass": { "value": "0", "quote": "<原文>", "confidence": 0.9 },
      "anchor": { "value": "<出处原文>", "quote": "<同左>", "confidence": 0.9 }
    }
  ]
}
\`\`\`

## 常见错误（务必避免）
- ❌ 把结果表里出现的所有指标都列进来（这是最常见的错误）。
- ❌ 同一个量表的不同维度算成一条（SF-12 physical 与 mental 是两条——它们在声明句里被分别列出时）。
- ❌ \`anchor\` 填自己编的句子：必须是材料里**逐字存在**的声明句，否则该条目会被系统丢弃。
- ❌ 一条都没声明时凭空编造（此时 declarationFound 填 false，outcomes 只列摘要明确提到的指标）。
`;
}

/* ---------------------------- 事后验证（查漏补缺） ---------------------------- */

function outcomeAuditPrompt() {
  return `${COMMON_PREAMBLE}

## 你的角色：**事后核查员**

结局层已经由前一道 SKILL 抽过一轮。现在请你拿**论文材料**与**已抽取的结果**逐项对照，
找出两类问题：

1. **遗漏（gaps）**：论文里报告了、但已抽取结果里**没有**的结局 / 时点 / 数值；
2. **不符（suspects）**：已抽取的值与论文材料**对不上**（数值错、时点错、把别的指标混进来）。

## 重点核查这几类（实测最常漏）

- **例数**：效应量与 CI 多来自表格，而例数常写在**正文**（\`A total of 164 participants…\`、
  \`153 completed\`、CONSORT 流程描述）——表格里没有就回正文找；
- **95%CI 的上下限**：只抽到一半（有下限没上限）是最常见的；
- **每个结局的每个时点**（baseline / end_of_treatment / follow_up_end）是否都给了值；
- **时点归属**：6 个月/12 个月的随访不要算成"疗程结束"。

## 输出字段

- \`gaps[]\`：每条给出
  - \`outcomeName\`：属于哪个结局（用已抽取结果里的名称，若是一个全新结局则填论文里的名称）；
  - \`timepoint\`：\`baseline\` / \`endOfTreatment\` / \`followUpEnd\`（非时点字段可省略）；
  - \`field\`：要补的键。时点块内用这些键名：\`experimentalEstimate\`、\`experimentalCiLower\`、
    \`experimentalCiUpper\`、\`experimentalN\`、\`controlEstimate\`、\`controlCiLower\`、\`controlCiUpper\`、\`controlN\`；
    结局级用 \`followUpDescription\`/\`followUpValue\`/\`followUpUnit\`；
  - \`value\`：该值（只填数值本身，如 \`78\`）；
  - \`quote\`：**逐字复制**自材料的证据片段（必须能定位，否则该条会被丢弃）。
- \`suspects[]\`：同上结构，但 \`value\` 填**你认为正确的值**，并在 \`reason\` 里说明原值错在哪。
- \`notes[]\`：其他需要人工注意的说明（字符串数组）。

${OUTPUT_RULES}

## JSON 模板

\`\`\`json
{
  "gaps": [
    {
      "outcomeName": "<结局名称>",
      "timepoint": "endOfTreatment",
      "field": "experimentalN",
      "value": "78",
      "quote": "<逐字原文>",
      "confidence": 0.9
    }
  ],
  "suspects": [
    {
      "outcomeName": "<结局名称>",
      "timepoint": "followUpEnd",
      "field": "controlCiUpper",
      "value": "<正确值>",
      "reason": "原值写成了另一个时点的数",
      "quote": "<逐字原文>",
      "confidence": 0.8
    }
  ],
  "notes": ["<需要人工注意的说明>"]
}
\`\`\`

## 常见错误（务必避免）
- ❌ 把"已抽取结果里本来就有"的值再报一遍（那不算遗漏）；
- ❌ 报告无法给出 quote 的"疑似"——没有原文支撑的条目会被系统丢弃；
- ❌ 借机重新抽一遍全部内容（只报**差异**，否则等于白花一遍成本）。
`;
}

/* ---------------------------- 生成与写盘 ---------------------------- */

const prompts = {
  article: articlePrompt(),
  comparison: comparisonPrompt(),
  outcome: outcomePrompt(),
  /** 数值层：只抽「结局 × 时点」数值的系统提示词 */
  outcomeValue: outcomeValuePrompt(),
  outcomeListTask: outcomeListTaskPrompt(),
  outcomeItemTask: outcomeItemTaskPrompt(),
  /** 数值层：任务说明（逐结局抽「结局 × 时点」数值） */
  outcomeValueTask: outcomeValueTaskPrompt(),
  studyPlan: studyPlanPrompt(),
  outcomePlan: outcomePlanPrompt(),
  outcomeAudit: outcomeAuditPrompt(),
  comparisonTask: comparisonTaskPrompt(),
};

for (const [level, text] of Object.entries(prompts)) {
  writeFileSync(join(OUT_MD, `${level}.md`), text, 'utf8');
}

/** 生成 TS 模块。 */
function tsString(s) {
  return JSON.stringify(s);
}

const ts = `// 本文件由 tools/prompt_gen.mjs 自动生成，请勿手工编辑。
// 真源：tools/canonical-field-map.mjs（字段含义/要求/编码）
// 重新生成：pnpm prompts
//
// 生成时间无关紧要，内容只取决于字段清单。

/** 各层级的 LLM 系统提示词。 */
export const PROMPTS = {
  article: ${tsString(prompts.article)},
  comparison: ${tsString(prompts.comparison)},
  outcome: ${tsString(prompts.outcome)},
  /** 数值层：只抽「结局 × 时点」数值（不含结局元信息图例，篇幅集中在取数列规则） */
  outcomeValue: ${tsString(prompts.outcomeValue)},
  /** 上游：研究设计规划（几个组、各组定位、几个比较组） */
  studyPlan: ${tsString(prompts.studyPlan)},
  /** 上游：结局指标规划（论文自己声明的结局清单） */
  outcomePlan: ${tsString(prompts.outcomePlan)},
  /** 事后：结局层查漏补缺核查 */
  outcomeAudit: ${tsString(prompts.outcomeAudit)},
} as const;

/**
 * 结局层分步调用，这几段是【用户消息末尾的任务说明】（拼在材料之后）。
 *
 * 为什么放用户消息而不是系统提示：材料在前、任务在后，同一篇论文的多次调用
 * 共享「系统提示 + 材料」这个前缀，服务端的上下文缓存可以命中，省时省钱。
 *
 * 分工：\`list\` 枚举结局 → \`item\` 抽结局自身字段 → \`value\` 抽「结局 × 时点」数值。
 * \`item\` 与 \`value\` 拆开是因为两套规则都很长，混在一起会互相挤占（数值规则会盖掉字段图例）。
 */
export const OUTCOME_TASKS = {
  list: ${tsString(prompts.outcomeListTask)},
  item: ${tsString(prompts.outcomeItemTask)},
  value: ${tsString(prompts.outcomeValueTask)},
} as const;

/**
 * 比较组层：上游 study-plan 判定出比较组清单后，**逐个比较组**抽取时的任务说明。
 * 同样拼在材料之后（省缓存、且每个响应都足够小，不会撞输出上限）。
 */
export const COMPARISON_TASK = ${tsString(prompts.comparisonTask)};

export type PromptLevel = keyof typeof PROMPTS;

/** 哨兵值约定，校验器与提示词必须保持一致。 */
export const SENTINELS = ${JSON.stringify(Object.fromEntries(SENTINELS), null, 2)} as const;
`;
writeFileSync(OUT_TS, ts, 'utf8');

/* 摘要 */
console.log(`提示词已生成：\n`);
for (const [level, text] of Object.entries(prompts)) {
  const fieldCount = level === 'article'
    ? ARTICLE_FIELDS.length
    : level === 'comparison'
      ? COMPARISON_FIELDS.length
      : level === 'outcome'
        ? OUTCOME_TOP_FIELDS.length
        : level === 'outcomeValue'
          ? TIMEPOINT_FIELDS.length
          : OUTCOME_TOP_FIELDS.length + TIMEPOINT_FIELDS.length;
  console.log(`  ${level.padEnd(14)} ${String(text.length).padStart(6)} 字符  字段/键 ${fieldCount}`);
}
console.log(`\n  Markdown: ${OUT_MD}`);
console.log(`  TS 模块:  ${OUT_TS}`);
console.log(`\n  文章级含 Sheet2 结局分类字段: ${STUDY_OUTCOME_FIELDS.length} 个`);
