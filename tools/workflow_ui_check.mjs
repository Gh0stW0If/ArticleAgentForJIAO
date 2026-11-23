import fs from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { atomicJson } from './lib/workflow-store.mjs';
import { findSources, readWorkflowMaterials, groundSource } from './lib/workflow-materials.mjs';
import { readWorkbook } from './lib/xlsx.mjs';

const root = process.cwd();
const output = join(root, 'build', 'workflow-ui-check');
const workflowRoot = join(output, 'state');
const llmConfig = join(output, 'reasoning-test-config.json');
fs.mkdirSync(output, { recursive: true });
const modelCalls = [];
let mockSource;
const modelServer = createServer(async (request, response) => {
  let input = '';
  for await (const chunk of request) input += chunk;
  const body = JSON.parse(input);
  modelCalls.push({ model:body.model, effort:body.reasoning?.effort });
  response.writeHead(200, { 'content-type':'application/json' });
  response.end(JSON.stringify({ status:'completed', model:body.model, output:[{ type:'message',
    content:[{ type:'output_text', text:JSON.stringify({ reviews:[{ recordId:'ui-record', findings:[
      { field:'time', reason:'测试复核：请核对时点', source:mockSource },
    ] }] }) }],
  }] }));
}).listen(0,'127.0.0.1');
await once(modelServer,'listening');
atomicJson(llmConfig, { wireApi:'responses', model:'gpt-6.2-sol', reviewModel:'test-review-model',
  apiKey:'fixture-key', reasoningEffort:'adaptive', baseUrl:'http://127.0.0.1:' + modelServer.address().port + '/v1' });
process.env.AA_WORKFLOW_ROOT = workflowRoot;
const year = '2015', study = '2015-06';
const sources = findSources(root, year, study);
const source = { documentId: sources[0].id, page: 4, bbox: [40, 150, 540, 300], quote: 'CIC frequency (times/day)' };
const candidate = { id: 'ui-cic', name: 'CIC frequency', instrument: '', domain: '', primary: false, evidence: [source], origin: 'model' };
atomicJson(join(workflowRoot, year, study, 'workflow.json'), {
  schemaVersion: 'AA_WORKFLOW/1.0', version: '0.2.0', year, study, revision: 1,
  stages: { basic: { status: 'done' }, candidates: { status: 'done' }, summary: { status: 'idle' } },
  basic: { comparisons: [{ missingData: { issues: [], frames: [{
      role:'overall',group:{raw:'UI test group'},outcome:{raw:'UI outcome'},time:{raw:'week 8'},population:{raw:'randomized cohort'},
      counts:{randomized:{raw:'100'},observed:{raw:'90'},analyzed:{raw:'100'},imputed:{raw:'10'}},
      derivedRatio:{raw:'0.1',legend:'(100-90)/100',evidence:[source]},status:'supported',issues:[],
    }] } }], fields: [{ path: 'article.title', label: '题目', raw: 'Acupuncture trial', evidence: [source] }], at: new Date().toISOString() },
  sources, candidates: [candidate], selection: { revision: 0, candidateIds: [], reviewer: '' }, edits: {}, runs: [], result: null,
});
const server = spawn(process.execPath, ['apps/web/server.mjs'], {
  cwd: root, env: { ...process.env, AA_ROOT: root, AA_PORT: '43141', AA_WORKFLOW_ROOT: workflowRoot, AA_LLM_CONFIG: llmConfig }, windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', chunk => { serverLog += chunk; });
server.stderr.on('data', chunk => { serverLog += chunk; });
let browser;
const checks = [];
try {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch('http://127.0.0.1:43141/api/health')).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1500, height: 980 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:43141', { waitUntil: 'networkidle' });
  const settingsButton = page.getByRole('button', { name: '设置', exact: true });
  const settingsDialog = page.getByTestId('settings-dialog');
  await settingsButton.click();
  const stageOptions = [
    ['基础信息','basic','medium','low'],['结局候选','candidates','high','xhigh'],
    ['常规结局汇总','summary','medium','medium'],['疑难字段复核','difficult','high',''],
    ['最终复核','review','high','high'],
  ];
  for (const [label,key,expected,value] of stageOptions) {
    await page.waitForFunction(({key,expected}) => document.getElementById('reasoning-' + key)?.value === expected,{key,expected});
    await settingsDialog.getByLabel(label,{exact:true}).selectOption(value);
  }
  await settingsDialog.getByRole('button', { name: '保存', exact: true }).click();
  await settingsDialog.getByText('已保存', { exact: true }).waitFor();
  const savedConfig = () => JSON.parse(fs.readFileSync(llmConfig, 'utf8'));
  const staged = savedConfig().reasoningStages;
  if (JSON.stringify(staged) !== JSON.stringify({ basic:'low', candidates:'xhigh', summary:'medium', difficult:null, review:'high' })
    || savedConfig().apiKey !== 'fixture-key') throw new Error('各阶段思考强度未独立保存');
  const invalidSetting = await page.request.put(new URL('/api/settings', page.url()).href, { data:{reasoningStages:{review:'invalid'}} });
  if (invalidSetting.status() !== 400 || savedConfig().reasoningStages.review !== 'high') {
    throw new Error('无效的思考强度应被拒绝');
  }
  await settingsDialog.getByRole('button', { name: '✕', exact: true }).click();
  await settingsButton.click();
  for (const [,key,,expected] of stageOptions) {
    await page.waitForFunction(({key,expected}) => document.getElementById('reasoning-' + key)?.value === expected,{key,expected});
  }
  await settingsDialog.getByRole('button', { name: '✕', exact: true }).click();
  checks.push('五个阶段分别保存并恢复各自的思考强度');
  await page.getByTestId('study-select').selectOption(study);
  await page.getByTestId('reviewer-input').fill('客户端测试医生');
  await page.getByTestId('reviewer-input').press('Enter');
  await page.locator('summary').filter({hasText:'比较 1 · 缺失数据口径（1）'}).click();
  await page.getByText(/程序计算比例：10.00%/).waitFor();
  checks.push('分别显示随机、观测、分析、插补人数及程序计算比例');
  await page.getByRole('button', { name: '人工选择', exact: true }).click();
  await page.getByRole('checkbox', { name: 'CIC frequency 原文未指定量表' }).check();
  await page.getByRole('button', { name: '保存选择（1）', exact: true }).click();
  await page.getByText('选择已保存，可以开始汇总').waitFor();
  checks.push('实际界面勾选及后端选择保存');
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '人工选择', exact: true }).click();
  if (!await page.getByRole('checkbox', { name: 'CIC frequency 原文未指定量表' }).isChecked()) throw new Error('重载后选择丢失');
  checks.push('重载后选择恢复');
  await page.getByLabel('补加结局名称').fill('voided volume');
  await page.getByLabel('补加量表').fill('mL');
  await page.getByRole('button', { name: '加入候选', exact: true }).click();
  await page.getByText('voided volume', { exact: true }).waitFor();
  checks.push('人工补加候选');
  const sourceResponse = page.waitForResponse(response => response.url().includes('/api/workflow/pdf') && response.ok());
  await page.getByRole('button', { name: '查看原文 · p4', exact: true }).first().click();
  await sourceResponse;
  checks.push('正文证据页面切换');
  await page.screenshot({ path: join(output, '候选结局选择.png'), fullPage: true });

  // Use a known persisted result to test reviewing/export without spending API calls in a UI regression.
  const file = join(workflowRoot, year, study, 'workflow.json');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  state.stages.summary = { status: 'partial' };
  const inputs = await readWorkflowMaterials(root,year,study);
  const reviewBlock = inputs.blocks.find(block => block.documentId === sources[0].id && block.page === 4
    && groundSource(inputs,{block:block.id,quote:source.quote}));
  if (!reviewBlock) throw Error('最终复核测试找不到原文来源');
  mockSource = {block:reviewBlock.id,quote:source.quote};
  Object.assign(source,groundSource(inputs,mockSource));
  state.candidateFingerprint = inputs.fingerprint;
  state.result = { runId: 'ui-result', at: new Date().toISOString(), selectionRevision: state.selection.revision,
    records: [{
      id: 'ui-record', candidateId: 'ui-cic', outcome: 'CIC frequency', group: 'Group 2',
      time: 'not_reported', estimand: 'absolute', statistic: 'mean', unit:{raw:'times/day',canonical:'event/day',status:'reported',source,origin:'model'}, values: { estimate: '0.35', sd: '0.07' },
      evidence: { estimate: source, sd: source }, scopeSource: source, issues: ['原文未明确时点，请核对'], status: 'needs_review',
    }], outcomes: [{ candidateId: 'ui-cic', status: 'needs_review', records: [], rejected: [], errors: [], unreported: ['原文未明确时点'] }],
  };
  atomicJson(file, state);
  await page.getByRole('button', { name: '选中结局汇总', exact: true }).click();
  await page.getByText('0.35', { exact: true }).waitFor();
  const modify = page.getByRole('button', { name: '修改', exact: true });
  await modify.first().click();
  await page.getByLabel('修改字段值').fill('0.36');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await page.getByText('0.36', { exact: true }).waitFor();
  checks.push('汇总数值修改并持久保存');
  await page.getByRole('button',{name:'修改单位',exact:true}).click();
  await page.getByLabel('修改字段值').fill('次/日');
  await page.getByRole('button',{name:'保存修改',exact:true}).click();
  await page.getByText('· 人工修改',{exact:true}).waitFor();
  if((await page.request.get('http://127.0.0.1:43141/api/workflow?year=2015&study=2015-06').then(r=>r.json())).effectiveRecords[0].values.estimate!=='0.36')throw new Error('修改单位意外换算数值');
  checks.push('单位规范值与人工单位修改保存，原数值保持不变');

  await page.getByRole('button', { name: '确认此条', exact: true }).click();
  await page.getByRole('button', { name: '已确认 · 客户端测试医生', exact: true }).waitFor();
  checks.push('人工确认');
  await page.getByRole('button',{name:'AI 最终复核',exact:true}).click();
  await page.getByTestId('final-review-result').waitFor({timeout:45000});
  await page.getByText(/测试复核：请核对时点/).waitFor();
  if (modelCalls.length !== 1 || modelCalls[0].effort !== 'high' || modelCalls[0].model !== 'test-review-model') {
    throw new Error('最终复核未使用独立配置的模型与档位');
  }
  await page.getByText('0.36', { exact:true }).waitFor();
  await page.getByRole('button', { name:'已确认 · 客户端测试医生',exact:true }).waitFor();
  await modify.first().click();
  await page.getByLabel('修改字段值').fill('0.37');
  await page.getByRole('button',{name:'保存修改',exact:true}).click();
  await page.getByText('汇总结果曾更新，请重新运行最终复核。').waitFor();
  checks.push('独立最终复核、原文疑点展示，以及人工修改后复核过期');
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: '导出 Excel', exact: true }).click();
  const saved = await download;
  const xlsx = join(output, saved.suggestedFilename());
  await saved.saveAs(xlsx);
  const workbook = readWorkbook(fs.readFileSync(xlsx));
  if (workbook.sheets.length !== 4 || !workbook.sheets.some(s => s.name === '结局全部时点')) throw new Error('导出工作表不完整');
  if(!workbook.sheets.find(s=>s.name==='结局全部时点').rows[0].cells.includes('测量单位(规范)'))throw new Error('Excel未导出单位列');
  checks.push('Excel 四张工作表导出');
  await page.screenshot({ path: join(output, '所选结局汇总.png'), fullPage: true });
  const attachmentSources = findSources(root, '2024', '2024-12');
  const attachment = attachmentSources.find(source => source.attachment);
  atomicJson(join(workflowRoot, '2024', '2024-12', 'workflow.json'), {
    schemaVersion:'AA_WORKFLOW/1.0',version:'0.2.0',year:'2024',study:'2024-12',revision:1,
    stages:{basic:{status:'done'},candidates:{status:'done'},summary:{status:'idle'}},
    basic:{fields:[],at:new Date().toISOString()}, sources:attachmentSources,
    candidates:[{...candidate,id:'ui-attachment',name:'Attachment outcome',
      evidence:[{documentId:attachment.id,page:1,bbox:null,quote:'UI attachment navigation test'}]}],
    selection:{revision:0,candidateIds:[],reviewer:''},edits:{},runs:[],result:null,
  });
  await page.locator('header select').first().selectOption('2024');
  await page.getByTestId('study-select').selectOption('2024-12');
  await page.getByRole('button',{name:'人工选择',exact:true}).click();
  const attachmentResponse=page.waitForResponse(response=>response.url().includes('/api/workflow/pdf')&&response.url().includes(attachment.id)&&response.ok());
  await page.getByRole('button',{name:'查看原文 · 附件 · p1',exact:true}).click();
  await attachmentResponse;
  await page.getByText('第 1 / 1 页',{exact:true}).waitFor({timeout:60000});
  await page.getByText(/第 1 页 渲染中/).waitFor({state:'hidden',timeout:60000});
  await page.locator('canvas[style*="opacity: 1"]').first().waitFor({timeout:60000});
  checks.push('真实附件 PDF 按文档身份切换并渲染');
  await page.screenshot({path:join(output,'附件来源.png'),fullPage:true});
  if (errors.length) throw new Error(errors.join('\n'));
  atomicJson(join(output, 'checks.json'), { ok: true, checks, pageErrors: errors });
  console.log('界面验收通过', checks);
} catch (error) {
  atomicJson(join(output, 'checks.json'), { ok: false, checks, error: error.message });
  console.error(error.stack); process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.kill();
  modelServer.close();
  fs.writeFileSync(join(output, 'server.log'), serverLog, 'utf8');
}
