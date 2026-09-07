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
      currentTab = 'calendar'; calYear = 2026; calMonth = 8;
      scheduleLoadedMonths['2026-09'] = true;
      loadScheduleMonth = () => { throw new Error('unexpected read'); };
      syncQuickCreateActions = () => {};
      canEditScheduleItem = () => true;
      canManageSchedules = () => true;
      const song = (id, category) => ({ id, category, songName: id, year: 2026, month: 9, day: 13 });
      allSongs = [song('주일곡', '주일찬송'), song('시각선교부곡', '시각선교부'), song('미분류곡', '')];
      allSchedules = [
        { id: 'practice', title: '정기 연습', date: '2026-09-13' },
        { id: 'event', title: '찬양의 밤', useBriefing: true, date: '2026-09-14', endDate: '2026-09-16' },
        { id: 'custom', title: '회의', calendarKind: 'other', color: '#C66B6B', date: '2026-09-13' },
        { id: 'explicit', title: '찬송 일정', showInSundayScores: true, date: '2026-09-20' }
      ];
      window.beforeRecords = JSON.stringify([allSongs, allSchedules]);
      document.querySelectorAll('[id^="page"]').forEach(el => el.classList.add('hidden'));
      document.getElementById('pageCalendar').classList.remove('hidden');
      renderCal(); showCalDay('2026-09-13', 13);
    });
    assert.deepEqual(await page.evaluate(() => [calendarKind(allSongs[0], true), calendarKind(allSongs[1], true), calendarKind(allSongs[2], true), calendarKind(allSchedules[0]), calendarKind(allSchedules[1]), calendarColor(allSchedules[2])]), ['hymn', 'special', 'special', 'practice', 'event', '#C66B6B']);
    for (const mode of ['stack', 'default']) {
      await page.evaluate(mode => setCalViewMode(mode), mode);
      for (const [kind, yes, no] of [['hymn', '주일곡', '시각선교부곡'], ['special', '시각선교부곡', '주일곡'], ['practice', '정기 연습', '주일곡'], ['other', '회의', '정기 연습']]) {
        await page.evaluate(kind => { setCalendarKindFilter(kind); showCalDay('2026-09-13', 13); }, kind);
        const text = await page.locator('#calEvtList').innerText();
        assert.ok(text.includes(yes), kind + ' missing'); assert.ok(!text.includes(no), kind + ' leaked');
        if (kind === 'hymn') assert.ok(!text.includes('시각선교부곡') && !text.includes('미분류곡'));
      }
    }
    await page.evaluate(() => { setCalViewMode('stack'); setCalendarKindFilter('event'); });
    assert.equal(await page.locator('.cal-range-bar').count(), 1);
    assert.equal(await page.locator('.cal-range-bar').evaluate(el => el.style.gridColumn), '2 / 5');
    assert.equal(await page.evaluate(() => JSON.stringify([allSongs, allSchedules]) === beforeRecords), true);
    const form = await page.evaluate(async () => {
      editSchedule('custom', { scroll: false });
      const legacyColor = selColor;
      document.getElementById('schKind').value = 'practice';
      const beforeState = scheduleFormState();
      document.getElementById('schKind').value = 'event';
      const changed = scheduleFormState() !== beforeState;
      initColorPicker();
      const retained = selColor;
      pickColor('');
      window.saved = null;
      db = { collection: () => ({ doc: () => ({ update: async data => { window.saved = data; } }) }) };
      loadSchAdmin = () => {}; saveLoadedScheduleMonthCaches = () => {}; writeLog = () => {};
      await addSchedule();
      const normalized = scheduleRowFromDoc({ id: 'saved', data: () => window.saved });
      return { legacyColor, retained, changed, saved: window.saved, normalized, resetKind: document.getElementById('schKind').value, resetColor: selColor };
    });
    assert.equal(form.legacyColor, '#C66B6B'); assert.equal(form.retained, '#C66B6B'); assert.equal(form.changed, true);
    assert.equal(form.saved.calendarKind, 'event'); assert.equal(form.saved.colorMode, 'auto'); assert.equal(form.saved.color, '#936D2B');
    assert.equal(form.normalized.calendarKind, 'event'); assert.equal(form.normalized.colorMode, 'auto');
    assert.equal(form.resetKind, 'other'); assert.equal(form.resetColor, '');
    fs.mkdirSync(path.join(root, 'tmp/calendar-kind'), { recursive: true });
    for (const width of [320, 390, 820]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const dark of [false, true]) {
        await page.evaluate(dark => { document.documentElement.classList.toggle('dark', dark); setCalendarKindFilter('all'); showCalDay('2026-09-13', 13); }, dark);
        assert.ok(await page.locator('#calKindFilters').evaluate(el => el.scrollWidth <= el.clientWidth));
        assert.deepEqual(await page.locator('#calKindFilters button').allTextContents(), ['전체', '주일찬송', '특송', '연습']);
        assert.ok(await page.locator('#calKindFilters button').evaluateAll(els => els.every(el => el.scrollWidth <= el.clientWidth && getComputedStyle(el).whiteSpace === 'nowrap')));
        await page.screenshot({ path: path.join(root, `tmp/calendar-kind/${width}-${dark ? 'dark' : 'light'}.png`), fullPage: true });
      }
    }
    assert.deepEqual(errors, []);
    console.log('PASS calendar kinds, both views and day filters, no Sunday inference, period bars, legacy colors, save/edit/reset/normalization, responsive light/dark, no extra reads');
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
