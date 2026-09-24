/**
 * 全量运行：逐年份把「解析 → 抽取 → 评测」跑通，产出年度评测报告。
 *
 * 用法：
 *   node tools/run_all_years.mjs                      # 2015..2025 全部
 *   node tools/run_all_years.mjs --years 2015,2016    # 指定年份
 *   node tools/run_all_years.mjs --skip-parse         # 已解析过，只跑抽取+评测
 *   node tools/run_all_years.mjs --jobs 4             # 抽取并发数（默认 4）
 *   node tools/run_all_years.mjs --dry                # 只打印计划
 *
 * 三个阶段的取舍：
 *   1. **解析（MinerU）**：只有缺产物时才跑。MinerU 的 `-p` 只接受一个路径，
 *      所以整年目录一次提交（模型只加载一次，比逐篇快得多）。
 *   2. **抽取（LLM）**：逐篇调用 `llm_run.mjs --only <id>`，**多篇并发**。
 *      实测单篇 20 次左右请求、串行要数小时；并发 4 路能把全量压到 1~2 小时。
 *      并发按篇分片，互不写同一文件（产物 `build/extraction/<year>/<id>.json`、
 *      缓存 `build/llm-cache/<hash>.json` 都是按篇/按请求指纹命名的）。
 *   3. **评测**：跑 `llm_eval.mjs`，产出 `build/eval/<year>.json`。
 *
 * 幂等：重复运行会复用 LLM 缓存与已有产物；`--force-extract` 可强制重跑抽取。
 */

import { readdirSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = { years: [], jobs: 4, skipParse: false, forceExtract: false, dry: false, follow: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--years') opt.years = String(argv[++i]).split(',').map((s) => s.trim()).filter(Boolean);
  else if (a === '--jobs') opt.jobs = Math.max(1, Number(argv[++i]));
  else if (a === '--skip-parse') opt.skipParse = true;
  else if (a === '--force-extract') opt.forceExtract = true;
  else if (a === '--dry') opt.dry = true;
  else if (a === '--follow') opt.follow = true;
  else throw new Error(`未知参数 ${a}`);
}
const YEARS = opt.years.length ? opt.years : Array.from({ length: 11 }, (_, i) => String(2015 + i));

const ARTICLES = (y) => join(ROOT, 'Datas', 'articles', y);
const MINERU = (y) => join(ROOT, 'build', 'mineru', y);
const EXTRACTION = (y) => join(ROOT, 'build', 'extraction', y);
const MINERU_EXE = join(ROOT, 'runtime', 'mineru', 'Scripts', 'mineru.exe');

const studiesOf = (y) => {
  const dir = ARTICLES(y);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.pdf$/i.test(f))
    .map((f) => /(\d{4}-\d{1,2}(?:-\d{1,2})?)/.exec(f.replace(/^-+/, ''))?.[1])
    .filter(Boolean)
    .sort();
};

const parsedCount = (y) => {
  const d = MINERU(y);
  if (!existsSync(d)) return 0;
  return readdirSync(d).filter((n) => n !== '_clean').length;
};

/** 跑一个子进程并把输出按行回调（stdout 保持原样，便于后台日志查看）。 */
function run(cmd, args, { env = {}, onLine } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, windowsHide: true });
    const pipe = (stream) => {
      let buf = '';
      stream.on('data', (d) => {
        buf += d.toString();
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() ?? '';
        for (const l of lines) if (l.trim()) onLine?.(l);
      });
    };
    pipe(child.stdout); pipe(child.stderr);
    child.on('close', (code) => resolvePromise(code ?? 1));
  });
}

/* ------------------------------ 解析 ------------------------------ */

async function parseYear(y, studies) {
  const need = studies.length;
  const have = parsedCount(y);
  if (have >= need) {
    console.log(`  [解析] 已有 ${have}/${need} 篇产物，跳过`);
    return true;
  }
  if (!existsSync(MINERU_EXE)) {
    console.log(`  [解析] ✗ 未找到 MinerU：${MINERU_EXE}`);
    return false;
  }
  console.log(`  [解析] 提交整年目录（${need} 篇）→ MinerU 只加载一次模型…`);
  const code = await run(MINERU_EXE,
    ['-p', ARTICLES(y), '-o', MINERU(y), '-b', 'pipeline', '-m', 'txt'],
    { env: { MINERU_MODEL_SOURCE: 'local' }, onLine: (l) => { if (/Completed|Error|Traceback/.test(l)) console.log(`    ${l.slice(0, 160)}`); } });
  console.log(`  [解析] 完成（exit ${code}），产物 ${parsedCount(y)}/${need}`);
  return code === 0;
}

/* ------------------------------ 抽取（并发） ------------------------------ */

async function extractYear(y, studies) {
  const done = new Set(
    existsSync(EXTRACTION(y))
      ? readdirSync(EXTRACTION(y)).filter((f) => /^\d{4}-\d+\.json$/.test(f)).map((f) => f.replace('.json', ''))
      : [],
  );
  const todo = opt.forceExtract ? studies : studies.filter((s) => !done.has(s));
  if (!todo.length) {
    console.log(`  [抽取] ${studies.length} 篇都已有产物，跳过`);
    return;
  }
  console.log(`  [抽取] ${todo.length} 篇待跑（并发 ${opt.jobs}）…`);
  let idx = 0;
  let ok = 0;
  let fail = 0;

  const worker = async (n) => {
    while (idx < todo.length) {
      const study = todo[idx++];
      const code = await run(process.execPath,
        [join(ROOT, 'tools', 'llm_run.mjs'), '--year', y, '--only', study],
        { env: { ELECTRON_RUN_AS_NODE: '1' }, onLine: (l) => { if (/✗|失败/.test(l)) console.log(`    [w${n}] ${study}: ${l.slice(0, 140)}`); } });
      if (code === 0) { ok++; } else { fail++; console.log(`    [w${n}] ✗ ${study} exit ${code}`); }
      if ((ok + fail) % 10 === 0) console.log(`    进度 ${ok + fail}/${todo.length}（成功 ${ok} 失败 ${fail}）`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(opt.jobs, todo.length) }, (_, i) => worker(i + 1)));
  console.log(`  [抽取] 完成：成功 ${ok} 失败 ${fail}`);
}

/* ------------------------------ 评测 ------------------------------ */

async function evalYear(y) {
  console.log(`  [评测] 跑 ${y} …`);
  const code = await run(process.execPath, [join(ROOT, 'tools', 'llm_eval.mjs'), '--year', y],
    { onLine: (l) => { if (/准确率|报告/.test(l)) console.log(`    ${l.slice(0, 140)}`); } });
  const f = join(ROOT, 'build', 'eval', `${y}.json`);
  console.log(`  [评测] exit ${code}${existsSync(f) ? '，报告已生成' : '，⚠ 无报告产出'}`);
}

/* ------------------------------ 主流程 ------------------------------ */

console.log(`\n=== 全量运行 ===`);
console.log(`  年份   ${YEARS.join(', ')}`);
console.log(`  并发   ${opt.jobs}；跳过解析 ${opt.skipParse}；强制抽取 ${opt.forceExtract}${opt.dry ? '；仅打印计划' : ''}\n`);

const summary = [];

/**
 * 守护模式（`--follow`）：等 MinerU 把某年解析完，就自动接着抽取 + 评测。
 *
 * 为什么需要它：全量解析要一两个小时（单 GPU 串行），抽取又是另一段长时间。
 * 没有守护模式就得人工盯着"哪年解析完了、该跑抽取了"——实测这样最容易漏年份，
 * 或者忍不住提前跑导致抽取在缺产物的年份上大面积失败。
 * 判据很简单：该年**解析产物数 ≥ PDF 数**才算就绪。
 */
if (opt.follow) {
  const done = new Set();
  let idle = 0;
  console.log('守护模式：等各年解析就绪后自动抽取 + 评测（每 60s 检查一次）\n');
  for (;;) {
    let progressed = false;
    for (const y of YEARS) {
      if (done.has(y)) continue;
      const studies = studiesOf(y);
      if (!studies.length) { done.add(y); continue; }
      if (parsedCount(y) < studies.length) continue;
      console.log(`──── ${y} 解析就绪（${parsedCount(y)}/${studies.length}）→ 抽取 + 评测 ────`);
      await extractYear(y, studies);
      await evalYear(y);
      done.add(y);
      progressed = true;
    }
    if (done.size >= YEARS.length) break;
    if (!progressed) {
      idle++;
      if (idle % 5 === 0) {
        const state = YEARS.filter((y) => !done.has(y)).map((y) => `${y}:${parsedCount(y)}/${studiesOf(y).length}`).join(' ');
        console.log(`  …等待解析：${state}`);
      }
    } else idle = 0;
    await new Promise((r) => setTimeout(r, 60_000));
  }
  console.log('\n守护模式：全部年份完成。');
}

for (const y of YEARS) {
  const studies = studiesOf(y);
  console.log(`──── ${y}（${studies.length} 篇）────`);
  if (!studies.length) { summary.push({ year: y, studies: 0 }); continue; }
  if (opt.dry) { summary.push({ year: y, studies: studies.length, parsed: parsedCount(y) }); continue; }

  if (!opt.skipParse) await parseYear(y, studies);
  await extractYear(y, studies);
  await evalYear(y);
  summary.push({ year: y, studies: studies.length, parsed: parsedCount(y) });
}

console.log(`\n=== 汇总 ===`);
for (const s of summary) console.log(`  ${s.year}: ${s.studies} 篇，已解析 ${s.parsed ?? '-'}`);
console.log(`\n提示：接着跑 \`node tools/report_clinicians.mjs\` 生成给医生看的报告。\n`);
