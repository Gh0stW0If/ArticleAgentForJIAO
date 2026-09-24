/**
 * 复核「值未在论文中出现（疑似错误金标准）」这类发现的可信度。
 *
 * 为什么需要这一步
 * ----------------
 * `tools/gold_vs_paper.mjs` 的判据是"数值的字面形态能不能在论文文本里逐字找到"。
 * 这个判据**偏严**：论文里写 `week 24`、`24-week`、`2 4`（排版断字）、
 * `12,5`（逗号小数点）、Unicode 减号 `−`、上下标拆开，都会判成"找不到"。
 * 而这类发现会直接进 `llm_eval` 的排除表——**排除错了等于把该扣的分抹掉，准确率虚高**。
 *
 * 所以本工具对每条发现做一次"宽容复核"，给出三档结论：
 *   · `found`  —— 放宽写法后能在论文里找到（原判据误报：排版/写法差异）；
 *   · `weak`   —— 逐位数字能在论文里找到，但上下文对不上（形态可疑，需人工看）；
 *   · `strong` —— 连逐位数字都找不到（很可能真是金标准错，可安全排除）。
 *
 * 用法：
 *   node tools/gold_evidence_check.mjs               # 全部年份
 *   node tools/gold_evidence_check.mjs --year 2024
 * 输出：build/gold_evidence_check.json（含每年三档计数与逐条明细）
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const onlyYear = argv.includes('--year') ? argv[argv.indexOf('--year') + 1] : null;

const REASON = '值未在论文中出现（疑似错误金标准）';
const anomaliesFile = join(ROOT, 'build', 'gold_anomalies.json');
if (!existsSync(anomaliesFile)) {
  console.error('缺少 build/gold_anomalies.json，请先跑 node tools/gold_vs_paper.mjs');
  process.exit(2);
}
const anomalies = JSON.parse(readFileSync(anomaliesFile, 'utf8')).anomalies ?? [];
const targets = anomalies.filter((a) => a.reason === REASON).filter((a) => !onlyYear || String(a.year) === onlyYear);

/* ------------------------------ 论文文本（按篇缓存） ------------------------------ */

/**
 * 论文全文：优先用 MinerU 的 markdown（表格以 HTML 形式内嵌，数值都在里面）。
 * 归一化：全角数字/标点转半角、Unicode 减号统一、去空白、小写。
 */
const textCache = new Map();
function paperTexts(year, articleId) {
  const key = `${year}/${articleId}`;
  if (textCache.has(key)) return textCache.get(key);
  const md = join(ROOT, 'build', 'mineru', String(year), articleId, 'txt', `${articleId}.md`);
  let raw = '';
  if (existsSync(md)) raw = readFileSync(md, 'utf8');
  const norm = raw
    .replace(/[\uFF10-\uFF19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))   // 全角数字
    .replace(/[\u2212\u2013\u2014\u2015]/g, '-')                                          // − – — ―
    .replace(/[\u00A0\u2007\u202F]/g, ' ')                                                // 不换行空格
    .toLowerCase();
  const flat = norm.replace(/\s+/g, ' ');
  const out = { flat, digits: flat.replace(/\D+/g, '') };
  textCache.set(key, out);
  return out;
}

/* ------------------------------ 判据 ------------------------------ */

/** 数字的几种可能写法：原样、去小数点、逗号小数点、去掉千分位。 */
function digitVariants(num) {
  const s = String(num).trim();
  const v = new Set([s]);
  v.add(s.replace(/\./g, ''));           // 46.67 → 4667（排版把小数点吃掉/OCR 漏点）
  v.add(s.replace(/\./g, ','));          // 欧式逗号小数点
  v.add(s.replace(/,/g, ''));            // 千分位
  if (s.includes('.')) {
    const [i, f] = s.split('.');
    v.add(`${i}${f}`);                   // 去小数点拼接
    v.add(`${i} ${f}`);                  // 排版断成 "46 . 67" → 去标点后就是 46 67
  }
  return [...v].filter((x) => x && x !== '.');
}

const UNIT_STEM = {
  week: 'week', wk: 'week', month: 'month', mo: 'month', year: 'year', yr: 'year',
  day: 'day', hour: 'hour', hr: 'hour', minute: 'minute', min: 'minute',
  周: '周', 个月: '月', 月: '月', 年: '年', 天: '天', 小时: '小时', 分钟: '分钟',
};
const NUM_UNIT_RE = /^(\d+(?:[.,]\d+)?)\s*(weeks?|wks?|months?|mos?|years?|yrs?|days?|hours?|hrs?|minutes?|mins?|周|个月|月|年|天|小时|分钟)$/i;

/**
 * 复核一条发现。
 * 返回 { verdict, hint }：verdict ∈ found | weak | strong。
 */
function recheck(finding) {
  const { year, articleId } = finding;
  const value = String(finding.value).trim();
  if (!existsSync(join(ROOT, 'build', 'mineru', String(year), articleId, 'txt'))) {
    return { verdict: 'unknown', hint: '该篇没有解析产物，无法复核' };
  }
  const { flat, digits } = paperTexts(year, articleId);

  const m = NUM_UNIT_RE.exec(value);
  if (m) {
    const [, num, unitRaw] = m;
    const stem = UNIT_STEM[unitRaw.toLowerCase().replace(/s$/, '')] ?? unitRaw.toLowerCase();
    for (const v of digitVariants(num)) {
      // 数字与单位在 60 字符窗口内同时出现即算找到（"24 weeks" / "week 24" / "24-week"）
      let idx = flat.indexOf(v);
      while (idx >= 0) {
        const win = flat.slice(Math.max(0, idx - 60), idx + 60);
        if (win.includes(stem)) return { verdict: 'found', hint: `数字「${v}」与单位「${stem}」在文中同现` };
        idx = flat.indexOf(v, idx + 1);
      }
    }
  }

  // 纯数值：先看原样/变体，再看逐位数字
  const variants = digitVariants(value).filter((v) => /^[\d.,\s-]+$/.test(v));
  for (const v of variants) {
    if (v && flat.includes(v)) return { verdict: 'found', hint: `文中出现「${v}」` };
  }
  const digitsOnly = value.replace(/\D+/g, '');
  if (digitsOnly.length >= 3 && digits.includes(digitsOnly)) {
    return { verdict: 'weak', hint: `逐位数字 ${digitsOnly} 在文中出现，但原写法未找到` };
  }
  if (digitsOnly.length > 0 && digitsOnly.length < 3 && digits.includes(digitsOnly)) {
    return { verdict: 'weak', hint: '短数字，逐位匹配不足以判断' };
  }
  return { verdict: 'strong', hint: '连逐位数字都找不到' };
}

/* ------------------------------ 主循环 ------------------------------ */

const items = [];
const byYear = new Map();
for (const f of targets) {
  const { verdict, hint } = recheck(f);
  items.push({ ...f, verdict, hint });
  const k = String(f.year);
  const cur = byYear.get(k) ?? { total: 0, found: 0, weak: 0, strong: 0, unknown: 0 };
  cur.total += 1;
  cur[verdict] = (cur[verdict] ?? 0) + 1;
  byYear.set(k, cur);
}

const total = { total: 0, found: 0, weak: 0, strong: 0, unknown: 0 };
for (const v of byYear.values()) for (const k of Object.keys(total)) total[k] += v[k] ?? 0;

const out = join(ROOT, 'build', 'gold_evidence_check.json');
const payload = {
  at: new Date().toISOString(),
  note: '对「值未在论文中出现」这类发现做宽容复核；只有 strong 才适合作为评分排除项',
  total,
  byYear: Object.fromEntries([...byYear.entries()].sort()),
  items,
};
writeFileSync(out, JSON.stringify(payload, null, 2), 'utf8');

console.log(`\n金标准"值不在论文里"复核（${onlyYear ?? '全部年份'}）`);
console.log(`  合计 ${total.total} 条：可在文中找到 ${total.found} / 疑似写法差异 ${total.weak} / 确实找不到 ${total.strong}${total.unknown ? ` / 无法复核 ${total.unknown}` : ''}`);
console.log('\n  年份   合计   文中找到   写法可疑   找不到');
for (const [y, v] of [...byYear.entries()].sort()) {
  console.log(`  ${y}   ${String(v.total).padStart(4)}   ${String(v.found).padStart(6)}   ${String(v.weak).padStart(6)}   ${String(v.strong).padStart(5)}`);
}
console.log(`\n  明细已写入 ${out.replace(ROOT, '.')}\n`);
