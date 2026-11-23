import fs from 'node:fs';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';
const root=resolve('.');
const output=join(root,'build/workflow-portable-check');
fs.mkdirSync(output,{recursive:true});
const version=JSON.parse(fs.readFileSync(join(root,'apps/desktop/package.json'),'utf8')).version;
const exe=join(root,'build/desktop-workflow/ArticleAgent-Workflow-'+version+'-portable.exe');
const parent=spawn(exe,['--remote-debugging-port=43251','--remote-debugging-address=127.0.0.1'],{
 cwd:root,windowsHide:true,env:{...process.env,AA_ROOT:root,AA_WORKFLOW_ROOT:join(root,'build/workflow-ui-check/state')},
 stdio:'ignore',
});
let browser;
try{
 let endpoint;
 for(let i=0;i<300;i++){
  try{const res=await fetch('http://127.0.0.1:43251/json/version');if(res.ok){endpoint=(await res.json()).webSocketDebuggerUrl;break;}}catch{}
  await new Promise(done=>setTimeout(done,200));
 }
 if(!endpoint)throw new Error('便携版解压启动失败');
 browser=await chromium.connectOverCDP(endpoint);
 let page;
 for(let i=0;i<50;i++){
  page=browser.contexts()[0]?.pages().find(p=>p.url().startsWith('http://127.0.0.1:431'));
  if(page)break;
  await new Promise(done=>setTimeout(done,200));
 }
 if(!page)throw new Error('没有本地服务窗口');
 await page.getByTestId('workflow-panel').waitFor({timeout:60000});
 await page.locator('header select').first().selectOption('2015');
 await page.getByTestId('study-select').selectOption('2015-06');
 await page.getByText('第 1 / 7 页',{exact:true}).waitFor({timeout:60000});
  await page.getByText(/第 1 页 渲染中/).waitFor({state:'hidden',timeout:60000});
  await page.locator('canvas[style*="opacity: 1"]').first().waitFor({timeout:60000});
 await page.screenshot({path:join(output,'便携版实际运行.png')});
 const session=await browser.newBrowserCDPSession();
 const info=await session.send('SystemInfo.getProcessInfo');
 const main=info.processInfo.find(item=>item.type==='browser');
 fs.writeFileSync(join(output,'checks.json'),JSON.stringify({ok:true,checks:['实际便携exe自解压启动','工作区自动读取','四步界面显示','正文PDF实际渲染'],pid:main?.id},null,2));
 console.log('便携版实际运行通过');
 // Close only the test application's own main window.
 await page.close();
 if(main?.id)try{process.kill(main.id);}catch{}
}finally{
 if(browser)await browser.close();
 parent.kill();
}
