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
    page.on('pageerror', error => errors.push(error.message));
    await page.route(/firestore\.googleapis\.com|firebasestorage\.googleapis\.com|cloudfunctions\.net/, route => route.abort());
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.evaluate(() => {
      adminRole = 'admin'; ensureScoreRealtimeSync = () => Promise.resolve([]);
      saveSeatingDraftNow = () => {}; showToast = () => {}; window.confirm = () => true;
      const sub = document.getElementById('subSeatingPlan'); document.body.appendChild(sub);
      [...document.body.children].forEach(el => { if (el !== sub && el.tagName !== 'SCRIPT' && !el.classList.contains('modal-overlay')) el.style.display = 'none'; });
      sub.style.removeProperty('display'); sub.classList.remove('hidden'); sub.classList.add('seating-fullscreen');
      seatingPlanId = 'highlight-test'; seatingSettingsOpen = false; seatingMemberPanelCollapsed = true;
      seatingRows = createSeatingRows(3, 6); seatingOrchestraRows = createSeatingRows(1, 4);
      seatingMembers = ['S1', 'S2', 'T1', 'T2'].map((part, i) => ({ id: 'm' + i, part, name: ['가단원', '나단원', '다단원', '라단원'][i] }));
      seatingMembers.forEach((m, i) => { seatingRows[0].seats[i] = { memberId: m.id, name: m.name, part: m.part, highlight: false, locked: false }; });
      seatingAttendees = Object.fromEntries(seatingMembers.map(m => [m.id, true]));
      seatingSpecialSlots = { conductor: null, accompanist: null, staff: [] };
      seatingBoardTab = 'choir'; seatingWorkspaceMode = 'place'; seatingInteractionMode = 'select';
      seatingUndoStack = []; seatingRedoStack = []; seatingDirty = false;
      renderSeatingMemberList(); renderSeatingBoard(); handleSeatingSeatClick(0, 0);
    });
    const single = page.locator('.seating-edit-actions .seating-highlight-colors');
    assert.equal(await single.locator('button').count(), 4);
    await single.getByRole('button', { name: '분홍 강조', exact: true }).click();
    assert.equal(await page.evaluate(() => seatingRows[0].seats[0].highlightColor), 'pink');
    await page.evaluate(() => undoSeatingChange());
    assert.equal(await page.evaluate(() => seatingRows[0].seats[0].highlight), false);
    await page.evaluate(() => redoSeatingChange());
    assert.equal(await page.evaluate(() => seatingRows[0].seats[0].highlightColor), 'pink');
    await page.evaluate(() => {
      toggleSeatingPlacementQueueSelection(); seatingPlacementQueue = ['m0', 'm1']; renderSeatingBoard();
    });
    await page.locator('#seatingGroupTools').getByRole('button', { name: '하늘 강조', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => seatingRows[0].seats.slice(0, 2).map(s => s.highlightColor)), ['blue', 'blue']);
    await page.evaluate(() => undoSeatingChange());
    assert.deepEqual(await page.evaluate(() => seatingRows[0].seats.slice(0, 2).map(s => s.highlight)), [true, false]);
    await page.evaluate(() => redoSeatingChange());
    await page.evaluate(() => {
      toggleSeatingQueueHighlight();
      if (seatingRows[0].seats.slice(0, 2).some(s => s.highlight)) throw Error('bulk clear failed');
      chooseSeatingHighlightColor('mint', true);
      const snap = JSON.parse(JSON.stringify(seatingSnapshot())); applySeatingSnapshot(snap, true);
      if (seatingRows[0].seats[1].highlightColor !== 'mint') throw Error('snapshot lost color');
      const legacy = normalizeSeatingSeat({ memberId: 'old', name: 'Old', highlight: true });
      if (normalizeSeatingHighlightColor(legacy.highlightColor) !== 'yellow') throw Error('legacy color changed');
      if (normalizeSeatingHighlightColor('__proto__') !== 'yellow') throw Error('invalid color accepted');
      resetSeatingWorkspaceTransientState();
      ['yellow', 'mint', 'blue', 'pink'].forEach((color, i) => {
        seatingRows[0].seats[i].highlight = true; seatingRows[0].seats[i].highlightColor = color;
      });
      renderSeatingBoard(); handleSeatingSeatClick(0, 0);
      window.roundTrip = normalizeStoredSeatingPlan(JSON.parse(JSON.stringify(buildPublishedSeatingPlanData())), 'test');
      if (roundTrip.rows[0].seats[3].highlightColor !== 'pink') throw Error('saved plan lost color');
      window.publicFixture = buildPublishedSeatingPlanData();
    });
    const out = path.join(root, 'tmp/seating-highlight'); fs.mkdirSync(out, { recursive: true });
    for (const [width, height] of [[820, 1180], [390, 844], [844, 390], [1280, 900]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => renderSeatingBoard());
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      for (const button of await single.locator('button').all()) {
        const box = await button.boundingBox(); assert.ok(box.width >= 30 && box.height >= 36);
      }
      const styles = await page.locator('#seatingBoard .highlighted').evaluateAll(els => els.map(el => {
        const css = getComputedStyle(el); return [css.backgroundColor, css.borderColor, css.color, css.borderWidth];
      }));
      assert.equal(new Set(styles.map(s => s[0])).size, 4);
      assert.deepEqual(styles.map(s => s[1]), ['rgb(232, 185, 213)', 'rgb(159, 209, 216)', 'rgb(143, 194, 124)', 'rgb(237, 179, 75)']);
      assert.ok(styles.every(s => s[2] === 'rgb(32, 32, 24)' && s[3] === '2px'));
      await page.screenshot({ path: path.join(out, width + '.png') });
    }
    await page.evaluate(() => { document.documentElement.classList.add('dark'); setSeatingInteractionMode('pan'); });
    assert.ok(await single.locator('button').evaluateAll(buttons => buttons.every(button => button.disabled)));
    assert.ok(await page.locator('#seatingBoard .highlighted').evaluateAll(els => els.every(el => getComputedStyle(el).color === 'rgb(32, 32, 24)')));
    await page.screenshot({ path: path.join(out, 'dark.png') });
    await page.evaluate(() => { document.documentElement.classList.remove('dark'); setSeatingInteractionMode('select'); });
    await page.evaluate(() => {
      const before = JSON.stringify(seatingRows); adminRole = 'custom'; currentUser = { id: 'viewer', permissions: ['seating.manage'] };
      chooseSeatingHighlightColor('blue', false); applySeatingQueueHighlight(true, 'pink');
      if (JSON.stringify(seatingRows) !== before) throw Error('viewer changed colors');
      adminRole = 'admin';
      HTMLCanvasElement.prototype.toBlob = function () { window.exportCanvas = this; };
      downloadSeatingImage(false);
    });
    const pixels = await page.evaluate(() => {
      const canvas = window.exportCanvas, ctx = canvas.getContext('2d');
      const bytes = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      return ['#FFF06A', '#B9E8CC', '#B9DEFA', '#F6BFD1', '#E8B9D5', '#9FD1D8', '#8FC27C', '#EDB34B'].map(hex => {
        const rgb = hex.slice(1).match(/../g).map(s => parseInt(s, 16)); let count = 0;
        for (let i = 0; i < bytes.length; i += 4) if (rgb.every((v, n) => bytes[i + n] === v)) count++;
        return count;
      });
    });
    assert.ok(pixels.every(count => count > 100), 'image must retain every highlight and part color');
    await page.evaluate(() => {
      publishedSeatingPlan = publicFixture; publishedSeatingPlans = [publicFixture];
      publicSeatingBoardTab = 'choir'; renderPublicSeatingModalBody();
    });
    assert.equal(await page.locator('#publicSeatingBody .highlighted').count(), 4);
    assert.deepEqual(await page.locator('#publicSeatingBody .highlighted').evaluateAll(els => els.map(el => el.style.getPropertyValue('--seat-highlight')).sort()), ['#B9DEFA', '#B9E8CC', '#F6BFD1', '#FFF06A']);
    assert.deepEqual(errors, []);
    console.log('PASS: four colors, bulk recolor, undo/redo, legacy compatibility, persistence, publication, export pixels, read-only/pan guards, dark mode and four responsive viewports');
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
