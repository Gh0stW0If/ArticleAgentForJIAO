/**
 * 金标准 vs 论文原文 的**取证式审计**：检查"金标准里的数值/时间是否真的出现在论文里"。
 *
 * 起因（实测）：2015-01 的 `follow_up` 与 `max_followup` 都写 `42 weeks`，
 * 但该论文全文**没有任何 "42 weeks"**——它的随访时点是 10 周(T1) / 6 个月(T2) / 12 个月(T3)。
 * 也就是说这个值不是"位置不同"或"定义不同"，而是**论文里根本不存在**。
 * 这类错误会直接污染评分（模型答对反而被判错），必须挑出来记录并排除。
 *
 * 做法：对形如 `<数字> <单位>` 的金标准值，检查该数字是否与同一单位一起出现在论文文本里
 * （MinerU 产物存在才能查）。判据保守——只在**全文完全找不到该数值**时才报告，
 * 避免把"表述差异"误判成错误。
 *
 * 用法：
 *   node tools/gold_vs_paper.mjs            # 所有有 MinerU 产物的年份
 *   node tools/gold_vs_paper.mjs --year 2015
 *
 * 输出：把结果**追加**进 build/gold_anomalies.json（reason='值未在论文中出现'），
 *       评分时会被 llm_eval 自动排除并单列。
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingest } from '../packages/ingest/dist/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const onlyYear = argv.includes('--year') ? argv[argv.indexOf('--year') + 1] : null;

const NUM_UNIT_RE = /^(\d+(?:\.\d+)?)\s*(weeks?|wks?|months?|mos?|years?|yrs?|days?|hours?|hrs?|minutes?|mins?|周|个月|月|年|天|小时|分钟)$/i;

/** 有时间/数值语义、且最值得核对的字段。 */
const CHECK_FIELDS = new Set([
  'follow_up', 'max_followup_desc', 'max_followup_value', 'course_desc', 'course_value',
  'frequency_desc', 'frequency_value', 'needle_retention_desc', 'needle_retention_value',
  'total_sessions', 'dropout_total', 'randomized_n', 'randomized_n_experimental', 'randomized_n_control',
  'analyzed_n_experimental', 'analyzed_n_control', 'trial_center_count',
]);

const goldDir = join(ROOT, 'build', 'gold');
const mineruBase = join(ROOT, 'build', 'mineru');

const years = readdirSync(goldDir)
  .filter((f) => /^\d{4}\.json$/.test(f))
  .map((f) => f.replace('.json', ''))
  .filter((y) => !onlyYear || y === onlyYear)
  .filter((y) => existsSync(join(mineruBase, y)));

if (!years.length) {
  console.error('没有可用于对照的 MinerU 产物（先跑 pnpm mineru:batch）');
  process.exit(2);
}

const findings = [];
let checked = 0;

for (const year of years) {
  const gold = JSON.parse(readFileSync(join(goldDir, `${year}.json`), 'utf8'));

  for (const a of gold.articles ?? []) {
    let doc;
    try {
      doc = ingest({ rootDir: ROOT, year, studyId: a.article_id }).doc;
    } catch {
      continue;   // 该篇没有 MinerU 产物
    }
    const paper = doc.blocks.map((b) => b.text.replace(/\s+/g, ' ')).join(' \n ');
    const paperLower = paper.toLowerCase();

    /** 某个"数字+单位"是否在论文里出现（数字与单位可被少量字符分隔）。 */
    const appearsInPaper = (value) => {
      const m = NUM_UNIT_RE.exec(String(value).trim());
      if (!m) return true;                       // 非"数字+单位"形态 → 不在这里判
      const [, num, unit] = m;
      const u = unit.toLowerCase().replace(/s$/, '');
      // 允许 "42 weeks" / "42-week" / "42 w" 等写法；数字本身必须在单位附近出现
      const near = new RegExp(`\\b${num.replace('.', '\\.')}\\s*[-–~]?\\s*${u.slice(0, 4)}`, 'i');
      if (near.test(paperLower)) return true;
      // 退一步：数字与单位分别出现在同一段（120 字符窗口）内
      const idx = paperLower.indexOf(num.toLowerCase());
      if (idx >= 0) {
        const win = paperLower.slice(Math.max(0, idx - 60), idx + 60);
        if (win.includes(u.slice(0, 4))) return true;
      }
      return false;
    };

    for (const [scope, obj] of [
      ['article', a.article],
      ['study', a.study],
      ...(a.comparisons ?? []).map((c) => ['comparison', c, true]),
    ]) {
      for (const [k, v] of Object.entries(obj ?? {})) {
        if (!v || typeof v !== 'object' || !('raw' in v)) continue;
        const key = k === 'follow_up' || k === 'max_followup_desc' ? 'follow_up' : k;
        if (!CHECK_FIELDS.has(key) && !CHECK_FIELDS.has(k)) continue;
        if (!NUM_UNIT_RE.test(String(v.raw).trim())) continue;
        checked++;
        if (!appearsInPaper(v.raw)) {
          findings.push({
            year, articleId: a.article_id, scope, field: k,
            value: String(v.raw).slice(0, 80),
            reason: '值未在论文中出现（疑似错误金标准）',
          });
        }
      }
    }

    // 结局层的 follow_up：注意它是个**容器**（description / value / unit 三个叶子），
    // 评分时按叶子逐项比较，因此这里也要按叶子记录，否则排除键对不上。
    for (const o of a.outcomes ?? []) {
      const fu = o.follow_up?.description;
      if (!fu?.raw || !NUM_UNIT_RE.test(String(fu.raw).trim())) continue;
      checked++;
      if (!appearsInPaper(fu.raw)) {
        for (const leaf of ['description', 'value', 'unit']) {
          findings.push({
            year, articleId: a.article_id, scope: 'outcome', field: leaf,
            value: String(fu.raw).slice(0, 80),
            reason: '值未在论文中出现（疑似错误金标准）',
          });
        }
      }

      /*
       * Sheet3 的**纯数值叶子**（estimate / CI / n 等）也做同样的取证检查。
       *
       * 实测（`tools/sheet3_sources.mjs`）：449 个数值里 80.8% 能在表格里找到、
       * 7.6%（34 个）在表格与正文**都找不到**——那批要么是标注时换了口径（如百分比写成绝对值），
       * 要么是论文里根本没有，评分时不该算在流水线头上。
       */
      for (const [tp, block] of Object.entries(o.timepoints ?? {})) {
        void tp;
        for (const [kind, fields] of Object.entries(block ?? {})) {
          void kind;
          for (const leaves of Object.values(fields ?? {})) {
            if (leaves === null || typeof leaves !== 'object') continue;
            const items = 'raw' in leaves ? { _: leaves } : leaves;
            for (const [leaf, v] of Object.entries(items)) {
              if (!v || typeof v !== 'object' || !('raw' in v)) continue;
              const raw = String(v.raw).trim();
              if (!/^-?\d+(\.\d+)?$/.test(raw)) continue;
              checked++;
              const tok = raw.replace(/^-/, '');
              const present = new RegExp(`(^|[^\\d.])${tok.replace('.', '\\.')}([^\\d]|$)`).test(paperLower);
              if (!present) {
                findings.push({
                  year, articleId: a.article_id, scope: 'outcome',
                  field: `timepoints.${leaf === '_' ? 'difference' : leaf}`,
                  value: raw,
                  reason: '值未在论文中出现（疑似错误金标准）',
                });
              }
            }
          }
        }
      }
    }
  }
}

/* 合并进 build/gold_anomalies.json（评分时统一排除） */
/*
 * ⚠️ 合并语义：**只替换本次跑到的年份**，其余年份的既有发现原样保留。
 *
 * 最初的写法是 `filter(a => a.reason !== 本reason)`，即"先删掉全部同类发现再追加"——
 * 逐年前进式地跑（2015 → 2016 → …）会让上一次的发现被下一次**静默冲掉**：
 * 实测按年跑完 2016–2025 之后，文件里只剩 2025 的 258 条，前面九年的发现全没了，
 * 于是那些本应剔除的错位值重新回到准确率分母里。这与 gold_anomalies.mjs 踩过的坑是同一个。
 */
const file = join(ROOT, 'build', 'gold_anomalies.json');
const REASON = '值未在论文中出现（疑似错误金标准）';
const prev = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { at: null, years: [], total: 0, byReason: {}, anomalies: [] };
const ranYears = new Set(years.map((y) => String(y)));
const kept = (prev.anomalies ?? []).filter((a) => a.reason !== REASON || !ranYears.has(String(a.year)));
const merged = [...kept, ...findings];
const byReason = {};
for (const a of merged) byReason[a.reason] = (byReason[a.reason] ?? 0) + 1;
writeFileSync(file, JSON.stringify({ ...prev, at: new Date().toISOString(), total: merged.length, byReason, anomalies: merged }, null, 2), 'utf8');

console.log(`\n金标准 × 论文原文 取证审计（${years.join(', ')}）`);
console.log(`  核对了 ${checked} 个"数字+单位"形态的金标准值`);
console.log(`  全文找不到该数值的：${findings.length} 处`);
for (const f of findings.slice(0, 12)) {
  console.log(`    ${f.year}/${f.articleId} ${f.scope}.${f.field} = ${JSON.stringify(f.value)}`);
}
if (findings.length > 12) console.log(`    …共 ${findings.length} 处`);
console.log(`\n  已合并进 build/gold_anomalies.json（评分时自动排除并单列）\n`);
