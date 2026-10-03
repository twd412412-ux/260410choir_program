const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
  .replace(/^init\(\);\r?$/m, '').replace(/^initInstallUi\(\);\r?$/m, '');

(async () => {
  const server = http.createServer((req, res) => { if (require('./serve-firebase-sdk.cjs')(req, res)) return;
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
      canUseRehearsalCue = () => true;
      openRehearsalCue = id => { window.openedCueId = id; };
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
        const cueBox = await page.locator('.home-event-cue').boundingBox();
        assert.ok(cueBox.height >= 44 && cueBox.x + cueBox.width <= box.x, 'cue left of D-day');
        fs.mkdirSync(path.join(root, 'tmp/home-event-dday'), { recursive: true });
        await page.screenshot({ path: path.join(root, `tmp/home-event-dday/${width}-${dark ? 'dark' : 'light'}.png`) });
      }
    }
    await page.locator('.home-event-cue').click();
    assert.equal(await page.evaluate(() => window.openedCueId), 'night');
    await page.evaluate(() => {
      canUseRehearsalCue = () => false;
      document.getElementById('ddayFixture').innerHTML = renderHomeEventHubCard(window.scheduleFixture);
    });
    assert.equal(await page.locator('.home-event-cue').count(), 0, 'no cue shortcut without permission');
    await page.evaluate(() => {
      canViewAttendance = () => true;
      canCheckAttendance = () => true;
      canUseRehearsalCue = () => true;
      openRehearsalAttendance = () => { window.openedAttendance = true; };
      document.documentElement.classList.remove('dark');
      document.getElementById('ddayFixture').innerHTML = renderHomeEventHubCard(window.scheduleFixture);
    });
    for (const width of [320, 390, 820]) {
      await page.setViewportSize({width, height:844});
      const attendance = await page.getByRole('button', {name:'리허설 출첵', exact:true}).boundingBox();
      const cue = await page.getByRole('button', {name:'큐시트', exact:true}).boundingBox();
      assert(attendance.x + attendance.width <= cue.x, 'attendance button left of cue');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({path:path.join(root, `tmp/home-event-dday/${width}-attendance-light.png`)});
    }
    await page.getByRole('button', {name:'리허설 출첵', exact:true}).click();
    assert.equal(await page.evaluate(() => window.openedAttendance), true);
    await page.evaluate(() => {
      canViewAttendance = () => false;canCheckAttendance = () => false;
      document.getElementById('ddayFixture').innerHTML = renderHomeEventHubCard(window.scheduleFixture);
    });
    assert.equal(await page.getByRole('button', {name:'리허설 출첵', exact:true}).count(), 0, 'ordinary member has no attendance shortcut');
    assert.deepEqual(errors, []);
    console.log('PASS prominent gold D-day badge, light/dark contrast, 320/390/820px bounds');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
