/**
 * 全量统计"表格解析不完整"的论文。
 *
 * 为什么要单独统计：MinerU 对**跨页续表**偶尔还原不出表体（HTML body 为空），
 * 这类论文的数值提取会偏低——如果不区分"解析没拿到"与"模型没抽对"，
 * 报告会把解析器的锅算到提取质量上（对医生讨论毫无帮助，还会误导优化方向）。
 *
 * 判据：MinerU `_middle.json` 里 type=table 的块，若其 table_body 的 HTML 为空
 * → 记一个"空表"。产出 build/parse_health.json。
 *
 * ⚠️ 另外记两类"源头就错了"的情况（它们与提取质量无关，但会让整篇接近 0 分）：
 *   · `short`：解析出来的正文字符数过少（< 8000），多半是扫描件 OCR 失败，
 *     或者 **Datas 里把同一主名的图片（.jpg）也喂给了 MinerU**，导致 `<id>` 目录里
 *     存的是那张图的 1 页解析（实测 2023-19 / 2025-07 整篇 0 分就是这么来的；
 *     正文解析被写到了 `<id>_2`）。取最完整解析的逻辑见 packages/ingest 的 findMiddleFile。
 *   · `lost`：同名撞车时被挤到 `<id>_2`/`<id>_3` 的目录（提示应检查取到了哪一份）。
 *
 * 用法：node tools/parse_health.mjs
 */
import { readdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const years = Array.from({ length: 11 }, (_, i) => String(2015 + i));

/** 递归数表格块与空表（表格 body 是子块，因此只看 table 顶层块 + 其子块里的 html）。 */
function scanMiddle(file) {
  let tables = 0;
  let empty = 0;
  let raw;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch { return { tables, empty }; }
  const pages = raw.pdf_info ?? {};
  const walk = (blocks, depth) => {
    for (const b of blocks ?? []) {
      const t = String(b.type ?? '').toLowerCase();
      if (depth === 0 && t === 'table') {
        tables++;
        // body 在子块 table_body 的 spans[].html 里
        let html = '';
        for (const child of b.blocks ?? []) {
          if (String(child.type ?? '').toLowerCase() !== 'table_body') continue;
          for (const line of child.lines ?? []) {
            for (const span of line.spans ?? []) if (span.html) html += span.html;
          }
        }
        if (!html.trim()) empty++;
      }
      if (b.blocks) walk(b.blocks, depth + 1);
    }
  };
  for (const pg of Object.values(pages)) {
    walk(pg.para_blocks, 0);
    walk(pg.discarded_blocks, 0);
  }
  return { tables, empty };
}

const out = { at: new Date().toISOString(), years: {}, papers: [], shortParses: [], collisionDirs: [] };
let totalPapers = 0;
let affected = 0;
let totalTables = 0;
let totalEmpty = 0;

/** 解析出来的正文字符数（markdown，含表格 HTML 与图片占位）。 */
function mdChars(base, dir) {
  const dpath = join(base, dir);
  let subs = [];
  try { subs = readdirSync(dpath); } catch { return null; }
  for (const sub of subs) {
    const dir2 = join(dpath, sub);
    let files = [];
    try { files = readdirSync(dir2); } catch { continue; }
    const md = files.find((f) => f.endsWith('.md'));
    if (md) { try { return readFileSync(join(dir2, md), 'utf8').length; } catch { return null; } }
  }
  return null;
}

for (const y of years) {
  const base = join(ROOT, 'build', 'mineru', y);
  if (!existsSync(base)) continue;
  let yTables = 0;
  let yEmpty = 0;
  let yAffected = 0;
  for (const d of readdirSync(base)) {
    if (d === '_clean') continue;
    /*
     * 同名撞车目录：`<id>_2` / `<id>_3` —— Datas 里同时有 `<id>.pdf` 与 `<id>.jpg` 时
     * MinerU 会把后处理的那份写到带后缀的目录。记下来，便于复查"取到的是哪一份"。
     */
    if (/_\d+$/.test(d)) out.collisionDirs.push({ year: y, dir: d, chars: mdChars(base, d) });
    // 找到该篇的 _middle.json
    const dirs = [];
    const dpath = join(base, d);
    try { for (const sub of readdirSync(dpath)) dirs.push(join(dpath, sub)); } catch { continue; }
    let mid = null;
    for (const dir of dirs) {
      try {
        const hit = readdirSync(dir).find((f) => f.endsWith('_middle.json'));
        if (hit) { mid = join(dir, hit); break; }
      } catch { /* 忽略 */ }
    }
    if (!mid) continue;
    totalPapers++;
    const { tables, empty } = scanMiddle(mid);
    yTables += tables;
    yEmpty += empty;
    totalTables += tables;
    totalEmpty += empty;
    if (empty > 0) {
      affected++;
      yAffected++;
      out.papers.push({ year: y, studyId: d.replace(/^-/, ''), tables, empty });
    }
    /* 正文过短：多半是扫描件或喂错了文件（详见文件头说明） */
    const chars = mdChars(base, d);
    if (chars !== null && chars < 8000 && /^\d{4}-\d+$/.test(d.replace(/^-/, ''))) {
      out.shortParses.push({ year: y, studyId: d.replace(/^-/, ''), chars, note: chars < 3000 ? '极短，基本等于没解析出正文' : '偏短，需人工确认' });
    }
  }
  out.years[y] = { papers: yAffected, tables: yTables, emptyTables: yEmpty };
  console.log(`  ${y}: 表格 ${yTables} 个，空表 ${yEmpty} 个，涉及 ${yAffected} 篇`);
}

out.total = { papers: totalPapers, tables: totalTables, emptyTables: totalEmpty, affectedPapers: affected };
const outFile = join(ROOT, 'build', 'parse_health.json');
writeFileSync(outFile, JSON.stringify(out, null, 2), 'utf8');
console.log(`\n合计：${totalPapers} 篇，表格 ${totalTables} 个，其中空表 ${totalEmpty} 个（涉及 ${affected} 篇）`);
if (out.shortParses.length) {
  console.log(`\n⚠ 正文过短的篇（< 8000 字符，需人工确认是扫描件还是喂错了文件）：`);
  for (const s of out.shortParses.sort((a, b) => a.chars - b.chars)) console.log(`   ${s.year}/${s.studyId}  ${s.chars} 字符  ${s.note}`);
}
if (out.collisionDirs.length) {
  console.log(`\n⚠ 同名撞车目录（.pdf 与 .jpg 主名相同，MinerU 把其中一份写到带后缀的目录）：`);
  for (const c of out.collisionDirs) console.log(`   build/mineru/${c.year}/${c.dir}  正文 ${c.chars} 字符`);
}
console.log(`→ ${outFile}\n`);
