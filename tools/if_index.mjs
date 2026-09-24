/**
 * 影响因子（2019）查表索引：`Datas/IF-SCI-2019.xlsx` → `build/if-2019.json`。
 *
 * 为什么改成查表：影响因子**论文里根本没有这个数**，让模型凭记忆答必然不可靠——
 * 实测 224 篇里 172 篇答错，而"答对"的 50 篇几乎都是双方都填 NR。
 * 用户已明确：影响因子从 Datas 的 IF-SCI-2019.xlsx 查。
 *
 * 纯解析/查表逻辑在 `tools/lib/if.mjs`（流水线共用同一份实现，避免两处口径漂移）。
 *
 * 用法：
 *   node tools/if_index.mjs              # 生成 build/if-2019.json
 *   node tools/if_index.mjs --measure    # 另外用金标准核对一次（会长这样：
 *                                        #   查得上且与金标准一致 / 不一致 / 金标准填 0 / 表里没有）
 *   node tools/if_index.mjs --gaps       # 只列"表里查不到"的期刊名（看是不是缩写或写错）
 */

import { readIfEntriesFromXlsx, buildIfLookup, normJournal } from './lib/if.mjs';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const XLSX = join(ROOT, 'Datas', 'IF-SCI-2019.xlsx');
const OUT = join(ROOT, 'build', 'if-2019.json');
const argv = process.argv.slice(2);
const measure = argv.includes('--measure') || argv.includes('--gaps');
const onlyGaps = argv.includes('--gaps');

if (!existsSync(XLSX)) {
  console.error(`缺少 ${XLSX}——影响因子只能从这张表查，请确认文件存在。`);
  process.exit(2);
}

const { sheet, entries } = readIfEntriesFromXlsx(XLSX);
const lookup = buildIfLookup(entries);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({
  at: new Date().toISOString(),
  source: 'Datas/IF-SCI-2019.xlsx',
  sheet,
  note: 'JCR 2019 SCIE 全刊影响因子；查表口径见 tools/lib/if.mjs（归一后精确相等，或令牌 Dice ≥ 0.9）',
  entries,
}, null, 1), 'utf8');
console.log(`影响因子索引：表《${sheet}》→ ${entries.length} 个期刊（含多分类去重）`);
console.log(`  → ${OUT.replace(ROOT + '\\', '')}`);

if (measure) {
  const YEARS = ['2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025'];
  const s = { total: 0, same: 0, diff: 0, goldZero: 0, notFound: 0, byHow: {} };
  const gaps = []; const diffs = [];
  for (const y of YEARS) {
    const gold = JSON.parse(readFileSync(join(ROOT, 'build', 'gold', `${y}.json`), 'utf8'));
    for (const ga of gold.articles ?? []) {
      const journal = String(ga.article?.journal?.raw ?? '').trim();
      const gif = String(ga.article?.impact_factor_2019?.raw ?? '').trim();
      s.total++;
      const hit = lookup(journal);
      if (!hit) { s.notFound++; if (!/^(0|NR|NA|NE)?$/i.test(gif)) gaps.push(`${ga.article_id}「${journal}」金标准 ${gif}`); continue; }
      s.byHow[hit.how] = (s.byHow[hit.how] ?? 0) + 1;
      if (!gif || /^(0|NR|NA|NE)$/i.test(gif)) { s.goldZero++; if (!onlyGaps) diffs.push(`${ga.article_id}「${journal}」表值 ${hit.jif}，金标准「${gif}」`); continue; }
      if (Math.abs(Number(hit.jif) - Number(gif)) < 0.001) s.same++;
      else { s.diff++; diffs.push(`${ga.article_id}「${journal}」表值 ${hit.jif}，金标准 ${gif}`); }
    }
  }
  if (onlyGaps) {
    console.log(`\n表里查不到的期刊（${gaps.length} 篇）——多半是缩写或写错了：`);
    for (const g of gaps.slice(0, 40)) console.log('   ', g);
  } else {
    console.log(`\n用金标准期刊名核对（11 年 ${s.total} 篇）：`);
    console.log(`  查到且与金标准一致：${s.same}｜查到但数值不同：${s.diff}｜金标准填 0/NR：${s.goldZero}｜表里查不到：${s.notFound}`);
    console.log(`  命中方式：${JSON.stringify(s.byHow)}`);
    console.log('\n  与金标准不一致的样例（表是权威口径，这些要作为"疑似金标准问题"记录）：');
    for (const d of diffs.slice(0, 12)) console.log('   ', d);
    if (gaps.length) { console.log(`\n  表里查不到的期刊（${gaps.length} 篇，前 12）：`); for (const g of gaps.slice(0, 12)) console.log('   ', g); }
  }
  void normJournal;
}
