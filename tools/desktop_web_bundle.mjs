/**
 * **网页版部署包**：不要 Electron、不要 dmg、不要签名，Mac 上用浏览器就能用。
 *
 * 为什么这条路比打 dmg 省事得多：
 *   `apps/web/server.mjs` 本身是个**零第三方依赖**的 node http 服务
 *   （只用 node 内置模块 + 相对路径 import，见 docs/24 §8.4 的可达性扫描），
 *   前端是静态 dist。Electron 只是个"把它跑起来 + 开个窗口"的壳。
 *   于是：
 *     · 不需要 macOS 系统来打包（Windows 上就能产出）
 *     · 不需要 codesign / 公证（Gatekeeper 完全不参与）
 *     · 包体从 400 MB 降到个位数 MB（不含数据）
 *   代价：目标机器要有 **Node.js**（官网安装包，Apple/微软都签过名，双击装即可）。
 *
 * 附带的好处：网页版里 `process.execPath` 就是 `node` 本身，
 * 所以顶栏「抽取」按钮**能直接用**（填个 API key 即可）——
 * 和 Electron 版一样，只有「解析」需要 MinerU 而用不了。
 *
 * 用法：
 *   node tools/desktop_web_bundle.mjs                       # 全部年份
 *   node tools/desktop_web_bundle.mjs --years 2015          # 只带 2015（冒烟测试）
 *   node tools/desktop_web_bundle.mjs --no-data             # 只出程序，数据自己放
 *   node tools/desktop_web_bundle.mjs --out build/web-test
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync, readdirSync, statSync, mkdirSync, rmSync, copyFileSync, writeFileSync,
} from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSecretLeaks } from './lib/secret_scan.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const arg = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);

const OUT = resolve(ROOT, arg('out', join('build', 'web-bundle')));
const YEARS = arg('years', 'all');
const WITH_DATA = !has('no-data');
/*
 * 数据先落到**临时目录**再合并进 OUT。
 *
 * ⚠️ 不能直接 `desktop_installer.mjs --out OUT` —— 那个脚本会**先清空输出目录**
 * （`rmSync(PAYLOAD, recursive)`），于是刚拷好的代码会被整个删掉。
 * 实测踩到：报"代码 519 个文件"，但最终体积只有数据的 12.4 MB，代码没了。
 * 这和 docs/24 §9.8 里"给 Mac 生成工作区必须用 --out"是同一类坑，只是方向相反。
 */
const DATA_STAGE = resolve(ROOT, join('build', '_webbundle-data'));

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const rel = (p) => relative(ROOT, p);

/* ------------------------------ 1. 拷代码 ------------------------------ */

/*
 * 布局**刻意和仓库一致**（apps/web、tools、packages、node_modules、Datas、build、runtime）。
 * 因为 server.mjs 里那几处路径是写死的：
 *   APP_DIR = server.mjs 的上两级     → DIST = <包根>/apps/web/dist
 *   ROOT    = AA_ROOT ?? cwd          → 数据目录
 * 布局一致 + 在包根执行，就完全不用改一行服务端代码。
 */
console.log(`\n══ 生成网页版部署包 ══\n${rel(OUT)}\n`);
if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });

const copyDir = (src, destRel, filter = () => true) => {
  let n = 0;
  const walk = (s, d) => {
    if (!existsSync(s)) return;
    mkdirSync(d, { recursive: true });
    for (const e of readdirSync(s, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const sp = join(s, e.name); const dp = join(d, e.name);
      if (e.isDirectory()) { walk(sp, dp); continue; }
      if (!filter(e.name)) continue;
      copyFileSync(sp, dp); n++;
    }
  };
  walk(src, join(OUT, destRel));
  return n;
};

let nCode = 0;
nCode += copyDir(join(ROOT, 'apps', 'web', 'dist'), join('apps', 'web', 'dist'));
copyFileSync(join(ROOT, 'apps', 'web', 'server.mjs'), (() => {
  const p = join(OUT, 'apps', 'web', 'server.mjs');
  mkdirSync(dirname(p), { recursive: true });
  return p;
})());
nCode++;
// 只要 .mjs：tools 下还有一堆非运行时文件，全带上会平白胖一圈
// 测试文件排除（里面有意写的假密钥，见 docs/24 §6.2）
nCode += copyDir(join(ROOT, 'tools'), 'tools',
  (f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'));
/*
 * ⚠️ 只带 `packages/<pkg>/dist`，**不能整个 packages/** ——
 *    src 里带着 `__tests__/deepseek.test.ts`（有意写的假密钥 sk-test-…），
 *    打包时的密钥扫描会如实拦下来（实测踩到）。运行时也只需要 dist。
 */
for (const pkg of readdirSync(join(ROOT, 'packages'))) {
  const dist = join(ROOT, 'packages', pkg, 'dist');
  if (existsSync(dist)) nCode += copyDir(dist, join('packages', pkg, 'dist'));
}
/*
 * @aa/* 的裸包名解析：各包的 dist 之间用 `import ... from '@aa/core'` 互相引用。
 * 只有 0.9 MB，是"运行时缺依赖"这类事故的廉价保险（docs/24 §8.4）。
 */
const staged = join(ROOT, 'build', 'desktop-stage', 'node_modules');
if (existsSync(staged)) nCode += copyDir(staged, 'node_modules');
else console.warn('  ⚠ 没有 build/desktop-stage/node_modules —— 先跑 node tools/desktop_stage_modules.mjs');

/* ------------------------------ 2. 拷数据 ------------------------------ */

let nData = 0;
if (WITH_DATA) {
  /*
   * 复用既有的工作区裁剪逻辑（只带服务端真正读的文件）。
   * 落到临时目录，再把 Datas/build/runtime 搬进 OUT —— 顺序不能反（见上面注释）。
   */
  rmSync(DATA_STAGE, { recursive: true, force: true });
  const r = spawnSync(process.execPath, [
    join(ROOT, 'tools', 'desktop_installer.mjs'),
    '--payload-only', '--skip-tsc', '--years', YEARS, '--out', DATA_STAGE,
  ], { stdio: 'inherit', cwd: ROOT });
  if (r.status !== 0) { console.error('✗ 工作区裁剪失败'); process.exit(r.status ?? 1); }

  for (const d of ['Datas', 'build', 'runtime']) {
    const src = join(DATA_STAGE, d);
    if (existsSync(src)) copyDir(src, d);
  }
  const firstYear = String(YEARS).split(',')[0];
  const count = (d) => (existsSync(d) ? readdirSync(d).length : 0);
  nData = count(join(OUT, 'Datas', 'articles', firstYear)) + count(join(OUT, 'build', 'extraction', firstYear));
  rmSync(DATA_STAGE, { recursive: true, force: true });
}

/* ------------------------------ 3. 启动脚本 + 说明 ------------------------------ */

const startSh = `#!/bin/bash
# Article Agent 网页版 · macOS / Linux 启动脚本
# 双击运行（macOS 上若提示"无法打开"，先在本文件所在目录执行一次：chmod +x 启动.command）
cd "$(dirname "$0")" || exit 1

PORT="\${AA_PORT:-43130}"

if ! command -v node >/dev/null 2>&1; then
  osascript -e 'display alert "需要先安装 Node.js" message "请到 https://nodejs.org/ 下载 macOS 安装包（选 LTS 版），双击装好后重新运行本文件。"' 2>/dev/null \\
    || echo "未找到 Node.js。请先到 https://nodejs.org/ 安装（选 LTS）。"
  exit 1
fi

echo "Article Agent 正在启动…"
echo "  浏览器会自动打开 http://127.0.0.1:$PORT"
echo "  关掉这个终端窗口即停止服务。"
echo

AA_PORT="$PORT" node apps/web/server.mjs &
PID=$!
sleep 2
(open "http://127.0.0.1:$PORT" 2>/dev/null || xdg-open "http://127.0.0.1:$PORT" 2>/dev/null || true)
wait $PID
`;

const startBat = `@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   需要先安装 Node.js：https://nodejs.org/  ^(下载 LTS 版，双击安装^)
  echo.
  pause
  exit /b 1
)
echo Article Agent 正在启动...
echo   浏览器会自动打开 http://127.0.0.1:43130
echo   关掉这个窗口即停止服务。
start "" http://127.0.0.1:43130
node apps\\web\\server.mjs
pause
`;

writeFileSync(join(OUT, '启动.command'), startSh.replace(/\n/g, '\n'), 'utf8');
writeFileSync(join(OUT, '启动.bat'), startBat.replace(/\n/g, '\r\n'), 'utf8');

const yearsLabel = YEARS === 'all' ? '全部年份' : YEARS;
const readme = `Article Agent · 网页版（Mac / Windows 通用）
==========================================

这个版本**不用安装、不用签名**：装一个 Node.js，双击启动脚本，
浏览器里就能用完整界面。


一、Mac 上怎么用
----------------
1. 装 Node.js

   打开 https://nodejs.org/ ，下载 **LTS 版**的 macOS 安装包，
   双击一路「继续」装完即可（官方安装包有 Apple 签名，不会有安全提示）。

   验证：打开「终端」，输入  node -v  回车，能打印出版本号就行。

2. 把整个文件夹放到你喜欢的位置（比如「文稿」里）。

3. 双击本文件夹里的 **启动.command**

   · 如果提示"无法打开，因为它来自身份不明的开发者"：
     在「终端」里 cd 到本文件夹，执行一次
         chmod +x 启动.command
     之后就能双击了。
   · 或者干脆在「终端」里执行：
         cd 本文件夹路径
         node apps/web/server.mjs
     然后浏览器打开 http://127.0.0.1:43130

4. 浏览器会自动打开界面。**关掉终端窗口就停止服务**。


二、Windows 上怎么用
--------------------
同样装 Node.js，然后双击 **启动.bat**。


三、里面有什么
--------------
  ${yearsLabel} 的机器抽取结果 + 原文 PDF + 金标准（${WITH_DATA ? '已内置' : '⚠️ 未内置，需自己放'}）

  布局（和仓库一致，不要改动层级）：
    apps/web/server.mjs     本地服务
    apps/web/dist/          界面
    tools/  packages/       抽取流程代码
    Datas/articles/         原文 PDF
    build/extraction/       机器抽取结果
    build/annotations/      你的核对记录      ← 最重要，注意备份
    build/adjudications/    结局行裁定
    runtime/                （空目录，程序要求存在）


四、能做什么、不能做什么
------------------------
  ✅ 看 PDF、点字段定位证据、框选证据、编辑/确认/回滚
  ✅ Sheet3「待人工裁定」保留 / 丢弃
  ✅ 多人各自核对（右上角「核对人」填名字）
  ✅ 导出 XLSX / CSV、导回、两组结果对比
  ✅ 顶栏「抽取」—— 网页版里它就是调用本机的 node，
     只要在「设置」里填自己的 API key 就能重新抽取
  ❌ 顶栏「解析」—— 需要 MinerU 的 Python 环境（数 GB），没打进包。
     包里的 PDF 已经在开发机上解析好了。

  ⚠️ 服务只监听 127.0.0.1，**同一局域网的其他电脑访问不了**（单机用）。


五、出问题了看哪里
------------------
  · 界面打不开：确认终端窗口里没有报错；端口 43130 是否被别的程序占用。
  · 想换端口：启动前设环境变量，例如
        AA_PORT=43140 node apps/web/server.mjs
  · 数据不对：确认是在**本文件夹根目录**里启动的（服务按当前目录找 Datas/build/runtime）。


生成时间：${new Date().toISOString().slice(0, 19).replace('T', ' ')}
包含年份：${yearsLabel}
`;
writeFileSync(join(OUT, '使用说明.txt'), `\uFEFF${readme}`, 'utf8');

/* ------------------------------ 4. 校验 ------------------------------ */

const leaks = findSecretLeaks(OUT);
if (leaks.length) {
  console.error('\n✗ 包里发现疑似密钥：');
  for (const l of leaks) console.error(`    ${l.rel}  —— ${l.why}`);
  process.exit(1);
}

const size = (() => {
  let n = 0;
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile()) n += statSync(p).size; } };
  walk(OUT); return n;
})();

console.log(`\n══ 完成 ══\n`);
console.log(`  代码 ${nCode} 个文件（无 Electron、无签名）`);
if (WITH_DATA) console.log(`  数据：${yearsLabel}`);
console.log(`  合计 ${mb(size)}   位置 ${rel(OUT)}`);
console.log(`\n  发出去只需要这一个文件夹（压缩后更小）。`);
console.log(`  自检：node tools/desktop_web_bundle_verify.mjs --root ${rel(OUT)}\n`);
