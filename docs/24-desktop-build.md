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

---

## 9. macOS（Apple Silicon / arm64）

> **⚠️ 结论先行：这台 Windows 开发机打不出 mac 包 —— electron-builder 直接拒绝。**

### 9.1 为什么不能在本机打

实测：

```
$ npx electron-builder --mac dir --arm64 --config electron-builder-mac.yml
  • electron-builder  version=26.15.3 os=10.0.19045
  ⨯ Build for macOS is supported only on macOS, please see
    https://electron.build/multi-platform-build
```

三条硬约束，都不是配置能绕过的：

| 需要什么 | 为什么 | 本机 |
|---|---|---|
| **macOS 系统** | electron-builder 明确只在 mac 上构建 mac 目标 | Windows ❌ |
| **`hdiutil` / `productbuild`** | mac 的"安装包"就是 `.dmg` / `.pkg`，只存在于 macOS | 两个都没有 ❌ |
| **`codesign`** | arm64 上**所有**可执行代码至少要 ad-hoc 签名 | 没有 ❌ |

另外本机 `node_modules/electron/dist` 是 **win32-x64** 运行时（`path.txt = electron.exe`），
electron-builder 缓存里也没有 darwin 的 Electron。

### 9.2 正确做法：GitHub Actions 的 `macos-14`（就是 Apple Silicon）

已加好 `.github/workflows/build-macos.yml`：

```
GitHub → Actions → build-macos-arm64 → Run workflow
产物：Artifacts → ArticleAgent-macOS-arm64（.dmg + .zip）
```

`macos-14` 这个 runner 就是 arm64。流程：编译 → 跑测试 → `desktop_stage_modules`
→ 生成图标 → `electron-builder --mac --arm64` → 最后**顺手跑一遍
`desktop_dep_scan`** 确认包内没有缺失的第三方依赖。

### 9.3 ⚠️ CI 打出来的包**不含数据**

工作区数据（`Datas/` `build/` `runtime/`，约 608 MB）在 `.gitignore` 里，
**根本不在仓库里**，CI 拿不到。所以：

- CI 产出 = **只有程序**（约 400 MB 的 .app）
- 数据要**另外拷给医生**（与 Windows 包用同一份 `build/desktop-payload`）

mac 上的摆放方式（`main.mjs` 已按此改好，见 9.4）：

```
某个目录/
├── Article Agent.app          ← 从 dmg 拖出来
├── Datas/                     ← 数据与 .app **并排**
├── build/
└── runtime/
```

数据必须放在 `.app` **旁边**：mac 的 exe 实际在
`Article Agent.app/Contents/MacOS/`，`dirname(exe)` 是 **.app 内部** ——
数据放那儿不符合 mac 习惯（app 包应当可整体替换），也不便于备份。

> 想把数据**一起**塞进 dmg：先 `node tools/desktop_installer.mjs --payload-only`，
> 再打开 `electron-builder-mac.yml` 里 `dmg.contents` 那段注释
> （把 `Datas`/`build`/`runtime` 与 `.app` 并排摆进 dmg，医生一起拖出来）。

### 9.4 为 mac 改了什么代码

| 文件 | 改动 | 为什么 |
|---|---|---|
| `apps/desktop/main.mjs` | `resolveWorkspace()` 增加 `.app` 所在层的候选路径（往上三级 + 其下的 `workspace/`），候选去重 | 见 9.3；不改的话 mac 版一启动就弹"选择工作区" |
| `apps/web/server.mjs` | MinerU 路径按平台分（Windows `Scripts/mineru.exe` / mac-Linux `bin/mineru`），报错文案也说明"安装包不带解析环境" | 原来硬编码 Windows 路径，mac 上会报一个不存在的路径 |

`process.execPath` + `ELECTRON_RUN_AS_NODE=1`（「抽取」用）在 mac 上同样成立，
所以 **mac 版也不需要装 Node**。

### 9.5 未签名会怎样、怎么绕过

> ⚠️ 这一节我第一版写错过，已按 electron-builder 官方文档改正：
> 原文说"arm64 上所有可执行代码至少要 ad-hoc 签名 → 未签名根本起不来（拒绝执行）"。
> **这个说法太强**。官方文档明确：*"On Apple Silicon, unsigned apps can still be
> run locally by approving them in System Settings → Privacy & Security."*
> 未签名/未公证的 app 会被 **Gatekeeper 拦一次**，但用户批准后可以运行。

`mac.identity` 的四种取值（见 `electron-builder-mac.yml` 注释）：

| 取值 | 行为 |
|---|---|
| 不设（本仓库当前） | 从钥匙串找证书；**找不到就跳过签名** |
| `null` | 完全跳过签名 |
| `"-"` | **ad-hoc 签名**（自签、无 Team ID）。electron-builder 会自动给 app 与嵌套二进制加上 `allow-jit` + `disable-library-validation` 两项 entitlement（因为 Electron 预编译框架带 Apple 的 Team ID，不关库校验会起不来） |
| 证书名 | 用指定证书 |

⚠️ 两个容易写错的地方：
- 写 `identity: null` 是**错的默认** —— 它连 ad-hoc 都不做。想要 ad-hoc 必须显式 `"-"`。
- 但 `identity: "-"` 也**不能写死在 yml 里**，否则会顶掉真证书。
  所以本仓库的 yml **不写 identity**，由调用方决定：
  CI 里导入了证书就自动发现，没有证书时由 workflow 传 `-c.mac.identity=-`。

**医生拿到未签名包时的放行办法**（任选其一）：

```bash
xattr -dr com.apple.quarantine "Article Agent.app"
```

- 右键点 app →「打开」→ 弹窗里再点「打开」
- 「系统设置 → 隐私与安全性」→ 底下会出现"已阻止…"→ 点「仍要打开」

### 9.6 为什么不做"Windows 上交叉编译"

能凑出一个 `.app` 目录结构，但：
- **签不了名** —— 可以本地批准运行，但每次都要人工放行，且没法公证
- 做不了 dmg/pkg → 交到医生手里是压缩包，不是安装包
- 每次都要手工对齐 Electron 运行时版本

所以直接用 mac runner 最省事也最可靠。

### 9.7 怎么拿到 Apple 开发者证书

**先想清楚值不值**。三条路线：

| 路线 | 成本 | 医生的体验 |
|---|---|---|
| **A. 不签**（现状） | ￥0 | 拿到后要跑一次 `xattr` 命令，或在系统设置里批准一次 |
| **B. ad-hoc 签名** | ￥0 | **和 A 一样**仍要放行一次 —— ad-hoc 过不了 Gatekeeper/公证，只是保证包结构完整、能本地批准运行 |
| **C. Developer ID 签名 + 公证** | **$99/年** | **双击就能开**，没有任何警告 |

> 结论：**只是给几位合作医生用，走 A 就够了**（一条 `xattr` 命令，或右键→打开）。
> 只有要"发给不熟电脑的人、且不想教他们跑命令"时才值得花 $99。

#### 走 C 的完整步骤

**① 注册 Apple Developer Program**

- 用 Apple ID 到 <https://developer.apple.com/cn/programs/> 注册
- **个人（Individual）**：实名验证（身份证/护照），通常 **1–2 天**通过
- **组织（Organization）**：需要 **D-U-N-S（邓白氏）编码** 与法定实体名，
  Apple 会核验；没有 D-U-N-S 要先免费申请，整体可能 **1–2 周**
- 费用 **$99/年**（中国区结账页会显示人民币金额；以结账页为准）
- ⚠️ 个人账号签名后显示的是**个人姓名**，不是机构名 —— 要显示机构名必须用组织账号

**② 创建 Developer ID Application 证书**（这一步**必须在 Mac 上做**）

> 为什么必须在 Mac：「证书助理」生成 CSR、以及与私钥配对导出 `.p12`，
> 都依赖 macOS 的「钥匙串访问」。Windows 上用 OpenSSL 理论上能生成 CSR，
> 但 Apple 的流程与文档都是围绕钥匙串的，容易在"私钥没配对"上翻车。
> **借一台 Mac 做一次（约 30 分钟），之后证书可以长期在 CI 里复用。**

1. Mac 上打开「钥匙串访问」→ 菜单「证书助理」→「从证书颁发机构请求证书」
2. 填 Apple ID 邮箱；选「存储到磁盘」→ 得到 `CertificateSigningRequest.certSigningRequest`
3. 到 <https://developer.apple.com/account/resources/certificates> →
   新建 → 选 **Developer ID Application** → 上传刚才的 CSR
4. 下载 `.cer` → 双击导入钥匙串（此时证书与私钥已配对）
5. 在钥匙串里找到它 → 右键「导出」→ 存成 **`.p12`**，**设一个导出密码**

**③ 配进 CI**

```powershell
# 把 .p12 转成 base64（Windows 上也能做）
[Convert]::ToBase64String([IO.File]::ReadAllBytes("cert.p12")) | Set-Clipboard
```

GitHub 仓库 → Settings → Secrets and variables → Actions，加：

| Secret | 内容 |
|---|---|
| `MAC_CERT_P12` | 上面那串 base64 |
| `MAC_CERT_PASSWORD` | 导出 `.p12` 时设的密码 |
| `APPLE_ID` | Apple ID 邮箱（公证用） |
| `APPLE_APP_SPECIFIC_PASSWORD` | 在 <https://appleid.apple.com> →「登录与安全」生成的 App 专用密码 |
| `APPLE_TEAM_ID` | <https://developer.apple.com/account> → Membership 里的 Team ID（10 位） |

然后把 `electron-builder-mac.yml` 里 `mac.notarize` 那段注释打开、填上 teamId。
工作流会**自动判断**：配了 Secret 就用真证书 + 公证，没配就退化成 ad-hoc。

**④ 公证要多久**

Apple 的公证是自动化的，通常**几分钟**；偶尔排队到十几分钟。
electron-builder 会等结果并把公证凭据 staple 进 dmg。

#### 常见坑

- **证书导出时没带私钥** → CI 里报"no identity found"。在钥匙串里展开证书，
  确认下面挂着私钥再一起导出。
- **`.p12` 密码里有特殊字符** → 塞进 Secret 没问题，但本地测试时记得加引号。
- **公证一直失败** → 多半是 app 里有未签名的嵌套二进制（本仓库用 `asar: false`，
  `tools/` 下全是 `.mjs`，不需要单独签；但如果你日后加了原生模块要注意）。
- **账号一年不续费** → 证书失效，**已分发的 app 仍能打开**（公证凭据已 staple），
  但重新打包需要续费。

### 9.8 给 Mac 测试，到底发哪几个文件

CI 跑完后，Mac 那边需要**两样东西**（程序 + 数据），**都是必须的**：

| # | 文件 | 从哪来 | 体积 |
|---|---|---|---|
| 1 | `ArticleAgent-0.1.0-arm64-mac.dmg` | GitHub → Actions → 该次运行的 Artifacts | 约 130 MB |
| 2 | 工作区（`Datas/` `build/` `runtime/`） | 本机生成，见下 | 12 MB（只 2015）/ 608 MB（全部 11 年） |

**为什么数据必须单独发**：`Datas/` `build/` `runtime/` 都在 `.gitignore` 里，
CI 拿不到（见 9.3）。所以 CI 只能出程序。

#### 生成工作区压缩包

```powershell
# 冒烟测试：只带 2015（6 篇，12 MB）—— 第一次先发这个
node tools/desktop_installer.mjs --payload-only --skip-tsc --years 2015 `
  --out build/mac-workspace-2015
# ⚠️ 必须用 --out，否则会把 Windows 安装包在用的 build/desktop-payload 整个清掉

# 完整版：11 年 235 篇（608 MB）
node tools/desktop_installer.mjs --payload-only --skip-tsc --out build/mac-workspace-all

# 打包成一个文件（中文文件名没问题：zip 条目带 UTF-8 标志，macOS 能正确显示）
tar -a -c -f build/ArticleAgent-mac-工作区-2015.zip -C build/mac-workspace-2015 .
```

⚠️ **Windows 专有的文件要删掉**再发（`使用说明.txt`、`备份我的核对记录.bat`、
`打开数据文件夹.bat`）—— 在 Mac 上没用还让人困惑。
（脚本目前不区分平台，这一步要手工做；见"还没做"。）

#### Mac 那边的摆放

```
ArticleAgent/
├── Article Agent.app      ← 从 dmg 拖出来
├── Datas/
├── build/
└── runtime/               ← 三者与 .app **并排**
```

加一份 `使用说明-mac.txt`（内容与 Windows 版不同：讲清第一次怎么放行、
哪些功能没有、请帮忙确认哪几件事）。

#### 第一次测试先只发 2015 的理由

12 MB vs 608 MB，传起来快得多，而"能不能开、能不能定位证据、待裁定在不在"
这几件事用 6 篇就能验。**跑通再发完整版。**

### 9.9 还没做的

- **脚本不区分平台**：`desktop_installer.mjs` 生成的工作区一律带 Windows 的
  `.bat` 与 `使用说明.txt`。给 mac 用时得手工删（见 9.8）。
  要根治应加 `--platform mac`，让它改写 mac 版说明、不带 `.bat`。
- **CI 未实测**：`.github/workflows/build-macos.yml` 只是写好并过了 YAML 校验，
  **还没真跑过**。第一次跑多半会暴露小问题（比如 mac 上某些单测的平台差异）。

---

## 10. 网页版部署（**不打 dmg**，Mac 用浏览器就能用）

> 打 dmg 那条路上有打包、签名、公证三座山。而**这个工具的架构本来就是
> "一个零依赖的本地 HTTP 服务 + 静态前端"，Electron 只是个壳**。
> 把壳去掉，问题就少了一大半。

### 10.1 为什么网页版更省事

`apps/web/server.mjs` 只依赖 **node 内置模块 + 相对路径 import**
（可达性扫描见 §8.4：65 个文件、7 个 node 内置、3 个 `@aa/*`，无第三方依赖），
前端是静态 `dist`。于是：

| | Electron 安装包 / dmg | **网页版** |
|---|---|---|
| 要在 macOS 上打包吗 | 要（electron-builder 拒绝跨平台） | **不用**，Windows 上就能产出 |
| 要签名的吗 | 要（否则每次放行） | **不需要** —— Gatekeeper 完全不参与 |
| 要公证吗 | 正式分发要 | **不需要** |
| 体积 | 278.5 MB（含全部数据） | **4.8 MB**（含 2015 数据）/ 约 15 MB（含全部数据） |
| 目标机器要装什么 | 什么都不用 | **Node.js**（官网安装包，官方签名，双击装） |

**附带的好处**：网页版里 `process.execPath` 就是 `node` 本身，
所以顶栏「**抽取**」按钮**能直接用**（在「设置」里填自己的 API key）。
和 Electron 版一样，只有「解析」需要 MinerU 而用不了。

### 10.2 怎么生成

```powershell
# 先只带 2015（4.8 MB），发过去冒烟测试
node tools/desktop_web_bundle.mjs --years 2015 --skip-tsc --out build/web-test
node tools/desktop_web_bundle_verify.mjs --root build/web-test     # 23 项
tar -a -c -f build/ArticleAgent-网页版-2015.zip -C build/web-test .

# 全部年份（11 年 235 篇）
node tools/desktop_web_bundle.mjs --skip-tsc --out build/web-bundle
node tools/desktop_web_bundle.mjs --no-data --out build/web-codeonly   # 只出程序
```

产物布局**刻意和仓库一致**，因为 `server.mjs` 里 `APP_DIR`/`ROOT` 是写死的：

```
web-test/
├── apps/web/server.mjs + dist/    服务与界面
├── tools/  packages/             抽取流程代码
├── node_modules/@aa/             裸包名解析（0.9 MB 的廉价保险）
├── Datas/  build/  runtime/      工作区数据（与仓库同布局）
├── 启动.command                  Mac 双击启动
├── 启动.bat                      Windows 双击启动
└── 使用说明.txt                  给使用者看的（含 Mac 首次运行注意事项）
```

在包根执行 `node apps/web/server.mjs`，`ROOT` 就落在包根，不用配任何环境变量。

### 10.3 走这条路的三个坑（都踩过）

1. **不能把数据步骤指到已放好代码的目录**。`desktop_installer.mjs` 会**先清空**
   输出目录，于是刚拷好的代码被整个删掉 —— 实测报"代码 519 个文件"，
   但最终体积只有数据的 12.4 MB。现在数据先落 `build/_webbundle-data` 临时目录再合并。
   （和 §9.8 "给 Mac 生成工作区必须用 `--out`" 是同一类坑，方向相反。）
2. **`packages/` 只能带 `dist`，不能整个拷** —— `src/**/__tests__` 里有
   有意写的假密钥 `sk-test-…`，密钥扫描会如实拦下来（拦对了，是该改复制范围）。
3. **数"抽取结果 N 篇"要排除 `_run.json`**。抽取目录里每年还有一个运行报告，
   用 `endsWith('.json')` 会把它算成文章 → 11 年合计显示 235 篇（实际 224），
   并让"每篇都有 `*_middle.json`"的检查在单年 payload 上误报。

### 10.4 另一个更省事的路子：Mac 什么都不装

服务开在 Windows 上，Mac 用浏览器访问 —— **Mac 连 Node 都不用装**：

```powershell
$env:AA_HOST='0.0.0.0'; node apps/web/server.mjs
```

启动日志会直接打印同网段的访问地址，例如：

```
⚠️ 已对外监听（AA_HOST=0.0.0.0）：同网段的机器可以访问，且能读改本工作区
   对方浏览器打开：http://10.128.63.108:43130/
   本服务**没有鉴权**，用完请关掉；别在公共网络上这么开。
```

> ⚠️ **这个服务没有任何鉴权，而且能写文件**（核对记录、裁定、导入的 PDF）。
> 绑 `0.0.0.0` 等于把工作区敞开给同网段任何人。**只在可信局域网临时这么做。**
> 所以默认值必须是 `127.0.0.1`，而且真对外监听时要在日志里把话说明白。

### 10.5 三条路怎么选

| 场景 | 选哪条 |
|---|---|
| **只是想让人在 Mac 上快速试一下** | §10.4 —— Mac 什么都不装，最快 |
| **Mac 上要长期用、能离线** | §10.2 网页版包 + Mac 装 Node —— 4.8 MB，无签名问题 |
| **要发给不熟电脑的人、双击就用** | 只能走 dmg + 签名公证（§9.7，$99/年） |

### 10.6 还没做的

- 网页版的「启动.command」在 Windows 上打的 zip **可能丢可执行位**
  （zip 的外部属性由 Windows 的 tar 决定，没实测过）。
  所以 `使用说明.txt` 里同时给了"`chmod +x`"和"直接跑 `node`"两条路。
- 网页版**不做端口回退**：43130 被占就直接报错（Electron 版会自动往后找）。

