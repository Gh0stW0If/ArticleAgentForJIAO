import fs from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { _electron as electron } from 'playwright';
const root = resolve('.');
const folder = join(root, 'build/desktop-workflow/win-unpacked');
const output = join(root, 'build/workflow-desktop-check');
fs.mkdirSync(output, { recursive: true });
const executablePath = join(folder, 'Article Agent Workflow.exe');
const app = await electron.launch({
  executablePath, args: ['--no-sandbox'],
  env: { ...process.env, AA_ROOT: root, AA_WORKFLOW_ROOT: join(root, 'build/workflow-ui-check/state') },
  timeout: 60000,
});
const checks = [];
try {
  const window = await app.firstWindow({timeout:60000});
  await window.waitForSelector('[data-testid="workflow-panel"]', {timeout:60000});
  checks.push('打包版 Electron 启动并显示四步界面');
  await window.getByTestId('study-select').selectOption('2015-06');
  await window.getByText('第 1 / 7 页',{exact:true}).waitFor({timeout:60000});
  await window.getByText(/第 1 页 渲染中/).waitFor({state:'hidden',timeout:60000});
  await window.locator('canvas[style*="opacity: 1"]').first().waitFor({timeout:60000});
  checks.push('打包版 PDF 页面实际渲染');
  await window.screenshot({ path: join(output, '桌面版.png') });
  const base = await window.url();
  const api = new URL('/api/workflow?year=2015&study=2015-06', base);
  const state = await fetch(api).then(r=>r.json());
  if (!state.basic || !state.selection.candidateIds.length) throw new Error('工作区状态读取失败');
  checks.push('打包版本地服务读取持久状态');
  const pdfUrl = new URL('/api/workflow/pdf?year=2015&study=2015-06&document='+state.sources[0].id,base);
  const pdf = await fetch(pdfUrl);
  if (!pdf.ok || (await pdf.arrayBuffer()).byteLength <1000) throw new Error('打包版本地 PDF 读取失败');
  checks.push('打包版本文 PDF 来源接口');
  const script = join(output,'runtime-check.mjs');
  const modulePath = new URL('file:///'+join(folder,'resources/app/tools/lib/workflow-materials.mjs').replaceAll('\\','/')).href;
  fs.writeFileSync(script,'import {readWorkflowMaterials} from '+JSON.stringify(modulePath)+';\nconst m=await readWorkflowMaterials(process.env.AA_ROOT,"2015","2015-06");\nif(!m.blocks.some(b=>b.type==="native"))throw new Error("PDF.js 原生读取失败");\nconsole.log(JSON.stringify({sources:m.sources.length,blocks:m.blocks.length}));');
  const result = await new Promise((done,fail)=>{
    const child=spawn(executablePath,[script],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1',AA_ROOT:root,AA_WORKFLOW_ROOT:join(output,'runtime-state')},windowsHide:true});
    let text='';
    child.stdout.on('data',b=>text+=b);
    child.stderr.on('data',b=>text+=b);
    child.on('error',fail);
    child.on('exit',code=>code===0?done(text):fail(new Error(text)));
  });
  checks.push('随包 Electron Node 运行时及 PDF.js 重新解析原文');
  fs.writeFileSync(join(output,'checks.json'),JSON.stringify({ok:true,checks,runtime:result},null,2));
  console.log(checks);
} finally { await app.close(); }
