/**
 * tools/outcome-field-map.test.mjs — Sheet3 字段标题映射的**防漂移**测试
 *
 * 这张映射表（契约路径 → 规范键 + 中文名）是**手写的**，而真源在 `@aa/skills`
 * （`buildOutcomeMetaPathMap` / `buildOutcomeIdentityPathMap` / `buildOutcomeValuePathMap`）。
 * 手写表的经典失败方式是"悄悄漏了一项"——界面就退回显示契约路径，
 * 正是这次要修的问题。所以这里**逐条交叉核对**：契约里有的，映射表必须都能认出来。
 *
 * 注意用 `@aa/skills`（vitest 别名指向**源码**），而不是 `packages/skills/dist`——
 * dist 不入库，新克隆的仓库直接跑测试会找不到。
 */

import { describe, it, expect } from 'vitest';
import {
  buildOutcomeIdentityPathMap,
  buildOutcomeMetaPathMap,
  buildOutcomeValuePathMap,
  TIMEPOINTS,
} from '@aa/skills';
import { labelOutcomeField, leafZh } from './outcome-field-map.mjs';

/** 真源里出现的全部（契约路径，期望规范键）。 */
function contractPairs() {
  const tp = Object.keys(TIMEPOINTS);
  const out = [];
  for (const fn of [buildOutcomeIdentityPathMap, buildOutcomeMetaPathMap, buildOutcomeValuePathMap]) {
    for (const [jsonKey, path] of Object.entries(fn(0, tp))) {
      // jsonKey 形如 `outcomes.0.outcomeName` / `values.0.baseline.continuous.experimentalEstimate`
      out.push({ path, key: jsonKey.split('.').pop() });
    }
  }
  return out;
}

describe('outcome-field-map — 与 @aa/skills 契约逐条对齐', () => {
  const pairs = contractPairs();

  it('契约非空（否则下面的断言会假通过）', () => {
    expect(pairs.length).toBeGreaterThan(40);
    // identity 与 meta 都含 `outcome.name` / `outcome.instrument`，所以路径会有 2 条重复
    expect(new Set(pairs.map((p) => p.path)).size).toBeGreaterThan(40);
  });

  it('契约里的每一条都能认出规范键（漏一条界面就会退回显示契约路径）', () => {
    const missing = pairs.filter((p) => labelOutcomeField(p.path)?.key !== p.key)
      .map((p) => `${p.path} 期望 ${p.key} 实得 ${labelOutcomeField(p.path)?.key ?? 'null'}`);
    expect(missing).toEqual([]);
  });

  it('每条都给出中文名，且不是原样回显契约路径', () => {
    for (const p of pairs) {
      const got = labelOutcomeField(p.path);
      expect(got?.label, p.path).toBeTruthy();
      expect(got.label, p.path).not.toBe(p.path);
      // 中文名里不该再出现驼峰或点号（`construct`/`subconstruct` 是原表就这么写的，例外）
      if (!['construct', 'subconstruct'].includes(got.label)) {
        expect(got.label, p.path).not.toMatch(/[a-z][A-Z]|\./);
      }
    }
  });

  it('三个时点的同一字段标题互不相同（否则一行里分不清是哪一块）', () => {
    const leaves = pairs.filter((p) => p.path.startsWith('timepoints.')).map((p) => p.path.replace(/^timepoints\.\w+\./, ''));
    for (const leaf of new Set(leaves)) {
      const labels = Object.keys(TIMEPOINTS).map((tp) => labelOutcomeField(`timepoints.${tp}.${leaf}`)?.label);
      expect(new Set(labels).size, leaf).toBe(labels.length);
    }
  });
});

describe('outcome-field-map — 具体样例', () => {
  it('结局自身字段：中文名 + 规范键', () => {
    expect(labelOutcomeField('outcome.name')).toEqual({ key: 'outcomeName', label: '结局名称' });
    expect(labelOutcomeField('outcome.measurementType')).toEqual({ key: 'measurementType', label: '测量类型' });
    expect(labelOutcomeField('followUp.value')).toEqual({ key: 'followUpValue', label: '本结局随访时间数值' });
    expect(labelOutcomeField('armNumber')).toEqual({ key: 'armNumber', label: '研究组别的数量' });
  });

  it('原表里就叫 construct / subconstruct，保持英文（不硬翻成中文）', () => {
    expect(labelOutcomeField('outcome.constructCode')?.label).toBe('construct');
    expect(labelOutcomeField('outcome.subconstructCode')?.label).toBe('subconstruct');
  });

  it('时点字段：标题带时点与类型，规范键是驼峰字段名', () => {
    expect(labelOutcomeField('timepoints.baseline.continuous.experimental.estimate')).toEqual({
      key: 'experimentalEstimate',
      label: '基线期 · 连续型变量 · 试验组效应量',
      timepoint: 'baseline',
      kind: 'continuous',
    });
    expect(labelOutcomeField('timepoints.endOfTreatment.binary.experimental.events')?.label)
      .toBe('疗程结束时 · 二分类变量 · 试验组事件数');
    expect(labelOutcomeField('timepoints.followUpEnd.categorical.control.cat3')?.label)
      .toBe('随访结束时 · 等级资料 · 对照组第 3 级');
  });

  it('同一叶子在连续型与等级资料里键名相同、标题不同（例数）', () => {
    expect(labelOutcomeField('timepoints.baseline.continuous.experimental.n')?.key).toBe('experimentalN');
    expect(labelOutcomeField('timepoints.baseline.categorical.experimental.n')?.key).toBe('experimentalN');
    expect(labelOutcomeField('timepoints.baseline.continuous.experimental.n')?.label)
      .not.toBe(labelOutcomeField('timepoints.baseline.categorical.experimental.n')?.label);
  });

  it('带 outcomes.<下标> 前缀也能认（界面拿到的是完整 fieldPath）', () => {
    expect(labelOutcomeField('outcomes.3.outcome.name')?.label).toBe('结局名称');
    expect(labelOutcomeField('outcomes.0.timepoints.baseline.continuous.varianceType')?.key).toBe('varianceType');
  });

  it('认不出来返回 null，由调用方退回原路径（不静默编造标题）', () => {
    expect(labelOutcomeField('some.unknown.field')).toBeNull();
    expect(labelOutcomeField('')).toBeNull();
    expect(labelOutcomeField(undefined)).toBeNull();
  });

  it('leafZh 兜底：表里没有的叶子返回叶子本身，而不是抛错', () => {
    expect(leafZh('continuous.estimateType')).toBe('效应量类型');
    expect(leafZh('nonsense.leaf')).toBe('nonsense.leaf');
  });
});
