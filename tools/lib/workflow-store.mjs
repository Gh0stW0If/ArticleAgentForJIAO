import { normalizeOutcomeUnit } from '../../packages/core/dist/index.js';
import fs from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const WORKFLOW_VERSION = '0.2.2';
export function workflowBase(root) {
  return resolve(process.env.AA_WORKFLOW_ROOT || join(root, 'build', 'workflows'));
}
export function studyDirectory(root, year, study) {
  if (!/^\d{4}$/.test(String(year)) || !/^[A-Za-z0-9._\u4e00-\u9fa5-]{1,80}$/.test(study) || study.includes('..')) {
    throw new Error('论文编号或年份非法');
  }
  return join(workflowBase(root), year, study);
}
export const fingerprint = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export function atomicJson(file, value) {
  fs.mkdirSync(resolve(file, '..'), { recursive: true });
  const tmp = file + '.' + randomUUID() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
export function readWorkflow(root, year, study) {
  const file = join(studyDirectory(root, year, study), 'workflow.json');
  const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {
    schemaVersion: 'AA_WORKFLOW/1.0', version: WORKFLOW_VERSION, year, study,
    revision: 0, candidates: [], selection: { revision: 0, candidateIds: [], reviewer: '' },
    stages: Object.fromEntries(['basic', 'candidates', 'summary'].map(stage => [stage, { status: 'idle' }])),
    runs: [], result: null, edits: {},
  };
  state.stages.review ??= { status: 'idle' };
  for (const stage of Object.values(state.stages)) {
    if (stage.status === 'running' && !alive(stage.pid)) {
      stage.status = 'interrupted';
      stage.message = '上次任务已中断，可重试已完成检查点之后的任务';
    }
  }
  return state;
}
export function saveWorkflow(root, state) {
  state.version = WORKFLOW_VERSION;
  state.updatedAt = new Date().toISOString();
  state.revision++;
  atomicJson(join(studyDirectory(root, state.year, state.study), 'workflow.json'), state);
  return state;
}
export function withStudyLock(root, year, study, action) {
  const dir = studyDirectory(root, year, study);
  fs.mkdirSync(dir, { recursive: true });
  const file = join(dir, '.lock');
  if (fs.existsSync(file)) {
    let lock;
    try { lock = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('任务锁文件无法读取'); }
    if (alive(lock.pid)) throw new Error('该论文已有任务运行，请等待完成');
    fs.unlinkSync(file);
  }
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' });
  return Promise.resolve().then(action).finally(() => {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  });
}
export async function selectOutcomes(root, year, study, input) {
  return withStudyLock(root, year, study, () => {
    const state = readWorkflow(root, year, study);
    if (input.revision !== state.selection.revision) throw new Error('选择已发生变化，请刷新后重试');
    const reviewer = String(input.reviewer ?? '').trim();
    if (!reviewer || reviewer.length > 80) throw new Error('请填写核对人');
    const ids = [...new Set(input.candidateIds ?? [])];
    if (!ids.every(id => state.candidates.some(c => c.id === id))) throw new Error('存在已失效的候选结局');
    state.selectionHistory ??= [];
    state.selectionHistory.push(structuredClone(state.selection));
    state.selection = { revision: state.selection.revision + 1, candidateIds: ids, reviewer, at: new Date().toISOString() };
    state.stages.summary = { status: state.result ? 'stale' : 'idle', message: state.result ? '选择已更新，请重新汇总' : '' };
    return saveWorkflow(root, state);
  });
}
export async function addCandidate(root, year, study, input) {
  return withStudyLock(root, year, study, () => {
    const state = readWorkflow(root, year, study);
    const name = String(input.name ?? '').trim();
    if (!name || name.length > 300 || !String(input.reviewer ?? '').trim()) throw new Error('请填写候选名称和核对人');
    const source = input.source;
    if (source && (!state.sources?.some(s => s.id === source.documentId)
      || !Number.isSafeInteger(source.page) || source.page < 1 || typeof source.quote !== 'string')) {
      throw new Error('来源参数非法');
    }
    const id = 'manual-' + randomUUID();
    state.candidates.push({
      id, name, instrument: String(input.instrument ?? '').trim(), domain: '', primary: false,
      evidence: source ? [source] : [], origin: 'human', reviewer: input.reviewer,
      sourceStatus: source ? 'reported' : 'needs_source', createdAt: new Date().toISOString(),
    });
    return saveWorkflow(root, state);
  });
}
export async function updateCandidate(root, year, study, input) {
  return withStudyLock(root, year, study, () => {
    const state = readWorkflow(root, year, study);
    const target = state.candidates.find(c => c.id === input.id);
    const name = String(input.name ?? '').trim();
    if (!target || !name || name.length > 300 || !String(input.reviewer ?? '').trim()) throw new Error('请填写候选名称和核对人');
    target.originalName ??= target.name;
    target.name = name;
    target.instrument = String(input.instrument ?? target.instrument).trim();
    target.updatedBy = input.reviewer;
    target.updatedAt = new Date().toISOString();
    state.selection.revision++;
    state.stages.summary = { status: state.result ? 'stale' : 'idle' };
    return saveWorkflow(root, state);
  });
}
export async function editResult(root, year, study, input) {
  return withStudyLock(root, year, study, () => {
    const state = readWorkflow(root, year, study);
    if (!String(input.reviewer ?? '').trim()) throw new Error('请填写核对人');
    if (input.revision !== state.selection.revision) throw new Error('结果版本已变化，请刷新');
    const record = state.result?.records?.find(r => r.id === input.recordId);
    const basic = state.basic?.fields?.find(f => f.path === input.path);
    if (!record && !basic) throw new Error('找不到要核对的字段');
    const target = basic ? 'basic:' + input.path : input.recordId;
    if (input.action === 'confirm') {
      state.confirmations ??= {};
      state.confirmations[target] = { reviewer: input.reviewer, at: new Date().toISOString() };
    } else {
      const allowed = ['estimate', 'sd', 'se', 'ciLower', 'ciUpper', 'iqrLower', 'iqrUpper', 'events', 'n'];
      if (record && input.field !== 'unit' && !allowed.includes(input.field)) throw new Error('不支持修改该数值字段');
      const key = basic ? target : target + ':' + input.field;
      state.edits[key] = { raw: String(input.raw ?? '').trim(), reviewer: input.reviewer, at: new Date().toISOString(), note: String(input.note ?? '') };
      if (state.confirmations) delete state.confirmations[target];
    }
    return saveWorkflow(root, state);
  });
}
export function effectiveRecords(state) {
  return (state.result?.records ?? []).map(record => {
    const result = structuredClone(record);
    result.humanEdits = [];
    for (const field of ['estimate', 'sd', 'se', 'ciLower', 'ciUpper', 'iqrLower', 'iqrUpper', 'events', 'n']) {
      const edit = state.edits[record.id + ':' + field];
      if (!edit) continue;
      result.values[field] = edit.raw;
      result.humanEdits.push({ field, ...edit });
    }
    const unitEdit = state.edits[record.id + ':unit'];
    if (unitEdit) {
      result.unit = { ...normalizeOutcomeUnit(unitEdit.raw), ...(result.unit?.source ? { source: result.unit.source } : {}), origin: 'human' };
      result.humanEdits.push({ field: 'unit', ...unitEdit });
    } else if (result.unit) {
      const normalized = normalizeOutcomeUnit(result.unit.raw);
      if (normalized.canonical === 'NA') {
        result.unit = { ...result.unit, ...normalized };
      }
    }
    result.confirmed = state.confirmations?.[record.id] ?? null;
    return result;
  });
}
export function safeSourcePath(root, source) {
  const file = resolve(root, source.path);
  const rel = relative(resolve(root), file);
  if (rel.startsWith('..') || isAbsolute(rel) || !/\.pdf$/i.test(file)) throw new Error('PDF 路径非法');
  if (!rel.startsWith('Datas' + (process.platform === 'win32' ? '\\' : '/')) && !rel.startsWith('build' + (process.platform === 'win32' ? '\\' : '/'))) throw new Error('PDF 路径超出工作区');
  return file;
}
