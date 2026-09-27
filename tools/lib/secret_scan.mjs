/**
 * **密钥泄漏扫描**（安装包打包与验收共用）。
 *
 * 为什么单独抽出来：打包脚本和验收脚本各写一份判据，迟早会漂移成
 * "打包放行了、验收报错"或者反过来。口径只能有一份。
 *
 * ── 只扫**文本文件**，这一点很关键 ──
 *
 * 第一版是"除了超过 2MB 的 json 之外全读成 utf8 扫一遍"，结果两个方向都出问题：
 *   · **误报**：Electron 的 `locales\nl.pak`（二进制）里恰好有一段字节
 *     构成 `sk-` + 16 位字母数字，被当成密钥 —— 打包被无谓地拦住；
 *   · **漏报风险**：PDF 也是二进制，随便一段压缩流都可能碰巧匹配，
 *     反过来让人不敢相信这个检查。
 * 所以改成**扩展名白名单**：只读真正会是文本的那几类。
 * 二进制（`.pak` `.dll` `.exe` `.bin` `.pdf` `.png` …）一律跳过。
 */

import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/** 会是文本、且可能承载配置/密钥的扩展名。 */
export const TEXT_EXT = new Set([
  '.json', '.txt', '.md', '.bat', '.cmd', '.ps1',
  '.mjs', '.js', '.cjs', '.ts', '.tsx', '.mts',
  '.csv', '.tsv', '.yml', '.yaml', '.ini', '.cfg', '.conf', '.env', '.log',
]);

/** 真实的 API key 形状（DeepSeek/OpenAI 一类：`sk-` + 一长串）。 */
export const KEY_RE = /sk-[A-Za-z0-9_-]{16,}/;

/** 明确不该出现的文件名。 */
const FORBIDDEN_NAMES = new Set(['llm.local.json']);

/**
 * 扫描一棵目录树，返回泄漏清单。
 * @param {string} root
 * @returns {{rel:string, why:string}[]}
 */
export function findSecretLeaks(root) {
  const out = [];
  if (!existsSync(root)) return out;

  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.isFile()) continue;

      const rel = relative(root, p);
      if (FORBIDDEN_NAMES.has(e.name.toLowerCase())) {
        out.push({ rel, why: '文件名本身（私有配置，绝不该进分发包）' });
        continue;
      }
      if (!TEXT_EXT.has(e.name.slice(e.name.lastIndexOf('.')).toLowerCase())) continue;
      // 超大文本也不必逐字节找（正常配置都是几 KB）
      if (statSync(p).size > 8 * 1024 * 1024) continue;

      let t;
      try { t = readFileSync(p, 'utf8'); } catch { continue; }
      const m = KEY_RE.exec(t);
      if (m) out.push({ rel, why: `正文含 ${m[0].slice(0, 8)}…（已截断，不打印完整密钥）` });
    }
  };

  walk(root);
  return out;
}
