/**
 * metadata（文章级字段）到底能到多少分：把"错"拆成"写法差异 / 编码映射错 / 真的读错 / 论文里没有"。
 * 判据都写在输出里，便于核对。
 */
import { readFileSync, existsSync } from 'node:fs';
import { normText, dice } from './lib/align.mjs';

const YEARS = ['2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025'];
/*
 * ⚠️ 驼峰转换必须处理**数字**：`funding_1` → `funding1`、`impact_factor_2019` → `impactFactor2019`。
 * 只替换 `_([a-z])` 时这两类键永远取不到值，会被误判成"机器没填"——
 * 实测因此把 funding_1/funding_2/impact_factor_2019 全算成 222 个漏填（假象）。
 */
const camel = (k) => k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
const NO_GOLD = new Set(['literature_no', 'extractor', 'eligibility_check', 'title_sheet2', 'row_id', 'article_id', 'study_id']);

/** 归一化到"只留字母数字"用于判断写法差异（去掉标点/空格/大小写）。 */
const tight = (s) => normText(s).replace(/[^\p{L}\p{N}]+/gu, '');

const perField = new Map();
const bump = (k, bucket, sample) => {
  const c = perField.get(k) ?? { n: 0, exact: 0, tightEqual: 0, near: 0, far: 0, missing: 0, samples: [] };
  c.n++; c[bucket]++;
  if (sample && c.samples.length < 3) c.samples.push(sample);
  perField.set(k, c);
};

for (const y of YEARS) {
  const gf = `build/gold/${y}.json`;
  if (!existsSync(gf)) continue;
  const gold = JSON.parse(readFileSync(gf, 'utf8'));
  for (const ga of gold.articles ?? []) {
    const pf = `build/extraction/${y}/${ga.article_id}.json`;
    if (!existsSync(pf)) continue;
    const pred = JSON.parse(readFileSync(pf, 'utf8'));
    for (const [k, gv] of Object.entries(ga.article ?? {})) {
      if (NO_GOLD.has(k)) continue;
      const g = String(gv?.raw ?? '').trim();
      if (!g) continue;
      const pv = pred.article?.[camel(k)] ?? pred.article?.[k];
      const p = String(pv?.raw ?? '').trim();
      const tag = `${ga.article_id} 金标准「${g.slice(0, 40)}」↔ 机器「${p.slice(0, 40)}」`;
      if (!p) { bump(k, 'missing', tag); continue; }
      if (normText(g) === normText(p)) { bump(k, 'exact'); continue; }
      if (tight(g) === tight(p)) { bump(k, 'tightEqual', tag); continue; }
      const d = dice(g, p);
      if (d >= 0.5) bump(k, 'near', `${tag}（相似 ${d.toFixed(2)}）`);
      else bump(k, 'far', tag);
    }
  }
}

const rows = [...perField.entries()].map(([k, c]) => ({ k, ...c }))
  .sort((a, b) => (b.far + b.near + b.tightEqual + b.missing) - (a.far + a.near + a.tightEqual + a.missing));
const tot = rows.reduce((a, r) => ({
  n: a.n + r.n, exact: a.exact + r.exact, tightEqual: a.tightEqual + r.tightEqual,
  near: a.near + r.near, far: a.far + r.far, missing: a.missing + r.missing,
}), { n: 0, exact: 0, tightEqual: 0, near: 0, far: 0, missing: 0 });

console.log('文章级字段逐项拆解（全 11 年）');
console.log('字段'.padEnd(24), '总数   逐字同  去标点同  写法近似  明显不同  机器没填');
for (const r of rows) {
  console.log(r.k.replace(/^article\./, '').padEnd(24),
    String(r.n).padStart(5), String(r.exact).padStart(7), String(r.tightEqual).padStart(9),
    String(r.near).padStart(9), String(r.far).padStart(9), String(r.missing).padStart(9));
}
console.log('─'.repeat(88));
console.log('合计'.padEnd(24),
  String(tot.n).padStart(5), String(tot.exact).padStart(7), String(tot.tightEqual).padStart(9),
  String(tot.near).padStart(9), String(tot.far).padStart(9), String(tot.missing).padStart(9));

const ok = tot.exact + tot.tightEqual;
console.log(`\n严格口径（逐字）：${(tot.exact / tot.n * 100).toFixed(1)}%`);
console.log(`去标点/大小写后相同：${((tot.exact + tot.tightEqual) / tot.n * 100).toFixed(1)}%（+${tot.tightEqual} 个字段只是标点/大小写差异）`);
console.log(`再把"写法近似"算作含义一致：${((ok + tot.near) / tot.n * 100).toFixed(1)}%（+${tot.near}）`);

console.log('\n"写法近似"的样例（现在都算错）：');
for (const r of rows) for (const s of r.samples.filter((x) => x.includes('相似')).slice(0, 1)) console.log(`  ${r.k}: ${s}`);
