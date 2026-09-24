/**
 * 前端「人工回环」冒烟测试（需要 API 服务已在运行）
 *
 * 目的：把前端会发出的请求序列固化下来，验证「框选证据 + 人工修改」这套通路
 * 在真实服务上始终成立——这是需求 1 的核心承诺，不能只靠界面点一遍。
 *
 * 用法：
 *   终端 A：pnpm web:api
 *   终端 B：pnpm web:smoke            # 默认校验 build/gold 里的第一篇文章
 *           pnpm web:smoke 2015 2015-02
 *
 * 它只写 `build/annotations/**`（人工覆盖层），结束时清理，不触碰 Datas/ 与流水线产物。
 */

const BASE = process.env.AA_API ?? 'http://127.0.0.1:43130';
const YEAR = process.argv[2] ?? '2015';
const STUDY = process.argv[3] ?? `${YEAR}-01`;
const Q = `year=${YEAR}&study=${encodeURIComponent(STUDY)}`;

let fails = 0;

const req = async (url, init) => {
  const r = await fetch(BASE + url, init);
  return { status: r.status, body: await r.json().catch(() => null) };
};
const post = (entry) => req(`/api/annotation?${Q}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ entry }),
});
const del = (fieldPath) => req(
  `/api/annotation?${Q}${fieldPath ? `&fieldPath=${encodeURIComponent(fieldPath)}` : ''}`,
  { method: 'DELETE' },
);
const fieldView = async () => (await req(`/api/fields?${Q}`)).body;
const fieldOf = async (fp) => {
  const d = await fieldView();
  for (const g of d?.groups ?? []) {
    const hit = g.fields.find((f) => f.fieldPath === fp);
    if (hit) return hit;
  }
  return null;
};

const expect = (name, cond, extra = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) fails++;
};
const show = (tag, f) => console.log(
  `    ${tag}: raw=${JSON.stringify(f?.raw)} decidedBy=${f?.decidedBy} overridden=${f?.overridden}` +
  ` inGold=${f?.inGold} llmRaw=${JSON.stringify(f?.llmRaw)}` +
  ` ev=${f?.evidence?.[0] ? `p${f.evidence[0].page}/[${f.evidence[0].bbox}]` : '无'}` +
  ` note=${JSON.stringify(f?.note)}`,
);

/** 与 App.tsx 一致的 action 判定（按"值是否变化"，不按"是否点了编辑"）。 */
const decideEdit = (cur, raw) => {
  if (!cur.inGold) return 'add';
  const originalRaw = cur.overridden ? (cur.llmRaw ?? cur.raw) : cur.raw;
  return raw !== originalRaw ? 'override' : 'confirm';
};
const decideAttach = (cur) => (!cur.inGold ? 'add' : cur.overridden ? 'override' : 'confirm');

/* ---------------------------------- 主流程 ---------------------------------- */

const health = await req('/api/health');
if (!health.body?.ok) {
  console.error(`无法连接 ${BASE}，请先运行 pnpm web:api`);
  process.exit(2);
}

const views = await fieldView();
if (!views?.groups?.length) {
  console.error(`${STUDY}: 没有字段视图（${views?.warning ?? '未知原因'}）`);
  process.exit(2);
}

console.log(`目标: ${YEAR}/${STUDY}`);
console.log('字段分组: ' + views.groups.map((g) => `${g.title}(${g.fields.length})`).join(' | '));

/**
 * 挑一个「值确实出现在 PDF 文本里」的文章级字段做改造对象。
 *
 * 不能随便拿第一个字段：像 `extractor`（提取人姓名，值是 "EN009"）这类值
 * 本来就不在正文里，拿它测「定位证据」必然 404——那是数据的性质，不是缺陷。
 */
const candidates = views.groups[0].fields.filter((f) => f.inGold && f.raw.trim().length >= 4);
let target = null;
let located = null;
for (const f of candidates.slice(0, 25)) {
  const r = await req(`/api/locate?${Q}&q=${encodeURIComponent(f.raw.trim())}`);
  if (r.status === 200) { target = f; located = r.body; break; }
}
if (!target) {
  target = candidates[0];
  console.log('（未找到可定位的字段值，[5] 定位命中将跳过）');
}
if (!target) {
  console.error('没有可用于测试的文章级字段');
  process.exit(2);
}
const FP = target.fieldPath;
const ORIGINAL = target.raw;
const EDITED = `${ORIGINAL} (人工校对)`;

console.log(`\n[0] 清空既有覆盖层`);
await del();

console.log(`\n[1] 初始状态（字段 ${FP}）`);
show('before', await fieldOf(FP));
// 流水线值可能来自模型、确定性推导或 Crossref（外部权威来源），三者都属"非人工"
expect('初始未被人工修改', ['model', 'external', 'deterministic'].includes((await fieldOf(FP)).decidedBy));
expect('inGold=true', (await fieldOf(FP)).inGold === true);

console.log('\n[2] 人工改值 → override');
{
  const cur = await fieldOf(FP);
  const action = decideEdit(cur, EDITED);
  const r = await post({
    fieldPath: FP, action,
    value: { raw: EDITED, evidence: cur.evidence ?? [], provenance: 'human', confidence: 1 },
    note: '冒烟测试',
  });
  expect('写入成功', r.status === 200, `status=${r.status} action=${action}`);
  const f = await fieldOf(FP);
  show('after', f);
  expect('decidedBy=human', f.decidedBy === 'human');
  expect('overridden=true', f.overridden === true);
  expect('保留原值 llmRaw', f.llmRaw === ORIGINAL, `llmRaw=${JSON.stringify(f.llmRaw)}`);
}

console.log('\n[3] 框选写入证据（值不变）');
{
  const cur = await fieldOf(FP);
  const action = decideAttach(cur);
  await post({
    fieldPath: FP, action,
    value: {
      raw: cur.raw,
      evidence: [{ kind: 'text', page: 1, bbox: [100, 200, 300, 220], quote: ORIGINAL, blockId: 'b1' }],
      provenance: 'human', confidence: 1,
    },
    note: '人工框选指定证据',
  });
  const f = await fieldOf(FP);
  show('after', f);
  expect('值未被证据操作改动', f.raw === EDITED);
  expect('证据已写入 canonical bbox', JSON.stringify(f.evidence?.[0]?.bbox) === '[100,200,300,220]');
  expect('仍标记为人工修改（未被降级）', f.overridden === true);
}

console.log('\n[4] 把值改回原值 → 应记 confirm');
{
  const cur = await fieldOf(FP);
  const action = decideEdit(cur, ORIGINAL);
  await post({
    fieldPath: FP, action,
    value: { raw: ORIGINAL, evidence: cur.evidence ?? [], provenance: 'human', confidence: 1 },
  });
  const f = await fieldOf(FP);
  show('after', f);
  expect('值回到原值', f.raw === ORIGINAL);
  expect('不再标记为人工修改', f.overridden === false);
}

console.log('\n[5] 定位证据（只读，不写盘）');
{
  if (located) {
    console.log(`    ${FP}: p${located.page} bbox=[${located.bbox}] type=${located.blockType} exact=${located.exact}`);
    expect('返回页码与坐标', located.page >= 1 && located.bbox.length === 4);
    const again = await req(`/api/locate?${Q}&q=${encodeURIComponent(ORIGINAL)}`);
    expect('接口可重复调用（无副作用）', again.status === 200);
  } else {
    console.log('    跳过（该字段值不在正文中）');
  }
  const miss = await req(`/api/locate?${Q}&q=zzz-not-in-this-paper-zzz`);
  expect('不存在的串返回 404', miss.status === 404, `status=${miss.status}`);
}

console.log('\n[6] 人工补录字段 → add');
{
  const NEW = 'smokeTestField';
  const r = await post({
    fieldPath: NEW, action: 'add',
    value: { raw: 'NCT00000000', evidence: [], provenance: 'human', confidence: 1 },
  });
  expect('写入成功', r.status === 200, `status=${r.status}`);
  const f = await fieldOf(NEW);
  show('added', f);
  expect('inGold=false', f?.inGold === false);
  expect('decidedBy=human', f?.decidedBy === 'human');
}

console.log('\n[7] 单字段回滚（只删该字段的人工标注）');
{
  const r = await del(FP);
  expect('删除 1 条', r.body?.removed === 1, JSON.stringify(r.body));
  const f = await fieldOf(FP);
  show('rollback', f);
  expect('恢复流水线原值', f.raw === ORIGINAL && ['model', 'external', 'deterministic'].includes(f.decidedBy));
  expect('其他字段的人工标注不受影响', (await fieldOf('smokeTestField'))?.decidedBy === 'human');
}

console.log('\n[8] 非法输入');
{
  const bad = await post({ fieldPath: FP, action: 'bogus', value: { raw: 'x' } });
  expect('非法 action → 400', bad.status === 400, JSON.stringify(bad.body));
  const short = await req(`/api/locate?${Q}&q=a`);
  expect('q 过短 → 400', short.status === 400);
  const badStudy = await req('/api/fields?year=2015&study=..%2f..%2fetc');
  expect('非法 study → 400', badStudy.status === 400);
}

console.log('\n[9] 清理覆盖层');
await del();

console.log(fails === 0 ? '\n全部通过 ✅' : `\n失败 ${fails} 项 ❌`);
process.exit(fails === 0 ? 0 : 1);
