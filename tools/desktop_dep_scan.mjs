/**
 * **运行时可达依赖扫描**：从真实入口出发，检查打进包里的代码有没有"缺依赖"。
 *
 * 要解决的问题：打包只搬 `@aa/*`（各包 dist）+ 壳代码，**不搬第三方依赖**。
 * 于是只要某个 `.mjs` 里 `import` 了一个第三方包，开发机上永远发现不了
 * （`node_modules` 就在旁边），一到干净机器就 `ERR_MODULE_NOT_FOUND`。
 *
 * ── 为什么按"可达性"扫，而不是扫全目录 ──
 *
 * `tools/` 里有一堆开发/审计脚本（`deck_layout_check.mjs`、`_shot.mjs` …），
 * 它们 import 了 `playwright` 这类打包不会带的依赖。全目录扫描会把它们当成
 * "缺依赖"报警，而服务端**永远不会调用**它们。
 * 真正会跑的只有两个入口：
 *   · `apps/web/server.mjs`  —— Electron 主进程 import 的本地服务
 *   · `tools/llm_run.mjs`    —— 点「抽取」时 spawn 的脚本（以 Electron 作 node）
 *
 * ── 两个取词坑（都踩过）──
 *
 * 1. 只写 `import\s*\(?\s*['"]` 会**漏掉最常见的 `import … from 'x'`**
 *    （`import` 与引号之间还有 `{ … } from`），第一版因此只扫到 39 处、
 *    `server.mjs` 里十几个 import 一个都没中。
 * 2. `import` 会出现在**字符串**里（`if (p === '/api/import')`），
 *    被当成 import 语句；`/from\s*['"]/` 还会命中**停用词数组**
 *    （`'during', 'with', 'from', 'using'`）把 specifier 抓成 `", "`。
 *    所以既要给前导字符加否定环视，也要校验 specifier 的形状。
 *
 * 用法：
 *   node tools/desktop_dep_scan.mjs [app目录]
 *   默认 build/desktop-installer/win-unpacked/resources/app
 */

import { readFileSync, existsSync, statSync, realpathSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';

const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants',
  'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'http',
  'http2', 'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process',
  'punycode', 'querystring', 'readline', 'repl', 'stream', 'string_decoder', 'timers',
  'tls', 'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
]);

/** 说明符提取（四条规则，含前导否定环视避免命中字符串里的 `import`）。 */
const SPECS = [
  /(?<![\w$./-])import\s*\(\s*['"]([^'"\n]+)['"]/g,      // await import('x')
  /(?<![\w$./-])import\s+['"]([^'"\n]+)['"]/g,            // import 'x'（副作用）
  /(?<![\w$.])require\s*\(\s*['"]([^'"\n]+)['"]/g,        // require('x')
  /\bfrom\s*['"]([^'"\n]+)['"]/g,                         // import/export … from 'x'
];

/** 合法模块说明符的形状（模块路径不含空格、不以标点开头）。 */
const VALID_SPEC = /^[@a-zA-Z0-9._:][\w@./:-]*$/;

const ENTRIES = ['apps/web/server.mjs', 'tools/llm_run.mjs'];

/**
 * @param {string} appDir 打包后的 app 目录
 * @returns {{files:number, builtins:string[], bare:string[], missing:{spec:string,from:string}[], suspects:string[]}}
 */
export function scanRuntimeDeps(appDir) {
  const APP = resolve(appDir);
  const entries = ENTRIES.map((e) => join(APP, ...e.split('/'))).filter((p) => existsSync(p));

  const seen = new Set();
  const queue = [...entries];
  const builtinsUsed = new Set();
  const bareUsed = new Set();
  const missing = [];
  const suspects = [];

  const resolveSpec = (spec, fromFile) => {
    if (spec.startsWith('node:')) return { kind: 'builtin', id: spec.slice(5) };
    if (NODE_BUILTINS.has(spec.split('/')[0])) return { kind: 'builtin', id: spec.split('/')[0] };

    const paths = [];
    if (spec.startsWith('.')) {
      const base = resolve(dirname(fromFile), spec);
      paths.push(base, `${base}.mjs`, `${base}.js`, join(base, 'index.mjs'), join(base, 'index.js'));
    } else {
      const root = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      const rest = spec.slice(root.length).replace(/^\//, '');
      paths.push(join(APP, 'node_modules', root, 'dist', rest || 'index.js'));
      paths.push(join(APP, 'node_modules', ...spec.split('/')));
    }
    for (const p of paths) {
      if (existsSync(p) && statSync(p).isFile()) return { kind: 'file', id: realpathSync(p) };
    }
    return null;
  };

  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f)) continue;
    seen.add(f);
    if (!existsSync(f)) continue;

    const src = readFileSync(f, 'utf8');
    for (const re of SPECS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src))) {
        const spec = m[1];
        if (!VALID_SPEC.test(spec)) { suspects.push(`${JSON.stringify(spec)} ← ${relative(APP, f)}`); continue; }
        const r = resolveSpec(spec, f);
        const isBare = !spec.startsWith('.') && !spec.startsWith('/');
        if (!r) {
          missing.push({ spec, from: relative(APP, f) });
          if (isBare) bareUsed.add(spec);
          continue;
        }
        if (r.kind === 'builtin') { builtinsUsed.add(r.id); continue; }
        if (isBare) bareUsed.add(spec);
        queue.push(r.id);
      }
    }
  }

  return {
    files: seen.size,
    builtins: [...builtinsUsed].sort(),
    bare: [...bareUsed].sort(),
    missing,
    suspects,
  };
}

/* ------------------------------ CLI ------------------------------ */

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain || process.argv[1]?.endsWith('desktop_dep_scan.mjs')) {
  const APP = process.argv[2] ?? 'build/desktop-installer/win-unpacked/resources/app';
  if (!existsSync(APP)) { console.error(`✗ 没有 ${APP}`); process.exit(2); }

  const r = scanRuntimeDeps(APP);
  console.log(`\n══ 运行时可达依赖扫描 ══\n${APP}\n`);
  console.log(`  入口：${ENTRIES.join('、')}`);
  console.log(`  可达文件 ${r.files} 个`);
  console.log(`  node 内置 ${r.builtins.length} 个：${r.builtins.join(', ')}`);
  console.log(`  裸包依赖 ${r.bare.length} 个：${r.bare.join(', ') || '（无）'}`);
  if (r.suspects.length) console.log(`  取词假匹配（已忽略）${r.suspects.length} 处`);
  if (!r.missing.length) console.log(`\n  ✓ 运行时用到的模块在包内全部可解析`);
  else {
    console.log(`\n  ✗ 解析失败 ${r.missing.length} 处：`);
    for (const m of r.missing) console.log(`      ${m.spec}\n         ← ${m.from}`);
  }
  console.log(r.missing.length ? '\n✗ 干净机器上会 ERR_MODULE_NOT_FOUND\n' : '\n✓ 通过\n');
  process.exit(r.missing.length ? 1 : 0);
}
