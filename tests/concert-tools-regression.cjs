const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium, webkit } = require('playwright');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/^init\(\);\r?$/m, '').replace(/^initInstallUi\(\);\r?$/m, '');
const setup = () => {
  adminRole = 'admin'; firebaseAuthReady = false; currentActorId = () => 'director'; currentActorName = () => '지휘자';
  ensureScoreRealtimeSync = () => Promise.resolve([]); window.confirm = () => true;
  window.lastToast = ''; showToast = value => { lastToast = value; };
  window.eventRow = { id: 'concert', title: '찬양의밤', date: '2026-09-26', time: '19:00', location: '대강당', useBriefing: true, program: '첫 곡\n둘째 곡\n마지막 곡' };
  allSchedules = [structuredClone(eventRow)];
  window.fixture = { reads: 0, updates: [], offline: false, pending: null };
  db = { collection: () => ({ doc: id => ({ id, get: async () => { fixture.reads++; if (fixture.offline) throw Error('offline'); return { exists: true, id, data: () => structuredClone(eventRow) }; } }) }),
    runTransaction: async fn => fn({ get: async ref => { fixture.reads++; if (fixture.offline) throw Error('offline'); return { exists: true, id: ref.id, data: () => structuredClone(eventRow) }; },
      update: (ref, data) => { fixture.updates.push(structuredClone(data)); Object.assign(eventRow, data); } }) };
  document.getElementById('modalRehearsalCue').classList.add('active'); startRehearsalCue('concert');
};
(async () => {
  const server = http.createServer((req, res) => {
    if (require('./serve-firebase-sdk.cjs')(req, res)) return;
    if (req.url.startsWith('/assets/vendor/qrcode-generator')) { res.setHeader('Content-Type', 'text/javascript'); res.end(fs.readFileSync(path.join(root, 'assets/vendor/qrcode-generator-1.4.4.js'))); return; }
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const engine of [chromium, webkit]) {
      const browser = await engine.launch(engine === chromium ? { channel: 'msedge' } : {});
      try {
        const page = await browser.newPage({ viewport: { width: 820, height: 1180 }, hasTouch: true });
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        await page.route(/firestore\.googleapis\.com|cloudfunctions\.net/, route => route.abort());
        await page.goto('http://127.0.0.1:' + server.address().port); await page.evaluate(setup);
        await page.getByRole('button', { name: '큐 구성', exact: true }).click();
        const durationRows = page.locator('.concert-duration-row');
        for (let i = 0; i < 3; i++) { await durationRows.nth(i).locator('[data-duration-unit=minutes]').fill('4'); await durationRows.nth(i).locator('[data-duration-unit=seconds]').fill('30'); }
        const minutes = durationRows.first().locator('[data-duration-unit=minutes]');
        const seconds = durationRows.first().locator('[data-duration-unit=seconds]');
        assert.equal(await minutes.getAttribute('inputmode'), 'numeric');
        await seconds.fill('60');
        assert.equal(await seconds.evaluate(el => el.validity.valid), false);
        assert.equal(await page.evaluate(() => saveConcertPlan()), false);
        assert.equal(await page.evaluate(() => fixture.updates.length), 0);
        await seconds.fill('30');
        await minutes.fill('');
        assert.equal(await page.evaluate(() => concertCueItems(getRehearsalSchedule(), rehearsalPlanDraft)[0].duration), 30);
        await seconds.fill('');
        assert.equal(await page.evaluate(() => concertCueItems(getRehearsalSchedule(), rehearsalPlanDraft)[0].duration), 0);
        await minutes.fill('240');
        await seconds.fill('1');
        assert.equal(await minutes.evaluate(el => el.validity.valid), false);
        assert.equal(await page.evaluate(() => saveConcertPlan()), false);
        await minutes.fill('4');
        await seconds.fill('30');
        assert.equal(await minutes.evaluate(el => el.validity.valid), true);
        await page.locator('#concertExtraKind').selectOption('transition');
        await page.locator('#concertExtraTitle').fill('남성합창 입장');
        await page.locator('#concertExtraBefore').selectOption({ label: '2. 둘째 곡 앞' });
        await page.locator('#concertExtraNote').fill('사회자 멘트 후 입장');
        await page.getByRole('button', { name: '큐 추가', exact: true }).click();
        assert.equal(await page.locator('.concert-duration-row').count(), 4);
        await durationRows.nth(1).locator('[data-duration-unit=minutes]').fill('1');
        await durationRows.nth(1).locator('[data-duration-unit=seconds]').fill('0');
        await page.getByRole('button', { name: '구성 저장', exact: true }).click();
        await page.waitForFunction(() => !rehearsalPlanBusy && fixture.updates.length === 1);
        assert.equal(await page.evaluate(() => eventRow.program), '첫 곡\n둘째 곡\n마지막 곡');
        assert.deepEqual(await page.evaluate(() => rehearsalItems.map(item => [item.title, item.duration])), [['첫 곡', 270], ['남성합창 입장', 60], ['둘째 곡', 270], ['마지막 곡', 270]]);
        assert.match(await page.locator('#concertTiming').innerText(), /19:15/);
        assert.deepEqual(await page.evaluate(() => {
          rehearsalTimerSeconds = 120;
          const during = concertTimingMarkup(getRehearsalSchedule());
          rehearsalTimerSeconds = 400;
          const overdue = concertTimingMarkup(getRehearsalSchedule());
          toggleRehearsalTimer(); rehearsalTimerStartedAt = Date.now() - 500000;
          pauseRehearsalTimer();
          return [during.includes('예정대로'), overdue.includes('늦음'), rehearsalTimerSeconds];
        }), [true, true, 500], 'timing reported a normal song as late or lost suspended elapsed time');
        await page.evaluate(() => selectRehearsalCue(1));
        assert.equal(await page.locator('#rehearsalMetronome').count(), 0);
        assert.match(await page.locator('.concert-cue-instruction').innerText(), /사회자/);
        await page.evaluate(() => { allSchedules = [scheduleRowFromDoc({ id: eventRow.id, data: () => structuredClone(eventRow) })]; startRehearsalCue('concert'); });
        assert.equal(await page.evaluate(() => rehearsalItems.length), 4, 'persisted plan lost during schedule hydration');
        await page.evaluate(() => { openConcertEditor(); editConcertExtra(0); });
        assert.equal(await durationRows.first().locator('[data-duration-unit=minutes]').inputValue(), '4');
        assert.equal(await durationRows.first().locator('[data-duration-unit=seconds]').inputValue(), '30');
        assert.equal(await durationRows.nth(1).locator('[data-duration-unit=minutes]').inputValue(), '1');
        assert.equal(await durationRows.nth(1).locator('[data-duration-unit=seconds]').inputValue(), '0');
        await page.locator('#concertExtraTitle').fill('무대 전환');
        await page.getByRole('button', { name: '큐 수정', exact: true }).click();
        assert.deepEqual(await page.evaluate(() => [rehearsalPlanDraft.cues.length, concertCueItems(getRehearsalSchedule(), rehearsalPlanDraft)[1].duration]), [1, 60]);
        await page.evaluate(() => { removeConcertExtra(0); });
        assert.equal(await page.evaluate(() => rehearsalPlanDraft.cues.length), 0);
        await page.evaluate(() => cancelConcertEditor());
        assert.equal(await page.evaluate(() => getRehearsalSchedule().rehearsalPlan.cues.length), 1, 'cancel altered persisted cues');
        await page.evaluate(() => { selectRehearsalCue(0); openConcertEditor(); eventRow.rehearsalPlan.startTime = '20:00'; });
        assert.equal(await page.evaluate(() => saveConcertPlan()), false);
        assert.match(await page.locator('#concertEditorStatus').innerText(), /他|다른 사람/);
        assert.equal(await page.evaluate(() => fixture.updates.length), 1, 'conflict overwrote newer plan');
        await page.evaluate(() => { cancelConcertEditor(); adminRole = 'custom'; canUseRehearsalCue = () => true; canEditScheduleItem = () => false; renderRehearsalCue(); });
        assert.equal(await page.getByRole('button', { name: '큐 구성', exact: true }).count(), 0);
        await page.evaluate(() => {
          adminRole = 'admin'; canEditScheduleItem = () => true; canViewPublishedSeating = () => true;
          const songs = seatingProgramItems(eventRow);
          const seat = (id, name) => ({ memberId: id, name, part: 'S1' });
          const plan = (publicId, index, seats) => ({ publicId, sourcePlanId: publicId, name: publicId, title: eventRow.title, date: eventRow.date,
            rows: [{ label: '0단', offset: 0, seats }], orchestraRows: [], specialSlots: {},
            programLink: { scheduleId: eventRow.id, items: [songs[index]] } });
          publishedSeatingPlans = [plan('전체', 0, [seat('move', '김단원'), seat('stay', '이단원'), seat('leave', '박단원')]),
            plan('남성', 1, [seat('enter', '최단원'), seat('stay', '이단원'), seat('move', '김단원')])];
          publishedSeatingPlan = publishedSeatingPlans[0]; publishedSeatingLoaded = true;
          getPublishedSeatingPlan = () => Promise.resolve(publishedSeatingPlan);
          document.getElementById('modalRehearsalCue').classList.remove('active');
          document.getElementById('modalPublicSeating').classList.add('active'); renderPublicSeatingModalBody();
        });
        await page.getByRole('button', { name: /곡 사이 이동/ }).click();
        await page.waitForFunction(() => publicMovementSchedules.has('concert'));
        assert.match(await page.locator('.public-movement-counts').innerText(), /이동 1 · 유지 1 · 입장 1 · 퇴장 1/);
        const reads = await page.evaluate(() => fixture.reads);
        await page.getByRole('button', { name: '다음 배치', exact: true }).click();
        assert.equal(await page.evaluate(() => publishedSeatingPlan.publicId), '남성');
        assert.equal(await page.locator('.public-seating-seat.movement-move').count(), 1);
        assert.equal(await page.evaluate(() => fixture.reads), reads, 'changing movement view fetched backend');
        await page.evaluate(() => { publicSeatingSearch = '이단원'; renderPublicSeatingModalBody(); });
        assert.match(await page.locator('.public-movement-list').innerText(), /이단원.*유지/s);
        for (const width of [320, 390, 820]) {
          await page.setViewportSize({ width, height: 844 });
          assert(await page.locator('.public-movement').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
        }
        await page.setViewportSize({ width: 390, height: 844 });
        fs.mkdirSync(path.join(root, 'tmp/concert-tools'), { recursive: true });
        await page.screenshot({ path: path.join(root, 'tmp/concert-tools', engine.name() + '-movement.png') });
        assert.deepEqual(await page.evaluate(() => {
          const seat = { memberId: 'duplicate', name: '동명이인', part: 'T1' };
          const p = { rows: [{ label: '0단', seats: [seat, seat] }], orchestraRows: [] };
          const duplicate = seatingMovementDiff(p, p)[0].status;
          const steps = seatingProgramSequence(eventRow, publishedSeatingPlans.concat([structuredClone(publishedSeatingPlans[0])]));
          const rows = [{ label: '0단', offset: 0, seats: [seat] }];
          const value = seatingMovementPositions({ rows, centerOffset: 1 }).get('id:duplicate').x - seatingMovementPositions({ rows, centerOffset: 0 }).get('id:duplicate').x;
          return [duplicate, steps[0].status, value];
        }), ['check', 'conflict', -.5]);
        await page.evaluate(() => {
          publicSeatingSearch = ''; document.getElementById('modalPublicSeating').classList.remove('active');
          document.getElementById('modalRehearsalCue').classList.add('active'); startRehearsalCue('concert');
        });
        await page.setViewportSize({ width: 820, height: 1180 });
        const popupPromise = page.waitForEvent('popup'); await page.getByRole('button', { name: '인쇄', exact: true }).click();
        const popup = await popupPromise; await popup.waitForSelector('table');
        assert.equal(await popup.locator('tbody tr').count(), 4);
        assert.equal(await popup.locator('.print-qr svg').count(), 2);
        assert.match(await popup.locator('.print-qr a').first().getAttribute('href'), /seating=/);
        assert.equal(await popup.locator('thead th').count(), 6);
        await popup.emulateMedia({ media: 'print' }); assert.equal(await popup.locator('.print-toolbar').isVisible(), false);
        fs.mkdirSync(path.join(root, 'tmp/concert-tools'), { recursive: true });
        await popup.screenshot({ path: path.join(root, 'tmp/concert-tools', engine.name() + '-print.png'), fullPage: true }); await popup.close();
        await page.locator('#concertPrintMode').selectOption('member');
        const memberPopup = page.waitForEvent('popup'); await page.getByRole('button', { name: '인쇄', exact: true }).click();
        const member = await memberPopup; await member.waitForSelector('table'); assert.equal(await member.locator('thead th').count(), 4); await member.close();
        await page.getByRole('button', { name: '큐 구성', exact: true }).click();
        for (const width of [320, 390, 820]) {
          await page.setViewportSize({ width, height: 844 });
          assert(await page.locator('#concertEditor').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
          await page.locator('#concertEditor').scrollIntoViewIfNeeded();
          await page.screenshot({ path: path.join(root, 'tmp/concert-tools', engine.name() + '-editor-' + width + '.png') });
        }
        assert.deepEqual(await page.evaluate(() => {
          const base = allSchedules[0], plan = normalizeConcertPlan(base.rehearsalPlan);
          const keys = concertSongItems(base).map(item => item.cueKey);
          const old = concertCueItems(base).map(item => item.duration);
          const reordered = concertCueItems({ ...base, program: '둘째 곡\n첫 곡\n마지막 곡' });
          const renamed = concertCueItems({ ...base, program: '둘째 곡 새 이름\n첫 곡\n마지막 곡' });
          return [parseConcertDuration('4:61'), parseConcertDuration('240:01'), reordered[0].kind, reordered[1].title, renamed.some(item => item.kind === 'transition'), concertTimeLabel(1455)];
        }), [null, null, 'transition', '둘째 곡', false, '00:15 (+1일)']);
        assert.deepEqual(await page.evaluate(() => {
          const missing = concertTiming(eventRow, [{ duration: 0 }, { duration: 60 }]);
          return [missing.missing, missing.rows[0].start, missing.rows[1].start];
        }), [1, 1200, null], 'unknown durations produced invented downstream start times');
        await page.evaluate(() => {
          const schedule = structuredClone(eventRow);
          schedule.rehearsalPlan = normalizeConcertPlan(schedule.rehearsalPlan);
          schedule.rehearsalPlan.cues.push({ id: 'same-title', title: '첫 곡', kind: 'speech', before: concertSongItems(schedule)[0].cueKey, note: '' });
          allSchedules = [schedule]; startRehearsalCue(schedule.id); selectRehearsalCue(1);
        });
        assert.equal(await page.evaluate(() => rehearsalMetronomeItemKey()), '["첫 곡",0]', 'non-song cue changed song preset identity');
        await page.evaluate(() => {
          const schedule = allSchedules[0];
          schedule.rehearsalPlan.cues.push({ id: 'intro-video', title: '소개 영상', kind: 'video', before: concertSongItems(schedule)[0].cueKey, note: '' });
          startRehearsalCue(schedule.id); selectRehearsalCue(0);
        });
        assert.equal(await page.locator('.rehearsal-order-row.cue-song').count(), 3);
        for (const [kind, label] of [['speech', '멘트'], ['transition', '전환'], ['video', '영상']]) {
          assert.equal(await page.locator('.rehearsal-order-row.cue-' + kind + ' .rehearsal-order-kind').innerText(), label);
        }
        for (const theme of ['dark', 'light']) {
          await page.evaluate(theme => applyRehearsalTheme(theme), theme);
          for (const width of [320, 820]) {
            await page.setViewportSize({ width, height: 1180 });
            assert(await page.locator('.rehearsal-order').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
            const weights = await page.evaluate(() => ['song', 'video'].map(kind => Number(getComputedStyle(document.querySelector('.cue-' + kind + ' .rehearsal-order-title')).fontWeight)));
            assert(weights[0] > weights[1], 'songs should stand out from production cues');
            await page.locator('.rehearsal-order').scrollIntoViewIfNeeded();
            await page.screenshot({ path: path.join(root, 'tmp/concert-tools', engine.name() + '-order-' + theme + '-' + width + '.png') });
          }
        }
        await page.locator('.rehearsal-order-row.cue-video').click();
        assert.equal(await page.locator('.rehearsal-current-title').innerText(), '소개 영상');
        assert.equal(await page.locator('.rehearsal-order-row.cue-video.on').count(), 1);
        await page.evaluate(() => {
          history.replaceState(null, '', '?seating=' + encodeURIComponent('남성'));
          publicSeatingDeepLinkHandled = false; canViewPublishedSeating = () => false; openSeatingDeepLink();
        });
        assert.equal(await page.evaluate(() => publicSeatingDeepLinkHandled), false, 'QR bypassed member access');
        await page.evaluate(() => { canViewPublishedSeating = () => true; openSeatingDeepLink(); });
        await page.waitForFunction(() => publicSeatingSelectedPlanId === '남성');
        assert.deepEqual(errors, []); console.log(engine.name() + ' PASS cues, timing, shared save, conflicts, permissions, movement, cached reads, QR/print and phone/tablet layout');
      } finally { await browser.close(); }
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
