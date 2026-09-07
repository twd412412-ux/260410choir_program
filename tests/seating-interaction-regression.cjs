const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const html = source.replace(/^init\(\);\r?$/m, '').replace(/^initInstallUi\(\);\r?$/m, '');

(async () => {
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route(/firestore\.googleapis\.com|firebasestorage\.googleapis\.com|cloudfunctions\.net/, route => route.abort());
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(() => {
      ensureScoreRealtimeSync = () => Promise.resolve([]);
      canUseSeatingPlan = () => true;
      showToast = message => { window.lastToast = message; };
      window.confirm = () => true;
      saveSeatingDraftNow = () => {};
      const sub = document.getElementById('subSeatingPlan');
      document.body.appendChild(sub);
      Array.from(document.body.children).forEach(el => { if (el !== sub && el.tagName !== 'SCRIPT') el.style.display = 'none'; });
      sub.style.display = 'block'; sub.classList.remove('hidden');
      sub.classList.add('seating-fullscreen');
      seatingSettingsOpen = false; seatingMemberPanelCollapsed = true;
      window.resetFixture = () => {
        resetSeatingWorkspaceTransientState();
        seatingPlanId = 'test-plan'; seatingEditorEpoch++;
        seatingRows = createSeatingRows(3, 8); seatingOrchestraRows = createSeatingRows(2, 6);
        seatingSpecialSlots = { conductor: null, accompanist: null, staff: [null] };
        seatingMembers = Array.from({ length: 8 }, (_, i) => ({ id: 'm' + i, name: ['김하민', '윤하은', '박상인', '김수아', '신주영', '이지영', '최미진', '홍승미'][i], part: i < 4 ? 'S1' : 'T1' }));
        seatingAttendees = Object.fromEntries(seatingMembers.map(m => [m.id, true]));
        seatingMembers.slice(0, 4).forEach((m, i) => { seatingRows[0].seats[i] = { memberId: m.id, name: m.name, part: m.part, highlight: i === 0 }; });
        seatingAttendeesLocked = false; seatingPartSubmissions = {};
        seatingBoardTab = 'choir'; seatingWorkspaceMode = 'place'; seatingZoom = 1;
        seatingUndoStack = []; seatingRedoStack = []; seatingDirty = false;
        renderSeatingMemberList(); renderSeatingBoard();
      };
      resetFixture();
    });
    const result = await page.evaluate(() => {
      const check = (ok, message) => { if (!ok) throw Error(message); };
      const saved = JSON.stringify(seatingRows);
      setSeatingInteractionMode('pan'); handleSeatingSeatClick(0, 0);
      check(!seatingSelectedSeat && JSON.stringify(seatingRows) === saved, 'pan selected a seat');
      setSeatingInteractionMode('select'); selectSeatingRow(0);
      check(seatingPlacementQueue.length === 4, 'row selection count');
      selectSeatingRow(0); check(seatingPlacementQueue.length === 0, 'row deselection');
      selectSeatingRow(0); setSelectedSeatingPositionLock(true);
      check(seatingRows[0].seats.slice(0, 4).every(s => s.locked), 'lock not set');
      check(normalizeSeatingSeat(seatingRows[0].seats[0]).locked, 'lock lost on normalization');
      check(isSeatingMemberAttendanceLocked(seatingMembers[0]), 'attendance can remove locked seat');
      const locked = JSON.stringify(seatingRows);
      clearSeatingPlacementQueue(); swapSeatingSeats(0, 0, 1, 0); moveSeatingMemberToSpecialSlot('m0', 'accompanist', 0);
      seatingSelectedSeat = { row: 0, col: 0 };
      clearSelectedSeat(); removeSelectedSeatingSeat(); shiftSelectedSeatingRow(1); removeSelectedSeatingRow(); fitSeatingToAttendance();
      check(JSON.stringify(seatingRows) === locked && !seatingMovePreview, 'lock bypass');
      setSelectedSeatingPositionLock(false);
      startSeatingPlacementQueue(); handleSeatingSeatClick(1, 0);
      check(seatingMovePreview && seatingMovePreview.count === 4, 'bulk preview missing');
      check(seatingRows[0].seats[0].memberId === 'm0' && !seatingRows[1].seats[0], 'preview mutated live seats');
      confirmSeatingMovePreview();
      check(!seatingRows[0].seats[0] && seatingRows[1].seats.slice(0, 4).every(Boolean), 'bulk move failed');
      check(seatingRows[1].seats[0].highlight, 'highlight lost');
      undoSeatingChange(); check(seatingRows[0].seats[0].memberId === 'm0' && !seatingRows[1].seats[0], 'bulk undo failed');
      resetFixture();
      swapSeatingSeats(0, 0, 0, 1); check(seatingMovePreview.count === 2, 'swap preview');
      confirmSeatingMovePreview(); check(seatingRows[0].seats[1].memberId === 'm0' && seatingRows[0].seats[0].memberId === 'm1', 'swap lost a member');
      const prior = JSON.stringify(seatingRows);
      previewSeatingMembers(['m4'], 1, 0, false); cancelSeatingMovePreview(); check(JSON.stringify(seatingRows) === prior, 'cancel mutated');
      previewSeatingMembers(['m4'], 1, 0, false); seatingAttendees.m4 = false;
      confirmSeatingMovePreview(); check(!seatingRows[1].seats[0], 'stale preview applied');
      resetFixture();
      previewSeatingMembers(['m0', 'm1', 'm2', 'm3'], 2, 7, true); check(seatingMovePreview.blocked, 'insufficient capacity accepted');
      previewSeatingMembers(['m0', 'm1'], 0, 1, true); confirmSeatingMovePreview();
      check(seatingMovePreview.blocked && seatingRows[0].seats[0].memberId === 'm0' && seatingRows[0].seats[1].memberId === 'm1', 'occupied destination must block, not skip');
      resetFixture();
      const before = seatingSnapshot();
      seatingBoardTab = 'orchestra'; previewSeatingMembers(['m0'], 0, 0, false); confirmSeatingMovePreview();
      check(!seatingRows[0].seats[0] && seatingOrchestraRows[0].seats[0].memberId === 'm0', 'cross-board move');
      check(seatingPublishedDifferences(seatingSnapshot(), before).length === 1, 'comparison moved count');
      check(seatingPublishedDifferences(before, before).length === 0, 'identical comparison');
      resetFixture();
      seatingSpecialSlots.accompanist = { memberId: 'm4', name: '신주영', part: 'T1' };
      previewSeatingMembers(['m4'], 1, 0, false); confirmSeatingMovePreview();
      check(!seatingSpecialSlots.accompanist && seatingRows[1].seats[0].memberId === 'm4', 'special source not cleared: '+JSON.stringify({slots:seatingSpecialSlots,target:seatingRows[1].seats[0],toast:window.lastToast}));
      resetFixture();
      window.compareReads = 0;
      getPublishedSeatingPlan = async () => { window.compareReads++; publishedSeatingPlans = [Object.assign(seatingSnapshot(), { sourcePlanId: 'test-plan', name: 'test' })]; };
      return 'selection, locks, bulk preview, atomic undo, swap, cancel, stale preview, insufficient capacity, occupied targets, cross-board and special seats';
    });
    await page.evaluate(() => toggleSeatingPublishedComparison());
    assert.equal(await page.evaluate(() => seatingCompareEnabled && window.compareReads === 1), true);
    await page.evaluate(() => { renderSeatingBoard(); renderSeatingBoard(); });
    assert.equal(await page.evaluate(() => window.compareReads), 1, 'render performed extra reads');
    await page.evaluate(() => { closeSeatingPositionTools(); resetFixture(); });
    const blocks = await page.evaluate(() => {
      const check = (ok, message) => { if (!ok) throw Error(message); };
      const placed = plan => seatingPositionEntries(plan).filter(e => e.seat && !e.special);
      const setup = () => {
        resetFixture(); seatingRows = createSeatingRows(6, 10);
        // Unequal row lengths exercise centered coordinates as well as stagger.
        seatingRows[1].seats = Array(9).fill(null); seatingRows[3].seats = Array(11).fill(null);
        seatingMembers.slice(0, 6).forEach((m, i) => {
          seatingRows[i < 3 ? 0 : 1].seats[1 + i % 3] = { memberId: m.id, name: m.name, part: m.part, highlight: i === 0, locked: false };
        });
        renderSeatingBoard();
      };
      setup();
      const original = seatingSnapshot();
      const source = placed(original);
      // Deliberately reverse selection order: the upper-left source is still the anchor.
      const ids = source.map(e => e.seat.memberId).reverse();
      previewSeatingMembers(ids, 0, 1, true);
      check(!seatingMovePreview, 'unchanged position must not create a move');
      previewSeatingMembers(ids, 2, 5, true);
      check(!seatingMovePreview.blocked, 'valid 3+3 block rejected');
      const destinations = placed(seatingMovePreview.after);
      const delta = destinations.find(e => e.seat.memberId === 'm0').left - source.find(e => e.seat.memberId === 'm0').left;
      source.forEach(s => {
        const d = destinations.find(e => e.seat.memberId === s.seat.memberId);
        check(d.row - s.row === 2 && d.left - s.left === delta, '3+3 shape or physical gap changed');
      });
      confirmSeatingMovePreview();
      check(placed(seatingSnapshot()).length === 6, 'block lost/duplicated a member');
      undoSeatingChange(); check(JSON.stringify(seatingRows) === JSON.stringify(original.rows), 'block undo not atomic');
      // A shift by one row needs stagger compensation, not the same column offset.
      previewSeatingMembers(ids, 1, 4, true);
      check(!seatingMovePreview.blocked, 'odd-row stagger move rejected');
      const staggered = placed(seatingMovePreview.after);
      const dx = staggered.find(e => e.seat.memberId === 'm0').left - source.find(e => e.seat.memberId === 'm0').left;
      source.forEach(s => { const d = staggered.find(e => e.seat.memberId === s.seat.memberId); check(d.row - s.row === 1 && d.left - s.left === dx, 'stagger not preserved'); });
      cancelSeatingMovePreview();
      // The block can overlap its own previous cells; no outsider is displaced.
      previewSeatingMembers(ids, 0, 2, true); check(!seatingMovePreview.blocked, 'self-overlap rejected');
      confirmSeatingMovePreview(); check(placed(seatingSnapshot()).length === 6, 'self-overlap duplicate/loss');
      setup();
      const bystander = seatingMembers[6];
      seatingRows[2].seats[6] = { memberId: bystander.id, name: bystander.name, part: bystander.part, locked: true };
      const beforeConflict = JSON.stringify(seatingRows);
      previewSeatingMembers(ids, 2, 5, true);
      check(seatingMovePreview.blocked && seatingMovePreview.conflicts.length === 1, 'collision not detected');
      check(document.querySelectorAll('.move-conflict-seat').length === 1, 'collision not marked');
      check(document.querySelector('#seatingMoveConfirm .seating-move-apply').disabled, 'collision apply enabled');
      confirmSeatingMovePreview(); check(JSON.stringify(seatingRows) === beforeConflict, 'forced apply overwrote bystander');
      previewSeatingMembers(ids, 5, 9, true); check(seatingMovePreview.blocked, 'out of bounds not blocked');
      confirmSeatingMovePreview(); check(JSON.stringify(seatingRows) === beforeConflict, 'bounds failure mutated');
      // An invalid follow-up request must not leave an earlier preview applicable.
      previewSeatingMembers(ids, 2, 1, true); check(seatingMovePreview && !seatingMovePreview.blocked, 'new valid preview');
      previewSeatingMembers(['m0', 'm7'], 2, 1, true); check(!seatingMovePreview, 'mixed selection left stale preview');
      seatingPlacementQueue = ['m0', 'm7']; seatingPlacementQueueSelecting = true; startSeatingPlacementQueue();
      check(!seatingPlacementQueueActive, 'mixed selection started');
      // New roster selections still use selection order and skip occupied cells.
      resetFixture(); previewSeatingMembers(['m5', 'm4'], 0, 3, true);
      check(!seatingMovePreview.blocked, 'new roster sequence rejected');
      confirmSeatingMovePreview();
      check(seatingRows[0].seats[3].memberId === 'm3' && seatingRows[0].seats[4].memberId === 'm5' && seatingRows[0].seats[5].memberId === 'm4', 'new roster sequence changed');
      // Gaps within a selection remain gaps; unrelated occupants in those gaps stay put.
      resetFixture(); previewSeatingMembers(['m2', 'm0'], 1, 0, true); confirmSeatingMovePreview();
      check(seatingRows[1].seats[0].memberId === 'm0' && !seatingRows[1].seats[1] && seatingRows[1].seats[2].memberId === 'm2', 'selection gap compacted');
      resetFixture();
      return '3+3 block shape, centered/staggered rows, reverse selection, self overlap, locked collisions, bounds, stale previews, mixed selection, sequence and gaps';
    });
    await page.evaluate(() => {
      previewSeatingMembers(['m4'], 0, 0, false);
      if (seatingMovePreview.unplaced !== 1) throw Error('replacement warning missing');
      confirmSeatingMovePreview();
      if (seatingAssignedMap().m0 || seatingRows[0].seats[0].memberId !== 'm4') throw Error('replacement failed');
      resetFixture();
    });
    await page.locator('#seatingBoard .seating-seat').first().dragTo(page.locator('#seatingBoard .seating-row').nth(1).locator('.seating-seat').first());
    assert.ok(await page.evaluate(() => !!seatingMovePreview), 'actual drag missed preview');
    await page.evaluate(() => { cancelSeatingMovePreview(); resetFixture(); });

    const output = path.join(root, 'tmp', 'seating-interaction'); fs.mkdirSync(output, { recursive: true });
    for (const viewport of [{ width: 1280, height: 900 }, { width: 820, height: 1180 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport);
      await page.evaluate(() => { resetFixture(); seatingMemberPanelCollapsed = true; renderSeatingWorkspaceShell(); document.getElementById('subSeatingPlan').scrollTop = 0; });
      const seat = page.locator('#seatingBoard .seating-seat').first();
      await seat.scrollIntoViewIfNeeded();
      const before = await seat.boundingBox();
      await page.evaluate(() => { selectSeatingRow(0); startSeatingPlacementQueue(); handleSeatingSeatClick(1, 0); });
      const after = await seat.boundingBox();
      assert.ok(Math.abs(after.y - before.y) <= 1, 'preview moved the board vertically');
      const bar = await page.locator('#seatingMoveConfirm').boundingBox();
      assert.ok(bar.x >= 0 && bar.x + bar.width <= viewport.width + 1 && bar.y >= 0 && bar.y + bar.height <= viewport.height, 'confirmation clipped');
      assert.ok(await page.locator('#seatingMoveConfirm button').evaluateAll(buttons => buttons.every(button => button.getBoundingClientRect().height <= 48)), 'button labels wrapped');
      await page.screenshot({ path: path.join(output, `preview-${viewport.width}.png`) });
      await page.locator('#seatingMoveConfirm button').filter({ hasText: '취소' }).click();
      await page.evaluate(() => {
        const m = seatingMembers[6]; seatingRows[1].seats[0] = normalizeSeatingSeat({ memberId: m.id, name: m.name, part: m.part });
        previewSeatingMembers(['m0', 'm1'], 1, 0, true);
      });
      assert.equal(await page.locator('#seatingMoveConfirm .seating-move-apply').isDisabled(), true);
      const blockedBar = await page.locator('#seatingMoveConfirm').boundingBox();
      assert.ok(blockedBar.x >= 0 && blockedBar.x + blockedBar.width <= viewport.width + 1 && blockedBar.y >= 0 && blockedBar.y + blockedBar.height <= viewport.height + 1, 'blocked confirmation clipped');
      assert.equal(await page.locator('.move-conflict-seat').count(), 1);
      await page.screenshot({ path: path.join(output, `blocked-${viewport.width}.png`) });
      await page.locator('#seatingMoveConfirm button').filter({ hasText: '취소' }).click();
      await page.evaluate(() => { openSeatingPositionTools(); });
      const tools = await page.locator('#seatingPositionTools').boundingBox();
      assert.ok(tools.x >= 0 && tools.y >= 0 && tools.x + tools.width <= viewport.width + 1 && tools.y + tools.height <= viewport.height + 1, 'tools clipped');
      await page.locator('#seatingPositionTools button').filter({ hasText: '닫기' }).click();
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(() => { resetFixture(); seatingZoom = 1.8; seatingRows = createSeatingRows(10, 24); renderSeatingBoard(); setSeatingInteractionMode('pan'); });
    const scroller = page.locator('#subSeatingPlan .seating-board-scroll');
    await scroller.scrollIntoViewIfNeeded();
    const box = await scroller.boundingBox();
    const x = box.x + box.width / 2, y = Math.min(800, box.y + 100);
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x - 120, y - 60, { steps: 6 }); await page.mouse.up();
    assert.ok(await scroller.evaluate(el => el.scrollLeft > 50), 'mouse pan failed');
    await page.setViewportSize({ width: 844, height: 390 });
    await page.evaluate(() => { setSeatingWorkspaceMode('attendance'); setSeatingInteractionMode('pan'); seatingMemberPanelCollapsed = true; renderSeatingWorkspaceShell(); });
    await scroller.scrollIntoViewIfNeeded();
    const touchBox = await scroller.boundingBox();
    const client = await page.context().newCDPSession(page);
    const touchX = Math.round(touchBox.x + touchBox.width / 2), touchY = Math.round(Math.min(340, touchBox.y + 100));
    const touchBefore = await scroller.evaluate(el => el.scrollTop);
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: touchX, y: touchY }] });
    for (let i = 1; i <= 5; i++) await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: touchX, y: touchY - i * 12 }] });
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert.ok(await scroller.evaluate((el, before) => el.scrollTop > before, touchBefore), 'landscape touch scroll failed');
    assert.equal(await page.evaluate(() => seatingSelectedSeat), null, 'touch pan selected seat');
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(() => { document.body.classList.add('dark'); openSeatingPositionTools(); });
    await page.screenshot({ path: path.join(output, 'dark-tools.png') });
    assert.deepEqual(errors, [], 'browser errors');
    console.log('PASS:', result, ';', blocks, '; comparison on demand; responsive overlay; mouse pan; no browser errors');
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
