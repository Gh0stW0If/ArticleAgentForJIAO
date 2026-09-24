/**
 * 金标准修正：三组"带单位"字段的 **desc / value / unit 三列对齐**（只改 `build/gold/*.json`）。
 *
 * ── 用户口径 ──────────────────────────────────────────────
 * 1. **单位编码以表头要求为准**（`最长随访时间单位`：`1=天 2=月 3=年 4=周 5=小时`）。
 *    不改 `Datas/` 原始表格（只读），只改 json 版 gold。
 * 2. **desc 保留原文，但格式归一化**：`30 min` / `30 minutes` 统一成"数字 + 单位全拼"（`30 minutes`）。
 *    无法用数值表示的（`post-gastroscopy`、`until delivery`）保持原样。
 * 3. **归一化后，value / unit 由 desc 用代码约束提取，不交给 LLM。**
 * 4. 其他金标准问题**先不处理**。
 *
 * ── 安全边界（宁可不改，不可改错）────────────────────────────
 * 只处理**简单量**：`<数>[<单位>]` + 可选的非数字尾注（`12 months (pregnancy outcome)`）。
 * 出现下列任一情形一律**跳过并列入报告**（人工复核）：
 *   · desc 里**不止一个数字**（`2-5s/ maximum 30 s each`、`5 days per week for 2 weeks`）
 *   · 数字带范围（`15-20`）
 *   · 无法解析出单位且该字段没有"表头缺省单位"（见各组的 `defaultUnit`）
 *   · 纯文字描述 / 哨兵值（哨兵值只做三列对齐，不改文字）
 *
 * 用法：
 *   node tools/gold_fix_units.mjs            # 干跑：只报告会改什么
 *   node tools/gold_fix_units.mjs --apply    # 落盘（先自动备份到 build/_backup_gold_pre_units/）
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APPLY = process.argv.includes('--apply');
const YEARS = ['2015','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025'];
const BACKUP = join(ROOT, 'build', '_backup_gold_pre_units');

/* ------------------------------ 词表 ------------------------------ */

/** 内部时间单位（与 SECONDS 一致）。 */
const SECONDS = { 秒: 1, 分钟: 60, 小时: 3600, 天: 86400, 周: 7 * 86400, 月: 4 * 7 * 86400, 年: 12 * 4 * 7 * 86400 };

/** 单位词（中英、缩写）→ 内部单位。 */
const UNIT_WORDS = [
  [/^(s|sec|secs|second|seconds|秒)$/i, '秒'],
  [/^(m|min|mins|minute|minutes|分钟|分)$/i, '分钟'],
  [/^(h|hr|hrs|hour|hours|小时|時|时)$/i, '小时'],
  [/^(d|day|days|天|日)$/i, '天'],
  [/^(w|wk|wks|week|weeks|周|星期)$/i, '周'],
  [/^(mo|mon|month|months|月)$/i, '月'],
  [/^(y|yr|yrs|year|years|年)$/i, '年'],
];
/** 内部单位 → 英文全拼（用户要求"数字+单位全拼"）。 */
const FULL_EN = { 秒: 'second', 分钟: 'minute', 小时: 'hour', 天: 'day', 周: 'week', 月: 'month', 年: 'year' };

/**
 * 三组字段的定义。
 * `codes` = 表头图例（权威）；`defaultUnit` = desc 只有数字时的缺省单位
 * （表头写死了单位的字段才有，如"留针时间 (单位：分钟, min)"）。
 */
const GROUPS = [
  {
    zh: '最长随访时间',
    desc: 'max_followup_desc', value: 'max_followup_value', unit: 'max_followup_unit',
    codes: { 1: '天', 2: '月', 3: '年', 4: '周', 5: '小时' },
    defaultUnit: null,
  },
  {
    zh: '治疗频次',
    desc: 'frequency_desc', value: 'frequency_value', unit: 'frequency_unit',
    codes: { 1: '天', 2: '周', 3: '1小时' },
    defaultUnit: null,
    frequency: true,
  },
  {
    zh: '留针时间',
    desc: 'needle_retention_desc', value: 'needle_retention_value', unit: 'needle_retention_unit',
    codes: { 1: '分钟', 2: '小时' },
    /* 表头写明"单位：分钟" → desc 只有数字时按分钟 */
    defaultUnit: '分钟',
  },
];

/* ------------------------------ 解析 ------------------------------ */

const SENT = /^\s*(NR|NA|NE)[.。]?\s*$/i;
const countNumbers = (s) => (String(s).match(/\d+(?:\.\d+)?/g) ?? []).length;

/** 英文/中文数词。 */
const WORD_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, once: 1, twice: 2, thrice: 3 };

/**
 * 解析 desc → { numText, num, unit, rest } 或 null（null = 不处理）。
 * 只在"简单量"上返回结果；复杂写法一律 null。
 */
function parseDesc(desc, group) {
  const t = String(desc ?? '').trim();
  if (!t) return null;

  if (group.frequency) return parseFrequency(t);

  /* <数> <单位> [尾注] —— 尾注里一般不能有数字，但**尾随括号**除外：
     `24 weeks (6 months)`、`4 weeks post-treatment (week 16)` 这类括号是对同一时点的补充说明，
     前导量仍然唯一确定。 */
  const m = /^(\d+(?:\.\d+)?)\s*([A-Za-z\u4e00-\u9fa5]+)?/.exec(t);
  if (m && m[1]) {
    const rest = t.slice(m[0].length);
    /* 判断尾注是否"还含别的量"时先**剥掉括号内容**：
       `24 weeks (6 months)`、`4 weeks post-treatment (week 16)`、`3 months after (3rd month)`
       里的括号都是对同一时点的补充说明，前导量仍唯一确定；
       而括号外还有第二个量的（`5 days per week for 2 weeks`）仍跳过。 */
    const restNoParen = rest.replace(/\([^()]*\)/g, '');
    if (countNumbers(restNoParen) > 0) return null;            // 括号外还有数字 → 复杂写法，跳过
    /*
     * ⚠️ **"每穴 X"必须跳过**：`2 min per point (6 points total)` 的 2 是**每穴**留针时间，
     * 总时长是 2×6=12（金标准填的正是 12）。按前导数字归一化会把 12 改成 2 —— 改错。
     * 实测 2024-01 / 2024-16 就是这种。凡出现 per/each + point/leg/site 一律交人工。
     */
    if (/\b(per|each)\s+(point|acupoint|site|leg|needle)/i.test(t)) return null;
    if (/\d+\s*(points?|acupoints?|sites?|legs?|needles?)\b/i.test(t)) return null;
    if (/\d\s*[-–~]\s*\d/.test(t)) return null;                // 范围 → 跳过
    const num = Number(m[1]);
    let unit = null;
    if (m[2]) { for (const [re, u] of UNIT_WORDS) if (re.test(m[2])) { unit = u; break; } }
    if (!unit) unit = group.defaultUnit ?? null;              // 表头缺省单位
    if (!unit) return null;                                   // 解析不出单位且无缺省 → 跳过
    return { numText: m[1], num, unit, rest };
  }
  return null;
}

/** 治疗频次的专门解析：`3 times per week` / `once a day` / `5 days per week` / `twice weekly`。 */
function parseFrequency(t) {
  if (countNumbers(t) > 1) return null;                       // `5 days per week for 2 weeks` → 跳过
  const period = '(day|days|week|weeks|month|months|hour|hours|天|日|周|星期|月|小时)';
  const per = new RegExp(`^(\\d+(?:\\.\\d+)?)\\s*(?:times?|sessions?|treatments?|days?)?\\s*(?:per|a|each|/|every)\\s*${period}\\s*$`, 'i');
  const bare = new RegExp(`^(\\d+(?:\\.\\d+)?)\\s*(?:times?|sessions?|treatments?)?\\s*${period}ly\\s*$`, 'i');
  const word = new RegExp(`^(once|twice|thrice|one|two|three|four|five|six|seven|eight|nine|ten)\\s*(?:times?)?\\s*(?:per|a|each|/|every)?\\s*${period}(?:ly)?\\s*$`, 'i');
  const unitOfPeriod = (w) => { for (const [re, u] of UNIT_WORDS) if (re.test(w)) return u; return null; };

  let mm = per.exec(t);
  if (mm) { const u = unitOfPeriod(mm[2]); if (u) return { numText: mm[1], num: Number(mm[1]), unit: u, rest: '', freq: true }; }
  mm = bare.exec(t);
  if (mm) { const u = unitOfPeriod(mm[2]); if (u) return { numText: mm[1], num: Number(mm[1]), unit: u, rest: '', freq: true }; }
  mm = word.exec(t);
  if (mm) { const u = unitOfPeriod(mm[2]); if (u) return { numText: String(WORD_NUM[mm[1].toLowerCase()]), num: WORD_NUM[mm[1].toLowerCase()], unit: u, rest: '', freq: true }; }
  return null;
}

/* ------------------------------ 归一化与派生 ------------------------------ */

/** 把数值格式化成简洁写法：整数不带小数点，其余最多 3 位小数。 */
const fmt = (n) => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3))));

/** 单位全拼（单复数按数值是否为 1）。 */
const unitEn = (unit, num) => (num === 1 ? FULL_EN[unit] : `${FULL_EN[unit]}s`);

/** 把"数 + 内部单位"换算到目标单位。 */
const convert = (num, from, to) => (num * SECONDS[from]) / SECONDS[to];

/**
 * 选目标单位与数值：**优先用 desc 自己的单位**（若在编码表里）。
 *
 * 不在表里时**只在能整除的情况下**换算——
 * 否则会出现 `30 minutes` → `0.5`（小时）这种"等价但很不自然"的写法。
 * 除不尽就返回 null，交给人工（列入跳过报告）。
 */
function toCode(group, unit, num) {
  const entry = Object.entries(group.codes).find(([, zh]) => zh === unit);
  if (entry) return { code: entry[0], value: num, approx: false };
  const candidates = Object.entries(group.codes)
    .map(([c, zh]) => ({ c, zh, v: convert(num, unit, zh) }))
    .filter((x) => Number.isFinite(x.v));
  /* 优先整数结果；多个整数时取**最大**单位（更简洁，如 120 分钟 → 2 小时） */
  const ints = candidates.filter((x) => Math.abs(x.v - Math.round(x.v)) < 1e-9);
  if (ints.length) {
    const pick = ints.sort((a, b) => SECONDS[b.zh] - SECONDS[a.zh])[0];
    return { code: pick.c, value: pick.v, approx: false };
  }
  /*
   * 没有整数解（实测只有"最长随访 + 分钟"这一种：`30 minutes after HSG`）：
   * 取**数值最接近 1** 的编码单位（=`小时`），并标 `approx` 供人工复核。
   * 之所以不退化成"保持原样"：原做法会把 `分钟` 硬塞进只认天/月/年/周/小时的编码列
   * （实测有 `unit="minutes"`、`unit="分钟"` 这种非法值），那更糟。
   */
  const pick = candidates.sort((a, b) => Math.abs(Math.log(a.v)) - Math.abs(Math.log(b.v)))[0];
  return pick ? { code: pick.c, value: pick.v, approx: true } : null;
}

/** desc 的归一化写法（数字 + 单位全拼；频次用 `N time(s) per <period>`，period 用**单数**）。 */
function normalizedDesc(parsed) {
  if (parsed.freq) return `${parsed.numText} ${parsed.num === 1 ? 'time' : 'times'} per ${FULL_EN[parsed.unit]}`;
  const head = `${parsed.numText} ${unitEn(parsed.unit, parsed.num)}`;
  return parsed.rest ? `${head}${parsed.rest.startsWith(' ') || parsed.rest.startsWith('(') ? '' : ' '}${parsed.rest}`.trim() : head;
}

/* ------------------------------ 主流程 ------------------------------ */

/*
 * ⚠️ **备份必须在任何写入之前**。
 * 第一版把这段放在了年份循环之后，而写入是在循环里做的——
 * 结果 `build/_backup_gold_pre_units/` 里存的是**改好之后**的副本，等于没有备份
 * （靠 `gold_normalize.mjs --out` 重新生成原状才发现）。
 * 这类"备份晚了一步"的错不会报错、只会静默失效，所以在这里显式钉一条注释。
 */
if (APPLY && !existsSync(BACKUP)) {
  mkdirSync(BACKUP, { recursive: true });
  for (const f of readdirSync(join(ROOT, 'build', 'gold'))) {
    if (f.endsWith('.json')) copyFileSync(join(ROOT, 'build', 'gold', f), join(BACKUP, f));
  }
  console.log(`已备份原金标准 → ${BACKUP.replace(ROOT + '\\', '')}（在写入之前）`);
}

const changes = [];
const skipped = [];
let scanned = 0;

for (const y of YEARS) {
  const file = join(ROOT, 'build', 'gold', `${y}.json`);
  if (!existsSync(file)) continue;
  const gold = JSON.parse(readFileSync(file, 'utf8'));

  for (const a of gold.articles ?? []) {
    for (const [ci, c] of (a.comparisons ?? []).entries()) {
      for (const g of GROUPS) {
        scanned++;
        const d = c[g.desc]?.raw ?? '';
        const v = c[g.value]?.raw ?? '';
        const u = c[g.unit]?.raw ?? '';
        const base = { year: y, articleId: a.article_id, cmp: ci + 1, group: g.zh, desc: d, value: v, unit: u };

        /* ① 哨兵值：只做三列对齐（desc 是哨兵就要求 value/unit 同哨兵） */
        if (SENT.test(d)) {
          const s = (/^\s*(NR|NA|NE)/i.exec(d)?.[1] ?? 'NR').toUpperCase();
          if (v !== s || u !== s) {
            changes.push({ ...base, kind: 'sentinel-align', newDesc: d, newValue: s, newUnit: s });
            if (APPLY) {
              if (c[g.value]) { c[g.value].raw = s; delete c[g.value].code; }
              if (c[g.unit]) { c[g.unit].raw = s; delete c[g.unit].code; }
            }
          }
          continue;
        }

        /* ② 解析 desc */
        const p = parseDesc(d, g);
        if (!p) {
          skipped.push({ ...base, reason: countNumbers(d) > 1 ? '含多个数字' : '解析不出数+单位' });
          continue;
        }
        const tc = toCode(g, p.unit, p.num);
        if (!tc) { skipped.push({ ...base, reason: '单位无法映射到编码表' }); continue; }

        const newDesc = normalizedDesc(p);
        const newValue = fmt(tc.value);
        const newUnit = String(tc.code);
        if (newDesc === d && newValue === v && newUnit === u) continue;   // 无变化

        changes.push({ ...base, kind: 'normalize', newDesc, newValue, newUnit, approx: !!tc.approx });
        if (APPLY) {
          if (c[g.desc]) { c[g.desc].raw = newDesc; if ('code' in c[g.desc]) c[g.desc].code = newDesc; }
          if (c[g.value]) { c[g.value].raw = newValue; if ('code' in c[g.value]) c[g.value].code = newValue; }
          if (c[g.unit]) { c[g.unit].raw = newUnit; if ('code' in c[g.unit]) c[g.unit].code = newUnit; }
        }
      }
    }
  }

  if (APPLY) writeFileSync(file, JSON.stringify(gold, null, 1), 'utf8');
}

/* ------------------------------ 报告 ------------------------------ */

const byKind = new Map();
for (const ch of changes) byKind.set(ch.kind, (byKind.get(ch.kind) ?? 0) + 1);
const byGroup = new Map();
for (const ch of changes) byGroup.set(ch.group, (byGroup.get(ch.group) ?? 0) + 1);

console.log(`\n══ 金标准三列对齐${APPLY ? '（已落盘）' : '（干跑，未写文件）'} ══\n`);
console.log(`  扫描比较组字段：${scanned}`);
console.log(`  **将修改：${changes.length}**  （${[...byKind].map(([k, n]) => `${k} ${n}`).join('，')}）`);
console.log(`  按组：${[...byGroup].map(([k, n]) => `${k} ${n}`).join('，')}`);
console.log(`  跳过（列报告待人工处理）：${skipped.length}`);

const nb = new Map();
for (const s of skipped) nb.set(`${s.group}|${s.reason}`, (nb.get(`${s.group}|${s.reason}`) ?? 0) + 1);
console.log('\n  ── 跳过原因分布 ──');
for (const [k, n] of [...nb].sort((x, z) => z[1] - x[1])) console.log(`   ${String(n).padStart(4)}  ${k.replace('|', '：')}`);

console.log('\n  ── 修改样例（前 20）──');
for (const ch of changes.slice(0, 20)) {
  console.log(`   ${ch.year} ${ch.articleId} 比较组${ch.cmp}　[${ch.group}] ${ch.kind}`);
  if (ch.kind === 'sentinel-align') { console.log(`      value/unit → ${JSON.stringify(ch.newValue)}`); continue; }
  console.log(`      desc : ${JSON.stringify(ch.desc.slice(0, 34))} → ${JSON.stringify(ch.newDesc.slice(0, 34))}`);
  console.log(`      value: ${JSON.stringify(ch.value)} → ${JSON.stringify(ch.newValue)}`);
  console.log(`      unit : ${JSON.stringify(ch.unit)} → ${JSON.stringify(ch.newUnit)}`);
}

/* 重点：最长随访"单位编码"的修正条数 */
const unitFixes = changes.filter((ch) => ch.kind === 'normalize' && ch.newUnit !== ch.unit);
console.log(`\n  ★ 其中**单位编码被修正**的：${unitFixes.length} 条`);
const pair = new Map();
for (const ch of unitFixes) pair.set(`${ch.unit}→${ch.newUnit}`, (pair.get(`${ch.unit}→${ch.newUnit}`) ?? 0) + 1);
for (const [k, n] of [...pair].sort((x, z) => z[1] - x[1])) console.log(`     ${k}：${n} 条`);

/*
 * 数值被改动的条目单独列出：**这不是格式问题，是内容变更**，必须人工看一遍。
 * 实测样本里就有 `desc="15"` 而 value 原本是 `14` 的——按"以第一列为准"的口径应改成 15。
 */
const valueFixes = changes.filter((ch) => ch.kind === 'normalize' && ch.newValue !== ch.value);
console.log(`\n  ★ **数值被改动**的：${valueFixes.length} 条（内容变更，建议人工核一遍）`);
for (const ch of valueFixes.slice(0, 25)) {
  console.log(`     ${ch.year} ${ch.articleId} 比较组${ch.cmp}　[${ch.group}] desc=${JSON.stringify(ch.desc.slice(0, 30))}　value ${JSON.stringify(ch.value)} → ${JSON.stringify(ch.newValue)}`);
}

console.log(`\n  ★ 哨兵对齐（desc 是 NR/NA/NE，value/unit 不是）：${changes.filter((c) => c.kind === 'sentinel-align').length} 条`);
for (const ch of changes.filter((c) => c.kind === 'sentinel-align').slice(0, 12)) {
  console.log(`     ${ch.year} ${ch.articleId} 比较组${ch.cmp}　[${ch.group}] desc=${JSON.stringify(ch.desc)}  value ${JSON.stringify(ch.value)}→${JSON.stringify(ch.newValue)}  unit ${JSON.stringify(ch.unit)}→${JSON.stringify(ch.newUnit)}`);
}

console.log('\n  ── 跳过的样例（前 12，待人工处理）──');
for (const s of skipped.slice(0, 12)) {
  console.log(`     ${s.year} ${s.articleId} 比较组${s.cmp}　[${s.group}] ${s.reason}：${JSON.stringify(s.desc.slice(0, 44))}`);
}

writeFileSync(join(ROOT, 'build', 'gold_unit_fix_report.json'),
  JSON.stringify({ at: new Date().toISOString(), applied: APPLY, scanned, changed: changes.length, skipped: skipped.length, changes, skippedRows: skipped }, null, 1), 'utf8');
console.log(`\n明细 build/gold_unit_fix_report.json\n`);
