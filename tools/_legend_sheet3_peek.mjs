/**
 * 一次性探针：legend 里 Sheet3 的列条目长什么样（用来接 outcome 列代码 → 中文表头）。
 * 用法：node tools/_legend_sheet3_peek.mjs [year]
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const Y = process.argv[2] ?? '2020';
const j = JSON.parse(readFileSync(join(ROOT, 'build', 'legend', `${Y}.json`), 'utf8'));
for (const [sn, sh] of Object.entries(j.sheets)) {
  console.log(`\n【${sn}】 headerRows=${JSON.stringify(sh.headerRows)} colShift=${sh.colShift} codeRow=${sh.codeRow} fields=${sh.fields.length}`);
  if (sn === 'Sheet3' || sh.fields.length > 60) {
    for (const f of sh.fields.filter((x) => /PVALNUM|PVALRAG|OUTCOM|INSTRU|RANGE|FOLTIM|SUBCONST|CONST|MDIRE|MUNIT|MTYPE|IFADJ|POTIMPO|SPECO|STDATA|ARMNU|STUDYID/.test(JSON.stringify(x))).slice(0, 20)) {
      console.log('   ', JSON.stringify({ col: f.col, field: f.field, hdr: (f.headerLabels ?? []).map((h) => h.text), codes: f.codes }).slice(0, 300));
    }
  } else {
    for (const f of sh.fields.slice(0, 4)) console.log('   ', JSON.stringify({ col: f.col, field: f.field, hdr: (f.headerLabels ?? []).map((h) => h.text), codes: f.codes }).slice(0, 260));
  }
}
