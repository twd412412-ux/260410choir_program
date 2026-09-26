const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium, webkit } = require('playwright');
const root = path.resolve(__dirname, '..');
const audit = process.env.VIEWPORT_AUDIT === '1';
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
  .replace(/^init\(\);\r?$/m, '').replace(/^initInstallUi\(\);\r?$/m, '');
(async () => {
  const server = http.createServer((req, res) => {
    if (require('./serve-firebase-sdk.cjs')(req, res)) return;
    if (req.url.startsWith('/assets/') && !req.url.includes('..')) {
      const file = path.join(root, decodeURIComponent(req.url));
      if (fs.existsSync(file) && fs.statSync(file).isFile()) { res.end(fs.readFileSync(file)); return; }
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const output = path.join(root, 'tmp', 'mobile-viewport');
  fs.mkdirSync(output, { recursive: true });
  try {
    for (const engine of [chromium, webkit]) {
      const browser = await engine.launch(engine === chromium ? { channel: 'msedge' } : {});
      try {
        for (const [width, height] of [[320, 568], [375, 812], [390, 844], [430, 932], [844, 390], [820, 1180]]) {
        const page = await browser.newPage({ isMobile: true, hasTouch: true, viewport: { width, height } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.route(/firestore\.googleapis\.com|firebasestorage\.googleapis\.com|cloudfunctions\.net/, route => route.abort());
        await page.goto('http://127.0.0.1:' + server.address().port);
        await page.evaluate(() => {
          firebaseAuthReady = false;
          ensureScoreRealtimeSync = () => Promise.resolve([]);
          resumeScoreRealtimeSync = () => {};
          syncPublishedSeatingLive = () => {};
          scheduleProfilePhotoGuide = () => {};
          ensureScheduleRange = async () => allSchedules;
          getPublishedSeatingPlan = async () => null;
          loadScores = async () => allScores;
          canAccessHomeAttendance = () => false;
          canShowHomeEventHub = () => false;
          canUseMemberHandbook = canUseRehearsalCue = canSeeHomePianistAssignments = () => false;
          canViewSongList = canViewScores = canUseGlobalSearch = () => true;
          currentUser = null;
          songsLoaded = scoresLoaded = true;
          const date = getFeaturedSunday(new Date());
          allSongs = [{ id: 'song', songName: '하나님의 사랑은 (The Love of God)', category: '주일찬송', year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() },
            { id: 'long', songName: 'ElShaddai_Choir_Orchestra_Rehearsal_Final', category: '특송', year: 2026, month: 9, day: 27 }];
          filteredSongs = allSongs;
          allScores = [{ id: 'score', title: '하나님의 사랑은 (The Love of God)', scoreKind: 'singer', status: 'published', currentVersion: 2, currentFileName: '하나님의사랑은_최종수정_20260926.pdf', currentFileSize: 102400, updatedAt: '2026-09-26T01:00:00Z' }];
          canViewScoreItem = () => true;
          scoreViewMode = 'singer';
          allSchedules = [{ id: 'schedule', title: '정기 연습 및 찬양의밤 전체 합창', date: getTodayInputDate(), time: '16:00', location: '광주교회 찬양대실' }];
          scheduleLoadedMonths[calYear + '-' + String(calMonth + 1).padStart(2, '0')] = true;
          window.showViewportPage = name => {
            document.querySelectorAll('.modal-overlay.active').forEach(el => el.classList.remove('active'));
            ['pageHome','pageSongs','pageScores','pageFavorites','pageCalendar','pageArchive','pageStats','pageAdmin'].forEach(id => document.getElementById(id).classList.add('hidden'));
            const base = ['login', 'search'].includes(name) ? 'home' : name;
            currentTab = base;
            document.getElementById('page' + base[0].toUpperCase() + base.slice(1)).classList.remove('hidden');
            if (base === 'home') renderHome();
            if (name === 'songs') renderSongList();
            if (name === 'scores') renderScoresPage();
            if (name === 'calendar') renderCal();
            if (name === 'login') openUserModal();
            if (name === 'search') openGlobalSearch();
            syncLayoutState();
          };
        });
          for (const screen of ['home', 'login', 'search', 'songs', 'scores', 'calendar']) {
            await page.evaluate(name => showViewportPage(name), screen);
            await page.waitForTimeout(170);
            const result = await page.evaluate(() => {
              const visible = el => !!el.getClientRects().length;
              const bounds = el => ({ id: el.id, cls: String(el.className), right: Math.round(el.getBoundingClientRect().right) });
              return {
                layoutWidth: innerWidth, scrollWidth: document.documentElement.scrollWidth, scale: visualViewport.scale,
                doubleTapTargets: [...document.querySelectorAll('html,body,body *')]
                  .filter(el => visible(el) && getComputedStyle(el).touchAction === 'auto').slice(0, 10).map(bounds),
                overflow: [...document.querySelectorAll('body *')].filter(el => visible(el) && el.getBoundingClientRect().right > document.documentElement.clientWidth + 1).slice(0, 8).map(bounds),
                smallInputs: [...document.querySelectorAll('input:not([type=hidden]):not([type=range]):not([type=checkbox]):not([type=file]),select,textarea')]
                  .filter(el => visible(el) && parseFloat(getComputedStyle(el).fontSize) < 16).map(el => ({ id: el.id, size: getComputedStyle(el).fontSize }))
              };
            });
            if (audit) { if (result.smallInputs.length || result.scrollWidth > width + 1) console.log(engine.name(), width, screen, JSON.stringify(result)); }
            else {
              assert.ok(result.layoutWidth <= width + 1 && result.scrollWidth <= width + 1, `${engine.name()} ${width} ${screen}: horizontal overflow ${JSON.stringify(result)}`);
              assert.deepEqual(result.smallInputs, [], `${engine.name()} ${width} ${screen}: small focus text`);
              assert.ok(Math.abs(result.scale - 1) < .01, `${screen}: initial scale`);
              assert.deepEqual(result.doubleTapTargets, [], `${engine.name()} ${width} ${screen}: native double-tap zoom still enabled`);
            }
            if (width === 390 && ['home', 'login', 'songs'].includes(screen)) await page.screenshot({ path: path.join(output, engine.name() + '-' + screen + '.png') });
          }
        assert.deepEqual(await page.evaluate(() => {
          function probe(markup, selector) {
            const host = document.createElement('div');
            host.innerHTML = markup;
            document.body.appendChild(host);
            const action = getComputedStyle(host.querySelector(selector)).touchAction;
            host.remove();
            return action;
          }
          return {
          root: getComputedStyle(document.documentElement).touchAction,
          board: getComputedStyle(document.querySelector('.seating-board-scroll')).touchAction,
          publicBoard: probe('<div class="public-seating-board-scroll"></div>', 'div'),
          calendar: getComputedStyle(document.getElementById('calGrid')).touchAction,
          crop: probe('<div class="photo-crop-frame"><canvas></canvas></div>', 'canvas'),
          viewport: document.querySelector('meta[name=viewport]').content
        }; }), {
          root: 'manipulation', board: 'pan-x pan-y', publicBoard: 'none', calendar: 'pan-y', crop: 'none',
          viewport: 'width=device-width,initial-scale=1'
        }, 'custom gestures and manual pinch zoom must remain available');
        await page.evaluate(() => showViewportPage('home'));
        const title = await page.locator('.header-title').boundingBox();
        await page.touchscreen.tap(title.x + title.width / 2, title.y + title.height / 2);
        await page.touchscreen.tap(title.x + title.width / 2, title.y + title.height / 2);
        assert.ok(Math.abs(await page.evaluate(() => visualViewport.scale) - 1) < .01, 'double tap changed page scale');
        assert.deepEqual(errors, []);
        await page.close();
        }
        console.log(engine.name(), 'mobile viewport checks complete');
      } finally { await browser.close(); }
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
