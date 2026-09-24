/**
 * 设计"去 LaTeX 化"规则前的形态调研：`<eq>` 里到底长什么样？
 * 重点回答一个风险问题：把"数字 空格 数字"粘起来，会不会把**两个独立数字**误并成一个？
 * 输出：build/latex_shapes.json（含全部 distinct 形态与样例）
 * 用法：node tools/latex_shapes.mjs
 */

import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const YEARS = ['2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025'];

const eqs = [];
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
    for (const page of mid.pdf_info ?? []) {
      const walk = (blocks) => {
        for (const b of blocks ?? []) {
          for (const l of b.lines ?? []) for (const s of l.spans ?? []) {
            const html = String(s.html ?? '');
            if (html) for (const m of html.match(/<eq>[\s\S]*?<\/eq>/g) ?? []) eqs.push({ id, eq: m.slice(4, -5) });
          }
          if (b.blocks) walk(b.blocks);
        }
      };
      walk(page.para_blocks);
      walk(page.discarded_blocks);
    }
  }
}

/* 形态归类：把内容抽象成"骨架"（数字→#, 字母→a, 反斜杠命令→\c, 其余符号保留） */
const skeleton = (s) => s
  .replace(/\\[a-zA-Z]+/g, '\\c')
  .replace(/\d+/g, '#')
  .replace(/[a-zA-Z]+/g, 'a')
  .replace(/\s+/g, ' ')
  .trim();

const byShape = new Map();
for (const e of eqs) {
  const k = skeleton(e.eq);
  if (!byShape.has(k)) byShape.set(k, []);
  byShape.get(k).push(e);
}

/** 只有符号差异的（去掉 # 与空白后为空）→ 纯数字片段 */
const isPureNumberish = (k) => k.replace(/[#\s.+\-−–—/±,:%()[\]{}^_=<>≤≥×÷·~]/g, '') === '';

const shapes = [...byShape.entries()].sort((a, b) => b[1].length - a[1].length);
console.log(`\n══ <eq> 形态调研：共 ${eqs.length} 个片段，${shapes.length} 种骨架 ══\n`);
console.log('  Top 30 骨架：');
for (const [k, v] of shapes.slice(0, 30)) {
  console.log(`   ${String(v.length).padStart(5)}× ${isPureNumberish(k) ? '［纯数字］' : '        '} ${k.slice(0, 60)}`);
  console.log(`           例：${v[0].eq.replace(/\s+/g, ' ').slice(0, 90)}`);
}

/* 纯数字骨架里，含 >=2 组数字的（这些是"误并风险"最高的） */
const risky = new Map();
for (const [k, v] of shapes) {
  if (!isPureNumberish(k)) continue;
  const groups = k.split(' ').filter((x) => x.includes('#'));
  if (groups.length < 2) continue;
  risky.set(k, v);
}
console.log(`\n  ⚠ 纯数字骨架中含 ≥2 组数字的骨架：${risky.size} 种（误并风险）`);
for (const [k, v] of [...risky].sort((a, b) => b[1].length - a[1].length).slice(0, 15)) {
  console.log(`   ${String(v.length).padStart(5)}× ${k.slice(0, 40)}｜例：${v[0].eq.replace(/\s+/g, ' ').slice(0, 70)}`);
}

/* 含 LaTeX 命令的骨架（需要做命令→符号映射） */
const cmds = new Map();
for (const e of eqs) {
  for (const c of e.eq.match(/\\[a-zA-Z]+/g) ?? []) cmds.set(c, (cmds.get(c) ?? 0) + 1);
}
console.log(`\n  LaTeX 命令频次（Top 40）：`);
for (const [c, n] of [...cmds].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(`   ${String(n).padStart(5)}× ${c}`);

/* 数字被空格拆散、且"拆散段"总位数分布 —— 判断合并后位数是否离谱 */
const joinLen = new Map();
for (const e of eqs) {
  const t = e.eq;
  const re = /\d(?:\s+\d)+/g;
  let m;
  while ((m = re.exec(t)) !== null) {
    const joined = m[0].replace(/\s+/g, '');
    joinLen.set(joined.length, (joinLen.get(joined.length) ?? 0) + 1);
  }
}
console.log(`\n  粘合后数字位数分布：`);
for (const [len, n] of [...joinLen].sort((a, b) => a[0] - b[0])) console.log(`   ${String(len).padStart(3)} 位：${n}`);

writeFileSync(join(ROOT, 'build', 'latex_shapes.json'), JSON.stringify({
  total: eqs.length,
  shapes: shapes.map(([k, v]) => ({ skeleton: k, count: v.length, sample: v[0].eq.slice(0, 200), sampleId: v[0].id })),
  riskyShapes: [...risky].map(([k, v]) => ({ skeleton: k, count: v.length, sample: v[0].eq.slice(0, 200) })),
  commands: [...cmds].map(([c, n]) => ({ cmd: c, count: n })),
  joinLengths: [...joinLen].map(([len, n]) => ({ len, count: n })),
}, null, 1), 'utf8');
console.log(`\n明细 build/latex_shapes.json\n`);
