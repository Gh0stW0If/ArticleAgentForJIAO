# 图例/批注自动提取 + 提示词生成

> 真源：`tools/canonical-field-map.mjs`（人工维护，含义/要求/编码）
> 工具：`pnpm legend`（图例+批注提取）、`pnpm prompts`（提示词生成）
> 产物：`build/legend/*.json`、`build/prompts/*.md`、`packages/skills/src/prompts.generated.ts`

## 1. 为什么必须合并「图例行 + 单元格批注」

金标准的填写规范分散在两处，**任一处都不完整**：

| 位置 | 内容 |
|---|---|
| **图例行**（Sheet1 R1；Sheet3 R1~R4 + R5 编码行） | 编码 → 含义 |
| **单元格批注**（266 条） | 人工填写要求、优先级规则、**图例没写全的判定标准** |

**最能说明问题的实例**（V2 国家分类）：

```
图例行只写：  1=东方  2=西方          ← 无法判定某个国家属于哪边
批注 V2 补全：1=东方：亚洲国家  2=西方：非亚洲国家   ← 这才是可执行的判据
```

其他高价值批注：

| 位置 | 批注内容 |
|---|---|
| `B2` 文献编号 | `中文编号格式CH001 英文编号格式EN001` |
| `K2` 期刊分类 | 英文期刊查附录1；中文期刊：中医药类=1，非中医药类=2 |
| `S2` 疾病系统 | 可参考「附录3-疾病系统分类」，也可参考 **ICD-11** |
| `T3` 变异值类型 | **报告多个者只选 1 个；按 1→7 顺序依次优选（有 SE 和 CI 时只取 SE）** |
| `E1` 特殊数据情况 | `1=无法确定数据 2=等级资料无法转化二分类 3=等级转二分类 4=排除` |
| `DC1` 随访时间 | 两位提取人先商量确定随访时间点，再提取；从治疗结束后开始计算 |

批注作者分布：Administrator 176、gangweijuan 77、mary 11、huaweiuser 2。

**规模**：Sheet1 每年 9 条、Sheet3 每年 15 条（2019 另有 Sheet2 1 条），共 **266 条**。
去重后落在约 **24 个字段**上。

## 2. 提取器（`pnpm legend`）

输出 `build/legend/<year>.json` 与 `_merged.json`（跨年合并）。

### 踩过的坑（都已在代码注释中标注）

| # | 坑 | 现象 | 修正 |
|---|---|---|---|
| 1 | **表头行误判** | 早期把"数据行之前的行"全当表头，2020+ 因列位移把**数据行**当表头，产出 `field="15"`、`field="age 48.82±13.29"` 这类垃圾 | 表头行改为**固定骨架**（Sheet1=[1,2]、Sheet2=[1]、Sheet3=[1..5]），实测 10/11 年份一致 |
| 2 | **2023 特殊结构** | 2023 Sheet1 在字段名行(r2)与数据(r18)之间**插了 15 行图例编号行**(r3..r17)，自动探测会把这些行当表头，把 G 列的论文标题当字段名 | 骨架化后按【标签锚定】定位实际列，与金标准归一化器同一套做法 |
| 3 | **批注列偏移方向搞反** | 曾以为"批注停在 2015 坐标而字段右移了"，据此加偏移，结果把正确归属改错 | 澄清：**批注坐标写在本年份自己的工作表坐标系里**，不需平移 |
| 4 | **`parseCodes` 格式覆盖不足** | 只支持 `1=xxx`，导致「疾病系统」的 18 类（写成 `1.肌肉骨骼…`）**全部漏掉** | 支持三种写法：`1=x`、`1.x`、`2 =x`；并排除 `0.001`/`1.5` 这类小数 |
| 5 | **批注里的普通编号被当成图例** | `S2` 批注正文是 `1.可参考附录3…2.可参考ICD-11.`，被解析成 `{1:…,2:…}` 并**覆盖**了正确的 18 类图例 | 加质量门槛 `isLegendBlock`：条目 ≥4，或编码是从 0/1 起的连续序列 |

> 坑 5 说明一个通用教训：**"能解析出结果"不等于"解析对了"**。质量门槛比宽松匹配更重要。

### 已验证的提取质量

```
疾病系统   18 类，1..18 完全正确
对照组类型  6 类，正确
国家分类   3 类（图例行），判定标准由批注提供
```

## 3. 规范字段清单（`tools/canonical-field-map.mjs`）

**这是提示词与 SKILL 的唯一真源。** 每个字段记录：
`key`（稳定英文 JSON 键）、`label`（金标准中文表头/编码名）、`code`（Sheet3 编码名）、
`source`（`llm` / `gold_meta`）、`codes`（允许取值）、`requirement`（批注要求）、`desc`（字段含义）。

为什么需要它：金标准的中文表头不适合直接当 JSON 键（不稳定、难写代码）；
`source: 'gold_meta'` 的字段（文献编号、提取人、复核结论）**不由 LLM 推断**，
提示词会明确要求模型不要输出这些键。

覆盖：文章级 23 + 比较组级 55 + 结局级 25（含三个时点块的重复字段）。

## 4. 提示词生成（`pnpm prompts`）

输出 `build/prompts/{article,comparison,outcome}.md`（人工审阅用）
与 `packages/skills/src/prompts.generated.ts`（SKILL 使用）。

### 提示词的组织（按需求）

| 段落 | 内容 |
|---|---|
| 角色 | 循证医学系统评价数据抽取员 |
| 任务 | 该层级要抽什么、材料说明（带 `[[b块号\|p页号]]` 锚点） |
| **字段定义与填写要求** | 每个字段：**含义**（desc）+ **批注要求**（requirement）+ **允许取值编码表**（codes）+ 依据的批注坐标 |
| **输出格式约束** | 只输出一个 JSON；每字段 `{value, quote, confidence}`；`quote` 必须逐字；有允许取值时必须填编码；不得猜测；不得使用既有记忆 |
| **JSON 模板** | 可直接照抄的完整结构 |
| **常见错误** | 该层级最容易犯的错（如把参考文献的 DOI 当论文自身 DOI） |

### 哨兵约定（三层级统一）

```
"NR" = 文中未报告（not reported）
"NA" = 不适用（如给 TEAS/激光针/穴位按压填进针深度）
"NE" = 文中提到该指标但无法确定数值
```
并要求：填哨兵值时，`quote` 必须给出**能证明"未报告"的原文片段**。

### 关键设计：为什么模型只回传 quote

提示词明确写：

> `quote` 必须是逐字复制自所给材料的片段……**系统会用它在原文中定位坐标；定位失败的字段会被直接丢弃。**

因为模型看不到页面坐标，让它给坐标必然编造。坐标由本地 `locateEvidence()`
在 MiniDoc 里定位（见 `docs/05-skills-and-crossref.md`）。

### 体量

| 层级 | 提示词长度 | 字段/键 |
|---|---|---|
| article | 5.5 K 字符 | 23 |
| comparison | 14.2 K 字符 | 55 |
| outcome | 6.7 K 字符 | 25 |

comparison 最长是因为 55 个字段每个都要带含义 + 编码表。

## 5. 图例一致性校验器（`pnpm legend:audit`）

### 为什么需要它
图例有**三份来源**，会各自漂移：

| # | 来源 | 用途 |
|---|---|---|
| 1 | `tools/legend_extract.mjs` 自动提取 | 审计、发现人工清单遗漏 |
| 2 | `tools/canonical-field-map.mjs` 人工维护 | **提示词与 SKILL 的真源** |
| 3 | `packages/skills/src/legend.ts` 的 `LEGENDS` | 解码器（确定性编码） |

校验器比对三者，输出 `build/legend/_audit.json`，有冲突时退出码 1（可接 CI）。

### 它实际抓到的真实问题

| 问题 | 后果 | 修正 |
|---|---|---|
| `stimulationType` code 4 含义不一致 | 人工清单写 `TEAS（经皮穴位电刺激）`，金标准原文是 `TEAS（transeutaneous electrical acupoint stimulation）` | 改为原文（顺带发现金标准原文把 transcutaneous 拼成了 transeutaneous） |
| `missingDataReported` code 1 含义不一致 | 我写的中文概括 vs 英文原文 | 改为原文 |
| **解码器漏登记 18 个字段** | `estimateType`/`varianceType`/`measurementDirection`/`stimulationIntensity` 等在 (2) 与提示词里都有编码表，却漏登记到 (3) → `decode()` 返回 `none`、**编码推导静默失效且无任何报错** | 见下 |

最后一条是最有价值的发现，也暴露了校验器本身的第一版缺陷：它只比对 (1) vs (2)，**完全没检查 (3)**。

### 修正：消除重复维护

与其手抄 18 个字段到 (3)（必然再次漂移），改为让 `legendFor()` 在 `LEGENDS` 未命中时
**自动回退到 (2) 的清单**：

```ts
const BY_FIELD = new Map<string, LegendEntry>();
for (const l of CANONICAL_LEGENDS) BY_FIELD.set(l.field, l);  // 真源兜底
for (const l of LEGENDS) BY_FIELD.set(l.field, l);            // 本地覆盖措辞
```

`LEGENDS` 现在只保留需要本地化措辞的少量条目。这样**编码表只有一处真源**，
从根上消除 (2)/(3) 之间的漂移。

## 6. 衔接与防回归

`packages/skills/src/article-meta.ts` 已改为使用生成的提示词
（`const SYSTEM_PROMPT = PROMPTS.article`），不再手写。

**防回归测试**（`packages/skills/src/__tests__/prompts.test.ts`）：

> 提示词 JSON 模板里的每个键，都必须在 SKILL 的 `FIELD_MAP` 中登记。

这条测试很关键：提示词与映射表若不同步，模型输出的字段会因"不认识该键"被**静默丢弃**，
且不会有任何报错。

其他测试覆盖：三层提示词都含 JSON 模板/输出约束/哨兵约定/逐字 quote 要求/禁止用既有记忆；
批注要求确实进入了提示词（附录1、ICD-11、亚洲国家）；outcome 的变异值类型优先级规则；
gold_meta 字段被排除。

`packages/skills/src/__tests__/legend.test.ts` 把提取器的关键结论固化为断言：
不得出现"数据值被当成字段名"、疾病系统 18 类、Sheet3 编码跨年不重复、时点块 B/E/F 齐全等。

## 7. 当前测试状态

```
113 tests passed (7 files)   +   4 包类型检查通过
```

| 包 | 测试数 |
|---|---|
| core | 17 |
| ingest | 18 |
| crossref | 26 |
| skills（含 prompts 13 + legend 11） | 52 |

## 8. 待办

1. ~~一致性校验器~~ ✅ 已完成（`pnpm legend:audit`）
2. ~~comparison / outcome SKILL~~ ✅ 已完成
3. **SKILL 编排器**：拓扑排序、合并各 SKILL 产出为 `ExtractionDocument`、跑 `auditEvidence`。
4. **前端**：PDF 查看 + 框选证据（注意 `rotate: 90` 的画布处理）。
5. 短编码表（2~3 条）的批注仍会被质量门槛过滤；当前靠 `canonical-field-map` 兜底，
   语义无损失，但提取器的"发现遗漏"能力在短表上偏弱。
