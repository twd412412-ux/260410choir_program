const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium, webkit } = require('playwright');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/^init\(\);\r?$/m, '').replace(/^initInstallUi\(\);\r?$/m, '');
const setup = () => {
  firebaseAuthReady = false;
  ensureScoreRealtimeSync = () => Promise.resolve([]);
  resumeScoreRealtimeSync = () => {};
  adminRole = 'admin';
  window.testActor = 'director-a';
  currentActorId = () => testActor;
  allSchedules = [{ id: 'concert', title: '공연', date: '2026-09-26', program: 'Alpha\nBeta\nAlpha' },
    { id: 'other-concert', title: '다른 행사', date: '2026-09-27', program: 'Alpha\nBeta' }];
  document.getElementById('modalRehearsalCue').classList.add('active');
  startRehearsalCue('concert');
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
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.route(/firestore\.googleapis\.com|cloudfunctions\.net/, route => route.abort());
        await page.goto('http://127.0.0.1:' + server.address().port);
        await page.evaluate(setup);
        await page.locator('#rehearsalMetroBpm').fill('92');
        await page.locator('#rehearsalMetroBpm').press('Tab');
        await page.locator('#rehearsalMetronome select').selectOption('3');
        assert.equal(await page.locator('#rehearsalMetroSaved').innerText(), '곡 설정 저장됨');
        await page.evaluate(() => selectRehearsalCue(1));
        assert.deepEqual(await page.evaluate(() => [rehearsalMetro.bpm, rehearsalMetro.beats]), [80, 4]);
        await page.locator('#rehearsalMetroBpm').fill('146');
        await page.locator('#rehearsalMetroBpm').press('Tab');
        await page.locator('#rehearsalMetronome select').selectOption('6');
        await page.evaluate(() => { selectRehearsalCue(2); setRehearsalMetronome('bpm', 108); setRehearsalMetronome('beats', 12); selectRehearsalCue(0); });
        assert.deepEqual(await page.evaluate(() => [rehearsalMetro.bpm, rehearsalMetro.beats]), [92, 3]);
        await page.reload();
        await page.evaluate(setup);
        assert.deepEqual(await page.evaluate(() => [rehearsalMetro.bpm, rehearsalMetro.beats]), [92, 3], 'reload lost preset');
        await page.evaluate(() => {
          allSchedules[0].program = 'Beta\nAlpha\nAlpha';
          startRehearsalCue('concert');
        });
        assert.deepEqual(await page.evaluate(() => [rehearsalMetro.bpm, rehearsalMetro.beats]), [146, 6], 'reorder lost preset');
        await page.evaluate(() => selectRehearsalCue(2));
        assert.deepEqual(await page.evaluate(() => [rehearsalMetro.bpm, rehearsalMetro.beats]), [108, 12], 'duplicate song settings collided');
        await page.evaluate(() => startRehearsalCue('other-concert'));
        assert.deepEqual(await page.evaluate(() => [rehearsalMetro.bpm, rehearsalMetro.beats]), [80, 4], 'event leakage');
        await page.evaluate(() => { testActor = 'director-b'; startRehearsalCue('concert'); });
        assert.deepEqual(await page.evaluate(() => [rehearsalMetro.bpm, rehearsalMetro.beats]), [80, 4], 'actor leakage');
        await page.evaluate(() => { testActor = 'director-a'; startRehearsalCue('concert'); });
        assert.deepEqual(await page.evaluate(() => [rehearsalMetro.bpm, rehearsalMetro.beats]), [108, 12], 'restored selection lost settings');
        await page.evaluate(() => selectRehearsalCue(0));
        assert.deepEqual(await page.evaluate(() => [rehearsalMetro.bpm, rehearsalMetro.beats]), [146, 6]);
        await page.setViewportSize({ width: 390, height: 844 });
        assert.equal(await page.locator('#rehearsalMetronome').evaluate(el => el.scrollWidth > el.clientWidth), false);
        fs.mkdirSync(path.join(root, 'tmp', 'cue-presets'), { recursive: true });
        await page.locator('#rehearsalMetronome').scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(root, 'tmp', 'cue-presets', engine.name() + '.png') });
        await page.getByRole('button', { name: '메트로놈 접기', exact: true }).click();
        assert.equal(await page.locator('#rehearsalMetroBpm').isVisible(), false);
        assert.equal(await page.evaluate(() => rehearsalMetro.running), false);
        await page.evaluate(() => selectRehearsalCue(1));
        assert.equal(await page.getByRole('button', { name: '메트로놈 펼치기', exact: true }).getAttribute('aria-expanded'), 'false');
        await page.reload(); await page.evaluate(setup);
        assert.equal(await page.locator('#rehearsalMetroBpm').isVisible(), false, 'reload lost collapsed state');
        await page.evaluate(() => {
          rehearsalItems[rehearsalIndex].kind = 'video'; renderRehearsalCue();
        });
        assert.equal(await page.locator('#rehearsalMetronome').count(), 1, 'video retains metronome');
        assert.equal(await page.locator('#rehearsalMetroBpm').isVisible(), false, 'video retains collapsed state');
        await page.evaluate(() => {
          rehearsalItems[rehearsalIndex].kind = 'song'; renderRehearsalCue();
        });
        assert.equal(await page.locator('#rehearsalMetroBpm').isVisible(), false, 'video transition overwrote collapsed state');
        await page.getByRole('button', { name: '메트로놈 펼치기', exact: true }).click();
        await page.reload(); await page.evaluate(setup);
        assert.equal(await page.locator('#rehearsalMetroBpm').isVisible(), true, 'reload lost expanded state');
        await page.locator('#rehearsalMetronome select').selectOption('4');
        assert.equal(await page.locator('.rehearsal-metronome-beats span').count(), 4);
        assert.ok(await page.locator('.rehearsal-metronome-beats').evaluate(el => el.getBoundingClientRect().height >= 12));
        for (const width of [390, 820]) {
          await page.setViewportSize({ width, height: 1180 });
          assert.equal(await page.locator('#rehearsalMetronome').evaluate(el => el.scrollWidth > el.clientWidth), false);
          await page.locator('#rehearsalMetronome').scrollIntoViewIfNeeded();
          await page.screenshot({ path: path.join(root, 'tmp', 'cue-presets', engine.name() + '-fold-' + width + '.png') });
        }
        await page.evaluate(() => startRehearsalCue('other-concert'));
        await page.getByRole('button', { name: '메트로놈 접기', exact: true }).click();
        await page.evaluate(() => { testActor = 'director-b'; startRehearsalCue('other-concert'); });
        assert.equal(await page.locator('#rehearsalMetroBpm').isVisible(), true, 'collapsed state leaked between accounts');
        await page.evaluate(() => {
          Storage.prototype.setItem = function() { throw new Error('blocked'); };
          setRehearsalMetronome('bpm', 96);
        });
        assert.equal(await page.locator('#rehearsalMetroSaved').innerText(), '기기 저장 실패');
        assert.deepEqual(errors, []);
        console.log(engine.name(), 'PASS per-song BPM/beats, reload, reorder, duplicates, event/actor isolation, storage failure and mobile layout');
      } finally { await browser.close(); }
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
