/**
 * 现状盘点：现有评测产物里，**哪些是今天的新管线、哪些是旧管线**？
 *
 * 为什么要查：今天改了 5 处（LaTeX 清洗、提示词 4b、邮箱定点补料、Europe PMC、单位三列规则），
 * 又修正了金标准。这些改动只在小批文章上跑过 A/B，**全量产物并没有重跑**。
 * 直接拿 build/eval/*.json 汇总会得到一个"混合口径"的数字，必须先说清成分。
 *
 * 用法：node tools/_pipeline_freshness.mjs
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const YEARS = ['2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025'];

/** 今天的起点：以 LaTeX 清洗那次重建（约 20:33）为界；用"当天"判断足够。 */
const TODAY = new Date().toDateString();

let totArt = 0; let freshArt = 0;
console.log('\n年份   篇数   今天重跑   最近一次跑的时间');
for (const y of YEARS) {
  const d = join(ROOT, 'build', 'extraction', y);
  if (!existsSync(d)) continue;
  const files = readdirSync(d).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
  let fresh = 0; let newest = 0;
  for (const f of files) {
    const m = statSync(join(d, f)).mtime;
    if (m.getTime() > newest) newest = m.getTime();
    if (m.toDateString() === TODAY) fresh++;
  }
  totArt += files.length; freshArt += fresh;
  console.log(`  ${y}   ${String(files.length).padStart(4)}   ${String(fresh).padStart(6)}     ${new Date(newest).toLocaleString('zh-CN')}`);
}

console.log(`\n  合计 ${totArt} 篇，其中**今天重跑的 ${freshArt} 篇（${((freshArt / totArt) * 100).toFixed(0)}%）**`);

console.log('\n── build/eval/*.json 的时间与口径 ──');
for (const y of YEARS) {
  const f = join(ROOT, 'build', 'eval', `${y}.json`);
  if (!existsSync(f)) continue;
  const m = statSync(f).mtime;
  let s = '';
  try {
    const rep = JSON.parse(readFileSync(f, 'utf8'));
    const s1 = rep.sheets?.sheet1;
    const s3 = rep.sheets?.sheet3;
    /* 判断是否含"Sheet1 的描述性语义条目"：修好分组后 sheet1.judged 非空 */
    const fixed = (s1?.judged ?? []).length > 0;
    s = `Sheet1 den=${s1?.den} judged=${(s1?.judged ?? []).length}｜Sheet3 judged=${(s3?.judged ?? []).length}｜分组${fixed ? '已修' : '**未修**（Sheet1 描述字段被并进 Sheet3）'}`;
  } catch { s = '（读取失败）'; }
  console.log(`  ${y}  ${m.toLocaleString('zh-CN')}  ${s}`);
}

console.log('\n── 今天改了什么（都没全量重跑）──');
for (const [k, v] of [
  ['LaTeX 清洗（deLatex）', '材料层的数字不再被切成 4 1 . 7 5'],
  ['提示词规则 4b（数值归一化 + 证据留原文）', '7 份提示词'],
  ['邮箱定点补料 + 确定性兜底', 'article-meta'],
  ['Europe PMC 第二信源（题名补全）', 'article-meta 步骤 6b'],
  ['comparison 提示词：带单位三列规则', '单位表 + 示例 + 防硬凑'],
  ['**金标准修正**（三组单位三列）', '274 处；只有 2015 按新金标准重跑过评测'],
]) console.log(`  · ${k}：${v}`);
