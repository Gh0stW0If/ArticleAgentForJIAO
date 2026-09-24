// tools/gold_reconcile.mjs — 交叉核对金标准里的可疑 ID / 重复条目
//
// 背景：部分年份的 xlsx 是从其它年份复制而来，改内容时漏改了 A 列 ID，
// 造成「同名不同文」的跨年份 ID 冲突（例如 2022 表里出现 2024-05）。
//
// 本工具【只读】：读取 build/gold/*.json 与 Datas/articles 下的 PDF 文件名，
// 输出 build/gold/_reconcile.json，不修改任何归一化结果。
//
// 用法：node tools/gold_reconcile.mjs

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(process.cwd());
const GOLD_ALL = join(ROOT, 'build', 'gold');
const GOLD = join(ROOT, 'build', 'gold', 'naive');   // 审计基线（未应用 ID 修正）
const ARTICLES = join(ROOT, 'Datas', 'articles');

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
/** 更激进的规范化：去掉标点，用于容忍「Joint Pain:」vs「Joint Pain」这类差异。 */
const normLoose = (s) => norm(s).replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
const V = (o) => o?.raw ?? null;
const yearOf = (id) => (String(id ?? '').match(/^(\d{4})/) ?? [])[1] ?? null;

/** 字符三元组 Dice 相似度：对改写/缺标点的标题足够稳健，且无需依赖。 */
function diceTrigram(a, b) {
  const grams = (s) => {
    const out = new Set();
    for (let i = 0; i + 3 <= s.length; i++) out.add(s.slice(i, i + 3));
    if (!out.size) out.add(s);
    return out;
  };
  const A = grams(a), B = grams(b);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
}

/** 年份目录下的 PDF 清单（去掉 -sup 等后缀变体）。 */
function pdfIndex(year) {
  const dir = join(ARTICLES, year);
  if (!existsSync(dir)) return new Map();
  const m = new Map();
  for (const f of readdirSync(dir).filter((x) => x.toLowerCase().endsWith('.pdf'))) {
    const base = f.replace(/\.pdf$/i, '');
    const id = base.replace(/-sup$/, '');
    if (!m.has(id)) m.set(id, []);
    m.get(id).push(f);
  }
  return m;
}

const years = readdirSync(GOLD)
  .filter((f) => /^\d{4}\.json$/.test(f))
  .map((f) => f.replace('.json', ''))
  .sort();

const docs = {};
for (const y of years) docs[y] = JSON.parse(readFileSync(join(GOLD, `${y}.json`), 'utf8'));
const pdfs = Object.fromEntries(years.map((y) => [y, pdfIndex(y)]));

const report = { generated_at: new Date().toISOString(), findings: [], recommendations: [] };

for (const y of years) {
  const d = docs[y];
  for (const a of d.articles) {
    const id = a.article_id;
    if (yearOf(id) === y) continue;

    const title = V(a.article.title) ?? V(a.study.title);
    const hasArticleRow = Object.keys(a.article).length > 0 || a.comparisons.length > 0;
    const finding = {
      file_year: y,
      id_as_recorded: id,
      correct_year: yearOf(id),
      has_article_level_row: hasArticleRow,
      title,
      outcome_rows: a.outcomes.length,
      // 证据 1：同文件其它表中是否存在「本年份」的同名条目
      same_title_in_same_file_other_sheet: null,
      // 证据 2：正确年份文件里同 ID 的标题
      same_id_in_year_file: null,
      // 证据 3：PDF 是否存在
      pdf: { in_recorded_year: null, in_correct_year: null },
    };

    // 证据 1：按标题在【同一文件】里找本年份的条目。
    // 注意 (a) Sheet2 的「题目」列有时填主要结局缩写；(b) 标题可能只差一个标点
    // （如 "Joint Pain:" vs "Joint Pain"），因此先做宽松规范化，再用三元组相似度兜底。
    if (title) {
      const nt = normLoose(title);
      let best = null;
      for (const other of d.articles) {
        if (other.article_id === id) continue;
        if (yearOf(other.article_id) !== y) continue;
        const rawOther = V(other.article.title) ?? V(other.study.title);
        if (!rawOther) continue;
        const ot = normLoose(rawOther);
        if (!ot || Math.min(ot.length, nt.length) < 30) continue;

        const exact = norm(V(other.article.title) ?? V(other.study.title)) === norm(title);
        const loose = ot === nt;
        const prefix = ot.startsWith(nt.slice(0, Math.min(ot.length, nt.length))) ||
                       nt.startsWith(ot.slice(0, Math.min(ot.length, nt.length)));
        const sim = diceTrigram(ot, nt);
        const kind = exact ? 'exact' : loose ? 'loose' : prefix ? 'prefix' : sim >= 0.85 ? 'fuzzy' : null;
        if (!kind) continue;
        if (!best || sim > best.sim) {
          best = {
            candidate_id: other.article_id,
            match_kind: kind,
            similarity: Number(sim.toFixed(3)),
            literature_no_sheet1: V(other.article.literature_no),
            literature_no_sheet2: V(other.study.literature_no),
            matched_text: String(rawOther).slice(0, 90),
            note: `同文件内标题${kind === 'exact' ? '完全一致' : kind === 'loose' ? '一致（忽略标点）' : kind === 'prefix' ? '前缀一致' : '高度相似'}`,
          };
        }
      }
      finding.same_title_in_same_file_other_sheet = best;
    }

    // 证据 2：正确年份文件里的同 ID
    const cy = yearOf(id);
    const target = docs[cy]?.articles.find((x) => x.article_id === id);
    if (target) {
      finding.same_id_in_year_file = {
        year: cy,
        title: V(target.article.title) ?? V(target.study.title),
        same_title: title ? norm(V(target.article.title) ?? V(target.study.title)) === norm(title) : null,
        note: '同 ID 在该年份文件中已存在 → 本条目是重复/滞留数据',
      };
    }

    // 证据 3：PDF
    finding.pdf.in_recorded_year = [...(pdfs[y]?.get(id) ?? [])];
    finding.pdf.in_correct_year = [...(pdfs[cy]?.get(id) ?? [])];

    report.findings.push(finding);
  }
}

// 生成建议 + 可机读的 ID 修正映射
const idRemap = [];
for (const f of report.findings) {
  const dup = f.same_id_in_year_file;
  if (dup && dup.same_title === false && f.same_title_in_same_file_other_sheet) {
    const target = f.same_title_in_same_file_other_sheet.candidate_id;
    report.recommendations.push({
      id: f.id_as_recorded,
      action: 'rename_id',
      reason: `ID 年份写错：${f.correct_year} 文件里 ${f.id_as_recorded} 已属于另一篇文章；` +
        `同文件的 ${target} 标题逐字一致（${f.pdf.in_correct_year.join(',') || 'PDF 佐证'}），应改为 ${target}。`,
      evidence: {
        same_title_candidate: target,
        pdf_in_correct_year: f.pdf.in_correct_year,
        pdf_in_recorded_year: f.pdf.in_recorded_year,
      },
    });
    // 逐条映射：2024-06-01 → 2022-06-01（保留比较组序号）
    const suffix = f.id_as_recorded.slice(f.correct_year.length + 3);
    const targetSuffix = target.slice(8);
    const newId = f.file_year + '-' + target.slice(5, 7) + suffix;
    idRemap.push({ file_year: f.file_year, from: f.id_as_recorded, to: newId, evidence: 'same_title_within_file' });
  } else if (dup && dup.same_title === false) {
    report.recommendations.push({
      id: f.id_as_recorded,
      action: 'investigate_id',
      reason: `ID 在 ${f.correct_year} 文件中已属于另一篇文章，但本文件内找不到标题一致的候选 → 需人工判定。`,
      evidence: { pdf_in_recorded_year: f.pdf.in_recorded_year, pdf_in_correct_year: f.pdf.in_correct_year },
    });
  } else if (!dup && f.has_article_level_row) {
    report.recommendations.push({
      id: f.id_as_recorded,
      action: 'investigate_id',
      reason: `A 列 ID 年份与文件不符，且在 ${f.correct_year} 文件中不存在同 ID，需人工判定归属。`,
      evidence: { pdf_in_recorded_year: f.pdf.in_recorded_year },
    });
  } else {
    report.recommendations.push({
      id: f.id_as_recorded,
      action: 'stale_outcome_rows',
      reason: `仅有 Sheet3 结局行（${f.outcome_rows} 行），无文章级记录，且 ${f.correct_year} 文件已收录同 ID` +
        `（「${String(f.same_id_in_year_file?.title ?? '').slice(0, 60)}…」）→ 判定为复制残留，应从本年份剔除。`,
      evidence: { pdf_in_correct_year: f.pdf.in_correct_year },
    });
    idRemap.push({ file_year: f.file_year, from: f.id_as_recorded, to: null, evidence: 'stale_duplicate_of_other_year' });
  }
}

report.id_remap = idRemap;
writeFileSync(join(GOLD_ALL, '_reconcile.json'), JSON.stringify(report, null, 2), 'utf8');

// 控制台报告
for (const f of report.findings) {
  console.log('='.repeat(100));
  console.log(`文件 ${f.file_year} 中记录的 ID: ${f.id_as_recorded}   （年份应为 ${f.correct_year}）`);
  console.log(`  有文章级记录: ${f.has_article_level_row}   Sheet3 结局行: ${f.outcome_rows}`);
  console.log(`  标题: ${JSON.stringify(String(f.title ?? '').slice(0, 100))}`);
  if (f.same_title_in_same_file_other_sheet) {
    const c = f.same_title_in_same_file_other_sheet;
    console.log(`  ✓ 同文件内同标题条目: ${c.candidate_id}  (S1 lit=${c.literature_no_sheet1} / S2 lit=${c.literature_no_sheet2})`);
  }
  if (f.same_id_in_year_file) {
    const s = f.same_id_in_year_file;
    console.log(`  ⚠ ${s.year} 文件中同 ID 已存在，标题相同? ${s.same_title}`);
    console.log(`     该 ID 归属于: ${JSON.stringify(String(s.title ?? '').slice(0, 90))}`);
  } else {
    console.log(`  · ${f.correct_year} 文件中不存在同 ID`);
  }
  console.log(`  PDF: 记录年份[${f.pdf.in_recorded_year.join(', ') || '无'}]  正确年份[${f.pdf.in_correct_year.join(', ') || '无'}]`);
}
console.log('\n' + '#'.repeat(100));
console.log('建议：');
for (const r of report.recommendations) {
  console.log(`  [${r.action}] ${r.id}`);
  console.log(`      ${r.reason}`);
}
console.log(`\n写入: ${join(GOLD_ALL, '_reconcile.json')}`);
