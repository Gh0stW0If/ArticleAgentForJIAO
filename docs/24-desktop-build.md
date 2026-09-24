# 桌面版（Electron / portable exe）的构建与验收

> 目标：**让 exe 里的提取流程始终是最新版**。
> 相关文件：`apps/desktop/electron-builder.yml`、`tools/desktop_make.mjs`、`tools/desktop_verify.mjs`、
> `tools/desktop_stage_modules.mjs`。

## 0. 一条命令

```powershell
node tools/desktop_make.mjs      # 编译 5 个包 → staging → 打 portable exe
node tools/desktop_verify.mjs    # 验收（8 项，全过才算数）
```

`desktop_make` 的顺序不能改：**先编译、再 staging、最后打包**。

## 1. exe 里装了什么、不装什么

`electron-builder.yml` 的 `files` 决定内容：

| 装进 exe | 说明 |
|---|---|
| `apps/desktop/main.mjs`、`package.json` | Electron 主进程 |
| `apps/web/dist`、`apps/web/server.mjs` | 前端 + 本地服务 |
| `tools/`（全部 `.mjs`） | 流水线脚本（`llm_run.mjs` 等）|
| `packages/{core,crossref,europepmc,ingest,skills}/dist` | 各包的编译产物 |
| **`node_modules/@aa/*`** | 由 `tools/desktop_stage_modules.mjs` 生成 |

**不装**：`Datas/`、`build/`、`runtime/`、`docs/` —— 这些属于**工作区**（用户数据），
由 Electron 启动时选定的工作区目录提供（通过环境变量 `AA_ROOT`）。

## 2. 踩过的三个坑（都已修，验收里各有一条对应）

### ① 裸包名解析不到（**整个「抽取」按钮全废**）

各包的 dist 之间用裸包名互相 import（如 `import { warn } from '@aa/core'`），
而 exe 里原本没有 `node_modules`，实测：

```
$ node build/desktop/win-unpacked/resources/app/tools/llm_run.mjs --year 1999
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@aa/core'
  imported from ...\resources\app\packages\ingest\dist\ingest.js
```

修法：`tools/desktop_stage_modules.mjs` 生成 `build/desktop-stage/node_modules/@aa/<pkg>`，
每个包**只要 `package.json` + `dist`**（这 5 个包没有第三方依赖，不必搬 pnpm 依赖树），
再由 `files` 里的 `from: ../../build/desktop-stage/node_modules` 带进 exe。

### ② 新增的 `@aa/europepmc` 没进清单

`article-meta` 现在会 `import '@aa/europepmc'`，而 `files` 里原来只有 4 个包的 dist
→ 重打包后一跑抽取就 `ERR_MODULE_NOT_FOUND`。已补 `packages/europepmc/dist`。

### ③ 子进程把数据写进了 exe 自己的目录（**产物界面看不到**）

`tools/llm_run.mjs` 原本写死 `ROOT = 脚本所在目录的上一级`：
- 命令行下 = 仓库根（没问题）
- **打包后 = `resources/app`** → 读不到工作区的 `runtime/llm.local.json`（报"未找到配置文件"），
  抽取产物也写进 exe 的解包目录，界面永远看不到

修法：`ROOT` 支持 `AA_ROOT`（桌面壳启动时写入工作区路径，子进程继承环境变量）：

```js
const ROOT = process.env.AA_ROOT
  ? resolve(process.env.AA_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');
```

## 3. 验收做了什么（`tools/desktop_verify.mjs`）

| # | 检查 | 不通过意味着 |
|---|---|---|
| ① | `resources/app/node_modules/@aa/*` 存在 | 裸包名解析不了（坑 ①） |
| ② | 打包版 `packages/skills/dist` 能被 import | 同上 |
| ③ | `packages/europepmc/dist` 在包里 | 坑 ② |
| ④ | 跑一次打包版入口，与**工作区入口**对同一输入输出一致 | ROOT 没落到工作区（坑 ③） |
| ⑤ | 打包版提示词含新口径特征串（如「按原文怎么写就怎么记」「1 月 = 4 周」） | 打进 exe 的是旧 dist |
| ⑥ | exe 时间 ≥ 所有**入包代码**的最新修改时间 | 改了代码没重打包 |

第 ④ 条用"不存在的年份"走业务报错路径，**不花 token**：
打包版与工作区版都应打印同一行 `[影响因子] 用索引 build/if-2019.json（9366 个期刊）`
再报 `1999 下没有找到 PDF` —— 能读到工作区的 `build/` 就证明 `AA_ROOT` 生效了。

## 4. 真机冒烟（一次性，需花 token）

验收之外，可让**打包后的 exe 本体**跑一篇真实抽取（以 `2015-01` 为例）：

```powershell
# 先备份会被覆盖的产物
Copy-Item build/extraction/2015/2015-01.json build/_backup_2015-01_extraction.json -Force

$env:ELECTRON_RUN_AS_NODE = '1'
$env:AA_ROOT = 'E:\dshproject\article agent'
& 'build\desktop\win-unpacked\Article Agent.exe' `
    'build\desktop\win-unpacked\resources\app\tools\llm_run.mjs' --year 2015 --only 2015-01

# 跑完对比产物、确认无误后还原备份
Copy-Item build/_backup_2015-01_extraction.json build/extraction/2015/2015-01.json -Force
```

`ELECTRON_RUN_AS_NODE=1` 让 Electron 主程序以 node 模式执行脚本（与 GUI 里「抽取」按钮的启动方式一致）。

**2026-09-18 实跑结果**（打包后的 exe 本体，非工作区脚本）：

```
[影响因子] 用索引 build/if-2019.json（9366 个期刊）      ← 读的是工作区
配置   E:\dshproject\article agent\runtime\llm.local.json ← 读的是工作区
──── 2015-01 ────
  MiniDoc: 136 块 / 11 页 / 表 6 / 图 1
  ⏎ 命中缓存 study-plan@0.1.0:2015-01
  ⏎ 命中缓存 article-meta@0.1.0:2015-01
  …（其余 SKILL 同样命中缓存）
```

3 秒跑完并写出完整产物（23 个文章级字段 / 1 个比较组 / 7 条结局行 / pipeline 里含
studyPlan、outcomePlan、outcomeValues、outcomeAudit 五段统计）。

**"命中缓存"本身就是证据**：LLM 缓存的键是 `hash(tag + system + user)`，
打包版能命中工作区跑出来的缓存，说明**exe 里的提示词与工作区当前提示词逐字一致**
（若提示词旧了，键不同 → 必然 miss 并触发真实请求）。

产物留档：`build/_exe_smoke_2015-01.json`；工作区原产物已还原（字节一致），
所以这次冒烟**没有改变评测状态**。

## 5. 什么时候必须重打包

只要下面任何一处改动，exe 就旧了（`desktop_verify` 第 ⑥ 条会报出来）：

- `packages/*/src` 或 `dist`（提示词、SKILL、core 工具）
- `tools/` 下的 `.mjs`（流水线脚本本身）
- `apps/web/server.mjs`、`apps/web/src`（界面）
- `apps/desktop/main.mjs`

不影响的：`docs/`、`build/`（报告、评测、金标准产物）、`Datas/`。
