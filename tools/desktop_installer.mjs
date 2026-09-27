/**
 * **医生安装包**：软件 + 最近一次抽取结果 + 原文 PDF，一条命令出一个 setup.exe。
 *
 * 与 `desktop_make.mjs`（便携版，*不带数据*）的分工：
 *   便携版  → 给开发者/演示：单文件 exe，工作区自己准备
 *   本脚本  → 给医生：NSIS 安装包，**装完打开就能核对**，不用跑 MinerU、不用配密钥
 *
 * 三步：
 *   1. 编译包 + staging（复用 `desktop_make.mjs --dry`，它已经把这套顺序踩平了）
 *   2. 生成 `build/desktop-payload/` —— 会**被装到 exe 旁边**的工作区
 *   3. electron-builder 打 NSIS 安装包
 *
 * ── 装哪些数据：只带**服务端真正读的**那几样 ──
 *
 * 实测（2026-09，11 年语料）：
 *
 * | 目录 | 原样 | 进包 | 说明 |
 * |---|---|---|---|
 * | `Datas/articles/<年>/*.pdf` | 436 MB | **261 MB** | 只带 `<年>/` 下的正文 PDF；
 * |  |  |  | 根目录的 `2024.zip` 等**原件压缩包**（175 MB）运行时用不到 |
 * | `build/mineru/` | 1303 MB | **287 MB** | ⚠️ 服务端**只读 `<stem>/<sub>/*_middle.json`**
 * |  |  |  | （见 server.mjs 的 `mineruDirOf`/`loadMiniDoc`）； |
 * |  |  |  | 同目录的 `images/`、`*_span.pdf`、`*_layout.pdf`、`*_origin.pdf`、 |
 * |  |  |  | `*_model.json` 全都不读 —— 裁掉它们省了 **1 GB** |
 * | `build/extraction/` | 55 MB | 55 MB | 机器抽取结果（界面显示的就是它） |
 * | `build/gold/` | 14 MB | 14 MB | 金标准：Sheet3「待人工裁定」要靠它算，对照也要 |
 * | `build/annotations/` 等 | — | 空目录 | 核对记录的落点，必须存在且**可写** |
 *
 * ── ⚠️ 一条硬约束：**绝不带 API key** ──
 *
 * `runtime/llm.local.json` 里是真实的 DeepSeek 密钥。装机器的包里塞一份密钥，
 * 等于把密钥发给每一个拿到安装包的人。所以：
 *   · payload 里**只放一个空的 `runtime/`**（`isWorkspace()` 要求它存在，见 main.mjs）
 *   · 装完由医生在「设置」里自己填（**只想核对的话根本不用填**）
 *   · 脚本最后会**全文扫描 payload**，命中 `sk-…` 或 `llm.local.json` 就直接失败退出
 *
 * 用法：
 *   node tools/desktop_installer.mjs                     # 全部年份 + PDF，打安装包
 *   node tools/desktop_installer.mjs --years 2025        # 只带 2025 年
 *   node tools/desktop_installer.mjs --years 2024,2025
 *   node tools/desktop_installer.mjs --no-pdf            # 不带原文（体积最小，但点不了"定位证据"）
 *   node tools/desktop_installer.mjs --skip-tsc          # 跳过编译（已编过）
 *   node tools/desktop_installer.mjs --payload-only      # 只生成 payload，不打包
 *   node tools/desktop_installer.mjs --zip               # 额外再出一个绿色版 zip
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync, readdirSync, statSync, mkdirSync, rmSync, copyFileSync, writeFileSync, readFileSync,
} from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSecretLeaks } from './lib/secret_scan.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PAYLOAD = join(ROOT, 'build', 'desktop-payload');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const arg = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);

const WITH_PDF = !has('no-pdf');
const PAYLOAD_ONLY = has('payload-only');
const WANT_ZIP = has('zip');
const YEARS_ARG = arg('years', 'all');

const EB = join(ROOT, 'node_modules', 'electron-builder', 'cli.js');
const INSTALLER_CFG = 'electron-builder-installer.yml';

const run = (label, cmd, args, cwd = ROOT) => {
  process.stdout.write(`\n── ${label} ──\n`);
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: false });
  if (r.status !== 0) {
    console.error(`✗ ${label} 失败（exit ${r.status}）`);
    process.exit(r.status ?? 1);
  }
};

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const dirSize = (d) => {
  if (!existsSync(d)) return 0;
  let n = 0;
  const walk = (p) => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const f = join(p, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile()) n += statSync(f).size;
    }
  };
  walk(d);
  return n;
};

/* ------------------------------ 挑年份 ------------------------------ */

const extrBase = join(ROOT, 'build', 'extraction');
if (!existsSync(extrBase)) {
  console.error('✗ 没有 build/extraction/ —— 先跑抽取：node tools/llm_run.mjs --year 2015');
  process.exit(1);
}
const available = readdirSync(extrBase).filter((d) => /^\d{4}$/.test(d)).sort();
const years = YEARS_ARG === 'all'
  ? available
  : String(YEARS_ARG).split(',').map((s) => s.trim()).filter(Boolean);
if (!years.length) { console.error('✗ 没挑到任何年份'); process.exit(1); }
for (const y of years) {
  if (!available.includes(y)) {
    console.error(`✗ ${y} 没有抽取产物（可用：${available.join(', ')}）`);
    process.exit(1);
  }
}

/* ------------------------------ 1. 编译 + staging ------------------------------ */

if (!has('skip-tsc')) {
  run('编译包 + staging（复用 desktop_make --dry）',
    process.execPath, [join(ROOT, 'tools', 'desktop_make.mjs'), '--dry']);
} else {
  console.log('\n── 编译 ──\n（--skip-tsc：跳过；⚠️ 前提是已经跑过一次完整打包）');
}

/* ------------------------------ 2. 生成 payload ------------------------------ */

console.log(`\n══ 生成工作区 payload（年份：${years.join(', ')}${WITH_PDF ? '' : '，不含 PDF'}）══\n`);

if (existsSync(PAYLOAD)) rmSync(PAYLOAD, { recursive: true, force: true });
const put = (rel) => { const p = join(PAYLOAD, rel); mkdirSync(dirname(p), { recursive: true }); return p; };
const copyInto = (src, relDir) => {
  const dest = join(PAYLOAD, relDir);
  mkdirSync(dest, { recursive: true });
  copyFileSync(src, join(dest, src.split(/[\\/]/).pop()));
};

let nFiles = 0;
let nPdf = 0; let nMid = 0; let nExtr = 0;

for (const y of years) {
  /* ① 原文 PDF：只取 <年>/ 下的 .pdf，跳过根目录的原件 zip 与 .DS_Store */
  if (WITH_PDF) {
    const src = join(ROOT, 'Datas', 'articles', y);
    if (existsSync(src)) {
      for (const f of readdirSync(src).filter((x) => x.toLowerCase().endsWith('.pdf'))) {
        copyInto(join(src, f), join('Datas', 'articles', y));
        nFiles++; nPdf++;
      }
    }
  }

  /* ② MinerU：**只取 `<stem>/<sub>/*_middle.json`** */
  const mbase = join(ROOT, 'build', 'mineru', y);
  if (existsSync(mbase)) {
    for (const stem of readdirSync(mbase)) {
      const stemDir = join(mbase, stem);
      if (!statSync(stemDir).isDirectory()) continue;
      for (const sub of readdirSync(stemDir)) {
        const subDir = join(stemDir, sub);
        if (!statSync(subDir).isDirectory()) continue;
        const mid = readdirSync(subDir).find((f) => f.endsWith('_middle.json'));
        if (!mid) continue;
        copyInto(join(subDir, mid), join('build', 'mineru', y, stem, sub));
        nFiles++; nMid++;
      }
    }
  }

  /* ③ 抽取结果 */
  const ebase = join(ROOT, 'build', 'extraction', y);
  for (const f of readdirSync(ebase).filter((x) => x.endsWith('.json'))) {
    copyInto(join(ebase, f), join('build', 'extraction', y));
    nFiles++; nExtr++;
  }
}

/* ④ 金标准：**只带所选年份的 `<年>.json`**。
     服务端只按 `join(DIRS.gold, `${year}.json`)` 读（见 buildFromGold / deferredOutcomeRows），
      同目录的 `_reconcile.json` 与 `naive/` 是审计中间件，运行时用不到。 */
let nGold = 0;
for (const y of years) {
  const f = join(ROOT, 'build', 'gold', `${y}.json`);
  if (!existsSync(f)) {
    console.warn(`  ⚠ 缺 build/gold/${y}.json —— 该年的「待人工裁定」与对照会不准`);
    continue;
  }
  copyInto(f, join('build', 'gold'));
  nFiles++; nGold++;
}

/* ⑤ 可写的空落点（核对记录写这里；装了 Program Files 会写不进去，所以按用户安装） */
for (const [rel, note] of [
  ['build/annotations', '这里放**人工核对记录**（一位核对人一份文件）。\r\n重装或换电脑前，请先跑「备份我的核对记录.bat」。\r\n'],
  ['build/adjudications', '这里放**结局行裁定记录**（保留/丢弃）。\r\n重装或换电脑前，请先跑「备份我的核对记录.bat」。\r\n'],
  ['build/review-batches', '这里放每次「导回」的批次快照，用于追溯。\r\n'],
  ['build/imports', '在这里放自己导入的 PDF（或直接用界面上的「导入文章」按钮）。\r\n'],
]) {
  mkdirSync(join(PAYLOAD, rel), { recursive: true });
  put(join(rel, '说明.txt'));
  writeFileSync(join(PAYLOAD, rel, '说明.txt'), `${note}`, 'utf8');
}

/* ⑥ runtime/：只保证目录存在（isWorkspace 要求），**绝不放密钥** */
mkdirSync(join(PAYLOAD, 'runtime'), { recursive: true });
writeFileSync(join(PAYLOAD, 'runtime', '说明.txt'),
  '这个目录必须存在，程序才会把当前文件夹认成工作区。\r\n'
  + '\r\n'
  + 'API 密钥不在这里预置：想重新跑抽取时，用界面右上角「设置」自己填，\r\n'
  + '填完会写到这个目录下的 llm.local.json（只存本机，不会上传）。\r\n'
  + '\r\n'
  + '⚠️ 只想核对已有的抽取结果，**根本不需要填密钥**。\r\n', 'utf8');

/* ⑦ 医生看得懂的说明 + 两个批处理 */

const total = years.reduce((a, y) => a + readdirSync(join(extrBase, y)).filter((x) => x.endsWith('.json')).length, 0);

const readme = [
  'Article Agent 使用说明',
  '======================',
  '',
  '一、怎么启动',
  '  双击桌面上的「Article Agent」图标（或开始菜单里的同名项）。',
  '  第一次打开可能要等十几秒；窗口出来就能用。',
  '',
  '二、能不能马上用？—— 能，不用配置',
  `  这个包里已经带了 ${years.length} 个年份、共 ${total} 篇的机器抽取结果和原文 PDF。`,
  '  打开后：左上角选年份、中间选文章，右边就是抽出来的字段。',
  '  **不需要填 API 密钥**。密钥只在你要"重新跑抽取"时才需要（见第五节）。',
  '',
  '三、每天要做的事（核对）',
  '  1. 右上角「核对人」填上你的名字 —— 不填不能提交',
  '  2. 点右边任意一个字段 → 左边 PDF 会自动跳到出处并高亮，先看证据再判断',
  '  3. 对的点「确认无误」；不对的点「编辑」改成正确的（改错了可以「回滚」）',
  '  4. 机器没抄到的：点「框选证据」，在 PDF 上拖一个框，把出处框给它；',
  '     或者拉到底部「＋ 新增字段」手工补一格',
  '  5. 切到 Sheet3 选项卡：顶部「待人工裁定」里是机器多抽、表格里没有的结局，',
  '     逐个点「保留」或「丢弃」—— **丢弃的不会进导出的表**',
  '  6. 核完点「导出 XLSX」或「导出 CSV」交给负责人',
  '',
  '  详细的图文步骤见随包的《操作教学视频》与 docs/27 大纲。',
  '',
  '四、两个人一起核对',
  '  各人用**自己的名字**分别核对，互不覆盖。',
  '  两人不一致的地方，工具**不会替你选**，会标成"分歧"等第三人仲裁——',
  '  这是故意的：专家分歧本身就是重要信息。',
  '  右上角「核对 N/M」可以看进度和两两一致率。',
  '',
  '五、什么时候需要 API 密钥',
  '  只有当你要**让机器重新抽取一篇文章**时才需要：',
  '  右上角「设置」→ 填 API Key → 「保存」→ 「测试连接」看是否连通。',
  '  密钥只存在本机（runtime\\llm.local.json），不会上传、不会随导出文件外发。',
  '',
  '六、数据放在哪 / 怎么备份',
  '  全部数据就在**本程序所在的文件夹**里：',
  '    Datas\\articles\\   原文 PDF',
  '    build\\extraction\\ 机器抽取结果',
  '    build\\annotations\\ 你的核对记录   ← 最重要',
  '    build\\adjudications\\ 你的结局行裁定',
  '  重装、升级或换电脑前，**双击「备份我的核对记录.bat」**，',
  '  它会在旁边生成一个带日期的备份文件夹，拷走即可。',
  '',
  '七、卸载',
  '  开始菜单 →「Article Agent」→ 卸载（或 Windows「应用和功能」里卸载）。',
  '  ⚠️ 卸载会连核对记录一起删掉 —— **先备份**。',
  '',
  '八、出问题了看哪里',
  `  日志：%APPDATA%\\article-agent\\desktop.log`,
  '  （在文件资源管理器地址栏粘贴这一行就能打开）',
  '',
  `打包时间：${new Date().toISOString().slice(0, 19).replace('T', ' ')}`,
  `包含年份：${years.join(', ')}${WITH_PDF ? '' : '（不含原文 PDF）'}`,
  '',
].join('\r\n');

/* ⚠️ .txt 用 **UTF-8 带 BOM**：Windows 记事本对无 BOM 的 UTF-8 偶尔会按 GBK 解，中文乱码 */
writeFileSync(join(PAYLOAD, '使用说明.txt'), `\uFEFF${readme}`, 'utf8');

/* .bat 保持**纯 ASCII 逻辑 + chcp 65001**：cmd 默认按 OEM 代码页解，UTF-8 中文会乱码，
   所以路径与命令一律 ASCII，只有 echo 的中文依赖 chcp。 */
const backupBat = [
  '@echo off',
  'chcp 65001 >nul',
  'setlocal',
  'cd /d "%~dp0"',
  'set STAMP=%date:~0,4%%date:~5,2%%date:~8,2%_%time:~0,2%%time:~3,2%',
  'set STAMP=%STAMP: =0%',
  'set DEST=%~dp0备份_%STAMP%',
  'echo 正在备份核对记录到:',
  'echo   %DEST%',
  'mkdir "%DEST%" 2>nul',
  'if exist "build\\annotations"    xcopy /E /I /Y "build\\annotations"    "%DEST%\\annotations"    >nul',
  'if exist "build\\adjudications"  xcopy /E /I /Y "build\\adjudications"  "%DEST%\\adjudications"  >nul',
  'if exist "build\\review-batches" xcopy /E /I /Y "build\\review-batches" "%DEST%\\review-batches" >nul',
  'echo.',
  'echo 备份完成。把这个文件夹拷到U盘或网盘即可。',
  'echo.',
  'pause',
].join('\r\n');
writeFileSync(join(PAYLOAD, '备份我的核对记录.bat'), `${backupBat}\r\n`, 'utf8');

const openBat = [
  '@echo off',
  'chcp 65001 >nul',
  'cd /d "%~dp0"',
  'start "" "%~dp0build"',
].join('\r\n');
writeFileSync(join(PAYLOAD, '打开数据文件夹.bat'), `${openBat}\r\n`, 'utf8');

/* ------------------------------ 3. 密钥硬校验 ------------------------------ */

console.log('── 校验：包里不能有 API 密钥 ──\n');

const offenders = findSecretLeaks(PAYLOAD);

if (offenders.length) {
  console.error('✗ payload 里发现了疑似密钥，已中止打包：');
  for (const o of offenders) console.error(`    ${o.rel}  —— ${o.why}`);
  console.error('\n  runtime/llm.local.json 里是真实密钥，绝不能进安装包。');
  process.exit(1);
}
console.log('✓ 未发现 llm.local.json，也未在文本文件里扫到 sk- 形式的密钥\n');

/* ------------------------------ 4. 汇总 ------------------------------ */

const size = dirSize(PAYLOAD);
console.log('── payload 汇总 ──\n');
console.log(`  原文 PDF      ${String(nPdf).padStart(4)} 个`);
console.log(`  MinerU 中间件 ${String(nMid).padStart(4)} 个  （只带 *_middle.json）`);
console.log(`  抽取结果      ${String(nExtr).padStart(4)} 个`);
console.log(`  金标准        ${String(nGold).padStart(4)} 个`);
console.log(`  合计 ${nFiles + nGold} 个文件，${mb(size)}`);
console.log(`  位置 ${relative(ROOT, PAYLOAD)}`);

if (PAYLOAD_ONLY) {
  console.log('\n（--payload-only：不打包）');
  process.exit(0);
}

/* ------------------------------ 5. 打安装包 ------------------------------ */

run('electron-builder nsis（医生安装包）', process.execPath,
  [EB, '--win', 'nsis', '--config', INSTALLER_CFG], join(ROOT, 'apps', 'desktop'));

const outDir = join(ROOT, 'build', 'desktop-installer');
const setup = existsSync(outDir)
  ? readdirSync(outDir).filter((f) => f.endsWith('.exe')).map((f) => join(outDir, f))
  : [];
console.log('\n══ 完成 ══\n');
for (const s of setup) console.log(`  安装包：${relative(ROOT, s)}  ${mb(statSync(s).size)}`);
console.log(`  payload：${relative(ROOT, PAYLOAD)}  ${mb(size)}`);
console.log('\n  自检：node tools/desktop_installer_verify.mjs');

if (WANT_ZIP) {
  const zip = join(outDir, `ArticleAgent-${new Date().toISOString().slice(0, 10)}-绿色版.zip`);
  console.log(`\n── 绿色版 zip（可选）──\n`);
  const r = spawnSync('tar', ['-a', '-c', '-f', zip, '-C', PAYLOAD, '.'], { stdio: 'inherit' });
  if (r.status === 0 && existsSync(zip)) {
    console.log(`  ${relative(ROOT, zip)}  ${mb(statSync(zip).size)}`);
    console.log('  （绿色版：解压后把 exe 也拷进同一层即可，或直接用便携版 exe 指到这里）');
  } else {
    console.log('  ⚠️ tar 不可用，跳过 zip（payload 目录本身就能直接拷走用）');
  }
}
