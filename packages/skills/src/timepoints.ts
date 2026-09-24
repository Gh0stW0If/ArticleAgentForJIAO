/**
 * @aa/skills — 时点数值块的**共享**定义与校验。
 *
 * 为什么单独一个模块：结局层的"数值"部分被拆成了两个 SKILL
 *   · `outcome`        —— 结局自身字段（编码/范围/方向/单位/类型/基线调整）
 *   · `outcome-values` —— 只抽「结局 × 时点」的数值块
 * 两者都要用同一套时点键名、同一套字段路径映射、同一套编码推导与合理性校验。
 * 复制一份必然漂移（"评测说配上了、校验说没配上"），所以集中在这里。
 *
 * ⚠️ `ciLower` / `ciUpper` 的键名有误导性：它们装的是**变异值**（`varianceType` 指定的离散度），
 * 95%CI 只是其中一种。详见 SINGLE_VALUE_VARIANCE / TWO_BOUND_VARIANCE。
 */

import {
  type FieldValue,
  type GroupStats,
  type Issue,
  type OutcomeLevel,
  warn,
} from '@aa/core';
import { decode } from './legend.ts';

/* ------------------------------ 时点定义 ------------------------------ */

/** JSON 键（提示词模板用） → @aa/core 的时点键名。 */
export const TIMEPOINTS = {
  baseline: 'baseline',
  endOfTreatment: 'endOfTreatment',
  followUpEnd: 'followUpEnd',
} as const;

export type TimepointJsonKey = keyof typeof TIMEPOINTS;

/**
 * 时点块内的字段：**按块类型分开**定义（JSON 键 → 规范路径后缀）。
 *
 * ⚠️ 为什么必须分类型：模型是**按类型分组**输出的，同一个 JSON 键在不同块里含义不同——
 * `experimentalN` 在 `continuous` 块里是「连续型结局该组例数」，在 `binary` 块里是
 * 「事件结局该组例数（分母）」。过去只有一张不分类型的表，`experimentalN` 被固定映射到
 * `continuous.experimental.n`，于是**二分类块里的例数全被塞进了连续型块**（或整块丢弃）：
 * 实测 224 篇里"二分类结局每组例数"金标准有值 109 处，我们**一处都没抽到**（报告 §2.1.1 最大一块）。
 */
const CONTINUOUS_FIELDS: Readonly<Record<string, string>> = {
  estimateType: 'continuous.estimateType',
  varianceType: 'continuous.varianceType',
  experimentalEstimate: 'continuous.experimental.estimate',
  experimentalCiLower: 'continuous.experimental.ciLower',
  experimentalCiUpper: 'continuous.experimental.ciUpper',
  experimentalN: 'continuous.experimental.n',
  controlEstimate: 'continuous.control.estimate',
  controlCiLower: 'continuous.control.ciLower',
  controlCiUpper: 'continuous.control.ciUpper',
  controlN: 'continuous.control.n',
};

/** 二分类（事件数/人数型结局）——同时是**组间效应量**的容器。 */
const BINARY_FIELDS: Readonly<Record<string, string>> = {
  experimentalEvents: 'binary.experimental.events',
  experimentalN: 'binary.experimental.n',
  controlEvents: 'binary.control.events',
  controlN: 'binary.control.n',
  differenceEstimate: 'binary.differenceEstimate',
  differenceCiLower: 'binary.differenceCiLower',
  differenceCiUpper: 'binary.differenceCiUpper',
};

/** 等级资料。 */
const CATEGORICAL_FIELDS: Readonly<Record<string, string>> = {
  classificationMethod: 'categorical.classificationMethod',
  cat1Experimental: 'categorical.experimental.cat1',
  cat2Experimental: 'categorical.experimental.cat2',
  cat3Experimental: 'categorical.experimental.cat3',
  cat4Experimental: 'categorical.experimental.cat4',
  cat5Experimental: 'categorical.experimental.cat5',
  cat6Experimental: 'categorical.experimental.cat6',
  experimentalN: 'categorical.experimental.n',
  cat1Control: 'categorical.control.cat1',
  cat2Control: 'categorical.control.cat2',
  cat3Control: 'categorical.control.cat3',
  cat4Control: 'categorical.control.cat4',
  cat5Control: 'categorical.control.cat5',
  cat6Control: 'categorical.control.cat6',
  controlN: 'categorical.control.n',
};

/** 按块类型取字段表。 */
export const TIMEPOINT_FIELDS_BY_KIND: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  continuous: CONTINUOUS_FIELDS,
  binary: BINARY_FIELDS,
  categorical: CATEGORICAL_FIELDS,
};

/** 所有块类型的字段并集（JSON 键 → 规范后缀）。仅用于"键是否存在"这类整体检查。 */
export const TIMEPOINT_FIELD_MAP: Readonly<Record<string, string>> = {
  ...CONTINUOUS_FIELDS,
  ...BINARY_FIELDS,
  ...CATEGORICAL_FIELDS,
};

/** 时点块内需要确定性编码的字段。 */
export const TIMEPOINT_CODE_TARGETS: readonly string[] = ['estimateType', 'varianceType'];

/** 变异值类型偏好顺序（金标准 T3 批注）：数值越小越优先。 */
export const VARIANCE_PREFERENCE: Readonly<Record<string, number>> = {
  '1': 1, // 标准误 SE
  '2': 2, // 95% CI
  '3': 3, // 标准差 SD
  '4': 4, // 四分位间距 IQR
  '5': 5, // 全距
  '6': 6, // P 值
  '7': 7, // QR
};

/**
 * 单值型 / 双边界型变异指标。
 *
 * ⚠️ `ciLower`/`ciUpper` 两个键名有误导性：金标准里它们叫「试验组**变异值**下限/上限」
 * （列名 ILVARI/IUVARI），装的是 `varianceType` 指定的那个离散度，95%CI 只是其中一种：
 *   · 单值型（SE/SD/P/QR）→ 只有 `ciLower` 有值，`ciUpper` 本就是空的；
 *   · 双边界型（95%CI/IQR/全距）→ 两个都该有。
 * 实测 2015 年 94 组带变异值的时点块里 **62 组是 SD 单值**，把它们当成"CI 只填了一半"
 * 会系统性误报，并让模型去"补"一个不存在的上限。
 */
export const SINGLE_VALUE_VARIANCE: ReadonlySet<string> = new Set(['1', '3', '6', '7']);
export const TWO_BOUND_VARIANCE: ReadonlySet<string> = new Set(['2', '4', '5']);

/**
 * 时点数值块（三个时点同构）。
 *
 * 直接用 core 契约里的形状，而不是 `Record<string, unknown>`——否则调用方
 * （含测试）拿到的 `experimental`/`varianceType` 都是 `unknown`，取个字段就要强转。
 */
export type TimepointBlocks = NonNullable<OutcomeLevel['timepoints']>;

/* ------------------------------ 路径映射 ------------------------------ */

/**
 * 时点块字段的 JSON 路径 → 规范路径。
 *
 * ⚠️ 模型输出是**按类型分组**的（`<时点>.continuous.<字段>` / `<时点>.binary.<字段>` /
 * `<时点>.categorical.<字段>`），因此映射表的键必须带上这一层——
 * 否则 walk 生成的路径（`…endOfTreatment.continuous.experimentalN`）在表里查不到，
 * 整个时点块的字段会被静默丢弃。
 */
export function addTimepointPaths(
  map: Record<string, string>,
  inPrefix: string,
  timepointKeys: readonly TimepointJsonKey[],
  outPrefix = 'timepoints',
): void {
  for (const tp of timepointKeys) {
    for (const [kind, fields] of Object.entries(TIMEPOINT_FIELDS_BY_KIND)) {
      for (const [jsonKey, suffix] of Object.entries(fields)) {
        /* 映射必须"同类型进、同类型出"：块类型由模型输出的那一层决定，不由键名决定 */
        map[`${inPrefix}.${tp}.${kind}.${jsonKey}`] = `${outPrefix}.${TIMEPOINTS[tp]}.${suffix}`;
      }
    }
  }
}

/* ------------------------------ 编码推导 ------------------------------ */

/**
 * 由**我们自己填进去的数值形态**反推 `measurementType`，保证"数值 ↔ 编码"自洽。
 *
 * 为什么不交给模型：实测 2015-04 的 BDI 两行**明明填了 `differenceEstimate` 却写
 * `measurementType=1`（估计值）**——同一行里自相矛盾，而金标准对这两行要求 `2`（组间差值）。
 * 这类"从自己的产出就能推出来"的编码，用确定性代码定，比在提示词里反复强调可靠。
 *
 * 判据（按优先级）：
 *   OR/RR/RD/HR → 4/5/6/7；等级资料块 → 8；事件数 → 3；组间差值 → 2；
 *   都没有（只有各组自己的估计值）→ 保持模型给的 1。
 */
export function inferMeasurementType(tps: TimepointBlocks | undefined): string | undefined {
  const filled = (v?: FieldValue): boolean => Boolean(v?.raw && !/^(NR|NA|NE)$/i.test(v.raw));
  let events = false;
  let difference = false;
  let categorical = false;
  for (const block of Object.values(tps ?? {})) {
    const b = block as {
      binary?: Record<string, unknown>;
      categorical?: Record<string, unknown>;
    };
    if (b.categorical && Object.keys(b.categorical).length > 0) categorical = true;
    const bin = b.binary as
      | {
        experimental?: { events?: FieldValue };
        control?: { events?: FieldValue };
        differenceEstimate?: FieldValue;
        differenceCiLower?: FieldValue;
        differenceCiUpper?: FieldValue;
      }
      | undefined;
    if (bin) {
      /*
       * ⚠️ 事件数在**规范结构**里是嵌套的 `binary.experimental.events` /
       * `binary.control.events`（见 TIMEPOINT_FIELD_MAP），不是 JSON 模板里的扁平键
       * `experimentalEvents`——读错键会让事件数永远检测不到（实测踩到：2015-06 的
       * 膀胱平衡行明明有 events，却被判成"没有事件数"）。
       * 而差值三个键在规范结构里是**扁平**的 `binary.differenceEstimate` 等。
       */
      if (filled(bin.experimental?.events) || filled(bin.control?.events)) events = true;
      /*
       * 差值必须**带 95%CI** 才算"论文报告了组间差值"。
       *
       * 实测：2015-05 的 `differenceEstimate=31.5` 其实是把**试验组自己的估计值**抄进了差值格
       * （该结局各组估计值就是 31.5），没有任何 CI——若只看"填了差值"就把它当成组间差值，
       * 编码会被带到 `measurementType=2`（金标准该行是 1）。真实论文里报告的组间差值
       * （LSMD / mean difference / 率差）几乎总带 95%CI，因此用"是否有 CI"当护栏。
       */
      const hasDiff = filled(bin.differenceEstimate);
      const hasDiffCi = filled(bin.differenceCiLower) || filled(bin.differenceCiUpper);
      if (hasDiff && hasDiffCi) difference = true;
    }
  }
  if (categorical) return '8';
  if (events) return '3';
  if (difference) return '2';
  return undefined;
}

/**
 * 把反推出来的 `measurementType` 写回结局行。
 *
 * 三种情形：
 *   ① 推出来的码与现值不同 → 覆盖，并**把模型原来的答案存进 `alternatives`**；
 *   ② 判据不再成立、而现值是上一次由本函数确定性写入的 → **回退**到模型原答案（没有则回退到 1=估计值）；
 *   ③ 其余 → 不动。返回值只在真正改写时给出。
 *
 * 为什么必须能回退：判据会随实测收紧（例如"差值必须带 95%CI"）。第一版没有存原答案，
 * 收紧后 2015-01/2015-05 那 3 行被误标的 `2` 就再也退不回来了（实测踩到）。
 */
export function applyMeasurementType(row: OutcomeLevel, tps: TimepointBlocks | undefined): string | undefined {
  const code = inferMeasurementType(tps);
  const cur = row.outcome?.measurementType;
  const curCode = cur?.code ?? cur?.raw;

  const write = (next: string, evidence: FieldValue['evidence'], alternatives?: FieldValue['alternatives']): string => {
    const d = decode('measurementType', next);
    row.outcome = {
      ...(row.outcome ?? {}),
      measurementType: {
        raw: next,
        code: next,
        ...(d.meaning ? { legend: d.meaning } : {}),
        evidence,
        ...(alternatives?.length ? { alternatives } : {}),
        provenance: 'deterministic',
        confidence: 1,
      },
    };
    return next;
  };

  const derivedEvidence: FieldValue['evidence'] = [{
    kind: 'external',
    page: 1,
    bbox: null,
    quote: `由已抽取的数值形态确定性推导（存在${code === '2' ? '组间差值' : code === '3' ? '事件数' : '等级资料'}字段）`,
  }];

  if (code) {
    if (curCode === code) return undefined;
    // 覆盖：把模型原答案留档，便于日后回退
    const alts = cur?.raw
      ? [...(cur.alternatives ?? []), { raw: cur.raw, confidence: cur.confidence }]
      : cur?.alternatives;
    return write(code, cur?.evidence?.length ? cur.evidence : derivedEvidence, alts);
  }

  // 判据不再成立：只回退"我们自己写过"的值
  if (cur && cur.provenance === 'deterministic') {
    const back = cur.alternatives?.[cur.alternatives.length - 1]?.raw ?? '1';
    return write(back, cur.evidence?.length ? cur.evidence : derivedEvidence);
  }
  return undefined;
}

/** 逐时点块做确定性编码推导（estimateType / varianceType），并做变异值优先级校验。 */
export function decodeTimepointCodes(
  timepoints: TimepointBlocks | undefined,
  base: string,
  issues: Issue[],
): void {
  for (const [tpName, block] of Object.entries(timepoints ?? {})) {
    const cont = (block as { continuous?: Record<string, FieldValue> })?.continuous;
    if (!cont) continue;

    for (const key of TIMEPOINT_CODE_TARGETS) {
      const fv = cont[key];
      if (!fv || typeof fv !== 'object' || !('raw' in fv)) continue;
      const d = decode(key, fv.raw);
      if (d.code) {
        cont[key] = {
          raw: fv.raw, code: d.code,
          ...(d.meaning ? { legend: d.meaning } : {}),
          evidence: fv.evidence, provenance: 'deterministic', confidence: 1,
        } satisfies FieldValue;
      } else {
        issues.push(warn(
          `${base}.${tpName}.${key} 无法确定性编码：${d.note ?? '未知原因'}`,
          'CODE_DECODE_FAILED',
          { path: `${base}.${tpName}.${key}`, ...(fv.evidence.length ? { evidence: fv.evidence } : {}) },
        ));
      }
    }

    // 变异值类型选择校验（金标准 T3 批注的硬规则）
    const vtf = cont.varianceType;
    const vt = vtf?.code;
    if (vt && VARIANCE_PREFERENCE[vt] !== undefined && VARIANCE_PREFERENCE[vt] > 3) {
      issues.push(warn(
        `${base}.${tpName}.varianceType = ${vt}（${vtf?.legend ?? '?'}）。` +
        `按金标准应优先取标准误(1)或 95%CI(2)，请确认是否确实只有该值可用`,
        'VARIANCE_TYPE_LOW_PRIORITY',
        { path: `${base}.${tpName}.varianceType`, ...(vtf && vtf.evidence.length ? { evidence: vtf.evidence } : {}) },
      ));
    }
  }
}

/* ------------------------------ 校验 ------------------------------ */

/**
 * 时点数值块的合理性校验。
 *
 * 判据只针对"确实给了估计值"的块，避免对空块噪声报警：
 *   · 有 estimate 却没有该组 n           → 例数多半写在正文里，需要回找
 *   · 双边界型变异值只填了一半            → 真的抄漏了
 *   · 单值型变异值却填了上下限            → 多半串列了
 *   · 95%CI 不包住估计值                  → 取错了列（仅当 varianceType=2 时判定）
 */
export function validateTimepoints(
  timepoints: TimepointBlocks | undefined,
  base: string,
  issues: Issue[],
): void {
  for (const [tpName, block] of Object.entries(timepoints ?? {})) {
    const cont = (block as { continuous?: Record<string, FieldValue> & { experimental?: GroupStats; control?: GroupStats } })
      ?.continuous;
    if (!cont) continue;

    for (const side of ['experimental', 'control'] as const) {
      const nField = (cont[side] as Record<string, FieldValue> | undefined)?.n;
      if (!nField?.raw) continue;
      if (!/^\d+$/.test(nField.raw.trim())) {
        issues.push(warn(`${base}.${tpName}.${side}.n 不是整数：${nField.raw}`, 'N_NOT_INTEGER', { path: `${base}.${tpName}.${side}.n` }));
      }
    }

    const vtCode = cont.varianceType?.code;
    const twoBound = vtCode !== undefined && TWO_BOUND_VARIANCE.has(vtCode);
    for (const side of ['experimental', 'control'] as const) {
      const g = cont[side] as GroupStats | undefined;
      if (!g) continue;
      const hasEstimate = Boolean(g.estimate?.raw && !/^(NR|NA)$/i.test(g.estimate.raw));
      const hasN = Boolean(g.n?.raw && !/^(NR|NA)$/i.test(g.n.raw));
      const hasLo = Boolean(g.ciLower?.raw && !/^(NR|NA)$/i.test(g.ciLower.raw));
      const hasHi = Boolean(g.ciUpper?.raw && !/^(NR|NA)$/i.test(g.ciUpper.raw));

      if (hasEstimate && !hasN) {
        issues.push(warn(
          `${base}.${tpName}.${side}：有估计值但没有例数 n——例数常写在正文（流程/结果描述）里，请回找`,
          'TIMEPOINT_MISSING_N',
          { path: `${base}.${tpName}.${side}.n` },
        ));
      }
      if (twoBound && hasLo !== hasHi) {
        issues.push(warn(
          `${base}.${tpName}.${side}：变异值是双边界型（${cont.varianceType?.legend ?? vtCode}）却只填了一半（下限 ${hasLo ? '有' : '缺'} / 上限 ${hasHi ? '有' : '缺'}）`,
          'CI_INCOMPLETE',
          { path: `${base}.${tpName}.${side}` },
        ));
      }
      // 单值型变异指标填了上限 → 多半是把别的列串进来了
      if (!twoBound && hasLo && hasHi) {
        issues.push(warn(
          `${base}.${tpName}.${side}：变异值类型是单值型（${cont.varianceType?.legend ?? vtCode ?? '未填'}），却同时填了上下限，请确认是否串列`,
          'VARIANCE_BOTH_BOUNDS_UNEXPECTED',
          { path: `${base}.${tpName}.${side}` },
        ));
      }
    }

    /*
     * 组间差值不能等于"试验组自己的估计值"。
     *
     * 实测 2015-05：`differenceEstimate` 填成了 31.5，而该行各组自己的估计值也正是 31.5——
     * 模型把组内值抄进了差值格。真差值（LSMD / mean difference / 率差）不会恰好等于组内估计值。
     */
    const bin = (block as { binary?: Record<string, FieldValue | undefined> }).binary;
    const dEst = Number(bin?.differenceEstimate?.raw);
    const eEst = Number(cont.experimental?.estimate?.raw);
    if (Number.isFinite(dEst) && Number.isFinite(eEst) && Math.abs(dEst - eEst) < 1e-9) {
      issues.push(warn(
        `${base}.${tpName}：differenceEstimate(${dEst}) 与试验组自己的估计值相同，疑似把组内值当成了组间差值`,
        'DIFFERENCE_EQUALS_GROUP_ESTIMATE',
        { path: `${base}.${tpName}.binary.differenceEstimate` },
      ));
    }

    // 估计值与 95%CI 的数值合理性：仅当变异值**确实是 95%CI** 时才检查
    // （SD 的数值比估计值小，套用"估计值必须落在区间内"必然误报）
    const vtIsCi = vtCode === undefined || vtCode === '2';
    if (!vtIsCi) continue;    const exp = cont.experimental as GroupStats | undefined;
    const ctrl = cont.control as GroupStats | undefined;
    const est = Number(exp?.estimate?.raw);
    const lo = Number(exp?.ciLower?.raw);
    const hi = Number(exp?.ciUpper?.raw);
    if ([est, lo, hi].every(Number.isFinite)) {
      if (lo > hi) {
        issues.push(warn(`${base}.${tpName}: 试验组 CI 下限(${lo})大于上限(${hi})`, 'CI_INVERTED', { path: `${base}.${tpName}.experimental` }));
      } else if (est < lo || est > hi) {
        issues.push(warn(`${base}.${tpName}: 试验组估计值(${est})未落在 CI [${lo}, ${hi}] 内`, 'ESTIMATE_OUTSIDE_CI', { path: `${base}.${tpName}.experimental.estimate` }));
      }
    }
    const cest = Number(ctrl?.estimate?.raw);
    const clo = Number(ctrl?.ciLower?.raw);
    const chi = Number(ctrl?.ciUpper?.raw);
    if ([cest, clo, chi].every(Number.isFinite) && (clo > chi || cest < clo || cest > chi)) {
      issues.push(warn(`${base}.${tpName}: 对照组的估计值/CI 关系不合理`, 'CONTROL_ESTIMATE_INCONSISTENT', { path: `${base}.${tpName}.control` }));
    }
  }
}
