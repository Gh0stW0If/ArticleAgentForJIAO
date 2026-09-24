/**
 * 金标准 ↔ 流水线的**结局行对齐**与文本/数值工具（评测与诊断工具共用）。
 *
 * 为什么要单独抽出来：对齐口径一旦两边各写一份就会漂移，
 * 于是"评测说配上了、诊断说没配上"，互相矛盾且无法复盘。
 * 这里只放纯函数，不读文件、不打印。
 */

/* ------------------------------ 文本归一化 ------------------------------ */

export const normText = (s) => String(s ?? '')
  .replace(/\s+/g, ' ')
  .replace(/[\u2010-\u2015]/g, '-')
  .replace(/[“”„]/g, '"')
  .replace(/[‘’]/g, "'")
  .trim()
  .toLowerCase();

/** 数值归一化；非数值返回 null。`−41` / `–41.0` / `1,234` 都能认。 */
export const normNum = (s) => {
  const t = String(s ?? '').replace(/[,\s]/g, '').replace(/[–—−]/g, '-');
  if (!/^[-+]?\d*\.?\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

/* ------------------------------ 分词 / Dice ------------------------------ */

/**
 * 分词：除标点外还要切开"驼峰"与"字母/数字"边界。
 *
 * 实测必要性：2015-01 金标准把疼痛 VAS 那一行的结局名写成 `fibromyalgia`、工具写 `VAS`，
 * 而流水线写的是 `pain intensity` / `PainVAS: Visual Analogue Scale`。
 * 不切开驼峰时 `PainVAS` 是单个 token `painvas`，与金标准的 `vas` 永不相交，
 * 于是金标准那一行被"名称里有 fibromyalgia"的 FIQ 行抢走（0.33 > 0），
 * 该行 estimate/CI 明明已经抽对（−41.0 / −47.2~−34.8）却全被判错。
 * 切分后：`PainVAS`→pain+vas、`SF12`→sf+12（金标准写作 `SF12:①Physical`）。
 */
export const tokensOf = (s) => new Set(
  normText(
    String(s ?? '')
      .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')       // PainVAS → Pain VAS
      .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, '$1 $2')       // HDRSscale → HDRS scale
      .replace(/(\p{L})(\p{N})/gu, '$1 $2')                // SF12 → SF 12
      .replace(/(\p{N})(\p{L})/gu, '$1 $2'),               // 12item → 12 item
  ).replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter((t) => t.length > 1),
);

/** Dice 系数：两个词集合的重合度（0~1）。 */
export function dice(a, b) {
  const A = tokensOf(a); const B = tokensOf(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return (2 * inter) / (A.size + B.size);
}

/* ------------------------------ 结局行对齐 ------------------------------ */

/**
 * 一条结局行里的**数值叶子**（供对齐佐证用）。
 *
 * 只收 |值| ≥ 10 的数：结局编码（estimateType 1~7）与 0/1 之类的哨兵值太容易撞车，
 * 而效应量、CI、例数几乎不会在两篇不同的结局之间同时相同。
 */
export function numericLeavesOf(row) {
  const out = [];
  for (const tp of Object.values(row?.timepoints ?? {})) {
    for (const grp of Object.values(tp ?? {})) {
      const walk = (o) => {
        if (!o || typeof o !== 'object') return;
        if (typeof o.raw === 'string') {
          const n = normNum(o.raw);
          if (n !== null && Math.abs(n) >= 10) out.push(n);
          return;
        }
        Object.values(o).forEach(walk);
      };
      walk(grp);
    }
  }
  return out;
}

/** 两条结局行**数值重合**的个数（去重后）。 */
export function numericCorroboration(g, p) {
  const A = numericLeavesOf(g); const B = numericLeavesOf(p);
  if (!A.length || !B.length) return 0;
  const bset = new Set(B.map((x) => x.toFixed(4)));
  const seen = new Set();
  for (const a of A) {
    const k = a.toFixed(4);
    if (bset.has(k) && !seen.has(k)) seen.add(k);
  }
  return seen.size;
}

/**
 * 结局相似度：金标准一条 vs 流水线一条。
 *
 * 实测必要性：一篇论文的结局条数常常对不上（金标准 4 条 / 流水线 12 条），
 * 按下标硬对会把"疼痛 VAS"和"SF-12 mental"凑成一对，于是每个字段都判错，
 * 准确率被严重低估。因此按「名称 + 测量工具」的文本相似度做贪心配对。
 *
 * 对齐佐证：金标准的结局名是"自然语言原样抄"（同一篇里既有 `fibromyalgia` 又有
 * `quality of life`），只靠文字会把行配错。数值是最硬的证据——两条行的效应量/CI
 * 同时相同，基本只可能是同一条结局。**下限 2 个数值重合**才加分，1 个不加（避免撞车）。
 * ⚠️ 这种配对会用到被评分的字段本身，因此统计里单独披露"靠数值配上的对数"。
 */
export function outcomeSimilarity(g, p) {
  const gText = `${g?.outcome?.name?.raw ?? ''} ${g?.outcome?.instrument?.raw ?? ''}`;
  const pText = `${p?.outcome?.name?.raw ?? ''} ${p?.outcome?.instrument?.raw ?? ''}`;
  const nameScore = dice(gText, pText);
  const instrScore = dice(g?.outcome?.instrument?.raw ?? '', p?.outcome?.instrument?.raw ?? '');
  const textScore = Math.max(nameScore, instrScore);
  // construct/subconstruct 编码相同是强信号
  const sameConstruct = Boolean(
    g?.outcome?.construct_code?.raw && g.outcome.construct_code.raw === p?.outcome?.constructCode?.raw,
  );
  const sameSub = Boolean(
    g?.outcome?.subconstruct_code?.raw && g.outcome.subconstruct_code.raw === p?.outcome?.subconstructCode?.raw,
  );
  const corr = numericCorroboration(g, p);
  const corrBonus = corr >= 3 ? 0.7 : corr === 2 ? 0.5 : 0;
  return {
    score: textScore + (sameConstruct ? 0.25 : 0) + (sameSub ? 0.15 : 0) + corrBonus,
    textScore,
    corr,
  };
}

/** 低于此分数视为"没抽到这一条"，不再硬配。 */
export const MIN_SCORE = 0.34;

/**
 * 结局行贪心配对。返回 { goldToPred: Map<gi, pi>, alignments }，
 * alignments 里每项带 textScore/corr，供调用方披露对齐口径。
 */
export function alignOutcomes(goldOuts, predOuts) {
  const pairs = [];
  for (const [gi, g] of goldOuts.entries()) {
    for (const [pi, p] of predOuts.entries()) {
      pairs.push({ gi, pi, ...outcomeSimilarity(g, p) });
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  const goldToPred = new Map();
  const usedGold = new Set();
  const alignments = [];
  for (const { gi, pi, score, textScore, corr } of pairs) {
    if (score < MIN_SCORE) break;
    if (goldToPred.has(gi) || usedGold.has(pi)) continue;
    goldToPred.set(gi, pi);
    usedGold.add(pi);
    const kind = textScore >= MIN_SCORE ? 'text' : corr >= 2 ? 'numeric' : 'weak';
    alignments.push({ gi, pi, textScore, corr, kind });
  }
  // literatureCode 命中优先（若有）
  const predByCode = new Map();
  for (const p of predOuts) {
    const c = p.literatureCode?.raw;
    if (c) predByCode.set(normText(c), p);
  }
  for (const [gi, g] of goldOuts.entries()) {
    const code = normText(g.literature_code?.raw ?? '');
    if (!code || !predByCode.has(code)) continue;
    const pi = predOuts.indexOf(predByCode.get(code));
    if (usedGold.has(pi)) continue;
    const prev = goldToPred.get(gi);
    if (prev !== undefined) usedGold.delete(prev);
    goldToPred.set(gi, pi);
    usedGold.add(pi);
    const sim = outcomeSimilarity(g, predOuts[pi]);
    const old = alignments.findIndex((a) => a.gi === gi);
    if (old >= 0) alignments.splice(old, 1);
    alignments.push({ gi, pi, textScore: sim.textScore, corr: sim.corr, kind: 'code' });
  }
  return { goldToPred, usedPred: usedGold, alignments };
}
