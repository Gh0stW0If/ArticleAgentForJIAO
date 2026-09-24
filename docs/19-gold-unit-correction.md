# 金标准修正：带单位三列的归一化与对齐

> 按用户口径执行的一次**金标准修正**：只改 `build/gold/*.json`（`Datas/` 只读不动），
> 只处理"最长随访时间 / 治疗频次 / 留针时间"三组的 `desc` / `value` / `unit` 三列。
> 其他金标准问题**未处理**。
>
> 工具：`tools/gold_fix_units.mjs`（默认干跑，`--apply` 落盘）、
> `tools/gold_fix_units_verify.mjs`（结构完整性校验）、`tools/gold_fix_units_recon.mjs`（形态侦察）。

## 0. 结果速览

| 指标 | 修正前 | 修正后 |
|---|---|---|
| `最长随访时间单位` 与表头图例不符 | **56/154（36%）** | **0** |
| 三列自洽性（desc 可解析时 value/unit 由 desc 推出） | 部分自相矛盾 | 全部一致 |
| 直接比对口径下这 12 列的直观准确率 | 46.4% | **47.6%** |
| 结构完整性 | — | ✅ 文章数/比较组数/键集合完全一致 |

修改明细：**274 处**（`normalize` 248 + `sentinel-align` 26），其中
**单位编码修正 85 条**、**数值修正 31 条**、**哨兵对齐 26 条**；
跳过 **329 处**无法确定性解析的（列在报告里待人工）。

## 1. 修正规则（用户口径 → 实现）

| 用户要求 | 实现 |
|---|---|
| 单位编码以**表头**为准 | 三组的编码表取自 `build/legend/<year>.json` 的 `headerLabels`（原始 Excel 表头），**不从数据反推** |
| desc 保留原文、格式归一化 | `30 min` / `20min` / `30分钟` → **`30 minutes`**；`9 wks` → `9 weeks`；`once a day` → `1 time per day` |
| 无法数值化的保持原样 | `post-gastroscopy`、`until delivery`、`outcomes measured only during hospitalization` 原样保留 |
| value / unit 由 desc **用代码约束提取**，不交给 LLM | `parseDesc()` → `toCode()` 纯确定性；单测与干跑可复核 |
| 不改 `Datas/` | 全部改动只写 `build/gold/*.json` |

### 1.1 三组的编码表（表头原文）

| 组 | 编码表 | desc 只有数字时的缺省单位 |
|---|---|---|
| 最长随访时间 | `1`=天 `2`=月 `3`=年 `4`=周 `5`=小时 | 无（表头没写死单位） |
| 治疗频次 | `1`=天 `2`=周 `3`=1小时 | 无 |
| 留针时间 | `1`=分钟 `2`=小时 | **分钟**（表头写「单位：分钟, min」） |

### 1.2 换算约定

**1 月 = 4 周、1 周 = 7 天、1 天 = 24 小时、1 小时 = 60 分钟。**
依据：金标准里 `3 months` 对应 `course_value=12`、`course_unit=2`（周）
（`tools/_unit_convention_scale.mjs` 对全库三列交叉统计）。用物理值 4.345 会系统性不符。

## 2. 安全边界：什么改、什么不改

**只处理"简单量"**：`<数>[<单位>]` + 可选尾注。出现下列任一情形一律**跳过并列入报告**：

| 跳过原因 | 条数 | 例子 |
|---|---|---|
| 治疗频次：含多个数字 | 142 | `5 sessions in each of the first 2 weeks, and 3 sessions…` |
| 治疗频次：解析不出数+单位 | 118 | `once`、`PRN` |
| 最长随访：解析不出数+单位 | 31 | `until discharge`、`post-radiotherapy` |
| 留针时间：含多个数字 | 27 | `2-5s/ maximum 30 s each` |
| 最长随访：含多个数字 | 13 | `5 days per week for 2 weeks` |
| 留针时间：解析不出数+单位 | 8 | `during the procedure of survey` |

### 2.1 三条"宁可不改"的护栏（都是实测踩出来的）

1. **"每穴 X"必须跳过**：`2 min per point (6 points total)` 的 2 是**每穴**留针时间，
   总时长是 2×6=12（金标准填的正是 12）。按前导数字归一化会把 12 改成 2 —— **改错**。
   凡出现 `per/each + point/acupoint/site/leg/needle` 一律交人工。
2. **跨表换算只在整除时做**：`30 minutes` 落在只认天/月/年/周/小时的编码列里，
   30/60=0.5 不是整数。若不设这条限制，`value` 会出现 `0.083` 这类难以阅读的值。
   例外处理见 §2.2。
3. **括号内容先剥离再判"是否还有别的量"**：`24 weeks (6 months)`、`4 weeks post-treatment (week 16)`
   里的括号是对同一时点的补充说明 → 可取前导量；
   而 `5 days per week for 2 weeks` 括号外还有第二个量 → 跳过。

### 2.2 唯一的例外：`分钟` 落进"无分钟编码"的列

`最长随访时间` 的编码表没有"分钟"，但有 3 条 desc 是分钟
（`30 minutes after HSG`、`10 minutes post-procedure`、`30 minutes`）。
其中两条原 `unit` 是**非法值**（`"minutes"`、`"分钟"`）——那比"不精确"更糟。

处理：换算到**数值最接近 1** 的编码单位（=小时），并在报告里标 `approx: true`：
`30 minutes` → `value=0.5, unit=5（小时）`。这 3 条需要人工确认。

## 3. 改动明细

| 类别 | 条数 | 说明 |
|---|---|---|
| `normalize` | 248 | desc 归一化 + value/unit 由 desc 重新推出 |
| └ 其中**单位编码修正** | **85** | 主要是 `2→4`（"周"被编成"月"）**38 条** |
| └ 其中**数值修正** | **31** | desc 与 value 自相矛盾的，如 `desc="15"` 而 value=14、`desc="20"` 而 value=1 |
| `sentinel-align` | 26 | desc 是 NR/NA/NE 而 value/unit 不是 → 对齐为同一哨兵 |

单位编码修正的分布：`2→4` 38 条、`3→2` 6 条、`2→1` 4 条、`1→2` 4 条、`1→5` 3 条、`1→4` 2 条、`5→2` 2 条。

### 3.1 修正前后对照（样例）

| 文章 | desc | value | unit | 问题 |
|---|---|---|---|---|
| 2021-05（前） | `9 weeks` | 9 | **2（月）** | 与表头图例不符 |
| 2021-05（后） | `9 weeks` | 9 | **4（周）** | ✅ |
| 2025-13（前） | `12 months (pregnancy outcome)` | 12 | **3（年）** | 同上 |
| 2025-13（后） | 同 | 12 | **2（月）** | ✅ |
| 2015-01（前） | `20` | 20 | 1（分钟） | desc 缺单位（表头已指定分钟） |
| 2015-01（后） | `20 minutes` | 20 | 1（分钟） | ✅ |
| 2015-06（前） | `once a day` | 1 | 1（天） | desc 未归一化 |
| 2015-06（后） | `1 time per day` | 1 | 1（天） | ✅ |
| 2016-07（前） | `15` | **14** | 1 | **value 与 desc 矛盾** |
| 2016-07（后） | `15 minutes` | **15** | 1 | ✅ |

## 4. ⚠️ 过程中的一次失误（必须记录）

第一版把**备份代码放在了写文件之后**，于是 `build/_backup_gold_pre_units/` 里存的是
**改好之后**的副本——等于没有备份。这个错**不会报错、只会静默失效**，
是靠"重新生成原状再对比"才发现的：

```powershell
node tools/gold_normalize.mjs --out build/_gold_original --apply-reconcile
```

发现过程本身又暴露了第二个坑：**`gold_normalize.mjs` 必须带 `--apply-reconcile`**。
不带时，源表里的年份错配会原样带出（2022 的表里混进 `2020-14`/`2021-18`/`2024-05`/`2024-06`，
2024 的表里混进 `2025-26`/`2025-27`），文章数从 224 变成 **230**——
若没发现就会**悄悄换掉评测基线**。

修法：
1. `gold_fix_units.mjs` 的备份块移到任何写入之前（并在代码里写了注释钉住）；
2. 用 `--apply-reconcile` 重新生成原状（224 篇，与原有逐年逐篇一致），
   还原后再**一次性重跑**修正，保证整条链路可审计。

备份现在确实是原状（已核验：`2021-05` 的 unit 是 `2`、`2015-01` 的 desc 是 `20`）。

## 5. 验证

| 验证 | 结果 |
|---|---|
| 结构完整性（`gold_fix_units_verify.mjs`） | ✅ 12 个文件、224 篇文章、301 个比较组：数量与键集合完全一致，**只有这三组的叶子被改动** |
| 图例一致性（`_unit_legend_anomaly.mjs`） | 不一致 **56 → 0**（3 条为"换算后等值"，正常） |
| 直接比对口径（`_scheme_columns_direct.mjs`） | 46.4% → **47.6%**（+1.2 点，即被修正掉的假错误） |
| 备份可用性 | ✅ `build/_backup_gold_pre_units/`（12 个文件，确为修正前原状） |
| 当前（已修正）另有存档 | `build/_backup_gold_fixed/`（第一轮修正后的状态，仅供对照） |

## 6. 后续（需要处理或拍板的）

| 优先级 | 事项 |
|---|---|
| 1 | **329 处跳过项**需人工：主要是治疗频次的复杂短语（142+118 条），无法在不让模型判断的前提下归一化 |
| 2 | **3 条 `approx`**：`30 minutes` 类落在无"分钟"编码的列里，现按 `0.5 小时` 记录 |
| 3 | **重跑评测**：`build/eval/*.json` 与 `build/report/医生讨论报告.md` 都是修正前的口径，需重跑 `llm:eval` 才反映本次修正 |
| 4 | 已重算依赖金标准的产物：`gold_anomalies.json`、`gold_evidence_check.json` |
| 5 | 用户明确"其他金标准问题先不处理"——本次未动任何其他字段 |

## 7. 复现命令

```powershell
node tools/gold_fix_units_recon.mjs     # 侦察：三组 desc 的形态分布
node tools/gold_fix_units.mjs           # 干跑：只报告会改什么
node tools/gold_fix_units.mjs --apply   # 落盘（先自动备份到 build/_backup_gold_pre_units/）
node tools/gold_fix_units_verify.mjs    # 结构完整性校验
node tools/_unit_legend_anomaly.mjs     # 图例一致性（应为 0）
node tools/_scheme_columns_direct.mjs   # 逐比较组直接比对（修正后的口径）
```
