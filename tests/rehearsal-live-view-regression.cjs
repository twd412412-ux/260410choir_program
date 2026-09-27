const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium, webkit } = require('playwright');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/^init\(\);\r?$/m, '').replace(/^initInstallUi\(\);\r?$/m, '');

(async () => {
  const server = http.createServer((req, res) => {
    if (require('./serve-firebase-sdk.cjs')(req, res)) return;
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const output = path.join(root, 'tmp/cue-live-view'); fs.mkdirSync(output, { recursive: true });
  try {
    for (const engine of [chromium, webkit]) {
      const browser = await engine.launch(engine === chromium ? { channel: 'msedge' } : {});
      try {
        const page = await browser.newPage({ viewport: { width: 820, height: 1180 }, hasTouch: true });
        const errors = []; page.on('pageerror', error => errors.push(error.stack));
        await page.route(/googleapis\.com|cloudfunctions\.net/, route => route.abort());
        await page.goto(`http://127.0.0.1:${server.address().port}`);
        await page.evaluate(() => {
          firebaseAuthReady = false; adminRole = 'admin';
          ensureScoreRealtimeSync = async () => []; getPublishedSeatingPlan = async () => null;
          currentActorId = () => 'preview';
          allSchedules = [{ id: 'preview', title: '찬양의밤', date: '2026-10-18', time: '19:00', useBriefing: true,
            program: '내 주는 강한 성이요\n주의 손에 나의 손을 포개고\n어린아이처럼\n일어나 걸어라\n주의 용사\n하나님의 사랑은\n축복하노라\n엘샤다이\n마음이 상한 자를\n갈보리 산 위에\n나의 안에 거하라\n은혜 아니면\n주님의 솜씨\n주께로 오시오\n험한 십자가\n야곱의 축복\n오라\n주님\n모든 것 주셨네\n아 하나님의 은혜로',
            rehearsalPlan: { startTime: '19:00', cues: [{ id: 'video', kind: 'video', title: '소개 영상', before: '', note: '영상 종료 후 다음 순서' }] } }];
          document.getElementById('modalRehearsalCue').classList.add('active'); startRehearsalCue('preview');
          rehearsalTimerSeconds = 1455; refreshRehearsalTimerUi();
        });
        assert.equal(await page.locator('#rehearsalToolsPanel').isVisible(), false);
        assert.match(await page.locator('#rehearsalClockValue').innerText(), /^\d{2}:\d{2}:\d{2}$/);
        await page.locator('#rehearsalTimerToggle').click();
        assert.equal(await page.locator('#rehearsalTimerPauseIcon').isVisible(), true);
        assert.equal(await page.locator('#rehearsalTimerReset').isEnabled(), false);
        await page.locator('#rehearsalTimerToggle').click();
        assert.equal(await page.locator('#rehearsalTimerPlayIcon').isVisible(), true);
        assert.equal(await page.locator('#rehearsalTimerReset').isEnabled(), true);
        page.once('dialog', dialog => dialog.dismiss());
        await page.locator('#rehearsalTimerReset').click();
        assert.ok(await page.evaluate(() => rehearsalTimerSeconds >= 1455));
        page.once('dialog', dialog => dialog.accept());
        await page.locator('#rehearsalTimerReset').click();
        assert.equal(await page.locator('#rehearsalTimerValue').innerText(), '00:00');
        assert.equal(await page.locator('#rehearsalTimerReset').isEnabled(), false);
        await page.getByRole('button', { name: '도구 펼치기', exact: true }).click();
        await page.locator('#rehearsalCueNote').fill('2절부터 반주');
        await page.getByRole('button', { name: '큐 구성', exact: true }).click();
        await page.locator('#concertExtraTitle').fill('입장 확인');
        await page.evaluate(() => { toggleRehearsalTimer(); rehearsalTimerStartedAt = Date.now() - 1455000; });
        const body = await page.locator('#rehearsalCueBody').elementHandle();
        await page.waitForTimeout(1100);
        assert.equal(await page.evaluate(el => el === document.getElementById('rehearsalCueBody'), body), true);
        assert.equal(await page.locator('#concertExtraTitle').inputValue(), '입장 확인');
        await page.getByRole('button', { name: '도구 접기', exact: true }).click();
        await page.getByRole('button', { name: '도구 펼치기', exact: true }).click();
        assert.equal(await page.locator('#concertExtraTitle').inputValue(), '입장 확인');
        assert.equal(await page.locator('#rehearsalCueNote').inputValue(), '2절부터 반주');
        await page.evaluate(() => { cancelConcertEditor(); setRehearsalToolsOpen(false); selectRehearsalCue(1); });
        assert.ok(await page.evaluate(() => rehearsalTimerRunning && rehearsalTimerSeconds >= 1455));
        await page.evaluate(() => {
          rehearsalTimerStartedAt = Date.now() - 1500000;
          document.dispatchEvent(new Event('visibilitychange'));
        });
        assert.equal(await page.locator('#rehearsalTimerValue').innerText(), '25:00');
        await page.evaluate(() => { pauseRehearsalTimer(); selectRehearsalCue(rehearsalItems.length - 1); });
        assert.equal(await page.locator('#rehearsalMetronome').count(), 0);
        await page.evaluate(() => selectRehearsalCue(1));
        await page.evaluate(() => { rehearsalTimerSeconds = 3661; refreshRehearsalTimerUi(); });
        for (const [width, height] of [[320, 740], [390, 844], [844, 390], [820, 1180], [1180, 820]]) {
          await page.setViewportSize({ width, height });
          for (const light of [false, true]) {
            await page.evaluate(light => document.getElementById('modalRehearsalCue').classList.toggle('theme-light', light), light);
            assert.equal(await page.locator('#rehearsalCueShell').evaluate(el => el.scrollWidth > el.clientWidth + 1), false, `${width}: horizontal overflow`);
            for (const selector of ['.rehearsal-live-time', '.rehearsal-live-actions']) {
              assert.equal(await page.locator(selector).first().evaluate(el => el.scrollWidth > el.clientWidth + 1), false, `${width}: timer controls overflow`);
            }
            const before = await page.locator('#rehearsalLiveStatus').boundingBox();
            const footer = await page.locator('#rehearsalCueControls').boundingBox();
            assert.ok(footer.y + footer.height <= height + 1, `${width}: footer clipped`);
            assert.ok(before.y >= 0 && before.y + before.height < footer.y, `${width}: status clipped`);
            const scroller = width > 760 && height > 500 ? '.rehearsal-side' : '#rehearsalCueBody';
            const moved = await page.locator(scroller).evaluate(el => { el.scrollTop = 250; return el.scrollTop; });
            assert.ok(moved > 0, `${width}: list cannot scroll`);
            assert.equal((await page.locator('#rehearsalLiveStatus').boundingBox()).y, before.y);
            await page.locator(scroller).evaluate(el => { el.scrollTop = 0; });
            await page.screenshot({ path: path.join(output, `${engine.name()}-${width}-${light ? 'light' : 'dark'}.png`) });
          }
        }
        await page.evaluate(() => teardownRehearsalCue());
        assert.equal(await page.evaluate(() => rehearsalClockId), null);
        assert.deepEqual(errors, []);
        console.log('PASS ' + engine.name() + ': fixed clock/timer, draft preservation, background recovery, video, phone/tablet themes, scrolling and teardown');
      } finally { await browser.close(); }
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
