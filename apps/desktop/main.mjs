/**
 * @aa/desktop —— Electron 主进程（把 Web 界面打包成 exe）
 *
 * 架构：**壳 + 工作区**。
 *
 *   壳（本 exe 内）  Electron 运行时 + 前端 dist + 本地 HTTP 服务 + tools/packages 代码
 *   工作区（仓库目录）`Datas/`（只读语料）、`build/`（解析产物、抽取结果、人工覆盖层）、
 *                    `runtime/`（MinerU 的 python 环境与 API 密钥）
 *
 * 为什么不把工作区也塞进 exe：MinerU 的 python 环境有数 GB 模型、语料是只读数据、
 * 抽取产物需要人去看——这些本来就应该在磁盘上、可被别的工具（CLI、评测脚本）共用。
 * 因此 exe 只负责"把界面跑起来"，工作区路径可配置。
 *
 * 工作区解析顺序（第一个可用的胜出）：
 *   1. 环境变量 `AA_ROOT`
 *   2. 用户配置 `%APPDATA%/article-agent/workspace.json`（上次选过的）
 *   3. exe 所在目录 / 其上一级（把 exe 丢进仓库根目录即可直接用）
 *   4. 让用户选目录（原生对话框），并把选择记下来
 *
 * 服务在**本进程内** import 起来（`server.mjs` 只依赖 node 内置模块），
 * 端口冲突时自动向后找空闲端口。
 */

import { app, BrowserWindow, dialog, Menu, shell } from 'electron';
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 应用根目录：**以"哪里真的有 server.mjs"为准**，不要靠数 `..` 的层数。
 *
 * 两种布局的深度不同：
 *   开发：`<仓库>/apps/desktop/main.mjs`            → 根目录 = 上两级
 *   打包：`resources/app/main.mjs`                  → 根目录 = 上一级
 * 一开始按"上两级"硬写，开发下正常、打包后指向了解压根目录，
 * 报 `ERR_MODULE_NOT_FOUND: .../apps/web/server.mjs`（实测踩到，靠 desktop.log 定位）。
 */
const APP_ROOT = [
  resolve(HERE, '..', '..'),   // 开发：<repo>/apps/desktop → <repo>
  resolve(HERE, '..'),         // 打包：resources/app → resources
  HERE,
].find((d) => existsSync(join(d, 'apps', 'web', 'server.mjs'))) ?? resolve(HERE, '..', '..');
const SERVER = join(APP_ROOT, 'apps', 'web', 'server.mjs');

/*
 * 应用名固定下来：它决定 `app.getPath('userData')` 的目录名
 * （%APPDATA%/article-agent）。不设的话会跟着 package.json 的 scoped 名字走
 * （`@aa/desktop`），日志与"上次选过的工作区"会落到一个不好找的路径下。
 */
app.setName('article-agent');

/* ------------------------------ 日志 ------------------------------ */

/**
 * 写文件日志。
 *
 * 为什么必须有：Windows 上 Electron 主进程挂在 GUI 子系统，`console.log` 不会出现在
 * 任何终端里——启动失败时用户（和我）只能看到一个报错对话框、拿不到堆栈。
 * 日志落在 `%APPDATA%/article-agent/desktop.log`，出问题时直接看这个文件。
 */
const LOG_FILE = () => join(app.getPath('userData'), 'desktop.log');
function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`;
  try {
    mkdirSync(dirname(LOG_FILE()), { recursive: true });
    appendFileSync(LOG_FILE(), line, 'utf8');
  } catch { /* 日志失败不能影响启动 */ }
}

process.on('uncaughtException', (e) => {
  log('UNCAUGHT', e?.stack ?? String(e));
});
process.on('unhandledRejection', (e) => {
  log('UNHANDLED_REJECTION', e?.stack ?? String(e));
});

/* ------------------------------ 工作区解析 ------------------------------ */

const CFG_FILE = () => join(app.getPath('userData'), 'workspace.json');

/** 一个目录算不算"可用工作区"：至少要有语料或产物目录之一 + 运行环境。 */
function isWorkspace(dir) {
  if (!dir || !existsSync(dir)) return false;
  const has = (p) => existsSync(join(dir, p));
  return (has('Datas') || has('build')) && has('runtime');
}

function readSavedWorkspace() {
  try {
    const f = CFG_FILE();
    if (!existsSync(f)) return null;
    const j = JSON.parse(readFileSync(f, 'utf8'));
    return typeof j.workspace === 'string' ? j.workspace : null;
  } catch {
    return null;
  }
}

function saveWorkspace(dir) {
  try {
    mkdirSync(dirname(CFG_FILE()), { recursive: true });
    writeFileSync(CFG_FILE(), JSON.stringify({ workspace: dir, savedAt: new Date().toISOString() }, null, 2), 'utf8');
  } catch { /* 记不住不影响本次使用 */ }
}

function resolveWorkspace() {
  const exeDir = dirname(app.getPath('exe'));
  /*
   * ⚠️ macOS 的目录布局和 Windows 完全不同，不能只按"exe 旁边"找：
   *
   *   Windows 安装版   <X>\Article Agent.exe
   *                   → 数据放 <X>\
   *   macOS           <X>/Article Agent.app/Contents/MacOS/Article Agent
   *                   → `dirname(exe)` 是 **.app 内部**。数据放那儿不符合 mac 习惯
   *                     （app 包应当可整体替换），也不便于备份。
   *
   * 所以 mac 上要多试**往上三级**——.app 所在的那一层，以及它下面的 `workspace/`。
   * mac 的分发形态就是「.app 与数据文件夹并排放同一个目录」。
   */
  const candidates = [
    process.env.AA_ROOT,
    readSavedWorkspace(),
    // 便携版会把"exe 实际所在目录"放在这个环境变量里（自解压到临时目录后，
    // app.getPath('exe') 指向临时目录，用户真正的 exe 位置得看这个）
    process.env.PORTABLE_EXECUTABLE_DIR,
    exeDir,                                          // Windows 安装版：数据就在 exe 旁
    resolve(exeDir, '..'),
    resolve(exeDir, '..', '..', '..'),               // macOS：.app 所在的那一层
    resolve(exeDir, '..', '..', '..', 'workspace'),  // macOS：.app 旁的 workspace/
    process.cwd(),
  ].filter(Boolean);

  // 去重：开发布局下 `..` 与 `../..` 会互相撞上，重复探测只会刷日志
  for (const c of [...new Set(candidates.map((x) => resolve(x)))]) {
    const ok = isWorkspace(c);
    log('候选工作区', c, ok ? '✓' : '✗');
    if (ok) return c;
  }
  return null;
}

async function askWorkspace() {
  const r = await dialog.showOpenDialog({
    title: '选择工作区目录（含 Datas / build / runtime 的项目目录）',
    properties: ['openDirectory'],
    buttonLabel: '使用此目录',
  });
  const dir = r.filePaths?.[0];
  if (!dir) return null;
  if (!isWorkspace(dir)) {
    const again = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['仍然使用', '重新选择'],
      defaultId: 0,
      message: '该目录看起来不是工作区',
      detail: `期望至少有 Datas/ 或 build/ 之一，并且有 runtime/（MinerU 环境与 API 配置）：\n${dir}`,
    });
    if (again.response === 1) return askWorkspace();
  }
  saveWorkspace(dir);
  return dir;
}

/* ------------------------------ 端口与 HTTP 服务 ------------------------------ */

/** 找一个空闲端口（默认 43130，被占则向后试）。 */
function freePort(start = 43130, tries = 20) {
  return new Promise((resolvePromise, reject) => {
    let port = start;
    const tryOne = () => {
      const s = createServer();
      s.once('error', (e) => {
        s.close();
        if (e.code === 'EADDRINUSE' && port < start + tries) { port++; tryOne(); }
        else reject(e);
      });
      s.once('listening', () => s.close(() => resolvePromise(port)));
      s.listen(port, '127.0.0.1');
    };
    tryOne();
  });
}

/**
 * 启动本地服务。
 *
 * ⚠️ `server.mjs` 在模块顶层读 `process.env.AA_ROOT`，所以**必须先设环境变量再 import**；
 * 端口同理（`AA_PORT`）。这也是它能在 exe 里原样复用的原因——没有改一行 web 代码。
 */
async function startServer(workspace, port) {
  process.env.AA_ROOT = workspace;
  process.env.AA_PORT = String(port);
  log('import server', SERVER);
  const mod = await import(`file://${SERVER.replace(/\\/g, '/')}`);
  void mod;
  log('server imported, listening on', port);
  return port;
}

/* ------------------------------ 窗口 ------------------------------ */

function createWindow(port) {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 700,
    backgroundColor: '#edf0f4',
    title: 'Article Agent',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // 只用本地渲染 + 本地服务；外部链接交给系统浏览器打开
      sandbox: true,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  void win.loadURL(`http://127.0.0.1:${port}/`);
  return win;
}

/** 极简菜单：只留"重载 / 开发者工具 / 打开工作区 / 关于"。 */
function buildMenu(workspace, win) {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: '文件',
      submenu: [
        { label: '重新加载', accelerator: 'CmdOrCtrl+R', click: () => win.webContents.reload() },
        {
          label: '打开工作区目录',
          click: () => { void shell.openPath(workspace); },
        },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'toggleDevTools', label: '开发者工具' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于',
          click: () => {
            void dialog.showMessageBox({
              type: 'info',
              title: '关于 Article Agent',
              message: `Article Agent ${app.getVersion()}`,
              detail:
                `工作区：${workspace}\n` +
                `服务：http://127.0.0.1:${process.env.AA_PORT}\n` +
                `Electron：${process.versions.electron} / Chromium ${process.versions.chrome}`,
            });
          },
        },
      ],
    },
  ]));
}

/* ------------------------------ 启动流程 ------------------------------ */

app.whenReady().then(async () => {
  log('=== 启动 ===', 'version', app.getVersion(), 'exe', app.getPath('exe'));
  log('AA_ROOT =', process.env.AA_ROOT ?? '(未设置)');

  let workspace = resolveWorkspace();
  log('resolveWorkspace →', workspace ?? '(未找到，需用户选择)');
  if (!workspace) {
    workspace = await askWorkspace();
    if (!workspace) { log('用户取消选择工作区，退出'); app.quit(); return; }
    log('用户选择工作区', workspace);
  }

  let port;
  try {
    port = await freePort();
    log('空闲端口', port);
    await startServer(workspace, port);
  } catch (e) {
    log('启动失败', e?.stack ?? String(e));
    await dialog.showMessageBox({
      type: 'error',
      title: '启动失败',
      message: '本地服务启动失败',
      detail: `${e?.message ?? e}\n\n工作区：${workspace}\n服务文件：${SERVER}\n日志：${LOG_FILE()}`,
    });
    app.quit();
    return;
  }

  const win = createWindow(port);
  buildMenu(workspace, win);
  win.webContents.on('did-fail-load', (_e, code, desc, url) => log('did-fail-load', code, desc, url));
  win.webContents.on('render-process-gone', (_e, d) => log('render-process-gone', JSON.stringify(d)));
  log('窗口已创建，加载', `http://127.0.0.1:${port}/`);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(port);
  });
});

app.on('window-all-closed', () => {
  // 单窗口工具：关窗即退出（macOS 也保持一致，避免留下后台服务）
  app.quit();
});
