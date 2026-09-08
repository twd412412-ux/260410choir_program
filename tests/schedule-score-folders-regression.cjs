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
    const matching = await page.evaluate(() => {
      window.allowed = ['singer', 'orchestra'];
      allSongs = [];
      allScores = [
        {id: 'short', title: '갈보리', scoreKind: 'singer', public: true},
        {id: 'long', title: '갈보리 산 위에', scoreKind: 'singer', public: true},
        {id: 'english', title: 'El Shaddai', scoreKind: 'orchestra', public: true},
        {id: 'hidden', title: '갈보리 산 위에', scoreKind: 'orchestra', public: false}
      ];
      const ids = schedule => scheduleMatchedScoreRows(schedule).filter(r => r.score).map(r => r.score.id).sort();
      const result = {
        longOnly: ids({program: '1. 갈보리 산 위에'}),
        both: ids({program: '1. 갈보리\n2. 갈보리 산 위에'}),
        separateLines: ids({program: '갈보리\n산 위에'}),
        bilingual: ids({songs: '엘샤다이 (El Shaddai)'}),
        encore: ids({program: '첫째날\n1. 곡명: 갈보리 산 위에\n앵콜: 갈보리 산 위에'}),
        noSubstringHome: homeEventMatchedScoreRow({}, '갈보리 산 위에', [{score: allScores[0]}]) === null
      };
      allScores.push({id: 'stale-label', title: '다른 곡', linkedSongName: '갈보리 산 위에', public: true, scoreKind: 'singer'});
      result.staleLabel = ids({program: '갈보리 산 위에'});
      allScores.pop();
      allSongs = [
        {id: 'past', songName: '갈보리 산 위에', year: 2022, month: 9, day: 20},
        {id: 'current', songName: '갈보리 산 위에', year: 2026, month: 9, day: 20}
      ];
      allScores.push({id: 'manual', title: '별도로 정한 악보 이름', currentFilePath: 'scores/manual/original.pdf', scoreKind: 'singer', public: true, linkedSongId: 'current', linkedSongIds: ['current'], linkedSongName: '갈보리 산 위에'});
      allScores.forEach(score => {score.currentFilePath = score.currentFilePath || 'scores/' + score.id + '/original.pdf';});
      const event = {date: '2026-09-20', program: '1. 갈보리 산 위에'};
      result.selectedSong = scheduleMatchedSongs(event).map(song => song.id);
      result.explicitLink = ids(event);
      window.allowed = ['orchestra'];
      result.permissionFiltered = ids(event);
      window.allowed = ['singer', 'orchestra'];
      allSongs = Array.from({length: 1916}, (_, i) => ({id: 'song' + i, songName: '테스트곡 ' + i, year: 2026, month: 9, day: 20}));
      allScores = Array.from({length: 300}, (_, i) => ({id: 'score' + i, title: '테스트곡 ' + i, currentFilePath: 'scores/score' + i + '/original.pdf', scoreKind: 'singer', public: true}));
      const bigEvent = {date: '2026-09-20', program: Array.from({length: 60}, (_, i) => (i + 1) + '. 테스트곡 ' + i).join('\n')};
      const start = performance.now();
      result.largeCount = ids(bigEvent).length;
      result.matchingMs = Math.round(performance.now() - start);
      return result;
    });
    assert.deepEqual(matching.longOnly, ['long']);
    assert.deepEqual(matching.both, ['long', 'short']);
    assert.deepEqual(matching.separateLines, ['short']);
    assert.deepEqual(matching.bilingual, ['english']);
    assert.deepEqual(matching.encore, ['long']);
    assert.equal(matching.noSubstringHome, true);
    assert.deepEqual(matching.staleLabel, ['long'], 'free-standing matching must not revive old link labels');
    assert.deepEqual(matching.selectedSong, ['current']);
    assert.deepEqual(matching.explicitLink, ['long', 'manual']);
    assert.deepEqual(matching.permissionFiltered, []);
    assert.equal(matching.largeCount, 60);
    console.log('Matching benchmark (1,916 songs, 300 scores, 60 program entries): ' + matching.matchingMs + 'ms');
    await page.evaluate(() => {
      closeModal('modalSchDetail');
      document.getElementById('pageHome').classList.add('hidden');
      document.getElementById('pageSongs').classList.remove('hidden');
      document.getElementById('songList').innerHTML = '';
      setSongLoadStatus(true);
      initSongs = force => {window.retried = force; setSongLoadStatus(false); return Promise.resolve([]);};
    });
    for (const width of [320, 820]) {
      await page.setViewportSize({width, height: 1000});
      assert.ok(await page.locator('#songLoadStatus').isVisible());
      assert.ok(await page.locator('#songLoadStatus').evaluate(el => el.scrollWidth <= el.clientWidth));
      await page.screenshot({path: path.join(root, `tmp/schedule-score-folders/retry-${width}.png`)});
    }
    await page.locator('#songLoadStatus button').click();
    assert.equal(await page.evaluate(() => window.retried), true);
    assert.equal(await page.locator('#songLoadStatus').isVisible(), false);
    assert.deepEqual(errors, []);
    console.log('PASS schedule singer/orchestra sections, per-song collapsed folders, 36 parts, part opening, access filtering and mobile bounds');
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
