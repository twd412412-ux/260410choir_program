const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/^init\(\);\r?$/m, '').replace(/^initInstallUi\(\);\r?$/m, '');
(async () => {
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route(/firestore\.googleapis\.com|firebasestorage\.googleapis\.com|cloudfunctions\.net/, route => route.abort());
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(() => {
      ensureScoreRealtimeSync = () => Promise.resolve([]);
      songsLoaded = scoresLoaded = true;
      canViewScores = () => true;
      canManageScores = () => false;
      window.allowed = ['singer', 'orchestra'];
      canViewScoreItem = canOpenScoreItem = score => score.public && window.allowed.includes(score.scoreKind);
      allSongs = [];
      allScores = ['은혜', '엘샤다이'].flatMap((title, index) => [
        { id: 'singer-' + index, title, scoreKind: 'singer', public: true },
        ...Array.from({ length: 18 }, (_, part) => ({ id: 'part-' + index + '-' + part, title, scoreKind: 'orchestra', instrumentLabel: '파트 ' + part, instrument: 'p' + part, public: true, versionNumber: part === 0 ? 2 : 1, currentUploadedAt: '2026-09-07T00:00:00Z' }))
      ]);
      allScores.push({ id: 'private', title: '은혜', scoreKind: 'orchestra', public: false });
      allSchedules = [{ id: 'night', title: '찬양의 밤', date: '2026-09-20', useBriefing: true, program: '1. 은혜\n2. 엘샤다이' }];
      scorePickerOrchestraOpen = true;
      window.original = JSON.stringify(allScores);
      window.renderFixture = () => {
        document.getElementById('schDetailBody').innerHTML = renderScheduleScoreSection(allSchedules[0], false);
        openModal('modalSchDetail');
      };
      renderFixture();
    });
    assert.deepEqual(await page.locator('#schScheduleScoreSection > .score-picker-section').allTextContents(), ['싱어 악보', '관현악 악보']);
    assert.equal(await page.locator('#schScheduleScoreSection .score-week-row').count(), 2);
    assert.equal(await page.locator('#schScheduleScoreSection details').count(), 2);
    assert.equal(await page.locator('#schScheduleScoreSection details[open]').count(), 0);
    assert.equal(await page.locator('#schScheduleScoreSection .score-picker-part').count(), 36);
    assert.equal(await page.locator('[onclick*="private"]').count(), 0);
    await page.locator('#schScheduleScoreSection summary').first().click();
    assert.equal(await page.locator('#schScheduleScoreSection details[open]').count(), 1);
    await page.evaluate(() => { openScoreFileById = id => { window.openedFile = id; }; });
    const part = page.locator('#schScheduleScoreSection details[open] .score-picker-part').first();
    await part.click();
    assert.ok((await page.evaluate(() => window.openedFile)).startsWith('part-'));
    fs.mkdirSync(path.join(root, 'tmp/schedule-score-folders'), { recursive: true });
    for (const width of [320, 820]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(() => renderFixture());
      assert.ok(await page.locator('#schScheduleScoreSection').evaluate(el => el.scrollWidth <= el.clientWidth));
      await page.screenshot({ path: path.join(root, `tmp/schedule-score-folders/${width}.png`) });
    }
    await page.evaluate(() => { window.allowed = ['singer']; renderFixture(); });
    assert.equal(await page.locator('#schScheduleScoreSection details').count(), 0);
    assert.equal(await page.locator('#schScheduleScoreSection .score-week-row').count(), 2);
    await page.evaluate(() => { window.allowed = ['orchestra']; renderFixture(); });
    assert.equal(await page.locator('#schScheduleScoreSection .score-week-row').count(), 0);
    assert.equal(await page.locator('#schScheduleScoreSection details').count(), 2);
    assert.equal(await page.evaluate(() => JSON.stringify(allScores) === window.original), true);
    assert.deepEqual(errors, []);
    console.log('PASS schedule singer/orchestra sections, per-song collapsed folders, 36 parts, part opening, access filtering and mobile bounds');
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
