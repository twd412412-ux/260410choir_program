const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium, webkit } = require('playwright');
const html = fs.readFileSync(process.env.SEATING_TEST_HTML || path.join(__dirname, '../index.html'), 'utf8');

(async () => {
  const server = http.createServer((req, res) => {
    if (require('./serve-firebase-sdk.cjs')(req, res)) return;
    if (new URL(req.url, 'http://localhost').pathname === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(html);
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = process.env.STARTUP_BROWSER === 'webkit'
    ? await webkit.launch({ headless: true })
    : await chromium.launch({ channel: 'msedge', headless: true });
  const url = 'http://127.0.0.1:' + server.address().port;
  try {
    for (const mode of ['healthy', 'cached', 'stalled', 'missing']) {
      const context = await browser.newContext({ viewport: { width: 820, height: 1180 }, hasTouch: true, serviceWorkers: 'block' });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      // No production database access; retain the real synchronous init path.
      await page.route(/googleapis\.com|gstatic\.com|cloudfunctions\.net/, route => route.abort());
      await page.addInitScript(cached => {
        localStorage.setItem('startup-draft-sentinel', 'keep');
        if (cached) localStorage.setItem('choir_user', JSON.stringify({ id: 'fixture', name: '테스트', part: 'S1', permissions: {} }));
      }, mode === 'cached');
      if (mode === 'stalled') await page.route('**/firebase-app-compat.js', () => {});
      if (mode === 'missing') await page.route('**/firebase-app-compat.js', route => route.abort());
      await page.goto(url, { waitUntil: 'commit' });
      if (mode === 'healthy' || mode === 'cached') {
        await page.waitForFunction(() => window.appStartupReady === true, { timeout: 15000 });
        assert.equal(await page.locator('#appStartup').count(), 0);
        assert.match(await page.locator('body').innerText(), /광주교회 찬양대/);
        assert.deepEqual(errors, []);
      } else {
        await page.locator('#appStartupRetry').waitFor({ state: 'visible', timeout: 15000 });
        assert.match(await page.locator('#appStartupMessage').innerText(), /다시 열어/);
        assert.equal(await page.evaluate(() => localStorage.getItem('startup-draft-sentinel')), 'keep');
        // WebKit waits for document fonts even when a script is deliberately held.
        if (process.env.STARTUP_BROWSER !== 'webkit') await page.screenshot({ path: path.join(__dirname, '../tmp/startup-' + mode + '.png') });
        await page.unroute('**/firebase-app-compat.js');
        const box = await page.locator('#appStartupRetry').boundingBox();
        assert(box && box.width > 0 && box.height > 0);
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForURL(/startupRetry=/, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForFunction(() => window.appStartupReady === true);
        assert.equal(await page.evaluate(() => localStorage.getItem('startup-draft-sentinel')), 'keep');
      }
      console.log('PASS startup: ' + mode);
      await context.close();
    }
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
