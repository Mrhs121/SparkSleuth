// Connect to a managed headless Chrome started with --remote-debugging-port=9223.
// Run from the repository root: node scripts/capture-screenshots.js
import { mkdir, writeFile } from 'node:fs/promises';

const baseUrl = process.env.SPARKSLEUTH_SCREENSHOT_URL || 'http://127.0.0.1:8787';
const debugUrl = process.env.SPARKSLEUTH_CHROME_DEBUG_URL || 'http://127.0.0.1:9223';
const pages = await (await fetch(`${debugUrl}/json/list`)).json();
const page = pages.find((p) => p.type === 'page');
if (!page) throw new Error('Start managed Chrome with a page and remote debugging first.');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let id = 0;
const pending = new Map();
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (!data.id) return;
  const request = pending.get(data.id);
  if (!request) return;
  pending.delete(data.id);
  if (data.error) request.reject(new Error(JSON.stringify(data.error)));
  else request.resolve(data.result);
};
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const n = ++id; pending.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
}
async function evaluate(expression) {
  const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
  return response.result?.value;
}
async function ui(body) {
  return evaluate(`(async()=>{const buttons=()=>[...document.querySelectorAll('button')]; const until=async(fn)=>{for(let i=0;i<1500;i++){const result=fn();if(result)return result;await new Promise(r=>setTimeout(r,100));}throw new Error('UI condition timed out');}; ${body} })()`);
}
async function screenshot(name) {
  await evaluate('document.fonts.ready');
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const buffer = Buffer.from(shot.data, 'base64');
  await writeFile(`docs/screenshots/${name}.png`, buffer);
  console.log(`${name}: ${buffer.length} bytes`);
}
async function home() {
  await send('Page.navigate', { url: baseUrl });
  await ui(`await until(()=>document.querySelector('.app-select-trigger'));`);
}
try {
  await mkdir('docs/screenshots', { recursive: true });
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1760, height: 1100, deviceScaleFactor: 1.5, mobile: false });
  await home();
  await evaluate(`localStorage.setItem('sparksleuth_lang','zh');localStorage.setItem('sparksleuth_inspector_width','1020');`);
  // Set the actual language via visible control; do not fake any diagnostic content.
  await ui(`const zh=buttons().find(b=>b.textContent.trim()==='中文');if(zh)zh.click();`);
  await home();
  await screenshot('01_hero_launcher');
  await ui(`document.querySelector('.app-select-trigger').click();await until(()=>document.querySelector('.app-select-popover'));`);
  await screenshot('02_app_select_dropdown');
  await home();
  await ui(`(await until(()=>buttons().find(b=>b.textContent.includes('系统设置')||b.title.includes('系统配置')))).click();await until(()=>document.querySelector('.modal-backdrop'));`);
  await screenshot('03_settings_modal');
  await home();
  await ui(`(await until(()=>buttons().find(b=>b.classList.contains('session')&&b.textContent.includes('诊断图示例：自连接膨胀与 Spill')))).click();(await until(()=>buttons().find(b=>b.textContent.trim()==='诊断图'))).click();await until(()=>document.querySelectorAll('[data-graph-node]').length===35);`);
  await ui(`const findings=document.querySelector('.graph-findings-list');if(findings)findings.open=false;const fit=buttons().find(b=>b.textContent.trim()==='适配');if(fit)fit.click();const canvas=document.querySelector('.graph-canvas');const bounds=canvas.getBoundingClientRect();if(bounds.bottom>innerHeight)canvas.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return {canvas:canvas.getBoundingClientRect().toJSON(),inspector:document.querySelector('.inspector').getBoundingClientRect().toJSON()};`).then(result=>console.log('Canvas screenshot bounds:',JSON.stringify(result)));
  await screenshot('04_diagnostic_session');
  await screenshot('07_diagnostic_dag');
  await ui(`(await until(()=>buttons().find(b=>b.className.includes('graph-finding')&&b.textContent.includes('JOIN_EXPLOSION')))).click();await until(()=>document.querySelector('.graph-target')?.textContent.includes('"nodeId": 15'));const fit=buttons().find(b=>b.textContent.trim()==='适配');if(fit)fit.click();return {nodes:document.querySelectorAll('[data-graph-node]').length,edges:document.querySelectorAll('.graph-edge').length,target:document.querySelector('.graph-target').textContent};`).then((result)=>console.log('Verified real DAG:',JSON.stringify(result)));
  await send('Emulation.setDeviceMetricsOverride', { width: 1760, height: 1700, deviceScaleFactor: 1.5, mobile: false });
  await ui(`document.querySelector('.inspector-body').scrollTop=0;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));if(!document.querySelector('.graph-evidence').innerText.includes('膨胀为'))throw new Error('Localized Join evidence missing');`);
  await screenshot('08_dag_node_evidence');
  await send('Emulation.setDeviceMetricsOverride', { width: 1760, height: 1100, deviceScaleFactor: 1.5, mobile: false });
  await home();
  await ui(`(await until(()=>buttons().find(b=>b.classList.contains('nav-btn')&&b.textContent.includes('知识沉淀')))).click();await until(()=>document.querySelectorAll('.doc-card').length>0&&!document.querySelector('.content-loading'));await until(()=>document.querySelector('.learnings-wrapper')||document.querySelector('.candidate-item'));`);
  await screenshot('05_memory_knowledge_base');
  await ui(`(await until(()=>document.querySelector('.doc-card'))).click();await until(()=>document.querySelector('.doc-report-wrapper .report-body')?.textContent.length>100&&!document.querySelector('.content-loading'));if(document.querySelector('.doc-report-wrapper .report-body').textContent.includes('翻译暂不可用'))throw new Error('Read-time translation notice must not appear in saved-source view');`);
  await screenshot('06_memory_investigation_doc');
  console.log('Screenshots captured from real UI; no model diagnosis or approval actions triggered.');
} finally { ws.close(); }
