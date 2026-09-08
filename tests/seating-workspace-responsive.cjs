const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
  .replace(/^init\(\);\r?$/m, '').replace(/^initInstallUi\(\);\r?$/m, '');
const output = path.join(root, 'tmp', 'seating-workspace');
fs.mkdirSync(output, { recursive: true });

(async () => {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 820, height: 1180 }, hasTouch: true });
    const errors = [], dataRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route(/firestore\.googleapis\.com|firebasestorage\.googleapis\.com|cloudfunctions\.net/, route => {
      dataRequests.push(route.request().url());
      return route.abort();
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(() => {
      canUseSeatingPlan = () => true;
      ensureScoreRealtimeSync = () => Promise.resolve([]);
      maybeShowSeatingWorkspaceHelp = () => {};
      showToast = message => { window.lastToast = message; };
      window.confirm = () => true;
      const sub = document.getElementById('subSeatingPlan');
      document.body.appendChild(sub);
      Array.from(document.body.children).forEach(el => {
        if (el !== sub && el.tagName !== 'SCRIPT') el.style.display = 'none';
      });
      sub.classList.remove('hidden');
      window.startWorkspace = () => {
        clearTimeout(seatingDraftTimer);
        localStorage.removeItem(SEATING_DRAFT_KEY);
        seatingLastDraftSavedAt = '';
        resetSeatingWorkspaceTransientState();
        seatingPlanId = 'responsive-fixture'; seatingEditorEpoch++;
        seatingRows = createSeatingRows(5, 12); seatingOrchestraRows = createSeatingRows(2, 8);
        seatingSpecialSlots = { conductor: null, accompanist: null, staff: [null] };
        seatingMembers = Array.from({ length: 100 }, (_, i) => ({
          id: `m${i}`, name: `단원${String(i + 1).padStart(3, '0')}`,
          part: ['S1', 'S2', 'T1', 'T2', '관현악'][i % 5]
        }));
        seatingAttendees = Object.fromEntries(seatingMembers.map((m, i) => [m.id, i < 60]));
        seatingMembers.slice(0, 36).forEach((m, i) => {
          seatingRows[Math.floor(i / 12)].seats[i % 12] = { memberId: m.id, name: m.name, part: m.part };
        });
        seatingAttendeesLocked = false; seatingPartSubmissions = {};
        seatingBoardTab = 'choir'; seatingZoom = .95;
        seatingUndoStack = []; seatingRedoStack = []; seatingDirty = false;
        seatingBoardHeightPct = 60; seatingTouchClickUntil = 0;
        document.getElementById('seatingPlanName').value = '찬양의밤 전체 합창';
        document.getElementById('seatingMemberSearch').value = '';
        sub.classList.remove('seating-fullscreen');
        toggleSeatingFullscreen(); renderSeatingDraftBar();
      };
    });
    const rect = selector => page.locator(selector).boundingBox();
    const usable = async selector => {
      const result = await page.locator(selector).evaluate(el => {
        const r = el.getBoundingClientRect();
        const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return { w: r.width, h: r.height, x: r.x, y: r.y, fits: r.x >= 0 && r.y >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1, hit: el === top || el.contains(top) };
      });
      assert.ok(result.w >= 28 && result.h >= 28 && result.fits && result.hit, `${selector} not reachable: ${JSON.stringify(result)}`);
    };
    const seat = (row, col) => page.locator('#seatingBoard .seating-row').nth(row).locator('.seating-seat').nth(col);
    const clickSeat = async (row, col) => { await seat(row, col).scrollIntoViewIfNeeded(); await seat(row, col).click(); };
    const fresh = () => page.evaluate(() => startWorkspace());
    const profiles = [
      { width: 1180, height: 820 }, { width: 820, height: 1180 }, { width: 768, height: 1024 },
      { width: 390, height: 844 }, { width: 375, height: 667 }, { width: 320, height: 568 },
      { width: 844, height: 390 }, { width: 667, height: 375 }
    ];
    const sizes = [];
    for (const viewport of profiles) {
      await page.setViewportSize(viewport); await fresh();
      const compact = viewport.width < 720 || viewport.height <= 520;
      const boardBefore = await rect('.seating-board-scroll');
      assert.ok(boardBefore.height >= viewport.height * (viewport.height <= 520 ? .35 : .45), `board too small at ${viewport.width}: ${boardBefore.height}`);
      await usable('.seating-structure-toolbar [aria-label="빈칸 추가"]');
      await usable('.seating-structure-toolbar [aria-label="줄 제거"]');
      await usable('.seating-history-actions [aria-label="되돌리기"]');
      await usable('.seating-fullscreen-actions [onclick="saveSeatingPlan()"]');
      const roster = await rect('#seatingMemberPanel');
      if (!compact) assert.ok(roster && roster.x + roster.width <= boardBefore.x, 'tablet roster not alongside board');
      else assert.equal(roster, null, 'phone roster obscures initial board');
      await page.screenshot({ path: path.join(output, `initial-${viewport.width}-${viewport.height}.png`) });

      if (compact) {
        await page.locator('#seatingRosterOpenBtn').click();
        await usable('#seatingRosterQueueToggleBtn');
        await page.locator('#seatingRosterQueueToggleBtn').click();
      } else await page.locator('#seatingQueueToggleBtn').click();
      await page.locator('[data-seating-member-id="m36"]').click();
      await page.locator('[data-seating-member-id="m37"]').click();
      assert.equal(await page.locator('#seatingGroupTools').isVisible(), false, 'unplaced people offered irrelevant seat tools');
      await usable('#seatingQueueStartBtn');
      await usable('#seatingQueueStopBtn');
      if (compact) await usable('#seatingRosterOpenBtn');
      assert.ok(await page.locator('#seatingActionDock').evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'action dock overflows');
      await page.screenshot({ path: path.join(output, `selection-${viewport.width}-${viewport.height}.png`) });
      await page.locator('#seatingQueueStartBtn').click();
      assert.deepEqual(await rect('.seating-board-scroll'), boardBefore, 'choosing roster moved or resized the board');
      if (!compact) assert.equal(await page.locator('#seatingMemberPanel').isVisible(), true, 'starting tablet placement hid roster');
      await clickSeat(3, 1); await clickSeat(4, 7);
      assert.deepEqual(await page.evaluate(() => [seatingRows[3].seats[1]?.memberId, seatingRows[4].seats[7]?.memberId, seatingPlacementQueue.length]), ['m36', 'm37', 0]);
      await page.locator('.seating-history-actions [aria-label="되돌리기"]').click();
      assert.deepEqual(await page.evaluate(() => [seatingRows[4].seats[7], seatingPlacementQueue[0]]), [null, 'm37']);
      await page.locator('.seating-history-actions [aria-label="앞돌리기"]').click();
      assert.equal(await page.evaluate(() => seatingRows[4].seats[7].memberId), 'm37');
      // Exercise real local draft rendering, not a stubbed autosave.
      await page.evaluate(() => saveSeatingDraftNow());
      assert.deepEqual(await rect('.seating-board-scroll'), boardBefore, 'draft notification shifted the board');
      sizes.push({ viewport, boardHeight: Math.round(boardBefore.height), compact });
    }

    for (const viewport of [{ width: 820, height: 1180 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport); await fresh();
      const compact = viewport.width < 720;
      if (compact) await page.locator('#seatingRosterOpenBtn').click();
      await page.locator('#seatingMemberSearch').fill('단원04');
      await page.locator('[data-seating-member-id="m40"]').click();
      const before = await rect('.seating-board-scroll');
      await clickSeat(3, 3);
      assert.equal(await page.evaluate(() => seatingRows[3].seats[3]?.memberId), 'm40');
      assert.equal(await page.evaluate(() => !!seatingMovePreview), false, 'new person in empty seat requires extra confirmation');
      assert.equal(await page.locator('#seatingMemberSearch').inputValue(), '단원04', 'placement discarded roster search');
      assert.equal(await page.locator('#seatingMemberPanel').isVisible(), !compact);
      assert.deepEqual(await rect('.seating-board-scroll'), before, 'single placement moved board');
      await page.locator('.seating-history-actions [aria-label="되돌리기"]').click();
      assert.equal(await page.evaluate(() => seatingRows[3].seats[3]), null);
      await page.locator('.seating-history-actions [aria-label="앞돌리기"]').click();
      assert.equal(await page.evaluate(() => seatingRows[3].seats[3]?.memberId), 'm40');
    }

    await page.setViewportSize({ width: 390, height: 844 }); await fresh();
    await page.locator('#seatingModeAttendanceBtn').click();
    await page.locator('[data-seating-member-id="m59"] input').click();
    await page.locator('#seatingAttendanceBatchbar button').filter({ hasText: /^미참석$/ }).click();
    assert.deepEqual(await page.evaluate(() => [seatingAttendees.m59, seatingAttendees.m0]), [false, true]);
    await page.locator('.seating-roster-close').click();
    await clickSeat(4, 4);
    assert.equal(await page.locator('#seatingMemberPanel').isVisible(), true, 'empty seat in attendance cannot choose member');
    assert.equal(await page.locator('#seatingAttendanceBatchbar').isVisible(), false, 'attendance actions mixed with placement');
    await page.locator('[data-seating-member-id="m38"]').click();
    assert.equal(await page.evaluate(() => seatingRows[4].seats[4]?.memberId), 'm38');

    await fresh();
    const before = await rect('.seating-board-scroll');
    await page.locator('#seatingViewToggleBtn').click();
    await usable('#seatingZoomRange');
    assert.deepEqual(await rect('.seating-board-scroll'), before, 'view controls moved board');
    await page.locator('#seatingViewControls button').filter({ hasText: '화면 맞춤' }).click();
    await page.locator('#seatingViewToggleBtn').click();
    await page.evaluate(() => { seatingZoom = 1.4; renderSeatingBoard(); });
    const scroll = page.locator('.seating-board-scroll');
    const box = await scroll.boundingBox();
    const cdp = await page.context().newCDPSession(page);
    const point = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + 110) };
    const prior = await scroll.evaluate(el => [el.scrollLeft, el.scrollTop]);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    for (let n = 1; n <= 6; n++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x - n * 12, y: point.y - n * 10 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const later = await scroll.evaluate(el => [el.scrollLeft, el.scrollTop]);
    assert.ok(later[0] > prior[0] || later[1] > prior[1], 'touch cannot pan in select mode');
    assert.equal(await page.evaluate(() => seatingSelectedSeat), null, 'panning accidentally selected a person');
    const zoomBefore = await page.evaluate(() => seatingZoom);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: point.x - 30, y: point.y }, { x: point.x + 30, y: point.y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x - 48, y: point.y }, { x: point.x + 48, y: point.y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert.ok(await page.evaluate(() => seatingZoom) > zoomBefore, 'pinch does not zoom board');
    assert.equal(await page.evaluate(() => seatingSelectedSeat), null, 'pinch selected a seat');

    for (const viewport of [{ width: 320, height: 568 }, { width: 667, height: 375 }]) {
      await page.setViewportSize(viewport); await fresh();
      await page.locator('#seatingQueueToggleBtn').click();
      await page.evaluate(() => { handleSeatingSeatClick(0, 1); handleSeatingSeatClick(0, 2); });
      for (const selector of ['#seatingQueueHighlightBtn', '#seatingQueueClearBtn', '#seatingQueueLockBtn']) await usable(selector);
      const boardBefore = await rect('.seating-board-scroll');
      await page.locator('#seatingQueueStartBtn').click();
      await clickSeat(3, 1);
      assert.equal(await page.locator('#seatingMoveConfirm').isVisible(), true);
      await usable('#seatingMoveConfirm .seating-move-apply');
      assert.deepEqual(await rect('.seating-board-scroll'), boardBefore, 'preview moved board');
      await page.locator('#seatingMoveConfirm button').filter({ hasText: '취소' }).click();
      assert.equal(await page.evaluate(() => seatingRows[0].seats[1]?.memberId), 'm1');
    }

    await page.setViewportSize({ width: 820, height: 1180 }); await fresh();
    await page.locator('#seatingQueueToggleBtn').click();
    await page.locator('[data-seating-member-id="m36"]').click();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.deepEqual(await page.evaluate(() => seatingPlacementQueue), ['m36'], 'rotation lost selection');
    assert.equal(await page.locator('#seatingMemberPanel').isVisible(), true);
    await usable('#seatingQueueStartBtn');

    await page.setViewportSize({ width: 820, height: 1180 }); await fresh();
    await page.evaluate(() => { document.body.classList.add('dark'); toggleSeatingPlacementQueueSelection(); handleSeatingSeatClick(0, 1); handleSeatingSeatClick(0, 2); });
    await usable('#seatingQueueHighlightBtn');
    await page.locator('#seatingQueueHighlightBtn').click();
    assert.equal(await page.evaluate(() => seatingRows[0].seats[1].highlight), true);
    await page.locator('#seatingQueueHighlightBtn').click();
    assert.equal(await page.evaluate(() => seatingRows[0].seats[1].highlight), false);
    await page.screenshot({ path: path.join(output, 'dark-tablet.png') });
    await page.evaluate(() => { stopSeatingPlacementQueue(true); canUseSeatingPlan = () => false; });
    const protectedData = await page.evaluate(() => JSON.stringify(seatingRows));
    await page.evaluate(() => moveSeatingMemberToSeat('m40', 3, 3));
    assert.equal(await page.evaluate(() => JSON.stringify(seatingRows)), protectedData, 'direct placement bypassed permission');
    assert.deepEqual(errors, [], 'page errors');
    assert.deepEqual(dataRequests, [], 'workspace interaction requested backend data');
    console.log('PASS: tablet/phone layouts, reachable inline tools and actions, sequential and direct placement, undo/redo, stable drafts, attendance, touch, permissions, no backend reads.');
    console.log(JSON.stringify(sizes));
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
