/**
 * @aa/core — 数值判等的**评分口径**（评测与诊断共用，必须只有一份实现）
 *
 * 为什么需要它：评测要允许"同一个数的不同写法"（`-41` vs `-41.0`、`41` vs `41.0`），
 * 否则会把大量正确提取误判为错。但**容差怎么定**直接决定分数真假，踩过的坑：
 *
 * ⚠️ 曾用"相对容差 0.5%"（`|a-b| <= max(0.05, |b|*0.005)`），对效应量没问题，
 * 对**年份**却成了灾难：金标准 `2015`、流水线 `2018`，差值 3 ≤ 2015×0.005 = 10.075
 * → 判为**命中**。于是 `publication_year` 在评测里几乎全对（222 篇只有 3 篇算错），
 * 而逐篇核对发现有 47 篇年份不同——metadata 的准确率被虚高了约 1.2 个百分点。
 * 同类风险还有任何"大数值"字段（例数、金额、总次数）。
 *
 * 现在的口径：**按两者中"较短的小数位数"四舍五入后比较**——
 *   · `41` vs `41.0` → 都按 0 位 → 41 = 41 ✓（写法差异，算对）
 *   · `-41` vs `-41.0` → ✓
 *   · `2015` vs `2018` → 2015 ≠ 2018 ✗（绝不再放过）
 *   · `0.175` vs `0.18` → 按 2 位 → 0.18 = 0.18 ✓
 * 这条规则不随数量级漂移，语义也直白：**差异只在书写精度上**。
 */

/** 小数位数（`41.0` → 1；`41` → 0；科学计数法按字符串处理，返回 0）。 */
export function decimalsOf(s: string): number {
  const m = /^[-+]?\d*\.(\d+)$/.exec(String(s).trim());
  return m ? m[1]!.length : 0;
}

/** 四舍五入到 d 位小数（避免浮点误差，先转成整数运算）。 */
function roundTo(n: number, d: number): number {
  const f = 10 ** d;
  return Math.round((n + Number.EPSILON * Math.sign(n)) * f) / f;
}

/**
 * 两个数值字符串是否"数值上相等"（允许精度写法差异）。
 * 任一不是数字 → 返回 false（由调用方按文本/编码规则处理）。
 */
export function numericEqual(a: unknown, b: unknown): boolean {
  const sa = String(a ?? '').trim().replace(/[\u2212\u2013\u2014]/g, '-').replace(/,/g, '');
  const sb = String(b ?? '').trim().replace(/[\u2212\u2013\u2014]/g, '-').replace(/,/g, '');
  if (!/^[-+]?\d*\.?\d+$/.test(sa) || !/^[-+]?\d*\.?\d+$/.test(sb)) return false;
  const na = Number(sa);
  const nb = Number(sb);
  if (!Number.isFinite(na) || !Number.isFinite(nb)) return false;
  if (na === nb) return true;
  const d = Math.min(decimalsOf(sa), decimalsOf(sb));
  return roundTo(na, d) === roundTo(nb, d);
}
