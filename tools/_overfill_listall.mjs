/**
 * 把"金标准全空、模型却填了值"的**全部**案例摊开（含模型给出的证据原文），供人工判断性质。
 *
 * 为什么需要人工看：自动分类器不可靠——实测它把 `3 months post-treatment`（数就在证据里）
 * 判成了"quote 定位不到"。这类判断只能摊开看。
 *
 * 用法：node tools/_overfill_listall.mjs
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const YEARS = ['2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025'];
const raw = (o) => (o && typeof o === 'object' && 'raw' in o ? String(o.raw ?? '') : '');
const codeOf = (o) => (o && typeof o === 'object' && 'code' in o && o.code ? String(o.code) : '');
const isSent = (s) => /^\s*(NR|NA|NE)[.。]?\s*$/i.test(String(s ?? '')) || String(s ?? '').trim() === '';
const CAMEL = (k) => k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
const GROUPS = [['最长随访', 'max_followup'], ['治疗频次', 'frequency'], ['留针时间', 'needle_retention'], ['疗程', 'course']];

let n = 0;
const lines = [];
for (const y of YEARS) {
  const gf = join(ROOT, 'build', 'gold', `${y}.json`);
  if (!existsSync(gf)) continue;
  const gold = JSON.parse(readFileSync(gf, 'utf8'));
  for (const a of gold.articles ?? []) {
    const pf = join(ROOT, 'build', 'extraction', y, `${a.article_id}.json`);
    if (!existsSync(pf)) continue;
    let pred;
    try { pred = JSON.parse(readFileSync(pf, 'utf8')); } catch { continue; }
    const gcs = a.comparisons ?? []; const pcs = pred.comparisons ?? [];
    for (let i = 0; i < gcs.length; i++) {
      const pc = pcs[i];
      if (!pc) continue;
      for (const [zh, pre] of GROUPS) {
        const gd = raw(gcs[i][`${pre}_desc`]); const gv = raw(gcs[i][`${pre}_value`]); const gu = codeOf(gcs[i][`${pre}_unit`]);
        const pv = raw(pc[CAMEL(`${pre}_value`)]); const pu = codeOf(pc[CAMEL(`${pre}_unit`)]);
        if (!(isSent(gd) && isSent(gv) && !gu)) continue;
        if (isSent(pv) && !pu) continue;
        const leaf = pc[CAMEL(`${pre}_value`)] ?? pc[CAMEL(`${pre}_unit`)] ?? pc[CAMEL(`${pre}_desc`)];
        const q = String((leaf?.evidence ?? [])[0]?.quote ?? '');
        n++;
        lines.push(`${String(n).padStart(2)}. ${y} ${a.article_id}#${i + 1} [${zh}]`);
        lines.push(`    模型: desc=${JSON.stringify(raw(pc[CAMEL(`${pre}_desc`)]))} value=${JSON.stringify(pv)} unit=${JSON.stringify(pu)}`);
        lines.push(`    证据: ${JSON.stringify(q.slice(0, 150))}`);
      }
    }
  }
}
lines.unshift(`共 ${n} 例："金标准 desc/value/unit 全空，模型却填了值"`, '');
/*
 * ⚠️ 由工具**自己写文件**，不要靠 PowerShell 重定向——`> x.log` 会写成 UTF-16LE，
 * 后续 `readFileSync(...,'utf8')` 读出来全是乱码/匹配不上（实测踩过两次）。
 */
writeFileSync(join(ROOT, 'build', '_overfill_all.log'), lines.join('\n'), 'utf8');
console.log(lines.slice(0, 30).join('\n'));
console.log(`\n（共 ${n} 例，已写入 build/_overfill_all.log）`);
