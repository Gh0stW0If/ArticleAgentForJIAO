/**
 * 单位归一化：解析、换算、同量判定。
 *
 * 用例全部取自**金标准真实取值**（`build/gold/*.json` 的 `_desc` 与 `_value`/`_unit` 三列）。
 * 特别钉住"1 月 = 4 周"这个**项目约定**——用物理常数会与金标准系统性不符。
 */

import { describe, expect, it } from 'vitest';
import { CANONICAL_UNITS, convert, parseQuantity, quantityEqual, SECONDS_PER } from '../units.js';

describe('units — 解析', () => {
  it('数字 + 单位（金标准里最常见的形态）', () => {
    expect(parseQuantity('9 weeks')).toMatchObject({ value: 9, unit: '周', isRange: false });
    expect(parseQuantity('3 months')).toMatchObject({ value: 3, unit: '月' });
    expect(parseQuantity('30 min')).toMatchObject({ value: 30, unit: '分钟' });
    expect(parseQuantity('24 hours')).toMatchObject({ value: 24, unit: '小时' });
    expect(parseQuantity('12 hours')).toMatchObject({ value: 12, unit: '小时' });
  });

  it('英文数词', () => {
    expect(parseQuantity('four weeks')).toMatchObject({ value: 4, unit: '周' });
    expect(parseQuantity('one hour')).toMatchObject({ value: 1, unit: '小时' });
  });

  it('范围写法：取低值并标 isRange', () => {
    const q = parseQuantity('15-20 min');
    expect(q).toMatchObject({ value: 15, unit: '分钟', isRange: true, rangeHigh: 20 });
  });

  it('中文单位', () => {
    expect(parseQuantity('30分钟')).toMatchObject({ value: 30, unit: '分钟' });
    expect(parseQuantity('2 周')).toMatchObject({ value: 2, unit: '周' });
  });

  it('解析不出来返回 null（不猜）', () => {
    for (const s of ['NR', 'NA', '', 'during the procedure of survey', 'trimester abortion']) {
      expect(parseQuantity(s)).toBeNull();
    }
  });
});

describe('units — 换算约定（必须与金标准一致）', () => {
  it('1 月 = 4 周（金标准实测约定，不是物理值 4.345）', () => {
    expect(SECONDS_PER['月']).toBe(4 * SECONDS_PER['周']);
    expect(convert(parseQuantity('3 months')!.seconds, '周')).toBe(12);
    expect(convert(parseQuantity('6 months')!.seconds, '周')).toBe(24);
  });

  it('1 周 = 7 天、1 天 = 24 小时、1 小时 = 60 分钟', () => {
    expect(convert(parseQuantity('2 weeks')!.seconds, '天')).toBe(14);
    expect(convert(parseQuantity('24 hours')!.seconds, '天')).toBe(1);
    expect(convert(parseQuantity('0.5 h')!.seconds, '分钟')).toBe(30);
  });

  it('1 年 = 12 月 = 48 周（项目约定）', () => {
    expect(convert(parseQuantity('1 year')!.seconds, '周')).toBe(48);
  });
});

describe('units — 同量判定（把 LLM 语义判定换成确定性比对）', () => {
  it('同量异单位 → 相等（这些原本要送 LLM 判）', () => {
    expect(quantityEqual('3 months', '12 weeks')).toBe(true);
    expect(quantityEqual('30 min', '0.5 hours')).toBe(true);
    expect(quantityEqual('24 hours', '1 day')).toBe(true);
    expect(quantityEqual('2 weeks', '14 days')).toBe(true);
    expect(quantityEqual('four weeks', '4 weeks')).toBe(true);
  });

  it('真的不同量 → 不等', () => {
    expect(quantityEqual('20 weeks', '24 months')).toBe(false);
    expect(quantityEqual('9 days', '28 days')).toBe(false);
    expect(quantityEqual('12 weeks', '12 months')).toBe(false);
  });

  it('范围与点值：区间相交即认为一致（只能确定到这一步）', () => {
    expect(quantityEqual('15-20 min', '18 min')).toBe(true);
    expect(quantityEqual('15-20 min', '60 min')).toBe(false);
  });

  it('解析不了的一侧 → 不判等（交给语义判定）', () => {
    const pairs: [string, string][] = [['NR', '30 min'], ['until delivery', '4 weeks'], ['30 min', 'NR']];
    for (const [a, b] of pairs) expect(quantityEqual(a, b)).toBe(false);
  });
});

describe('units — 规范单位表', () => {
  it('编码含义取自原始 Excel 表头', () => {
    const mf = CANONICAL_UNITS.find((u) => u.field === 'max_followup')!;
    /* 关键：2=月、4=周。实测 44 条金标准把"周"编成了 2，那是标注问题，不能改这张表 */
    expect(mf.codes['2']).toBe('月');
    expect(mf.codes['4']).toBe('周');    expect(CANONICAL_UNITS.find((u) => u.field === 'needle_retention')!.canonical).toBe('分钟');
    expect(CANONICAL_UNITS.find((u) => u.field === 'insertion_depth')!.canonical).toBe('毫米');
  });
});
