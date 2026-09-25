# ArticleAgentForJIAO

从 PDF 研究文章中按三层结构自动提取信息的多 Agent 流水线，配套本地 Web 界面与 Electron 桌面程序，
用于针刺类随机对照试验（RCT）的系统评价数据提取与人机核对。

三层结构对应医生工作簿的三张表：

| 层 | 对应工作表 | 一行 = 什么 |
|---|---|---|
| `article.*` / `comparison.*` | Sheet1 | 一篇文章 / 一个比较组 |
| `study.*` | Sheet2 | 一篇文章（结局分类） |
| `outcome.*` / `followUp.*` / `timepoints.*` | Sheet3 | 一个（比较组 × 结局） |

## 版本状态

本仓库是 **冻结快照**，标签：`v0.1.0-freeze-20260924`。

冻结时的工作区状态为：2015–2025 十一个年份的抽取已跑通，三张表均有逐字段准确率评测，
Web/桌面端具备人工覆盖层（`add` / `override` / `confirm`，不改写机器原始结果）。
已知缺口（`docs/10-roadmap.md`）：无 XLSX/CSV 导出、无多人评审、二分类与生存结局的 OR/RR/RD/HR 尚未抽取、
`build/eval` 与 `build/extraction` 存在版本漂移。

## 本分支新增（`feat/202609-prune-and-review-records`）

按 202609 的新要求做了这些事：

- **提取项目删减** —— 按列规则退役 6 个 Sheet1 列（E/F/AW/BB/BC/BK）与 2 个 Sheet3 列（E/R）
  对应的字段，**抽取与评测同步移除**（只删抽取会让这些列被判成「漏抽」，白掉准确率）。
  清单与依据见 `tools/canonical-field-map.mjs` 的 `RETIRED_FIELDS`。
- **多人机核对** —— 标注改为**一位核对人一份文件**
  （`build/annotations/<year>/<study>.<reviewer>.json`），支持多人独立盲评；
  逐字段给出「一致 / 分歧 / 仅一人 / 未核对」四态，
  **有分歧的字段不替人取值**（保留机器原值并标出），等第三方仲裁。
- **导出人工核对结果** —— 「导出 XLSX / 导出 CSV」。
  XLSX 含 4 个工作表（`核对汇总` + `Sheet1/2/3`）：每个字段一行、每位核对人三列（值/动作/备注）、
  **有分歧的行整行标红**；CSV 列结构相同、带 UTF-8 BOM 供 Excel/AI 读。
- **批量导出** —— 「批量 ▾」菜单：整年 / 全部年份。批量时每行多带 `年份`/`研究` 两列，
  缺抽取产物的篇目跳过并计数。
- **导回** —— 医生改完的表格传回来即可写回标注。**默认 dry-run 先给差异预览**，
  显式确认才落盘；只增改默认不删；动作由「值 vs 机器值」现算而不是信文件里的过期快照；
  每次导回落一份批次快照（`build/review-batches/`）供追溯。
- **文件署名** —— **导出必须署名**（导出人 / 时间 / 范围 / 规模写进文件），
  导回时校验署名：不一致或签名块损坏就**拒绝写入**，勾「忽略署名异常」才放行，
  且**改动记到署名者名下**（生效身份由署名决定，不是界面输入框）。
  XLSX 放在 `签名` 工作表，CSV 放在首行 `#` 注释。
  ⚠️ 校验和只防"签名块被表格软件改坏"，**不是防篡改签名**——文件本来就要给人编辑。
- **两组结果对比** —— 任选两组（机器 / 各位核对人 / 导入批次）逐字段并排，
  四态 `一致 / 不同 / 仅 A 有 / 仅 B 有`；
  「没表态」不算「一致」，一致率只在两组都表过态的字段上算。
- **界面标题对齐原表** —— Sheet3（结局）的字段标题改为**金标准表里的中文表头名**
  （`结局名称`、`基线期 · 连续型变量 · 试验组效应量`…），不再是医生看不懂的契约路径
  （`outcome.name`、`timepoints.baseline.contin.effect`）。对照表在
  `tools/outcome-field-map.mjs`，单测拿 `@aa/skills` 的契约遍历全部 111 个结局字段对，
  契约加字段而对照表漏补会直接红。老抽取产物里残留的退役字段也在展示层挡掉了
  （`RETIRED_KEYS`，不动产物文件）。
- **界面字体档位** —— 设置里「小 90% / 中 100% / 大 120%」三档，立即生效、本机记住
  （`localStorage`，不进服务端配置）。实现是根容器 CSS `zoom`：
  一次生效、行高间距一起变。⚠️ 两个已处理的副作用：容器**宽度保持 `100%` 不除倍数**
  （`%` 是在缩放后的坐标系里解析的，除了反而右边留白 245px；高度用 `100/倍数 vh`，`vh` 才是在真实视口里解析）、
  框选 PDF 的坐标换算要除以倍数（Chromium 的 `getBoundingClientRect()` 返回缩放后坐标）。

导出用零依赖自写 ZIP + OOXML（`tools/lib/zipwrite.mjs` / `xlsxwrite.mjs`），
导回解析与差异计算在 `tools/import_review.mjs`（纯逻辑，可单测）。

接口：`GET /api/export` · `POST /api/import-review` · `GET /api/review-sets` · `GET /api/compare`。

详见 `docs/26-202609-字段删减与多人核对.md`。

**删减已实际生效**：金标准重建（224 篇不变，只删该删的 1,695 个叶子）+ 11 年评测重跑。
统一口径 **48.95% → 49.16%（+0.20 点）**。⚠️ 这是分母变小带来的算术变化——
被删的列平均只有 41.65%，低于整体，**不是提取质量变好了**。

重建金标准必须用 `pnpm gold:rebuild`（= `gold_normalize --apply-reconcile` + `gold_fix_units --apply`）：
少第一个参数文章数会静默变成 230，少第二步会冲掉带单位三列的修正。

## ⚠️ 本仓库不含数据与私有配置

以下目录被 `.gitignore` 排除，**clone 后需要另行准备**，否则无法跑端到端流程：

| 目录 | 内容 | 为什么排除 |
|---|---|---|
| `Datas/` | 期刊 PDF 原文、金标准 Excel、外部提供的资料 | 版权与体积（数百 MB） |
| `runtime/` | 本地私有配置（含 LLM API key） | 凭证安全，绝不入库 |
| `build/` | MinerU 解析、抽取产物、评测结果、缓存 | 生成物，体积数 GB |
| `node_modules/` | 依赖 | 可由 lockfile 还原 |

LLM 配置可放在 `runtime/llm.local.json`，或用环境变量 `DEEPSEEK_API_KEY` / `AA_LLM_MODEL` 覆盖。

## 目录结构

```
apps/
  web/           本地 Web 界面（Vite + React）：PDF 连续滚动、三层叠加框选、人工覆盖层
  desktop/       Electron 桌面壳（工作区与代码分离）
packages/
  core/          证据契约与不变量、三层类型、单位与 LaTeX 规范化
  ingest/        MinerU 解析产物 → MiniDoc 规范化
  crossref/      Crossref 元信息核验
  europepmc/     Europe PMC 题名补全
  skills/        LLM 抽取技能（article / comparison / outcome / outcome-plan / outcome-values / audit）
tools/           流水线、评测、审计脚本（一个脚本一个可复现问题）
docs/            设计与实测记录（docs/00 – docs/25，按时间累加）
e2e/             Playwright 端到端测试
```

## 快速开始

```bash
pnpm install
pnpm check            # typecheck（5 个目标）+ 单元测试
pnpm web:api          # 本地 API（127.0.0.1:43130）
pnpm web:dev          # 前端开发服务器
```

需要 Node.js ≥ 20、pnpm 11。

## 常用命令

```bash
pnpm check                        # typecheck + 测试
pnpm fields:coverage              # 字段与编码集覆盖审计
pnpm gold:anomalies               # 金标准异常检测
pnpm gold:vs-paper                # 取证：金标准的值是否真在论文里
pnpm llm:run --year 2015          # 跑抽取
pnpm llm:eval --year 2015         # 评分
pnpm accuracy:overview            # 三张工作表的准确率（统一口径）
pnpm accuracy:diagnose            # **失分归因**：分丢在哪、是漏抽还是抽错
pnpm report:clinicians            # 面向医生的讨论报告
pnpm web:e2e                      # Playwright 端到端
pnpm desktop:build                # 打包便携 exe
```

完整清单见 `package.json` 的 `scripts`。

## 文档

从 `docs/10-roadmap.md`（路线图与现状）和 `docs/24-desktop-build.md`（交付）入手；
设计与实测细节见 `docs/04`–`docs/09`、`docs/20`–`docs/23`。
