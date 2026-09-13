const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(process.env.SEATING_TEST_HTML || path.join(root, 'index.html'), 'utf8')
  .replace(/^init\(\);\r?$/m, '').replace(/^initInstallUi\(\);\r?$/m, '');
(async () => {
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 820, height: 1180 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.stack));
    await page.route(/firestore\.googleapis\.com|firebasestorage\.googleapis\.com|cloudfunctions\.net/, route => route.abort());
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.evaluate(() => {
      firebaseAuthReady = true; adminRole = 'custom'; currentTab = 'admin'; currentUser = { id: 'editor', name: '편집자', permissions: ['seating.edit'] };
      ensureScoreRealtimeSync = () => Promise.resolve([]); writeLog = () => {}; saveSeatingDraftNow = () => {};
      getPublishedSeatingPlan = () => Promise.resolve(null);
      showToast = message => { window.lastToast = message; }; window.confirm = () => true;
      const sub = document.getElementById('subSeatingPlan'); document.body.appendChild(sub);
      [...document.body.children].forEach(el => { if (el !== sub && el.tagName !== 'SCRIPT' && !el.classList.contains('modal-overlay')) el.style.display = 'none'; });
      sub.style.removeProperty('display'); sub.classList.remove('hidden'); sub.classList.add('seating-fullscreen');
      seatingSettingsOpen = false; seatingMemberPanelCollapsed = true;
      const titles = ['은혜', '어린아이처럼', '여성합창곡', '듀엣곡', '남성합창 첫곡', '남성합창 둘째곡', '솔로곡', '하나님의 사랑은', '은혜'];
      window.eventFixture = { id: 'event-a', date: '2026-10-18', title: '찬양의밤', useBriefing: true,
        program: titles.map((title, i) => (i + 1) + '. ' + title).join('\n'),
        programItems: titles.map((title, i) => ({ title, performanceType: i === 3 ? 'duet' : i === 6 ? 'solo' : i === 1 ? 'ensemble' : 'all' })) };
      window.fixture = { reads: 0, writes: [], fail: false, rows: [eventFixture, { ...eventFixture, id: 'event-b', title: '다른 행사' }] };
      db = { collection: name => {
        const query = { where: () => query, limit: () => query, startAfter: () => query, get: async () => {
          fixture.reads++; if (fixture.fail) throw Error('fixture-offline');
          return { forEach: fn => fixture.rows.forEach(row => fn({ id: row.id, data: () => row })) };
        } }; return query;
      } };
      const rows = createSeatingRows(2, 4);
      seatingMembers = [{ id: 'm1', name: '가단원', part: 'S1' }];
      rows[0].seats[0] = { memberId: 'm1', name: '가단원', part: 'S1', highlight: true, highlightColor: 'blue', locked: false };
      window.basePlan = { id: 'full', name: '전체 합창', date: eventFixture.date, title: '찬양의밤', program: '전체 합창', rows, orchestraRows: [], attendees: { m1: true }, updatedAt: 'v1' };
      const items = seatingProgramItems(eventFixture);
      window.makeLink = indices => ({ scheduleId: eventFixture.id, scheduleTitle: eventFixture.title, scheduleDate: eventFixture.date, items: indices.map(i => items[i]) });
      seatingPlans = [basePlan,
        { ...basePlan, id: 'ensemble', name: '어린아이처럼', programLink: makeLink([1]) },
        { ...basePlan, id: 'female', name: '여성 합창', programLink: makeLink([2]) },
        { ...basePlan, id: 'male', name: '남성 합창', programLink: makeLink([4, 5]) }];
      applySeatingPlan(basePlan);
    });
    await page.evaluate(() => openSeatingProgramPicker());
    await page.waitForFunction(() => seatingProgramLoadedAt > 0 && !seatingProgramLoadPromise, null, { timeout: 12000 }).catch(async error => {
      console.error(await page.evaluate(() => ({ permission: canUseSeatingPlan(), error: seatingProgramLoadError, reads: fixture.reads })), errors);
      throw error;
    });
    const modal = page.locator('#modalSeatingProgram');
    await modal.locator('select').selectOption('event-a');
    const checks = modal.locator('#seatingProgramSongs input');
    assert.equal(await checks.count(), 9);
    assert.equal(await checks.nth(1).isDisabled(), true, 'other plan links must be visible but not claimable');
    assert.equal(await checks.nth(3).isDisabled(), false, 'duet links are optional, not prohibited');
    await checks.nth(0).check(); await checks.nth(7).check(); await checks.nth(8).check();
    assert.equal(await page.evaluate(() => fixture.reads), 1, 'checkbox clicks must not issue database reads');
    assert.equal(await page.evaluate(() => fixture.writes.length), 0);
    await modal.getByRole('button', { name: '적용', exact: true }).click();
    assert.equal(await page.evaluate(() => seatingProgramLink.items.length), 3);
    assert.equal(await page.evaluate(() => seatingDirty), true);
    assert.deepEqual(await page.evaluate(() => seatingProgramSequence(eventFixture, seatingPlans.filter(p => p.id !== 'full').concat([{ ...basePlan, programLink: seatingProgramLink }])).map(s => s.status)),
      ['start', 'change', 'change', 'unlinked', 'change', 'keep', 'unlinked', 'change', 'keep']);
    await page.evaluate(() => undoSeatingChange());
    assert.equal(await page.evaluate(() => seatingProgramLink), null);
    await page.evaluate(() => redoSeatingChange());
    const snapshot = await page.evaluate(() => seatingSnapshot());
    assert.equal(snapshot.programLink.items.length, 3);
    await page.evaluate(snap => applySeatingSnapshot(snap, true), snapshot);
    assert.equal(await page.evaluate(() => seatingProgramLink.items.length), 3);
    await page.evaluate(async () => {
      saveSeatingPlanRecord = async data => { fixture.writes.push(JSON.parse(JSON.stringify(data))); return 'doc'; };
      syncPublishedSeatingPlanAfterSave = async (data, previous, publicData) => { fixture.publicData = publicData; return false; };
      await saveSeatingPlan();
    });
    await page.waitForFunction(() => !seatingSaveBusy && fixture.writes.length === 1);
    assert.equal(await page.evaluate(() => fixture.writes[0].programLink.items.length), 3);
    assert.equal(await page.evaluate(() => fixture.publicData.programLink.items.length), 3);
    await page.evaluate(() => applySeatingPlan(fixture.writes[0]));
    assert.equal(await page.evaluate(() => seatingProgramLink.items.length), 3);
    await page.evaluate(() => openSeatingProgramPicker());
    await checks.nth(7).uncheck();
    await modal.getByRole('button', { name: '취소', exact: true }).click();
    assert.equal(await page.evaluate(() => seatingProgramLink.items.length), 3, 'cancel must not mutate plan');
    assert.equal(await page.evaluate(() => fixture.reads), 1, 'reopening must reuse the bounded cache');
    const domain = await page.evaluate(() => {
      const link = seatingProgramLink, plan = { ...basePlan, programLink: link };
      const reorder = { ...eventFixture, program: '1. 추가 곡\n2. 하나님의 사랑은\n3. 은혜\n4. 은혜' };
      const reordered = seatingProgramSequence(reorder, [plan]);
      const other = seatingProgramSequence({ ...eventFixture, id: 'event-b' }, [plan]);
      const duplicate = seatingProgramSequence(eventFixture, [plan, { ...plan, id: 'copy' }]);
      const renamed = seatingProgramSequence({ ...eventFixture, program: '1. 전혀 다른 곡' }, [plan]);
      return { reordered: reordered.map(s => s.status), other: other.every(s => s.status === 'unlinked'),
        duplicate: duplicate[0].status, renamed: renamed[0].status,
        uniqueKeys: new Set(seatingProgramItems(eventFixture).map(s => s.key)).size };
    });
    assert.deepEqual(domain, { reordered: ['unlinked', 'start', 'keep', 'keep'], other: true, duplicate: 'conflict', renamed: 'unlinked', uniqueKeys: 9 });
    await page.evaluate(() => { openSeatingProgramPicker(); });
    const out = path.join(root, 'tmp/seating-program'); fs.mkdirSync(out, { recursive: true });
    for (const [width, height] of [[820, 1180], [390, 844], [844, 390]]) {
      await page.setViewportSize({ width, height });
      await modal.locator('summary').click();
      const content = await modal.locator('.modal-content').boundingBox(), apply = await modal.locator('#seatingProgramApply').boundingBox();
      assert.ok(content.x >= 0 && content.y >= 0 && content.x + content.width <= width + 1 && content.y + content.height <= height + 1);
      assert.ok(apply.y >= 0 && apply.y + apply.height <= height);
      assert.equal(await modal.locator('.modal-content').evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
      await page.screenshot({ path: path.join(out, width + '.png') });
    }
    await page.evaluate(() => { fixture.rows[0] = { ...eventFixture, program: '1. 새 곡' }; allSchedules = []; fixture.fail = true; });
    await modal.locator('#seatingProgramRefresh').click();
    await page.waitForFunction(() => !seatingProgramLoadPromise && seatingProgramLoadError);
    assert.equal(await modal.locator('#seatingProgramApply').isDisabled(), true);
    await page.evaluate(() => { fixture.fail = false; });
    await modal.locator('#seatingProgramRefresh').click();
    await page.waitForFunction(() => !seatingProgramLoadPromise && !seatingProgramLoadError);
    assert.ok((await modal.locator('#seatingProgramSongs').textContent()).includes('현재 순서에 없음'));
    await modal.locator('#seatingProgramApply').click();
    assert.equal(await modal.isVisible(), true, 'stale song links must not silently retarget');
    await page.evaluate(async () => {
      closeModal('modalSeatingProgram');
      await saveSeatingPlan({ forceNew: true, nameOverride: '복사본' });
      if (fixture.writes[1].programLink !== null || seatingProgramLink !== null) throw Error('copy claimed existing song links');
      applySeatingPlan(fixture.writes[0]);
      fixture.rows = []; allSchedules = [eventFixture];
      await loadSeatingProgramSchedules(true, false);
      if (seatingProgramCandidates().length) throw Error('deleted event retained through stale calendar cache');
    });
    await page.evaluate(() => {
      const before = JSON.stringify(seatingProgramLink);
      currentUser.permissions = ['seating.manage'];
      changeSeatingProgramEvent('event-b'); toggleSeatingProgramSong(0, true); applySeatingProgramSelection();
      if (JSON.stringify(seatingProgramLink) !== before) throw Error('view-only permission changed links');
      currentUser.permissions = ['seating.edit'];
      closeModal('modalSeatingProgram'); createNewSeatingPlan(true, true);
      if (seatingProgramLink) throw Error('new plan inherited old song links');
    });
    assert.deepEqual(errors, []);
    console.log('PASS: multi-song linking, program order, repeated titles, same-plan continuity, unlinked skips, conflict detection, rename safety, cancellation, undo, save/reload/publication, permission checks, cached reads, retry and responsive modal');
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
