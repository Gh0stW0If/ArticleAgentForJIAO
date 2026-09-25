/**
 * @aa/web — 主界面
 *
 * 布局：
 *   顶栏      左：年份 / 研究 / 导入文章 / 解析 / 抽取    右：设置（API 配置）
 *   左 = PDF **连续滚动**查看 + 框选（浏览模式：查看命中的解析块；标注模式：框选即产出证据）
 *   右 = 三张选项卡（Sheet1 / Sheet2 / Sheet3），字段按**原始表格列序**排布，可编辑/确认/回滚
 *
 * 数据流：
 *   GET  /api/fields                       → 字段视图（流水线值 + 多人核对合并；含 sheets 布局）
 *   GET  /api/annotation?reviewer=…        → 某核对人的记录 + 全部核对人进度 + 分歧 + 两两一致率
 *   POST /api/annotation {reviewer,…}      → 写入某核对人的标注（confirm / override / add）
 *   DELETE /api/annotation?reviewer=…&fieldPath=… → 单字段回滚（按核对人）
 *   GET  /api/export?format=xlsx|csv       → 导出人工核对结果（每个字段一行，每位核对人三列）
 *   POST /api/import                       → 导入 PDF（写入 build/imports，不动 Datas/）
 *   POST /api/parse | /api/extract         → 后台任务（MinerU 解析 / LLM 抽取）
 *   GET  /api/jobs                         → 任务状态与日志尾部
 *
 * 「人工修改」的存储原则：绝不改写流水线产物，只写独立的覆盖层
 * （见 packages/core/src/annotation.ts），因此随时可对比"原始 vs 人工"。
 *
 * 多人机核对（202609）：**一位核对人一份文件** —— `build/annotations/<year>/<study>.<reviewer>.json`。
 * 各人独立盲评、互不覆盖；结论一致的字段才生效，**有分歧的字段不替人取值**（保留机器原值并标出），
 * 等第三方仲裁。核对人身份存在 localStorage，提交时随请求带上。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PdfViewer, type Selection, type SelectMode } from './PdfViewer.tsx';
import { ExtractionPanel } from './ExtractionPanel.tsx';
import { SettingsPanel } from './SettingsPanel.tsx';
import { ReviewToolsPanel } from './ReviewToolsPanel.tsx';
import { T, R, SH, tint, ghostBtn, primaryBtn, input as inputS } from './theme.ts';
import type { Bbox } from './geometry.ts';
import type { FieldView, JobInfo, MiniDoc, SheetsPayload, StudyEntry } from './types.ts';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const YEARS = ['2015', '2016', '2017', '2018', '2019', '2020', '2021', '2022', '2023', '2024', '2025'];

interface Highlight { page: number; bbox: Bbox; label: string; color?: string; human?: boolean }

/** 证据类型（与 @aa/core 的 Evidence.kind 对齐）。 */
type EvKind = 'text' | 'table' | 'figure' | 'caption' | 'footnote' | 'external';

interface UiEvidence { kind: EvKind; page: number; bbox: Bbox | null; quote: string; blockId?: string }

const EMPTY_SHEETS: SheetsPayload = {
  layoutSource: null,
  headerOf: {},
  order: { sheet1: { article: [], comparison: [] }, sheet2: [], sheet3: { top: [], timepoint: { baseline: [], endOfTreatment: [], followUpEnd: [] } } },
  sheet1: { title: 'Sheet1', article: [], comparisons: [], external: [] },
  sheet2: { title: 'Sheet2', fields: [] },
  sheet3: { title: 'Sheet3', rows: [], candidates: [], nextOutcomeIndex: 0 },
};

/** MinerU 块类型 → 证据类型。 */
function evKindOf(blockType: string | undefined): EvKind {
  if (blockType === 'table') return 'table';
  if (blockType === 'image' || blockType === 'figure') return 'figure';
  if (blockType === 'title') return 'text';
  return 'text';
}

/** 一位核对人的工作量（`/api/annotation` 的 `reviewers`）。 */
interface ReviewerSummary {
  reviewer: string;
  total: number;
  added: number;
  overridden: number;
  confirmed: number;
  updatedAt: string | null;
}

/** 多人机核对汇总（`/api/annotation` 的 `reviewers` + `consensus`）。 */
interface ReviewSummary {
  reviewers: ReviewerSummary[];
  consensus: {
    stats: {
      total: number; agreed: number; disputed: number; single: number;
      machineOnly: number; reviewed: number; changed: number;
    };
    disputed: {
      fieldPath: string;
      machineRaw: string | null;
      opinions: { reviewer: string; raw: string; action: string }[];
    }[];
    pairwise: { reviewerA: string; reviewerB: string; common: number; same: number; disputed: number; rate: number | null }[];
  };
}

const EMPTY_REVIEW: ReviewSummary = {
  reviewers: [],
  consensus: {
    stats: { total: 0, agreed: 0, disputed: 0, single: 0, machineOnly: 0, reviewed: 0, changed: 0 },
    disputed: [],
    pairwise: [],
  },
};

/**
 * 核对人身份的本地存储键。
 *
 * 为什么必须持久化：多人核对是**按人留痕**的（服务端强制校验 reviewer）。
 * 每次刷新都要重填姓名，人会干脆不填或随手填一个——两种都会污染"人机核对"数据。
 */
const REVIEWER_KEY = 'aa.reviewer';

export default function App() {
  const [year, setYear] = useState('2015');
  const [studies, setStudies] = useState<StudyEntry[]>([]);
  const [study, setStudy] = useState('');
  const [doc, setDoc] = useState<MiniDoc | null>(null);
  const [sheets, setSheets] = useState<SheetsPayload>(EMPTY_SHEETS);
  const [annStats, setAnnStats] = useState({ total: 0, added: 0, overridden: 0, confirmed: 0 });
  /*
   * 多人机核对：核对人身份 + 汇总。
   * 「草稿」与「生效」分开——输入框 onBlur / 回车才生效，否则每敲一个字就重新拉一遍汇总。
   */
  const [reviewer, setReviewer] = useState(() => {
    try { return window.localStorage.getItem(REVIEWER_KEY) ?? ''; } catch { return ''; }
  });
  const [reviewerDraft, setReviewerDraft] = useState(reviewer);
  const [review, setReview] = useState<ReviewSummary>(EMPTY_REVIEW);
  const [reviewOpen, setReviewOpen] = useState(false);
  /** 人工核对工具面板：null = 关闭；否则是当前选项卡。 */
  const [toolsTab, setToolsTab] = useState<'import' | 'compare' | null>(null);
  /** 批量导出菜单是否展开。 */
  const [batchOpen, setBatchOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [focusPage, setFocusPage] = useState<number | undefined>(undefined);
  const [focusToken, setFocusToken] = useState(0);
  const [scale, setScale] = useState(1.1);
  const [showBlocks, setShowBlocks] = useState(false);
  const [mode, setMode] = useState<SelectMode>('browse');
  const [markingField, setMarkingField] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [status, setStatus] = useState('就绪');
  /**
   * 独立于 status 的**通知**（导入完成、纳入完成这类"结果性"消息）。
   *
   * 为什么不能只用 status：切换研究会触发 minidoc/字段重新加载，那些流程会 setStatus
   * （"加载 …"→"11 块 / 11 页"），把刚写进去的"已导入…"瞬间冲掉——实测用户根本看不到
   * 导入是否成功（e2e 也是这么发现的）。结果性消息必须有独立、不会被覆盖的位置。
   */
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [jobs, setJobs] = useState<JobInfo[]>([]);
  const [showJobLog, setShowJobLog] = useState(false);
  const pdfRef = useRef<pdfjs.PDFDocumentProxy | null>(null);
  const [pdf, setPdf] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  /* ------------------------------ 研究列表 ------------------------------ */
  const loadStudies = useCallback(async (y: string, keep?: string) => {
    setStatus(`加载 ${y} 研究列表…`);
    try {
      const d = await (await fetch(`/api/studies?year=${y}`)).json();
      const list: StudyEntry[] = d.studies ?? [];
      setStudies(list);
      const next = keep && list.some((s) => s.studyId === keep) ? keep : (list[0]?.studyId ?? '');
      setStudy(next);
      setStatus(list.length ? `${y}: ${list.length} 篇` : `${y} 下没有 PDF`);
      return next;
    } catch (e) {
      setStatus(`研究列表加载失败: ${(e as Error).message}`);
      return '';
    }
  }, []);

  useEffect(() => { void loadStudies(year); }, [year, loadStudies]);

  /* ------------------------------ 字段视图 ------------------------------ */
  const loadFields = useCallback(async (y: string, s: string) => {
    if (!s) return;
    try {
      const r = await fetch(`/api/fields?year=${y}&study=${encodeURIComponent(s)}`);
      const d = await r.json();
      if (!r.ok) { setStatus(`字段加载失败: ${d.error}`); return; }
      setSheets(d.sheets ?? EMPTY_SHEETS);
      setAnnStats(d.stats ?? { total: 0, added: 0, overridden: 0, confirmed: 0 });
      if (d.warning) setStatus(d.warning);
    } catch (e) {
      setStatus(`字段加载失败: ${(e as Error).message}`);
    }
  }, []);

  /* --------------------------- 多人核对汇总 --------------------------- */
  const loadReview = useCallback(async (y: string, s: string, r: string) => {
    if (!s) { setReview(EMPTY_REVIEW); return; }
    try {
      const q = r ? `&reviewer=${encodeURIComponent(r)}` : '';
      const d = await (await fetch(`/api/annotation?year=${y}&study=${encodeURIComponent(s)}${q}`)).json();
      setReview({ reviewers: d.reviewers ?? [], consensus: d.consensus ?? EMPTY_REVIEW.consensus });
    } catch {
      // 汇总失败不该拖垮字段视图：静默保留上一次的汇总
    }
  }, []);

  useEffect(() => { void loadReview(year, study, reviewer); }, [year, study, reviewer, loadReview]);

  /**
   * 导出人工核对结果。
   *
   * `scope`：单篇 / 整年 / 全部年份。服务端直接从**界面同一份数据**生成，
   * 所以文件与屏幕必然一致。
   *
   * 用 fetch + blob 而不是 `<a download>`：出错时（比如该篇没有可导出的字段）
   * 能拿到中文错误信息显示出来，而不是把浏览器导航到一个 JSON 页面。
   */
  const onExport = useCallback(async (
    format: 'xlsx' | 'csv',
    scope: 'study' | 'year' | 'all' = 'study',
  ) => {
    if (scope === 'study' && !study) { setStatus('请先选择一篇文章'); return; }
    setBatchOpen(false);
    setBusy(true);
    setStatus(scope === 'study' ? '导出中…' : '批量导出中（篇数多时需要几秒）…');
    try {
      const q = scope === 'study'
        ? `year=${year}&study=${encodeURIComponent(study)}&format=${format}`
        : (scope === 'year' ? `year=${year}&format=${format}` : `scope=all&format=${format}`);
      const r = await fetch(`/api/export?${q}`);
      if (!r.ok) {
        const d = await r.json().catch(() => ({} as { error?: string }));
        setStatus(`导出失败：${d.error ?? r.status}`);
        return;
      }
      // 文件名在 content-disposition 里（中文名走 RFC 5987 的 filename*）
      const cd = r.headers.get('content-disposition') ?? '';
      const m = /filename\*=UTF-8''([^;]+)/i.exec(cd);
      const fallback = scope === 'study' ? `人工核对_${year}_${study}.${format}`
        : (scope === 'year' ? `人工核对_${year}_全部.${format}` : `人工核对_全部年份.${format}`);
      const name = m?.[1] ? decodeURIComponent(m[1]) : fallback;

      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setStatus(`已导出 ${name}`);
    } catch (e) {
      setStatus(`导出失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [year, study]);

  /** 提交核对人改名（输入框失焦 / 回车）。 */
  const commitReviewer = useCallback(() => {
    const next = reviewerDraft.trim();
    setReviewer(next);
    try {
      if (next) window.localStorage.setItem(REVIEWER_KEY, next);
      else window.localStorage.removeItem(REVIEWER_KEY);
    } catch { /* 隐私模式下 localStorage 不可用：不影响本次会话 */ }
    if (next && next !== reviewer) setStatus(`核对人已切换为「${next}」，此前提交的记录仍归原核对人`);
  }, [reviewerDraft, reviewer]);

  /* --------------------------- MiniDoc + 字段 --------------------------- */
  useEffect(() => {
    if (!study) { setDoc(null); setSheets(EMPTY_SHEETS); return; }
    let cancelled = false;
    setStatus(`加载 ${study} …`);

    fetch(`/api/minidoc?year=${year}&study=${encodeURIComponent(study)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error ?? r.statusText);
        return r.json() as Promise<MiniDoc>;
      })
      .then((md) => {
        if (cancelled) return;
        setDoc(md);
        setPage(1);
        setSelection(null);
        setHighlights([]);
        setMarkingField(null);
        setMode('browse');
        setStatus(`${md.studyId}: ${md.stats.blocks} 块 / ${md.stats.pages} 页`);
      })
      .catch((e) => { if (!cancelled) setStatus(`解析文档加载失败: ${e.message}`); });

    void loadFields(year, study);
    return () => { cancelled = true; };
  }, [year, study, loadFields]);

  /* ------------------------------ PDF ------------------------------ */
  useEffect(() => {
    if (!study) return;
    let cancelled = false;
    (async () => {
      try {
        const prev = pdfRef.current;
        const p = await pdfjs.getDocument({
          url: `/api/pdf?year=${year}&study=${encodeURIComponent(study)}`,
        }).promise;
        if (cancelled) { void p.destroy(); return; }
        pdfRef.current = p;
        setPdf(p);
        // 旧文档延后销毁：等 React 提交新文档后再释放，否则会打断旧页渲染，闪现"渲染失败"
        if (prev) setTimeout(() => { void prev.destroy(); }, 0);
      } catch (e) {
        if (!cancelled) setStatus(`PDF 加载失败: ${(e as Error).message}`);
      }
    })();
    return () => { cancelled = true; };
  }, [year, study]);

  /* ------------------------------ 后台任务 ------------------------------ */
  const refreshJobs = useCallback(async () => {
    try {
      const d = await (await fetch('/api/jobs')).json();
      setJobs(d.jobs ?? []);
      return (d.jobs ?? []) as JobInfo[];
    } catch { return []; }
  }, []);

  const runningJob = jobs.find((j) => j.state === 'running' && j.year === year && j.study === study);

  useEffect(() => {
    if (!runningJob) return;
    const t = setInterval(async () => {
      const list = await refreshJobs();
      const done = list.find((j) => j.id === runningJob.id && j.state !== 'running');
      if (done) {
        if (done.state === 'done') {
          if (done.kind === 'extract') await loadFields(year, study);
          setStatus(`${done.kind === 'parse' ? 'MinerU 解析' : 'LLM 抽取'}完成（${done.id}）`);
        } else {
          setStatus(`${done.kind} 失败（exit ${done.exitCode}）——展开任务日志查看`);
        }
      }
    }, 2000);
    return () => clearInterval(t);
  }, [runningJob, refreshJobs, loadFields, year, study]);

  const startJob = useCallback(async (kind: 'parse' | 'extract') => {
    setBusy(true);
    try {
      const r = await fetch(`/api/${kind}?year=${year}&study=${encodeURIComponent(study)}`, { method: 'POST' });
      const d = await r.json();
      if (!r.ok) { setStatus(`${kind} 启动失败：${d.error}`); return; }
      setStatus(`${kind === 'parse' ? 'MinerU 解析' : 'LLM 抽取'}已启动：${d.job.id}`);
      setShowJobLog(true);
      await refreshJobs();
    } catch (e) {
      setStatus(`启动失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [year, study, refreshJobs]);

  /* ------------------------------ 导入文章 ------------------------------ */
  const onPickFile = useCallback(async (file: File) => {
    setBusy(true);
    setStatus(`导入 ${file.name}…`);
    try {
      const buf = await file.arrayBuffer();
      const r = await fetch(`/api/import?year=${year}`, {
        method: 'POST',
        headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent(file.name) },
        body: buf,
      });
      const d = await r.json();
      if (!r.ok) { setStatus(`导入失败：${d.error}`); return; }
      /*
       * ⚠️ 先刷新列表、再写状态：`loadStudies` 自己会 setStatus("2015: 7 篇")，
       * 顺序反了会把"已导入…"这条关键反馈冲掉（实测 e2e 就是这样发现界面没提示的）。
       */
      await loadStudies(year, d.studyId);
      setNotice(`已导入 ${file.name} → ${d.studyId}（${Math.round(d.bytes / 1024)} KB）；可点「解析」跑 MinerU`);
    } catch (e) {
      setStatus(`导入失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [year, loadStudies]);

  /* ------------------------------ 字段索引 ------------------------------ */
  const allFields = useMemo(() => {
    const out: FieldView[] = [
      ...sheets.sheet1.article, ...sheets.sheet1.external,
      ...sheets.sheet1.comparisons.flatMap((g) => g.fields),
      ...sheets.sheet2.fields,
      ...sheets.sheet3.rows.flatMap((r) => r.fields),
      ...sheets.sheet3.candidates,
    ];
    return out;
  }, [sheets]);

  const findField = useCallback((fieldPath: string): FieldView | null =>
    allFields.find((f) => f.fieldPath === fieldPath) ?? null, [allFields]);

  /** 现有证据（改值时沿用，避免"改个错别字就丢证据"）。 */
  const currentEvidence = useCallback((fieldPath: string): UiEvidence[] => {
    const cur = findField(fieldPath);
    return (cur?.evidence ?? []).map((e) => ({
      kind: (e.kind ?? 'text') as EvKind,
      page: e.page,
      bbox: e.bbox,
      quote: e.quote,
    }));
  }, [findField]);

  /* ------------------------------ 标注写入 ------------------------------ */

  const postAnnotation = useCallback(async (
    entry: {
      fieldPath: string;
      action: 'confirm' | 'override' | 'add';
      value: { raw: string; evidence?: UiEvidence[]; provenance: 'human'; confidence: number };
      note?: string;
    },
  ): Promise<boolean> => {
    /*
     * 核对人必填（服务端也会校验一次）。这里先拦是为了给出**看得懂的话**，
     * 而不是把 400 的错误原文抛给医生。
     */
    if (!reviewer) {
      setStatus('请先填写「核对人」再提交——多人核对按人留痕，不接受匿名写入');
      return false;
    }
    setBusy(true);
    try {
      const r = await fetch(
        `/api/annotation?year=${year}&study=${encodeURIComponent(study)}&reviewer=${encodeURIComponent(reviewer)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reviewer, entry }),
        },
      );
      const d = await r.json();
      if (!r.ok) { setStatus(`保存失败: ${d.error}`); return false; }
      // POST 的响应已带回最新汇总，直接用，省一次往返
      if (d.reviewers) setReview({ reviewers: d.reviewers, consensus: d.consensus ?? EMPTY_REVIEW.consensus });
      await loadFields(year, study);
      return true;
    } catch (e) {
      setStatus(`保存失败: ${(e as Error).message}`);
      return false;
    } finally {
      setBusy(false);
    }
  }, [year, study, reviewer, loadFields]);

  /**
   * 人工改值。
   *
   * action 的判定以"最终值是否等于原值"为准，而不是以"用户是否点了编辑"为准：
   *   add / override / confirm —— 见 docs/07-web-frontend.md §6。
   */
  const onEdit = useCallback(async (fieldPath: string, raw: string, note?: string) => {
    const cur = findField(fieldPath);
    if (!cur) { setStatus(`字段未找到: ${fieldPath}`); return; }
    const evidence = currentEvidence(fieldPath);
    const noteChanged = (note ?? '') !== (cur.note ?? '');
    const originalRaw = cur.overridden ? (cur.llmRaw ?? cur.raw) : cur.raw;

    let action: 'confirm' | 'override' | 'add';
    if (!cur.inGold) action = 'add';
    else if (raw !== originalRaw) action = 'override';
    else action = 'confirm';

    if (raw === cur.raw && !noteChanged && cur.decidedBy === 'human') { setStatus('值未变化'); return; }

    const ok = await postAnnotation({
      fieldPath,
      action,
      value: { raw, evidence, provenance: 'human', confidence: 1 },
      ...(note ? { note } : {}),
    });
    if (ok) setStatus(`${action === 'add' ? '已补录' : action === 'override' ? '已修改' : '已确认'} ${fieldPath}`);
  }, [findField, currentEvidence, postAnnotation]);

  const onConfirm = useCallback(async (fieldPath: string) => {
    const cur = findField(fieldPath);
    if (!cur) return;
    const ok = await postAnnotation({
      fieldPath,
      action: 'confirm',
      value: { raw: cur.raw, evidence: currentEvidence(fieldPath), provenance: 'human', confidence: 1 },
    });
    if (ok) setStatus(`已确认 ${fieldPath}`);
  }, [findField, currentEvidence, postAnnotation]);

  const onAdd = useCallback(async (fieldPath: string, raw: string) => {
    const ok = await postAnnotation({
      fieldPath,
      action: 'add',
      value: { raw, evidence: [], provenance: 'human', confidence: 1 },
      note: '人工补录',
    });
    if (ok) setStatus(`已补录 ${fieldPath}`);
  }, [postAnnotation]);

  const onRevert = useCallback(async (fieldPath: string) => {
    if (!reviewer) { setStatus('请先填写「核对人」'); return; }
    if (findField(fieldPath)?.decidedBy !== 'human') { setStatus('该字段没有人工标注'); return; }
    setBusy(true);
    try {
      const r = await fetch(
        `/api/annotation?year=${year}&study=${encodeURIComponent(study)}`
          + `&reviewer=${encodeURIComponent(reviewer)}&fieldPath=${encodeURIComponent(fieldPath)}`,
        { method: 'DELETE' },
      );
      const d = await r.json();
      if (!r.ok) { setStatus(`回滚失败: ${d.error}`); return; }
      await loadFields(year, study);
      void loadReview(year, study, reviewer);
      setStatus(d.removed ? `已回滚 ${fieldPath}` : `${fieldPath} 无人工标注`);
    } catch (e) {
      setStatus(`回滚失败: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [year, study, reviewer, findField, loadFields, loadReview]);

  /**
   * 「纳入抽取」：把「待人工确认纳入」的候选结局提升为正式的 Sheet3 行。
   *
   * 落库方式就是普通的 `add` 标注，但写在下标 = 当前行数的新行上
   * （`outcomes.<N>.outcome.name` / `.instrument`）——因此无需新契约，
   * 服务端一看到覆盖层里出现更大的下标就会把该行渲染出来，随后可继续编辑/框选证据。
   */
  const onInclude = useCallback(async (f: FieldView) => {
    const meta = f.candidate;
    if (!meta) { setStatus('该候选缺少名称/工具，无法纳入'); return; }
    if (!reviewer) { setStatus('请先填写「核对人」再纳入——纳入也是一条人工记录'); return; }
    const idx = sheets.sheet3.nextOutcomeIndex;
    const ev = currentEvidence(f.fieldPath);
    const note = '从「待人工确认纳入」纳入抽取';
    setBusy(true);
    try {
      const r = await fetch(
        `/api/annotation?year=${year}&study=${encodeURIComponent(study)}&reviewer=${encodeURIComponent(reviewer)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            reviewer,
            entries: [
              { fieldPath: `outcomes.${idx}.outcome.name`, action: 'add', value: { raw: meta.name || '（未命名）', evidence: ev, provenance: 'human', confidence: 1 }, note },
              { fieldPath: `outcomes.${idx}.outcome.instrument`, action: 'add', value: { raw: meta.instrument || 'NR', evidence: ev, provenance: 'human', confidence: 1 }, note },
            ],
          }),
        },
      );
      const d = await r.json();
      if (!r.ok) { setStatus(`纳入失败：${d.error}`); return; }
      await loadFields(year, study);
      void loadReview(year, study, reviewer);
      setNotice(`已纳入为 Sheet3 结局 ${idx + 1}：${meta.name || meta.instrument}（可继续编辑/框选证据）`);
    } catch (e) {
      setStatus(`纳入失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [sheets.sheet3.nextOutcomeIndex, year, study, reviewer, currentEvidence, loadFields, loadReview]);

  /* ------------------------------ 框选 ------------------------------ */

  const attachEvidence = useCallback(async (fieldPath: string, sel: Selection) => {
    const cur = findField(fieldPath);
    if (!cur) { setStatus(`字段未找到: ${fieldPath}`); return; }
    const top = sel.hits[0];
    const ev: UiEvidence = {
      kind: evKindOf(top?.block.type),
      page: sel.page,
      bbox: sel.bbox,
      quote: sel.quote || '(人工框选，未命中解析文本)',
      ...(top ? { blockId: `b${top.block.index}` } : {}),
    };
    const action: 'confirm' | 'override' | 'add' = !cur.inGold ? 'add' : cur.overridden ? 'override' : 'confirm';
    const ok = await postAnnotation({
      fieldPath,
      action,
      value: { raw: cur.raw, evidence: [ev], provenance: 'human', confidence: 1 },
      note: '人工框选指定证据',
    });
    setMarkingField(null);
    setMode('browse');
    if (ok) {
      setHighlights([{ page: sel.page, bbox: sel.bbox, label: `${fieldPath} 的证据`, color: '#a855f7', human: true }]);
      setStatus(`已为 ${fieldPath} 写入证据（p${sel.page}，${sel.hits.length} 个命中块）`);
    }
  }, [findField, postAnnotation]);

  const onSelect = useCallback((sel: Selection | null) => {
    setSelection(sel);
    if (!sel) {
      if (markingField) { setMarkingField(null); setMode('browse'); }
      return;
    }
    if (sel.mode === 'mark' && markingField) { void attachEvidence(markingField, sel); return; }
    setHighlights([{ page: sel.page, bbox: sel.bbox, label: '框选', color: '#22d3ee' }]);
  }, [markingField, attachEvidence]);

  const onStartMark = useCallback((fieldPath: string) => {
    setMarkingField(fieldPath);
    setMode('mark');
    setStatus(`标注模式：在左侧 PDF 拖框，作为 ${fieldPath} 的证据`);
  }, []);

  const onAttachEvidence = useCallback((fieldPath: string) => {
    if (!selection) { setStatus('请先在 PDF 上框选'); return; }
    void attachEvidence(fieldPath, selection);
  }, [selection, attachEvidence]);

  /** 点字段 → 滚到证据所在页并高亮（右侧不再显示证据原文）。 */
  const onFocusEvidence = useCallback((pg: number, bbox: Bbox) => {
    setFocusPage(pg);
    setFocusToken((t) => t + 1);
    setHighlights([{ page: pg, bbox, label: '证据', color: '#ff9500' }]);
    setStatus(`已定位到 p${pg}`);
  }, []);

  const onLocate = useCallback(async (fieldPath: string, raw: string) => {
    const q = raw.trim();
    if (q.length < 2) { setStatus('值太短，无法定位'); return; }
    setBusy(true);
    try {
      const r = await fetch(`/api/locate?year=${year}&study=${encodeURIComponent(study)}&q=${encodeURIComponent(q)}`);
      const d = await r.json();
      if (!r.ok) { setStatus(`未定位到「${q.slice(0, 40)}」：${d.error ?? ''}`); return; }
      setFocusPage(d.page);
      setFocusToken((t) => t + 1);
      setHighlights([{ page: d.page, bbox: d.bbox, label: `${fieldPath} 自动定位`, color: d.exact ? '#ff9500' : '#eab308' }]);
      setStatus(`已定位 ${fieldPath} → p${d.page}（${d.exact ? '精确' : '近似'}匹配，${d.blockType}）；确认后用「框选证据」写盘`);
    } catch (e) {
      setStatus(`定位失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [year, study]);

  const totalPages = doc?.pages.length ?? 0;
  const currentStudy = studies.find((s) => s.studyId === study);

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden', background: T.canvas }}>
      {/* ============ 左：PDF ============ */}
      <div style={{ flex: '1 1 auto', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* 顶栏第 1 行：品牌 + 文章选择 + 导入/解析/抽取（左上角菜单） */}
        <header style={{
          display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
          padding: '9px 14px', background: T.bg, borderBottom: `1px solid ${T.border}`,
        }}>
          <span style={{
            width: 26, height: 26, borderRadius: 8, background: T.ink, color: T.amberBright,
            display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: 13,
          }}>A</span>
          <strong style={{ color: T.ink, fontSize: 14, letterSpacing: .2 }}>Article Agent</strong>
          <span style={{ width: 1, height: 18, background: T.border }} />
          <select value={year} onChange={(e) => setYear(e.target.value)} style={inputS({ width: 78 })}>
            {YEARS.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
          <select
            value={study} onChange={(e) => setStudy(e.target.value)}
            style={inputS({ maxWidth: 240 })} data-testid="study-select"
          >
            {studies.map((s) => (
              <option key={s.studyId} value={s.studyId}>
                {s.studyId}{s.imported ? '（导入）' : ''} · {s.file}
              </option>
            ))}
          </select>

          <input
            ref={fileRef} type="file" accept="application/pdf" style={{ display: 'none' }}
            data-testid="import-input"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onPickFile(f);
              e.target.value = '';
            }}
          />
          <button onClick={() => fileRef.current?.click()} style={primaryBtn()} disabled={busy} data-testid="import-btn">
            导入文章
          </button>
          <button
            onClick={() => void startJob('parse')} style={ghostBtn(T.blue)}
            disabled={busy || Boolean(runningJob)} data-testid="parse-btn"
            title="用 MinerU 解析该 PDF（写入 build/mineru）"
          >解析</button>
          <button
            onClick={() => void startJob('extract')} style={ghostBtn(T.indigo)}
            disabled={busy || Boolean(runningJob)} data-testid="extract-btn"
            title="对该文章跑 LLM 抽取（tools/llm_run.mjs --only）"
          >抽取</button>

          {/* 右上角：设置 */}
          <button
            onClick={() => setSettingsOpen(true)}
            style={{ ...ghostBtn(T.amber), marginLeft: 'auto', padding: '5px 11px', fontSize: 12 }}
            data-testid="settings-btn"
          >设置</button>
        </header>

        {/* 顶栏第 2 行：查看工具 */}
        <div style={{
          display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap',
          padding: '7px 14px', background: T.bg, borderBottom: `1px solid ${T.border}`,
        }}>
          <span style={{ color: T.text, fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
            第 {page} / {totalPages} 页
          </span>
          <span style={{ display: 'flex', gap: 6, alignItems: 'center', color: T.faint, fontSize: 11 }}>
            缩放
            <input
              type="range" min={0.6} max={2.4} step={0.1} value={scale}
              onChange={(e) => setScale(Number(e.target.value))} style={{ width: 90, accentColor: T.amber }}
              title={`缩放 ${scale.toFixed(1)}×`}
            />
            {Math.round(scale * 100)}%
          </span>
          <label style={{
            display: 'flex', gap: 5, alignItems: 'center', color: T.muted, fontSize: 11,
            padding: '3px 9px', borderRadius: R.pill,
            background: showBlocks ? T.amberTint : T.panel,
            border: `1px solid ${showBlocks ? tint(T.amber, '40') : T.border}`,
          }}>
            <input type="checkbox" checked={showBlocks} onChange={(e) => setShowBlocks(e.target.checked)} style={{ accentColor: T.amber }} />
            解析块
          </label>
          <button
            onClick={() => { setMode(mode === 'mark' ? 'browse' : 'mark'); setMarkingField(null); }}
            style={mode === 'mark' ? ghostBtn(T.amber) : ghostBtn(T.cyan)}
          >
            {mode === 'mark' ? '标注模式（框选=证据）' : '浏览模式'}
          </button>
          <span style={{ marginLeft: 'auto', color: T.faint, fontSize: 11 }}>
            {busy ? '处理中… ' : ''}{status}
          </span>
        </div>

        {/* 任务条（有任务时替换状态文字的位置，避免两行都显示状态） */}
        {(runningJob || jobs.length > 0) && (
          <div style={{
            padding: '5px 14px', background: T.panel, borderBottom: `1px solid ${T.border}`,
            fontSize: 11, color: T.muted, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
          }}>
            {runningJob
              ? <span style={{ color: T.blue }}>
                  {runningJob.kind === 'parse' ? 'MinerU 解析' : 'LLM 抽取'}进行中（{runningJob.id}）…
                  已 {Math.round((Date.now() - Date.parse(runningJob.startedAt)) / 1000)}s
                </span>
              : <span>最近任务：{jobs[0]?.id} {jobs[0]?.state}</span>}
            <button onClick={() => setShowJobLog((v) => !v)} style={ghostBtn()}>
              {showJobLog ? '收起日志' : '展开日志'}
            </button>
            <button onClick={() => void loadFields(year, study)} style={ghostBtn()}>刷新字段</button>
          </div>
        )}

        {notice && (
          <div
            data-testid="notice"
            style={{
              padding: '6px 14px', borderBottom: `1px solid ${tint(T.emerald, '40')}`, fontSize: 12,
              background: tint(T.emerald, '14'), color: '#05674a',
              display: 'flex', gap: 10, alignItems: 'center',
            }}
          >
            <span style={{ flex: 1 }}>{notice}</span>
            <button onClick={() => setNotice(null)} style={ghostBtn(T.emerald)}>知道了</button>
          </div>
        )}

        {showJobLog && jobs.length > 0 && (
          <pre style={{
            margin: 0, padding: '7px 14px', maxHeight: 140, overflow: 'auto',
            background: T.panel, color: T.muted, fontSize: 10.5,
            borderBottom: `1px solid ${T.border}`,
          }}>{jobs[0]!.logTail.join('\n')}</pre>
        )}

        <main style={{ flex: 1, overflow: 'hidden', background: T.canvas }}>
          {doc && pdf
            ? (
              <PdfViewer
                pdf={pdf}
                doc={doc}
                scale={scale}
                highlights={highlights}
                showBlocks={showBlocks}
                mode={mode}
                focusPage={focusPage}
                focusToken={focusToken}
                onSelect={onSelect}
                onPageChange={setPage}
              />
            )
            : <div style={{ color: T.muted, padding: 20 }}>{status}</div>}
        </main>

        {/* 框选信息条（左边底部：核对解析质量用） */}
        {selection && (
          <div style={{
            borderTop: `1px solid ${T.border}`, background: T.bg, padding: '7px 14px',
            fontSize: 11, maxHeight: 132, overflow: 'auto', flexShrink: 0,
          }}>
            <div style={{ color: T.muted, marginBottom: 4 }}>
              p{selection.page} · bbox [{selection.bbox.map((v) => Math.round(v)).join(', ')}] · 命中 {selection.hits.length} 块
              {selection.mode === 'mark'
                ? <span style={{ color: T.amber }}> · 标注框选（已/待写入字段证据）</span>
                : <span style={{ color: T.cyan }}> · 点右侧字段的「用当前框选作证据」即可写入</span>}
            </div>
            {selection.hits.length === 0
              ? <div style={{ color: T.faint }}>未命中解析块（该区域可能是图表或扫描层，quote 将标记为人工框选）</div>
              : selection.hits.map((h, i) => (
                <div key={h.block.index} style={{ color: T.faint, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {i + 1}. <span style={{ color: T.blue }}>#{h.block.index}</span> {h.block.type}
                  {' '}<span style={{ color: T.faint }}>{Math.round(h.ratio * 100)}%</span>{' '}
                  <span style={{ color: T.muted }}>{h.block.text.slice(0, 100) || '（无文本）'}</span>
                </div>
              ))}
          </div>
        )}
      </div>

      {/* ============ 右：字段详情（三张选项卡） ============ */}
      <aside style={{
        width: 520, flexShrink: 0, borderLeft: `1px solid ${T.border}`,
        background: T.panel, display: 'flex', flexDirection: 'column',
      }}>
        <div style={{
          padding: '9px 14px', background: T.bg, borderBottom: `1px solid ${T.border}`,
          display: 'flex', flexDirection: 'column', gap: 7,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
            <span style={{ color: T.ink, fontWeight: 700, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              抽取字段{currentStudy?.imported ? '（导入件）' : ''}
            </span>
            <span style={{ fontSize: 11, color: T.faint, whiteSpace: 'nowrap' }}>
              人工 {annStats.total}
              {annStats.overridden > 0 && <span style={{ color: T.amber }}> · 修改 {annStats.overridden}</span>}
              {annStats.confirmed > 0 && <span style={{ color: T.emerald }}> · 确认 {annStats.confirmed}</span>}
            </span>
          </div>

          {/* 多人机核对：核对人身份 + 汇总入口 + 导出（202609） */}
          <div style={{ display: 'flex', gap: 7, alignItems: 'center', fontSize: 11, flexWrap: 'wrap' }}>
            <span style={{ color: T.faint }}>核对人</span>
            <input
              value={reviewerDraft}
              onChange={(e) => setReviewerDraft(e.target.value)}
              onBlur={commitReviewer}
              onKeyDown={(e) => { if (e.key === 'Enter') commitReviewer(); }}
              placeholder="填姓名后才能提交"
              data-testid="reviewer-input"
              style={{ ...inputS(), width: 116, padding: '3px 8px', fontSize: 11 }}
            />
            {!reviewer && <span style={{ color: T.red }}>未设置，暂不能提交</span>}
            <button
              onClick={() => void onExport('xlsx')}
              style={{ ...ghostBtn(T.emerald), marginLeft: 'auto' }}
              disabled={busy || !study}
              data-testid="export-xlsx"
              title="导出人工核对结果（4 个工作表：核对汇总 + Sheet1/2/3）"
            >导出 XLSX</button>
            <button
              onClick={() => void onExport('csv')}
              style={ghostBtn(T.cyan)}
              disabled={busy || !study}
              data-testid="export-csv"
              title="导出人工核对结果（CSV，三表拼成一张，带 UTF-8 BOM）"
            >导出 CSV</button>

            {/* 批量导出：整年 / 全部年份 */}
            <span style={{ position: 'relative' }}>
              <button
                onClick={() => setBatchOpen((v) => !v)}
                style={ghostBtn(T.amberBright)}
                disabled={busy}
                data-testid="batch-menu"
                title="整年或全部年份一起导出（每行多带「年份/研究」两列）"
              >批量 ▾</button>
              {batchOpen && (
                <div
                  data-testid="batch-popup"
                  style={{
                    position: 'absolute', right: 0, top: '100%', marginTop: 4, zIndex: 40,
                    background: T.bg, border: `1px solid ${T.border}`, borderRadius: R.btn,
                    boxShadow: SH.pop, padding: 6, display: 'flex', flexDirection: 'column', gap: 4, minWidth: 156,
                  }}
                >
                  <button onClick={() => void onExport('xlsx', 'year')} style={ghostBtn(T.emerald)} data-testid="batch-year-xlsx">{year} 年 XLSX</button>
                  <button onClick={() => void onExport('csv', 'year')} style={ghostBtn(T.cyan)} data-testid="batch-year-csv">{year} 年 CSV</button>
                  <button onClick={() => void onExport('xlsx', 'all')} style={ghostBtn(T.emerald)} data-testid="batch-all-xlsx">全部年份 XLSX</button>
                  <button onClick={() => void onExport('csv', 'all')} style={ghostBtn(T.cyan)} data-testid="batch-all-csv">全部年份 CSV</button>
                </div>
              )}
            </span>

            <button
              onClick={() => setToolsTab('import')}
              style={ghostBtn(T.indigo)}
              disabled={!study}
              data-testid="open-import"
              title="把医生改过的表格导回成人工标注（先预览差异，再确认写入）"
            >导回…</button>
            <button
              onClick={() => setToolsTab('compare')}
              style={ghostBtn(T.blue)}
              disabled={!study}
              data-testid="open-compare"
              title="任选两组结果并排对比（机器 / 各位核对人 / 导入批次）"
            >对比…</button>
            <button
              onClick={() => setReviewOpen((v) => !v)}
              style={ghostBtn(review.consensus.stats.disputed > 0 ? T.red : T.indigo)}
              data-testid="review-toggle"
            >
              核对 {review.consensus.stats.reviewed}/{review.consensus.stats.total}
              {review.consensus.stats.disputed > 0 ? ` · 分歧 ${review.consensus.stats.disputed}` : ''}
            </button>
          </div>

          {reviewOpen && (
            <div
              data-testid="review-panel"
              style={{
                border: `1px solid ${T.border}`, borderRadius: R.btn, padding: '7px 9px',
                background: T.panel, fontSize: 11, color: T.muted, maxHeight: 200, overflow: 'auto',
              }}
            >
              <div style={{ marginBottom: 4 }}>
                {review.reviewers.length
                  ? review.reviewers.map((r) => `${r.reviewer}（${r.total} 条）`).join('、')
                  : '尚无人核对本篇'}
              </div>
              <div style={{ marginBottom: 4, color: T.faint }}>
                一致 {review.consensus.stats.agreed} · 仅一人 {review.consensus.stats.single}
                {' · '}分歧 {review.consensus.stats.disputed} · 未核对 {review.consensus.stats.machineOnly}
              </div>
              {review.consensus.pairwise.filter((p) => p.rate !== null).map((p) => (
                <div key={`${p.reviewerA}-${p.reviewerB}`} style={{ color: T.faint }}>
                  {p.reviewerA} ↔ {p.reviewerB}：一致 {p.same}/{p.common}（{Math.round((p.rate ?? 0) * 100)}%）
                </div>
              ))}
              {review.consensus.disputed.length > 0 && (
                <div style={{ marginTop: 6, color: T.amber }}>
                  <div style={{ fontWeight: 600, marginBottom: 3 }}>待第三方仲裁：</div>
                  {review.consensus.disputed.map((d) => (
                    <div key={d.fieldPath} style={{ marginBottom: 4 }}>
                      <code style={{ fontSize: 10.5 }}>{d.fieldPath}</code>
                      <div style={{ color: T.faint }}>
                        {/*
                          机器值优先用汇总里的；汇总里没有就退回字段视图的当前值。
                          汇总是在"没有机器值"的前提下算的（machineRaw 恒为 null），
                          而分歧字段的当前值恰好就是机器原值（分歧不生效），所以这样回退是准确的。
                        */}
                        机器「{d.machineRaw ?? findField(d.fieldPath)?.raw ?? '（无）'}」／
                        {d.opinions.map((o) => `${o.reviewer}「${o.raw}」`).join('，')}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <button
                onClick={() => void loadReview(year, study, reviewer)}
                style={{ ...ghostBtn(), marginTop: 6 }}
              >刷新汇总</button>
            </div>
          )}
        </div>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <ExtractionPanel
            sheets={sheets}
            markingFieldPath={markingField}
            hasSelection={Boolean(selection)}
            busy={busy}
            onFocusEvidence={onFocusEvidence}
            onEdit={onEdit}
            onConfirm={onConfirm}
            onRevert={onRevert}
            onStartMark={onStartMark}
            onAttachEvidence={onAttachEvidence}
            onAdd={onAdd}
            onLocate={onLocate}
            onInclude={onInclude}
          />
        </div>
      </aside>

      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}

      {toolsTab && (
        <ReviewToolsPanel
          year={year}
          study={study}
          reviewer={reviewer}
          tab={toolsTab}
          onTab={setToolsTab}
          onClose={() => setToolsTab(null)}
          onChanged={() => { void loadFields(year, study); void loadReview(year, study, reviewer); }}
          notify={setNotice}
        />
      )}
    </div>
  );
}


const tb = (color: string): React.CSSProperties => ({
  fontSize: 11, padding: '3px 8px', borderRadius: 3, cursor: 'pointer',
  background: `${color}1a`, color, border: `1px solid ${color}66`,
});
