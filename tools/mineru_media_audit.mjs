/**
 * MinerU 媒体（表格 / 图片）**全链路不丢失**审计。
 *
 * 背景（上游明确要求）：MinerU 流程必须保留**所有**表格与图片信息，一张都不能丢。
 * "没丢"不能靠读代码断言，要能数出来。因此本工具按篇逐层计数：
 *
 *   MinerU `_middle.json`（para_blocks + discarded_blocks）
 *        ↓ ingest
 *   MiniDoc 块（type=table / figure）
 *        ↓ collectMaterials（各 SKILL 的材料窗口）
 *   材料里真正给到模型的表格 / 图片
 *
 * 任一层数量下降就说明有丢，工具会把**丢在哪一层、哪一块、为什么**打出来。
 *
 * 用法：node tools/mineru_media_audit.mjs [--year 2015]
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingest, findMiddleFile } from '../packages/ingest/dist/index.js';
import { collectMaterials } from '../packages/skills/dist/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
let year = '2015';
for (let i = 0; i < argv.length; i++) if (argv[i] === '--year') year = argv[++i];

/** 数一数 MinerU 原始产物里的表 / 图块（含被 MinerU 丢进 discarded_blocks 的）。 */
function countRawMedia(middleFile) {
  const m = JSON.parse(readFileSync(middleFile, 'utf8'));
  const pages = m.pdf_info ?? {};
  const tally = { table: 0, image: 0, figure: 0, inDiscarded: { table: 0, image: 0 } };
  /** 递归：MinerU 的表/图可能嵌在 blocks 里（表格 body 是子块）。 */
  const walk = (blocks, depth, discarded) => {
    for (const b of blocks ?? []) {
      const t = String(b.type ?? '').toLowerCase();
      /*
       * ⚠️ 只数**顶层**的表/图块。
       * 表格的 `table_body`/`table_caption` 是同一张表的子块，递归会把一张表数成 3~4 张；
       * 图片同理（image_caption 是子块）。depth>0 的子块不计入媒体总数。
       */
      if (depth === 0) {
        if (t === 'table') { tally.table++; if (discarded) tally.inDiscarded.table++; }
        if (t === 'image') { tally.image++; if (discarded) tally.inDiscarded.image++; }
        if (t === 'figure') { tally.figure++; if (discarded) tally.inDiscarded.figure++; }
      }
      if (b.blocks) walk(b.blocks, depth + 1, discarded);
    }
  };
  for (const pg of Object.values(pages)) {
    walk(pg.para_blocks, 0, false);
    walk(pg.discarded_blocks, 0, true);
  }
  return tally;
}

const ids = readdirSync(join(ROOT, 'build', 'mineru', year), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name.replace(/^-/, ''))
  .sort();

console.log(`\n=== MinerU 媒体保真审计（${year}）===`);
console.log('  「原始」= _middle.json 顶层 table/image 块；「MiniDoc」= ingest 后的块；「材料」= 交给模型的材料\n');

let bad = 0;
for (const id of ids) {
  const middleFile = findMiddleFile(ROOT, year, id) ?? findMiddleFile(ROOT, year, `-${id}`);
  if (!middleFile) { console.log(`  ⚠ ${id}: 找不到 _middle.json`); continue; }
  const raw = countRawMedia(middleFile);
  const { doc } = ingest({ rootDir: ROOT, year, studyId: findMiddleFile(ROOT, year, `-${id}`) ? `-${id}` : id });

  const docTables = doc.blocks.filter((b) => b.type === 'table');
  const docFigures = doc.blocks.filter((b) => b.type === 'figure');
  const droppedMedia = doc.blocks.filter((b) => b.dropped && (b.type === 'table' || b.type === 'figure'));

  // 各 SKILL 的实际材料窗口（与代码保持一致）
  const windows = {
    '结果+方法+摘要(有表)': { sections: ['results', 'methods', 'abstract'], pages: [1], tables: true, figures: false },
    '摘要+方法(无表)': { sections: ['abstract', 'metadata', 'methods'], pages: [1], tables: false, figures: false },
    '全章节+表+图': { tables: true, figures: true },
  };
  const per = {};
  for (const [name, opt] of Object.entries(windows)) {
    const m = collectMaterials(doc, { maxCharsPerBlock: 6000, ...opt });
    per[name] = {
      tables: m.blocks.filter((b) => b.type === 'table').length,
      figures: m.blocks.filter((b) => b.type === 'figure').length,
    };
  }

  const rawTotal = raw.table + raw.image + raw.figure;
  const docTotal = docTables.length + docFigures.length;
  const summary = `原始 ${rawTotal}（表 ${raw.table} / 图 ${raw.image + raw.figure}）` +
    ` → MiniDoc ${docTotal}（表 ${docTables.length} / 图 ${docFigures.length}）`;
  console.log(`  ${id}: ${summary}`);
  for (const [name, c] of Object.entries(per)) {
    console.log(`      材料·${name.padEnd(18)} 表 ${c.tables} / 图 ${c.figures}`);
  }

  /*
   * 判定：
   *   · MiniDoc 少于原始 → 真丢（ingest 的问题），必须为 0
   *   · 有 dropped 的媒体块 → 真丢，必须为 0
   *   · 材料少于 MiniDoc → 只可能是"该 SKILL 明确不要表/图"（如枚举阶段刻意不看表），
   *     属于有意裁剪，但**必须有窗口拿得到全部媒体**（见"全章节+表+图"那一行）
   */
  if (docTotal < rawTotal) {
    console.log(`       ❌ MiniDoc 比原始少 ${rawTotal - docTotal} 个媒体块`);
    bad++;
  }
  if (droppedMedia.length) {
    console.log(`       ❌ 有 ${droppedMedia.length} 个媒体块被标记 dropped`);
    bad++;
  }
  const all = per['全章节+表+图'];
  if (all.tables + all.figures < docTotal) {
    console.log(`       ❌ 无任何材料窗口能拿到全部媒体（全章节窗口只有 ${all.tables + all.figures}/${docTotal}）`);
    bad++;
  }
}

console.log(`\n${bad === 0 ? '✅ 未发现媒体丢失' : `❌ ${bad} 处疑似丢失`}\n`);
process.exitCode = bad === 0 ? 0 : 1;
