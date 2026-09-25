/**
 * tools/outcome-field-map.mjs — Sheet3（结局层）**契约路径 → 规范键 + 中文名**
 *
 * ===== 为什么需要它 =====
 * 抽取产物里走的是 `@aa/skills` 的**契约路径**：
 *   `outcome.name`、`outcome.measurementType`、
 *   `timepoints.baseline.continuous.experimental.estimate` …
 * 而界面/导出要用的是**规范键**（`outcomeName` / `measurementType` / `experimentalEstimate`）
 * 才能查到原始表头（`sheets.headerOf`）、按原表列序排序、填导出的「原始列」。
 *
 * 两者对不上时，界面只能把契约路径本身当标题显示出来 —— 实测就是这样：
 * Sheet3 的字段名全是 `outcome.name`、`timepoints.baseline.continuous.experimental.estimate`，
 * 而 Sheet1 是「题目 / 发表年份」。本次修正即为此。
 *
 * ===== 权威来源 =====
 * 键名取自 `packages/skills`（契约真源）：`buildOutcomeMetaPathMap` /
 * `buildOutcomeIdentityPathMap` / `buildOutcomeValuePathMap`，由
 * `tools/outcome-field-map.test.mjs` **交叉核对**——表漏了或多了，测试会红，
 * 免得又变成"多份 schema 各自漂移"（见 docs/14）。
 *
 * 中文名复用 `tools/lib/field_labels.mjs` 的 `BLOCK_FIELD_ZH`（那本就是给医生看的列名表）。
 */

import { camelToSnake } from './lib/keys.mjs';
import { BLOCK_FIELD_ZH } from './lib/field_labels.mjs';
import { OUTCOME_TOP_FIELDS } from './canonical-field-map.mjs';

/** 结局自身 / 顶层字段：契约路径 → 规范键。 */
const TOP_KEY = {
  'outcome.name': 'outcomeName',
  'outcome.instrument': 'instrument',
  armNumber: 'armNumber',
  'outcome.constructCode': 'construct',
  'outcome.subconstructCode': 'subconstruct',
  'outcome.pValueRange': 'pValueRange',
  'outcome.pValue': 'pValue',
  'outcome.measurementRange': 'measurementRange',
  'outcome.measurementDirection': 'measurementDirection',
  'outcome.measurementUnit': 'measurementUnit',
  'outcome.measurementType': 'measurementType',
  'outcome.baselineAdjusted': 'baselineAdjusted',
  'outcome.primaryOutcomeTimepoint': 'primaryOutcomeTimepoint',
  'followUp.description': 'followUpDescription',
  'followUp.value': 'followUpValue',
  'followUp.unit': 'followUpUnit',
};

/** 时点块：契约叶子（`timepoints.<时点>.` 之后的部分）→ 规范键。 */
const LEAF_KEY = {
  // 连续型
  'continuous.estimateType': 'estimateType',
  'continuous.varianceType': 'varianceType',
  'continuous.experimental.estimate': 'experimentalEstimate',
  'continuous.experimental.ciLower': 'experimentalCiLower',
  'continuous.experimental.ciUpper': 'experimentalCiUpper',
  'continuous.experimental.n': 'experimentalN',
  'continuous.control.estimate': 'controlEstimate',
  'continuous.control.ciLower': 'controlCiLower',
  'continuous.control.ciUpper': 'controlCiUpper',
  'continuous.control.n': 'controlN',
  // 二分类
  'binary.experimental.events': 'experimentalEvents',
  'binary.experimental.n': 'experimentalN',
  'binary.control.events': 'controlEvents',
  'binary.control.n': 'controlN',
  'binary.differenceEstimate': 'differenceEstimate',
  'binary.differenceCiLower': 'differenceCiLower',
  'binary.differenceCiUpper': 'differenceCiUpper',
  // 等级资料
  'categorical.classificationMethod': 'classificationMethod',
  'categorical.experimental.cat1': 'cat1Experimental',
  'categorical.experimental.cat2': 'cat2Experimental',
  'categorical.experimental.cat3': 'cat3Experimental',
  'categorical.experimental.cat4': 'cat4Experimental',
  'categorical.experimental.cat5': 'cat5Experimental',
  'categorical.experimental.cat6': 'cat6Experimental',
  'categorical.experimental.n': 'experimentalN',
  'categorical.control.cat1': 'cat1Control',
  'categorical.control.cat2': 'cat2Control',
  'categorical.control.cat3': 'cat3Control',
  'categorical.control.cat4': 'cat4Control',
  'categorical.control.cat5': 'cat5Control',
  'categorical.control.cat6': 'cat6Control',
  'categorical.control.n': 'controlN',
};

/**
 * `BLOCK_FIELD_ZH` 里没有的少数叶子，直接按契约叶子补。
 *
 * 为什么不让 `camelToSnake` 兜住：`cat1` 会被数字规则拆成 `cat_1`
 * （见 `tools/lib/keys.mjs` 的说明），与那张表的键对不上。
 */
const EXTRA_LEAF_ZH = {
  'categorical.experimental.cat1': '试验组第 1 级',
  'categorical.experimental.cat2': '试验组第 2 级',
  'categorical.experimental.cat3': '试验组第 3 级',
  'categorical.experimental.cat4': '试验组第 4 级',
  'categorical.experimental.cat5': '试验组第 5 级',
  'categorical.experimental.cat6': '试验组第 6 级',
  'categorical.control.cat1': '对照组第 1 级',
  'categorical.control.cat2': '对照组第 2 级',
  'categorical.control.cat3': '对照组第 3 级',
  'categorical.control.cat4': '对照组第 4 级',
  'categorical.control.cat5': '对照组第 5 级',
  'categorical.control.cat6': '对照组第 6 级',
};

/** 时点 → 中文（与金标准三块的列名一致）。 */
const TP_ZH = { baseline: '基线期', endOfTreatment: '疗程结束时', followUpEnd: '随访结束时' };
/** 块内变量类型 → 中文（对应原表的分组表头）。 */
const KIND_ZH = { continuous: '连续型变量', binary: '二分类变量', categorical: '等级资料' };

/** 规范键 → 中文（顶层字段直接取规范清单里的 label；`construct` 等本就该显示英文，与原表一致）。 */
const TOP_LABEL = new Map(OUTCOME_TOP_FIELDS.map((f) => [f.key, f.label ?? f.key]));

/** 时点块字段的中文名。 */
export function leafZh(leaf) {
  return EXTRA_LEAF_ZH[leaf] ?? BLOCK_FIELD_ZH[camelToSnake(leaf)] ?? leaf;
}

/**
 * 契约相对路径 → `{ key, label }`。认不出来返回 null（调用方退回原路径，不静默改数据）。
 *
 * @param {string} rel 形如 `outcome.name` / `followUp.value` / `timepoints.baseline.continuous.experimental.estimate`
 * @returns {{ key: string, label: string, timepoint?: string, kind?: string } | null}
 */
export function labelOutcomeField(rel) {
  const s = String(rel ?? '').replace(/^outcomes\.\d+\./, '');
  if (!s) return null;

  const tp = /^timepoints\.(\w+)\.(\w+)\.(.+)$/.exec(s);
  if (tp) {
    const [, point, kind, leaf] = tp;
    const key = LEAF_KEY[`${kind}.${leaf}`] ?? leaf.split('.').pop();
    /*
     * 三个时点在同一行里，标题必须带上时点，否则「试验组效应量」会出现三次分不清。
     * 类型也带上：`experimentalN` 在连续型与等级资料里都存在。
     */
    const label = [TP_ZH[point] ?? point, KIND_ZH[kind] ?? kind, leafZh(`${kind}.${leaf}`)].join(' · ');
    return { key, label, timepoint: point, kind };
  }

  const key = TOP_KEY[s];
  if (!key) return null;
  return { key, label: TOP_LABEL.get(key) ?? key };
}
