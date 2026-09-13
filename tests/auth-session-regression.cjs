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
    const errors = []; page.on('pageerror', error => errors.push(error.stack));
    await page.route(/firestore\.googleapis\.com|firebasestorage\.googleapis\.com|cloudfunctions\.net/, route => route.abort());
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.evaluate(() => {
      window.fixture = { tokenReads: 0, memberReads: 0, writes: 0, signouts: 0, toasts: [] };
      firebaseAuthChecking = false; firebaseAuthReady = true; currentTab = 'admin';
      updateUserBar = () => {}; syncAccessShell = () => {}; refreshHomeAccessState = () => {};
      ensureScoreRealtimeSync = () => Promise.resolve([]); resumeScoreRealtimeSync = () => {};
      clearScoreAccessCache = () => {}; initSongs = () => Promise.resolve([]); scheduleScoresLoad = () => {};
      requestHomeRender = () => {}; scheduleProfilePhotoGuide = () => {}; scheduleSecureAuthClaimsRefresh = () => {};
      getPublishedSeatingPlan = () => Promise.resolve(null); resetArchiveReactionSession = () => {};
      showToast = message => fixture.toasts.push(message); writeLog = () => {};
      window.baseClaims = { account: true, choirName: '시험단원', choirPart: 'S1', memberId: 'm1', permissions: ['seating.manage'], role: '', permissionPreset: '', attendanceScope: [], scoreAccessScope: 'default' };
      window.editClaims = { ...baseClaims, permissions: ['seating.manage', 'seating.edit'] };
      window.tokenClaims = baseClaims;
      window.firebaseUserFixture = { uid: 'account-a', getIdTokenResult: async () => { fixture.tokenReads++; return { claims: tokenClaims }; } };
      window.authFixture = { currentUser: firebaseUserFixture, signOut: async () => { fixture.signouts++; authFixture.currentUser = null; } };
      ensureFirebaseAuth = () => Promise.resolve(authFixture);
      removePushSubscription = () => Promise.resolve();
      db = { collection: () => ({ doc: () => ({ get: () => {
        fixture.memberReads++; return new Promise(resolve => { window.resolveMember = resolve; });
      } }) }) };
      const sub = document.getElementById('subSeatingPlan'); document.body.appendChild(sub);
      [...document.body.children].forEach(el => { if (el !== sub && el.tagName !== 'SCRIPT' && !el.classList.contains('modal-overlay')) el.style.display = 'none'; });
      sub.classList.remove('hidden'); sub.style.removeProperty('display'); sub.classList.add('seating-fullscreen');
      document.getElementById('pageAdmin').classList.remove('hidden');
      seatingSettingsOpen = false; seatingMemberPanelCollapsed = true;
      seatingMembers = [{ id: 'm1', name: '시험단원', part: 'S1' }];
      seatingPlans = [{ id: 'plan', name: '수정 중 배치', date: '2026-10-18', rows: createSeatingRows(2, 4), attendees: { m1: true }, updatedAt: 'v1' }];
      applySecureAuthState(firebaseUserFixture, baseClaims, null); applySeatingPlan(seatingPlans[0]);
      refreshAfterSecureAuth(false);
      tokenClaims = editClaims;
    });
    await page.evaluate(() => refreshSecureAuthClaims(true));
    assert.equal(await page.evaluate(() => canUseSeatingPlan()), true);
    await page.evaluate(async () => { resolveMember({ exists: true, data: () => ({ part: 'S1', subPart: '신입단원' }) }); await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.equal(await page.evaluate(() => canUseSeatingPlan()), true, 'late member hydration must not overwrite fresh edit permission');
    await page.evaluate(() => {
      seatingRows[0].seats[0] = { memberId: 'm1', name: '시험단원', part: 'S1' }; markSeatingDirty(); renderSeatingBoard();
      fixture.before = JSON.stringify(seatingRows);
      currentUser.permissions = ['seating.manage']; renderSeatingBoard();
    });
    assert.equal(await page.locator('#subSeatingPlan').evaluate(el => el.classList.contains('seating-readonly')), true);
    await page.evaluate(() => refreshSecureAuthClaims(false));
    assert.equal(await page.evaluate(() => canUseSeatingPlan()), true, 'unchanged verified token must repair drift without logging out');
    assert.equal(await page.locator('#subSeatingPlan').evaluate(el => el.classList.contains('seating-readonly')), false);
    assert.equal(await page.evaluate(() => seatingDirty && JSON.stringify(seatingRows) === fixture.before), true, 'refresh must preserve unsaved seating edits');
    const reads = await page.evaluate(() => fixture.tokenReads);
    await page.evaluate(() => refreshSecureAuthClaims(false));
    assert.equal(await page.evaluate(() => fixture.tokenReads), reads, 'healthy session must retain the refresh throttle');
    await page.evaluate(() => { refreshAfterSecureAuth(false); tokenClaims = baseClaims; });
    await page.evaluate(() => refreshSecureAuthClaims(true));
    await page.evaluate(async () => { resolveMember({ exists: true, data: () => ({ part: 'S1' }) }); await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.equal(await page.evaluate(() => canUseSeatingPlan()), false, 'actual edit revocation must remain enforced');
    await page.evaluate(() => {
      const profile = { permissions: ['seating.edit'], permissionPreset: '', role: '' };
      applySecureAuthState(firebaseUserFixture, baseClaims, profile);
    });
    assert.equal(await page.evaluate(() => canUseSeatingPlan()), false, 'login profile must not override verified token permissions');
    await page.evaluate(async () => {
      tokenClaims = editClaims; await refreshSecureAuthClaims(true);
      firebaseUserFixture.getIdTokenResult = () => Promise.reject(Object.assign(Error('offline'), { code: 'auth/network-request-failed' }));
      await refreshSecureAuthClaims(true);
    });
    assert.equal(await page.evaluate(() => canUseSeatingPlan()), true, 'transient network errors must not erase verified rights');
    await page.evaluate(async () => {
      firebaseUserFixture.getIdTokenResult = () => new Promise(resolve => { window.resolveToken = resolve; });
      window.pendingRefresh = refreshSecureAuthClaims(true); await new Promise(resolve => setTimeout(resolve, 0));
      const other = { uid: 'account-b' }; authFixture.currentUser = other;
      applySecureAuthState(other, baseClaims, null);
      resolveToken({ claims: editClaims }); await pendingRefresh;
    });
    assert.equal(await page.evaluate(() => currentUser.id), 'account-b', 'old token response must not restore a previous account');
    assert.equal(await page.evaluate(() => canUseSeatingPlan()), false);
    await page.evaluate(async () => {
      authFixture.currentUser = firebaseUserFixture; applySecureAuthState(firebaseUserFixture, editClaims, null);
      firebaseUserFixture.getIdTokenResult = () => new Promise((resolve, reject) => { window.rejectToken = reject; });
      window.pendingRefresh = refreshSecureAuthClaims(true); await new Promise(resolve => setTimeout(resolve, 0));
      const other = { uid: 'account-b' }; authFixture.currentUser = other; applySecureAuthState(other, baseClaims, null);
      rejectToken(Object.assign(Error('old expired token'), { code: 'auth/user-token-expired' })); await pendingRefresh;
    });
    assert.equal(await page.evaluate(() => currentUser.id), 'account-b', 'old failure must not log out a newer session');
    assert.equal(await page.evaluate(() => fixture.signouts), 0);
    await page.evaluate(async () => {
      authFixture.currentUser = firebaseUserFixture; applySecureAuthState(firebaseUserFixture, baseClaims, null);
      firebaseUserFixture.getIdTokenResult = () => new Promise(resolve => { window.resolveToken = resolve; });
      window.pendingRefresh = refreshSecureAuthClaims(true); await new Promise(resolve => setTimeout(resolve, 0));
      applySecureAuthState(firebaseUserFixture, editClaims, null);
      resolveToken({ claims: baseClaims }); await pendingRefresh;
    });
    assert.equal(await page.evaluate(() => canUseSeatingPlan()), true, 'old token response must not overwrite a newer session for the same account');
    assert.equal(await page.evaluate(() => fixture.memberReads), 2, 'claims refresh must not load the roster again');
    assert.deepEqual(errors, []);
    console.log('PASS: delayed hydration, permission drift repair, real revocation, claims authority, network failure, stale session response/error, throttling and unsaved seating preservation');
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
