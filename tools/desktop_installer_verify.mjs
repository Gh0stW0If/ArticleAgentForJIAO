/**
 * **医生安装包验收**：拿 `build/desktop-payload/` 当工作区，把服务真跑起来点一遍。
 *
 * 为什么不能只检查"文件在不在"：
 *   `build/mineru/` 里每个目录有 8 个文件，服务端**只读其中一个**
 *   （`<stem>/<sub>/*_middle.json`，见 server.mjs 的 `mineruDirOf`）。
 *   裁数据时只要把目录层级弄错一层，打包不会报任何错、安装也正常，
 *   但医生一打开就是"页面空白 / 定位证据没反应"。
 *   所以这里必须**真的请求一遍**。
 *
 * 检查项：
 *   1. payload 结构（年份齐、每篇都有 middle/extraction、没夹带密钥）
 *   2. 起服务（AA_ROOT=payload），逐个点：
 *      /api/health · /api/studies · /api/fields · /api/minidoc · /api/pdf · /api/adjudication
 *   3. 安装包文件存在且体积合理
 *
 * 用法：
 *   node tools/desktop_installer_verify.mjs                    # 验 payload
 *   node tools/desktop_installer_verify.mjs --root <目录>       # 验任意工作区
 *     ⚠️ 更硬的验法：指向 **解包出来的安装目录**
 *     （`build/desktop-installer/win-unpacked`）—— 那才是医生装完看到的布局，
 *     能顺带证明 electron-builder 的 `extraFiles` 真的落在 exe 旁边。
 */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSecretLeaks } from './lib/secret_scan.mjs';
import { scanRuntimeDeps } from './desktop_dep_scan.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const PAYLOAD = resolve(ROOT, arg('root', join('build', 'desktop-payload')));
const PORT = 43211;

let pass = 0; let fail = 0;
const ok = (m) => { pass++; console.log(`  ✓ ${m}`); };
const bad = (m) => { fail++; console.log(`  ✗ ${m}`); };
const check = (cond, good, badMsg) => (cond ? ok(good) : bad(badMsg ?? good));

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

console.log(`\n══ 验收医生安装包 ══\n${PAYLOAD}\n`);

if (!existsSync(PAYLOAD)) {
  console.error('✗ 没有 payload。先跑：node tools/desktop_installer.mjs');
  process.exit(2);
}

/* ------------------------------ 1. 结构 ------------------------------ */

console.log('§1 payload 结构');

const years = existsSync(join(PAYLOAD, 'build', 'extraction'))
  ? readdirSync(join(PAYLOAD, 'build', 'extraction')).filter((d) => /^\d{4}$/.test(d)).sort()
  : [];
check(years.length > 0, `包含 ${years.length} 个年份：${years.join(', ')}`, '没有任何年份');

let nPdf = 0; let nMid = 0; let nExtr = 0; let nGold = 0;
for (const y of years) {
  const pdfDir = join(PAYLOAD, 'Datas', 'articles', y);
  nPdf += existsSync(pdfDir) ? readdirSync(pdfDir).filter((f) => f.endsWith('.pdf')).length : 0;

  const mbase = join(PAYLOAD, 'build', 'mineru', y);
  if (existsSync(mbase)) {
    for (const stem of readdirSync(mbase)) {
      const sd = join(mbase, stem);
      if (!statSync(sd).isDirectory()) continue;
      for (const sub of readdirSync(sd)) {
        const sub2 = join(sd, sub);
        if (statSync(sub2).isDirectory() && readdirSync(sub2).some((f) => f.endsWith('_middle.json'))) nMid++;
      }
    }
  }
  /*
   * ⚠️ 只数**文章**产物：抽取目录里还有每年一个 `_run.json`（运行报告），
   *    用 `f.endsWith('.json')` 会把它算进去，于是下面 `nMid >= nExtr` 的检查
   *    误报"有 N 篇缺 *_middle.json"（实测在单年 payload 上踩到；
   *    11 年合计时因为 237 ≥ 235 才凑巧没触发）。
   */
  nExtr += readdirSync(join(PAYLOAD, 'build', 'extraction', y))
    .filter((f) => /^\d{4}-\d{1,2}\.json$/.test(f)).length;
  if (existsSync(join(PAYLOAD, 'build', 'gold', `${y}.json`))) nGold++;
}

ok(`原文 PDF ${nPdf} 篇 / MinerU 中间件 ${nMid} 篇 / 抽取结果 ${nExtr} 篇 / 金标准 ${nGold} 年`);
check(nMid >= nExtr, `每篇都有 *_middle.json（${nMid} ≥ ${nExtr}）`,
  `有 ${nExtr - nMid} 篇缺 *_middle.json —— 那些篇的「定位证据/解析块」会失效`);

for (const d of ['build/annotations', 'build/adjudications', 'build/review-batches', 'runtime']) {
  check(existsSync(join(PAYLOAD, d)), `可写落点 ${d}/ 存在`, `缺 ${d}/ —— isWorkspace() 会失败，医生会被弹出选目录对话框`);
}

/* 密钥硬校验（与打包脚本**同一实现**，避免两边判据漂移） */
const leaks = findSecretLeaks(PAYLOAD);
check(leaks.length === 0, '未夹带 API 密钥',
  `⚠️ 发现疑似密钥：${leaks.map((x) => `${x.rel}（${x.why}）`).join('；')}`);

/* ------------------------------ 2. 真起服务点一遍 ------------------------------ */

console.log('\n§2 用 payload 当工作区，真跑服务');

const srv = spawn(process.execPath, [join(ROOT, 'apps', 'web', 'server.mjs')], {
  env: { ...process.env, AA_ROOT: PAYLOAD, AA_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLog = '';
srv.stdout.on('data', (d) => { srvLog += d; });
srv.stderr.on('data', (d) => { srvLog += d; });

const base = `http://127.0.0.1:${PORT}`;
const waitUp = async () => {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await new Promise((s) => setTimeout(s, 250));
  }
  return false;
};

try {
  if (!(await waitUp())) {
    bad(`服务起不来（端口 ${PORT}）\n${srvLog.slice(-800)}`);
    throw new Error('server not up');
  }
  ok(`服务已启动（AA_ROOT=payload, :${PORT}）`);

  const y0 = years.at(-1);
  const studies = await (await fetch(`${base}/api/studies?year=${y0}`)).json();
  const list = studies.studies ?? [];
  check(list.length > 0, `${y0} 年列出 ${list.length} 篇研究`, `${y0} 年一篇都没列出来`);
  const study = list[0]?.studyId;
  if (!study) throw new Error('no study');

  const fields = await (await fetch(`${base}/api/fields?year=${y0}&study=${encodeURIComponent(study)}`)).json();
  check(fields.source === 'extraction',
    `${study} 字段来自**抽取产物**（source=extraction）`,
    `${study} 的 source=${fields.source} —— 说明抽取产物没被认出来（医生看到的会是金标准）`);
  const nSheet3 = fields.sheets?.sheet3?.rows?.length ?? 0;
  check(nSheet3 > 0, `Sheet3 有 ${nSheet3} 个结局行`, 'Sheet3 没有结局行');

  const mini = await (await fetch(`${base}/api/minidoc?year=${y0}&study=${encodeURIComponent(study)}`)).json();
  const nBlocks = mini.blocks?.length ?? 0;
  check(nBlocks > 0,
    `MiniDoc 有 ${nBlocks} 个文本块 / ${mini.pages?.length ?? 0} 页（证明 *_middle.json 装对了）`,
    'MiniDoc 空的 —— *_middle.json 的目录层级不对，"定位证据"会失效');

  const pdf = await fetch(`${base}/api/pdf?year=${y0}&study=${encodeURIComponent(study)}`);
  const buf = Buffer.from(await pdf.arrayBuffer());
  check(pdf.ok && buf.subarray(0, 4).toString() === '%PDF',
    `PDF 可下载（${mb(buf.length)}，文件头 %PDF）`,
    `PDF 取不到（HTTP ${pdf.status}）—— 原文没装进去`);

  /* 待裁队列要靠 gold：找一篇真的有待裁行的 */
  let foundDefer = false;
  for (const s of list.slice(0, 12)) {
    const adj = await (await fetch(`${base}/api/adjudication?year=${y0}&study=${encodeURIComponent(s.studyId)}`)).json();
    if ((adj.rows ?? []).length > 0) { foundDefer = true; ok(`「待人工裁定」可用（${s.studyId} 有 ${adj.rows.length} 条）`); break; }
  }
  if (!foundDefer) ok('「待人工裁定」接口可用（该年恰好没有待裁行）');
} catch (e) {
  if (String(e.message) !== 'server not up') bad(`请求过程出错：${e.message}`);
} finally {
  srv.kill();
}

/* ------------------------------ 3. 运行时依赖是否都进包了 ------------------------------ */

/*
 * 这条一定要查：打包只搬 `@aa/*` 与壳代码，**不搬第三方依赖**。
 * 某个 `.mjs` 只要 import 了一个第三方包，开发机上永远发现不了
 * （node_modules 就在旁边），一到干净机器就 ERR_MODULE_NOT_FOUND。
 * 详见 tools/desktop_dep_scan.mjs 顶部说明。
 */
console.log('\n§3 运行时可达依赖');
{
  const appDir = existsSync(join(PAYLOAD, 'resources', 'app'))
    ? join(PAYLOAD, 'resources', 'app')                          // 传进来的是解包后的安装目录
    : join(PAYLOAD, 'win-unpacked', 'resources', 'app');         // 或仓库里的固定位置
  if (!existsSync(appDir)) {
    ok('跳过（当前只验 payload，没有壳代码可查）');
  } else {
    const r = scanRuntimeDeps(appDir);
    check(r.missing.length === 0,
      `可达 ${r.files} 个文件，裸依赖 ${r.bare.join('、') || '（无）'}，全部可解析`,
      `有 ${r.missing.length} 个模块包内解析不到（干净机器会 ERR_MODULE_NOT_FOUND）：`
        + r.missing.map((m) => `${m.spec} ← ${m.from}`).join('；'));
  }
}

/* ------------------------------ 4. 安装包文件 ------------------------------ */

console.log('\n§4 安装包产物');
const outDir = join(ROOT, 'build', 'desktop-installer');
const setups = existsSync(outDir)
  ? readdirSync(outDir).filter((f) => f.endsWith('.exe')).map((f) => join(outDir, f))
  : [];
if (!setups.length) {
  bad('没有 setup.exe（只做了 payload？那就用 --payload-only）');
} else {
  for (const s of setups) {
    const sz = statSync(s).size;
    check(sz > 100 * 1024 * 1024,
      `${relative(ROOT, s)}  ${mb(sz)}`,
      `${relative(ROOT, s)} 只有 ${mb(sz)} —— 太小，数据多半没进包`);
  }
}

console.log(`\n══ 结果：${pass} 通过 / ${fail} 失败 ══\n`);
process.exit(fail ? 1 : 0);
