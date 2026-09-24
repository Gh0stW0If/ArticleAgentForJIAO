# 桌面端：Electron 打包成单个 exe

> 目标：把已经做好的 Web 界面（PDF 查看 + 框选证据 + 三张 Sheet 选项卡）打包成一个
> **免安装的单文件 exe**，双击即用，不需要先起服务、也不要求用户装 Node。

## 1. 一句话架构：壳 + 工作区

```
exe（壳，自解压到 %TEMP%/article-agent）
├─ Electron 运行时
├─ apps/web/server.mjs      ← 本地 HTTP 服务（在 Electron 主进程内 import 起来）
├─ apps/web/dist/           ← 前端产物
├─ tools/*.mjs              ← 流水线代码（解析/抽取/表头布局）
└─ packages/*/dist/         ← 流水线依赖的包

工作区（用户磁盘上的项目目录，可配置）
├─ Datas/    只读语料（PDF）
├─ build/    MinerU 产物、抽取结果、人工覆盖层、导入件
└─ runtime/  MinerU 的 python 环境 + llm.local.json（API 密钥）
```

**为什么不把工作区也塞进 exe**：

- 语料是只读数据、产物要能被人和 CLI 工具共用（`pnpm llm:run`、评测脚本都读 `build/`）；
- MinerU 的模型有几 GB，塞进 exe 会让它膨胀到不可接受；
- 抽取产物会持续增长，放在 exe 的临时自解压目录里会在退出后丢失。

因此 exe 只负责"把界面跑起来"，工作区路径可配置。

### 1.1 一个容易写错的地方：代码随壳、数据随工作区

实现里有两个根目录，**不能混用**：

| 常量 | 含义 | 谁用它 |
|---|---|---|
| `APP_DIR` | 壳自己的目录（开发时=仓库根，打包后=`resources/app`） | 服务代码、`tools/`、`packages/*/dist`、**前端 dist** |
| `ROOT`（= `AA_ROOT`） | 工作区 | `Datas/`、`build/`、`runtime/`、导入件 |

实测踩到的两个坑（都靠 `desktop.log` 定位）：

1. `main.mjs` 里用 `resolve(HERE, '..', '..')` 找 `server.mjs`——开发下对（`apps/desktop` 上两级），
   打包后错（`resources/app` 只需要上一级），于是 `ERR_MODULE_NOT_FOUND`。
   现在改成"**哪个候选目录里真的有 `apps/web/server.mjs` 就用哪个**"，不数层数。
2. `server.mjs` 里静态目录写成 `join(ROOT, 'apps', 'web', 'dist')`——只因为测试时
   工作区恰好是仓库根才看起来正常；换成任意工作区页面就 404。现在用 `join(APP_DIR, ...)`。

## 2. 打包与运行

```bash
pnpm icon            # 生成 build/icon.png（自写 SDF 光栅化 + PNG 编码，无需额外依赖）
pnpm desktop:build   # → build/desktop/ArticleAgent-0.1.0-portable.exe（约 97 MB）
pnpm desktop:dev     # 开发时直接跑 Electron（不必打包）
```

> 打包需要 Electron 运行时。若 `node_modules/electron/dist` 已存在，配置里的
> `electronDist` 会直接复用、跳过下载（26.x 在本环境下载会抛
> `Cannot read properties of undefined (reading 'ReadWrite')`，根因是它依赖的
> `@electron/get@3` 缺 `ElectronDownloadCacheMode`；已在 `pnpm-workspace.yaml`
> 用 `overrides` 钉到 `^5.1.0` 修掉）。

### 2.1 工作区怎么找（按顺序）

1. 环境变量 `AA_ROOT`
2. `%APPDATA%/article-agent/workspace.json`（上次选过的）
3. `PORTABLE_EXECUTABLE_DIR`（便携版提供：**用户 exe 所在的真实目录**）
4. exe 所在目录 / 其上一级
5. 都没有 → 弹原生目录选择框，并把选择记下来

判定"是不是工作区"：至少有 `Datas/` 或 `build/` 之一，**并且**有 `runtime/`。

### 2.2 排障日志

`%APPDATA%/article-agent/desktop.log`。Windows 上 Electron 主进程挂在 GUI 子系统，
`console.log` 不会出现在任何终端里——启动失败时只有这个文件能给出堆栈。日志覆盖：
启动、工作区候选与最终选择、空闲端口、服务 import、窗口创建、`did-fail-load`、
`render-process-gone`、以及未捕获异常。

### 2.3 与命令行流水线的关系

桌面端里的「解析」「抽取」按钮就是**以子进程方式调用现成脚本**：

- 解析 → `runtime/mineru/Scripts/mineru.exe -p <单篇> -o build/mineru/<year> -b pipeline -m txt`
- 抽取 → `node tools/llm_run.mjs --year Y --only <id>`

⚠️ 桌面端里 `process.execPath` 是 Electron 主程序，必须带 `ELECTRON_RUN_AS_NODE=1`
才会以 node 模式跑脚本（对普通 node 无副作用）。参数以数组传给 `spawn`，不经 shell。

## 3. 打包配置要点（`apps/desktop/electron-builder.yml`）

| 配置 | 为什么 |
|---|---|
| `asar: false` | 子进程读不了 asar 虚拟文件系统；解包成普通目录最省事 |
| `electronVersion: 44.3.0` | 必须精确版本，`^44.3.0` 这种范围它无法解析 |
| `electronDist: ../../node_modules/electron/dist` | 复用已下载的运行时，绕开下载路径的 bug |
| `files` 里的单文件 | **必须用 `from: 目录 + filter`**：`from: ../web/server.mjs` + `to: apps/web/server.mjs` 会被当成目录处理，文件根本不会被打进去（实测打出来的 exe 一启动就找不到服务） |
| `target: portable` | 单个 exe、不写注册表、不建开始菜单 |

## 4. 实测验证记录

打包后的 exe（97.2 MB）在**非仓库工作区**上跑通（工作区只有 `Datas/build/runtime` 三个接头目录）：

```
✓ /api/health      → 200，root 指向该工作区
✓ /                → 200（页面来自 exe 内的 dist）
✓ /assets/index-*.js → 200，541 KB
✓ /api/fields      → 200（数据来自工作区 build/extraction）
✓ /api/pdf         → 200，372 KB（语料来自工作区 Datas）
```

即：**壳与数据确实分开了**——把 exe 拷到任何机器，只要指定工作区就能用。
