const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const output = path.join(__dirname, 'site');
const source = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const fixtureSource = source.replace(/^init\(\);\r?$/m, '').replace(/^initInstallUi\(\);\r?$/m, '');

async function build() {
  const server = http.createServer((req, res) => {
    if (require('../tests/serve-firebase-sdk.cjs')(req, res)) return;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(fixtureSource);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'msedge' });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Seoul' });
    await page.clock.setFixedTime(new Date('2026-09-26T15:00:00+09:00'));
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const snapshot = await page.evaluate(async () => {
      firebaseAuthReady = false;
      ensureScoreRealtimeSync = async () => [];
      resumeScoreRealtimeSync = syncPublishedSeatingLive = scheduleProfilePhotoGuide = openSeatingDeepLink = () => {};
      canViewSongList = canViewScores = canUseGlobalSearch = canShowHomeEventHub = canViewPublishedSeating = () => true;
      canAccessHomeAttendance = canUseMemberHandbook = canUseRehearsalCue = canSeeHomePianistAssignments = () => false;
      canViewScoreItem = () => true;
      currentUser = null;
      currentTab = 'home';
      songsLoaded = scoresLoaded = schedulesLoaded = publishedSeatingLoaded = homeEventSchedulesLoaded = true;
      const titles = ['하나님의 사랑은', '엘샤다이(El Shaddai)', '내 주는 강한 성이요'];
      allSongs = titles.map((songName, index) => ({ id: 'demo-song-' + index, songName, category: '주일찬송', year: 2026, month: index === 2 ? 10 : 9, day: [20, 27, 4][index] }));
      filteredSongs = allSongs;
      allScores = titles.map((title, index) => ({ id: 'demo-score-' + index, title, scoreKind: 'singer', status: 'published', currentVersion: index === 0 ? 2 : 1, currentFileName: title + '.pdf', currentFileSize: 180000, updatedAt: '2026-09-25T03:00:00Z' }));
      findVisibleScoresForSong = song => allScores.filter(score => score.title === song.songName);
      scheduleMatchedScoreRows = () => allScores.map(score => ({ score }));
      const event = { id: 'demo-event', title: '찬양의밤', date: '2026-10-11', endDate: '2026-10-11', time: '19:30', location: '광주교회', useBriefing: true, showEventHub: true, program: '내 주는 강한 성이요\n주의 손에 나의 손을 포개고\n어린아이처럼\n일어나 걸어라\n주의 용사\n하나님의 사랑은\n엘샤다이(El Shaddai)' };
      homeEventSchedules = [event];
      allSchedules = [{ id: 'demo-practice', title: '찬양의밤 전체 연습', date: '2026-09-26', time: '16:00', location: '찬양대실' }];
      publishedSeatingPlans = ['전체', '여성합창', '남성합창', '어린아이처럼'].map((name, index) => ({ publicId: 'demo-plan-' + index, name: '찬양의밤_' + name, publishedAt: '2026-09-25T07:30:00Z' }));
      publishedSeatingPlan = publishedSeatingPlans[0];
      ensureScheduleRange = async () => allSchedules;
      getPublishedSeatingPlan = async () => publishedSeatingPlan;
      loadHomeEventSchedules = async () => homeEventSchedules;
      loadScores = async () => allScores;
      rehearsalItemsFromSchedule = schedule => schedule.program.split('\n').map((title, i) => ({ title, performanceType: i === 2 ? 'ensemble' : 'all' }));
      renderHome();
      await new Promise(resolve => setTimeout(resolve, 250));
      document.querySelectorAll('[data-app-release-version]').forEach(el => el.textContent = APP_RELEASE_VERSION);
      document.querySelectorAll('[data-app-update-label]').forEach(el => el.textContent = '앱 업데이트');
      document.getElementById('homeGlobalSearch').classList.remove('hidden');
      document.getElementById('notificationBellBtn').classList.remove('hidden');
      ['navArchive', 'navScores'].forEach(id => document.getElementById(id).classList.remove('hidden'));
      document.getElementById('homeInstallBtn').classList.add('hidden');
      const home = document.getElementById('pageHome').cloneNode(true);
      const header = document.querySelector('.header').cloneNode(true);
      const nav = document.querySelector('.bottom-nav').cloneNode(true);
      function clean(host) {
        host.querySelectorAll('[onclick]').forEach(el => {
          const raw = el.getAttribute('onclick');
          const action = raw.replace('event.stopPropagation();', '').match(/^(\w+)\((.*)\)$/);
          el.removeAttribute('onclick');
          if (action) { el.dataset.previewAction = action[1]; el.dataset.previewArg = action[2].match(/^'([^']*)'/)?.[1] || ''; }
          if (el.tagName !== 'BUTTON') { el.setAttribute('role', 'button'); el.setAttribute('tabindex', '0'); }
        });
        return host.outerHTML;
      }
      const eventInfo = document.createElement('div');
      eventInfo.innerHTML = renderHomeEventInfo(event);
      const eventProgram = document.createElement('div');
      eventProgram.innerHTML = renderHomeEventProgram(event);
      clean(eventInfo); clean(eventProgram);
      return { header: clean(header), home: clean(home), nav: clean(nav), eventInfo: eventInfo.innerHTML, eventProgram: eventProgram.innerHTML, titles };
    });
    fs.mkdirSync(output, { recursive: true });
    fs.mkdirSync(path.join(output, 'assets'), { recursive: true });
    fs.copyFileSync(path.join(root, 'assets/hymn-dove-book.png'), path.join(output, 'assets/hymn-dove-book.png'));
    // Only the real head stylesheet, not printable HTML templates inside app JS.
    const styles = source.match(/<style>([\s\S]*?)<\/style>/)[1];
    fs.writeFileSync(path.join(output, 'original.css'), styles);
    fs.writeFileSync(path.join(output, 'snapshot.json'), JSON.stringify(snapshot));
    fs.writeFileSync(path.join(output, '.nojekyll'), '');
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    fs.writeFileSync(path.join(output, 'index.html'), `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; frame-src 'none'; worker-src 'none'; object-src 'none'; form-action 'none'; base-uri 'self'">
<meta name="preview-source-commit" content="${sha}"><title>광주교회 찬양대 · 홈 디자인 비교</title>
<link rel="icon" href="assets/hymn-dove-book.png"><link rel="stylesheet" href="original.css"><link rel="stylesheet" href="preview.css"></head>
<body class="refined"><div class="preview-toolbar"><span class="preview-label">홈 디자인 비교 <small>샘플 데이터</small></span><div class="preview-modes" role="group" aria-label="디자인 선택"><button type="button" data-mode="original" aria-pressed="false">기존</button><button type="button" data-mode="refined" aria-pressed="true">개선안</button></div></div>
${snapshot.header}<main>${snapshot.home}</main>${snapshot.nav}
<dialog id="previewDialog" aria-labelledby="dialogTitle"><div class="preview-dialog-head"><h2 id="dialogTitle"></h2><button type="button" class="dialog-close" aria-label="닫기"><i data-lucide="x"></i></button></div><div id="dialogContent"></div></dialog>
<script src="assets/lucide.min.js"></script><script src="preview.js"></script></body></html>`);
    fs.copyFileSync(path.join(__dirname, 'preview.css'), path.join(output, 'preview.css'));
    fs.copyFileSync(path.join(__dirname, 'preview.js'), path.join(output, 'preview.js'));
    console.log('Built isolated home snapshot from ' + sha);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
build().catch(error => { console.error(error); process.exitCode = 1; });
