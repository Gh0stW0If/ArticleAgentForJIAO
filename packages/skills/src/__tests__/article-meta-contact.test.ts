/**
 * article-meta 的**通讯作者邮箱定点补料**：防回归测试。
 *
 * 背景（实测，见 `docs/16-author-contact.md` §5.4）：
 * `collectMaterials` 的判据是「章节命中 **或** 页码命中」，白名单只有
 * `metadata/abstract/funding/acknowledgements` + 前 `metaPages` 页。
 * 通讯作者邮箱常印在正文深处的"通讯作者脚注"里，块被归到 `discussion`/`conclusion`/`references`，
 * 于是整块丢掉、模型只能答 `NR`。150 条"金标准确实是邮箱"里：
 *   块进得了材料的 96 条 → 加权 81.8%；进不了的 17 条 → **0.0%**。
 *
 * 这里锁三条规则：
 *   ① 全文中存在邮箱 → 用户消息里必须出现那段补料，且**带上页码与章节**；
 *   ② 有 correspondence/通讯作者 字样的排前面（模型据此判断谁是通讯作者）；
 *   ③ 全文没有邮箱 → **不加**这一段（避免给模型塞一段空提示）。
 */
import { describe, it, expect } from 'vitest';
import { createArticleMetaSkill } from '../article-meta.ts';
import type { LlmInvoker, LlmResponse, MiniDoc, MiniDocBlock, SkillContext } from '@aa/core';

/** 造一个最小 MiniDoc：只需 blocks 有 page/section/text。 */
function docOf(blocks: Array<Partial<MiniDocBlock> & { text: string }>): MiniDoc {
  return {
    schemaVersion: 'AA_MINIDOC/1.0', year: '2020', articleId: '2020-99',
    sourcePdf: '', mineruDir: '', pages: [], stats: {} as MiniDoc['stats'], warnings: [],
    blocks: blocks.map((b, i) => ({
      index: i, type: 'text', page: 1, section: 'unknown', ...b,
    })) as MiniDocBlock[],
  } as unknown as MiniDoc;
}

/** 假模型：把收到的 user 消息记下来，返回空 JSON。 */
const capturingLlm = (): { llm: LlmInvoker; seen: () => string } => {
  let captured = '';
  return {
    llm: {
      async invoke(req): Promise<LlmResponse> {
        captured = String(req.user ?? '');
        return { text: '{}', json: {}, model: 'fake' };
      },
    },
    seen: () => captured,
  };
};
const ctxOf = (doc: MiniDoc, llm: LlmInvoker): SkillContext =>
  ({ doc, llm, log: () => {} } as unknown as SkillContext);

const run = async (doc: MiniDoc) => {
  const cap = capturingLlm();
  /* 关掉 Crossref，避免测试触网 */
  const skill = createArticleMetaSkill({ verifyWithCrossref: false });
  await skill.run(ctxOf(doc, cap.llm));
  return cap.seen();
};

describe('article-meta — 通讯作者邮箱定点补料', () => {
  it('全文中存在邮箱 → 补料段出现，且带页码/章节/correspondence 标记', async () => {
    const doc = docOf([
      { text: 'Acupuncture for fibromyalgia: a randomised trial', page: 1, section: 'metadata' },
      { text: 'Correspondence to Dr Jorge Vas; jorgef.vas.sspa@juntadeandalucia.es', page: 8, section: 'discussion' },
      { text: 'editorial office: aim@bmj.com', page: 9, section: 'references' },
    ]);
    const user = await run(doc);

    expect(user).toContain('附：程序在**全文**中扫描到的邮箱');
    expect(user).toContain('jorgef.vas.sspa@juntadeandalucia.es');
    expect(user).toContain('p8');
    expect(user).toContain('discussion');
    /* 带 correspondence 字样的那条必须出现"同段出现 correspondence"标注 */
    expect(user).toMatch(/jorgef\.vas\.sspa@juntadeandalucia\.es（[^）]*同段出现 correspondence/);
  });

  it('有 correspondence 字样的排在前面（第三方邮箱在后）', async () => {
    /* 必须有一个能进材料的块（前 2 页 + metadata 章节），否则技能会因"无材料"提前返回 */
    const doc = docOf([
      { text: 'Acupuncture for chronic pain: a randomised trial', page: 1, section: 'metadata' },
      { text: 'editorial office: aim@bmj.com', page: 9, section: 'references' },
      { text: 'Correspondence: lcz623780@126.com', page: 8, section: 'discussion' },
    ]);
    const user = await run(doc);
    const iCorr = user.indexOf('lcz623780@126.com');
    const iOther = user.indexOf('aim@bmj.com');
    expect(iCorr).toBeGreaterThan(-1);
    expect(iOther).toBeGreaterThan(-1);
    expect(iCorr).toBeLessThan(iOther);
  });

  it('全文没有邮箱 → 不加补料段', async () => {
    const doc = docOf([{ text: 'no contact information here', page: 1, section: 'metadata' }]);
    const user = await run(doc);
    expect(user).not.toContain('附：程序在**全文**中扫描到的邮箱');
  });

  it('PDF 里的 OCR 空格（`a@b. com`）也能被扫到并归一化', async () => {
    const doc = docOf([{ text: 'Email: Charlie.xue@rmit. edu.au', page: 2, section: 'metadata' }]);
    const user = await run(doc);
    expect(user).toContain('Charlie.xue@rmit.edu.au');
  });
});

/**
 * 确定性兜底：模型答 NR、但全文**只有一个**带 correspondence 标记的邮箱时，直接采用；
 * 两个及以上候选时**不猜**。
 *
 * 为什么必须有这条：实测 2024-03 / 2021-08 的补料段里已经写着正确答案与 correspondence 标记，
 * 模型仍然答 NR（它抓住首页那句"Author affiliations … are listed at the end of this article."）。
 * 两次加固提示词都无效，所以改走确定性路径。
 */
describe('article-meta — 通讯作者邮箱确定性兜底', () => {
  /**
   * 假模型：authorContact 一律答 NR，其余留空。
   * ⚠️ quote 必须**能在文档里定位到**——`grounding.ts` 的不变量是"定位不上就丢字段"，
   * 写个 `not reported` 会让该字段整个消失（断言 NR 就会拿到 undefined）。
   */
  const nrLlm = (): LlmInvoker => ({
    async invoke(): Promise<LlmResponse> {
      const json = { authorContact: { value: 'NR', quote: 'Acupuncture for chronic pain', confidence: 0.4 } };
      return { text: JSON.stringify(json), json, model: 'fake' };
    },
  });

  const runWith = async (doc: MiniDoc) => {
    const skill = createArticleMetaSkill({ verifyWithCrossref: false });
    return skill.run(ctxOf(doc, nrLlm()));
  };

  it('唯一带 correspondence 的邮箱 → 采用它，并给出可定位的证据', async () => {
    const doc = docOf([
      { text: 'Acupuncture for chronic pain', page: 1, section: 'metadata' },
      { text: 'Correspondence to Dr Jorge Vas; jorgef.vas.sspa@juntadeandalucia.es', page: 8, section: 'conclusion' },
    ]);
    const out = await runWith(doc);
    expect(out.payload.authorContact?.raw).toBe('jorgef.vas.sspa@juntadeandalucia.es');
    expect(out.payload.authorContact?.provenance).toBe('deterministic');
    expect(out.payload.authorContact?.evidence?.[0]?.page).toBe(8);
    expect(out.issues.some((i) => i.code === 'CONTACT_FROM_SCAN')).toBe(true);
  });

  it('两个候选 → 不猜，保持模型给的 NR', async () => {
    const doc = docOf([
      { text: 'Acupuncture for chronic pain', page: 1, section: 'metadata' },
      { text: 'Correspondence: a@x.org', page: 5, section: 'conclusion' },
      { text: 'Correspondence: b@y.org', page: 9, section: 'discussion' },
    ]);
    const out = await runWith(doc);
    expect(out.payload.authorContact?.raw).toBe('NR');
    expect(out.issues.some((i) => i.code === 'CONTACT_FROM_SCAN')).toBe(false);
  });

  it('没有任何 correspondence 标记 → 不猜，保持 NR', async () => {
    const doc = docOf([
      { text: 'Acupuncture for chronic pain', page: 1, section: 'metadata' },
      { text: 'editorial office: aim@bmj.com', page: 9, section: 'references' },
    ]);
    const out = await runWith(doc);
    expect(out.payload.authorContact?.raw).toBe('NR');
    expect(out.issues.some((i) => i.code === 'CONTACT_FROM_SCAN')).toBe(false);
  });
});
