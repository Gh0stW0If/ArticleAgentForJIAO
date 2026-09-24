/**
 * @aa/core — 时间/频次量的**解析与单位归一化**
 *
 * 用途有两个，都很具体：
 *
 * 1. **评测侧**：让 `3 months` 与 `12 weeks`、`30 min` 与 `0.5 h` 这类"同量异单位"的答案
 *    能被**确定性判定**，不再送 LLM 语义判定。收益不只是省钱——
 *    实测同一组 `"30"` vs `"30 minutes"` 在不同条目上被判过 1.0 也判过 0.5，
 *    LLM 判定本身有噪声，而这里的结果是可复现的。
 * 2. **提示词侧**：为 `course` / `frequency` / `needle_retention` / `max_followup`
 *    这几组"表头指定了单位"的字段提供规范单位与换算因子，写进提示词让模型直接输出规范口径。
 *
 * ⚠️ **换算因子必须用金标准的约定，不能用物理常数。**
 * 实测金标准里 `3 months` 对应 `course_value=12`、`course_unit=2`（周），即
 * **1 月 = 4 周**（若用物理值 4.345 周会与金标准对不上）。
 * 依据：`tools/_unit_convention_scale.mjs` 对全库三列（desc/value/unit）的交叉统计。
 */

/** 时间单位（内部一律换算到秒做比较）。 */
export type TimeUnit = '秒' | '分钟' | '小时' | '天' | '周' | '月' | '年';

/**
 * 各单位相对"秒"的因子。
 *
 * `月 = 4 周`、`年 = 12 月` 是**项目约定**（与金标准一致），不是天文常数——
 * 见文件头说明。改动这里会同时影响评测判定与提示词示例。
 */
export const SECONDS_PER: Readonly<Record<TimeUnit, number>> = {
  秒: 1,
  分钟: 60,
  小时: 3600,
  天: 86400,
  周: 7 * 86400,
  月: 4 * 7 * 86400,      // 项目约定：1 月 = 4 周
  年: 12 * 4 * 7 * 86400, // 项目约定：1 年 = 12 月 = 48 周
};

/** 中文/英文单位词 → 规范时间单位。 */
const UNIT_ALIASES: readonly (readonly [RegExp, TimeUnit])[] = [
  [/^(s|sec|secs|second|seconds|秒)$/i, '秒'],
  [/^(min|mins|minute|minutes|分钟|分)$/i, '分钟'],
  [/^(h|hr|hrs|hour|hours|小时|時|时)$/i, '小时'],
  [/^(d|day|days|天|日)$/i, '天'],
  [/^(w|wk|wks|week|weeks|周|星期)/i, '周'],
  [/^(mo|mon|month|months|月)/i, '月'],
  [/^(y|yr|yrs|year|years|年)/i, '年'],
];

/** 英文数词（提示词里出现 `four weeks`、`twice` 这类写法）。 */
const NUMBER_WORDS: Readonly<Record<string, number>> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  once: 1, twice: 2, thrice: 3, a: 1, an: 1,
};

export interface Quantity {
  /** 原样写法 */
  raw: string;
  /** 数值（若原文是范围 `15-20`，取低值并标 `isRange`） */
  value: number;
  /** 规范时间单位 */
  unit: TimeUnit;
  /** 换算到秒后的量（用于跨单位比较） */
  seconds: number;
  /** 原文是范围（`15-20`、`2 to 3 weeks`）→ 比较时只能判"区间相交" */
  isRange: boolean;
  /** 范围的另一端 */
  rangeHigh?: number;
}

/**
 * 解析一个"数 + 时间单位"的片段。
 *
 * 支持：`30 min`、`9 weeks`、`3 months`、`24 hours`、`five days`、`once a week`（取 1 次/周）、
 * `15-20 min`（范围，取低值并标 isRange）。
 * 解析不出来返回 null——**不猜**。
 */
export function parseQuantity(input: string): Quantity | null {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  const s = raw.toLowerCase();

  /* 数词 → 数字 */
  const wordNum = /^([a-z]+)\s+([a-z]+)/.exec(s);
  let numText: string | null = null;
  let rest = s;
  const m = /^(\d+(?:\.\d+)?)\s*(?:[-–~]\s*(\d+(?:\.\d+)?))?\s*([a-z\u4e00-\u9fa5]+)?/.exec(s);
  if (m && m[1]) {
    numText = m[1];
    rest = (m[3] ?? '').trim();
  } else if (wordNum && NUMBER_WORDS[wordNum[1]!] !== undefined) {
    numText = String(NUMBER_WORDS[wordNum[1]!]);
    rest = wordNum[2]!;
  } else if (/^once\s+a\s+(week|day|month)/.test(s)) {
    numText = '1';
    rest = /^once\s+a\s+(week|day|month)/.exec(s)![1]!;
  } else {
    return null;
  }

  const value = Number(numText);
  if (!Number.isFinite(value)) return null;

  let unit: TimeUnit | null = null;
  for (const [re, u] of UNIT_ALIASES) { if (re.test(rest)) { unit = u; break; } }
  if (!unit) {
    /* `5 days per week`、`3 times per week` 这类：单位在末尾 */
    for (const [re, u] of UNIT_ALIASES) { if (re.test(s)) { unit = u; break; } }
  }
  if (!unit) return null;

  const high = m?.[2] ? Number(m[2]) : undefined;
  return {
    raw,
    value,
    unit,
    seconds: value * SECONDS_PER[unit],
    isRange: high !== undefined && Number.isFinite(high),
    ...(high !== undefined && Number.isFinite(high) ? { rangeHigh: high } : {}),
  };
}

/** 把秒数换成目标单位（保留 3 位有效小数，避免 1/3 这类无限小数）。 */
export function convert(seconds: number, to: TimeUnit): number {
  return Number((seconds / SECONDS_PER[to]).toFixed(3));
}

/**
 * 两个"数+单位"片段是否**同量**（换算后相等）。
 *
 * 容差 2%：`3 months`(=12 周) 与 `12 weeks` 相等；`0.5 h`(=30 min) 与 `30 min` 相等。
 * 带范围的（`15-20 min`）只判**区间是否相交**——这是能确定的最强结论。
 */
export function quantityEqual(a: string, b: string, tolerance = 0.02): boolean {
  const qa = parseQuantity(a); const qb = parseQuantity(b);
  if (!qa || !qb) return false;
  const aLo = qa.seconds;
  const aHi = qa.isRange && qa.rangeHigh !== undefined ? qa.rangeHigh * SECONDS_PER[qa.unit] : aLo;
  const bLo = qb.seconds;
  const bHi = qb.isRange && qb.rangeHigh !== undefined ? qb.rangeHigh * SECONDS_PER[qb.unit] : bLo;
  if (qa.isRange || qb.isRange) {
    /* 区间相交即认为一致（无法更强地断定） */
    return aLo <= bHi * (1 + tolerance) && bLo <= aHi * (1 + tolerance);
  }
  const denom = Math.max(Math.abs(aLo), Math.abs(bLo)) || 1;
  return Math.abs(aLo - bLo) / denom <= tolerance;
}

/** 一组字段的**规范单位**（写进提示词，也用于评测侧判定）。 */
export interface CanonicalUnit {
  field: string;
  label: string;
  /** 规范单位的编码与含义 */
  canonical: string;
  /** 允许的编码取值（来自金标准表头图例） */
  codes: Readonly<Record<string, string>>;
}

/**
 * 表头显式指定单位的几组字段。
 *
 * ⚠️ 编码含义取自**原始 Excel 表头**（`build/legend/<year>.json` 的 `headerLabels`），
 * 不是从数据反推的——实测有 36% 的记录（2020 年后成片出现）与表头不符，
 * 详见 `docs/18-unit-normalization.md`。**以表头为准。**
 */
export const CANONICAL_UNITS: readonly CanonicalUnit[] = [
  { field: 'needle_retention', label: '留针时间', canonical: '分钟', codes: { '1': '分钟', '2': '小时' } },
  { field: 'course', label: '疗程', canonical: '周（原文按天报告时用 code 1）', codes: { '1': '天', '2': '周' } },
  { field: 'frequency', label: '治疗频次', canonical: '次/周（原文按天报告时用 code 1）', codes: { '1': '天', '2': '周', '3': '1小时' } },
  { field: 'max_followup', label: '最长随访时间', canonical: '天/月/年/周/小时（按原文最自然的口径）', codes: { '1': '天', '2': '月', '3': '年', '4': '周', '5': '小时' } },
  { field: 'insertion_depth', label: '进针深度', canonical: '毫米', codes: {} },
];
