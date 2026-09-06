const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const root = path.join(__dirname, '..');

(async () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
    .replace(/^init\(\);\r?$/m, '').replace(/^initInstallUi\(\);\r?$/m, '');
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.route(/firestore\.googleapis\.com|firebasestorage\.googleapis\.com|cloudfunctions\.net/, route => route.abort());
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(() => {
      adminRole = 'admin'; currentUser = null; songsLoaded = true; scoresLoaded = scoresLoadedPrivate = true;
      canManageScores = () => true; canEditScoreItem = () => true; canViewScoreItem = () => true;
      renderScoreManage = () => {}; renderScoresPage = () => {}; requestHomeRender = () => {}; writeLog = () => {};
      // Keep background catalogue refreshes on the same in-memory fixture as writes.
      ensureScoreRealtimeSync = () => Promise.resolve(allScores);
      allSongs = [
        { id: 'ko', songName: '엘샤다이', year: 2026, month: 9, day: 27, category: '주일찬송' },
        { id: 'alias', songName: '전능하신 주', year: 2026, month: 10, day: 4, category: '특송' },
        { id: 'both', songName: '엘샤다이 (El Shaddai)', year: 2026, month: 10, day: 11, category: '주일찬송' }
      ];
      allScores = [{ id: 'fixture-singer', title: 'El Shaddai', scoreKind: 'singer', public: true, linkedSongId: '', linkedSongIds: [], linkedSongName: '', versionNumber: 2, currentFilePath: 'scores/fixture-singer/original.pdf', currentFileName: 'El Shaddai.pdf', currentUploadedAt: '2026-09-01T00:00:00Z' }];
      window.calls = [];
      scoreAdminCall = async (action, data) => { window.calls.push({ action, data }); return { items: data.items }; };
      document.querySelectorAll('.tab-page').forEach(el => el.classList.add('hidden'));
      document.getElementById('pageAdmin').classList.remove('hidden');
      document.getElementById('subScoreManage').classList.remove('hidden');
      editScoreUpload('fixture-singer');
      setScoreCandidatePanelOpen(true);
    });
    const candidate = id => page.locator(`#scoreSongCandidates button[onclick*="'${id}'"]`);
    await page.locator('#scoreSongSearch').fill('엘샤다이');
    await candidate('ko').click();
    await page.locator('#scoreSongSearch').fill('전능하신 주');
    assert.ok(await candidate('ko').isVisible(), 'selection disappeared when query changed');
    await candidate('alias').click();
    assert.equal(await page.locator('#scoreTitle').inputValue(), 'El Shaddai', 'manual search changed the score title');
    await page.locator('#scoreTitle').fill('El Shaddai ');
    assert.equal(await page.evaluate(() => selectedScoreCandidateIds().length), 2, 'title edit lost manual selection');
    assert.equal(await page.locator('#scoreLinkApplyBtn').textContent(), '선택 적용 (2)');
    await candidate('alias').click();
    await page.locator('#scoreLinkApplyBtn').click();
    assert.deepEqual(await page.evaluate(() => getScoreLinkedSongIds()), ['ko']);
    assert.equal(await page.evaluate(() => window.calls.length), 0, 'selecting a link should not write before saving');
    for (const viewport of [{ width: 390, height: 844 }, { width: 820, height: 1180 }]) {
      await page.setViewportSize(viewport);
      await page.locator('#scoreSongCandidateBox').scrollIntoViewIfNeeded();
      assert.ok(await page.locator('#scoreSongCandidateBox').evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'link picker overflows');
      await page.locator('#scoreSongCandidateBox').screenshot({ path: path.join(root, 'tmp', 'manual-score-link-' + viewport.width + '.png') });
    }
    await page.locator('#scoreSaveBtn').click();
    await page.waitForFunction(() => window.calls.length === 1 && !document.getElementById('scoreSaveBtn').dataset.busy, null, { timeout: 5000 }).catch(async error => {
      console.error(await page.evaluate(() => ({ calls: window.calls, scores: allScores.map(score => score.id), editId: document.getElementById('scoreEditId').value, title: document.getElementById('scoreTitle').value, toast: document.getElementById('toast').textContent, busy: document.getElementById('scoreSaveBtn').dataset.busy })));
      throw error;
    });
    const result = await page.evaluate(() => ({ call: window.calls[0], score: allScores[0], linked: findScoresForSong(allSongs[0], true).map(score => score.id) }));
    assert.equal(result.call.action, 'upsert');
    assert.deepEqual(result.call.data.items[0].linkedSongIds, ['ko']);
    assert.equal(result.score.title, 'El Shaddai');
    assert.equal(result.score.versionNumber, 2);
    assert.equal(result.score.currentFilePath, 'scores/fixture-singer/original.pdf');
    assert.equal(result.score.currentFileName, 'El Shaddai.pdf');
    assert.equal(result.score.currentUploadedAt, '2026-09-01T00:00:00Z');
    assert.deepEqual(result.linked, ['fixture-singer']);
    assert.equal(await page.locator('#scoreSongSearch').inputValue(), '', 'saved form kept previous query');
    await page.evaluate(() => {
      resetScoreForm(); setScoreFormKind('orchestra');
      document.getElementById('scoreTitle').value = 'El Shaddai';
      document.getElementById('scoreSongSearch').value = '전능하신 주';
      setScoreCandidatePanelOpen(true); renderScoreSongCandidates();
    });
    await candidate('alias').click(); await page.locator('#scoreLinkApplyBtn').click();
    assert.deepEqual(await page.evaluate(() => getScoreLinkedSongIds()), ['alias'], 'orchestra form manual linking failed');
    await page.evaluate(() => { clearScoreLinkedSongs(); document.getElementById('scoreTitle').value = 'El Shaddai'; linkSameTitleScoreSongs(); });
    assert.deepEqual(await page.evaluate(() => selectedScoreCandidateIds()), ['both'], 'bilingual same-title selection failed');
    assert.deepEqual(errors, []);
    console.log('PASS: independent manual search for singer/orchestra, multi-selection retention/removal, no write until save, metadata-only singer save, file/version preservation, bilingual selection, 390/820px layout');
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
