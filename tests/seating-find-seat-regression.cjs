const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium, webkit } = require('playwright');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/^init\(\);\r?$/m, '').replace(/^initInstallUi\(\);\r?$/m, '');

(async () => {
  const server = http.createServer((req, res) => { if (require('./serve-firebase-sdk.cjs')(req, res)) return; res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const engine of [chromium, webkit]) {
      const browser = await engine.launch(engine === chromium ? { channel: 'msedge' } : {});
      try {
        for (const viewport of [{ width: 1180, height: 820 }, { width: 390, height: 844 }]) {
          const page = await browser.newPage({ viewport, hasTouch: true });
          const errors = []; page.on('pageerror', error => errors.push(error.message));
          await page.route(/firestore\.googleapis\.com|firebasestorage\.googleapis\.com|cloudfunctions\.net/, route => route.abort());
          await page.goto('http://127.0.0.1:' + server.address().port + '/');
          await page.evaluate(() => {
            canUseSeatingPlan = () => true; ensureScoreRealtimeSync = () => Promise.resolve([]); maybeShowSeatingWorkspaceHelp = () => {};
            showToast = message => { window.lastToast = message; }; window.confirm = () => true;
            const sub = document.getElementById('subSeatingPlan'); document.body.appendChild(sub);
            Array.from(document.body.children).forEach(el => { if (el !== sub && el.tagName !== 'SCRIPT') el.style.display = 'none'; });
            sub.classList.remove('hidden');
            clearTimeout(seatingDraftTimer); localStorage.removeItem(SEATING_DRAFT_KEY); resetSeatingWorkspaceTransientState();
            seatingPlanId = 'find-fixture'; seatingEditorEpoch++;
            seatingRows = createSeatingRows(8, 16); seatingOrchestraRows = createSeatingRows(2, 8);
            seatingSpecialSlots = { conductor: null, accompanist: null, staff: [null] };
            seatingMembers = Array.from({ length: 140 }, (_, i) => ({ id: 'm' + i, name: '단원' + String(i + 1).padStart(3, '0'), part: ['S1', 'S2', 'T1', 'T2'][i % 4] }));
            seatingAttendees = Object.fromEntries(seatingMembers.map(m => [m.id, true]));
            seatingMembers.slice(0, 128).forEach((m, i) => { seatingRows[Math.floor(i / 16)].seats[i % 16] = { memberId: m.id, name: m.name, part: m.part }; });
            seatingOrchestraRows[1].seats[3] = { memberId: 'm130', name: '단원131', part: 'T1' };
            seatingAttendeesLocked = false; seatingPartSubmissions = {}; seatingBoardTab = 'choir'; seatingZoom = 1.4;
            seatingUndoStack = []; seatingRedoStack = []; seatingDirty = false;
            sub.classList.remove('seating-fullscreen'); toggleSeatingFullscreen();
            const scroller = document.querySelector('#subSeatingPlan .seating-board-scroll'); scroller.scrollLeft = 0; scroller.scrollTop = 0;
          });
          const found = await page.evaluate(async () => {
            const scroller = document.querySelector('#subSeatingPlan .seating-board-scroll');
            const before = [scroller.scrollLeft, scroller.scrollTop];
            selectSeatingMember('m127');
            const seat = document.querySelectorAll('#seatingBoard .seating-row')[7].querySelectorAll('.seating-seat')[15];
            const box = scroller.getBoundingClientRect(), rect = seat.getBoundingClientRect();
            return {
              moved: scroller.scrollLeft !== before[0] || scroller.scrollTop !== before[1],
              visible: rect.left >= box.left - 1 && rect.right <= box.right + 1 && rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1,
              flashing: seat.classList.contains('seat-found'),
              source: seat.classList.contains('member-source'),
              selected: seatingSelectedMemberId
            };
          });
          assert.deepEqual(found, { moved: true, visible: true, flashing: true, source: true, selected: 'm127' }, JSON.stringify(viewport));
          // Moving still works exactly as before: the next empty seat receives the member and the old seat empties.
          await page.evaluate(() => { seatingRows[0].seats[0] = null; renderSeatingBoard(); handleSeatingSeatClick(0, 0); });
          assert.deepEqual(await page.evaluate(() => [seatingRows[0].seats[0] && seatingRows[0].seats[0].memberId, seatingRows[7].seats[15], seatingSelectedMemberId,
            document.querySelectorAll('#seatingBoard .member-source').length]), ['m127', null, '', 0]);
          // Members on the other board are reported instead of switching boards mid-edit.
          const other = await page.evaluate(() => { selectSeatingMember('m130'); return [seatingBoardTab, lastToast, '관현악 배치도 ' + seatingOrchestraRows[1].label + '에 있습니다']; });
          assert.equal(other[0], 'choir');
          assert.equal(other[1], other[2]);
          // Unplaced members do not scroll or flash anything.
          assert.equal(await page.evaluate(() => { selectSeatingMember('m130'); selectSeatingMember('m135'); return document.querySelectorAll('#seatingBoard .seat-found').length; }), 0);
          assert.deepEqual(errors, []);
          await page.close();
        }
        console.log('PASS ' + engine.name() + ': placed member seat is revealed and flashed on tablet/phone, move flow unchanged, other-board members reported, unplaced members ignored');
      } finally { await browser.close(); }
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
