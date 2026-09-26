const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium, webkit } = require('playwright');
const root = path.join(__dirname, 'site');
const output = path.join(__dirname, 'screenshots');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png' };
(async () => {
  fs.mkdirSync(output, { recursive: true });
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const engine of [chromium, webkit]) {
      const browser = await engine.launch(engine === chromium ? { channel: 'msedge' } : {});
      try {
        for (const [width, height] of [[320, 568], [390, 844], [844, 390], [820, 1180], [1180, 820], [1440, 1000]]) {
          const page = await browser.newPage({ viewport: { width, height }, isMobile: width < 1400, hasTouch: true });
          const errors = [], external = [];
          page.on('pageerror', error => errors.push(error.message));
          page.on('request', request => { if (new URL(request.url()).hostname !== '127.0.0.1') external.push(request.url()); });
          await page.goto(`http://127.0.0.1:${server.address().port}`);
          await page.waitForFunction(() => document.querySelector('.icon-refined svg'));
          for (const mode of ['refined', 'original']) {
            await page.locator(`[data-mode=${mode}]`).click();
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${engine.name()} ${width} ${mode} overflow`);
            assert.ok(await page.locator('.home-score-chip').count() >= 3);
            assert.equal(await page.locator('.home-seating-plan-button').count(), 4);
            assert.equal(await page.locator('.home-event-row').count(), 7);
            assert.ok(await page.locator('.home-hymn-art img').evaluate(el => el.complete && el.naturalWidth > 0));
            if ([390, 820, 1440].includes(width)) await page.screenshot({ path: path.join(output, `${engine.name()}-${width}-${mode}.png`), fullPage: true });
          }
          await page.locator('[data-mode=refined]').click();
          await page.locator('[data-preview-action=setHomeEventHubTab][data-preview-arg=info]').click();
          assert.equal(await page.locator('.home-event-row').count(), 0);
          await page.locator('[data-preview-action=setHomeEventHubTab][data-preview-arg=program]').click();
          assert.equal(await page.locator('.home-event-row').count(), 7);
          await page.locator('#homeGlobalSearch').click();
          await page.locator('.demo-search').fill('ㅎㄴㄴ');
          assert.equal(await page.locator('.demo-result').count(), 1);
          await page.locator('.demo-search').fill('없는곡');
          assert.equal(await page.locator('.demo-results-empty').count(), 1);
          await page.locator('.dialog-close').click();
          await page.locator('.home-seating-plan-button').first().click();
          assert.equal(await page.locator('.demo-seat-grid span').count(), 24);
          await page.locator('.dialog-close').click();
          await page.locator('#btnDark').click();
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
          if (width === 390) await page.screenshot({ path: path.join(output, `${engine.name()}-${width}-dark.png`), fullPage: true });
          assert.deepEqual(errors, []);
          assert.deepEqual(external, [], 'Preview must not make external requests');
          assert.equal(await page.evaluate(() => typeof window.firebase), 'undefined');
          assert.equal(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length), 0);
          await page.close();
        }
        console.log(`PASS ${engine.name()}: six viewports, comparison, tabs, search, sample dialogs, dark theme, no external/Firebase/SW access`);
      } finally { await browser.close(); }
    }
    const deployedHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    assert.ok(!/firebase|AIza|onclick=|manifest\.json/.test(deployedHtml));
  } finally { await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
