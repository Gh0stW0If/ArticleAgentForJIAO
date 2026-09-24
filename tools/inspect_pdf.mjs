// tools/inspect_pdf.mjs — inspect the 2015 PDFs with pdfjs-dist (no native deps).
// Read-only w.r.t. Datas/; writes reports under build/pdf_inspect/.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const pdfjsPath = require.resolve('pdfjs-dist/legacy/build/pdf.mjs', {
  paths: [join(process.cwd(), 'tools', 'nodepdf')],
});
const pdfjs = await import(pathToFileURL(pdfjsPath).href);
const standardFontDataUrl =
  pathToFileURL(join(process.cwd(), 'tools', 'nodepdf', 'node_modules', 'pdfjs-dist', 'standard_fonts') + '/').href;

const ROOT = resolve(process.cwd());
const ART = join(ROOT, 'Datas', 'articles', '2015');
const OUT = join(ROOT, 'build', 'pdf_inspect');
mkdirSync(OUT, { recursive: true });

const DOI_RE = /10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+/g;
const URL_RE = /https?:\/\/[^\s)>\]]+/g;

const summary = [];

for (const file of readdirSync(ART).filter((f) => f.toLowerCase().endsWith('.pdf')).sort()) {
  const data = new Uint8Array(readFileSync(join(ART, file)));
  const task = pdfjs.getDocument({ data, useSystemFonts: false, standardFontDataUrl });
  const doc = await task.promise;
  const meta = (await doc.getMetadata().catch(() => ({})))?.info ?? {};

  const pages = [];
  const pageTexts = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items = tc.items.filter((i) => typeof i.str === 'string');
    const text = items.map((i) => i.str).join('');
    pageTexts.push(items.map((i, idx) => (idx > 0 && i.str && items[idx - 1].str ? ' ' : '') + i.str).join(''));

    const xs = items.map((i) => i.transform[4]).filter((v) => Number.isFinite(v));
    const fonts = new Set(items.map((i) => i.fontName));
    const ops = await page.getOperatorList();
    const imgOps = ops.fnArray.filter((f) => f === pdfjs.OPS.paintImageXObject || f === pdfjs.OPS.paintInlineImageXObject).length;
    const pathOps = ops.fnArray.filter((f) => f === pdfjs.OPS.constructPath || f === pdfjs.OPS.stroke || f === pdfjs.OPS.fill).length;

    // crude column detection: histogram of item left-x
    const hist = new Array(40).fill(0);
    for (const x of xs) hist[Math.min(39, Math.max(0, Math.floor((x / vp.width) * 40)))]++;
    const midBand = hist.slice(6, 34).reduce((a, b) => a + b, 0);
    const total = xs.length || 1;
    const gutterFraction = midBand / total;

    pages.push({
      page: p,
      chars: text.length,
      words: items.filter((i) => i.str.trim()).length,
      textItems: items.length,
      fonts: fonts.size,
      imageOps: imgOps,
      pathOps,
      width: Math.round(vp.width),
      height: Math.round(vp.height),
      replacementChars: (text.match(/\uFFFD/g) ?? []).length,
      gutterFraction: +(gutterFraction).toFixed(3),
      likelyTwoColumn: gutterFraction < 0.25 && items.length > 40,
      xMin: xs.length ? Math.round(Math.min(...xs)) : null,
      xMax: xs.length ? Math.round(Math.max(...xs)) : null,
    });
  }

  const full = pageTexts.join('\n');
  const dois = [...new Set((full.match(DOI_RE) ?? []).map((d) => d.replace(/[.,;)]+$/, '')))];
  const urls = [...new Set(full.match(URL_RE) ?? [])];
  const reg = [...new Set(full.match(/ISRCTN\d+|NCT\d{6,}|UMIN\d+|ChiCTR[\w-]+|IRCT[\w-]+/gi) ?? [])];

  const rec = {
    file,
    pages: doc.numPages,
    meta: {
      title: meta.Title || null,
      author: meta.Author || null,
      subject: meta.Subject || null,
      keywords: meta.Keywords || null,
      creator: meta.Creator || null,
      producer: meta.Producer || null,
      creationDate: meta.CreationDate || null,
    },
    totalChars: full.length,
    totalImages: pages.reduce((a, b) => a + b.imageOps, 0),
    twoColumnPages: pages.filter((p) => p.likelyTwoColumn).length,
    dois, urls: urls.slice(0, 8), registration: reg,
    pagesDetail: pages,
  };
  summary.push(rec);

  const stem = file.replace(/[^\w.-]/g, '').replace(/\.pdf$/i, '');
  writeFileSync(join(OUT, `${stem}.page1.txt`), pageTexts[0] ?? '', 'utf8');
  writeFileSync(join(OUT, `${stem}.full.txt`), full, 'utf8');
  await task.destroy();
}

writeFileSync(join(OUT, '_pdf_summary.json'), JSON.stringify(summary, null, 2), 'utf8');

for (const r of summary) {
  console.log('='.repeat(100));
  console.log(`${r.file}  pages=${r.pages} chars=${r.totalChars} images=${r.totalImages} twoColPages=${r.twoColumnPages}`);
  console.log(`  meta.Title    : ${JSON.stringify(r.meta.title)}`);
  console.log(`  meta.Author   : ${JSON.stringify((r.meta.author || '').slice(0, 100))}`);
  console.log(`  meta.Subject  : ${JSON.stringify((r.meta.subject || '').slice(0, 100))}`);
  console.log(`  meta.Keywords : ${JSON.stringify((r.meta.keywords || '').slice(0, 100))}`);
  console.log(`  creator/producer: ${JSON.stringify(r.meta.creator)} / ${JSON.stringify(r.meta.producer)}`);
  console.log(`  DOIs          : ${r.dois.join(' | ') || '(none)'}`);
  console.log(`  Registration  : ${r.registration.join(', ') || '(none)'}`);
  console.log(`  per page      : ${r.pagesDetail.map((p) => `p${p.page}(c=${p.chars},img=${p.imageOps},2c=${p.likelyTwoColumn ? 'Y' : 'n'})`).join(' ')}`);
}
console.log('\nwritten to', OUT);
