/**
 * 截取界面截图（诊断用）：用于人工/模型审阅视觉稿。
 * 用法：node tools/_shot.mjs [输出路径] [年] [研究ID]
 */
import { chromium } from 'playwright';

const out = process.argv[2] ?? 'build/shot.png';
const year = process.argv[3] ?? '2015';
const study = process.argv[4] ?? '2015-01';
const base = process.env.AA_WEB_URL ?? 'http://127.0.0.1:43130';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await page.goto(`${base}/`);
await page.waitForSelector('[data-page="1"][data-drawn="1"]', { timeout: 30_000 });

// 固定到目标研究（下拉变化会重新加载）
await page.selectOption('[data-testid="study-select"]', study);
await page.waitForTimeout(1200);
await page.waitForSelector('[data-page="1"][data-drawn="1"]', { timeout: 30_000 });

// 打开一个带证据的字段所在页，并展开一个结局行，让右栏内容更接近真实使用
await page.locator('[data-tab="sheet3"]').click();
await page.waitForTimeout(400);
const rows = page.locator('section');
if (await rows.count()) await rows.first().click({ trial: true }).catch(() => {});

await page.screenshot({ path: out, fullPage: false });
console.log(`已保存 ${out}（${year}/${study}）`);
await browser.close();
