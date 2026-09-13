const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(process.env.SEATING_TEST_HTML || path.join(root, 'index.html'), 'utf8')
  .replace(/^init\(\);\r?$/m, '').replace(/^initInstallUi\(\);\r?$/m, '');
(async () => {
  const server = http.createServer((req, res) => { if (require('./serve-firebase-sdk.cjs')(req, res)) return; res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 820, height: 1180 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route(/firestore\.googleapis\.com|firebasestorage\.googleapis\.com|cloudfunctions\.net/, route => route.abort());
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.evaluate(async () => {
      firebaseAuthReady = true; adminRole = 'custom'; currentTab = 'admin';
      currentUser = { id: 'viewer', name: '조회자', permissions: ['seating.manage', 'attendance.check'] };
      ensureScoreRealtimeSync = () => Promise.resolve([]); writeLog = () => {};
      const clone = value => JSON.parse(JSON.stringify(value));
      const members = [{ id: 'a', name: '가단원', part: 'S1' }, { id: 'b', name: '나단원', part: 'T1' }];
      const plan = { id: 'draft-a', name: '미공개 합창', folder: '행사', date: '2026-09-13', program: '합창', updatedAt: 'v1',
        attendees: { a: true, b: true }, rows: [{ label: '1단', seats: [{ memberId: 'a', name: '가단원', part: 'S1' }, null] }, { label: '0단', seats: [null, null] }],
        orchestraRows: [{ label: '0단', seats: [null, null] }], micSlots: [false, true], centerOffset: 1 };
      window.fixture = { reads: 0, writes: 0, plans: [plan, { ...clone(plan), id: 'draft-b', name: '다른 배치', folder: '연습' }] };
      db = {
        collection: collection => {
          const query = { orderBy: () => query, limit: () => query, get: async () => { fixture.reads++; return { forEach: fn => fixture.plans.forEach(p => fn({ id: p.id, data: () => clone(p) })) }; } };
          query.doc = id => ({ get: async () => {
            fixture.reads++;
            const data = id === 'seatingMemberDirectory' ? { version: 2, complete: true, members } : { plans: [] };
            return { exists: true, data: () => clone(data) };
          } });
          return query;
        },
        runTransaction: async () => { fixture.writes++; throw new Error('Unexpected database write'); }
      };
      const sub = document.getElementById('subSeatingPlan'); document.body.appendChild(sub);
      [...document.body.children].forEach(el => { if (el !== sub && el.tagName !== 'SCRIPT' && !el.classList.contains('modal-overlay')) el.style.display = 'none'; });
      sub.classList.remove('hidden'); sub.style.removeProperty('display');
      updateAdminTabs(); await initSeatingPlanTool();
    });
    assert.deepEqual(await page.evaluate(() => [canViewSeatingPlan(), canUseSeatingPlan()]), [true, false]);
    assert.notEqual(await page.locator('[data-at="seatingPlan"]').evaluate(el => el.style.display), 'none');
    assert.equal(await page.locator('#seatingPlanSelect option').filter({ hasText: '새 배치 만들기' }).count(), 0);
    assert.equal(await page.locator('#seatingDate').isDisabled(), true);
    assert.equal(await page.locator('#seatingBoard .seating-seat').first().isDisabled(), true);
    assert.equal(await page.locator('.seating-toolbar').isVisible(), false);
    const initial = await page.evaluate(() => seatingSaveFingerprint());
    await page.evaluate(async () => {
      handleSeatingSeatClick(0, 0); handleSeatingSeatClick(1, 1); selectSeatingMember('b');
      addSeatingRow(); insertBlankSeat(); toggleSeatingMicSlot(0); changeSeatingCenterOffset(1);
      createNewSeatingPlan(); applySeatingTemplate('male'); fitSeatingToAttendance();
      toggleSeatingPlacementQueueSelection(); toggleSeatingPartSubmission('S1');
      toggleSeatingAttendee('a', false); moveSeatingMemberToSpecialSlot('b', 'staff', 0); addSeatingStaffSlot();
      saveSeatingPlan(); saveSeatingPlanAs(); deleteSeatingPlan(); publishSeatingPlan(); unpublishSeatingPlan();
      try { await saveSeatingPlanRecord({ id: 'draft-a' }, 'v1', true); throw new Error('Write accepted'); }
      catch (error) { if (!error.message.includes('권한')) throw error; }
    });
    assert.equal(await page.evaluate(() => seatingSaveFingerprint()), initial);
    assert.equal(await page.evaluate(() => fixture.writes), 0);
    await page.locator('#seatingPlanSelect').selectOption('draft-b');
    assert.equal(await page.evaluate(() => seatingPlanId), 'draft-b');
    await page.locator('#seatingPlanSelect').selectOption('draft-a');
    const out = path.join(root, 'tmp/seating-permissions'); fs.mkdirSync(out, { recursive: true });
    for (const [width, height] of [[820, 1180], [390, 844], [844, 390]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => { if (!isSeatingFullscreenWorkspace()) toggleSeatingFullscreen(); });
      assert.equal(await page.locator('#seatingPlanSelect').isVisible(), true);
      assert.equal(await page.locator('#seatingSaveState').textContent(), '조회 전용');
      assert.equal(await page.locator('.seating-fullscreen-actions button[onclick="saveSeatingPlan()"]').isVisible(), false);
      assert.equal(await page.locator('.seating-structure-toolbar').isVisible(), false);
      await page.locator('#seatingViewToggleBtn').click();
      assert.equal(await page.locator('#seatingZoomRange').isVisible(), true);
      assert.equal(await page.locator('.seating-center-control').isVisible(), false);
      await page.locator('#seatingZoomRange').fill('90');
      await page.locator('#seatingViewToggleBtn').click();
      await page.locator('#seatingBoardTabOrchestra').click();
      assert.equal(await page.evaluate(() => seatingBoardTab), 'orchestra');
      await page.locator('#seatingBoardTabChoir').click();
      const tool = await page.locator('.seating-tool').boundingBox();
      const board = await page.locator('.seating-board-scroll').boundingBox();
      assert.ok(tool.y < 190, 'plan selector must not consume the remaining viewport');
      assert.ok(board.height > height * .38, 'read-only seating board is too short');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false);
      await page.screenshot({ path: path.join(out, width + '.png') });
    }
    await page.evaluate(() => { currentUser.permissions = ['seating.edit']; applySeatingPlan(fixture.plans[0]); renderSeatingPlanSelect(); });
    assert.deepEqual(await page.evaluate(() => [canViewSeatingPlan(), canUseSeatingPlan()]), [true, true]);
    assert.equal(await page.locator('.seating-fullscreen-actions button[onclick="saveSeatingPlan()"]').isVisible(), true);
    assert.equal(await page.locator('#seatingBoard .seating-seat').first().isDisabled(), false);
    await page.evaluate(() => { handleSeatingSeatClick(0, 0); handleSeatingSeatClick(1, 1); });
    assert.equal(await page.evaluate(() => seatingRows[1].seats[1].memberId), 'a');
    const confirmations = await page.evaluate(async () => {
      const calls = [];
      window.confirm = () => true;
      saveSeatingPlanRecord = async (data, expected, overwrite) => {
        calls.push([expected, overwrite]);
        if (calls.length < 3) throw seatingConflictError({ id: data.id, name: '다른 저장', updatedBy: '다른 편집자', updatedAt: 'v' + (calls.length + 1) });
        return 'doc';
      };
      syncPublishedSeatingPlanAfterSave = async () => false;
      await saveSeatingPlan();
      return calls;
    });
    assert.deepEqual(confirmations, [['v1', false], ['v2', false], ['v3', false]], 'overwrite confirmation must recheck the displayed version');
    await page.evaluate(() => { currentUser.permissions = ['seating.manage']; renderSeatingWorkspaceShell(); });
    const revoked = await page.evaluate(() => seatingSaveFingerprint());
    await page.evaluate(() => { handleSeatingSeatClick(1, 1); clearSelectedSeat(); undoSeatingChange(); saveSeatingPlan(); });
    assert.equal(await page.evaluate(() => seatingSaveFingerprint()), revoked);
    await page.evaluate(() => { adminRole = 'admin'; currentUser.permissions = []; });
    assert.deepEqual(await page.evaluate(() => [canViewSeatingPlan(), canUseSeatingPlan()]), [true, true]);
    await page.evaluate(() => { adminRole = ''; });
    assert.deepEqual(await page.evaluate(() => [canViewSeatingPlan(), canUseSeatingPlan()]), [false, false]);
    await page.evaluate(() => { currentUser.permissions = ['seating.manage']; applyLoadedSeatingPlans([]); });
    assert.match(await page.locator('#seatingBoard').textContent(), /저장된 배치가 없습니다/);
    assert.equal(await page.evaluate(() => fixture.writes), 0);
    assert.deepEqual(errors, []);
    console.log('PASS: legacy grants are read-only, unpublished folders/plans accessible, editing and writes blocked, explicit editor/admin allowed, mobile/tablet layouts and empty state.');
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
