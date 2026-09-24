import { describe, it, expect } from 'vitest';
import { parseTableHtml, gridToMarkdown, findRowByLabel } from '../table.ts';
import { parseStudyId, articleIdOf, isStudyId, primaryKey, studyIdFromPdfName, studiesFromPdfNames } from '../ids.ts';
import { makeField, tryMakeField, EvidenceRequiredError, auditEvidence, missingSemanticsOf } from '../guards.ts';
import { numericEqual, decimalsOf } from '../values.ts';
import type { Evidence } from '../contracts.ts';

const ev = (quote: string, page = 1): Evidence => ({ kind: 'text', page, bbox: [0, 0, 10, 10], quote });

describe('ids — 研究 ID 语法', () => {
  it('解析文章级与比较组级 ID', () => {
    expect(parseStudyId('2015-01')).toEqual({ year: '2015', articleNo: '01', comparisonNo: null });
    expect(parseStudyId('2015-04-01')).toEqual({ year: '2015', articleNo: '04', comparisonNo: '01' });
  });

  it('归约文章号不能用"剪掉最后一段"——这是真实踩过的 bug', () => {
    // 曾用 id.replace(/-\d{2}$/, '')，把 2015-01 剪成了 2015
    expect(articleIdOf('2015-01')).toBe('2015-01');
    expect(articleIdOf('2015-04-01')).toBe('2015-04');
    expect(articleIdOf('2015-04-02')).toBe('2015-04');
    // 单篇文章的 3 段 ID 也必须正确
    expect(articleIdOf('2021-23')).toBe('2021-23');
  });

  it('容忍 2015 文件名里的多余前导连字符', () => {
    expect(studyIdFromPdfName('-2015-01.pdf')).toBe('2015-01');
    expect(studyIdFromPdfName('2024-12-03.pdf')).toBe('2024-12-03');
    expect(studyIdFromPdfName('random.pdf')).toBeNull();
  });

  it('主键包含年份——2022/2024 存在跨年份重名 ID', () => {
    // 实测：2022 表里的 2024-05 与 2024 表里的 2024-05 是两篇不同文章
    expect(primaryKey('2022', '2024-05')).not.toBe(primaryKey('2024', '2024-05'));
  });

  it('拒绝非法 ID', () => {
    expect(isStudyId('EN009')).toBe(false);
    expect(isStudyId('2015')).toBe(false);
    expect(parseStudyId('abc')).toBeNull();
  });
});

describe('values — 数值判等口径', () => {
  it('允许书写精度差异（这是它存在的意义）', () => {
    expect(numericEqual('41', '41.0')).toBe(true);
    expect(numericEqual('-41', '-41.0')).toBe(true);
    expect(numericEqual('0.175', '0.18')).toBe(true);
    expect(numericEqual('1,234', '1234')).toBe(true);
    expect(numericEqual('−41', '-41')).toBe(true);
  });

  it('绝不放过大数值的实质差异——曾用"相对容差 0.5%"把 2015 与 2018 判成相等', () => {
    // 老口径：|2018-2015| = 3 <= 2015*0.005 = 10.075 → 判"命中"，publication_year 因此虚高
    expect(numericEqual('2015', '2018')).toBe(false);
    expect(numericEqual('2017', '2016')).toBe(false);
    // 例数、总次数这类整数也必须严格
    expect(numericEqual('1000', '1005')).toBe(false);
    expect(numericEqual('140', '141')).toBe(false);
    // 但同一数量级的合理舍入仍算对
    expect(numericEqual('1000', '1000.0')).toBe(true);
  });

  it('非数值一律返回 false（交给文本/编码规则）', () => {
    expect(numericEqual('NR', 'NR')).toBe(false);
    expect(numericEqual('2 months', '2')).toBe(false);
    expect(numericEqual('', '1')).toBe(false);
    expect(numericEqual(undefined, 1)).toBe(false);
  });
});

describe('ids — 从文件名清单确定"要跑哪些研究"', () => {
  /*
   * 实测事故（2024-12，全语料准确率最低）：
   * Datas 里同时有 `2024-12.pdf`（9 页正文）与 `2024-12-01.pdf`…`2024-12-04.pdf`（各 1 页附件）。
   * 旧实现把 `2024-12-01` 也当成一篇研究，而 articleIdOf('2024-12-01') = '2024-12'，
   * 于是附件那一次写进了正文的产物文件、把正文覆盖掉 → 结局计划为空、26 行金标准只配上 2 行。
   */
  it('只把整串形如 YYYY-N 的文件当作正文，附件不算', () => {
    const { studies, skipped } = studiesFromPdfNames([
      '2024-12.pdf', '2024-12-01.pdf', '2024-12-02.pdf', '2024-12-03.pdf', '2024-12-04.pdf',
      '2024-24.pdf', '2024-24-sup.pdf', '2022-06-sup.pdf', 'txt.pdf', 'notes.txt',
    ]);
    expect(studies.map((s) => s.studyId)).toEqual(['2024-12', '2024-24']);
    expect(skipped).toEqual([
      '2024-12-01.pdf', '2024-12-02.pdf', '2024-12-03.pdf', '2024-12-04.pdf',
      '2024-24-sup.pdf', '2022-06-sup.pdf', 'txt.pdf',
    ]);
  });

  it('保留真实文件名（2015 带前导连字符；服务端要用它定位 PDF）', () => {
    const { studies } = studiesFromPdfNames(['-2015-01.pdf', '-2015-02.pdf']);
    expect(studies).toEqual([
      { studyId: '2015-01', file: '-2015-01.pdf' },
      { studyId: '2015-02', file: '-2015-02.pdf' },
    ]);
  });

  it('容忍 2015 的前导连字符，并对重复研究号去重', () => {
    const { studies } = studiesFromPdfNames(['-2015-01.pdf', '2015-01.pdf', '2015-02.pdf']);
    expect(studies.map((s) => s.studyId)).toEqual(['2015-01', '2015-02']);
  });

  it('附件不会被归约成正文号（否则就会覆盖正文产物）', () => {
    for (const f of ['2024-12-01.pdf', '2024-24-sup.pdf']) {
      const { studies } = studiesFromPdfNames([f]);
      expect(studies).toEqual([]);
    }
  });
});

describe('table — HTML 网格解析', () => {
  it('解析真实 MinerU 输出（含 colspan/rowspan）', () => {
    // 取自 build/mineru/2015/-2015-01/txt content_list 的真实 table_body 片段
    const html =
      '<table><tr><td></td><td colspan="3">Per protocol</td><td colspan="9"></td></tr>' +
      '<tr><td></td><td colspan="3">Acupuncture</td><td colspan="3">Sham</td>' +
      '<td colspan="3">Acupuncture n=80</td><td colspan="5">Sham n=82</td></tr>' +
      '<tr><td>Differences</td><td>n</td><td>MRC (%)</td><td>95% CI</td></tr></table>';

    const t = parseTableHtml(html);
    expect(t.rows).toBe(3);
    expect(t.warnings).toEqual([]);
    // header 行的 colspan 必须被展开为占位
    expect(t.grid[0]![1]).toBe('Per protocol');
    expect(t.grid[0]!.length).toBeGreaterThanOrEqual(14);
    // 第 3 行应能按标签找到
    const row = findRowByLabel(t, 'Differences', { labelCols: 1 });
    expect(row).not.toBeNull();
    expect(row!.values.slice(0, 3)).toEqual(['n', 'MRC (%)', '95% CI']);
  });

  it('展开 rowspan 占位', () => {
    const t = parseTableHtml('<table><tr><td rowspan="2">A</td><td>B</td></tr><tr><td>C</td></tr></table>');
    expect(t.grid[0]![0]).toBe('A');
    expect(t.grid[1]![0]).toBe('');   // 被 A 的 rowspan 占用
    expect(t.grid[1]![1]).toBe('C');
  });

  it('剥离内联标签但保留文本', () => {
    const t = parseTableHtml('<table><tr><td>Eva<sub>l</sub>uation</td></tr></table>');
    expect(t.grid[0]![0]).toBe('Evaluation');
  });

  it('解码实体', () => {
    const t = parseTableHtml('<table><tr><td>p&lt;0.05 &amp; n&gt;10</td></tr></table>');
    expect(t.grid[0]![0]).toBe('p<0.05 & n>10');
  });

  it('空表格不抛错，但给出 warning', () => {
    const t = parseTableHtml('');
    expect(t.rows).toBe(0);
    expect(t.warnings.length).toBeGreaterThan(0);
  });

  it('渲染 Markdown 供 LLM 使用', () => {
    const t = parseTableHtml('<table><tr><td>H1</td><td>H2</td></tr><tr><td>1</td><td>2</td></tr></table>');
    const md = gridToMarkdown(t.grid);
    expect(md).toContain('| H1 | H2 |');
    expect(md).toContain('| 1 | 2 |');
  });
});

describe('guards — 证据不变量', () => {
  it('无证据必须抛错（不允许产出无法复核的字段）', () => {
    expect(() => makeField('x.y', { raw: '1', evidence: [], provenance: 'model', confidence: 0.9 }))
      .toThrow(EvidenceRequiredError);
    expect(tryMakeField('x.y', { raw: '1', evidence: [], provenance: 'model', confidence: 0.9 }))
      .toBeUndefined();
  });

  it('证据必须带非空 quote', () => {
    expect(() => makeField('x.y', { raw: '1', evidence: [ev('  ')], provenance: 'model', confidence: 0.9 }))
      .toThrow(/缺少 quote/);
  });

  it('confidence 越界要拒绝', () => {
    expect(() => makeField('x.y', { raw: '1', evidence: [ev('a')], provenance: 'model', confidence: 1.5 }))
      .toThrow(/越界/);
  });

  it('识别金标准里的缺失哨兵 NR / NA', () => {
    expect(missingSemanticsOf('NR')).toBe('not_reported');
    expect(missingSemanticsOf('na')).toBe('not_applicable');
    expect(missingSemanticsOf('')).toBe('empty');
    expect(missingSemanticsOf('fibromyalgia')).toBeUndefined();
  });

  it('构造出的字段保留 raw 原貌并归一化空白', () => {
    const f = makeField('x.y', { raw: '  one   per week ', evidence: [ev('one per week')], provenance: 'model', confidence: 0.8 });
    expect(f.raw).toBe('one per week');
    expect(f.missing).toBeUndefined();
  });

  it('auditEvidence 能找出漏带证据的字段', () => {
    const doc = {
      ok: { raw: '1', evidence: [ev('1')] },
      bad: { raw: '2', evidence: [] },
      nested: { deep: { alsoBad: { raw: '3', evidence: [] } } },
    };
    const bad = auditEvidence(doc);
    expect(bad).toContain('$.bad');
    expect(bad).toContain('$.nested.deep.alsoBad');
    expect(bad).not.toContain('$.ok');
  });
});
