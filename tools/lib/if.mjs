/**
 * 影响因子（2019）查表 —— 纯函数实现（解析 xlsx / 建索引 / 查表）。
 *
 * 数据源：`Datas/IF-SCI-2019.xlsx`（JCR 2019 SCIE 全刊）。
 * 为什么要查表：影响因子**论文里没有**，让模型凭记忆答实测 222 篇错 172 篇；
 * 用户已明确"影响因子之后从 Datas 的 IF-SCI-2019.xlsx 查询"。
 *
 * 这里只放纯逻辑，不做 I/O 副作用：
 *   · CLI（`tools/if_index.mjs`）用它生成 `build/if-2019.json`；
 *   · 流水线（`tools/llm_run.mjs`）用它建查询函数注入 article-meta SKILL。
 */

import { readWorkbook } from './xlsx.mjs';

/**
 * 刊名别名（人工审过的短表）。
 *
 * 为什么需要：JCR 用的是**全称** `JAMA-JOURNAL OF THE AMERICAN MEDICAL ASSOCIATION`、
 * `BMJ-British Medical Journal`，而论文/金标准里常写 `JAMA`、`BMJ`。
 * 关键字面匹配对不上，只能留空——实测 `JAMA` 在语料里出现 3 次，全是这样丢的。
 *
 * ⚠️ 只放**确定无歧义**的：`JAMA` 若按前缀猜会同时命中 JAMA Oncology / Psychiatry / Surgery…
 * 六种，猜错等于填错刊的影响因子，比留空更糟。因此这里是白名单，不是规则。
 */
const JOURNAL_ALIASES = new Map(Object.entries({
  /* ⚠️ 键必须写成 normJournal 的输出（大写、无虚词）——写成小写会永远查不到（实测踩过） */
  JAMA: 'JAMA-JOURNAL OF THE AMERICAN MEDICAL ASSOCIATION',
  'JAMA JOURNAL AMERICAN MEDICAL ASSOCIATION': 'JAMA-JOURNAL OF THE AMERICAN MEDICAL ASSOCIATION',
  BMJ: 'BMJ-British Medical Journal',
  'BMJ BRITISH MEDICAL JOURNAL': 'BMJ-British Medical Journal',
  'BRITISH MEDICAL JOURNAL': 'BMJ-British Medical Journal',
  NEJM: 'NEW ENGLAND JOURNAL OF MEDICINE',
  'PLUS ONE': 'PLOS ONE',            // 语料里出现过这个错拼
  'PLOS ONE PONE': 'PLOS ONE',
}));

/**
 * 期刊名归一：大写、`&` → and、去标点、去虚词、压空白。
 * 归一后**精确相等**即认定同一刊；再退一步只接受令牌 Dice ≥ 0.9。
 *
 * ⚠️ 阈值不能放松：实测 0.6 会把 `JAMA` 匹配成 `JAMA Oncology`（24.799 vs 45.54）、
 * `International Journal of Adolescent Medicine and Health` 匹配成
 * `JOURNAL OF ADOLESCENT HEALTH`——都是**不同期刊**，填错比留空更糟。
 */
export const normJournal = (s) => String(s ?? '')
  /* 语料里的刊名常带补充说明：`BJU International (BJUI)`、`Journal of Affective Disorders? (not specified)`。
     这些括号/问号不是刊名的一部分，留着会与表里的 `BJU INTERNATIONAL` 对不上（实测丢 2 篇）。 */
  .replace(/[?？].*$/, ' ')
  .replace(/\([^)]*\)/g, ' ')
  .toUpperCase()
  .replace(/&/g, ' AND ')
  .replace(/[^A-Z0-9]+/g, ' ')
  .replace(/\b(THE|OF|AND|FOR|A|AN)\b/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/** 归一 + 别名改写（用于查表）。 */
export const lookupKeyOf = (s) => {
  const k = normJournal(s);
  return JOURNAL_ALIASES.get(k) ? normJournal(JOURNAL_ALIASES.get(k)) : k;
};

const tokensOf = (s) => new Set(normJournal(s).split(' ').filter((t) => t.length > 1));
const dice = (a, b) => {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return (2 * inter) / (a.size + b.size);
};

/**
 * 从 `IF-SCI-2019.xlsx` 读出全部条目。
 *
 * 表结构（实测）：第 1~2 行是导出说明，**第 3 行才是表头**
 * `Rank | Full Journal Title | Total Cites | (空) | Journal Impact Factor | Eigenfactor Score`，
 * 数据从第 4 行起。不能假设"第一行是表头"——那样会读出 0 条。
 */
export function readIfEntriesFromXlsx(file) {
  const wb = readWorkbook(file);
  const sheet = wb.sheets[0];
  let headerRow = -1; let titleCol = -1; let ifCol = -1;
  for (const r of sheet.rows.slice(0, 12)) {
    const cells = (r.cells ?? []).map((c) => String(c ?? '').trim());
    const ti = cells.findIndex((c) => /full journal title/i.test(c));
    const ii = cells.findIndex((c) => /journal impact factor/i.test(c));
    if (ti >= 0 && ii >= 0) { headerRow = r.r; titleCol = ti; ifCol = ii; break; }
  }
  if (headerRow < 0) throw new Error(`${file}：找不到表头（需要同时出现 Full Journal Title 与 Journal Impact Factor）`);
  const entries = [];
  const seen = new Set();
  for (const r of sheet.rows) {
    if (r.r <= headerRow) continue;
    const cells = r.cells ?? [];
    const journal = String(cells[titleCol] ?? '').trim();
    const jif = String(cells[ifCol] ?? '').trim().replace(/,/g, '');
    if (!journal || !/^\d+(\.\d+)?$/.test(jif)) continue;
    const key = normJournal(journal);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    entries.push({ journal, jif });
  }
  return { sheet: sheet.name, headerRow, entries };
}

/**
 * 缩写匹配：把查询词按顺序当作表内标题词的**前缀**去套。
 *
 * 为什么需要：论文首页印的是期刊缩写（`Int J Clin Exp Med`、`Menopause`、`EXPLORE`），
 * 而 JCR 表里是全称（`International Journal of Clinical and Experimental Medicine` …）。
 * 字面匹配必然落空，实测因此白丢 5 篇。
 *
 * 安全阀：**必须唯一命中**才采纳。`PAIN` 会同时套上 PAIN / PAIN MEDICINE / PAIN PRACTICE…
 * 多个标题，这时一律拒绝——缩写猜错刊=填错影响因子，比留空更糟。
 */
function prefixCandidates(name, entries) {
  const q = normJournal(name).split(' ').filter((t) => t.length > 1);
  if (!q.length) return [];
  const out = [];
  for (const e of entries) {
    const tt = normJournal(e.journal).split(' ').filter((t) => t.length > 1);
    if (!tt.length) continue;
    let i = 0;
    let ok = true;
    for (const qt of q) {
      while (i < tt.length && !tt[i].startsWith(qt)) i++;
      if (i >= tt.length) { ok = false; break; }
      i++;
    }
    if (ok) out.push(e);
  }
  return out;
}

/** 建查询函数：归一（含别名）后精确匹配 → 令牌 Dice ≥ 0.9 → 唯一缩写匹配。 */
export function buildIfLookup(entries) {
  const byKey = new Map(entries.map((e) => [normJournal(e.journal), e]));
  return (name) => {
    const key = lookupKeyOf(name);
    if (!key) return null;
    const exact = byKey.get(key);
    if (exact) return { journal: exact.journal, jif: exact.jif, how: 'exact' };
    const tk = tokensOf(name);
    /*
     * 模糊匹配要求查询词至少 2 个：单泛用词会误命中——实测 `Journal` 与 `R Journal`
     * 的令牌集合都是 {journal}（单词 'R' 被长度过滤掉），Dice = 1.00，于是把 R Journal
     * 的 3.312 当成《Journal》的影响因子。宁可查不到，也不能填错刊。
     */
    if (tk.size >= 2) {
      let best = null;
      for (const e of byKey.values()) {
        const d = dice(tk, tokensOf(e.journal));
        if (!best || d > best.d) best = { journal: e.journal, jif: e.jif, d };
      }
      if (best && best.d >= 0.9) return { journal: best.journal, jif: best.jif, how: `fuzzy(${best.d.toFixed(2)})` };
    }
    const cands = prefixCandidates(name, entries);
    if (cands.length === 1) return { journal: cands[0].journal, jif: cands[0].jif, how: 'abbrev' };
    return null;
  };
}
