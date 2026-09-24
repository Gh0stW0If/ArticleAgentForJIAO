# 前端：PDF 查看 + 框选证据 + 人工修改（需求 1）

> `apps/web` — React 18 + Vite 5 + pdf.js
> 验证：`pnpm check` 全绿（157 测试 / 10 文件），`pnpm web:build` 构建成功，
> 人机回环经 15 项端到端断言校验（见 §7）。

## 1. 启动

```bash
pnpm web:build && pnpm web:api    # 打开 http://127.0.0.1:43130 即可用（API + 前端同端口）
pnpm web:dev                      # 开发模式：前端 http://127.0.0.1:43131（/api 代理到 43130）
pnpm web:smoke                    # 接口人机回环冒烟（20 项断言）
pnpm web:e2e                      # Playwright 真实浏览器交互测试（11 例）
```

`server.mjs` 在 `apps/web/dist` 存在时顺带托管静态产物（只服务 dist 内的文件，
`resolve` 后必须仍位于 dist 之下，已实测 `../` 与 `%2e%2e%2f` 均被拒绝）。

> `pnpm web:e2e` 会自动复用已在跑的 `web:api`（`reuseExistingServer`），
> 没跑时自己起一个；首次使用需 `pnpm exec playwright install chromium`。

## 2. ⚠️ 最关键的一处：坐标系换算

`MiniDoc` 的 bbox 与 pdf.js 的 viewport **不在同一坐标系**，这是本项目实测踩到的坑：

```
-2015-01.pdf 第 6 页：
  page.rotate = 90
  MinerU page_size = [793, 595]        ← 显示方向（横向）
  但该页所有 bbox 落在 [595, 793] 内    ← canonical（未旋转）框架
```

若直接把 bbox 当 viewport 坐标叠加，会整体偏移（实测可达 199pt）。
因此 `src/geometry.ts` 显式做三件事：

| 函数 | 作用 |
|---|---|
| `canonicalSize(g)` | 把 page_size **反旋转**回 canonical 尺寸（rotate 90/270 时宽高互换） |
| `bboxToScreen(bbox, g)` | canonical bbox → 屏幕矩形（按 rotate 映射 + 缩放） |
| `screenToBbox(rect, g)` | 屏幕框选矩形 → canonical bbox（逆运算） |

**不依赖 pdf.js 的 `rotation` 参数**，避免与其内部实现耦合；`bboxToScreen`/`screenToBbox`
互为逆运算，有 13 个测试覆盖（含 rotate 0/90/180/270 与缩放的往返一致性）。

> 注意 `canonicalSize` 不能用 `min/max` —— 在非 A4 或自定义页面尺寸上会算错。
> 必须按 rotate 明确互换。

框选存盘时**存的是 canonical bbox**（与 MinerU 同一坐标系），
因此人工框选的证据与流水线自动产出的证据可以直接比对、可以互相替换。

## 3. 界面与交互

```
┌──────────────────────────────────────────────┬───────────────────────┐
│ 年份▾ 研究▾ ⬆导入文章 解析 抽取 | 页 3/11 缩放 解析块 模式 | ⚙设置 │ Sheet1 Sheet2 Sheet3 │
├──────────────────────────────────────────────┤  人工 3 · 修改 1 · 确认 2│
│                                              │  ───────────────────  │
│   PDF 连续滚动（所有页竖直堆叠，惰性渲染）      │  文章级字段（按原表列序）│
│    半透明蓝框 = 解析块（可切换）               │   文献编号 …  [编辑]   │
│    橙色框     = 证据（点字段跳转/定位）         │  ───────────────────  │
│    紫色框     = 人工框选的证据                 │  Crossref 核验 ▸      │
│    虚线框     = 正在拖拽                       │  比较组 1（56）▸      │
├──────────────────────────────────────────────┤  ＋新增字段            │
│ 框选信息条：p3 · bbox[…] · 命中 4 块 + 每块原文 │  （Sheet3：候选 + 每个结局行）│
└──────────────────────────────────────────────┴───────────────────────┘
```

### 1.1 三张选项卡（右侧）

需求：**抽取字段改成选项卡，按原始表格的字段排布**。落地方式：

| 选项卡 | 内容 | 列序来源 |
|---|---|---|
| **Sheet1** | 文章级字段 + Crossref 核验 + 逐个比较组 | `Sheet1` 表头（无代码行 → 按中文表头匹配规范字段 label） |
| **Sheet2** | 结局分类字段 | `Sheet2` 表头 |
| **Sheet3** | 待纳入候选 + 每个「结局 × 比较组」行 | `Sheet3` 有 `codeRow=5` → 按**列代码**精确还原；时点列按 `B/E/F` 前缀分组 |

布局实现在 `tools/sheet_layout.mjs`（与 CLI 共用），服务端把它随 `/api/fields` 一起下发
（`sheets.order` 是键的顺序表，`sheets.headerOf` 是原始表头文本）。
不在布局里的键（人工新增、或原表没有的流水线字段）**排在各自分组末尾**，不会丢字段。
实测 2015：Sheet1 文章级 21 列 / 比较组 56 列、Sheet2 7 列、Sheet3 顶层 15 列 + 每时点 10 列。

> ⚠️ Sheet1 里「试验组/对照组」这组表头**重复 4 次**（性别、随机例数、脱落人数…），
> 只比对列名会全部撞车。图例的 `headerLabels` 是**逐行**给出的（末行是组别），
> 因此匹配时把两行都收进候选，并在规范字段名带 Experimental/Control 时要求组别一致。

### 1.2 证据只在左侧显示（右侧不再显示原文）

需求：**原文证据只需要在左侧 PDF 能显示定位**。因此右侧字段行**不再渲染 quote 文本**，
只保留「定位证据」按钮/点值跳转：点击 → 左侧连续视图滚到该页并画橙色框。
好处是右侧版面全留给字段本身（原来一段被截断的引文要占 3~5 行）。
数据层面证据照旧保留（框选、回滚、导出都依赖它）。

### 三种框选模式

1. **框选（两种模式）**
   - `浏览模式`：拖拽后列出重叠率 >15% 的解析块（按比例降序，最多 8 个），
     在左下方信息条显示每块的 `#index`、类型、重叠率与原文——用于核对解析质量。
   - `标注模式`：从右侧字段点「框选证据」进入，拖拽即把该框写为该字段的证据
     （`page` + canonical `bbox` + 命中块原文作为 `quote`）。紫色高亮表示人工证据。
2. **点字段 → 跳转并高亮证据**：字段值带 bbox 时点击即滚到该页并画橙色框。
3. **编辑**：就地改值 + 可选修改理由；记录 `override`/`confirm`（判定见 §6）。
4. **确认无误 / 回滚**：确认只记录"人工核对过"（不改值，用于统计 LLM 正确率）；
   回滚删除该字段的人工标注，恢复流水线原值。
5. **＋新增字段 / 定位证据**：前者补录漏抽的字段（记 `add`）；
   后者在该字段还没有证据时，用**与流水线相同的匹配策略**（精确 → 去标点近似）
   在解析文本里搜索字段值并定位到坐标（只读、不写盘），确认后再用「框选证据」固化。
6. **「纳入抽取」**（Sheet3 顶部「待人工确认纳入」组）：把非六类候选结局
   提升为正式的 Sheet3 行（见 §11）。

### 1.3 PDF 连续滚动 + 惰性渲染

需求：不再一次只渲染一页。实现要点（`PdfViewer.tsx`）：

- 所有页**竖直堆叠**，每页先是"尺寸已知的占位 div"（高度由 MiniDoc 的页面尺寸算出，
  滚动条不会跳），`IntersectionObserver` 只给**可见页 ± 1** 创建 canvas，离开视口即销毁；
- 台账可见性用 `data-drawn` 暴露，e2e 用它断言"远页确实没画"——
  ⚠️ 不能用 `canvas.width > 0` 判断：未渲染的 `<canvas>` 默认宽就是 300，会假通过（踩过）；
- 当前页 = 离视口中心最近的一页，滚动时实时更新顶栏的"第 N / M 页"。


## 4. 人工修改怎么存：覆盖层，而不是改写产物

人工修改**绝不写回流水线产物**，而是单独存成覆盖层
`build/annotations/<year>/<articleId>.json`（类型见 `packages/core/src/annotation.ts`）：

| | 位置 | 说明 |
|---|---|---|
| 流水线产物 | `build/gold/*.json` / 未来的抽取结果 | 只读，不被人工修改污染 |
| 人工覆盖层 | `build/annotations/**` | 只记 `{fieldPath, action, value{raw,evidence}, note}` |

理由与金标准处理一致（见 `docs/02-gold-schema.md`）：自动改写会掩盖问题且不可审计。
分开存可以随时回放"原始 vs 人工"的差异，**也便于计算人工修正率**——这是评估 LLM 质量的关键指标。

合并规则（`server.mjs buildFieldGroups` ↔ `core mergeOverlay`，两者一致，简单可预测）：

```
覆盖层有该 fieldPath  → 取人工值，decidedBy = 'human'
否则流水线有该字段     → 取流水线值
两者都没有            → 不产出该字段（缺失即缺失，不编造）
```

字段路径与流水线完全对齐（`country`、`study.xxx`、`comparisons.0.randomizationClass`、
`outcomes.1.timepoints.endOfTreatment.continuous.experimental.estimate`），
因此合并逻辑不需要为不同层级写特例。

## 5. API（`apps/web/server.mjs`）

| 端点 | 说明 |
|---|---|
| `GET /api/health` | 健康检查（含各数据目录是否存在） |
| `GET /api/studies?year` | 该年份的研究列表（ID 从文件名推导） |
| `GET /api/minidoc?year&study` | 解析文档：pages + blocks（含 bbox 与文本） |
| `GET /api/gold?year[&study]` | 金标准归一化结果 |
| `GET /api/fields?year&study` | **字段视图**：流水线产物优先（带 source/model），三层分组 + Crossref 组 + 待人工确认组 + 字段级证据 + 人工覆盖层合并 |
| `GET /api/locate?year&study&q` | 把一段原文定位到解析块坐标（只读，供"定位证据"） |
| `POST/PUT /api/annotation?year&study` | 写入人工标注（`{entry:{fieldPath,action,value,note}}`，同路径只留最新一条） |
| `DELETE /api/annotation?year&study[&fieldPath]` | 带 `fieldPath` = 单字段回滚；不带 = 清空该研究的覆盖层 |
| `GET /api/pdf?year&study` | PDF 原始字节（供 pdf.js） |
| `GET /`（及 `/assets/*`） | 前端构建产物（dist 存在时） |

**安全**：`year` 必须是 4 位数字、`study` 必须匹配 `YYYY-NN(-K)`；
只读 `Datas/` 与 `build/`（覆盖层是唯一的可写目录）。
已验证目录穿越、非法 action（400）、`q` 过短（400）等边界。

**性能**：`/api/minidoc` 只回传前端需要的字段（index/type/page/bbox/text），
不把 MinerU 的 `_middle.json`（1.4MB）整份推给浏览器；文本截断到 4000 字符。

## 6. `action` 的判定：按"值是否变化"，不按"是否点了编辑"

前端不把"用户点了编辑"等同于"修改过"，而是比较最终值与被覆盖前的原值：

| action | 何时写入 | 界面表现 |
|---|---|---|
| `add` | 金标准/流水线没有该字段（人工补录） | 紫色「人工修改」 |
| `override` | 最终值 ≠ 原值 | 紫色「人工修改」+ 显示 LLM 原值 |
| `confirm` | 最终值 = 原值（人工核对无误 / 只换了证据） | 紫色「已确认」 |

这样即使用户改完又改回原样，也不会被误记成"人工修改"，人工修正率才可信。
同理，**给已被人改过值的字段框选证据时不会把 `override` 降级成 `confirm`**——
否则一次框选就会把"已修改"标记抹掉（这是实测发现并修掉的一个语义 bug）。

## 7. 实测验证

```
pnpm check              → 157 测试 / 10 文件通过，5 个 typecheck 目标全绿
pnpm web:build          → ✓ 37 modules，pdf.worker 1.37MB 独立 chunk
/               → 200 text/html；/assets/index-*.js → 200 text/javascript
/../package.json、/%2e%2e%2fpackage.json → 404 拒绝
/api/studies?year=2015   → 6 篇
/api/minidoc?…2015-01    → 127 块 / 11 页；第 6 页 rotate=90 ✅
/api/fields?…2015-01     → 文章级 21 / Sheet2 10 / 比较组 1(64) / 结局 1–4(39,38,38,38)
/api/locate?q=标题        → p1 bbox=[163,41,467,126] type=title exact=true
                           去标点/大小写后的近似查询 → exact=false 同样命中
                           不存在的串 → 404
```

**`pnpm web:smoke`（可重复运行，20 项断言）**——把前端会发出的请求序列固化下来，
在真实服务上验证「框选证据 + 人工修改」通路，避免只靠手点一遍：

```
pnpm web:api          # 终端 A
pnpm web:smoke        # 终端 B（可带参数：pnpm web:smoke 2015 2015-02）

[2] 人工改值    title: 原值 → 原值(人工校对)，保留 llmRaw ✅
[3] 框选证据    值不变、canonical bbox 写入 p1 [100,200,300,220]，仍标记"已修改" ✅
[4] 改回原值    overridden 变回 false（记 confirm 而非 override）✅
[5] 定位证据    命中 p1 bbox=[163,41,467,126] exact=true；无副作用；不存在→404 ✅
[6] 补录字段    inGold=false → decidedBy=human ✅
[7] 单字段回滚  仅该字段恢复原值，其他人工标注不受影响 ✅
[8] 非法输入    非法 action / 过短 q / 非法 study → 400 ✅
```

> 冒烟测试只写 `build/annotations/**`（人工覆盖层）并在结束时清理，
> 不触碰 `Datas/` 与流水线产物。它挑选的改造对象是"值确实出现在正文里"的字段——
> 像 `extractor`（值是 "EN009"）这类本就不在正文里的字段，测「定位证据」必然 404，
> 那是数据的性质而不是缺陷。

## 8. 数据源：**优先流水线产物**

`/api/fields` 的取数顺序（第六轮改）：

```
build/extraction/<year>/<id>.json   ← 优先：LLM 抽取结果（每个字段都带 evidence）
        ↓ 不存在时降级
build/gold/<year>.json              ← 金标准（并在响应里给 warning 提示先跑 llm:run）
```

响应里带 `source: 'extraction' | 'gold'`、`model`、`generatedAt`，前端可显示当前在看哪一份。

**分组**（实测 2015-01）：

```
[article]        文章级（LLM 抽取）                              20 字段
[external]       Crossref 核验（match）                          4 字段
[studyOutcomes]  Sheet2 结局分类                                  7 字段
[cmp-0]          比较组 1                                        70 字段
[out-0..6]       结局 1..7：名称 / 工具（比较组序号）  46/21/26/26/26/27/22 字段
[otherOutcomes]  待人工确认纳入（2 条非六类候选）                    2 字段
```

- **三条数据源合并**：流水线值 / Crossref 权威值 / 人工覆盖层（`build/annotations/`），
  人工优先，且保留 `llmRaw` 供回滚；
- **`decidedBy` 现在有三种"非人工"来源**：`model`（LLM）、`deterministic`（本地编码推导）、
  `external`（Crossref 覆盖，如题名/期刊/年份）。前端对 `external` 会显示证据
  `Crossref title：10.1136/…`（`bbox` 为空，因此不提供"定位证据"按钮——外部值没有页面坐标）；
- **「待人工确认纳入」分组**对应需求「其他提取出的结局可以记录，最后交由人工判断是否纳入」：
  非六类的候选结局（合并用药、就诊次数等）显示在这一组，人工可编辑备注、也可用
  「＋新增字段」把它补进正式字段。

## 9. 诚实说明：当前状态的边界

1. **金标准里没有任何证据**（实测 1603 个字段中带 evidence 的为 0 个）——这也是必须切换到
   流水线产物的原因：只有流水线字段带 `page/bbox/quote`，"点字段→PDF 定位"才有内容。
   切换后实测结局层 46 个字段带可定位证据。
2. **不是所有字段都能定位**：`title`、`journal` 这类来自页眉/页脚的字段常常只有 quote 没有坐标，
   点值不会跳转（设计如此）。e2e 因此**数据驱动地挑一个确实带 bbox 的字段**做断言，
   而不是假定某个字段一定有坐标。
3. 前端测试三层：几何换算单测（13 例）→ 接口人机回环 `pnpm web:smoke`（20 项断言）
   → `pnpm web:e2e` 真实浏览器交互（11 例，见 §12）。

## 11. 导入文章 / 设置 / 后台任务（第二轮新增）

### 11.1 左上角「导入文章」

- 前端 `<input type=file>` 读字节 → `POST /api/import`（原始 body + `X-File-Name` 头，
  不引入 multipart 解析依赖）；服务端只校验 `%PDF` 头与大小上限（200MB）；
- **落地位置 `build/imports/<year>/`，绝不写 `Datas/`**：那是只读语料，
  混入上传件会让"金标准 vs 语料"的对应关系不可审计；侧车 `<id>.meta.json` 记录
  原始文件名、字节数、sha256、导入时间；
- 研究列表把两个来源合并（`source: 'corpus' | 'import'`），界面上标「（导入）」；
  `/api/pdf`、`/api/minidoc`、`/api/fields`、人工覆盖层对导入件同样可用
  （`studyOk()` 放宽为"能查到就合法"）；
- 文件名词干会清洗（去扩展名、去前导 `-`、非法字符转 `_`）——语料文件名带前导 `-`，
  直接沿用会生成 `-2015-01` 这种 id。

### 11.2 右上角「设置」（API 配置）

- `GET /api/settings` 返回 baseUrl / model / temperature / maxTokens / crossrefMailto，
  **密钥只回显掩码**（`sk-****…32ec`）与 `keyFromEnv` 标记；
- `PUT /api/settings` 写入 `runtime/llm.local.json`（mode 0600）；
  **apiKey 留空 = 不修改**，避免"只改模型"把密钥抹掉；
- `POST /api/settings/test` 走 `GET {baseUrl}/models`（不花 token），
  返回状态、耗时、可用模型列表与"当前模型是否在列表里"；
  所有错误先过 `redact()`——网关常把 Authorization 原样回显在报错里（实测过）。

### 11.3 后台任务：解析 / 抽取

顶栏「解析」= MinerU（`runtime/mineru/Scripts/mineru.exe -p <单篇> -o build/mineru/<year> -b pipeline -m txt`），
「抽取」= `node tools/llm_run.mjs --year Y --only <id>`。两者共用一个极简任务表：

- `POST /api/parse` / `POST /api/extract` 启动（**同一 (year, study, kind) 同时只允许一个**，
  避免并发跑 MinerU 抢显存）；`GET /api/jobs` 取状态与日志尾部（保留 200 行）；
- 前端每 2s 轮询，完成即自动刷新字段视图（抽取完成后不必手动刷新）；
- 参数以**数组**传给 `spawn`（不经 shell），路径里的空格不会被拆开、也没有注入面；
- 任务只存内存：本机单用户、任务短命，重启重跑即可，不引入"上次没跑完"的脏状态。

### 11.4 Sheet3 的「纳入抽取」

需求原文：「其他提取出的结局可以记录，最后交由人工判断是否纳入」。落地：

- 「待人工确认纳入」组里每条候选带一个「纳入抽取」按钮；
- 点击后写两条 `add` 标注到**新的行下标**：`outcomes.<N>.outcome.name` / `.instrument`
  （N = 当前行数），note 记「从「待人工确认纳入」纳入抽取」；
- 服务端据此把行数扩到 `max(产物行数, 覆盖层最大下标 + 1)`，并为该行铺出
  **与流水线同样的字段路径**作为空表单——
  模板取自该篇**真实结局行的叶子路径并集**（不硬编码字段清单，避免与 SKILL 漂移）；
- 于是纳入之后可以继续编辑、框选证据、补时点数值，与普通结局行完全一致。

## 12. 交互层测试（Playwright）

`e2e/web.spec.ts`，11 例，跑在真实 Chromium 上（`pnpm web:e2e`）：

| 用例 | 覆盖 |
|---|---|
| 页面加载 | 三张选项卡 + 顶栏（导入/设置）齐备 |
| 连续滚动 | 所有页都在、**远页未渲染**（`data-drawn`）、滚动后页码跟随 |
| 点字段定位 | 数据驱动挑带 bbox 的字段 → 滚到该页并出现高亮框 |
| 浏览模式框选 | 拖框后信息条显示"命中 N 块" |
| 标注模式全链路 | 框选 → 写证据 → **落盘校验（API 读回覆盖层）** → 回滚 |
| 编辑字段 | 改值 → 记为人工修改 → API 校验 → 回滚（值消失） |
| Sheet3 列序 | DOM 里字段 key 的顺序 == 布局列序（真按原表排布） |
| Sheet2 切换 | 能切过去且显示结局分类字段 |
| 纳入抽取 | 点击后行数 +1，且新行含 `outcomes.<N>.outcome.name` |
| 设置对话框 | 掩码显示、密钥输入框为空、能触发连通性测试 |
| 导入文章 | 上传 → 出现在研究列表（`source=import`）→ PDF 可访问 |

两条工程约定：

1. **测试不留副作用**：每例先快照 `build/annotations/` 覆盖层、结束后原样还原；
   导入的 PDF 用完即 `DELETE /api/import`（否则会污染真实数据）；
2. **不复用语料文件名**：导入用 `setInputFiles({ name: 'e2e-import.pdf', buffer })`，
   避免生成 `-2015-01` 这类 id。

## 10. 曾经的待办（本轮已完成）

1. ~~「待人工确认纳入」的纳入动作~~ → §11.4 已实现（`add` 到新行下标 + 空表单模板）；
2. ~~多页滚动视图~~ → §1.3 已实现（连续滚动 + 惰性渲染 + 每页 rotate 感知）；
3. ~~交互层 Playwright 测试~~ → §12 已实现（11 例全绿）。

