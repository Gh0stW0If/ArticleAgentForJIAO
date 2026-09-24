/**
 * Europe PMC 用作 `author_contact` 补充信源的**条件效力**分析。
 *
 * 上一版分组把"EPMC 没有邮箱"的篇也算进了"冲突"桶，结论失真。这里严格按条件分：
 * 只在 **EPMC 确实给出邮箱**的篇里，看"抽到的邮箱是否命中 EPMC 列表"与正确率的关系。
 *
 * 用法：node tools/_europepmc_effect.mjs
 */

import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERDICT_WEIGHT } from './lib/judge.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const j = JSON.parse(readFileSync(join(ROOT, 'build', 'europepmc_sizing.json'), 'utf8'));
const EMAIL_RE = /[A-Za-z0-9._%+-]+\s*@\s*[A-Za-z0-9-]+(?:\s*\.\s*[A-Za-z0-9-]+)+/g;
const toks = (s) => [...new Set((String(s ?? '').match(EMAIL_RE) ?? []).map((e) => e.replace(/\s+/g, '').toLowerCase()))];
const W = VERDICT_WEIGHT;
const rows = j.rows.filter((r) => r.status === 'ok' && r.verdict);
const pc = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');
const score = (rs) => ({ n: rs.length, w: rs.reduce((a, r) => a + (W[r.verdict] ?? 0), 0), full: rs.filter((r) => (W[r.verdict] ?? 0) === 1).length });

const report = (label, rs) => {
  if (!rs.length) return;
  const s = score(rs);
  console.log(`  ${label.padEnd(38)}${String(s.n).padStart(4)} 篇   加权 ${pc(s.w, s.n).padStart(7)}   满分 ${pc(s.full, s.n).padStart(7)}`);
};

const withEmail = rows.filter((r) => r.epmcCount > 0);
const noEmail = rows.filter((r) => r.epmcCount === 0);

console.log(`\n══ Europe PMC 条件效力分析（${rows.length} 篇有判定）══\n`);
console.log(`【基线】全部：${rows.length} 篇，加权 ${pc(score(rows).w, rows.length)}\n`);

console.log(`【A】EPMC **有**邮箱的 ${withEmail.length} 篇（加权 ${pc(score(withEmail).w, withEmail.length)}）`);
const hitA = withEmail.filter((r) => { const p = toks(r.predContact); return p.length && p.some((e) => r.epmc.includes(e)); });
const missA = withEmail.filter((r) => { const p = toks(r.predContact); return p.length && !p.some((e) => r.epmc.includes(e)); });
const noneA = withEmail.filter((r) => toks(r.predContact).length === 0);
report('A1 抽到邮箱 且 命中 EPMC 列表', hitA);
report('A2 抽到邮箱 但 不在 EPMC 列表里', missA);
report('A3 没抽到邮箱（NR）', noneA);

console.log(`\n【B】EPMC **恰好一个**邮箱的 ${withEmail.filter((r) => r.epmcCount === 1).length} 篇`);
const one = withEmail.filter((r) => r.epmcCount === 1);
report('B1 抽到的就是那一个', one.filter((r) => toks(r.predContact).includes(r.epmc[0])));
report('B2 抽到了别的邮箱', one.filter((r) => { const p = toks(r.predContact); return p.length && !p.includes(r.epmc[0]); }));
report('B3 没抽到（NR）', one.filter((r) => toks(r.predContact).length === 0));
const goldInOne = one.filter((r) => r.goldEmails.includes(r.epmc[0]));
console.log(`     └ 这"唯一一个"就是金标准邮箱的：${goldInOne.length}/${one.length}（${pc(goldInOne.length, one.length)}）`
  + ` → **"唯一即采用"不可用**，会引入 ${one.length - goldInOne.length} 个错误`);

console.log(`\n【C】EPMC **没有**邮箱的 ${noEmail.length} 篇 → 该信源对此类无贡献（加权 ${pc(score(noEmail).w, noEmail.length)}）`);

/* 最有价值的用法：把"抽到的邮箱不在 EPMC 列表里"当作**可疑信号** */
console.log('\n【D】可疑信号检验：抽到邮箱但不在 EPMC 列表里（EPMC 有邮箱时）');
const suspicious = missA;
const actualWrong = suspicious.filter((r) => (W[r.verdict] ?? 0) < 1);
console.log(`  ${suspicious.length} 篇被判"可疑"，其中当前确实没拿满分：${actualWrong.length}（精确率 ${pc(actualWrong.length, suspicious.length)}）`);
console.log(`  误报（其实是对的却标可疑）：${suspicious.length - actualWrong.length}`);
for (const r of suspicious.slice(0, 10)) {
  console.log(`   ${r.id}  ${r.verdict}  抽到 ${toks(r.predContact).slice(0, 2).join(',')} ｜ EPMC ${r.epmc.slice(0, 3).join(',')}${r.epmc.length > 3 ? ' …' : ''}`);
}

console.log('\n【E】互补检验：抽到的邮箱命中 EPMC 列表 → 能否作为"高置信"标记？');
const hitWrong = hitA.filter((r) => (W[r.verdict] ?? 0) < 1);
console.log(`  命中 EPMC 的 ${hitA.length} 篇里，当前没拿满分的 ${hitWrong.length}（${pc(hitWrong.length, hitA.length)}）`
  + ` → 命中不足以证明"选对了作者"（EPMC 会把**每位作者**的邮箱都列出来）`);
