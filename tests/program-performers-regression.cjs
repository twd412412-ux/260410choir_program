const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium, webkit } = require('playwright');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/^init\(\);\r?$/m, '').replace(/^initInstallUi\(\);\r?$/m, '');
const setup = () => {
  adminRole = 'admin'; currentTab = 'admin'; currentActorId = () => 'editor'; currentActorName = () => '관리자';
  firebaseAuthReady = false; ensureScoreRealtimeSync = () => Promise.resolve([]); requestHomeRender = () => {}; loadSchAdmin = () => {}; writeLog = () => {};
  showToast = text => { window.lastToast = text; };
  window.roster = [
    { id: 'a', name: '김동명', part: 'S1', status: 'active' },
    { id: 'b', name: '김동명', part: 'T1', status: 'active' },
    { id: 'c', name: '이다원', part: 'S2', status: 'active' },
    { id: 'd', name: '최중창', part: 'T2', status: 'active' },
    { id: 'r', name: '박관현', part: '관현악', status: 'active' },
    { id: 'i', name: '윤연주', part: '관현악', status: 'active' },
    { id: 'p', name: '정반주', part: 'S1', status: 'active' }
  ];
  window.fixture = { directoryReads: 0, writes: [], failDirectory: false };
  window.serverSchedule = { id: 'concert', title: '찬양의밤', date: '2026-10-18', useBriefing: true,
    program: '전체곡\n듀엣곡\n소중창곡\n마지막전체', programItems: [
      { title: '전체곡', performanceType: 'all' }, { title: '듀엣곡', performanceType: 'duet' },
      { title: '소중창곡', performanceType: 'small' }, { title: '마지막전체', performanceType: 'all' }
    ] };
  allSchedules = [structuredClone(serverSchedule)];
  db = { collection: name => ({ doc: id => ({
    get: async () => {
      if (name === 'settings') { fixture.directoryReads++; if (fixture.failDirectory) throw Error('offline'); return { exists: true, id, data: () => ({ complete: true, version: 2, members: roster }) }; }
      return { exists: true, id, data: () => structuredClone(serverSchedule) };
    }, update: async data => { fixture.writes.push(structuredClone(data)); Object.assign(serverSchedule, data); }
  }) }) };
  const sub = document.getElementById('subSchedule'); document.body.appendChild(sub); sub.classList.remove('hidden'); sub.style.display = 'block';
  [...document.body.children].forEach(el => { if (el !== sub && el.tagName !== 'SCRIPT' && !el.classList.contains('modal-overlay')) el.style.display = 'none'; });
  sub.style.padding = '16px'; editSchedule('concert', { scroll: false });
};
(async () => {
  const server = http.createServer((req, res) => {
    if (require('./serve-firebase-sdk.cjs')(req, res)) return;
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
        assert.equal(await page.evaluate(() => fixture.directoryReads), 0, 'editor loaded roster before selection');
        assert.equal(await page.locator('.program-performers').count(), 2);
        await page.locator('.schedule-program-type-row').nth(1).locator('summary').click();
        await page.waitForFunction(() => programPerformerDirectory && programPerformerDirectory.length === 7);
        await page.locator('.schedule-program-type-row').nth(1).locator('input[type=search]').fill('김동명');
        assert.equal(await page.locator('#programPerformers1 label').count(), 2, 'homonyms collapsed');
        await page.locator('#programPerformers1 label').filter({ hasText: 'S1' }).locator('input').check();
        await page.locator('.schedule-program-type-row').nth(1).locator('input[type=search]').fill('박관현');
        await page.locator('#programPerformers1 input[type=checkbox]').check();
        await page.locator('.schedule-program-type-row').nth(1).locator('input[type=search]').fill('정반주');
        await page.locator('#programPerformers1').getByRole('button', { name: '반주', exact: true }).click();
        assert.equal(await page.evaluate(() => scheduleProgramTypeDraft[1].performers.length), 2, 'pianist counted as singer');
        await page.locator('.schedule-program-type-row').nth(2).locator('summary').click();
        for (const id of ['b', 'r', 'd']) await page.evaluate(id => selectProgramPerformer(2, id, true), id);
        assert.equal(await page.evaluate(() => fixture.directoryReads), 1, 'selections or search reread roster');
        assert.match(await page.locator('.schedule-program-type-row').nth(2).innerText(), /3명/);
        fs.mkdirSync(path.join(root, 'tmp/program-performers'), { recursive: true });
        for (const width of [320, 390, 820]) {
          await page.setViewportSize({ width, height: 844 });
          assert(await page.locator('#schProgramTypeEditor').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
          await page.locator('.schedule-program-type-row').nth(1).scrollIntoViewIfNeeded();
          await page.screenshot({ path: path.join(root, 'tmp/program-performers', engine.name() + '-editor-' + width + '.png') });
        }
        await page.evaluate(() => addSchedule());
        await page.waitForFunction(() => fixture.writes.length === 1 && !registrationBusy.schedule);
        assert.deepEqual(await page.evaluate(() => serverSchedule.programItems[1].performers.map(ref => ref.memberId)), ['a', 'r']);
        assert.equal(await page.evaluate(() => serverSchedule.programItems[1].accompanist.memberId), 'p');
        assert.equal(await page.evaluate(() => scheduleRowFromDoc({ id: serverSchedule.id, data: () => serverSchedule }).programItems[2].performers.length), 3, 'hydration dropped roster');
        await page.evaluate(() => {
          document.getElementById('subSchedule').style.display = 'none';
          const seat = id => { const member = roster.find(row => row.id === id); return { memberId: member.id, name: member.name, part: member.part }; };
          const items = seatingProgramItems(serverSchedule);
          const base = { publicId: 'whole', sourcePlanId: 'whole', name: '전체', rows: [{ label: '0단', seats: ['a', 'b', 'c', 'r'].map(seat) }],
            orchestraRows: [{ label: '관현악', seats: [seat('i')] }], specialSlots: { accompanist: seat('p') },
            programLink: { scheduleId: serverSchedule.id, items: [items[0], items[3]] } };
          publishedSeatingPlans = [base]; publishedSeatingPlan = base; publishedSeatingLoaded = true;
          getPublishedSeatingPlan = () => Promise.resolve(base); canViewPublishedSeating = () => true;
          document.getElementById('modalPublicSeating').classList.add('active'); publicMovementOpen = true;
          publicMovementSchedules.set(serverSchedule.id, structuredClone(serverSchedule)); publicMovementKey = items[0].key; renderPublicSeatingModalBody();
        });
        assert.deepEqual(await page.evaluate(() => Object.fromEntries(publicMovementPair().changes.map(row => [row.key, row.status]))),
          { 'id:a': 'move', 'id:b': 'leave', 'id:c': 'leave', 'id:r': 'move', 'id:i': 'stay', 'id:p': 'stay' });
        await page.getByRole('button', { name: '다음 출연', exact: true }).click();
        assert.equal(await page.locator('#publicSeatingBoard').count(), 0, 'duet rendered a fabricated seating chart');
        assert.match(await page.locator('.public-movement-front').innerText(), /김동명.*박관현/s);
        await page.evaluate(() => selectPublicMovement(seatingProgramItems(serverSchedule)[1].key));
        assert.deepEqual(await page.evaluate(() => Object.fromEntries(publicMovementPair().changes.map(row => [row.key, row.status]))),
          { 'id:i': 'stay', 'id:p': 'stay', 'id:a': 'leave', 'id:r': 'stay', 'id:b': 'enter', 'id:d': 'enter' });
        await page.evaluate(() => selectPublicMovement(seatingProgramItems(serverSchedule)[2].key));
        assert.equal(await page.evaluate(() => publicMovementPair().changes.find(row => row.key === 'id:r').status), 'move');
        await page.getByRole('button', { name: '다음 배치', exact: true }).click(); assert.equal(await page.locator('#publicSeatingBoard').count(), 1);
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({ path: path.join(root, 'tmp/program-performers', engine.name() + '-movement.png') });
        assert.deepEqual(await page.evaluate(() => {
          const items = serverSchedule.programItems;
          const reordered = rehearsalItemsFromSchedule({ ...serverSchedule, program: '소중창곡\n전체곡\n듀엣곡\n마지막전체' });
          const renamed = rehearsalItemsFromSchedule({ ...serverSchedule, program: '전체곡\n새 듀엣\n소중창곡\n마지막전체' });
          const missing = programMovementState({ item: { performanceType: 'duet' } });
          const empty = programMovementState({ item: { performanceType: 'duet', performersConfigured: true, performers: [] } });
          return [reordered[0].performers.length, reordered[2].performers.length, !!renamed[1].performersConfigured, !!missing.error, !!empty.error,
            programPerformerWarning({ performanceType: 'duet', performersConfigured: true, performers: [items[1].performers[0]] }).includes('확인')];
        }), [3, 2, false, true, true, true]);
        await page.evaluate(() => {
          document.getElementById('modalPublicSeating').classList.remove('active');
          allSchedules = [structuredClone(serverSchedule)]; document.getElementById('modalRehearsalCue').classList.add('active'); startRehearsalCue('concert'); selectRehearsalCue(1);
        });
        assert.match(await page.locator('.rehearsal-context').innerText(), /김동명.*박관현.*반주 정반주/s);
        assert.match(await page.evaluate(() => concertPrintMarkup(serverSchedule, 'member', null)), /앞쪽 출연.*|김동명/);
        assert.deepEqual(errors, []); console.log(engine.name() + ' PASS roster picker, orchestra singers, homonyms, pianist separation, save/hydration, no-selection safety, reorder/rename, small-group stage transitions and phone/tablet UI');
      } finally { await browser.close(); }
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
