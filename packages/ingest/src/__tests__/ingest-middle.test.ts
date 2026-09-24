/**
 * ingest 层集成测试——直接吃真实的 MinerU 产物。
 *
 * 刻意不做 mock：这一层的价值就在于正确处理真实数据里的脏东西
 * （噪声块、colspan 表格、旋转页面、被污染的坐标系）。
 * 产物不存在时跳过，而不是用假数据蒙过去。
 *
 * 期望值全部来自对 `_middle.json` 的实测（2015-01，MinerU 3.4.5 / pipeline）。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { resolve, join, sep } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ingest, findMiddleFile } from '../ingest.ts';
import { auditEvidence, isStudyId, articleIdOf, blocksInSection, tables, figures, locateEvidence } from '@aa/core';
import type { MiniDoc } from '@aa/core';

// __tests__ -> src -> ingest -> packages -> 仓库根，共四级
const ROOT = resolve(__dirname, '../../../..');
const YEAR = '2015';
const STUDY = '-2015-01';
const hasData = findMiddleFile(ROOT, YEAR, STUDY) !== null;

describe.skipIf(!hasData)('ingest — 真实 MinerU 产物 (_middle.json)', () => {
  let doc: MiniDoc;

  beforeAll(() => {
    doc = ingest({ rootDir: ROOT, year: YEAR, studyId: STUDY }).doc;
  });

  it('产出合法 MiniDoc 且 ID 正确（容忍文件名前导连字符）', () => {
    expect(doc.schemaVersion).toBe('AA_MINIDOC/1.0');
    expect(doc.articleId).toBe('2015-01');
    expect(isStudyId(doc.articleId)).toBe(true);
    expect(articleIdOf(doc.articleId)).toBe('2015-01');
  });

  it('页面尺寸与旋转推断正确（第 6 页实测 rotate:90）', () => {
    expect(doc.pages.length).toBe(11);
    expect(doc.pages[0]!.width).toBeCloseTo(595, 0);
    expect(doc.pages[0]!.height).toBeCloseTo(793, 0);
    expect(doc.pages[5]!.width).toBeCloseTo(793, 0);
    expect(doc.pages[5]!.rotate).toBe(90);
    expect(doc.pages[0]!.rotate).toBe(0);
  });

  it('噪声计入 droppedNoise 但不混入正文', () => {
    // 实测 _middle.json 共 47 条 discarded_blocks；其中前 2 页的页眉/页脚/脚注被
    // 有意保留为 section='metadata'（期刊名、卷期年、DOI、通讯作者邮箱都在里面），
    // 页码丢弃；重复页脚去重。剩下的才算噪声。
    expect(doc.stats.droppedNoise).toBe(38);
    expect(doc.stats.droppedNoise).toBeLessThan(47);
    expect(doc.blocks.some((b) => /header|footer|page_number|aside/i.test(b.type))).toBe(false);
  });

  it('首页页眉/页脚/脚注被保留为 metadata（否则 journal/年份/DOI 抽不到）', () => {
    const meta = doc.blocks.filter((b) => b.section === 'metadata');
    // 原来的正文 metadata 块（"Original paper" / 标题 / 作者）+ 保留的页脚块
    expect(meta.length).toBeGreaterThan(3);
    const text = meta.map((b) => b.text).join('\n');
    expect(text).toContain('doi:10.1136/acupmed-2015-010950');   // 页脚引文行
    expect(text).toMatch(/Acupunct Med 20\d\d;/);                 // 期刊缩写 + 卷期年
    expect(text).toContain('jorgef.vas');                         // 通讯作者邮箱
    // 页码不应被保留（纯数字易被 quote 误匹配）
    expect(meta.some((b) => /^\d{1,4}$/.test(b.text.trim()))).toBe(false);
    // 每页重复的页脚只保留一份
    const footers = meta.filter((b) => /^Vas J, et al\./.test(b.text.trim()));
    expect(footers).toHaveLength(1);
  });

  it('几何信息全部落在 canonical 框架内——这是框选证据的前提', () => {
    let checked = 0;
    for (const b of doc.blocks) {
      if (!b.bbox) continue;
      checked++;
      const pg = doc.pages[b.page - 1]!;
      const maxDim = Math.max(pg.width, pg.height);
      expect(b.bbox[2]).toBeLessThanOrEqual(maxDim + 2);
      expect(b.bbox[3]).toBeLessThanOrEqual(maxDim + 2);
      expect(b.bbox[0]).toBeLessThanOrEqual(b.bbox[2]);
      expect(b.bbox[1]).toBeLessThanOrEqual(b.bbox[3]);
      expect(b.bbox[0]).toBeGreaterThanOrEqual(0);
      expect(b.bbox[1]).toBeGreaterThanOrEqual(0);
    }
    expect(checked).toBeGreaterThan(80);
    expect(doc.warnings.filter((w) => w.includes('超出 canonical'))).toEqual([]);
  });

  it('标题块被正确识别并驱动章节路由', () => {
    expect(doc.blocks.filter((b) => b.type === 'title').length).toBeGreaterThan(10);
    expect(blocksInSection(doc, 'abstract').length).toBeGreaterThan(0);
    expect(blocksInSection(doc, 'methods').length).toBeGreaterThan(0);
    expect(blocksInSection(doc, 'results').length).toBeGreaterThan(0);
    expect(blocksInSection(doc, 'references').length).toBeGreaterThan(0);
    expect(blocksInSection(doc, 'metadata').length).toBeGreaterThan(0);
  });

  it('表格解析：6 个中有 5 个含完整 HTML+规整网格（1 个为跨页续表伪影）', () => {
    const t = tables(doc);
    expect(t.length).toBe(6);
    const withBody = t.filter((tb) => tb.table!.html.length > 50);
    // 实测：1 个 table 块的 body 为空（PDF 第5页 "Table 1 Continued" 的重复伪影）
    expect(withBody.length).toBe(5);
    for (const tb of withBody) {
      expect(tb.table!.grid!.length).toBeGreaterThan(0);
      // 网格必须是矩形（colspan/rowspan 已展开）
      expect(new Set(tb.table!.grid!.map((r) => r.length)).size).toBe(1);
    }
  });

  it('表格 caption 被抽取且带 bbox（实测 4/6 有 caption）', () => {
    const withCap = tables(doc).filter((t) => t.table?.caption);
    expect(withCap.length).toBe(4);
    const t1 = withCap.find((t) => t.table!.caption!.includes('Table 1'));
    expect(t1).toBeDefined();
    expect(t1!.table!.caption).toContain('baseline clinical');
    expect(t1!.bbox).not.toBeNull();
  });

  it('Table 2 的 caption 打散被如实保留（不静默丢弃）', () => {
    // 实测该 caption 为 "Ta b l e 2 Eva l ..."，源头的旋转页面导致；
    // ingest 阶段不做修复，如实透传供上游/人工处理。
    const scattered = tables(doc).find((t) => t.table?.caption && /Ta\s*b\s*l\s*e/i.test(t.table.caption));
    expect(scattered).toBeDefined();
    expect(scattered!.table!.grid).toBeDefined();
  });

  it('colspan 被展开为规整网格（Table 2 有 15 列）', () => {
    const t2 = tables(doc).find((t) => t.table?.grid?.[0] && t.table.grid[0]!.length >= 15);
    expect(t2).toBeDefined();
    // 展开后必须各行列数一致
    const w = t2!.table!.grid![0]!.length;
    for (const r of t2!.table!.grid!) expect(r.length).toBe(w);
  });

  it('图块带切图路径，供多模态使用', () => {
    const f = figures(doc);
    expect(f.length).toBe(1);
    expect(f[0]!.imagePath).toBeTruthy();
  });

  it('locateEvidence 能把摘要原文定位到带坐标的块', () => {
    const quote = 'Individualised acupuncture treatment in primary care in patients with fibromyalgia proved efficacious';
    const hit = locateEvidence(doc, quote);
    expect(hit).not.toBeNull();
    expect(hit!.block.page).toBe(1);
    expect(hit!.block.bbox).not.toBeNull();
    expect(hit!.exact).toBe(true);
  });

  it('CID 登记号可在正文中定位（元信息抽取的基础）', () => {
    const hit = locateEvidence(doc, 'ISRCTN60217348');
    expect(hit).not.toBeNull();
    expect(hit!.block.page).toBe(1);
  });

  it('locateEvidence 找不到时返回 null，绝不伪造坐标', () => {
    expect(locateEvidence(doc, 'ZZZ_这句原文不存在于文档中_ZZZ')).toBeNull();
  });

  it('表格内的真实数值存在（结局抽取的基础）', () => {
    const t1 = tables(doc).find((t) => t.table?.caption?.includes('Table 1'))!;
    const nums = t1.table!.grid!.flat().filter((c) => /^\d+\.\d+$/.test(c));
    expect(nums.length).toBeGreaterThan(0);
  });

  it('每个块页码合法且覆盖不超过总页数', () => {
    for (const b of doc.blocks) {
      expect(b.page).toBeGreaterThanOrEqual(1);
      expect(b.page).toBeLessThanOrEqual(doc.pages.length);
    }
    expect(doc.stats.pagesCovered).toBeLessThanOrEqual(doc.pages.length);
  });

  it('MiniDoc 自身不含 FieldValue，证据审计应通过', () => {
    expect(auditEvidence(doc)).toEqual([]);
  });

  it('MinerU 后端与版本被记录，便于复现', () => {
    const r = ingest({ rootDir: ROOT, year: YEAR, studyId: STUDY });
    expect(r.mineru.backend).toBe('pipeline');
    expect(r.mineru.version).toBe('3.4.5');
  });
});

describe('ingest — 缺数据时的行为', () => {
  it('缺少产物时给出可执行的提示，而不是空结果', () => {
    expect(() => ingest({ rootDir: ROOT, year: '1900', studyId: '1900-01' }))
      .toThrow(/mineru_batch\.mjs/);
  });
});

/**
 * 同名文件撞车：MinerU 按"输入文件主名"建目录，而 Datas 里同一篇可能同时有
 * `2023-19.pdf` 和 `2023-19.jpg`（正文 PDF + 图版 JPG），后处理的那个会写成 `<id>_2`。
 * 实测 2023-19 / 2025-07 的 `<id>` 目录里正是那张 1 页图版，只认 `<id>` 会让整篇 0 分。
 */
describe('ingest — 同名 PDF/JPG 撞车时取最完整的解析', () => {
  const mk = (root: string, stem: string, pages: number, filler: number) => {
    const dir = resolve(root, 'build', 'mineru', '2999', stem, 'txt');
    mkdirSync(dir, { recursive: true });
    const pdf_info = Array.from({ length: pages }, () => ({
      page_size: [595, 842],
      para_blocks: [{ type: 'text', lines: [{ spans: [{ content: 'x'.repeat(filler) }] }] }],
    }));
    writeFileSync(resolve(dir, `${stem}_middle.json`), JSON.stringify({ pdf_info }), 'utf8');
  };

  it('图版在 <id>、正文在 <id>_2 时，选正文那份', () => {
    const root = mkdtempSync(join(tmpdir(), 'aa-ingest-'));
    try {
      mk(root, '2999-01', 1, 10);        // 图版 JPG 的解析：1 页、内容极少
      mk(root, '2999-01_2', 9, 5000);    // 正文 PDF 的解析
      expect(findMiddleFile(root, '2999', '2999-01')).toContain('2999-01_2');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('反过来（正文在 <id>、图版在 <id>_2）同样选正文那份', () => {
    const root = mkdtempSync(join(tmpdir(), 'aa-ingest-'));
    try {
      mk(root, '2999-02', 12, 5000);
      mk(root, '2999-02_2', 1, 10);
      expect(findMiddleFile(root, '2999', '2999-02')).toContain(`2999-02${sep}txt`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('不把别的篇号当成候选（2999-1 不会被 2999-12 抢走）', () => {
    const root = mkdtempSync(join(tmpdir(), 'aa-ingest-'));
    try {
      mk(root, '2999-12', 8, 5000);
      expect(findMiddleFile(root, '2999', '2999-1')).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
