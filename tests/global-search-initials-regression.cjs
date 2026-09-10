const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { performance } = require('node:perf_hooks');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const ctx = vm.createContext({ getTodayInputDate: () => '2026-09-10' });
for (const name of ['globalSearchText', 'globalSearchCompact', 'globalSearchInitialPattern', 'prepareGlobalSearchQuery', 'globalSearchTimestamp', 'globalSearchItem', 'globalSearchMatch', 'globalSearchRank', 'sortGlobalSearchRows']) {
  const fn = source.match(new RegExp('^function ' + name + '\\([^]*?^}', 'm'));
  assert.ok(fn, name);
  vm.runInContext(fn[0], ctx);
}
const item = (title, extra = '', id = title, date = 0) => ctx.globalSearchItem('song', id, title, '', title + ' ' + extra, date);
const matches = (title, query, extra) => ctx.globalSearchMatch(item(title, extra), query);
for (const [title, query, expected] of [
  ['엘샤다이', 'ㅇㅅㄷㅇ', true], ['엘 샤다이', 'ㅇㅅㄷㅇ', true],
  ['엘샤다이', '엘ㅅㄷㅇ', true], ['하나님의 사랑은', 'ㅎㄴㄴㅇ ㅅㄹㅇ', true],
  ['찬양의 밤', 'ㅊㅇㅇㅂ', true], ['김하늘', 'ㄱㅎㄴ', true],
  ['엘샤다이', '\u110b\u1109\u1103\u110b', true],
  ['엘샤다이'.normalize('NFD'), 'ㅇㅅㄷㅇ', true],
  ['엘샤다이', '엘샤다이'.normalize('NFD'), true],
  ['기쁨', '\uffa1', true], ['꺼내다', 'ㄲㄴㄷ', true], ['꺼내다', 'ㄱㄴㄷ', false],
  ['허나', '하ㄴ', false], ['하늘', 'ㅏ', false], ['엘샤다이', 'ㅇㅅㄷㅇㄴ', false],
  ['EL SHADDAI (2026)', 'el shaddai 2026', true], ['모든 것 주셨네', '모든것주셨네', true],
  ['주(하나님)+ [찬양]?', 'ㅈ(ㅎㄴㄴ)+ [ㅊㅇ]?', true],
  ['주님', '^ㅈ.*$', false], ['주님', 'ㅈ|하', false], ['주님', 'ㅈ\\', false],
  ['주님', '.*', false], ['주님', '  ', true]
]) assert.equal(matches(title, query), expected, `${title} / ${query}`);
assert.equal(matches('엘샤다이', 'ㅇㅅㄷㅇ ㅈㅇㅊㅅ', '주일찬송'), true);
assert.equal(matches('엘샤다이', 'ㅇㅅㄷㅇ ㅂㅅㅎ', '주일찬송'), false);
const initials = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
Array.from(initials).forEach((initial, index) => {
  const first = 0xac00 + index * 588;
  assert.equal(matches(String.fromCharCode(first), initial), true);
  assert.equal(matches(String.fromCharCode(first + 587), initial), true);
  if (index < 18) assert.equal(matches(String.fromCharCode(first + 588), initial), false);
});
const ranking = [item('다른 곡', '찬양의 밤', 'metadata', 999), item('우리 찬양의 밤', '', 'contains', 300), item('찬양의 밤 연습', '', 'prefix', 200), item('찬양의 밤', '', 'exact', 100)];
assert.deepEqual(Array.from(ctx.sortGlobalSearchRows(ranking, 'ㅊㅇㅇㅂ', 'song'), row => row.id), ['exact', 'prefix', 'contains', 'metadata']);
assert.deepEqual(Array.from(ctx.sortGlobalSearchRows(ranking, '찬양의 밤', 'song'), row => row.id), ['exact', 'prefix', 'contains', 'metadata']);
const schedules = ['2026-09-20', '2026-09-01', '2026-09-12'].map(date => item(date, '', date, Date.parse(date)));
assert.deepEqual(Array.from(ctx.sortGlobalSearchRows(schedules, '', 'schedule'), row => row.id), ['2026-09-12', '2026-09-20', '2026-09-01']);
assert.equal(ctx.prepareGlobalSearchQuery('el shaddai').initialPattern, null, 'ordinary search should not compile patterns');
const prepared = ctx.prepareGlobalSearchQuery('ㅎㄴㄴ 2026');
assert.equal(ctx.prepareGlobalSearchQuery(prepared), prepared, 'compiled query should be reused');
const many = Array.from({ length: 5000 }, (_, i) => item(i % 2 ? '하나님의 사랑은' : '모든 것 주셨네', '주일찬송 김하늘 2026', String(i), i));
const started = performance.now();
const found = ctx.sortGlobalSearchRows(many.filter(row => ctx.globalSearchMatch(row, prepared)), prepared, 'song');
assert.equal(found.length, 2500);
console.log(`PASS initials, mixed syllables, Unicode, all 19 consonants, literal punctuation, token matching, ranking; 5,000 rows: ${Math.round(performance.now() - started)}ms`);

(async () => {
  const html = source.replace(/^init\(\);\r?$/m, '').replace(/^initInstallUi\(\);\r?$/m, '');
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
    const errors = [], requests = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route(/firestore\.googleapis\.com|firebasestorage\.googleapis\.com|cloudfunctions\.net/, route => { requests.push(route.request().url()); return route.abort(); });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(() => {
      canUseGlobalSearch = canViewSongList = canViewScores = hasArchiveView = () => true;
      window.memberAccess = false;
      canUseMemberHandbook = () => window.memberAccess;
      canViewScoreItem = score => score.public && score.scoreKind === 'singer';
      ensureScoreRealtimeSync = () => Promise.resolve([]);
      songsLoaded = scoresLoaded = true;
      scheduleLoadedMonths[scheduleMonthKey(getTodayInputDate())] = true;
      db = { collection() { throw Error('Search must not request additional data'); } };
      allSongs = [
        { id: 'song-el', songName: '엘샤다이 (El Shaddai)', category: '주일찬송', members: '김하늘', year: 2026, month: 9, day: 27 },
        { id: 'song-bless', songName: '축복하노라', year: 2026, month: 9, day: 13 }
      ];
      allScores = [
        { id: 'score-el', title: '엘샤다이', public: true, scoreKind: 'singer', currentFileName: '엘샤다이_합창보.pdf', currentUploadedAt: '2026-09-10T00:00:00Z' },
        { id: 'score-private', title: '엘샤다이 비공개', public: false, scoreKind: 'singer' },
        { id: 'score-orchestra', title: '엘샤다이 관현악', public: true, scoreKind: 'orchestra' }
      ];
      allSchedules = [{ id: 'night', title: '찬양의 밤', date: '2026-09-20', location: '교육원' }];
      archiveItems = [];
      globalSearchArchiveRows = [{ id: 'photo-night', title: '찬양의 밤 사진', date: '2026-09-01', url: 'fixture-photo' }];
      globalSearchMemberRows = [{ id: 'member-sky', name: '김하늘', part: 'S1' }];
      window.originalRows = JSON.stringify([allSongs, allScores, allSchedules, globalSearchArchiveRows, globalSearchMemberRows]);
      const originalRender = renderGlobalSearch;
      renderGlobalSearch = function() { originalRender(); window.renderedQuery = document.getElementById('globalSearchInput').value; };
      openSchDetail = id => { window.openedSchedule = id; };
      openGlobalSearch();
    });
    const search = async query => {
      await page.locator('#globalSearchInput').fill(query);
      await page.waitForFunction(value => window.renderedQuery === value, query);
    };
    const ids = () => page.locator('#globalSearchResults [data-global-id]').evaluateAll(els => els.map(el => el.dataset.globalId));
    await search('ㅇㅅㄷㅇ');
    assert.deepEqual(await ids(), ['song-el', 'score-el']);
    await search('엘ㅅㄷㅇ');
    assert.deepEqual(await ids(), ['song-el', 'score-el']);
    await search('ㅊㅇㅇㅂ');
    assert.deepEqual(await ids(), ['night', 'photo-night']);
    await search('ㄱㅎㄴ');
    assert.deepEqual(await ids(), ['song-el'], 'member permissions must be unchanged');
    assert.equal(await page.locator('#globalSearchMemberTab').isVisible(), false);
    await page.evaluate(() => { window.memberAccess = true; renderGlobalSearch(); });
    await page.locator('#globalSearchMemberTab').click();
    assert.deepEqual(await ids(), ['member-sky']);
    await page.locator('[data-search-tab="archive"]').click();
    await search('ㅊㅇㅇㅂ');
    assert.deepEqual(await ids(), ['photo-night']);
    await page.locator('[data-search-tab="score"]').click();
    await search('ㅎㅊㅂ');
    assert.deepEqual(await ids(), ['score-el'], 'file names support initials');
    await page.locator('[data-search-tab="song"]').click();
    await search('EL SHADDAI');
    assert.deepEqual(await ids(), ['song-el']);
    await search('ㅇㅅㄷㅇ ㅈㅇㅊㅅ');
    assert.deepEqual(await ids(), ['song-el']);
    await search('ㅃㅃㅃㅃ');
    assert.deepEqual(await ids(), []);
    await search('');
    assert.equal((await ids()).length, 2);
    const output = path.join(root, 'tmp/global-search-initials');
    fs.mkdirSync(output, { recursive: true });
    await page.locator('[data-search-tab="all"]').click();
    await search('ㅇㅅㄷㅇ');
    for (const width of [390, 820]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.ok(await page.locator('#modalGlobalSearch .modal-content').evaluate(el => el.scrollWidth <= el.clientWidth));
      await page.screenshot({ path: path.join(output, `search-${width}.png`) });
    }
    await search('ㅊㅇㅇㅂ');
    await page.locator('[data-search-tab="schedule"]').click();
    await page.locator('#globalSearchInput').press('Enter');
    assert.equal(await page.evaluate(() => window.openedSchedule), 'night');
    assert.equal(await page.locator('#modalGlobalSearch').isVisible(), false);
    assert.equal(await page.evaluate(() => JSON.stringify([allSongs, allScores, allSchedules, globalSearchArchiveRows, globalSearchMemberRows]) === window.originalRows), true);
    assert.deepEqual(requests, [], 'no additional backend reads');
    assert.deepEqual(errors, [], 'browser errors');
    console.log('PASS all five search types, permissions, input debounce, result opening, mobile/tablet rendering, no data mutation or backend reads');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
