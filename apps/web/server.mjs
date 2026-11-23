/**
 * @aa/web — 本地 API 服务（仅用于开发/演示，绑定 127.0.0.1）
 *
 * 只服务于：
 *   GET /api/health                          健康检查
 *   GET /api/studies?year=2015               某年份可选的研究列表
 *   GET /api/minidoc?year&study              解析文档（blocks + pages，带 bbox）
 *   GET /api/pdf?year&study                  PDF 原始字节（供 pdf.js）
 *
 * 说明：抽取结果目前直接读取 `build/gold/<year>.json`（金标准），
 * 因此「框选比对」这一功能可以先跑起来——用金标准的字段与证据对照 PDF。
 * 待 LLM 接入后，再把 `/api/extraction` 指向流水线产物即可，接口形状不变。
 *
 * 安全：只允许读取 Datas/ 与 build/ 下的文件；路径参数经过白名单校验，
 * 防止目录穿越。
 */

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { studiesFromPdfNames } from '../../packages/core/dist/index.js';

const ROOT = resolve(process.env.AA_ROOT ?? process.cwd());
const PORT = Number(process.env.AA_PORT ?? 43130);

/**
 * 本服务**代码**所在目录（开发时=仓库根；Electron 打包后=exe 内的 app 目录）。
 *
 * 与 `ROOT`（工作区：Datas/build/runtime）区分开：
 * 流水线代码随壳走、用户数据随工作区走，两者在打包后不再是同一个目录。
 */
const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const DIRS = {
  articles: join(ROOT, 'Datas', 'articles'),
  mineru: join(ROOT, 'build', 'mineru'),
  gold: join(ROOT, 'build', 'gold'),
  /** 抽取流水线产物（pnpm llm:run）——前端字段视图的首选数据源 */
  extraction: join(ROOT, 'build', 'extraction'),
  /**
   * 人工标注覆盖层。
   * 刻意与流水线产物分开存放：
   *   - 不改写 LLM 结果，随时可对比"原始 vs 人工"
   *   - 便于计算人工修正率（评估 LLM 质量的关键指标）
   */
  annotations: join(ROOT, 'build', 'annotations'),
  /**
   * 用户导入的 PDF。
   *
   * ⚠️ 刻意**不写进 `Datas/`**：那是只读语料（金标准与原文的来源），
   * 混入用户上传件会让"金标准 vs 语料"的对应关系不可审计。
   * 导入件放在 `build/imports/`，侧车 `.meta.json` 记录原始文件名、大小与 sha256。
   */
  imports: join(ROOT, 'build', 'imports'),
  /** 本地私有配置（API key 等）——只在本机读写，永不回显明文 */
  runtime: join(ROOT, 'runtime'),
};

/* ------------------------------ 标注读写 ------------------------------ */

const annotationPath = (year, study) =>
  join(DIRS.annotations, year, `${study.replace(/^-+/, '')}.json`);

function readAnnotation(year, study) {
  const p = annotationPath(year, study);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;   // 文件损坏不应让整个接口失败
  }
}

function writeAnnotation(year, study, overlay) {
  const p = annotationPath(year, study);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(overlay, null, 2), 'utf8');
}

/** 读取请求体（限制大小，防止误传大文件）。 */
function readBody(req, limitBytes = 1_000_000) {
  return new Promise((resolvePromise, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error(`请求体过大（>${limitBytes} 字节）`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const s = Buffer.concat(chunks).toString('utf8');
        resolvePromise(s ? JSON.parse(s) : {});
      } catch (e) {
        reject(new Error(`JSON 解析失败: ${e.message}`));
      }
    });
    req.on('error', reject);
  });
}

/** 读取二进制请求体（导入 PDF 用）。 */
function readBinary(req, limitBytes = 200 * 1024 * 1024) {
  return new Promise((resolvePromise, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error(`文件过大（>${Math.round(limitBytes / 1024 / 1024)}MB）`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** 仅允许 YYYY 形式的年份。 */
const okYear = (y) => /^\d{4}$/.test(String(y ?? ''));
/** 研究 ID：YYYY-NN 或 YYYY-NN-K，或带前导连字符的文件名形式。 */
const okStudy = (s) => /^-?\d{4}-\d{1,2}(?:-\d{1,2})?$/.test(String(s ?? ''));
/** 导入件的研究 ID 允许字母（用户自己的文件名），但必须是安全的文件名词干。 */
const okImportId = (s) => /^[A-Za-z0-9._\u4e00-\u9fa5-]{1,80}$/.test(String(s ?? '')) && !String(s).includes('..');

/**
 * 研究标识是否可用。
 * 语料是 `YYYY-NN` 形式；**导入件允许任意安全文件名**（用户可能叫 `my-paper`），
 * 因此只要能在两个来源里查到就算合法——否则导入的文章打不开 /api/minidoc。
 */
const studyOk = (year, study) => (okYear(year) && okStudy(study)) || Boolean(pdfPathOf(year, study));

/* ------------------------------ 本地配置（设置菜单） ------------------------------ */

const CONFIG_FILE = () => process.env.AA_LLM_CONFIG ?? join(DIRS.runtime, 'llm.local.json');

/** 读取本地配置；不存在时回落到默认值。 */
function readConfig() {
  const p = CONFIG_FILE();
  let file = {};
  if (existsSync(p)) {
    try { file = JSON.parse(readFileSync(p, 'utf8')); } catch { file = {}; }
  }
  return {
    file,
    // 环境变量优先（与 tools/llm_run.mjs 的取值顺序一致）
    apiKey: process.env.DEEPSEEK_API_KEY ?? file.apiKey ?? '',
    baseUrl: process.env.AA_LLM_BASE_URL ?? file.baseUrl ?? 'https://api.deepseek.com',
    model: process.env.AA_LLM_MODEL ?? file.model ?? 'deepseek-chat',
    provider: file.provider ?? 'deepseek',
    temperature: file.temperature ?? 0,
    maxTokens: file.maxTokens ?? 8000,
    crossrefMailto: file.crossrefMailto ?? '',
  };
}

/**
 * 掩码：只回显前 3 位与后 4 位。
 *
 * 需求要"在设置里配置 API 信息"，但密钥**绝不能**通过接口回显明文
 * （即使本机也可能被截图/日志带走）。前端只拿到掩码，留空即表示"不修改"。
 */
function maskKey(k) {
  const s = String(k ?? '');
  if (!s) return '';
  if (s.length <= 8) return '*'.repeat(s.length);
  return `${s.slice(0, 3)}${'*'.repeat(Math.min(12, s.length - 7))}${s.slice(-4)}`;
}

/** 把可能含密钥的字符串洗掉（错误信息里网关常把 Authorization 原样回显）。 */
function redact(msg, key) {
  let s = String(msg ?? '');
  if (key) s = s.split(key).join('«已隐藏»');
  return s.replace(/(sk-)[A-Za-z0-9]{6,}/g, '$1«已隐藏»');
}

/* ------------------------------ 后台任务（解析 / 抽取） ------------------------------ */

/**
 * 极简后台任务表：`{ id, kind, year, study, state, startedAt, endedAt, log[], exitCode }`
 *
 * 为什么放在内存：这是**本机单用户**工具，任务短命（解析几分钟、抽取十几分钟），
 * 重启后重跑即可；落盘反而要处理"上次没跑完"的脏状态。
 * 同一 (year, study, kind) 同时只允许一个任务，避免并发跑 MinerU 抢显存。
 */
const jobs = new Map();
let jobSeq = 0;

function startJob(kind, year, study, cmd, args, env = {}) {
  for (const j of jobs.values()) {
    if (j.kind === kind && j.year === year && j.study === study && j.state === 'running') return j;
  }
  const id = `${kind}-${++jobSeq}`;
  const job = {
    id, kind, year, study, state: 'running',
    startedAt: new Date().toISOString(), endedAt: null, exitCode: null, log: [],
  };
  jobs.set(id, job);

  const push = (line) => {
    for (const l of String(line).split(/\r?\n/)) {
      if (!l.trim()) continue;
      job.log.push(l.slice(0, 400));
      if (job.log.length > 200) job.log.splice(0, job.log.length - 200);
    }
  };
  push(`$ ${cmd} ${args.join(' ')}`);

  let child;
  try {
    // 参数以数组传入、不经 shell —— 避免注入，也避免路径里的空格被拆开
    child = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, windowsHide: true });
  } catch (e) {
    job.state = 'failed'; job.log.push(`启动失败：${e.message}`);
    job.endedAt = new Date().toISOString();
    return job;
  }
  child.stdout?.on('data', (d) => push(d.toString()));
  child.stderr?.on('data', (d) => push(d.toString()));
  child.on('error', (e) => { job.state = 'failed'; push(`进程错误：${e.message}`); });
  child.on('close', (code) => {
    job.exitCode = code;
    job.state = code === 0 ? 'done' : 'failed';
    job.endedAt = new Date().toISOString();
  });
  return job;
}

/** 列表用的任务快照（日志只给尾部，避免响应过大）。 */
const jobView = (j) => ({
  id: j.id, kind: j.kind, state: j.state, year: j.year, study: j.study,
  startedAt: j.startedAt, endedAt: j.endedAt, exitCode: j.exitCode,
  logTail: j.log.slice(-12),
});

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
  });
  res.end(data);
}

function notFound(res, msg) {
  json(res, 404, { error: msg });
}

/**
 * 列出某年份的 PDF（研究 ID 从文件名推导）。
 *
 * 两个来源合并：
 *   `Datas/articles/<year>`   语料（只读）
 *   `build/imports/<year>`    用户导入（`imported: true`，UI 上标注出来）
 * 语料优先：导入件若与语料同 ID 则不重复列出。
 */
function listStudies(year) {
  const out = [];
  const seen = new Set();

  const dir = join(DIRS.articles, year);
  if (existsSync(dir)) {
    /*
     * ⚠️ 只列**正文** PDF：`2024-12-01.pdf`（附件）、`2024-24-sup.pdf`（补充材料）不能算独立研究。
     * 它们的研究号会被 articleIdOf 归约回正文号（`2024-12-01` → `2024-12`），
     * 于是"全部抽取"会用附件的 1 页材料覆盖正文的产物（实测 2024-12 准确率因此掉到 5.1%）。
     * 判据与 tools/llm_run.mjs 一致，实现在 @aa/core 的 studiesFromPdfNames。
     */
    const files = readdirSync(dir).filter((x) => x.toLowerCase().endsWith('.pdf'));
    const { studies } = studiesFromPdfNames(files);
    for (const s of studies) {
      seen.add(s.studyId);
      out.push({ file: s.file, studyId: s.studyId, source: 'corpus', imported: false });
    }
  }

  const imp = join(DIRS.imports, year);
  if (existsSync(imp)) {
    for (const f of readdirSync(imp).filter((x) => x.toLowerCase().endsWith('.pdf'))) {
      const studyId = f.replace(/\.pdf$/i, '');
      if (seen.has(studyId)) continue;
      out.push({ file: f, studyId, source: 'import', imported: true });
    }
  }

  return out.sort((a, b) => a.studyId.localeCompare(b.studyId));
}

/** 某研究对应的 PDF 绝对路径（语料优先，其次导入件）。 */
function pdfPathOf(year, study) {
  const norm = String(study ?? '').replace(/^-+/, '');
  for (const s of listStudies(year)) {
    if (s.studyId === norm || s.file.replace(/\.pdf$/i, '') === norm) {
      const base = s.source === 'import' ? join(DIRS.imports, year) : join(DIRS.articles, year);
      return { path: join(base, s.file), file: s.file, source: s.source };
    }
  }
  return null;
}

/** 定位 MinerU 产物目录。 */
function mineruDirOf(year, study) {
  const base = join(DIRS.mineru, year);
  if (!existsSync(base)) return null;
  for (const d of readdirSync(base)) {
    if (d === '_clean') continue;
    const stem = d;
    if (stem !== study && stem !== `-${study}`) continue;
    for (const sub of readdirSync(join(base, d))) {
      const dir = join(base, d, sub);
      if (!statSync(dir).isDirectory()) continue;
      if (readdirSync(dir).some((f) => f.endsWith('_middle.json'))) return { dir, stem };
    }
  }
  return null;
}

/** 把 MinerU `_middle.json` 精简成前端需要的 MiniDoc。 */
function loadMiniDoc(year, study) {
  const hit = mineruDirOf(year, study);
  if (!hit) return null;

  const middleFile = readdirSync(hit.dir).find((f) => f.endsWith('_middle.json'));
  const mid = JSON.parse(readFileSync(join(hit.dir, middleFile), 'utf8'));
  const pages = (mid.pdf_info ?? []).map((pg, i) => {
    const s = pg.page_size ?? [595, 793];
    return { page: i + 1, width: s[0], height: s[1], rotate: s[0] > s[1] ? 90 : 0 };
  });

  // 精简 blocks：只回传前端需要的字段（避免把 1.4MB 全推给浏览器）
  const blocks = [];
  const push = (b, pageIdx) => {
    const lines = b.lines ?? [];
    const text = lines
      .flatMap((l) => (l.spans ?? []).map((s) => s.content ?? ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    blocks.push({
      index: blocks.length,
      type: b.type ?? 'text',
      page: pageIdx + 1,
      bbox: b.bbox ?? null,
      text: text.slice(0, 4000),
    });
  };
  (mid.pdf_info ?? []).forEach((pg, pageIdx) => {
    for (const b of pg.para_blocks ?? []) push(b, pageIdx);
  });

  return {
    year,
    studyId: study.replace(/^-+/, ''),
    sourcePdf: `/api/pdf?year=${encodeURIComponent(year)}&study=${encodeURIComponent(study)}`,
    pages,
    blocks,
    stats: { blocks: blocks.length, pages: pages.length },
  };
}

/**
 * 在解析文本里定位一段原文（只读，不落盘）。
 *
 * 与 `@aa/core` 的 locateEvidence 保持同一匹配策略（从严到宽）：
 *   1. 规范化空白后精确子串匹配
 *   2. 去标点/大小写后匹配（容忍 OCR 与标点差异）
 * 因此前端"定位证据"的结果与 LLM 流水线解析 quote 的结果一致。
 */
function locateInDoc(doc, quote) {
  const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const strip = (s) => norm(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const q = norm(quote);
  if (q.length < 2) return null;
  const qs = strip(quote);
  const live = doc.blocks.filter((b) => b.bbox);

  for (const b of live) if (norm(b.text).includes(q)) return { block: b, exact: true };
  if (qs.length >= 2) for (const b of live) if (strip(b.text).includes(qs)) return { block: b, exact: false };
  return null;
}

/**
 * 字段视图服务。
 *
 * 数据来源（按优先级合并）：
 *   1. \`build/gold/<year>.json\`        —— 流水线/金标准产出的字段值
 *   2. \`build/annotations/<year>/<id>.json\` —— 人工覆盖层
 *
 * 合并规则与 @aa/core 的 mergeOverlay 一致：人工优先，并保留原值以便回滚。
 * 字段标签取自 tools/canonical-field-map.mjs（与提示词同源），
 * 保证前端显示的名称与 LLM 抽取时看到的一致。
 */
let canonicalCache = null;

async function loadCanonical() {
  if (!canonicalCache) {
    const mod = await import('../../tools/canonical-field-map.mjs');
    canonicalCache = {
      article: [...mod.ARTICLE_FIELDS, ...mod.STUDY_OUTCOME_FIELDS],
      comparison: mod.COMPARISON_FIELDS,
      outcome: [...mod.OUTCOME_TOP_FIELDS, ...mod.TIMEPOINT_FIELDS],
    };
  }
  return canonicalCache;
}

/**
 * 「原始表格列序」布局（缓存；与年份相关但同年不变）。
 * 实现在 tools/sheet_layout.mjs —— 与 CLI 工具共用，避免两处各写一份表头匹配。
 */
const layoutCache = new Map();
async function loadSheetLayout(year) {
  if (!layoutCache.has(year)) {
    const mod = await import('../../tools/sheet_layout.mjs');
    layoutCache.set(year, mod.buildSheetLayout(year));
  }
  return layoutCache.get(year);
}

/**
 * 字段视图：**优先用流水线产物**（`build/extraction/<year>/<id>.json`），
 * 没有时才退回金标准（`build/gold/<year>.json`）。
 *
 * 为什么优先流水线：需求 1 要的是"框选 **LLM 提取时** 的证据 + 人工修改 LLM 的结果"，
 * 拿金标准当数据源只能演示界面，改的也不是 LLM 的输出。
 * 流水线产物里的字段值都带 evidence（page/bbox/quote），因此点字段就能在 PDF 上定位。
 */
async function buildFieldGroups(year, study) {
  const norm = study.replace(/^-+/, '');
  const extractionFile = join(DIRS.extraction, year, `${norm}.json`);

  if (existsSync(extractionFile)) {
    try {
      const doc = JSON.parse(readFileSync(extractionFile, 'utf8'));
      return await buildFromExtraction(year, study, norm, doc);
    } catch (e) {
      // 产物损坏不应让接口整体失败——降级到金标准
      const fallback = await buildFromGold(year, study, norm);
      return { ...fallback, warning: `流水线产物解析失败（已降级到金标准）：${e.message}` };
    }
  }

  const r = await buildFromGold(year, study, norm);
  return { ...r, ...(r.groups.length ? { warning: '尚未运行抽取流水线，当前显示的是金标准（pnpm llm:run --year ' + year + '）' } : {}) };
}

/** 流水线产物 → 字段视图（含"待人工确认"分组）。 */
async function buildFromExtraction(year, study, norm, doc) {
  const canon = await loadCanonical();
  const overlay = readAnnotation(year, study);
  const byPath = new Map((overlay?.entries ?? []).map((e) => [e.fieldPath, e]));

  const toView = makeToView(byPath);
  const groups = [];

  /* ---- 文章级 ---- */
  const art = doc.article ?? {};
  const artFields = [];
  const used = new Set();
  for (const f of canon.article) {
    const gv = art[f.key];
    if (!gv) continue;
    const v = toView(f.key, f.label ?? f.key, gv, f.key);
    if (v) { artFields.push(v); used.add(f.key); }
  }
  for (const [k, gv] of Object.entries(art)) {
    if (used.has(k) || k === 'articleId' || k === 'external' || k === 'studyOutcomes') continue;
    const v = toView(k, k, gv, k);
    if (v) artFields.push(v);
  }
  for (const e of overlay?.entries ?? []) {
    if (e.fieldPath.includes('.') || artFields.some((f) => f.fieldPath === e.fieldPath)) continue;
    const v = toView(e.fieldPath, e.fieldPath, null, e.fieldPath);
    if (v) artFields.push(v);
  }
  if (artFields.length) groups.push({ id: 'article', title: '文章级（LLM 抽取）', fields: artFields });

  /* ---- Crossref 外部核验（单独一组，便于比对权威值与 PDF 值） ---- */
  const ext = art.external;
  const extFields = [];
  if (ext) {
    const push = (key, label, gv) => {
      const v = toView(`external.${key}`, label, gv, key);
      if (v) extFields.push(v);
    };
    push('doi', 'DOI（Crossref 解析）', ext.resolvedDoi ? { raw: ext.resolvedDoi } : undefined);
    const w = ext.crossref ?? {};
    push('crossrefTitle', 'Crossref 题名', w.title ? { raw: w.title } : undefined);
    push('crossrefJournal', 'Crossref 期刊', w.containerTitle ? { raw: w.containerTitle } : undefined);
    push('crossrefYear', 'Crossref 发表年', w.issuedYear ? { raw: w.issuedYear } : undefined);
    const mism = (ext.comparisons ?? []).filter((c) => c.verdict === 'mismatch');
    if (mism.length) {
      extFields.push({
        fieldPath: 'external.mismatch', label: '与 PDF 不一致的字段',
        raw: mism.map((c) => `${c.field}: PDF「${c.pdfValue ?? ''}」≠ Crossref「${c.crossrefValue ?? ''}」`).join('；'),
        decidedBy: 'external', overridden: false, inGold: true,
      });
    }
    if (extFields.length) {
      groups.push({ id: 'external', title: `Crossref 核验（${ext.verdict ?? '未判定'}）`, fields: extFields, collapsible: true });
    }
  }

  /* ---- Sheet2 结局分类 ---- */
  const so = art.studyOutcomes ?? {};
  const soFields = [];
  const SO_LABEL = {
    primaryOutcome: '主要结局', pain: '疼痛类', nonPain: '非疼痛症状类', function: '功能类',
    qualityOfLife: '生活质量类', importantEvents: '重要事件类', mortality: '死亡率', remarks: '备注',
  };
  for (const [k, gv] of Object.entries(so)) {
    const v = toView(`studyOutcomes.${k}`, SO_LABEL[k] ?? k, gv, k);
    if (v) soFields.push(v);
  }
  if (soFields.length) groups.push({ id: 'studyOutcomes', title: 'Sheet2 结局分类', fields: soFields, collapsible: true });

  /* ---- 比较组 ---- */
  const comparisonGroups = [];
  (doc.comparisons ?? []).forEach((c, i) => {
    const fields = [];
    for (const [k, gv] of Object.entries(c)) {
      if (k === 'studyId') continue;
      const label = canon.comparison.find((f) => f.key === k)?.label ?? k;
      const v = toView(`comparisons.${i}.${k}`, label, gv, k);
      if (v) fields.push(v);
    }
    if (fields.length) {
      groups.push({ id: `cmp-${i}`, title: `比较组 ${i + 1}`, fields, collapsible: true });
      comparisonGroups.push({ id: `cmp-${i}`, title: `比较组 ${i + 1}`, fields });
    }
  });

  /* ---- 结局（按「比较组 × 结局」多行；标题里带上名称/工具便于辨认） ---- */
  /*
   * 人工「纳入抽取」出来的结局行只存在于覆盖层里（不在流水线产物中），
   * 因此行的枚举范围要取「产物行数」与「覆盖层里出现的最大结局下标 + 1」的较大者。
   * 这样点一下「纳入」就能得到一条可编辑的 Sheet3 行（含原始表格的全部列）。
   */
  const ovOutcomeIdx = (overlay?.entries ?? [])
    .map((e) => /^outcomes\.(\d+)\./.exec(e.fieldPath))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  const outcomeRowCount = Math.max((doc.outcomes ?? []).length, ovOutcomeIdx.length ? Math.max(...ovOutcomeIdx) + 1 : 0);

  /**
   * 「人工纳入」行的**空表单模板**：该篇所有结局行出现过的叶子路径并集。
   *
   * 为什么不硬编码字段清单：路径命名（`outcome.constructCode`、`timepoints.<时点>.continuous.<键>`…）
   * 由 outcome/outcome-values 两个 SKILL 决定，在 server 里再抄一份必然漂移。
   * 直接从真实产物里取并集，既完整又自维护——新增字段时这里不用改。
   */
  const formTemplate = new Map();
  const collectLeaves = (obj, prefix) => {
    for (const [k, v] of Object.entries(obj ?? {})) {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) continue;
      const path = `${prefix}${k}`;
      if ('raw' in v) { if (!formTemplate.has(path)) formTemplate.set(path, k); continue; }
      collectLeaves(v, `${path}.`);
    }
  };
  for (const o of doc.outcomes ?? []) collectLeaves(o, '');

  const outcomeRows = [];
  for (let i = 0; i < outcomeRowCount; i++) {
    const o = doc.outcomes?.[i] ?? {};
    const included = i >= (doc.outcomes ?? []).length;
    const fields = [];
    const walk = (obj, prefix) => {
      for (const [k, v] of Object.entries(obj ?? {})) {
        if (v === null || v === undefined || typeof v !== 'object' || Array.isArray(v)) continue;
        const path = `outcomes.${i}.${prefix}${k}`;
        if ('raw' in v) {
          const v2 = toView(path, `${prefix}${k}`, v, k);
          if (v2) fields.push(v2);
        } else {
          walk(v, `${prefix}${k}.`);
        }
      }
    };
    walk(o, '');
    /*
     * 人工纳入的行：按模板铺出**与流水线同样的字段路径**（有覆盖层值的用人工值，
     * 其余为空可编辑），这样人工才有落脚点去补名称/工具/编码/各时点数值。
     */
    if (included) {
      for (const [suffix] of formTemplate) {
        const path = `outcomes.${i}.${suffix}`;
        if (fields.some((x) => x.fieldPath === path)) continue;
        const v = toView(path, suffix, null, suffix.split('.').pop());
        if (v) fields.push(v);
      }
    }
    if (!fields.length) continue;
    const nm = fields.find((f) => f.fieldPath === `outcomes.${i}.outcome.name`)?.raw ?? '';
    const ins = fields.find((f) => f.fieldPath === `outcomes.${i}.outcome.instrument`)?.raw ?? '';
    const title = `结局 ${i + 1}${nm || ins ? `：${nm}${ins ? ` / ${ins}` : ''}` : ''}` +
      `${o.studyId ? `（${o.studyId}）` : ''}${included ? '（人工纳入）' : ''}`;
    groups.push({ id: `out-${i}`, title, fields, collapsible: true });
    outcomeRows.push({ id: `out-${i}`, index: i, title, fields, included });
  }

  /* ---- 待人工确认：归不进六类的候选结局 ---- */
  const others = doc.pipeline?.outcomePlan?.otherOutcomes ?? [];
  const candidateFields = [];
  if (others.length) {
    others.forEach((o, i) => {
      const v = toView(
        `outcomePlan.otherOutcomes.${i}`,
        `${o.name?.raw ?? o.instrument?.raw ?? `候选 ${i + 1}`}${o.instrument?.raw ? ` / ${o.instrument.raw}` : ''}`,
        { raw: '未纳入（非六类结局）', confidence: 0.9, provenance: 'model', ...(o.anchor?.evidence ? { evidence: o.anchor.evidence } : {}) },
        `other-${i}`,
      );
      if (!v) return;
      // 供「纳入抽取」按钮使用：候选自己的名称/工具（写入新行）
      v.candidate = {
        name: o.name?.raw ?? '',
        instrument: o.instrument?.raw ?? '',
        outcomeClass: o.outcomeClass?.raw ?? '',
      };
      candidateFields.push(v);
    });
    if (candidateFields.length) {
      groups.push({
        id: 'otherOutcomes',
        title: `待人工确认纳入（${candidateFields.length} 条非六类候选）`,
        fields: candidateFields,
        collapsible: true,
      });
    }
  }

  /* ---- 三张 Sheet 的选项卡视图（按原始表格列序） ---- */
  const layout = await loadSheetLayout(year);
  const sheets = {
    layoutSource: layout.source ? layout.source.replace(`${ROOT}${sep}`, '') : null,
    headerOf: layout.headerOf,
    order: {
      sheet1: layout.sheet1,
      sheet2: layout.sheet2,
      sheet3: layout.sheet3,
    },
    sheet1: {
      title: 'Sheet1 · 文章级 + 比较组',
      article: artFields,
      comparisons: comparisonGroups,
      external: extFields,
    },
    sheet2: { title: 'Sheet2 · 结局分类', fields: soFields },
    sheet3: {
      title: 'Sheet3 · 结局 × 时点',
      rows: outcomeRows,
      candidates: candidateFields,
      /** 下一个可用的结局行下标（「纳入抽取」写入这里） */
      nextOutcomeIndex: outcomeRowCount,
    },
  };

  const entries = overlay?.entries ?? [];
  return {
    groups,
    sheets,
    source: 'extraction',
    generatedAt: doc.generatedAt ?? null,
    model: doc.pipeline?.modelIds?.[0] ?? null,
    stats: {
      total: entries.length,
      added: entries.filter((e) => e.action === 'add').length,
      overridden: entries.filter((e) => e.action === 'override').length,
      confirmed: entries.filter((e) => e.action === 'confirm').length,
    },
    articleId: norm,
  };
}

/** 金标准 → 字段视图（流水线产物缺失时的降级路径）。 */
async function buildFromGold(year, study, norm) {
  const goldFile = join(DIRS.gold, `${year}.json`);
  if (!existsSync(goldFile)) return { groups: [], stats: emptyStats(), source: 'none', warning: `未找到 build/gold/${year}.json` };

  const goldDoc = JSON.parse(readFileSync(goldFile, 'utf8'));
  const article = (goldDoc.articles ?? []).find((a) => a.article_id === norm);
  if (!article) return { groups: [], stats: emptyStats(), source: 'none', warning: `金标准中未找到 ${norm}` };

  const canon = await loadCanonical();
  const overlay = readAnnotation(year, study);
  const byPath = new Map((overlay?.entries ?? []).map((e) => [e.fieldPath, e]));

  const toView = makeToView(byPath);

  const groups = [];
  const artFields = [];
  const used = new Set();
  for (const f of canon.article) {
    const gv = article.article?.[f.key];
    if (!gv) continue;
    const v = toView(f.key, f.label ?? f.key, gv);
    if (v) { artFields.push(v); used.add(f.key); }
  }
  for (const [k, gv] of Object.entries(article.article ?? {})) {
    if (used.has(k)) continue;
    const v = toView(k, k, gv);
    if (v) artFields.push(v);
  }
  for (const e of overlay?.entries ?? []) {
    if (e.fieldPath.includes('.') || artFields.some((f) => f.fieldPath === e.fieldPath)) continue;
    const v = toView(e.fieldPath, e.fieldPath, null);
    if (v) artFields.push(v);
  }
  groups.push({ id: 'article', title: '文章级', fields: artFields });
  for (const [k, gv] of Object.entries(article.study ?? {})) {
    const v = toView(k, k, gv);
    if (v) {
      const g = groups.find((x) => x.id === 'study') ?? { id: 'study', title: 'Sheet2 结局分类', fields: [] };
      g.fields.push(v);
      if (!groups.includes(g)) groups.push(g);
    }
  }
  for (const e of overlay?.entries ?? []) {
    if (e.fieldPath.includes('.') || artFields.some((f) => f.fieldPath === e.fieldPath)) continue;
    const v = toView(e.fieldPath, e.fieldPath, null);
    if (v && !artFields.includes(v)) artFields.push(v);
  }
  return { groups, source: 'gold', stats: statsOf(overlay), articleId: norm };
}

const emptyStats = () => ({ total: 0, added: 0, overridden: 0, confirmed: 0 });
const statsOf = (overlay) => {
  const entries = overlay?.entries ?? [];
  return {
    total: entries.length,
    added: entries.filter((e) => e.action === 'add').length,
    overridden: entries.filter((e) => e.action === 'override').length,
    confirmed: entries.filter((e) => e.action === 'confirm').length,
  };
};

/** 值 + 人工覆盖层 → FieldView（两条数据源共用）。 */
function makeToView(byPath) {
  return (fieldPath, label, gv, key) => {
    const ann = byPath.get(fieldPath);
    const base = ann ? ann.value : gv;
    if (!base) return null;
    const ev = (base.evidence ?? []).map((e) => ({
      page: e.page, bbox: e.bbox ?? null, quote: e.quote ?? '', kind: e.kind,
    }));
    return {
      fieldPath,
      label: label ?? fieldPath,
      /** 规范清单里的键（camelCase）——前端按「原始表格列序」排序时用它对齐 */
      key: key ?? fieldPath.split('.').pop(),
      raw: base.raw ?? '',
      ...(base.code !== undefined ? { code: base.code } : {}),
      ...(base.legend !== undefined ? { legend: base.legend } : {}),
      decidedBy: ann ? 'human' : (base.provenance ?? 'model'),
      overridden: ann ? ann.action !== 'confirm' : false,
      /** 原始产物里是否存在该字段：false 表示人工新增（写回时用 action='add'） */
      inGold: Boolean(gv),
      ...(base.confidence !== undefined ? { confidence: base.confidence } : {}),
      ...(ev.length ? { evidence: ev } : {}),
      ...(base.missing ? { missing: base.missing } : {}),
      ...(ann && ann.action !== 'confirm' ? { llmRaw: ann.llmValue?.raw ?? gv?.raw ?? '' } : {}),
      ...(ann?.note ? { note: ann.note } : {}),
    };
  };
}

/**
 * 静态托管前端构建产物（`pnpm web:build` 的 dist）。
 *
 * ⚠️ 必须用 `APP_DIR` 而不是 `ROOT`：前者是**壳**（打包后 dist 在 exe 内），
 * 后者是**工作区**（用户的数据目录，那里没有 dist）。
 * 一开始写成 ROOT/apps/web/dist，只因为测试时工作区恰好是仓库根才"看起来正常"——
 * 换成任意工作区就会 404。
 *
 * 这样一条 `pnpm web:api` 就能直接打开 http://127.0.0.1:43130 使用整个界面，
 * 不必再单独起 vite（`pnpm web:dev` 仍保留给需要热更新的开发场景）。
 * dist 不存在时静默跳过，仅提供 /api。
 */
const DIST = join(APP_DIR, 'apps', 'web', 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** 只服务 dist 目录内的文件（resolve 后必须仍在 dist 之下，防目录穿越）。 */
function serveStatic(res, urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath).replace(/^\/+/, '');
  } catch {
    return false;   // 非法百分号编码
  }
  if (rel.includes('\0')) return false;
  const abs = resolve(DIST, rel || 'index.html');
  if (abs !== DIST && !abs.startsWith(DIST + sep)) return false;
  if (!existsSync(abs) || !statSync(abs).isFile()) return false;
  const bytes = readFileSync(abs);
  res.writeHead(200, {
    'content-type': MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream',
    'content-length': bytes.length,
    'cache-control': 'no-store',
  });
  res.end(bytes);
  return true;
}

/* ------------------------------ 路由 ------------------------------ */

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
    const p = url.pathname;
    const year = url.searchParams.get('year') ?? '';
    const study = url.searchParams.get('study') ?? '';

    if (p === '/api/health') {
      return json(res, 200, {
        ok: true,
        root: ROOT,
        dirs: Object.fromEntries(Object.entries(DIRS).map(([k, v]) => [k, existsSync(v)])),
      });
    }

    if (p === '/api/studies') {
      if (!okYear(year)) return json(res, 400, { error: 'year 必须是 4 位数字' });
      const studies = listStudies(year);
      const goldFile = join(DIRS.gold, `${year}.json`);
      let goldCount = null;
      if (existsSync(goldFile)) {
        try {
          goldCount = JSON.parse(readFileSync(goldFile, 'utf8')).articles?.length ?? null;
        } catch { /* 忽略损坏的金标准文件 */ }
      }
      return json(res, 200, { year, studies, goldArticleCount: goldCount });
    }

    if (p === '/api/minidoc') {
      if (!studyOk(year, study)) return json(res, 400, { error: 'year/study 参数非法' });
      const doc = loadMiniDoc(year, study);
      if (!doc) return notFound(res, `未找到 ${year}/${study} 的 MinerU 产物，请先运行 pnpm mineru:batch`);
      return json(res, 200, doc);
    }

    /** 只读定位：把一段原文定位到解析块的坐标（供前端"定位证据"）。 */
    if (p === '/api/locate') {
      if (!studyOk(year, study)) return json(res, 400, { error: 'year/study 参数非法' });
      const quote = url.searchParams.get('q') ?? '';
      if (quote.trim().length < 2) return json(res, 400, { error: 'q 至少 2 个字符' });
      const doc = loadMiniDoc(year, study);
      if (!doc) return notFound(res, `未找到 ${year}/${study} 的 MinerU 产物`);
      const hit = locateInDoc(doc, quote);
      if (!hit) return notFound(res, `解析文本中未找到「${quote.slice(0, 40)}」`);
      return json(res, 200, {
        page: hit.block.page,
        bbox: hit.block.bbox,
        blockId: `b${hit.block.index}`,
        blockType: hit.block.type,
        exact: hit.exact,
        quote: hit.block.text.slice(0, 500),
      });
    }

    if (p === '/api/gold') {
      if (!okYear(year)) return json(res, 400, { error: 'year 参数非法' });
      const f = join(DIRS.gold, `${year}.json`);
      if (!existsSync(f)) return notFound(res, `未找到金标准归一化结果 build/gold/${year}.json`);
      const doc = JSON.parse(readFileSync(f, 'utf8'));
      if (!okStudy(study)) return json(res, 200, doc);
      // 命中具体研究
      const aid = study.replace(/^-+/, '').replace(/-\d{1,2}$/, (m, off, s) => (s.length === 7 ? '' : m));
      const article = (doc.articles ?? []).find((a) => a.article_id === study.replace(/^-+/, ''))
        ?? (doc.articles ?? []).find((a) => a.article_id === aid);
      return json(res, 200, { year: doc.year, counts: doc.counts, article: article ?? null });
    }

    if (p === '/api/fields') {
      if (!studyOk(year, study)) return json(res, 400, { error: 'year/study 参数非法' });
      const r = await buildFieldGroups(year, study);
      return json(res, 200, r);
    }

    if (p === '/api/annotation') {
      if (!studyOk(year, study)) return json(res, 400, { error: 'year/study 参数非法' });

      if (req.method === 'GET') {
        const ov = readAnnotation(year, study);
        return json(res, 200, { overlay: ov, stats: ov ? {
          total: ov.entries.length,
          added: ov.entries.filter((e) => e.action === 'add').length,
          overridden: ov.entries.filter((e) => e.action === 'override').length,
          confirmed: ov.entries.filter((e) => e.action === 'confirm').length,
        } : { total: 0, added: 0, overridden: 0, confirmed: 0 } });
      }

      if (req.method === 'DELETE') {
        const fp = annotationPath(year, study);
        // 带 fieldPath 时只删除该字段的人工标注（= 单字段「回滚」），
        // 否则清空整份覆盖层（= 该研究全部「重置」）。
        const fieldPath = url.searchParams.get('fieldPath') ?? '';
        if (!fieldPath) {
          if (existsSync(fp)) rmSync(fp, { force: true });
          return json(res, 200, { ok: true, removed: 'all' });
        }
        const ov = readAnnotation(year, study);
        if (!ov) return json(res, 200, { ok: true, removed: 0 });
        const before = ov.entries.length;
        ov.entries = ov.entries.filter((e) => e.fieldPath !== fieldPath);
        const removed = before - ov.entries.length;
        if (!ov.entries.length) rmSync(fp, { force: true });
        else writeAnnotation(year, study, { ...ov, updatedAt: new Date().toISOString() });
        return json(res, 200, { ok: true, removed });
      }

      if (req.method === 'POST' || req.method === 'PUT') {
        const body = await readBody(req);
        const artId = study.replace(/^-+/, '');
        const base = readAnnotation(year, study) ?? {
          schemaVersion: 'AA_ANNOTATION/1.0',
          year,
          articleId: artId,
          sourcePdf: `Datas/articles/${year}/${artId}.pdf`,
          entries: [],
          updatedAt: new Date().toISOString(),
        };

        const entries = Array.isArray(body.entries) ? body.entries : [body.entry].filter(Boolean);
        if (!entries.length) return json(res, 400, { error: '缺少 entry/entries' });

        for (const e of entries) {
          if (!e || typeof e.fieldPath !== 'string' || !e.value || typeof e.value.raw !== 'string') {
            return json(res, 400, { error: 'entry 形状非法：需要 { fieldPath, value:{raw,…}, action }' });
          }
          if (!['confirm', 'override', 'add'].includes(e.action)) {
            return json(res, 400, { error: `action 非法：${e.action}` });
          }
          // 同一 fieldPath 只保留最新一条
          const idx = base.entries.findIndex((x) => x.fieldPath === e.fieldPath);
          const rec = { ...e, updatedAt: new Date().toISOString() };
          if (idx >= 0) base.entries[idx] = rec; else base.entries.push(rec);
        }
        base.updatedAt = new Date().toISOString();
        writeAnnotation(year, study, base);
        return json(res, 200, { ok: true, overlay: base, count: base.entries.length });
      }

      return json(res, 405, { error: `不支持的方法 ${req.method}` });
    }

    /* ------------------------------ 设置（API 配置） ------------------------------ */
    if (p === '/api/settings') {
      if (req.method === 'GET') {
        const c = readConfig();
        return json(res, 200, {
          provider: c.provider,
          baseUrl: c.baseUrl,
          model: c.model,
          temperature: c.temperature,
          maxTokens: c.maxTokens,
          crossrefMailto: c.crossrefMailto,
          /** 只回显掩码；前端留空即"不修改" */
          apiKeyMasked: maskKey(c.apiKey),
          hasKey: Boolean(c.apiKey),
          /** 密钥来自环境变量时，界面上说明"改文件不生效" */
          keyFromEnv: Boolean(process.env.DEEPSEEK_API_KEY),
          configPath: CONFIG_FILE().replace(`${ROOT}${sep}`, ''),
        });
      }
      if (req.method === 'PUT' || req.method === 'POST') {
        const body = await readBody(req);
        const path = CONFIG_FILE();
        let cur = {};
        if (existsSync(path)) { try { cur = JSON.parse(readFileSync(path, 'utf8')); } catch { cur = {}; } }
        const next = { ...cur };
        for (const k of ['provider', 'baseUrl', 'model', 'crossrefMailto']) {
          if (typeof body[k] === 'string' && body[k].trim()) next[k] = body[k].trim();
        }
        for (const k of ['temperature', 'maxTokens']) {
          if (body[k] !== undefined && body[k] !== '' && Number.isFinite(Number(body[k]))) next[k] = Number(body[k]);
        }
        // 密钥：空字符串/缺省 = 保留原值（避免"只改模型"时把 key 抹掉）
        if (typeof body.apiKey === 'string' && body.apiKey.trim()) next.apiKey = body.apiKey.trim();
        next._note ??= '本地私有配置，不要提交/外发。也可用环境变量 DEEPSEEK_API_KEY / AA_LLM_MODEL 覆盖 apiKey 与 model。';
        mkdirSync(DIRS.runtime, { recursive: true });
        writeFileSync(path, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
        const c = readConfig();
        return json(res, 200, {
          ok: true,
          baseUrl: c.baseUrl, model: c.model, apiKeyMasked: maskKey(c.apiKey), hasKey: Boolean(c.apiKey),
        });
      }
      return json(res, 405, { error: `不支持的方法 ${req.method}` });
    }

    /*
     * 连通性测试：优先 GET /models（不花 token），失败再退回一次最小的 chat 调用。
     * 响应里**只回状态与耗时**，任何错误都过 redact()，绝不回显密钥。
     */
    if (p === '/api/settings/test' && req.method === 'POST') {
      const body = await readBody(req);
      const c = readConfig();
      const baseUrl = String(body.baseUrl ?? c.baseUrl).replace(/\/+$/, '');
      const apiKey = String(body.apiKey ?? '').trim() || c.apiKey;
      const model = String(body.model ?? c.model);
      if (!apiKey) return json(res, 400, { error: '尚未配置 API Key' });
      const t0 = Date.now();
      try {
        const r = await fetch(`${baseUrl}/models`, { headers: { authorization: `Bearer ${apiKey}` } });
        const text = await r.text();
        if (r.ok) {
          let ids = [];
          try { ids = (JSON.parse(text).data ?? []).map((m) => m.id).slice(0, 20); } catch { /* 忽略 */ }
          return json(res, 200, { ok: true, via: '/models', ms: Date.now() - t0, models: ids, modelInList: ids.includes(model) });
        }
        return json(res, 200, {
          ok: false, via: '/models', status: r.status, ms: Date.now() - t0,
          error: redact(text, apiKey).slice(0, 300),
        });
      } catch (e) {
        return json(res, 200, { ok: false, via: '/models', ms: Date.now() - t0, error: redact(e.message, apiKey) });
      }
    }

    /* ------------------------------ 导入文章 ------------------------------ */
    if (p === '/api/import' && req.method === 'POST') {
      if (!okYear(year)) return json(res, 400, { error: 'year 参数非法' });
      const rawName = decodeURIComponent(String(req.headers['x-file-name'] ?? 'imported.pdf'));
      // 去掉扩展名与**前导连字符/点**：语料的文件名带前导 `-`，导入件不该继承它
      const stem = rawName.replace(/\.pdf$/i, '').replace(/^[-.\s]+/, '')
        .replace(/[^\w\u4e00-\u9fa5.-]+/g, '_').slice(0, 80) || 'imported';
      if (!okImportId(stem)) return json(res, 400, { error: `文件名非法：${rawName}` });
      const buf = await readBinary(req, 200 * 1024 * 1024);
      if (buf.length < 1000 || buf.subarray(0, 4).toString('latin1') !== '%PDF') {
        return json(res, 400, { error: '不是有效的 PDF（缺少 %PDF 头）' });
      }
      const dir = join(DIRS.imports, year);
      mkdirSync(dir, { recursive: true });
      const target = join(dir, `${stem}.pdf`);
      writeFileSync(target, buf);
      writeFileSync(join(dir, `${stem}.meta.json`), JSON.stringify({
        originalName: rawName, studyId: stem, year,
        bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex'),
        importedAt: new Date().toISOString(),
      }, null, 2), 'utf8');
      return json(res, 200, { ok: true, studyId: stem, bytes: buf.length, path: target.replace(`${ROOT}${sep}`, '') });
    }

    if (p === '/api/import' && req.method === 'DELETE') {
      const id = String(study ?? '');
      if (!okYear(year) || !okImportId(id)) return json(res, 400, { error: 'year/study 参数非法' });
      const dir = join(DIRS.imports, year);
      for (const f of [`${id}.pdf`, `${id}.meta.json`]) {
        const fp = join(dir, f);
        if (existsSync(fp)) rmSync(fp, { force: true });
      }
      return json(res, 200, { ok: true });
    }

    /* ------------------------------ 后台任务：MinerU 解析 / LLM 抽取 ------------------------------ */
    if (p === '/api/jobs' && req.method === 'GET') {
      return json(res, 200, { jobs: [...jobs.values()].map(jobView).reverse().slice(0, 20) });
    }

    if (p === '/api/parse' && req.method === 'POST') {
      if (!okYear(year)) return json(res, 400, { error: 'year 参数非法' });
      const hit = pdfPathOf(year, study);
      if (!hit) return json(res, 404, { error: `未找到 ${year} 下的 ${study}.pdf` });
      const mineru = join(ROOT, 'runtime', 'mineru', 'Scripts', 'mineru.exe');
      if (!existsSync(mineru)) return json(res, 500, { error: `MinerU 未安装：${mineru}` });
      // 单篇解析：只把目标 PDF 放进暂存目录，避免整年重跑（MinerU 的 -p 只接受一个路径）
      const stage = join(ROOT, 'build', '_stage_web', year);
      mkdirSync(stage, { recursive: true });
      const staged = join(stage, hit.file);
      writeFileSync(staged, readFileSync(hit.path));
      const job = startJob('parse', year, study, mineru,
        ['-p', staged, '-o', join(DIRS.mineru, year), '-b', 'pipeline', '-m', 'txt'],
        { MINERU_MODEL_SOURCE: 'local' });
      return json(res, 200, { ok: true, job: jobView(job) });
    }

    if (p === '/api/extract' && req.method === 'POST') {
      if (!studyOk(year, study)) return json(res, 400, { error: 'year/study 参数非法' });
      /*
       * 三处路径语义要分清：
       *   `ROOT`    = 工作区（Datas / build / runtime）——用户的数据，随目录走
       *   `APP_DIR` = 本服务代码所在目录（开发时=仓库根，打包后=exe 内的 app 目录）——随壳走
       * 流水线代码（tools、各包的 dist）属于壳，因此用 APP_DIR 解析。
       *
       * `ELECTRON_RUN_AS_NODE=1`：桌面端里 `process.execPath` 是 Electron 主程序，
       * 带这个环境变量才会以 node 模式跑脚本（对普通 node 无副作用）。
       */
      const job = startJob('extract', year, study, process.execPath,
        [join(APP_DIR, 'tools', 'llm_run.mjs'), '--year', year, '--only', String(study).replace(/^-+/, '')],
        { ELECTRON_RUN_AS_NODE: '1' });
      return json(res, 200, { ok: true, job: jobView(job) });
    }

    if (p === '/api/pdf') {
      if (!studyOk(year, study)) return json(res, 400, { error: 'year/study 参数非法' });
      const hit = pdfPathOf(year, study);
      if (!hit) return notFound(res, `未找到 ${year} 下的 ${study}.pdf`);
      const bytes = readFileSync(hit.path);
      res.writeHead(200, {
        'content-type': 'application/pdf',
        'content-length': bytes.length,
        'cache-control': 'no-store',
      });
      return res.end(bytes);
    }

    // 前端静态资源（非 /api 路径）
    if (req.method === 'GET' && !p.startsWith('/api/')) {
      if (serveStatic(res, p)) return;
      if (!extname(p) && serveStatic(res, '/index.html')) return;   // SPA 兜底
      if (existsSync(DIST)) return notFound(res, `未找到资源 ${p}`);
      return json(res, 404, {
        error: '前端产物不存在：请先运行 pnpm web:build（或改用 pnpm web:dev 起 vite 开发服务器）',
      });
    }

    notFound(res, `未知路径 ${p}`);
  } catch (err) {
    json(res, 500, { error: String(err?.message ?? err) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`@aa/web API 已启动: http://127.0.0.1:${PORT}`);
  console.log(`  根目录: ${ROOT}`);
  console.log(`  前端页面: ${existsSync(DIST) ? `http://127.0.0.1:${PORT}/ （dist 已构建）` : '未构建，请先 pnpm web:build'}`);
  for (const [k, v] of Object.entries(DIRS)) {
    console.log(`  ${k.padEnd(9)} ${existsSync(v) ? '✓' : '✗'} ${v}`);
  }
});
