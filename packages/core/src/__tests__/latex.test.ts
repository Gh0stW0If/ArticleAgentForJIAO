/**
 * `deLatex` —— MinerU 公式误触发的清洗。
 *
 * 用例**全部取自真实产物**（`build/mineru/**\/txt/*_middle.json` 的 `<eq>` 片段），
 * 不是编造的字符串——这些形态来自 `tools/latex_shapes.mjs` 的骨架统计（前 6 大骨架占了一半以上）。
 */

import { describe, expect, it } from 'vitest';
import { deLatex, hasLatex } from '../latex.js';
import { parseTableHtml } from '../table.js';

describe('deLatex — 真实产物里的形态', () => {
  it('mean ± SD（最高频骨架，981+606+340+294+210+202 次）', () => {
    expect(deLatex('<eq>4 1 . 7 5 \\pm 1 1 . 1 5</eq>')).toContain('41.75 ± 11.15');
    expect(deLatex('<eq>2 . 3 2 \\pm 0 . 6 2</eq>')).toContain('2.32 ± 0.62');
    expect(deLatex('<eq>1 3 0 . 7 1 \\pm 1 4 . 9 7</eq>')).toContain('130.71 ± 14.97');
    expect(deLatex('<eq>1 6 5 9 \\pm 5 4 2</eq>')).toContain('1659 ± 542');
  });

  it('P 值 / t 值（前导小数点与负号）', () => {
    expect(deLatex('<eq>P = . 8 0 9</eq>')).toContain('.809');
    expect(deLatex('<eq>t = - 0 . 2 4 3</eq>')).toContain('-0.243');
    expect(deLatex('p = 0 . 0 1 9')).toContain('0.019');
  });

  it('括号里的 n', () => {
    expect(deLatex('<eq>( \\boldsymbol { \\mathrm { n } } = 8 8 )</eq>')).toContain('n = 88');
  });

  it('array 环境里的 χ²', () => {
    const s = deLatex('<eq>\\begin{array} { r } { \\chi ^ { 2 } = 0 . 7 3 7 } \\\\ { \\chi ^ { 2 } = 3 . 7 6 9 } \\end{array}</eq>');
    expect(s).toContain('0.737');
    expect(s).toContain('3.769');
    expect(s).not.toContain('begin');
  });

  it('置信区间（\\left \\right + \\mathrm{to} + \\sharp 脚注标记）', () => {
    const s = deLatex('- 3 . 6 \\left( - 4 . 6 \\mathrm { t o } - 2 . 6 \\right) ^ { \\sharp }');
    expect(s).toContain('-3.6');
    expect(s).toContain('-4.6');
    expect(s).toContain('to');
    expect(s).toContain('-2.6');
    expect(s).toContain('†');
  });

  it('字体命令包裹的单字母（旧 \\tt 风格）', () => {
    expect(deLatex('\\mathtt { m e a n } \\pm \\mathtt { S D }')).toContain('mean ± SD');
  });

  it('下标里的数字', () => {
    expect(deLatex('_ { 0 . 0 0 1 }')).toContain('0.001');
  });

  it('置信区间括号与区间号（不粘连两侧独立数字）', () => {
    const s = deLatex('( 1 1 . 9 8 – 1 4 . 3 8 )');
    expect(s).toContain('11.98');
    expect(s).toContain('14.38');
  });

  it('运算符两侧的数字各自独立', () => {
    const s = deLatex('3 3 + 2 0');
    expect(s).toContain('33');
    expect(s).toContain('20');
    expect(s).not.toContain('3320');
    const r = deLatex('3 { - } 4');
    expect(r).toContain('3');
    expect(r).toContain('4');
    expect(r).not.toContain('34');
  });

  it('\\%~ 等杂项命令不残留', () => {
    expect(deLatex('1 0 0 \\%')).toContain('100 %');
    expect(deLatex('0 . 9 7 ~ \\pm ~ 1 . 6 9')).toContain('0.97 ± 1.69');
  });
});

describe('deLatex — 安全护栏（宁可少做，不可造错）', () => {
  it('不跨表格单元格分隔符（\\t）粘合数字', () => {
    /* 材料里单元格以 \t 分隔；若用 \s+ 就会把两格的 35 与 38 粘成 3538 */
    const s = deLatex('Has family history of SAR\t35\t38\tP = .647');
    expect(s).toContain('35');
    expect(s).toContain('38');
    expect(s).not.toContain('3538');
  });

  it('不跨换行粘合数字', () => {
    const s = deLatex('n = 20\n30 patients');
    expect(s).toContain('20');
    expect(s).toContain('30');
    expect(s).not.toContain('2030');
  });

  it('普通英文原样通过', () => {
    for (const s of [
      'There was no difference between the two groups.',
      'Table 1 shows the baseline characteristics of participants.',
      'Patients were randomised 1:1 to acupuncture or sham.',
    ]) expect(deLatex(s)).toBe(s);
  });

  it('单字母粘合只在 LaTeX 语境生效（普通英文的 a b 不被粘）', () => {
    expect(deLatex('group a b')).toBe('group a b');
  });

  it('不臆造内容：.809 不补成 0.809', () => {
    expect(deLatex('<eq>P = . 8 0 9</eq>')).not.toContain('0.809');
  });

  it('句点 + 数字不误粘（Table 1. 2 / vs. 20 / Fig. 3）', () => {
    expect(deLatex('Table 1. 2 patients were excluded')).toContain('1. 2');
    expect(deLatex('acupuncture vs. 20 sham')).toContain('vs. 20');
    expect(deLatex('shown in Fig. 3 below')).toContain('Fig. 3');
  });

  it('幂等', () => {
    const cases = [
      '<eq>4 1 . 7 5 \\pm 1 1 . 1 5</eq>',
      '\\mathtt { m e a n } \\pm \\mathtt { S D }',
      '\\begin{array} { r } { \\chi ^ { 2 } = 0 . 7 3 7 } \\end{array}',
      'no difference between the groups',
    ];
    for (const c of cases) {
      const once = deLatex(c);
      expect(deLatex(once)).toBe(once);
    }
  });

  it('空串与无 LaTeX 文本不报错', () => {
    expect(deLatex('')).toBe('');
    expect(hasLatex('plain text')).toBe(false);
    expect(hasLatex('<eq>1</eq>')).toBe(true);
    expect(hasLatex('$x$')).toBe(true);
    expect(hasLatex('\\pm')).toBe(true);
  });
});

describe('parseTableHtml — 表格网格里数值已是原文', () => {
  it('<eq> 单元格被清洗成可读数值', () => {
    const html = '<table><tr><td>Age (y), mean ± SD</td><td><eq>4 1 . 7 5 \\pm 1 1 . 1 5</eq></td>'
      + '<td><eq>4 2 . 1 6 \\pm 1 1 . 2 6</eq></td></tr></table>';
    const t = parseTableHtml(html);
    expect(t.grid[0]![1]).toBe('41.75 ± 11.15');
    expect(t.grid[0]![2]).toBe('42.16 ± 11.26');
  });
});
