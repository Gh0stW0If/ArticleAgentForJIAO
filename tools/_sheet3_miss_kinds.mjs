/**
 * Sheet3 数值类指标：**漏掉的 148 个值到底漏在哪一步**。
 *
 * 动机：只看"漏 148"没法决定下一步改什么。漏的原因至少有四种，改法完全不同：
 *   ① 整条金标准结局行没配上（对齐失败）→ 改对齐
 *   ② 配对成功，但我们**没有这个时点块**（如只填了 baseline）→ 改 prompt 的时点规则
 *   ③ 有时点块，但**没有这一类**（金标准是 binary/等级，我们只填了 continuous）→ 改类型判定
 *   ④ 有时点块也有这一类，只是**这个叶子没填**（如没填 ciLower / n）→ 改叶子规则/审计
 *
 * 用法：node tools/_sheet3_miss_kinds.mjs [--year 2015]
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { camelToSnake } from './lib/keys.mjs';
import { alignOutcomes, normNum } from './lib/align.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
let year = '2015';
for (let i = 0; i < argv.length; i++) if (argv[i] === '--year') year = argv[++i];

/** 数值叶子（与 tools/_sheet3_numeric.mjs 保持一致）。 */
const NUMERIC_LEAVES = new Set([
  'estimate', 'ci_lower', 'ci_upper', 'n', 'events',
  'cat1', 'cat2', 'cat3', 'cat4', 'cat5', 'cat6',
  'difference_estimate', 'difference_ci_lower', 'difference_ci_upper',
]);

/* 错位金标准：与评测同一份排除表（值级匹配） */
const excluded = new Map();
const anomaliesFile = join(ROOT, 'build', 'gold_anomalies.json');
if (existsSync(anomaliesFile)) {
  for (const a of JSON.parse(readFileSync(anomaliesFile, 'utf8')).anomalies ?? []) {
    if (a.year !== year || !/^timepoints\./.test(String(a.field))) continue;
    const leaf = String(a.field).replace(/^timepoints\./, '');
    const k = `${a.articleId}|${leaf}`;
    if (!excluded.has(k)) excluded.set(k, new Set());
    excluded.get(k).add(String(a.value).trim());
  }
}
const isExcluded = (id, leaf, raw) => excluded.get(`${id}|${leaf}`)?.has(String(raw).trim()) ?? false;

const gold = JSON.parse(readFileSync(join(ROOT, 'build', 'gold', `${year}.json`), 'utf8'));
const extrDir = join(ROOT, 'build', 'extraction', year);

const KINDS = ['continuous', 'binary', 'categorical'];
/** 判定两个值是否算"同一个数"（与评测 compareValue 的数值容差一致）。 */
const sameValue = (a, b) => {
  if (a === undefined || a === null) return false;
  const x = normNum(a); const y = normNum(b);
  if (x !== null && y !== null) return Math.abs(x - y) <= Math.max(0.05, Math.abs(y) * 0.005);
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
};

const reasons = new Map();
const bump = (r) => reasons.set(r, (reasons.get(r) ?? 0) + 1);
/** 按「原因 → 例」记录几个样本，便于人工确认归类是否正确。 */
const samples = new Map();
const note = (r, s) => {
  if (!samples.has(r)) samples.set(r, []);
  if (samples.get(r).length < 6) samples.get(r).push(s);
};

const byLeafMiss = new Map();

for (const art of gold.articles) {
  const id = art.article_id;
  const f = join(extrDir, `${id}.json`);
  if (!existsSync(f)) continue;
  const pred = JSON.parse(readFileSync(f, 'utf8'));
  const goldOuts = art.outcomes ?? [];
  const predOuts = pred.outcomes ?? [];
  const { goldToPred } = alignOutcomes(goldOuts, predOuts);

  for (const [gi, g] of goldOuts.entries()) {
    const pi = goldToPred.get(gi);
    const p = pi === undefined ? null : predOuts[pi];
    const gName = g.outcome?.name?.raw ?? '';
    for (const [tpSnake, gtp] of Object.entries(g.timepoints ?? {})) {
      const tpCamel = { baseline: 'baseline', end_of_treatment: 'endOfTreatment', follow_up_end: 'followUpEnd' }[tpSnake] ?? tpSnake;
      const ptp = p?.timepoints?.[tpCamel] ?? null;
      for (const [kindSnake, gkind] of Object.entries(gtp ?? {})) {
        if (!gkind || typeof gkind !== 'object') continue;
        const pkind = ptp?.[kindSnake] ?? ptp?.[camelToSnake(kindSnake)] ?? null;
        // 深度展开金标准该 kind 下的 (叶子名 → 值)；对照组带 control.* 前缀
        const walk = (node, prefix) => {
          for (const [snake, gv] of Object.entries(node ?? {})) {
            if (gv === null || typeof gv !== 'object') continue;
            if (!('raw' in gv)) { walk(gv, prefix ? `${prefix}.${snake}` : snake); continue; }
            const leafName = snake;
            const leafKey = `${camelToSnake(prefix ? prefix.split('.').pop() : '') ? '' : ''}${leafName}`;
            void leafKey;
            if (!NUMERIC_LEAVES.has(leafName)) continue;
            if (isExcluded(id, leafName, gv.raw)) continue;
            // 流水线侧取值：注意 continuous 下是 experimental/control 两层
            const findPred = (obj) => {
              if (!obj) return undefined;
              const path = prefix ? prefix.split('.') : [];
              let cur = obj;
              for (const seg of path) {
                const k = Object.keys(cur ?? {}).find((x) => camelToSnake(x) === camelToSnake(seg));
                if (!k) return undefined;
                cur = cur[k];
              }
              const k2 = Object.keys(cur ?? {}).find((x) => camelToSnake(x) === camelToSnake(leafName));
              return k2 ? cur[k2] : undefined;
            };
            const pv = findPred(pkind);
            const pRaw = pv && typeof pv === 'object' && 'raw' in pv ? pv.raw : undefined;
            if (sameValue(pRaw, gv.raw)) continue;   // 没漏
            const where = `${id} 结局#${gi + 1}「${gName}」 ${tpSnake}/${kindSnake}/${prefix ? prefix + '.' : ''}${leafName}=${gv.raw}`;
            const leafBump = (l) => byLeafMiss.set(l, (byLeafMiss.get(l) ?? 0) + 1);
            leafBump(leafName);
            if (!p) { bump('① 整条结局行没配上'); note('① 整条结局行没配上', where); continue; }
            if (!ptp) { bump('② 没有这个时点块'); note('② 没有这个时点块', where); continue; }
            if (!pkind) {
              const kinds = Object.keys(ptp);
              bump(`③ 有时点块但没有这一类（我们只填了 ${kinds.join('/')}）`);
              note('③ 有时点块但没有这一类', `${where} ← 我们填的是 ${kinds.join('/')}`);
              continue;
            }
            // 这一类存在，但流水线在这个位置的值是 NR/NA 或干脆没这个键
            const leafReason = pRaw === undefined
              ? '④ 这一类里没有这个叶子'
              : (pRaw === 'NR' || pRaw === 'NA' ? '④b 填了 NR/NA' : '④c 值不同（但评测算"错"）');
            bump(leafReason);
            // ⚠️ 样本必须跟着**同一个**桶，否则"④"里会混进 ④c 的例子（踩过一次）
            note(leafReason, pRaw === undefined
              ? `${where} ← 我们这一类只有 ${Object.keys(pkind[prefix ? prefix.split('.')[0] : ''] ?? pkind).join('/') || '（空）'}`
              : `${where} ← 我们填的是 ${pRaw}`);
          }
        };
        walk(gkind, '');
      }
    }
  }
}

const total = [...reasons.values()].reduce((a, b) => a + b, 0);
console.log(`\n=== 漏掉的数值金标准（${year}）：共 ${total} 个 ===`);
for (const [r, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`\n  ${String(n).padStart(4)}  ${r}`);
  for (const s of samples.get(r) ?? []) console.log(`        例：${s}`);
}
console.log(`\n=== 按叶子 ===`);
for (const [l, n] of [...byLeafMiss.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${l}`);
