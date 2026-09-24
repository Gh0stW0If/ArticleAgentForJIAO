#!/usr/bin/env node
// tools/mineru_batch.mjs — 批量解析 + 稳定性验证
//
// 用法：
//   node tools/mineru_batch.mjs --year 2015                 # 跑整年
//   node tools/mineru_batch.mjs --year 2015 --only -2015-01  # 只跑一篇
//   node tools/mineru_batch.mjs --year 2015 --report-only    # 只重新评估已有输出
//
// 设计目标：不是「跑通就算」，而是逐篇给出可判定的健康度指标：
//   - 是否产出全部关键文件
//   - 正文块数 / 字符数（对比 PDF 原生文字层，检测漏抽）
//   - 表格：总数、有多少是空 body（跨页续表会表现为空）
//   - 公式：是否识别出 LaTeX
//   - 噪声块占比（页眉/页脚/页码，可直接清洗）
//
// Datas/ 只读；输出写入 build/mineru/<year>/<stem>/

import { readdirSync, writeFileSync, mkdirSync, existsSync, readFileSync, statSync, copyFileSync, rmSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(process.cwd());
const argv = process.argv.slice(2);
const argOf = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const YEAR = argOf('--year') ?? '2015';
const ONLY = argOf('--only');
const REPORT_ONLY = argv.includes('--report-only');

const ART_DIR = join(ROOT, 'Datas', 'articles', YEAR);
const OUT_ROOT = join(ROOT, 'build', 'mineru', YEAR);
const MINERU = join(ROOT, 'runtime', 'mineru', 'Scripts', 'mineru.exe');

/* ----------------------------- 步骤 1：解析 ----------------------------- */

function pdfs() {
  if (!existsSync(ART_DIR)) throw new Error(`目录不存在: ${ART_DIR}`);
  let list = readdirSync(ART_DIR).filter((f) => f.toLowerCase().endsWith('.pdf')).sort();
  if (ONLY) list = list.filter((f) => f.includes(ONLY));
  return list;
}

function runMinerU(files) {
  // MinerU 的 `-p` 只接受【一个】路径（文件或目录），不支持多个路径。
  // 传多个会被静默当成一个（只会处理第一个），因此这里做两件事：
  //   1. 若恰好是整年全集，直接把 Datas/articles/<year> 目录交给 MinerU；
  //   2. 否则建一个只含目标 PDF 的暂存目录，避免把 .DS_Store / 隐藏目录喂进去。
  //
  // 只调用一次的原因：MinerU 的 api 服务会常驻，模型只加载一次；
  // 逐篇调用会反复初始化模型（每篇约 45s 固定开销）。
  const stage = join(ROOT, 'build', '_stage', YEAR);
  let target;

  const allPdfs = readdirSync(ART_DIR).filter((f) => f.toLowerCase().endsWith('.pdf')).sort();
  const isFullSet = files.length === allPdfs.length && files.every((f, i) => f === allPdfs[i]);

  if (isFullSet) {
    target = ART_DIR;
  } else {
    mkdirSync(stage, { recursive: true });
    for (const f of files) copyFileSync(join(ART_DIR, f), join(stage, f));
    target = stage;
  }

  const args = ['-p', target, '-o', OUT_ROOT, '-b', 'pipeline', '-m', 'txt'];
  console.log('CMD:', MINERU, args.join(' '));
  const r = spawnSync(MINERU, args, {
    stdio: 'inherit',
    env: { ...process.env, MINERU_MODEL_SOURCE: 'local' },
    cwd: ROOT,
  });
  return r.status;
}

/* ----------------------------- 步骤 2：评估 ----------------------------- */

const NOISE_TYPES = new Set(['header', 'footer', 'page_number', 'page_footnote', 'aside_text']);

/** 找到某篇 PDF 的输出目录（MinerU 用 <stem>/txt/ 结构）。 */
function findOutputDir(stem) {
  const cands = [
    join(OUT_ROOT, stem, 'txt'),
    join(OUT_ROOT, stem, 'auto'),
    join(OUT_ROOT, stem),
  ];
  for (const c of cands) {
    if (existsSync(c) && readdirSync(c).some((x) => x.endsWith('_content_list.json'))) return c;
  }
  // 兜底：递归找
  for (const d of readdirSync(OUT_ROOT, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    for (const sub of readdirSync(join(OUT_ROOT, d.name), { withFileTypes: true })) {
      if (!sub.isDirectory()) continue;
      const p = join(OUT_ROOT, d.name, sub.name);
      if (readdirSync(p).some((x) => x.endsWith('_content_list.json'))) return p;
    }
  }
  return null;
}

function evaluate(file) {
  const stem = basename(file, '.pdf');
  const dir = findOutputDir(stem);
  const rep = { file, stem, outputDir: dir, ok: false, issues: [] };
  if (!dir) { rep.issues.push('未找到 MinerU 输出目录'); return rep; }

  const files = readdirSync(dir);
  const find = (suffix) => files.find((f) => f.endsWith(suffix));

  const p = {
    md: find('.md'),
    contentList: find('_content_list.json'),
    contentListV2: find('_content_list_v2.json'),
    middle: find('_middle.json'),
    model: find('_model.json'),
    layoutPdf: find('_layout.pdf'),
    spanPdf: find('_span.pdf'),
  };
  rep.artifacts = Object.fromEntries(
    Object.entries(p).map(([k, v]) => [k, v ? statSync(join(dir, v)).size : 0]),
  );
  const missing = Object.entries(p).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) rep.issues.push(`缺少产物: ${missing.join(', ')}`);

  if (!p.contentList) return rep;
  const items = JSON.parse(readFileSync(join(dir, p.contentList), 'utf8'));

  // 分类型统计
  const byType = {};
  for (const it of items) byType[it.type] = (byType[it.type] ?? 0) + 1;

  const tables = items.filter((i) => i.type === 'table');
  const emptyTables = tables.filter((t) => !t.table_body || t.table_body.trim().length < 20);
  const images = items.filter((i) => i.type === 'image');
  const textItems = items.filter((i) => i.type === 'text');
  const noiseItems = items.filter((i) => NOISE_TYPES.has(i.type));

  // LaTeX 公式：content_list_v2 里的 equation span
  let eqInline = 0, eqDisplay = 0;
  if (p.contentListV2) {
    const raw = readFileSync(join(dir, p.contentListV2), 'utf8');
    eqInline = (raw.match(/"equation_inline"/g) ?? []).length;
    eqDisplay = (raw.match(/"equation_display"/g) ?? []).length;
  }

  const bodyChars = textItems.reduce((n, t) => n + String(t.text ?? '').length, 0);

  // 页码覆盖
  const pageIdxs = new Set(items.map((i) => i.page_idx).filter((x) => typeof x === 'number'));
  const captionCount = items.filter((i) => i.type === 'table' && (i.table_caption ?? []).filter(Boolean).length).length;

  rep.metrics = {
    items: items.length,
    byType,
    bodyBlocks: textItems.length,
    bodyChars,
    noiseBlocks: noiseItems.length,
    noiseRatio: +(noiseItems.length / Math.max(1, items.length)).toFixed(3),
    pagesCovered: pageIdxs.size,
    tables: tables.length,
    tablesWithBody: tables.length - emptyTables.length,
    tablesEmpty: emptyTables.length,
    tablesWithCaption: captionCount,
    tableBodiesChars: tables.reduce((n, t) => n + String(t.table_body ?? '').length, 0),
    images: images.length,
    equationsInline: eqInline,
    equationsDisplay: eqDisplay,
    mdChars: p.md ? readFileSync(join(dir, p.md), 'utf8').length : 0,
  };

  // 判定
  if (textItems.length === 0) rep.issues.push('正文块为 0');
  if (tables.length && emptyTables.length === tables.length) rep.issues.push('所有表格 body 为空');
  if (emptyTables.length) rep.issues.push(`${emptyTables.length}/${tables.length} 个表格 body 为空（疑似跨页续表或抽取失败）`);
  rep.ok = rep.issues.length === 0;
  return rep;
}

/* ------------------------------ 主流程 ------------------------------ */

mkdirSync(OUT_ROOT, { recursive: true });
const files = pdfs();
console.log(`年份 ${YEAR}：${files.length} 篇`);

if (!REPORT_ONLY) {
  const status = runMinerU(files);
  console.log(`\nMinerU 退出码: ${status}`);
}

const reports = files.map(evaluate);

// 汇总
const totals = reports.reduce((a, r) => {
  const m = r.metrics ?? {};
  a.tables += m.tables ?? 0;
  a.tablesEmpty += m.tablesEmpty ?? 0;
  a.tableBodiesChars += m.tableBodiesChars ?? 0;
  a.images += m.images ?? 0;
  a.bodyChars += m.bodyChars ?? 0;
  a.equationsInline += m.equationsInline ?? 0;
  a.equationsDisplay += m.equationsDisplay ?? 0;
  a.noise += m.noiseBlocks ?? 0;
  a.items += m.items ?? 0;
  return a;
}, { tables: 0, tablesEmpty: 0, tableBodiesChars: 0, images: 0, bodyChars: 0, equationsInline: 0, equationsDisplay: 0, noise: 0, items: 0 });

const out = { year: YEAR, generated_at: new Date().toISOString(), totals, reports };
writeFileSync(join(OUT_ROOT, '_quality.json'), JSON.stringify(out, null, 2), 'utf8');

console.log('\n' + '='.repeat(104));
console.log('逐篇健康度');
console.log('='.repeat(104));
const hdr = ['文件', '页', '正文块', '正文字符', '表格', '空表', '表格字符', '图', '行内式', '块公式', '噪声比', 'MD字节'];
console.log(hdr.map((h, i) => h.padEnd([26, 4, 8, 10, 6, 6, 10, 5, 8, 8, 8, 9][i])).join(''));
for (const r of reports) {
  const m = r.metrics ?? {};
  const cells = [
    r.file, String(m.pagesCovered ?? '-'), String(m.bodyBlocks ?? '-'), String(m.bodyChars ?? '-'),
    String(m.tables ?? '-'), String(m.tablesEmpty ?? '-'), String(m.tableBodiesChars ?? '-'),
    String(m.images ?? '-'), String(m.equationsInline ?? '-'), String(m.equationsDisplay ?? '-'),
    String(m.noiseRatio ?? '-'), String(r.artifacts?.md ?? '-'),
  ];
  console.log(cells.map((c, i) => c.padEnd([26, 4, 8, 10, 6, 6, 10, 5, 8, 8, 8, 9][i])).join(''));
}

console.log('\n' + '='.repeat(104));
console.log(`合计: 表格 ${totals.tables}（空 ${totals.tablesEmpty}）| 表格 HTML 字符 ${totals.tableBodiesChars} | 图 ${totals.images} | 行内公式 ${totals.equationsInline} | 块公式 ${totals.equationsDisplay}`);
console.log(`      正文 ${totals.bodyChars} 字符 / ${totals.items} 个条目，噪声 ${totals.noise}（${(totals.noise / Math.max(1, totals.items) * 100).toFixed(1)}%）`);

const bad = reports.filter((r) => !r.ok);
console.log(`\n有问题的文档: ${bad.length}/${reports.length}`);
for (const r of bad) {
  console.log(`  ✗ ${r.file}`);
  for (const i of r.issues) console.log(`      - ${i}`);
}
if (!bad.length) console.log('  ✅ 全部通过');

console.log(`\n质量报告: ${join(OUT_ROOT, '_quality.json')}`);
process.exit(bad.length ? 1 : 0);
