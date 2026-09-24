# TS 抽取流水线 — 架构与 ingest 关键发现

> 状态：`@aa/core`（契约）+ `@aa/ingest`（MinerU→MiniDoc）已完成，35 个测试全绿，类型检查通过。
> 验证命令：`pnpm check`

## 1. ⚠️ 最重要的发现：MinerU 的 `content_list` 几何信息不可用

这直接决定"前端框选证据"（需求 1）能否做对，必须先记录。

实测 `-2015-01.pdf` 第 1 页的同一个块 `"Original paper"`：

| 数据源 | bbox | 判定 |
|---|---|---|
| `_middle.json` | `[458, 18, 537, 30]` | ✅ 页宽 595，自洽 |
| `_content_list.json` | `[769, 22, 902, 37]` | ❌ x 超出页宽 |

各页的越界比例**并不一致**（x 方向 1.19~1.53 倍），因此**无法用统一缩放系数还原**。

**结论：几何信息只能用 `_middle.json`。** `content_list` 虽然字段友好，但其 bbox 不可用于高亮/框选。

### 两套产物的对比（实测）

| | `_content_list.json` | `_middle.json` |
|---|---|---|
| bbox 可用性 | ❌ 越界，比例不一致 | ✅ 全部落在页面内 |
| 块类型 | text/title/table/image/list/… | **更细分**：title/text/**abstract**/table/image/**ref_text** |
| 噪声 | 混在条目里（需按 type 过滤） | **单独 `discarded_blocks`**（天然可审计） |
| 表格 | `table_body` HTML + caption | `table.blocks[]` → `table_caption` / `table_body`(HTML) + **`image_path`** |
| 公式 | 独立条目 | **span 类型 `inline_equation`**，文本已含 LaTeX |
| 页尺寸 | 无 | `pdf_info[].page_size` |

→ 因此 `@aa/ingest` **只读 `_middle.json`**。

## 2. 坐标系约定（MiniDoc 的硬约定）

```
bbox = [x0, y0, x1, y1]
  · 原点：页面左上角
  · 单位：pt
  · 位于 MinerU 的 canonical 页面框架
```

旋转页的实测行为（`-2015-01` 第 6 页）：

```
page_size = [793, 595]   ← 宽>高 → 判定 rotate: 90（前端视图需据此摆放）
页内所有 bbox 仍落在 [595, 793] 框架内  ← 说明 bbox 用的是 canonical 框架
```

所以 ingest 的校验上界取 `max(width, height)`，并把 `rotate` 记在 `MiniDocPage` 上供前端使用。
**前端渲染顺序必须是：先按 rotate 旋转画布，再叠加 canonical 坐标的 bbox。**

## 3. 包结构

```
packages/
  core/      @aa/core    契约层：证据 / 字段 / 三层结果 / ID 语法 / 表格网格
  ingest/    @aa/ingest  MinerU _middle.json → MiniDoc
apps/       （待建）    前端：PDF 查看 + 框选证据
```

### `@aa/core` 的核心不变量

> **任何进入抽取结果的字段都必须带证据（Evidence）。**
> 无证据的字段只能进入 `unresolved`，不得进入 `fields`。

这条不变量用 `makeField()` 强制（无证据直接抛 `EvidenceRequiredError`），
并有 `auditEvidence()` 递归审计整份结果。它是需求 1（框选证据）与人工复核的前提。

`FieldValue` 三元组直接对应金标准的双编码结构：

```ts
interface FieldValue {
  raw: string;          // 逐字原文，绝不改写
  code?: string;        // 受控编码（如 "1"、"2/5"）
  legend?: string;      // 编码含义（来自金标准图例行）
  evidence: Evidence[]; // 至少一条，含 page/bbox/quote
  provenance: 'deterministic' | 'model' | 'external' | 'human';
  confidence: number;
  missing?: 'not_reported' | 'not_applicable' | 'empty';  // NR / NA 哨兵
}
```

### `MiniDoc`（Agent 的唯一输入）

`_middle.json` 有 1.4MB 且含大量中间态，**Agent 不应直接读它**。
ingest 产出精简的 MiniDoc：127 个块 / 11 页 / 带章节归属，体积小一个量级。

## 4. 工程决策（含踩坑原因）

| 决策 | 原因 |
|---|---|
| 用 pnpm workspace | 与 DSH 环境一致；`onlyBuiltDependencies: [esbuild]` 必须设置，否则 vitest 的原生二进制被静默跳过 |
| 不用 LangChain 等编排框架 | 抽取编排需要精确控制证据与校验，框架会挡路 |
| 包的 `exports` 指向 `dist`，测试用 vitest alias 指源码 | "exports 指源码"在 Node 下**不成立**：源码里按 ESM 规范写 `./x.js`，Node 会去找不存在的 `.js`；只有打包器能容忍 |
| 测试内一律用 `.ts` 扩展名导入 | 配合 `allowImportingTsExtensions`；曾试图写 resolveId 插件把 `.js` 映射到 `.ts`，被 Vite 内部 `new URL()` 重新解析，徒增复杂度 |
| tsconfig 加 `paths` 映射 `@aa/*` | alias 只对 vitest 生效，`tsc` 需要自己的映射 |
| **先写测试再接数据** | 本项目前几轮反复出错的根因就是缺少验证（例如 caption 修复连续 3 版都改错） |

## 5. 测试即规格

35 个测试，**期望值全部来自对真实产物的实测**，不做 mock：

| 测试点 | 实测期望 |
|---|---|
| 页面与旋转 | 11 页；`pages[5].width=793` 且 `rotate=90` |
| 噪声 | `droppedNoise=47`，且不混入正文 |
| 几何 | 全部 bbox 落在 `max(宽,高)` 内，零越界告警 |
| 表格 | 6 个；其中 5 个有完整 HTML+网格，1 个是跨页续表伪影 |
| 网格 | 展开 colspan/rowspan 后**每行列数一致**（矩形） |
| caption | 4/6 有 caption；Table 2 的打散 caption **如实保留不篡改** |
| 图块 | 1 个，带 `image_path`（递归查找，路径嵌在多层 blocks 里） |
| 章节路由 | abstract/methods/results/references/metadata 均非空 |
| 证据定位 | 摘要原句可定位到第 1 页带 bbox 的块；CID 登记号可定位 |
| 反面用例 | 不存在的原文返回 `null`，**绝不伪造坐标** |

## 6. 待办

1. **章节路由仍是关键词启发式** —— `-2015-01` 的 `INTRODUCTION` 等标题可命中，但不同期刊标题风格差异大。建议后续按金标准的 section 体系补强，并对未命中项记录 warning。
2. **章节路由的 `metadata` 判定较粗** —— 目前用"首页 abstract 之前"，多栏排版下可能不准。
3. **表格跨页拼接** —— 2015 未出现真需拼接的情况（唯一的空块是伪影），后续年份需验证。
4. **旋转页前端渲染** —— 前端必须实现 `rotate` 感知的画布，否则 bbox 会整体偏移（实测偏 199pt）。
5. 下一步：SKILL 层（article / comparison / outcome）+ LLM 运行器 + Crossref 客户端。
