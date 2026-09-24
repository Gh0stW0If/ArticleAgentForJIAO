/**
 * MinerU 的**公式误触发**清洗：把被 LaTeX 包坏的数字还原成人能读、模型也能读的原文。
 *
 * ── 问题（实测，见 `docs/13-mineru-latex-noise.md`）─────────────────
 * MinerU 3.4.5 的公式模块会把**普通数字**判成行内公式，于是表格里的
 * `41.75 ± 11.15` 被输出成 LaTeX `4 1 . 7 5 \pm 1 1 . 1 5`：
 *   · middle.json 的 table_body span 用 `<eq>…</eq>` 包裹；
 *   · markdown 用 `$…$` 包裹；段落 span 的 `content` 里则是**裸 LaTeX**（无定界符）。
 * 全库扫描（`tools/latex_noise.mjs`）：
 *   **180 / 224 篇（80.4%）受影响**；879 张表里 290 张的数字被拆散；
 *   5,381 个 `<eq>` 片段里 **4,423 个（82.2%）**含"数字被空格拆散"。
 * 形态高度集中：前 6 大骨架全是 `mean ± SD`（`2 . 3 2 \pm 0 . 6 2`）——**正是我们要抽的数值**。
 *
 * 后果：喂给模型的材料里，一个 `41.75` 变成四个孤立数字 `4`、`1`、`7`、`5`，
 * 模型要么抄成 `4`，要么答 `NR`。**这不是模型没找到，是源头把数字切碎了。**
 *
 * ── 设计取舍 ─────────────────────────────────────────────────
 * 1. **数字粘合只看普通空格**（不碰 `\t` / `\n`）。表格单元格在材料里以 `\t` 分隔，
 *    若用 `\s+` 就会把相邻两格的 `35` `38` 粘成 `3538`——这是最容易犯的错，故显式避开。
 * 2. **只在"有 LaTeX 痕迹"的片段里做单字母粘合**（`m e a n` → `mean`）。
 *    该规则对 `\mathtt { m e a n }` 这种写法必要，但在普通英文里会把 `a b` 误粘成 `ab`。
 * 3. 未知命令**删除**而不是保留：留下 `lvert` 之类的残渣比删掉更干扰阅读。
 * 4. **不臆造内容**：`.809` 不会补成 `0.809`（那是"归一化"该做的事，属于抽取层职责，
 *    见提示词里的单位口径要求）；这里只做"把被切碎的原文还原成原文"。
 */

/** LaTeX 命令 → 符号。必须**先长后短**匹配，否则 `\pm` 会切掉 `\pmatrix` 的前缀。 */
const SYMBOLS: Readonly<Record<string, string>> = {
  '\\pm': '±', '\\mp': '∓', '\\times': '×', '\\cdot': '·', '\\div': '÷',
  '\\ast': '*', '\\star': '*', '\\sharp': '†', '\\dagger': '†', '\\ddagger': '‡',
  '\\circ': '°', '\\degree': '°', '\\leq': '≤', '\\le': '≤', '\\geq': '≥', '\\ge': '≥',
  '\\neq': '≠', '\\ne': '≠', '\\approx': '≈', '\\sim': '~', '\\propto': '∝',
  '\\infty': '∞', '\\ldots': '…', '\\dots': '…', '\\cdots': '…',
  '\\rightarrow': '→', '\\to': '–', '\\leftarrow': '←', '\\uparrow': '↑', '\\downarrow': '↓',
  '\\alpha': 'α', '\\beta': 'β', '\\gamma': 'γ', '\\delta': 'δ', '\\Delta': 'Δ',
  '\\epsilon': 'ε', '\\eta': 'η', '\\zeta': 'ζ', '\\xi': 'ξ', '\\theta': 'θ',
  '\\kappa': 'κ', '\\lambda': 'λ', '\\mu': 'μ', '\\nu': 'ν', '\\pi': 'π', '\\rho': 'ρ',
  '\\sigma': 'σ', '\\tau': 'τ', '\\phi': 'φ', '\\varphi': 'φ', '\\chi': 'χ',
  '\\psi': 'ψ', '\\omega': 'ω', '\\Omega': 'Ω', '\\Sigma': 'Σ', '\\Phi': 'Φ',
  '\\%': '%', '\\&': '&', '\\#': '#', '\\S': '§', '\\P': '¶', '\\copyright': '©',
};

/**
 * 需要**连命令带参数一起删掉**的命令（花括号里的内容也丢）。
 * 与"样式命令"不同：`\overline { x }` 里的上划线没有文本价值，但 `x` 要留。
 * 所以这里只列"本身无内容"的包装/间距命令——它们的参数是**被包装的内容**，必须保留。
 */
const WRAPPERS = [
  'left', 'right', 'big', 'Big', 'bigg', 'Bigg', 'bigl', 'bigr', 'Bigl', 'Bigr', 'bigm', 'Bigm',
  'quad', 'qquad', 'hspace', 'vspace', 'strut', 'phantom', 'limits', 'nolimits',
  'overline', 'underline', 'hat', 'bar', 'vec', 'dot', 'ddot', 'tilde', 'widehat', 'widetilde',
  'overset', 'underset', 'stackrel', 'overbrace', 'underbrace', 'substack', 'mathrm', 'mathsf',
  'mathbf', 'mathit', 'mathtt', 'mathbb', 'mathcal', 'mathfrak', 'boldsymbol', 'pmb',
  'bf', 'it', 'tt', 'rm', 'sf', 'textrm', 'textbf', 'textit', 'texttt', 'text', 'mbox',
  'operatorname', 'scriptstyle', 'scriptscriptstyle', 'displaystyle', 'textstyle',
  'mathnormal', 'mathstrut', 'ensuremath', 'mathop', 'mathbin', 'mathrel', 'mathord',
  'mathpunct', 'mathopen', 'mathclose', 'bfseries', 'itshape', 'upshape', 'centering',
];

/** 一条文本里是否含 LaTeX 痕迹（决定要不要做"单字母粘合"这种激进规则）。 */
export function hasLatex(s: string): boolean {
  return /\\[a-zA-Z]|<eq>|<\/eq>|\$[^$]/.test(s);
}

/**
 * 把 MinerU 的 LaTeX 噪声还原成原文。
 *
 * 幂等：对已清洗的文本再跑一次不改变结果（有单测保证）。
 */
export function deLatex(input: string): string {
  if (!input) return input;
  let t = input;

  /* 0. 去掉行内公式定界符，内容留下 */
  t = t.replace(/<\/?eq>/gi, ' ').replace(/\\[()[\]]/g, ' ').replace(/\$/g, ' ');

  /* 1. `\begin{array} { r } … \end{array}`：环境名与对齐参数都无内容价值 */
  t = t.replace(/\\begin\s*\{[a-zA-Z*]+\}\s*(?:\{[^{}]*\})?/g, ' ');
  t = t.replace(/\\end\s*\{[a-zA-Z*]+\}/g, ' ');
  t = t.replace(/\\\\/g, ' ');

  /* 2. 包装/样式命令：删命令，留参数 */
  const wrapperRe = new RegExp(`\\\\(?:${WRAPPERS.join('|')})(?![a-zA-Z])`, 'g');
  t = t.replace(wrapperRe, ' ');

  /* 3. 有意义的符号命令（长的优先） */
  const symbolRe = new RegExp(
    Object.keys(SYMBOLS).sort((a, b) => b.length - a.length).map((k) => k.replace(/\\/g, '\\\\')).join('|') + '(?![a-zA-Z])',
    'g',
  );
  t = t.replace(symbolRe, (m) => SYMBOLS[m] ?? ' ');

  /* 4. 其余命令一律删除（例如 `\lvert`、`\nonumber`），残渣比删除更干扰 */
  t = t.replace(/\\[a-zA-Z]+/g, ' ');
  t = t.replace(/\\/g, ' ');

  /* 5. 花括号 / 上下标 / LaTeX 空格记号 */
  t = t.replace(/[{}^_~]/g, ' ');

  /*
   * 6. 小数点两侧的空格（`4 1 . 7 5` → `41.75`）。
   *    **规则刻意不对称**，因为两类文本长得像但含义不同：
   *      · `1 . 7`（点**前**有空格）= MinerU 拆散的数字，要粘；
   *      · `Table 1. 2`（点后才有空格）= 句点 + 下一句的数字，**绝不能粘**。
   *    所以第一条要求"点前必须有空格"；第二条处理前导小数点 `. 8 0 9` → `.809`，
   *    用零宽后顾排除"前一个字符是数字/字母"的情形（`vs. 20`、`Fig. 3` 因此不受影响）。
   *    **只用普通空格**：`\t` 是表格单元格分隔符，跨格合并会造出假数据。
   */
  for (let i = 0; i < 4; i++) {
    const next = t
      .replace(/(\d) +\. *(\d)/g, '$1.$2')
      .replace(/(?<![\dA-Za-z])\. *(\d)/g, '.$1');
    if (next === t) break;
    t = next;
  }

  /* 7. 数字之间只剩空格 → 粘合（`4 1 . 7 5` 已在第 6 步变成 `4 1.7 5`，这里合成 `41.75`） */
  for (let i = 0; i < 6; i++) {
    const next = t.replace(/(\d) +(?=\d)/g, '$1');
    if (next === t) break;
    t = next;
  }

  /* 8. 正负号与数字之间的空格（`- 0 . 2 4 3` → `-0.243`），只在明确是"数的符号"时粘 */
  t = t.replace(/(^|[\s(=±×÷,;:[{]) *([-−+]) *(?=\d)/g, '$1$2');

  /* 9. LaTeX 语境里被拆散的单字母（`\mathtt { m e a n }` → `mean`）；普通英文不动。
        用零宽后顾而不是捕获前缀——否则匹配会把前导空格一并吃掉，把 `of m e a n` 粘成 `ofmean`。 */
  if (hasLatex(input)) {
    t = t.replace(/(?<![A-Za-z])(?:[A-Za-z] )+[A-Za-z](?![A-Za-z])/g, (m) => m.replace(/ /g, ''));
  }

  return t.replace(/[ ]{2,}/g, ' ').replace(/ ?\n ?/g, '\n').trim();
}
