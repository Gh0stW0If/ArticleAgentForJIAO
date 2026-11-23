/**
 * **网页版部署包验收**：拿包内自己的 `apps/web/server.mjs` 真跑起来点一遍。
 *
 * 为什么不能用 `desktop_installer_verify.mjs`：那个跑的是**仓库里**的 server，
 * 只验证了数据布局；而这里要验的是"这个文件夹拷到 Mac 上、只装了 Node，
 * 能不能自己跑起来"。所以要跑**包内**的 server，并且 cwd 设在包根。
 *
 * 用法：
 *   node tools/desktop_web_bundle_verify.mjs [--root build/web-bundle]
 */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSecretLeaks } from './lib/secret_scan.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const BUNDLE = resolve(ROOT, arg('root', join('build', 'web-bundle')));
const PORT = 43231;

let pass = 0; let fail = 0;
const ok = (m) => { pass++; console.log(`  ✓ ${m}`); };
const bad = (m) => { fail++; console.log(`  ✗ ${m}`); };
const check = (c, good, badMsg) => (c ? ok(good) : bad(badMsg ?? good));
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

console.log(`\n══ 验收网页版部署包 ══\n${BUNDLE}\n`);
if (!existsSync(BUNDLE)) { console.error('✗ 没有这个目录。先跑 node tools/desktop_web_bundle.mjs'); process.exit(2); }

/* ------------------------------ 1. 结构 ------------------------------ */

console.log('§1 结构（必须是"拷过去就能跑"的布局）');

const SERVER = join(BUNDLE, 'apps', 'web', 'server.mjs');
const DIST = join(BUNDLE, 'apps', 'web', 'dist', 'index.html');
check(existsSync(SERVER), 'apps/web/server.mjs 在（服务本体）', '✗ 缺 server.mjs');
check(existsSync(DIST), 'apps/web/dist/index.html 在（界面）', '✗ 缺前端 dist —— 界面会是空白');
check(existsSync(join(BUNDLE, 'tools')), 'tools/ 在（导出/导回/取整等逻辑）', '✗ 缺 tools/');
check(existsSync(join(BUNDLE, 'packages', 'core', 'dist')),
  'packages/*/dist 在', '✗ 缺 packages dist —— 服务 import 会直接失败');
check(existsSync(join(BUNDLE, 'node_modules', '@aa')),
  'node_modules/@aa 在（裸包名解析）', '⚠️ 缺 node_modules/@aa，某些 import 会 ERR_MODULE_NOT_FOUND');
check(existsSync(join(BUNDLE, '启动.command')), '启动.command 在（Mac 双击）');
check(existsSync(join(BUNDLE, '启动.bat')), '启动.bat 在（Windows 双击）');
check(existsSync(join(BUNDLE, '使用说明.txt')), '使用说明.txt 在');

// 不该出现的东西：Electron 壳和 Windows 专用脚本
check(!existsSync(join(BUNDLE, 'main.mjs')),
  '不含 Electron 主进程（说明确实是纯网页版）',
  '⚠️ 目录里有 main.mjs —— 是不是拷错了？');
for (const f of ['备份我的核对记录.bat', '打开数据文件夹.bat']) {
  check(!existsSync(join(BUNDLE, f)), `不含 Windows 专用 ${f}`, `⚠️ 混进了 Windows 专用文件：${f}`);
}

const leaks = findSecretLeaks(BUNDLE);
check(leaks.length === 0, '未夹带 API 密钥',
  `⚠️ 发现疑似密钥：${leaks.map((l) => l.rel).join('、')}`);

let years = [];
const ex = join(BUNDLE, 'build', 'extraction');
if (existsSync(ex)) years = readdirSync(ex).filter((d) => /^\d{4}$/.test(d)).sort();
if (years.length) {
  let nExtr = 0; let nMid = 0;
  /*
   * ⚠️ 只数**文章**产物：抽取目录里还有每年一个 `_run.json`（运行报告）。
   *    用 `f.endsWith('.json')` 会把它算成第 7 篇，于是误报"1 篇缺 *_middle.json"
   *    （实测踩到）。判据与 tools/llm_run.mjs 的产物命名一致。
   */
  const isArticle = (f) => /^\d{4}-\d{1,2}\.json$/.test(f);
  for (const y of years) {
    nExtr += readdirSync(join(ex, y)).filter(isArticle).length;
    const mb2 = join(BUNDLE, 'build', 'mineru', y);
    if (!existsSync(mb2)) continue;
    for (const stem of readdirSync(mb2)) {
      const sd = join(mb2, stem);
      if (!statSync(sd).isDirectory()) continue;
      for (const sub of readdirSync(sd)) {
        const s2 = join(sd, sub);
        if (statSync(s2).isDirectory() && readdirSync(s2).some((f) => f.endsWith('_middle.json'))) nMid++;
      }
    }
  }
  ok(`数据：${years.length} 个年份 / 抽取结果 ${nExtr} 篇 / MinerU 中间件 ${nMid} 篇`);
  check(nMid >= nExtr, `每篇都有 *_middle.json（${nMid} ≥ ${nExtr}）`,
    `有 ${nExtr - nMid} 篇缺 *_middle.json —— 那些篇「定位证据」会失效`);
} else {
  ok('（--no-data：包里没有数据，属预期）');
}
for (const d of ['build/annotations', 'build/adjudications', 'runtime']) {
  check(existsSync(join(BUNDLE, d)), `可写落点 ${d}/ 在`, `✗ 缺 ${d}/`);
}

/* ------------------------------ 2. 真跑包内的服务 ------------------------------ */

console.log('\n§2 用**包内**的 server.mjs 真跑一遍（cwd 设在包根，模拟 Mac 上双击启动）');

const srv = spawn(process.execPath, ['apps/web/server.mjs'], {
  cwd: BUNDLE,
  env: { ...process.env, AA_ROOT: BUNDLE, AA_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
srv.stdout.on('data', (d) => { log += d; });
srv.stderr.on('data', (d) => { log += d; });

const base = `http://127.0.0.1:${PORT}`;
const up = async () => {
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) return true; } catch { /* 未起 */ }
    await new Promise((s) => setTimeout(s, 250));
  }
  return false;
};

try {
  if (!(await up())) { bad(`包内服务起不来\n${log.slice(-800)}`); throw new Error('no server'); }
  ok(`包内服务已启动（cwd=包根，:${PORT}）`);

  // 前端首页（证明 dist 带对了、静态托管路径对）
  const home = await fetch(`${base}/`);
  const html = await home.text();
  check(home.ok && /<div id="root"|<script/i.test(html),
    `首页可访问（${html.length} 字节 HTML）`, '首页打不开或不像前端页面 —— dist 路径不对');

  if (years.length) {
    const y0 = years.at(-1);
    const studies = await (await fetch(`${base}/api/studies?year=${y0}`)).json();
    const list = studies.studies ?? [];
    check(list.length > 0, `${y0} 年列出 ${list.length} 篇研究`, `${y0} 年一篇都没列出来`);
    const study = list[0]?.studyId;
    if (study) {
      const fields = await (await fetch(`${base}/api/fields?year=${y0}&study=${encodeURIComponent(study)}`)).json();
      check(fields.source === 'extraction', `${study} 字段来自抽取产物`,
        `${study} 的 source=${fields.source} —— 医生看到的会是金标准`);
      const mini = await (await fetch(`${base}/api/minidoc?year=${y0}&study=${encodeURIComponent(study)}`)).json();
      check((mini.blocks?.length ?? 0) > 0,
        `MiniDoc 有 ${mini.blocks?.length ?? 0} 个块（定位证据可用）`,
        'MiniDoc 是空的 —— *_middle.json 的层级不对');
      const pdf = await fetch(`${base}/api/pdf?year=${y0}&study=${encodeURIComponent(study)}`);
      const buf = Buffer.from(await pdf.arrayBuffer());
      check(pdf.ok && buf.subarray(0, 4).toString() === '%PDF',
        `PDF 可下载（${mb(buf.length)}）`, `PDF 取不到（HTTP ${pdf.status}）`);
    }
  } else {
    ok('（无数据，跳过接口检查）');
  }
} catch (e) {
  if (String(e.message) !== 'no server') bad(`请求过程出错：${e.message}`);
} finally {
  srv.kill();
}

console.log(`\n══ 结果：${pass} 通过 / ${fail} 失败 ══\n`);
process.exit(fail ? 1 : 0);
