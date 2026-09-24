# MinerU 流程稳定性验证（2015 年 6 篇）

> 环境见 `docs/01-mineru-setup.md`。本文记录**2015 全年 6 篇的端到端稳定性验证结果**与踩到的坑。

## 1. 结论

**6 篇全部解析成功，无崩溃。** 55 页，批处理 84.7 秒（模型只加载一次）。

| 指标 | 结果 |
|---|---|
| 表格 | **22 个**，body 全部为完整 HTML（合并 1 个重复伪影后） |
| 表格 HTML 总量 | 50 126 字符（含 `colspan`，可直接解析） |
| caption | **27/28 正确**，1 个打散（已标记，非静默） |
| 公式 | 15 个行内 LaTeX（2015 这批没有独立块公式） |
| 图片 | 10 张（含表格/图切图，供多模态使用） |
| 噪声 | 177 条（页眉/页脚/页码），占比 24.1%，已可一键剔除 |

**对比此前 `.article_agent_hybrid` 的 PyMuPDF 结果（6 个表格全空、公式 `unavailable`）——需求 2「图表信息稳定」的根因（MinerU 从未真正启用）已彻底解决。**

## 2. 流程（三步，可复现）

```bash
# 1) 批量解析（MinerU 的 -p 只接受一个路径，传目录最优：模型只加载一次）
node tools/mineru_batch.mjs --year 2015
#    → build/mineru/2015/<stem>/txt/  + _quality.json（逐篇健康度）

# 2) 规范化后处理（合并伪影 / 修 caption / 去噪）
node tools/mineru_clean.mjs --year 2015
#    → build/mineru/2015/_clean/<stem>.json  + _clean_report.json
```

### ⚠️ `-p` 的坑
`mineru -p` 只接受**一个**路径（文件或目录）。我最初传了 6 个文件路径，
结果**只处理了第一个**，且**没有任何报错**——6 篇的输出指标完全相同才暴露出来。
正确做法是传目录（或逐篇调用）。为精确控制子集，`mineru_batch.mjs` 会建一个
只含目标 PDF 的暂存目录，避免把 `.DS_Store`/隐藏目录喂进去。

## 3. 逐篇健康度

| 文件 | 页 | 正文块 | 表格 | 表格HTML字符 | 图 | 行内公式 | 噪声比 |
|---|---|---|---|---|---|---|---|
| `-2015-01.pdf` | 11 | 80 | 6→5 | 15 285 | 1 | 1 | 0.346 |
| `-2015-02.pdf` | 9 | 93 | 4 | 12 053 | 2 | 3 | 0.188 |
| `-2015-03.pdf` | 10 | 86 | 3 | 3 268 | 2 | 6 | 0.26 |
| `-2015-04.pdf` | 13 | 151 | 6 | 14 476 | 0 | 5 | 0.163 |
| `-2015-05.pdf` | 5 | 54 | 2 | 3 203 | 2 | 0 | 0.28 |
| `-2015-06.pdf` | 7 | 45 | 2 | 1 841 | 3 | 0 | 0.264 |

（表格数含被合并的 1 个重复伪影，故 `-2015-01` 显示 6→5。）

## 4. 三类问题与处理

### 4.1 重复表格伪影（已自动合并）

`-2015-01`：PDF 第 4 页 = `Table 1 Descriptive analysis...`（表体完整），
第 5 页 = `Table 1 Continued`。MinerU 把第 5 页**又检测成一个表格块，却只框到页眉**
（bbox 高仅 215pt，占页高 26%），`table_body` 为空。

**判据**（不只看"body 为空"）：
- `table_body` 近空
- 与上一个表格块 `page_idx` 相邻（差 ≤ 1）
- 上一个块已有 body

→ 判定为重复伪影，把它的 caption/footnote 并入上一块，并记录 `_merged_from`。

工具：`tools/diag_empty_tables.mjs`（23 个表格块中唯一的空块被判定为伪影，其余 22 个健康）。

### 4.2 caption 打散（已部分修复 + 全部标记）

`-2015-01` 的 `Table 2` caption 被 MinerU 输出成：

```
"Ta b l e 2 Eva l <sub>u</sub> ati o n of o <sub>u</sub>tco m e m ea s <sub>u</sub> res"
```

**根因（逐步定位）**：
1. 起初以为是 PDF 文本层被字距切碎 → 实测 `Table 1` 区域只有 3 个文本 item，**PDF 层是干净的**，所以这是 MinerU 自己的识别产物。
2. 进一步发现该页 **`rotate: 90`（横向 PDF）**：`getViewport()` 返回 794×595，而坐标空间是 595×794——我此前的 `top = height - y` 用错 height，所有位置判断偏了 199pt。**这正是我连续几次"修复"都改错的原因。**
3. 最终定位：该 caption 是**旋转文本**，在 PDF 文本层里拆成两个片段且阅读顺序相反——
   `x≈125` 竖带按 y 降序 = `Evaluation of outcome measures` + `Table 2`
   （即 `Table N` 落在竖带**末尾**）。

**处理策略（保守）**：
- MinerU 的 caption **编号清晰且未打散 → 直接信任**（实测 21/23 正确，不该动）
- 无编号但描述性良好（散文式表题）→ **保留**，因为按编号找来的候选会退化成 `Table N`
- 确认为旋转块 → 用竖带重建
- 仍不可靠 → **标记 `caption_scrambled_kept`**，保留原文，绝不静默改错

> **踩坑记录**：前后 3 版修复逻辑都改错了，原因依次是
> (a) 只按"最近距离"匹配 → 把**图片** caption 换给了**表格**；
> (b) 同页多表时匹配到**其它表**的 caption；
> (c) `capNum` 没先规范化 `Ta b l e` → 提不出编号 → 重建逻辑被直接跳过。
> 教训：**同类分支出现不一致结果时，去打印真实数据，不要继续加启发式。**

工具：`tools/diag_caption_candidates.mjs`（打印每张表附近的同类型候选，用证据定规则）。

### 4.3 页眉/页脚/页码噪声（已剔除）

`header` / `footer` / `page_number` / `page_footnote` / `aside_text` 共 177 条，
占原始条目 24.1%。直接按 `type` 过滤即可，无需启发式。

## 5. 稳定性评估

| 维度 | 判定 |
|---|---|
| 崩溃 / 超时 | ✅ 6/6 无 |
| 表格 body 完整性 | ✅ 22/22 完整（含 colspan） |
| caption 可用性 | ✅ 27/28 正确；1 个已标记待人工 |
| 公式 | ✅ 行内 LaTeX 可用（2015 无块公式） |
| 可追溯性 | ✅ 每篇保留 `_layout.pdf`/`_span.pdf` 可肉眼核对 |
| 幂等性 | ✅ 重跑结果一致 |

**结论：2015 这 6 篇的 MinerU 流程已稳定，可作为后续年份的基线。**

## 6. 产物

```
build/mineru/2015/
  <stem>/txt/<stem>.md                 原始 Markdown（含表格 HTML、LaTeX）
  <stem>/txt/<stem>_content_list.json  ✅ 管线首选输入（136/128/... 个条目，含 bbox/page_idx）
  <stem>/txt/<stem>_content_list_v2.json 按页组织，富文本 span
  <stem>/txt/<stem>_middle.json        完整中间表示
  <stem>/txt/<stem>_layout.pdf         版面可视化（人工核对用）
  <stem>/txt/images/*.jpg              表格/图切图（多模态输入）
  _quality.json                        逐篇健康度（batch 产）
  _clean/<stem>.json                   ✅ 规范化结果（去噪 + 合并 + caption 修正）
  _clean/_clean_report.json            修复明细与日志
```

## 7. 待办

- **旋转表格（`rotate: 90`）是剩余风险点**：当前 caption 依赖竖带重建，建议在规范化里对
  这类页面做显式标记，供人工复核。
- 跨页表格**真正需要拼接**的情况在 2015 未出现（唯一的空块是伪影）。后续年份若出现
  「上一页表格未结束 + 下一页续体」，需要新增拼接逻辑并单独验证。
- 建议把 `_clean/<stem>.json` 作为 **Agent 管线的唯一输入**，不要让 LLM 直接读 `_middle.json`（1.4MB）。
