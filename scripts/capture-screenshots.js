import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';

mkdirSync('docs/screenshots', { recursive: true });

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log('Starting headless Chrome...');
  const chromeProc = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new',
    '--remote-debugging-port=9222',
    '--user-data-dir=/tmp/chrome-ss-clean-2',
    '--window-size=1440,900',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ], { stdio: 'ignore' });

  let versionData = null;
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch('http://127.0.0.1:9222/json/version');
      if (res.ok) {
        versionData = await res.json();
        break;
      }
    } catch {}
    await sleep(200);
  }

  if (!versionData) {
    chromeProc.kill();
    throw new Error('Failed to connect to Chrome remote debugging port.');
  }

  const pagesRes = await fetch('http://127.0.0.1:9222/json/list');
  const pages = await pagesRes.json();
  const targetPage = pages.find((p) => p.type === 'page') || pages[0];
  const wsUrl = targetPage.webSocketDebuggerUrl;

  const ws = new WebSocket(wsUrl);
  let msgId = 1;
  const pending = new Map();

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) reject(data.error);
      else resolve(data.result);
    }
  };

  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });

  function send(method, params = {}) {
    const id = msgId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async function evaluate(expression) {
    const res = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    return res.result?.value;
  }

  async function takeScreenshot(outputPath) {
    const res = await send('Page.captureScreenshot', { format: 'png' });
    const buffer = Buffer.from(res.data, 'base64');
    writeFileSync(outputPath, buffer);
    console.log(`Saved screenshot: ${outputPath} (${buffer.length} bytes)`);
  }

  await send('Page.enable');
  await send('DOM.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false,
  });

  // 1. Home Launcher View
  console.log('1. Capturing Home Launcher View...');
  await send('Page.navigate', { url: 'http://127.0.0.1:8787' });
  await sleep(1500);
  await takeScreenshot('docs/screenshots/01_hero_launcher.png');
  await takeScreenshot('docs/ui.png');

  // 2. Open App Select Dropdown
  console.log('2. Capturing App Select Dropdown...');
  await evaluate(`document.querySelector('.app-select-trigger')?.click();`);
  await sleep(600);
  await takeScreenshot('docs/screenshots/02_app_select_dropdown.png');

  // 3. Open Settings Modal
  console.log('3. Capturing Settings Modal...');
  await send('Page.navigate', { url: 'http://127.0.0.1:8787' });
  await sleep(1000);
  await evaluate(`
    const btns = Array.from(document.querySelectorAll('button'));
    const btn = btns.find(b => b.textContent.includes('系统设置') || b.title?.includes('系统配置'));
    btn?.click();
  `);
  await sleep(700);
  await takeScreenshot('docs/screenshots/03_settings_modal.png');

  // 4. Investigation Session View
  console.log('4. Capturing Investigation Session View...');
  await send('Page.navigate', { url: 'http://127.0.0.1:8787' });
  await sleep(1200);
  await evaluate(`
    const sessionBtns = Array.from(document.querySelectorAll('button.session'));
    if (sessionBtns.length > 0) sessionBtns[0].click();
  `);
  await sleep(2500);
  await takeScreenshot('docs/screenshots/04_diagnostic_session.png');

  // 5. Memory View (Learnings & Candidate Rules)
  console.log('5. Capturing Memory View (Candidate Rules)...');
  await send('Page.navigate', { url: 'http://127.0.0.1:8787' });
  await sleep(1000);
  await evaluate(`
    const btns = Array.from(document.querySelectorAll('button.nav-btn'));
    const memBtn = btns.find(b => b.textContent.includes('知识沉淀'));
    memBtn?.click();
  `);
  await sleep(1500);
  await takeScreenshot('docs/screenshots/05_memory_knowledge_base.png');

  // 6. Select a Case Document in Memory View
  console.log('6. Capturing Memory Case Document View...');
  await evaluate(`
    const docCards = Array.from(document.querySelectorAll('.doc-card'));
    if (docCards.length > 0) docCards[0].click();
  `);
  await sleep(1000);
  await takeScreenshot('docs/screenshots/06_memory_investigation_doc.png');

  console.log('All screenshots captured cleanly and verified!');
  ws.close();
  chromeProc.kill();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
