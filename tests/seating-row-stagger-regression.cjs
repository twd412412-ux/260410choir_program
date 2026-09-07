const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const context = vm.createContext({
  seatingRows: [], seatingOrchestraRows: [], seatingBoardTab: 'choir', seatingMicSlots: [],
  seatingSelectedSeat: null, seatingAutoFit: true,
  beginSeatingEdit() { context.beforeEdit = clone(context.seatingActiveRows()); },
  renderSeatingBoard() {}, renderSeatingMemberList() {}, showToast() {}, confirm: () => true,
  normalizeSeatingSeat: seat => seat
});
for (const name of ['seatingLeadWidth', 'seatingSeatPitch', 'seatingRowWidthForSeatCount', 'seatingCenterLeftForSeatCount', 'seatingRowLeftForSeatCount', 'seatingDefaultSeatCount', 'seatingRowsForBoard', 'seatingActiveRows', 'seatingBaseRowLabel', 'seatingInsertedRowLabel', 'seatingFrontInsertIndex', 'normalizeSeatingRowLabel', 'seatingRowStaggerOffset', 'seatingRowDisplayOffset', 'seatingMaxSeatCount', 'normalizeSeatingMicSlots', 'syncSeatingRowLabels', 'createSeatingRows', 'normalizeSeatingRows', 'normalizeOrchestraSeatingRows', 'addSeatingRow', 'removeSelectedSeatingRow']) {
  const source = html.match(new RegExp('^function ' + name + '\\([^]*?^}', 'm'));
  assert.ok(source, name); vm.runInContext(source[0], context);
}
function left(rows, i) {
  return context.seatingRowLeftForSeatCount(rows[i].seats.length, context.seatingMaxSeatCount(rows))
    + context.seatingRowDisplayOffset(rows[i], i, rows) * context.seatingSeatPitch();
}
function checkStagger(rows) {
  for (let i = 1; i < rows.length; i++) {
    const phase = ((left(rows, i) - left(rows, i - 1)) % 52 + 52) % 52;
    assert.equal(phase, 26, rows[i - 1].label + ' / ' + rows[i].label + ' heads overlap');
  }
}
for (const counts of [[10, 10, 10, 10], [9, 10, 9, 10], [11, 9, 10, 9]]) {
  context.seatingBoardTab = 'choir';
  context.seatingRows = counts.map((count, i) => ({ label: ['3단', '2단', '1단', '0단'][i], offset: i % 2 ? 0 : 0.5, seats: Array.from({ length: count }, (_, j) => ({ memberId: i + '-' + j, name: '단원 ' + j, part: 'S1' })) }));
  const original = clone(context.seatingRows);
  const originalLefts = original.map((row, i) => left(original, i));
  for (let n = 0; n < 3; n++) {
    context.addSeatingRow();
    const rows = context.seatingRows;
    checkStagger(rows);
    assert.deepEqual(clone(rows.slice(0, 4).map(row => row.seats)), original.map(row => row.seats));
    assert.deepEqual(rows.slice(0, 4).map((row, i) => left(rows, i)), originalLefts, 'existing rows shifted');
    assert.equal(rows.at(-1).seats.filter(Boolean).length, 0);
    assert.equal(context.beforeEdit.length, rows.length - 1, 'undo snapshot missing');
  }
  const saved = JSON.stringify(context.seatingRows);
  context.seatingRows = context.normalizeSeatingRows(JSON.parse(saved));
  checkStagger(context.seatingRows);
  context.seatingSelectedSeat = { row: 4, col: 0 };
  context.removeSelectedSeatingRow();
  checkStagger(context.seatingRows);
}
// Previously saved front rows may all contain offset: 0. Reopening must repair their display.
context.seatingRows = context.createSeatingRows(4, 10);
context.seatingRows.push({ label: '0단앞', offset: 0, seats: Array(10).fill(null) });
checkStagger(context.normalizeSeatingRows(clone(context.seatingRows)));
context.seatingBoardTab = 'orchestra';
context.seatingOrchestraRows = [{ label: '뒤열', offset: 0.5, seats: Array(8).fill(null) }, { label: '앞열', offset: 0, seats: Array(7).fill(null) }];
const orchestraLefts = context.seatingOrchestraRows.map((row, i) => left(context.seatingOrchestraRows, i));
context.addSeatingRow();
checkStagger(context.seatingOrchestraRows);
assert.deepEqual(context.seatingOrchestraRows.slice(0, 2).map((row, i) => left(context.seatingOrchestraRows, i)), orchestraLefts);
checkStagger(context.normalizeOrchestraSeatingRows(clone(context.seatingOrchestraRows)));
console.log('PASS: added/front/saved rows stagger by half a seat, mixed seat counts, repeated adds/removal, existing occupants/positions preserved, orchestra rows, undo snapshot');

(async () => {
  const http = require('node:http');
  const { chromium } = require('playwright');
  const pageHtml = html.replace(/^init\(\);\r?$/m, '').replace(/^initInstallUi\(\);\r?$/m, '');
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(pageHtml); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage();
    await page.route(/firestore\.googleapis\.com|firebasestorage\.googleapis\.com|cloudfunctions\.net/, route => route.abort());
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(() => {
      ensureScoreRealtimeSync = () => Promise.resolve([]);
      beginSeatingEdit = () => {};
      renderSeatingSummary = renderSeatingInlineList = renderSeatingWorkspaceShell = () => {};
      renderSeatingBoardTabs = setupSeatingBoardGestures = () => {};
      renderSeatingInlinePicker = renderSeatingSpecialArea = () => '';
      const board = document.getElementById('seatingBoard');
      const add = document.querySelector('button[onclick="addSeatingRow()"]');
      const scroller = document.createElement('div'); scroller.className = 'seating-board-scroll'; scroller.append(board);
      const preview = document.createElement('div'); preview.id = 'fixturePreview';
      document.body.replaceChildren(add, scroller, preview);
      seatingBoardTab = 'choir'; seatingZoom = 1;
      seatingRows = createSeatingRows(4, 10);
      seatingRows.forEach((row, i) => { row.seats[4] = { memberId: 'test-' + i, name: '테스트', part: 'S1' }; });
      renderSeatingBoard();
    });
    for (const width of [390, 820, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.locator('button[onclick="addSeatingRow()"]') .click();
      await page.evaluate(() => {
        document.getElementById('fixturePreview').innerHTML = renderSeatingPublishBoardPreview({ rows: JSON.parse(JSON.stringify(seatingRows)) });
      });
      for (const selector of ['#seatingBoard .seating-row .seating-line', '#fixturePreview .public-seating-line']) {
        const positions = await page.locator(selector).evaluateAll(lines => lines.map(line => {
          const a = line.children[0].getBoundingClientRect();
          const b = line.children[1].getBoundingClientRect();
          return { x: a.x, pitch: b.x - a.x };
        }));
        for (let i = 1; i < positions.length; i++) {
          const pitch = positions[i].pitch;
          const phase = ((positions[i].x - positions[i - 1].x) % pitch + pitch) % pitch;
          assert.ok(Math.abs(phase - pitch / 2) < 0.1, selector + ' not staggered at ' + width + 'px');
        }
      }
      fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
      await page.locator('#seatingBoard').screenshot({ path: path.join(root, 'tmp', 'seating-row-stagger-' + width + '.png') });
    }
    console.log('PASS: real add-row button, editor/public preview seat geometry at 390/820/1280px');
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
