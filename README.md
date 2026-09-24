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
pnpm report:clinicians            # 面向医生的讨论报告
pnpm web:e2e                      # Playwright 端到端
pnpm desktop:build                # 打包便携 exe
```

完整清单见 `package.json` 的 `scripts`。

## 文档

从 `docs/10-roadmap.md`（路线图与现状）和 `docs/24-desktop-build.md`（交付）入手；
设计与实测细节见 `docs/04`–`docs/09`、`docs/20`–`docs/23`。
