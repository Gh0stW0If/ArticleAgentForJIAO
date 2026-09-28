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

---

## 6. 医生安装包（**带数据**，NSIS setup.exe）

> 与上面 portable exe 的分工：
> portable = 单文件、**不带数据**，给开发者/演示；
> 安装包 = NSIS、**带最近一次抽取结果 + 原文 PDF**，给医生，**装完打开就能核对**。

```powershell
node tools/desktop_installer.mjs                    # 全部年份 + PDF → setup.exe
node tools/desktop_installer.mjs --years 2025       # 只带某年
node tools/desktop_installer.mjs --no-pdf           # 不带原文（最小，但点不了"定位证据"）
node tools/desktop_installer.mjs --payload-only     # 只生成工作区，不打包
node tools/desktop_installer_verify.mjs --root build/desktop-installer/win-unpacked
```

相关文件：`apps/desktop/electron-builder-installer.yml`、`tools/desktop_installer.mjs`、
`tools/desktop_installer_verify.mjs`、`tools/lib/secret_scan.mjs`。

### 6.1 装哪些数据：只带**服务端真正读的**

实测 11 年语料的裁剪效果（608 MB payload → **278.5 MB 安装包**）：

| 目录 | 原样 | 进包 | 依据 |
|---|---|---|---|
| `Datas/articles/<年>/*.pdf` | 436 MB | **261 MB** | 只取 `<年>/` 下的正文 PDF；根目录的 `2024.zip` 等**原件压缩包**（175 MB）运行时用不到 |
| `build/mineru/` | **1303 MB** | **287 MB** | ⚠️ 服务端**只读 `<stem>/<sub>/*_middle.json`**（`mineruDirOf` + `loadMiniDoc`）。同目录的 `images/`、`*_span.pdf`、`*_layout.pdf`、`*_origin.pdf`、`*_model.json` 一个都不读 —— **裁掉它们省了 1 GB** |
| `build/extraction/` | 55 MB | 55 MB | 界面显示的就是它 |
| `build/gold/<年>.json` | 14 MB | ~5 MB | Sheet3「待人工裁定」要靠它算；`_reconcile.json`/`naive/` 是审计件，不带 |

### 6.2 ⚠️ 三条不能想当然的地方

**① 绝不能带 API key。** `runtime/llm.local.json` 里是真实密钥，塞进安装包等于
发给每个拿到包的人。所以 payload 里只放**空的 `runtime/`**（`isWorkspace()` 要求它存在），
密钥由医生在「设置」里自己填 —— **只想核对的话根本不用填**。
打包脚本与验收脚本都会用 `tools/lib/secret_scan.mjs` 扫一遍，命中就直接失败。

> 这个扫描器**只扫文本文件**（扩展名白名单）。第一版"除了大 json 之外全读成 utf8"，
> 结果 Electron 的 `locales\nl.pak`（二进制）里恰好有一段字节构成 `sk-` + 16 位字母数字，
> **打包被无谓拦住**；反过来 PDF 的压缩流同样会碰巧匹配，让人不敢相信这个检查。
> 单测 `tools/secret_scan.test.mjs` 把两个方向都钉住了。

**② 必须按用户安装（`perMachine: false`）。** 默认落到
`%LOCALAPPDATA%\Programs\Article Agent`，**当前用户可写**。
核对记录写在 `<安装目录>\build\annotations\`，装到 Program Files 下普通用户写不进去，
一核对就报错。

**③ 数据要落在 exe 旁边，用 `extraFiles` 而不是 `extraResources`。**
主进程是按"exe 所在目录"（`dirname(app.getPath('exe'))`）认工作区的（见 `main.mjs`
的 `resolveWorkspace`）。`extraResources` 会落进 `resources\`，认不出来；
`extraFiles` 正好落在 exe 旁边，于是 `Datas/ build/ runtime/` 一眼就被认出来 ——
**不需要改一行主进程代码**。

### 6.3 验收不能只看"文件在不在"

`desktop_installer_verify.mjs` 会**拿 payload（或解包出来的安装目录）当工作区，
把服务真跑起来点一遍**：

```
✓ 服务已启动（AA_ROOT=payload）
✓ 2025 年列出 32 篇研究
✓ 2025-01 字段来自抽取产物（source=extraction）
✓ Sheet3 有 8 个结局行
✓ MiniDoc 有 151 个文本块 / 10 页   ← 证明 *_middle.json 的目录层级装对了
✓ PDF 可下载（文件头 %PDF）
✓ 「待人工裁定」可用（2025-01 有 4 条）
✓ 未夹带 API 密钥
```

为什么必须真点：`build/mineru/` 每个目录有 8 个文件、服务端只读其中一个。
**只要目录层级错一层，打包不报错、安装也正常，但医生一打开就是"定位证据没反应"。**

### 6.4 医生看到的是什么

安装目录根下：

```
Article Agent.exe            ← 桌面/开始菜单快捷方式指向它
Datas/articles/<年>/*.pdf    ← 原文
build/extraction/            ← 机器抽取结果
build/mineru/                ← 只含 *_middle.json（定位证据用）
build/gold/                  ← 金标准
build/annotations/           ← 他的核对记录（★ 要备份的就是这里）
build/adjudications/         ← 结局行裁定
runtime/                     ← 空；填了 API key 才会出现 llm.local.json
使用说明.txt                  ← 双击可读（UTF-8 **带 BOM**，防老记事本按 GBK 解）
备份我的核对记录.bat           ← 一键把三类记录复制到带日期的文件夹
打开数据文件夹.bat
```

> ⚠️ **卸载会连核对记录一起删掉**（记录就在安装目录里）。
> 所以包里带了一键备份脚本，`使用说明.txt` 里也把这条写在最显眼的位置。
> 这是"零配置安装"换来的代价：数据就在程序旁边，备份/迁移要靠那个 .bat。

---

## 7. `maxTokens: 0` = 不限制（换长输出模型时必须知道）

`runtime/llm.local.json` 与界面「设置」里的 `maxTokens`，填 **0** 表示**不限制**：
客户端会**整个省略** `max_tokens` 参数（不是填 0、也不是填 null），
由服务端用它自己的默认上限。实现在 `packages/skills/src/deepseek.ts` 的 `noMaxTokens`。

**为什么需要这个口子**：默认 8000 对长输出模型不够。实测 `gpt-6-sol` 在
`outcome-values` / `outcome-audit` 这类调用上会顶到 8000，`finish_reason === 'length'`，
回来的是一段**被截断的 JSON**，解析失败 → **整段字段白丢**：

```
outcomes.3（health-related quality of life (mental component)）取值失败：
输出被 max_tokens(8000) 截断，JSON 必然不完整——请提高 maxTokens
```

而"到底该填多少"没人说得准（各模型上限不同），所以**"不填"比"拍一个数"可靠**。

截断的报错信息会区分两种情形（未限制时不再谎报成"max_tokens 的锅"）：

| 情形 | 报错 |
|---|---|
| 设了 maxTokens | `输出被 max_tokens(8000) 截断…` |
| 未限制（0） | `输出被服务端上限截断（本次未限制 max_tokens）…` |

回归测试：`packages/skills/src/__tests__/deepseek.test.ts` 断言
`maxTokens: 0` 时请求体里**没有** `max_tokens` 字段（而不是 0 或 null）。

> ⚠️ 这是**客户端行为**，服务端不一定认。实测 `https://api.lvping.cloud/v1`
> 省略 `max_tokens` 正常工作。

---

## 8. 干净机器上什么能用、什么不能用

> 结论：**核对全流程零依赖**；「抽取」也能用（不需要系统装 Node）；
> **只有「解析」用不了**（要 MinerU 的 Python 环境，几 GB，没打进包）。

### 8.1 逐项

| 功能 | 干净机器 | 依据 |
|---|---|---|
| 打开界面、看 PDF、看抽取结果 | ✅ | Electron 自带 Chromium + Node，机器上**不用装 Node** |
| 点字段定位证据 / 解析块 / 框选证据 | ✅ | 靠包内的 `*_middle.json` 与 PDF |
| 编辑 / 确认 / 回滚 / 新增字段 | ✅ | 只写安装目录下的 `build/annotations` |
| Sheet3「待人工裁定」保留 / 丢弃 | ✅ | 只写 `build/adjudications` |
| 导出 XLSX / CSV、导回、两组对比 | ✅ | 零依赖自写的 ZIP/OOXML |
| **重新抽取**（顶栏「抽取」） | ✅ | ⚠️ 见下：spawn 的是 **Electron 自带的 Node**，不需要系统 Node；只需在「设置」里填自己的 API key |
| **重新解析 PDF**（顶栏「解析」） | ❌ | 需要 `runtime/mineru/Scripts/mineru.exe`；没装会返回**友好报错**（`MinerU 未安装：<路径>`），不会崩 |

### 8.2 「抽取」为什么不需要系统 Node

```js
startJob('extract', …, process.execPath,
  [join(APP_DIR,'tools','llm_run.mjs'), '--year', year, '--only', study],
  { ELECTRON_RUN_AS_NODE: '1' })          // ← 关键
```

`process.execPath` 是 Electron 主程序本身；带上 `ELECTRON_RUN_AS_NODE=1` 它就**以 node 模式**
跑那个脚本。所以不需要机器上有 node，也不需要 PATH 里有任何东西。

### 8.3 「解析」为什么进不了包

MinerU 是 Python 环境 + 数 GB 模型，塞进安装包会让体积翻好几倍。
所以设计上就是：**解析与抽取在开发机做，医生只做核对**。
包内已带 235 篇的解析与抽取结果，医生不需要自己跑。

### 8.4 依赖完整性怎么保证

打包只搬 `@aa/*`（各包 dist）+ 壳代码，**不搬第三方依赖**。因此只要哪个 `.mjs`
import 了一个第三方包，开发机上永远发现不了（`node_modules` 就在旁边），
一到干净机器就 `ERR_MODULE_NOT_FOUND`。

用 `pnpm desktop:dep-scan` 从**两个真实入口**（`apps/web/server.mjs`、
`tools/llm_run.mjs`）做可达性遍历，检查可达模块在包内是否都能解析。实测：

```
可达文件 65 个
node 内置 7 个：child_process, crypto, fs, http, path, url, zlib
裸包依赖 3 个：@aa/core, @aa/crossref, @aa/europepmc
✓ 运行时用到的模块在包内全部可解析
```

> 为什么按**可达性**扫而不是扫全目录：`tools/` 里有一堆开发/审计脚本
> （`deck_layout_check.mjs`、`_shot.mjs`…）import 了 `playwright` 这类打包不会带的依赖，
> 全目录扫描会把它们误报成"缺依赖"，而服务端永远不会调用它们。
> 这条检查已接进 `pnpm desktop:installer:verify`（§3）。

### 8.5 干净机器上的两个实际提醒

1. **安装包没有代码签名**（`forceCodeSigning: false`，本机自用）。
   Windows SmartScreen 会拦一次：**「更多信息」→「仍要运行」**。
   要消除得买代码签名证书。
2. **系统要求**：Windows 10/11 64 位（Electron 44 不支持 Win7/8）。
   安装后占用约 **994 MB**（程序 386 MB + 原文 260 MB + 产物 348 MB），
   安装包本身 278 MB。

