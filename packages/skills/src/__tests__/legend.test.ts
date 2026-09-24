/**
 * 图例提取器的防回归测试。
 *
 * 这个提取器踩过不少坑（表头行误判、批注列偏移、列位移校准方向搞反），
 * 因此把关键结论固化成断言，避免改动后静默退化。
 * 产物由 `pnpm legend` 生成；不存在时跳过。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../../..');
const MERGED = resolve(ROOT, 'build', 'legend', '_merged.json');
const hasData = existsSync(MERGED);

interface LegendField {
  kind: 'article' | 'study' | 'outcome';
  code: string | null;
  field: string | null;
  col: string;
  codes: Record<string, string> | null;
  requirements: string[];
  comments: { ref: string; text: string }[];
  seenIn: string[];
}

const merged = hasData
  ? (JSON.parse(readFileSync(MERGED, 'utf8')) as { stats: Record<string, unknown>; fields: LegendField[] })
  : null;

const byLabel = (re: RegExp): LegendField[] =>
  (merged?.fields ?? []).filter((f) => re.test(String(f.field ?? '') + String(f.code ?? '')));

describe.skipIf(!hasData)('legend — 提取结果', () => {
  it('覆盖全部 11 个年份', () => {
    expect(merged!.stats.years).toHaveLength(11);
  });

  it('字段数量合理（不应把数据行当表头而暴增）', () => {
    // 实测：article ~91、study ~10、outcome 151 → 去重后应在 250 上下
    expect(merged!.fields.length).toBeGreaterThan(200);
    expect(merged!.fields.length).toBeLessThan(300);
  });

  it('批注被归属到字段上（个别挂在数据行的批注除外）', () => {
    const withC = merged!.fields.filter((f) => f.comments.length);
    // 实测模板量：Sheet1 每年 9 条 + Sheet3 每年 15 条 → 去重后约 24 个字段
    expect(withC.length).toBeGreaterThanOrEqual(20);

    // 绝大多数批注必须挂在有名字段上。
    // 例外：个别批注写在数据行（如 2019 Sheet2 的 B7「不同梗塞部位」），
    // 其所在列若没有字段标签，就只能记为"未归属"——这是合理结果，不应当作失败，
    // 但必须只有极少数。
    const unnamed = withC.filter((f) => !f.field && !f.code);
    expect(
      unnamed.length,
      `有 ${unnamed.length} 条批注未归属到字段：${unnamed.flatMap((f) => f.comments.map((c) => c.ref + '=' + c.text.slice(0, 20))).join(' | ')}`,
    ).toBeLessThanOrEqual(2);
  });

  it('不得出现"数据值被当成字段名"（2023 曾出现的真实 bug）', () => {
    for (const f of merged!.fields) {
      const name = String(f.field ?? '');
      if (!name) continue;
      // 纯数值
      expect(/^-?\d+(\.\d+)?%?$/.test(name), `字段名是纯数值: ${name}`).toBe(false);
      // "1 (东方)" 这类答案选项
      expect(/^\d+\s*[（(].*[)）]$/.test(name), `字段名是答案选项: ${name}`).toBe(false);
      // 含 ± 的统计量，如 "age 48.82±13.29"
      expect(name.includes('±'), `字段名含统计量: ${name}`).toBe(false);
      // 明显是论文标题的（超长且含 "randomized controlled trial"）
      if (name.length > 90) {
        expect(/randomi[sz]ed controlled trial/i.test(name), `字段名像论文标题: ${name.slice(0, 60)}…`).toBe(false);
      }
    }
  });

  it('国家分类：图例行 + 批注合并后能给出"亚洲/非亚洲"的判定标准', () => {
    // 图例行只写 `1=东方 2=西方`，判定标准在 V2 批注里。
    // 提取器的质量门槛会过滤掉这类"仅 2~3 条的短编码表"，因此
    // 完整定义由人工维护的 tools/canonical-field-map.mjs 提供（提示词的真源）。
    // 这里断言：两者合起来必须包含判定标准，否则提示词会误导模型。
    const f = byLabel(/国家分类/)[0];
    expect(f).toBeDefined();
    const fromExtract = [...Object.values(f!.codes ?? {}), ...f!.requirements].join(' ');
    const canonical = readFileSync(resolve(ROOT, 'tools/canonical-field-map.mjs'), 'utf8');
    expect(fromExtract.includes('亚洲') || canonical.includes('亚洲国家')).toBe(true);
    expect(canonical).toContain('亚洲国家');
    expect(canonical).toContain('非亚洲国家');
  });

  it('疾病系统的编码是 18 类，且带 ICD-11 提示', () => {
    const f = byLabel(/疾病系统/)[0];
    expect(f).toBeDefined();
    expect(Object.keys(f!.codes ?? {})).toHaveLength(18);
    expect(f!.requirements.join(' ')).toContain('ICD-11');
  });

  it('期刊分类带中文期刊判定规则（来自 K2 批注）', () => {
    const f = byLabel(/期刊分类/)[0];
    expect(f).toBeDefined();
    const all = [...f!.requirements, ...Object.values(f!.codes ?? {})].join(' ');
    expect(all).toContain('中医药');
  });

  it('变异值类型带优先级规则（来自 T3 批注）', () => {
    const f = merged!.fields.find((x) => x.code === 'BTVARI');
    expect(f).toBeDefined();
    const all = [...f!.requirements, ...Object.values(f!.codes ?? {}), JSON.stringify(f!.codes ?? {})].join(' ');
    // 优先级规则必须被提取到（这是 T3 批注的核心内容）
    expect(all).toMatch(/只选择1个|只选 1 个|依次优选/);
    // 完整编码（含 `1=标准误（SE）`）由人工维护的 canonical-field-map 提供并已进提示词
    const canonical = readFileSync(resolve(ROOT, 'tools/canonical-field-map.mjs'), 'utf8');
    expect(canonical).toContain('标准误（SE）');
  });

  it('文献编号的编号规则被提取（来自 B2 批注）', () => {
    const f = merged!.fields.find((x) => x.kind === 'article' && /文献编号/.test(String(x.field)));
    expect(f).toBeDefined();
    const all = [...f!.requirements, ...Object.values(f!.codes ?? {})].join(' ');
    expect(all).toContain('EN001');
  });

  it('Sheet3 的编码名跨年稳定（同一 code 只应出现一次）', () => {
    const outcome = merged!.fields.filter((f) => f.kind === 'outcome' && f.code);
    const codes = outcome.map((f) => f.code!);
    const dup = codes.filter((c, i) => codes.indexOf(c) !== i);
    expect(dup, `重复的 outcome 编码: ${[...new Set(dup)].join(', ')}`).toEqual([]);
  });

  it('Sheet3 的时点块三个块各有一套同名字段（B/E/F 前缀）', () => {
    for (const c of ['BTESTI', 'ETESTI', 'FTESTI']) {
      expect(merged!.fields.some((f) => f.code === c), `缺 ${c}`).toBe(true);
    }
  });
});
