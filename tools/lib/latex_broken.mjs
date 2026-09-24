/**
 * "这个数字在修复前是不是被 LaTeX 拆散了？"——共用的判定实现。
 *
 * ── 为什么不能用"多重集差" ──────────────────────────────────
 * 最初的做法是：`numsOf(清洗后) - numsOf(清洗前)`，把差集当作"被救回的数字"。
 * 这会被两类噪声污染，且**污染方向都是虚高**：
 *   ① **单字符值**：金标准里的编码字段取值就是 `1`、`4`、`5` 这类单个数字，
 *      而"被拆散"的文本里满地都是单个数字，于是它们全被判成"受影响"。
 *      实测 2018-09 的 131 个"受影响字段"里绝大多数是这种假匹配（`control_type=4`、
 *      `primary_outcome=1. WOMAC pain`），把定向 A/B 的结论完全带偏。
 *   ② 网格与正则的取格差异（colspan/rowspan、漏配的 `<td>`）会造出假的"新增数字"。
 *
 * ── 现在用的判据（直接、正向、无歧义）────────────────────────
 *   值 `v` 算"修复前被拆散"，当且仅当：
 *     · **清洗前**的原文里**找不到** `v` 这个字符串；且
 *     · **清洗后**的原文里**能找到** `v`。
 *   即"这个数修复前确实读不出来，修复后才读得出来"。单字符值天然被排除
 *   （`1` 在任何一页原文里都能找到）。
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { deLatex } from '../../packages/core/dist/index.js';

/** 统一负号（原生 PDF 用 U+2212 `−`，MinerU 用 ASCII `-`），便于字面比较。 */
export const unifyMinus = (t) => String(t ?? '').replace(/[−–—]/g, '-');

const decodeEntities = (s) => String(s)
  .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** 老口径的单元格文本（只去标签、不清洗 LaTeX）——用于还原"修复前模型看到的文本"。 */
const legacyCell = (s) => decodeEntities(String(s).replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

/**
 * 取一篇的"修复前原文"与"修复后原文"。
 *
 * 两条来源都要（与线上 ingest 的两处接入点对应）：
 *   · **表格**：单元格文本；修复前 = 老口径 `legacyCell`，修复后 = `deLatex` 后再取格；
 *   · **正文段落**：`span.content`；修复前 = 原样，修复后 = `deLatex`。
 */
export function materialTexts(rootDir, year, id) {
  const base = join(rootDir, 'build', 'mineru', year);
  if (!existsSync(base)) return null;
  const dirName = readdirSync(base).find((d) => d.replace(/^-+/, '') === id);
  if (!dirName) return null;
  const txtDir = join(base, dirName, 'txt');
  if (!existsSync(txtDir)) return null;
  const midFile = readdirSync(txtDir).find((f) => f.endsWith('_middle.json'));
  if (!midFile) return null;

  let mid;
  try { mid = JSON.parse(readFileSync(join(txtDir, midFile), 'utf8')); } catch { return null; }

  const rawParts = [];
  const cleanParts = [];
  const cellRegex = /<(td|th)([^>]*)>([\s\S]*?)<\/\1>/gi;

  for (const page of mid.pdf_info ?? []) {
    const walkText = (blocks) => {
      for (const b of blocks ?? []) {
        if (String(b.type ?? '').toLowerCase() !== 'table') {
          for (const l of b.lines ?? []) {
            for (const s of l.spans ?? []) {
              const c = String(s.content ?? '');
              if (!c.trim()) continue;
              rawParts.push(c);
              cleanParts.push(deLatex(c));
            }
          }
        }
        if (b.blocks) walkText(b.blocks);
      }
    };
    for (const b of page.para_blocks ?? []) {
      if (String(b.type ?? '').toLowerCase() !== 'table') continue;
      for (const c of b.blocks ?? []) {
        if (String(c.type ?? '').toLowerCase() !== 'table_body') continue;
        for (const l of c.lines ?? []) {
          for (const s of l.spans ?? []) {
            const html = String(s.html ?? '');
            if (!html) continue;
            /* 修复前：每格原样（不清洗）；修复后：先在标签完整时清洗，再去标签 */
            const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
            for (const r of rows) {
              const cells = [...String(r[1] ?? '').matchAll(cellRegex)];
              for (const cell of cells) rawParts.push(legacyCell(cell[3] ?? ''));
            }
            cleanParts.push(decodeEntities(deLatex(html).replace(/<[^>]+>/g, ' ')));
          }
        }
      }
    }
    walkText(page.para_blocks);
    walkText(page.discarded_blocks);
  }

  return {
    raw: unifyMinus(rawParts.join('\n')),
    clean: unifyMinus(cleanParts.join('\n')),
  };
}

/** 值 `v` 是否"修复前读不出来、修复后才读得出来"。 */
export function wasBroken(texts, v) {
  if (!texts || !v) return false;
  const needle = unifyMinus(String(v));
  if (needle.length < 2) return false;              // 单字符值一律不算（遍地都是，无鉴别力）
  return !texts.raw.includes(needle) && texts.clean.includes(needle);
}
