# Europe PMC 作为第二联网信源

> 目的：记录接入 Europe PMC 的**实测依据**、能力边界与落地方式。
> 一句话：**它对题名有用（补副标题），对通讯作者邮箱没用（反而会引入错误）。**
> 所有数字由 `tools/_europepmc_*.mjs` 直接产出。

## 0. 结论速览

| 问题 | 结论 |
|---|---|
| 为什么接它？ | Crossref 有两处够不着：**题名常缺副标题**、反查候选不够时无兜底 |
| 取回率 | **201 / 222（90.5%）**（按 DOI；无需 API key） |
| **对 `article.title`** | ✅ **有效**（实测）：备份集里触发补全的 **11 篇全部 0.5 → 1.0，退步 0**；全量预测 23 篇触发、20 篇补全后与金标准一致，题名字段加权分 203.5 → 213.5 |
| **对 `author_contact`** | ❌ **无效，且有风险**：EPMC 列的是**每位作者**的邮箱、不含通讯作者标记；"恰好一个邮箱"的 50 篇里只有 **21 篇（42%）**那一个就是金标准 |
| 对 `journal` / `pubYear` | ⚠️ 仅作**第二意见**（不一致只记冲突，不改值）：EPMC vs 金标准 78.1% / 92.0% |
| 落地位置 | `packages/europepmc`（client + verify）+ `article-meta` 步骤 6b + `llm_run` 注入 |

## 1. 为什么需要第二个源：Crossref 的题名常缺副标题

`article-meta` 里 Crossref 本来就覆盖 `title`（`override('title', work.title, 'title')`）。
所以要接新源，必须先证明"Crossref 不够"——对着**当前题名没拿满分**的 27 篇逐篇比：

| 结论 | 篇数 | 占比 |
|---|---|---|
| Crossref 取回失败/无题名 | 0 | 0% |
| **Crossref 题名比 Europe PMC 短** | **20** | **74.1%** |
| Crossref 题名与 EPMC 等长 | 7 | 25.9% |
| Crossref 题名与金标准一致 | 7 | 25.9% |

典型形态（金标准用完整题名）：

| 文章 | 金标准 | Crossref | Europe PMC |
|---|---|---|---|
| 2016-01 | `Acupuncture for Chronic Severe Functional Constipation A Randomized Trial` | `… Constipation` | `… Constipation: A Randomized Trial.` |
| 2016-02 | `Acupuncture for Menopausal Hot Flashes A Randomized Trial` | `… Hot Flashes` | `… Hot Flashes: A Randomized Trial.` |
| 2017-14 | `Effect of Acupuncture and Clomiphene … A Randomized Clinical Trial` | `… Syndrome` | `… Syndrome: A Randomized Clinical Trial.` |

**即：Crossref 的题名常是"主标题"，PubMed（Europe PMC）收录的是含副标题的完整题名，
而金标准用的是后者。** 这就是接入的理由。

（工具：`tools/_epmc_vs_crossref_title.mjs`）

## 2. 明确**不**用它做的：补 `author_contact`

这一条是反直觉的，但数据很硬。Europe PMC 会把**每一位作者**的邮箱附在各自单位后面：

```json
"authorAffiliationDetailsList": { "authorAffiliation": [
  { "affiliation": "… Korea Institute of Oriental Medicine, Daejeon, South Korea. eujuki@gmail.com." } ] }
```

**且不保留通讯作者标记**（PubMed 的 `Electronic address:` 标记在该数据集里没有）。

| 指标 | 数值 |
|---|---|
| 取回成功的篇里**有邮箱**的 | 82 / 203（40.4%） |
| 其中**恰好一个**邮箱 | 50（24.6%） |
| └ **这一个就是金标准邮箱的** | **21 / 50（42.0%）** |
| 金标准有邮箱的 136 篇里，金标准邮箱**出现在** EPMC 列表里 | 31（22.8%） |

三个致命点：

1. **"唯一即采用"会引入 29 个错误**（50 篇里 29 篇那唯一一个不是金标准要的通讯作者邮箱，
   很多篇 PubMed 只收录了第一作者的邮箱）；
2. **"命中 EPMC 列表"没有判别力**：抽到的邮箱命中 EPMC 列表的 78 篇，当前加权正确率只有
   **26.9%**，低于全库基线 38.9%——因为 EPMC 列了每位作者的邮箱，我们抽到的几乎必然在列表里；
3. **EPMC 覆盖的样本恰好是最难的那批**：EPMC 有邮箱的 82 篇加权正确率 25.6%，
   而 EPMC 没有邮箱的 117 篇是 **48.3%**。

一句话：**这个源给的正是我们最缺的信息（"谁是通讯作者"），而它恰恰没有这个信息。**
因此本项目**只用它补题名、记冲突，绝不自动填 `authorContact`**
（`EuropePmcWork.authorEmails` 保留下来仅供人工复核）。

（工具：`tools/_europepmc_sizing.mjs`、`tools/_europepmc_effect.mjs`）

## 3. 能力边界一览（vs 金标准）

| 字段 | EPMC 取回后与金标准一致 | EPMC 与我们当前取值一致 | 用途 |
|---|---|---|---|
| `title` | 183/201（91.0%） | 198/201（98.5%） | **补全**（前缀扩展时以 EPMC 为准） |
| `journal` | 157/201（78.1%） | 179/201（89.1%） | 只记冲突 |
| `pubYear` | 185/201（92.0%） | 151/201（75.1%） | 只记冲突（年份另有 DOI 优先规则） |

> `pubYear` 的"与我们一致"只有 75.1%，是因为我们按"DOI 里的年份 > Crossref issued > PDF"
> 的规则取值，与 PubMed 的卷期年口径本就常有出入——**更说明它不适合当权威**。

## 4. 实现

### 4.1 `packages/europepmc`

```
src/client.ts   按 DOI 查 `search?query=DOI:"…"&resultType=core`，解析出
                title / journal / pubYear / pmid / pmcid / authorEmails
src/verify.ts   与本地取值比对，产出 comparisons + **titleCompletion** + notes
```

设计要点：
- **无 API key**，带 `mailto` 写进 User-Agent（礼貌约定）；
- 4xx 直接返回 `null` 不重试；5xx/网络错误重试 2 次后抛错（由调用方降级）；
- `verifyWithEuropePmc` **在接口上就没有"覆盖任意字段"的能力**——只返回
  `comparisons` 与 `titleCompletion`。这是刻意的：本源只适合当第二意见。

### 4.2 补全判据：只认"真前缀"

```ts
titlePrefixGain(ours, theirs) =
  normalize(ours) 是 normalize(theirs) 的前缀 且 theirs 至少多出 8 个字符 且两者都 ≥12 字符
```

为什么必须限制成"前缀"：只有"我们的更短、且正好是对方的开头"才能确定是**抽漏了后半段**；
若两篇不同论文的题名混进来（实测 2017-08 的 DOI 指向另一篇论文），
宽松的相似度判据会把它们也"补全"成错的。

### 4.3 接入点

- `packages/core/src/skill.ts`：`SkillContext.europepmc?: EuropePmcClient`
  （接口定义在 core 内、不 import `@aa/europepmc`——core 是所有包的依赖，不能反向依赖）；
- `packages/skills/src/article-meta.ts` 步骤 **6b**：在 Crossref（步骤 6）**之后**跑，
  所以只补 Crossref 没覆盖好的题名；产出 `article.external.europepmc` 与
  `EPMC_TITLE_COMPLETED` / `EPMC_NOTE` / `EPMC_ERROR` 三类 issue；
- `tools/llm_run.mjs`：`--no-europepmc` 可单独关掉（与 Crossref 解耦，便于对照实验）。

## 5. 效果

补全是**确定性路径**（成立就用 EPMC 题名替换，与模型输出无关），因此可以先算全量、再小批实测。

**预测**（`tools/_epmc_title_forecast.mjs`）：

| 指标 | 数值 |
|---|---|
| EPMC 取回 | 201 篇 |
| 触发补全 | **23 篇** |
| 补全后与金标准一致 | **20 篇** |
| 题名字段加权分 | 203.5 → **213.5**（分母 222，即 91.7% → 96.2%） |

**实测**（`tools/field_ab_check.mjs --field article.title --old build/_backup_achint`）：
备份集里触发补全的 **11 篇全部从 0.5 提升到 1.0**（加权 5.5 → 11.0），**退步 0**。

### 5.1 实测抓到的一个 bug（预测抓不到）

首轮实测里 2023-02 **退步**了（0.5 → 0）：EPMC 的题名夹着**内联标签**——

```
EPMC 原样：… A Randomized, Controlled, 2 <b>×</b> 2 Factorial Trial.
写进产物：… A Randomized, Controlled, 2 <b>×</b> 2 Factorial Trial.   ← `<b>` 被当正文
```

`clean()` 只做了实体解码、没剥标签。修法（已带注释钉在代码里）：
**先剥 `<[^>]*>`、再解码实体**——顺序不能反，否则 `&lt;b&gt;` 会被解码成 `<b>` 而躲过剥离。
全库扫描：201 篇里只有这 1 篇带标签，但**一次退步就足以说明"预测不能替代实测"**。

修后 2023-02 的题名与金标准在归一化下严格相等。

## 6. 复现命令

```powershell
node tools/_europepmc_probe.mjs 30        # 有没有邮箱（44.8%）
node tools/_europepmc_sizing.mjs 4        # 全库定标：唯一邮箱/命中/可救回上限
node tools/_europepmc_effect.mjs          # 条件效力：命中 EPMC 到底有没有判别力
node tools/_europepmc_meta.mjs 4          # meta 校验定标：题名/期刊/年份
node tools/_epmc_vs_crossref_title.mjs    # ★ 关键对照：Crossref vs EPMC 谁的题名更全
node tools/_epmc_title_forecast.mjs       # 补全效果预测
```
