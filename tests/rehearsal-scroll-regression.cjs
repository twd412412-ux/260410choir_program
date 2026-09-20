const assert = require('node:assert/strict');
const fs = require('node:fs'), http = require('node:http');
const { chromium, webkit } = require('playwright');
const html = fs.readFileSync('index.html', 'utf8').replace(/^init\(\);\r?$/m, '').replace(/^initInstallUi\(\);\r?$/m, '');
(async () => {
  const server = http.createServer((req, res) => {
    if (require('./serve-firebase-sdk.cjs')(req, res)) return;
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  let browser;
  try {
    browser = process.env.TEST_WEBKIT ? await webkit.launch() : await chromium.launch({ channel: 'msedge' });
    const page = await browser.newPage({ hasTouch: true });
    await page.route(/googleapis\.com|cloudfunctions\.net/, r => r.abort());
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.evaluate(() => {
      adminRole = 'admin'; rehearsalOwnerId = rehearsalScheduleId = 'fixture';
      allSchedules = [{ id: 'fixture', title: 'Scroll fixture', date: '2099-10-17', program: Array.from({ length: 30 }, (_, i) => 'Song ' + (i + 1)).join('\n') }];
      rehearsalItems = rehearsalItemsFromSchedule(allSchedules[0]);
      document.getElementById('modalRehearsalCue').classList.add('active'); renderRehearsalCue();
    });
    for (const size of [{ width: 390, height: 844 }, { width: 844, height: 390 }, { width: 820, height: 1180 }, { width: 1180, height: 820 }]) {
      await page.setViewportSize(size);
      for (const light of [false, true]) {
        await page.evaluate(light => {
          document.getElementById('modalRehearsalCue').classList.toggle('theme-light', light);
          document.getElementById('rehearsalCueBody').scrollTop = 0;
        }, light);
        const result = await page.evaluate(() => {
          const body = document.getElementById('rehearsalCueBody');
          const rect = document.getElementById('rehearsalCueControls').getBoundingClientRect();
          return { overflow: getComputedStyle(body).overflowY, scrollable: body.scrollHeight > body.clientHeight, footerVisible: rect.bottom <= innerHeight + 1, horizontal: body.scrollWidth > body.clientWidth + 1 };
        });
        assert.equal(result.overflow, 'auto'); assert(result.scrollable); assert(result.footerVisible); assert(!result.horizontal);
        if (!process.env.TEST_WEBKIT) {
          const area = await page.locator('#rehearsalCueBody').boundingBox();
          await page.mouse.move(area.x + 40, area.y + 60);
          await page.mouse.wheel(0, 240);
          await page.waitForFunction(() => document.getElementById('rehearsalCueBody').scrollTop > 0);
        }
        await page.locator('#rehearsalCueBody').evaluate(el => { el.scrollTop = el.scrollHeight; });
        const last = page.locator('.rehearsal-order-row').last();
        const bounds = await last.boundingBox();
        const bodyBounds = await page.locator('#rehearsalCueBody').boundingBox();
        assert(bounds.y >= bodyBounds.y && bounds.y + bounds.height <= bodyBounds.y + bodyBounds.height + 1, 'last song reachable without nested scrolling');
        await page.screenshot({ path: `tmp/cue-scroll-${process.env.TEST_WEBKIT ? 'webkit' : 'chrome'}-${size.width}-${light}.png` });
      }
    }
    await page.locator('.rehearsal-order-row').last().click();
    assert.equal(await page.evaluate(() => rehearsalIndex), 29);
    assert.equal(await page.locator('#rehearsalCueBody').evaluate(el => el.scrollTop), 0);
    console.log('PASS: cue body scroll, last song access, fixed controls, light/dark, phone/tablet portrait/landscape');
  } finally { if (browser) await browser.close(); await new Promise(r => server.close(r)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
