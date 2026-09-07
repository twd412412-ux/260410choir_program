const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
  .replace(/^init\(\);\r?$/m, '').replace(/^initInstallUi\(\);\r?$/m, '');

(async () => {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Seoul' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route(/firestore\.googleapis\.com|firebasestorage\.googleapis\.com|cloudfunctions\.net/, route => route.abort());
    await page.clock.setFixedTime(new Date('2026-09-07T12:00:00+09:00'));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(() => {
      ensureScoreRealtimeSync = () => Promise.resolve([]);
      canShowHomeEventHub = () => true;
      rehearsalItemsFromSchedule = () => [];
      const host = document.createElement('div');
      host.id = 'ddayFixture';
      host.style.padding = '16px';
      Array.from(document.body.children).forEach(el => { el.style.display = 'none'; });
      document.body.appendChild(host);
      window.scheduleFixture = {
        id: 'night', title: '찬양의밤', date: '2026-10-12', endDate: '2026-10-12',
        time: '19:30', useBriefing: true, showEventHub: true, program: ''
      };
      host.innerHTML = renderHomeEventHubCard(window.scheduleFixture);
    });
    const badge = page.locator('.home-event-dday');
    assert.equal(await badge.innerText(), 'D-35');
    for (const width of [320, 390, 820]) {
      await page.setViewportSize({ width, height: 844 });
      for (const dark of [false, true]) {
        await page.evaluate(dark => document.documentElement.classList.toggle('dark', dark), dark);
        const box = await badge.boundingBox();
        const style = await badge.evaluate(el => ({
          fontSize: parseFloat(getComputedStyle(el).fontSize),
          whiteSpace: getComputedStyle(el).whiteSpace,
          background: getComputedStyle(el).backgroundColor,
          overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
        }));
        assert.ok(box.width >= 62 && box.height >= 42, 'badge should be prominent');
        assert.ok(style.fontSize >= 16 && style.whiteSpace === 'nowrap');
        assert.equal(style.overflow, false, 'horizontal overflow at ' + width);
        assert.notEqual(style.background, 'rgba(0, 0, 0, 0)');
        fs.mkdirSync(path.join(root, 'tmp/home-event-dday'), { recursive: true });
        await page.screenshot({ path: path.join(root, `tmp/home-event-dday/${width}-${dark ? 'dark' : 'light'}.png`) });
      }
    }
    assert.deepEqual(errors, []);
    console.log('PASS prominent gold D-day badge, light/dark contrast, 320/390/820px bounds');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
