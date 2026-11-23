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
- **覆盖率口径（Sheet3 已切换）** —— 只问「金标准要的，机器给了没有」：
  一个产物结局行可以供给多个金标准行（多对一）、同一篇内的重复要求只计一次、
  机器多抽而金标准没要的行**不判错**。选边规则是
  `score ≥ MIN_SCORE 且（有词面对上 或 数值佐证 ≥2）` ——
  ⚠️ 只看 `score` 会让漏抽退化成 0（construct/subconstruct 加成足以越过阈值），
  只看文本又会拒掉真匹配（金「BI score change」↔ 产「ADL / BI: Barthel Index」文本分只有 0.33）。
  单测 `tools/align.test.mjs` 把这两个坑钉死了。
- **结局行人工裁定** —— Sheet3 顶部列出「金标准没要的结局行」（11 年共 354 行，≈ 每篇 1.6 行），
  每条附**最接近的金标准行**与 PDF 证据，就地「保留 / 丢弃 / 撤销」。
  裁定按核对人分开存（`build/adjudications/`），**有分歧不替人裁决**（按保留处理并标出）。
  被丢弃的行**整行从导出的 Sheet3 里消失**，并在「核对汇总」页留痕。
  接口：`GET/POST /api/adjudication`。

导出用零依赖自写 ZIP + OOXML（`tools/lib/zipwrite.mjs` / `xlsxwrite.mjs`），
导回解析与差异计算在 `tools/import_review.mjs`（纯逻辑，可单测）。

接口：`GET /api/export` · `POST /api/import-review` · `GET /api/review-sets` · `GET /api/compare`。

详见 `docs/26-202609-字段删减与多人核对.md`。

**删减已实际生效**：金标准重建（224 篇不变，只删该删的 1,695 个叶子）+ 11 年评测重跑。

⚠️ **准确率数字经历过一次口径切换，两个数不能直接比**：

| | 严格 1:1 口径（旧） | 覆盖率口径（现行） |
|---|---|---|
| Sheet1 | 63.6% | 63.6% |
| Sheet2 | 73.8% | 73.8% |
| Sheet3 | 35.9% | **45.9%** |
| 合计 | 49.2% | **58.1%** |

差的那 8.9 点**全部来自 Sheet3 的口径变化**（分母 27,498 → 12,333），
**不是抽取变好了**。旧口径下"漏抽"占总失分 41.2%，换口径后只剩 11.5% ——
说明那一块大半是「结局行 1:1 配对」造成的假象；现在 Sheet3 的主要问题变成了
**抽错**（53.7%）。详见 `docs/26` 第 13 节。

同口径下的历史对比：删减 8 个字段前 48.95% → 删减后 49.16%（+0.20 点）——
那是**分母变小的算术变化**，被删的列平均只有 41.65%，低于整体。

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
pnpm accuracy:coverage            # **覆盖率口径**：只问"金标准要的机器给了没有"
pnpm report:clinicians            # 面向医生的讨论报告
pnpm web:e2e                      # Playwright 端到端
pnpm desktop:build                # 打包便携 exe（不带数据，给开发者/演示）
pnpm desktop:installer            # **医生安装包**：软件 + 抽取结果 + 原文 PDF → setup.exe
pnpm desktop:installer:verify     # 安装包验收（拿它当工作区真跑一遍服务）
```

完整清单见 `package.json` 的 `scripts`。

## 给医生的安装包

`pnpm desktop:installer` 产出 `build/desktop-installer/ArticleAgent-<版本>-setup.exe`
（当前 11 年语料下约 **278 MB**）。**装完打开就能核对**：

- 已内置 **11 个年份 / 235 篇**的机器抽取结果 + 原文 PDF + 金标准
- **不需要配 API 密钥**（只有要重新跑抽取时才需要，在「设置」里填）
- 桌面与开始菜单快捷方式；按用户安装到 `%LOCALAPPDATA%\Programs\Article Agent`（可写，
  核对记录才存得下）
- 包内附 `使用说明.txt`、`备份我的核对记录.bat`、`打开数据文件夹.bat`

⚠️ **包里不含 API 密钥**：打包与验收都会用 `tools/lib/secret_scan.mjs` 扫一遍，
`runtime/llm.local.json` 或任何 `sk-…` 命中就中止打包。
⚠️ 卸载会连核对记录一起删（记录就在安装目录里）—— 先跑那个 .bat 备份。

裁剪依据（为什么是 608 MB payload 而不是 2.2 GB）见 `docs/24-desktop-build.md` 第 6 节。

## 文档

从 `docs/10-roadmap.md`（路线图与现状）和 `docs/24-desktop-build.md`（交付）入手；
第二篇（PRECIS-2）从 `docs/29-precis2-第一批实现.md` 入手；
设计与实测细节见 `docs/04`–`docs/09`、`docs/20`–`docs/23`。
