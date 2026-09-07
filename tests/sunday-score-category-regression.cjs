const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
  .replace(/^init\(\);\r?$/m, '').replace(/^initInstallUi\(\);\r?$/m, '');

(async () => {
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); });
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
      currentTab = 'scores'; songsLoaded = true;
      const song = (id, songName, category, month = 9, day = 13) => ({ id, songName, category, year: 2026, month, day });
      allSongs = [
        song('hymn', '하나님의 사랑은', '주일찬송'),
        song('l85exBzmFQsny0MOAEp0', '나 가진 재물 없으나', '시각선교부'),
        song('special', '야곱의 축복', '주일 봉사회 특송'),
        song('unknown', '미분류 특송', ''),
        song('prefix', '분류명에 주일찬송 포함', '주일찬송 외 특송'),
        song('future', '10월 주일 찬송곡', '주일 찬송', 10, 4),
        song('future-special', '10월 시각선교부 특송', '시각선교부', 10, 11),
        song('future-unknown', '미분류 미래 특송', '', 10, 18),
        song('later', '멀리 예정된 주일 찬송곡', '주일찬송', 10, 25),
        song('weekday', '평일 곡', '주일찬송', 10, 9)
      ];
      allSchedules = [
        { id: 'opt-in', date: '2026-10-18', endDate: '2026-10-18', title: '주일 연습', songs: '직접 표시한 찬송곡', showInSundayScores: true },
        { id: 'opt-out', date: '2026-09-13', endDate: '2026-09-13', title: '시각선교부', songs: '표시하지 않은 일정 특송', showInSundayScores: false },
        { id: 'multi-day', date: '2026-09-13', endDate: '2026-09-14', title: '기간 행사', songs: '기간 특송', showInSundayScores: true }
      ];
      allScores = [{ id: 'special-file', title: '나 가진 재물 없으나', scoreKind: 'singer', public: true }];
      window.originalRecords = JSON.stringify([allSongs, allSchedules, allScores]);
      window.rangeReads = 0;
      ensureScheduleRange = async () => { window.rangeReads++; return allSchedules; };
      visibleScoresForTitle = name => [{ id: name }];
      renderScoreActionForSong = item => '<button data-test-song="' + item.id + '">보기</button>';
      renderScoreActionForTitle = title => '<button>' + escHtml(title) + ' 악보</button>';
      document.querySelectorAll('.page').forEach(el => el.classList.add('hidden'));
      document.getElementById('pageScores').classList.remove('hidden');
      renderScoreWeekPanel();
    });
    await page.waitForFunction(() => scoreWeekScheduleRangeKey !== '' && !scoreWeekSchedulePromise);
    const text = await page.locator('#scoreWeekPanel').innerText();
    for (const title of ['하나님의 사랑은', '10월 주일 찬송곡', '멀리 예정된 주일 찬송곡', '직접 표시한 찬송곡']) assert.ok(text.includes(title), 'missing ' + title);
    for (const title of ['나 가진 재물 없으나', '야곱의 축복', '미분류 특송', '분류명에 주일찬송 포함', '10월 시각선교부 특송', '미분류 미래 특송', '평일 곡', '표시하지 않은 일정 특송', '기간 특송']) assert.ok(!text.includes(title), 'unexpected ' + title);
    assert.equal(await page.locator('[data-score-week-key="2026-10-11"]').count(), 0, 'special created future week');
    assert.equal(await page.evaluate(() => JSON.stringify([allSongs, allSchedules, allScores]) === window.originalRecords), true, 'records changed');
    await page.evaluate(() => renderScoreWeekPanel());
    assert.equal(await page.evaluate(() => window.rangeReads), 1, 'extra range read');
    for (const width of [390, 820]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => renderScoreWeekPanel());
      await page.waitForFunction(() => document.querySelector('#scoreWeekPanel .score-week-grid').style.maxHeight !== '');
      assert.ok(await page.locator('#scoreWeekPanel .score-week-grid').evaluate(el => el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY === 'auto'), 'four-row scroll missing');
    }
    await page.evaluate(async () => {
      currentTab = 'home'; adminRole = ''; currentUser = null;
      canAccessHomeAttendance = () => false; canViewSongList = () => true; canViewScores = () => false;
      canShowHomeEventHub = () => false; canUseMemberHandbook = () => false; canUseRehearsalCue = () => false;
      canSeeHomePianistAssignments = () => false; findVisibleScoresForSong = () => [];
      loadCache = () => null; schedulesLoaded = true;
      publishedSeatingLoaded = true; publishedSeatingPlan = null; publishedSeatingPlans = []; homeEventSchedules = [];
      getPublishedSeatingPlan = async () => null;
      document.querySelectorAll('.page').forEach(el => el.classList.add('hidden'));
      document.getElementById('pageHome').classList.remove('hidden');
      renderHome();
    });
    await page.waitForFunction(() => document.querySelector('[data-home-region="songs"]').textContent.includes('하나님의 사랑은'));
    const home = await page.locator('[data-home-region="songs"]').innerText();
    assert.ok(!home.includes('나 가진 재물 없으나') && !home.includes('야곱의 축복') && !home.includes('미분류 특송'), 'home category leak');
    assert.equal(await page.evaluate(() => allSongs.some(song => song.id === 'l85exBzmFQsny0MOAEp0') && allScores.some(score => score.id === 'special-file')), true, 'special data removed');
    assert.deepEqual(errors, []);
    console.log('PASS: 9/13 special excluded, hymn retained, strict category, unclassified/weekday excluded, schedule opt-in retained, future weeks and four-row scroll, home filtering, no record writes or extra range reads');
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
