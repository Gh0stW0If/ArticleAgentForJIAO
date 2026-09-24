# SKILL 层设计 + LLM 接口 + Crossref

> 状态：`@aa/skills`、`@aa/crossref` 完成。`pnpm check` = 89 测试通过 + 4 包类型检查通过。

## 1. 包结构（4 个）

```
packages/
  core/      @aa/core      契约：Evidence / FieldValue / 三层结果 / ID 语法 / 表格网格
  ingest/    @aa/ingest    MinerU _middle.json → MiniDoc
  crossref/  @aa/crossref  Crossref 客户端 + 元信息校验
  skills/    @aa/skills    SKILL 层 + LLM 接口（留空）+ 落地/图例/材料裁剪
```

## 2. 最关键的设计：模型不产出坐标

```
模型回传:  { value: "fibromyalgia", quote: "diagnosed with fibromyalgia", confidence: 0.95 }
              ↓  grounding 层本地定位
落地:      { raw: "fibromyalgia", evidence: [{ page: 1, bbox: [275,308,574,354], quote: "..." }], ... }
```

**为什么必须这样**：模型看不到页面坐标，让它给坐标必然编造。所以约定模型只回传
`quote`（逐字原文片段），坐标由本地 `locateEvidence()` 在 MiniDoc 里定位。

配套的**防幻觉**机制（`grounding.ts`）：
- 无 `quote` → 直接拒绝入库，转入 `unresolved`；
- `quote` 在文档里定位不到 → 拒绝（判定为幻觉），**不伪造坐标**；
- 定位带**降级窗口**：模型常回传"比原文更规范"的 quote。实测原文里 DOI 因排版被拆成
  `http://dx.doi.org/10.1136/ acupmed-2015-010950`（中间有空格），模型回传无空格版本，
  整串匹配会失败。因此整串失败后改用中间切片、再改后半段重试；
- 仍失败就放弃 —— **不会退回"用整块当证据"**，避免把块内无关内容算作证据。

## 3. LLM 接口留空（`packages/skills/src/llm.ts`）

按要求只定义契约与桩实现：

| 导出 | 用途 |
|---|---|
| `createStubLlm()` | 桩：任何调用**显式抛 `LlmNotConfiguredError`**。测试可离线跑通全链路 |
| `createLlmRecorder(entries)` | 录制/回放：把真实模型历史响应存盘，之后离线回放（评估需要可复现） |
| `requestKey(req)` | 请求指纹（FNV-1a），录制与回放对齐用 |

**为什么桩要抛错而不是返回空**：假成功会让流水线在没接模型时产出看似正常的空结果，
掩盖问题。宁可在需要模型的那一步显式失败。

### 未来接入的交接契约（写在代码注释里）
1. **结构化输出**：请求会带 `schema`；实现应使用模型的 JSON mode / tool calling，
   把解析结果放进 `LlmResponse.json`，不要塞在自由文本里让上层正则。
2. **禁止模型给坐标**：只要求 `quote` + 值。
3. **必须回传 quote**：无 quote 的字段会被本地拒绝。
4. **可复现**：记录 `model` 与采样参数，支持固定种子。
5. **失败要抛错**，不要返回空结果。

## 4. 抽查的 LLM 提示词要点

`article-meta.ts` 的 system prompt 里写死了几条硬约束（因为它们是本设计的成立前提）：
- 每个字段必须回传 quote，逐字复制，不得改写/翻译/补全；
- 材料中没有的信息**不要猜**，省略该字段或用 `NR` + 能证明"未报告"的 quote；
- **只依据所给材料作答，不得使用对该论文的既有记忆**；
- 材料每段带锚点 `[[b12|p3]]`（块号|页码）；
- 只抽取该论文自身元信息，**不要抽取参考文献的**。

## 5. 分工原则：可判定的交给代码

| 环节 | 谁做 | 理由 |
|---|---|---|
| 读懂原文（期刊名、国家、疾病名） | 模型 | 自由文本理解 |
| **受控编码映射** | **本地确定性**（`legend.ts`） | "3" 和 "5" 长得太像，人工极难发现；而它恰是最能用规则做对的一环 |
| 坐标定位 | 本地 | 模型看不到坐标 |
| DOI 形态校验 | 本地 | 挡掉正文正则捞到的脏值 |
| Crossref 校验 | 本地 | 确定性比较 |

`legend.ts` 已录入**已核验的 20 个字段图例**（来源标注到具体单元格，如
`2015 Sheet1 第1行 S 列`）。未登记的字段 `decode()` 返回 `method:'none'` 并说明缺图例——**不猜**。

### 一个刻意的保守行为
`conditionSystem`（疾病系统，图例为 `1=肌肉骨骼和结缔组织疾病 …`）在实践中**解不出来**：
论文写的是具体疾病名（`fibromyalgia`），而图例给的是系统类别。把前者映射到后者需要医学知识，
属于**语义映射**，不是字符串匹配能可靠解决的。

因此解码器拒绝猜，如实记 `CODE_DECODE_FAILED`，让字段留空并可被人工/后续步骤处理——
而不是产出一个看似正确、实则可能错误的编码（这类错误极难被发现）。
测试把这个行为**固定下来**作为规格。

## 6. Crossref（需求 4）

### 客户端（`client.ts`）
- `byDoi(doi)`：取权威元信息；**404 返回 null 而非抛错**（DOI 不存在是正常情况）；
- `byTitle(title, {year})`：按题名反查候选，带年份 `from-pub-date/until-pub-date` 过滤；
- **礼貌池**：构造时强制要求合法 `mailto`，请求同时带 `mailto` 参数与 UA；
- **限流与重试**：429/5xx/网络错误指数退避重试，`stats` 暴露 `requests/retries/rateLimited`；
- **网络层可注入**（`fetchImpl`），测试不打真实网络。

### `isLikelyDoi` 的坑（实测）
最初的 `^10\.\d{4,9}\/\S+$` **不够**：`\S+` 会把域名一起吃掉，导致实测脏值
`10.1136/acupmed-2015-010950group.bmj.com`（正文文本流拼接产物）被判为合法。
现在额外要求：后缀以字母/数字结尾、不含域名片段、只含 DOI 规范字符。
（同时把后缀长度下限设为 1 —— `10.1136/bmj` 这类短后缀是合法的。）

### 校验（`verify.ts`）
比对 PDF 内取值 vs Crossref 权威记录，逐字段给 `match / partial / mismatch / unverifiable`：

| 字段 | 容错策略 |
|---|---|
| title | 词级 + 字符级 Dice 取大者（对纯标点差异给 >0.95） |
| journal | 字符 Dice + **缩写签名兜底**（`Acupunct Med` ↔ `Acupuncture in Medicine`） |
| year | 严格相等，但**不一致时给出"语料年份≠发表年份"的说明** |
| authors | 全名或**姓氏命中**即算 match |
| doi | 归一化后严格相等 |

**关键立场：不自动"修正"，只判定 + 记录。** 数据里真实存在跨年份 ID 笔误这类问题，
自动改写会掩盖问题且不可审计。

`pickBestCandidate()`：从标题反查候选中择优（相似度优先，同分时年份一致者优先）；
**全部低于阈值时返回 null**，不"随便选一个"。

## 7. 测试（89 个，期望值来自真实数据）

| 包 | 数量 | 重点 |
|---|---|---|
| core | 17 | 证据不变量、ID 语法、表格网格 |
| ingest | 18 | 真实 MinerU 产物集成 |
| crossref | 26 | DOI 规范化、限流重试、校验容错、候选择优 |
| skills | 28 | 图例解码、grounding 防幻觉、材料裁剪、SKILL 端到端 |

几个值得注意的**反面用例**（确保系统不会"自作聪明"）：
- 模型不给 quote → 字段被拒，进 `unresolved`；
- quote 是幻觉 → 被拒；
- DOI 形态非法 → 丢弃并记 issue；
- 标题反查全部低于阈值 → 返回 null，不猜；
- 图例解不出编码 → 记 `CODE_DECODE_FAILED`，字段留空；
- Crossref 网络失败 → 降级为 warning，**不拖垮整个 SKILL**。

## 8. 工程坑（本轮）

1. **`rootDir` 与 tsconfig `paths` 冲突**：path 映射把 `@aa/core` 的源码也纳入程序，
   超出本包 `rootDir` → 报 TS6059。解决：构建配置 `paths: {}`（构建时走 workspace 依赖解析），
   类型检查配置保留 paths（走源码，无需先构建）。
2. **`exactOptionalPropertyTypes: true` 很严格**：`string | undefined` 不能赋给可选 `string`。
   暴露了 `work.authors[0]`、`payload[from]` 这类缺守卫的写法。
3. **测试用 `RequestInfo` 需要 lib.dom**：改用 `Parameters<typeof fetch>[0]`，不引入 DOM 类型。

## 9. 待办

1. **图例自动生成**：`legend.ts` 目前手录了 20 个字段。完整图例应从
   `Datas/label/*.xlsx` 第 1 行与单元格批注**自动提取**后合并——手抄不可持续且易错。
2. **其余 SKILL**：`comparison`（比较组级设计/针刺方案）、`outcome`（结局级数值，需表格材料）。
3. **章节路由补强**：目前是关键词启发式，未命中项应记 warning。
4. **SKILL 编排器**：按依赖拓扑排序、合并各 SKILL 产出为 `ExtractionDocument`、跑 `auditEvidence`。
5. **前端**：PDF 查看 + 框选证据（注意 `rotate: 90` 的画布处理）。
