/**
 * MinerU 的**公式误触发**污染面量化。
 *
 * 现象（2015-02 p4 实测）：MinerU 的公式模块把**普通数字**当成行内公式，
 * 输出 LaTeX `4 1 . 7 5 \pm 1 1 . 1 5`（原文是 `41.75 ± 11.15`）。
 * middle.json 的 table_body span 用 `<eq>…</eq>` 包裹，markdown 用 `$…$` 包裹 —— **两路都脏**。
 * 而 `packages/ingest/src/ingest.ts` 的 `tableParts()` 恰好取的就是这个 `sp.html`，
 * 于是喂给 LLM 的表格材料里，数值被拆成了孤立的单个数字（`4`、`1`、`7`、`5`）。
 *
 * 这直接决定第 ① 问的答案：问题不在"要不要上多模态/OCR"，
 * 而在"**MinerU 已经把数字读出来了，只是被 LaTeX 包坏了**"——去 LaTeX 化即可，成本极低。
 *
 * 输出：build/latex_noise.json
 * 用法：node tools/latex_noise.mjs [--year 2015] [--detail]
 */

import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const ONLY_YEAR = arg('year', null);
const DETAIL = argv.includes('--detail');
const YEARS = ONLY_YEAR ? [ONLY_YEAR]
  : ['2015', '2016', '2017', '2018', '2019', '2020', '2021', '2022', '2023', '2024', '2025'];

/** `<eq>…</eq>` 里的内容是否含"数字 空格 数字"（即被拆散的数字）。 */
const SPACED_DIGITS = /\d\s+\d/;
/** 段落 span 的 content 里出现 LaTeX 命令（反斜杠 + 字母）或 `$…$`。 */
const HAS_TEX_CMD = /\\[a-zA-Z]{2,}|\$[^$]{2,}\$/;

const stat = {
  articles: 0, tables: 0, tablesWithEq: 0, tablesWithSpacedDigits: 0,
  eqSpans: 0, eqSpansSpacedDigits: 0,
  paraSpans: 0, paraSpansWithTex: 0, paraSpansWithSpacedDigits: 0,
  articlesAffected: 0, articleIds: [],
};
const rows = [];
const samples = [];

for (const year of YEARS) {
  const base = join(ROOT, 'build', 'mineru', year);
  if (!existsSync(base)) continue;
  for (const d of readdirSync(base, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const id = d.name.replace(/^-+/, '');
    if (!/^\d{4}-\d+$/.test(id)) continue;
    const txtDir = join(base, d.name, 'txt');
    if (!existsSync(txtDir)) continue;
    const midFile = readdirSync(txtDir).find((f) => f.endsWith('_middle.json'));
    if (!midFile) continue;
    let mid;
    try { mid = JSON.parse(readFileSync(join(txtDir, midFile), 'utf8')); } catch { continue; }
    stat.articles++;

    let tTables = 0; let tEq = 0; let tSpaced = 0;
    let eqSpans = 0; let eqSpaced = 0; let paraSpans = 0; let paraTex = 0; let paraSpaced = 0;

    for (const page of mid.pdf_info ?? []) {
      const walk = (blocks) => {
        for (const b of blocks ?? []) {
          const type = String(b.type ?? '').toLowerCase();
          const spans = (b.lines ?? []).flatMap((l) => l.spans ?? []);
          if (type === 'table') tTables++;
          for (const s of spans) {
            const html = String(s.html ?? '');
            const content = String(s.content ?? '');
            if (html) {
              const eqs = html.match(/<eq>[\s\S]*?<\/eq>/g) ?? [];
              if (eqs.length) tEq++;
              let spaced = false;
              for (const e of eqs) {
                eqSpans++;
                if (SPACED_DIGITS.test(e)) {
                  eqSpaced++;
                  spaced = true;
                  if (DETAIL && samples.length < 40) samples.push({ id, page: page.page_idx + 1, eq: e.slice(0, 160) });
                }
              }
              if (spaced) tSpaced++;
            }
            if (content) {
              paraSpans++;
              if (HAS_TEX_CMD.test(content)) paraTex++;
              if (SPACED_DIGITS.test(content)) paraSpaced++;
            }
          }
          if (b.blocks) walk(b.blocks);
        }
      };
      walk(page.para_blocks);
      walk(page.discarded_blocks);
    }

    stat.tables += tTables; stat.tablesWithEq += tEq; stat.tablesWithSpacedDigits += tSpaced;
    stat.eqSpans += eqSpans; stat.eqSpansSpacedDigits += eqSpaced;
    stat.paraSpans += paraSpans; stat.paraSpansWithTex += paraTex; stat.paraSpansWithSpacedDigits += paraSpaced;
    const affected = tSpaced > 0 || eqSpaced > 0 || paraTex > 0;
    if (affected) { stat.articlesAffected++; stat.articleIds.push(id); }
    rows.push({ year, articleId: id, tables: tTables, tablesWithEq: tEq, tablesWithSpacedDigits: tSpaced,
      eqSpans, eqSpansSpacedDigits: eqSpaced, paraSpans, paraSpansWithTex: paraTex, paraSpansWithSpacedDigits: paraSpaced });
  }
}

const pc = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');
console.log(`\n══ MinerU 公式误触发（数字被 LaTeX 包坏）污染面 ══\n`);
console.log(`  扫描：${stat.articles} 篇 / ${stat.tables} 张表`);
console.log(`  含 <eq> 的表格：${stat.tablesWithEq}（${pc(stat.tablesWithEq, stat.tables)}）`);
console.log(`  其中 <eq> 里数字被空格拆散：${stat.tablesWithSpacedDigits}（占含 eq 的表 ${pc(stat.tablesWithSpacedDigits, stat.tablesWithEq)}）`);
console.log(`  <eq> 片段：${stat.eqSpans} 个｜数字被拆散：${stat.eqSpansSpacedDigits}（${pc(stat.eqSpansSpacedDigits, stat.eqSpans)}）`);
console.log(`  段落 span：${stat.paraSpans} 个｜含 LaTeX 命令：${stat.paraSpansWithTex}（${pc(stat.paraSpansWithTex, stat.paraSpans)}）`);
console.log(`  受影响篇数：${stat.articlesAffected} / ${stat.articles}（${pc(stat.articlesAffected, stat.articles)}）`);

const byYear = new Map();
for (const r of rows) {
  const y = byYear.get(r.year) ?? { n: 0, aff: 0, tables: 0, bad: 0 };
  y.n++; if (r.tablesWithSpacedDigits) y.aff++;
  y.tables += r.tables; y.bad += r.tablesWithSpacedDigits;
  byYear.set(r.year, y);
}
console.log('\n  分年（表被 LaTeX 包坏）：');
for (const [y, v] of [...byYear].sort()) {
  console.log(`   ${y}：${String(v.aff).padStart(3)}/${String(v.n).padStart(3)} 篇受影响｜表 ${String(v.bad).padStart(4)}/${String(v.tables).padStart(4)}（${pc(v.bad, v.tables)}）`);
}

if (DETAIL && samples.length) {
  console.log('\n  样例：');
  for (const s of samples.slice(0, 12)) console.log(`   ${s.id} p${s.page}：${s.eq}`);
}

const out = join(ROOT, 'build', 'latex_noise.json');
writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), stat, rows }, null, 1), 'utf8');
console.log(`\n明细 ${out.replace(ROOT + '\\', '')}\n`);
