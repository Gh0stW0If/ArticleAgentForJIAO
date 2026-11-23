/**
 * **验收打包版 exe**：确认里面的提取流程是新的、且能跑起来。
 *
 * 检查项（每条都对应一次踩过的坑）：
 *   ① `resources/app/node_modules/@aa/*` 存在 → 裸包名能解析（否则 ERR_MODULE_NOT_FOUND）
 *   ② 真正 import 一次打包版的 skills dist → 不报模块错误
 *   ③ 跑一次打包版入口 `tools/llm_run.mjs`（用一个不存在的年份）→ 应报"缺金标准"这类业务错误，
 *      而不是模块解析错误
 *   ④ 打包版里的提示词含**新版本特征串**（单位三列口径），证明不是旧 dist
 *   ⑤ `packages/europepmc/dist` 在包里（article-meta 会 import 它）
 *   ⑥ 打包时间 ≥ 各包 dist 的最新修改时间 → 没有"打包早于编译"
 *
 * 用法：node tools/desktop_verify.mjs
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP = join(ROOT, 'build', 'desktop', 'win-unpacked', 'resources', 'app');
let fail = 0;
const ok = (s) => console.log(`  ✓ ${s}`);
const bad = (s) => { fail++; console.log(`  ✗ ${s}`); };

console.log(`\n══ 验收打包版：${APP} ══\n`);
if (!existsSync(APP)) { console.error('✗ 没有打包产物，先跑 node tools/desktop_make.mjs'); process.exit(2); }

/* ① */
const aaDir = join(APP, 'node_modules', '@aa');
if (existsSync(aaDir)) ok(`node_modules/@aa 存在：${readdirSync(aaDir).join(', ')}`);
else bad('缺 node_modules/@aa → 裸包名无法解析（GUI 的「抽取」会 ERR_MODULE_NOT_FOUND）');

/* ⑤ */
const epmc = join(APP, 'packages', 'europepmc', 'dist');
if (existsSync(epmc)) ok('packages/europepmc/dist 在包里');
else bad('缺 packages/europepmc/dist → article-meta 的 import 会失败');

/* ② */
if (existsSync(aaDir)) {
  const entry = join(APP, 'packages', 'skills', 'dist', 'index.js');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e',
    `await import(${JSON.stringify(`file:///${entry.replace(/\\/g, '/')}`)}); console.log('LOADED');`],
  { encoding: 'utf8' });
  if (r.status === 0 && /LOADED/.test(r.stdout)) ok('打包版 packages/skills/dist 能 import（裸包名解析通过）');
  else bad(`打包版 skills/dist 加载失败：${String(r.stderr).split('\n').find((l) => /Error|error/.test(l)) ?? r.stderr}`);
}

/* ③ 真的跑一次打包版入口，并与**工作区脚本**对同一输入比较。
 *
 * 这是最有说服力的一条：打包版必须读到工作区的 `build/`（如影响因子索引）与 `runtime/` 配置，
 * 而不是 exe 自己的解包目录。判据：
 *   · 不能出现 ERR_MODULE_NOT_FOUND（裸包名解析）
 *   · 不能出现"未找到配置文件"（ROOT 没落到工作区）
 *   · 打包版与工作区脚本对同一输入**输出一致**（拿一个不存在的年份，走业务报错路径，不花 token）
 */
{
  const args = [join(APP, 'tools', 'llm_run.mjs'), '--year', '1999'];
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', cwd: ROOT, env: { ...process.env, AA_ROOT: ROOT } });
  const out = `${r.stdout}\n${r.stderr}`;
  const rw = spawnSync(process.execPath, [join(ROOT, 'tools', 'llm_run.mjs'), '--year', '1999'],
    { encoding: 'utf8', cwd: ROOT, env: { ...process.env, AA_ROOT: ROOT } });
  const outW = `${rw.stdout}\n${rw.stderr}`;
  const norm = (s) => s.split('\n').map((l) => l.trim())
    .filter((l) => l && !/^at |node:internal|Node\.js v|CategoryInfo|FullyQualifiedErrorId|^\+|^$/.test(l))
    .join(' | ');
  if (/ERR_MODULE_NOT_FOUND|Cannot find package/.test(out)) {
    bad(`入口报模块解析错误：${out.split('\n').find((l) => /Cannot find package/.test(l)) ?? ''}`);
  } else if (/未找到配置文件/.test(out)) {
    bad(`ROOT 没落到工作区：${out.split('\n').find((l) => /未找到配置文件/.test(l)) ?? ''}`);
  } else if (!/影响因子\] 用索引/.test(out)) {
    bad('打包版没有读到工作区的 build/（影响因子索引那一行没出现）');
  } else if (norm(out) === norm(outW)) {
    ok('打包版入口与工作区入口表现一致（读的是同一个工作区的 build/ 与配置，业务级报错）');
  } else {
    bad(`打包版与工作区入口输出不一致：\n      打包版 ${norm(out).slice(0, 120)}\n      工作区 ${norm(outW).slice(0, 120)}`);
  }
}

/* ④ 新版本特征串：提示词里的单位口径（2026-09-18 第三轮改成"按原文怎么写就怎么记"） */
{
  const f = join(APP, 'packages', 'skills', 'dist', 'prompts.generated.js');
  if (!existsSync(f)) bad('缺 skills/dist/prompts.generated.js');
  else {
    const t = readFileSync(f, 'utf8');
    const marks = [
      ['按原文怎么写就怎么记', '单位三列口径（第三轮修正）'],
      ['1 月 = 4 周', '单位换算约定'],
    ];
    for (const [needle, label] of marks) {
      if (t.includes(needle)) ok(`提示词含「${label}」`);
      else bad(`提示词缺少「${label}」（可能是旧 dist）`);
    }
    /*
     * ⑤ 已退役字段必须**不在**提示词里（202609 规则，见 RETIRED_FIELDS）。
     *
     * 这里以前是反着写的：当时 `totalSessionsClassB` 没有编码表属于"已知未修"，
     * 于是断言它必须命中。该列现已整列退役，断言改成"必须消失"——
     * 顺带让这条验收能兜住「改了字段清单但没重新打包」。
     */
    const retired = ['totalSessionsClassB', 'totalSessionsClassA', 'frequencyClass', 'needleRetentionClass', 'specialDataFlag'];
    for (const k of retired) {
      if (t.includes(k)) bad(`提示词仍含已退役字段「${k}」（字段清单没生效，或打的是旧 dist）`);
      else ok(`已退役字段「${k}」不在提示词里`);
    }
  }
}

/* ⑥ exe 是否晚于它**打进包里的**所有代码：
 *      packages 下各包的 src 与 dist、tools 下的 .mjs、apps/web（服务与前端）、apps/desktop/main.mjs
 *
 * `tools/` 也是打进 exe 的（electron-builder 的 files 里带了它，filter 为 .mjs），所以必须一起比——
 * 否则改了 `tools/llm_run.mjs` 而没重打包，这份验收会漏报（实测踩到）。
 * 排除打包/验收脚本自身与 `_` 前缀的一次性诊断脚本，它们不影响运行时行为。
 */
{
  const exe = readdirSync(join(ROOT, 'build', 'desktop')).filter((f) => f.endsWith('.exe')).sort().pop();
  if (!exe) bad('build/desktop 下没有 exe');
  else {
    const exeT = statSync(join(ROOT, 'build', 'desktop', exe)).mtimeMs;
    const SKIP = /(desktop_(verify|make|stage_modules)|^_)/;
    let newest = 0; let newestFile = '';
    const scan = (dir, keep) => {
      if (!existsSync(dir)) return;
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const f = join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') scan(f, keep); continue; }
        if (!keep(e.name)) continue;
        const t = statSync(f).mtimeMs;
        if (t > newest) { newest = t; newestFile = f.slice(ROOT.length + 1); }
      }
    };
    for (const p of ['core', 'crossref', 'europepmc', 'ingest', 'skills']) {
      scan(join(ROOT, 'packages', p, 'src'), () => true);
      scan(join(ROOT, 'packages', p, 'dist'), () => true);
    }
    scan(join(ROOT, 'tools'), (n) => n.endsWith('.mjs') && !SKIP.test(n));
    scan(join(ROOT, 'apps', 'web', 'src'), () => true);
    scan(join(ROOT, 'apps', 'web', 'dist'), () => true);
    scan(join(ROOT, 'apps', 'desktop'), (n) => n === 'main.mjs');
    if (exeT >= newest) ok(`exe（${new Date(exeT).toISOString().slice(0, 16)}）晚于所有入包代码（最新 ${newestFile} @ ${new Date(newest).toISOString().slice(0, 16)}）`);
    else bad(`exe 比代码旧：exe ${new Date(exeT).toISOString().slice(0, 16)} < ${newestFile} ${new Date(newest).toISOString().slice(0, 16)} → 跑 node tools/desktop_make.mjs`);
  }
}

console.log(fail === 0 ? '\n全部通过 ✅\n' : `\n${fail} 项未通过 ❌\n`);
process.exit(fail === 0 ? 0 : 1);
