/**
 * 前端**交互层**端到端测试（Playwright + 真实浏览器）
 *
 * 覆盖的是单测测不到、而人工每次都要手点的那条链路：
 *   连续滚动 → 点字段定位证据 → 框选（浏览/标注两种模式）→ 写入证据 → 回滚
 *   → 三张选项卡按「原始表格列序」渲染 → 「纳入抽取」→ 导入文章 → 设置对话框
 *
 * ⚠️ 测试会写入 `build/annotations/`，因此**先快照覆盖层、结束后原样还原**，
 * 不给使用者的真实标注留副作用；导入的 PDF 也会删掉。
 */
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const YEAR = '2015';
const STUDY = '2015-01';
const CORPUS_PDF = join(process.cwd(), 'Datas', 'articles', YEAR, '-2015-01.pdf');

/** 备份/还原某研究的覆盖层（测试不留副作用）。 */
async function snapshotOverlay(req: APIRequestContext): Promise<{ year: string; study: string; overlay: unknown }> {
  const r = await req.get(`/api/annotation?year=${YEAR}&study=${STUDY}`);
  const d = await r.json();
  return { year: YEAR, study: STUDY, overlay: d.overlay ?? null };
}

async function restoreOverlay(req: APIRequestContext, snap: { overlay: unknown }): Promise<void> {
  await req.delete(`/api/annotation?year=${YEAR}&study=${STUDY}`);
  const entries = (snap.overlay as { entries?: unknown[] } | null)?.entries ?? [];
  if (entries.length) {
    await req.post(`/api/annotation?year=${YEAR}&study=${STUDY}`, { data: { entries } });
  }
}

/** 等在 PDF 上画出可交互的页（惰性渲染完成）。 */
async function waitForPdf(page: Page): Promise<void> {
  await expect(page.locator('[data-page="1"]')).toBeVisible();
  // data-drawn 由组件在 pdf.js 真正画完后置 1；不能只看 canvas.width
  // —— 未渲染的 <canvas> 默认宽就是 300，用它判断会"假通过"
  await expect(page.locator('[data-page="1"][data-drawn="1"]')).toBeVisible({ timeout: 30_000 });
}

/** 在指定页上拖一个框（canonical 坐标由组件自行换算）。 */
async function dragOnPage(page: Page, pageNo: number, from = { x: 0.2, y: 0.2 }, to = { x: 0.7, y: 0.32 }): Promise<void> {
  const box = await page.locator(`[data-page="${pageNo}"]`).boundingBox();
  if (!box) throw new Error(`第 ${pageNo} 页不可见`);
  await page.mouse.move(box.x + box.width * from.x, box.y + box.height * from.y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * to.x, box.y + box.height * to.y, { steps: 8 });
  await page.mouse.up();
}

test.describe('前端交互（真实浏览器）', () => {
  let snap: { overlay: unknown };

  test.beforeEach(async ({ request }) => {
    snap = await snapshotOverlay(request);
  });

  test.afterEach(async ({ request }) => {
    await restoreOverlay(request, snap);
    // 清掉测试可能导入的 PDF
    await request.delete(`/api/import?year=${YEAR}&study=e2e-import`);
  });

  test('页面加载：三张选项卡与顶栏菜单齐备', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('[data-testid="study-select"]')).toBeVisible();
    await expect(page.locator('[data-testid="import-btn"]')).toBeVisible();
    await expect(page.locator('[data-testid="settings-btn"]')).toBeVisible();
    await expect(page.locator('[data-tab="sheet1"]')).toBeVisible();
    await expect(page.locator('[data-tab="sheet2"]')).toBeVisible();
    await expect(page.locator('[data-tab="sheet3"]')).toBeVisible();
    await expect(page.locator('[data-field="title"]')).toBeVisible();
  });

  test('PDF 连续滚动：所有页都在，滚动后当前页跟随', async ({ page, request }) => {
    const md = await (await request.get(`/api/minidoc?year=${YEAR}&study=${STUDY}`)).json();
    const total: number = md.pages.length;
    expect(total).toBeGreaterThan(1);

    await page.goto('/');
    await waitForPdf(page);
    // 所有页容器都在（不是一次只渲染一页）
    await expect(page.locator('[data-page]')).toHaveCount(total);
    await expect(page.getByText(`第 1 / ${total} 页`)).toBeVisible();

    // 惰性渲染：初始只渲染视口附近，远页仍是占位（未渲染的 canvas 默认宽 300，不能用它判断）
    const drawn = await page.locator('[data-page][data-drawn="1"]').count();
    expect(drawn).toBeLessThan(total);
    expect(drawn).toBeGreaterThan(0);

    // 滚到最后一页 → 页码跟随
    await page.locator('[data-testid="pdf-scroll"]').evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect(page.getByText(`第 ${total} / ${total} 页`)).toBeVisible();
  });

  test('点字段 → 在左侧 PDF 定位并高亮证据', async ({ page, request }) => {
    // 数据驱动：挑一个**确实带 bbox** 的字段（题目一类页眉字段常常只有 quote 没有坐标，
    // 那种字段本来就点不出定位——这是设计如此，不该拿来当断言对象）
    const fields = await (await request.get(`/api/fields?year=${YEAR}&study=${STUDY}`)).json();
    const target = [...fields.sheets.sheet1.article]
      .find((f: { evidence?: { bbox: unknown }[] }) => f.evidence?.[0]?.bbox);
    test.skip(!target, '该篇文章级字段都没有证据坐标');
    const page_ = target.evidence[0].page as number;

    await page.goto('/');
    await waitForPdf(page);
    await page.locator(`[data-field="${target.fieldPath}"] [data-value="1"]`).click();
    await expect(page.getByText(new RegExp(`已定位到 p${page_}\\b`))).toBeVisible();
    // 高亮框出现在该页上（橙色证据框）
    await expect(page.locator(`[data-page="${page_}"] div[title="证据"]`)).toHaveCount(1);
  });

  test('浏览模式框选：命中解析块并在信息条显示', async ({ page }) => {
    await page.goto('/');
    await waitForPdf(page);
    await dragOnPage(page, 1, { x: 0.1, y: 0.1 }, { x: 0.9, y: 0.55 });
    await expect(page.getByText(/命中 \d+ 块/)).toBeVisible();
  });

  test('标注模式：框选写入字段证据 → 落盘 → 回滚', async ({ page, request }) => {
    await page.goto('/');
    await waitForPdf(page);

    // 进入标注模式（点某个字段的「框选证据」）
    await page.locator('[data-field="title"] button:has-text("框选证据")').click();
    await expect(page.getByText(/标注模式：.*拖拽框选/)).toBeVisible();
    await dragOnPage(page, 1);
    await expect(page.getByText(/已为 title 写入证据/)).toBeVisible();

    // 落盘校验：覆盖层里出现 title，且带 bbox
    await expect.poll(async () => {
      const d = await (await request.get(`/api/annotation?year=${YEAR}&study=${STUDY}`)).json();
      const e = (d.overlay?.entries ?? []).find((x: { fieldPath: string }) => x.fieldPath === 'title');
      return e?.value?.evidence?.[0]?.bbox ? 'ok' : 'no';
    }).toBe('ok');

    // 回滚 → 覆盖层里的 title 消失，界面回到流水线值
    await page.locator('[data-field="title"] button:has-text("回滚")').click();
    await expect.poll(async () => {
      const d = await (await request.get(`/api/annotation?year=${YEAR}&study=${STUDY}`)).json();
      return (d.overlay?.entries ?? []).some((x: { fieldPath: string }) => x.fieldPath === 'title');
    }).toBe(false);
  });

  test('编辑字段 → 记为人工修改 → 回滚', async ({ page, request }) => {
    await page.goto('/');
    await waitForPdf(page);
    const row = page.locator('[data-field="condition"]');
    await row.locator('button:has-text("编辑")').click();
    const original = (await row.locator('div').first().innerText()).trim();
    await row.locator('textarea').fill('E2E 测试值');
    await row.locator('button:has-text("保存")').click();
    await expect(page.getByText(/已(修改|补录) condition/)).toBeVisible();

    await expect.poll(async () => {
      const d = await (await request.get(`/api/annotation?year=${YEAR}&study=${STUDY}`)).json();
      const e = (d.overlay?.entries ?? []).find((x: { fieldPath: string }) => x.fieldPath === 'condition');
      return e?.value?.raw ?? '';
    }).toBe('E2E 测试值');

    await page.locator('[data-field="condition"] button:has-text("回滚")').click();
    await expect.poll(async () => {
      const d = await (await request.get(`/api/annotation?year=${YEAR}&study=${STUDY}`)).json();
      return (d.overlay?.entries ?? []).some((x: { fieldPath: string }) => x.fieldPath === 'condition');
    }).toBe(false);
    expect(original.length).toBeGreaterThan(0);
  });

  test('Sheet3 选项卡：字段按原始表格列序渲染', async ({ page, request }) => {
    const fields = await (await request.get(`/api/fields?year=${YEAR}&study=${STUDY}`)).json();
    const order: string[] = fields.sheets.order.sheet3.top;
    const row = fields.sheets.sheet3.rows[0];
    test.skip(!row, '该篇没有结局行');

    await page.goto('/');
    await waitForPdf(page);
    await page.locator('[data-tab="sheet3"]').click();

    // 第一行展开后，逐个字段的 key 顺序应与布局里的列序一致
    const keysInDom: string[] = await page.locator(`[data-field^="outcomes.0."]`).evaluateAll((els) =>
      els.map((e) => (e as HTMLElement).dataset.field?.split('.').pop() ?? ''));
    const expected = row.fields
      .map((f: { fieldPath: string }) => f.fieldPath.split('.').pop())
      .filter((k: string) => keysInDom.includes(k));
    const posOf = (k: string) => order.indexOf(k);
    const ordered = [...keysInDom].sort((a, b) => {
      const pa = posOf(a); const pb = posOf(b);
      if (pa >= 0 && pb >= 0) return pa - pb;
      if (pa >= 0) return -1;
      if (pb >= 0) return 1;
      return 0;
    });
    expect(keysInDom).toEqual(ordered);
    expect(expected.length).toBeGreaterThan(0);
  });

  test('Sheet2 选项卡能切过去并显示结局分类', async ({ page }) => {
    await page.goto('/');
    await waitForPdf(page);
    await page.locator('[data-tab="sheet2"]').click();
    await expect(page.locator('[data-field="studyOutcomes.primaryOutcome"]')).toBeVisible();
  });

  test('「纳入抽取」把候选结局提升为正式 Sheet3 行', async ({ page, request }) => {
    const fields = await (await request.get(`/api/fields?year=${YEAR}&study=${STUDY}`)).json();
    const cands = fields.sheets.sheet3.candidates.length;
    test.skip(cands === 0, '该篇没有待纳入候选');

    await page.goto('/');
    await waitForPdf(page);
    await page.locator('[data-tab="sheet3"]').click();
    const before = fields.sheets.sheet3.rows.length;

    await page.locator('[data-action="include"]').first().click();
    await expect(page.locator('[data-testid="notice"]')).toContainText(/已纳入为 Sheet3 结局 \d+/);

    // 新行来自覆盖层：服务端把行数扩到 max(产物行数, 覆盖层最大下标+1)
    const after = await (await request.get(`/api/fields?year=${YEAR}&study=${STUDY}`)).json();
    expect(after.sheets.sheet3.rows.length).toBe(before + 1);
    expect(after.sheets.sheet3.rows.at(-1).fields.some((f: { fieldPath: string }) =>
      f.fieldPath === `outcomes.${before}.outcome.name`)).toBe(true);
  });

  test('设置对话框：显示掩码密钥并可测试连通性', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-testid="settings-btn"]').click();
    const dlg = page.locator('[data-testid="settings-dialog"]');
    await expect(dlg).toBeVisible();
    // 密钥只以掩码形式出现，绝无明文
    await expect(dlg.getByText(/sk-\*+/)).toBeVisible();
    await expect(dlg.locator('input[type="password"]')).toHaveValue('');
    await expect(dlg.getByText(/runtime[\\/]llm\.local\.json/)).toBeVisible();

    await dlg.locator('button:has-text("测试连接")').click();
    // 联网结果可能是成功也可能的失败（离线环境），但**必须有结果文本**
    await expect(page.locator('[data-testid="settings-test-result"]')).toBeVisible({ timeout: 20_000 });
  });

  test('导入文章：上传 PDF 后出现在研究列表并可打开', async ({ page, request }) => {
    test.skip(!existsSync(CORPUS_PDF), '缺少用于导入的样本 PDF');
    await page.goto('/');
    // 用 buffer + 指定文件名：避免复用带前导 `-` 的语料文件名（那会生成 `-2015-01` 这样的 id）
    const buf = readFileSync(CORPUS_PDF);
    await page.locator('[data-testid="import-input"]').setInputFiles({
      name: 'e2e-import.pdf', mimeType: 'application/pdf', buffer: buf,
    });
    await expect(page.locator('[data-testid="notice"]')).toContainText(/已导入 .*→ e2e-import/, { timeout: 60_000 });

    // 服务端已登记（source=import），且能打开它的 PDF
    const d = await (await request.get(`/api/studies?year=${YEAR}`)).json();
    const hit = (d.studies ?? []).find((s: { studyId: string }) => s.studyId === 'e2e-import');
    expect(hit?.source).toBe('import');
    const pdf = await request.get(`/api/pdf?year=${YEAR}&study=e2e-import`);
    expect(pdf.status()).toBe(200);
  });
});
