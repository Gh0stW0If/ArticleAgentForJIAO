/**
 * 核实 Sheet3 的行归属（是否按比较组拆），以及 2025 Sheet2 的重复行是什么。
 * 用法：node tools/_sheet_grain_probe.mjs
 */
import { readWorkbook, norm } from './lib/xlsx.mjs';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ── ① Sheet3 每行归属哪个 study_id（含 -01/-02 后缀） ── */
for (const [file, y] of [['2020-20篇-0813.xlsx', '2020'], ['2015-6篇-0813.xlsx', '2015']]) {
  const wb = readWorkbook(join(ROOT, 'Datas', 'label', file));
  const sh = wb.sheets['2'];
  const rows = (sh.rows ?? []).filter((r) => r.r > 5);           // 第 5 行是编码行
  const hist = new Map();
  for (const r of rows) {
    const id = norm((r.cells ?? [])[0]);
    if (!id) continue;
    hist.set(id, (hist.get(id) ?? 0) + 1);
  }
  console.log(`\n【${y} Sheet3】数据行 ${rows.length}，归属 ${hist.size} 个 study_id`);
  console.log('  行数最多的 study_id：' + [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}=${v}行`).join('  '));
  const g = JSON.parse(readFileSync(join(ROOT, 'build', 'gold', `${y}.json`), 'utf8'));
  const gHist = new Map();
  for (const a of g.articles ?? []) for (const o of a.outcomes ?? []) gHist.set(o.literature_code?.raw ?? '?', (gHist.get(o.literature_code?.raw ?? '?') ?? 0) + 1);
  console.log('  gold 里 literature_code 分布：' + [...gHist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}=${v}行`).join('  '));
  const multi = [...gHist.entries()].filter(([k]) => /-\d\d$/.test(k)).slice(0, 6);
  console.log('  带比较组后缀的 id 举例：' + (multi.length ? multi.map(([k, v]) => `${k}(${v})`).join('  ') : '（无）'));
}

/* ── ② 2025 Sheet2 的重复行 ── */
{
  const wb = readWorkbook(join(ROOT, 'Datas', 'label', '2025-33篇.xlsx'));
  const sh = wb.sheets['1'];
  const rows = (sh.rows ?? []).filter((r) => r.r > 1);
  const hit = rows.filter((r) => norm((r.cells ?? [])[0]) === '2025-02');
  console.log(`\n【2025 Sheet2】2025-02 出现 ${hit.length} 行：`);
  for (const r of hit) console.log(`   第${r.r}行 前 5 格：${(r.cells ?? []).slice(0, 5).map((c) => norm(c).slice(0, 28)).join(' | ')}`);
  const s1 = wb.sheets['0'];
  const hit1 = (s1.rows ?? []).filter((r) => r.r > 2 && norm((r.cells ?? [])[0]) === '2025-02');
  console.log(`【2025 Sheet1】2025-02 出现 ${hit1.length} 行：`);
  for (const r of hit1) console.log(`   第${r.r}行 前 6 格：${(r.cells ?? []).slice(0, 6).map((c) => norm(c).slice(0, 22)).join(' | ')}`);
  const s3 = wb.sheets['2'];
  const hit3 = (s3.rows ?? []).filter((r) => r.r > 5 && norm((r.cells ?? [])[0]).startsWith('2025-02'));
  console.log(`【2025 Sheet3】2025-02* 出现 ${hit3.length} 行，编号：${[...new Set(hit3.map((r) => norm((r.cells ?? [])[0])))].join(', ')}`);
}
