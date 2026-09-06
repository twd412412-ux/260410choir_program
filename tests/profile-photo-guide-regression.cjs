const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');

(async () => {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8')
    .replace(/^init\(\);\r?$/m, '').replace(/^initInstallUi\(\);\r?$/m, '');
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, channel: 'msedge' });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const errors = [];
    page.on('pageerror', error => errors.push(error.stack));
    await page.route(/firestore\.googleapis\.com|firebasestorage\.googleapis\.com|cloudfunctions\.net/, route => route.abort());
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(() => {
      firebaseAuthReady = true; firebaseAuthChecking = false;
      syncAccessShell = () => {}; renderPushSettings = () => {}; routePushTarget = () => {};
      refreshHomeAccessState = () => {}; requestHomeRender = () => {}; updateAdminTabs = () => {};
      initSongs = async () => []; scheduleScoresLoad = () => {}; tryApplyPendingAppUpdate = () => {};
      resumeScoreRealtimeSync = () => {}; ensureScoreRealtimeSync = () => {}; getPublishedSeatingPlan = async () => null;
      invalidateSharedMembers = () => {}; deleteStoragePhotoByUrl = async () => {};
      renderMyScorePartSettings = () => ''; currentTab = 'home';
      document.getElementById('notificationBellBtn').classList.remove('hidden');
      document.querySelectorAll('.page').forEach(el => el.classList.remove('active'));
      document.getElementById('pageHome').classList.add('active');
      window.photoReads = 0; window.photoWrites = 0;
      window.photoSaveFails = false;
      window.photoMember = { name: '테스트 단원', part: 'S1', status: 'active', photo: '' };
      window.photoReadMode = 'ok';
      window.photoReadDelay = 0;
      window.photoAuthAccount = 'manual-account';
      window.photoAuthReject = false;
      const fakeAuthUser = () => ({
        uid: photoAuthAccount,
        getIdTokenResult: async () => ({ claims: { account: true, choirName: '테스트 단원', choirPart: 'S1', memberId: 'member-a' } })
      });
      authGateway = async action => {
        if (action !== 'loginWithPin') throw new Error('Unexpected auth action: ' + action);
        if (photoAuthReject) throw new Error('Test login failure');
        return { token: 'test-only-token' };
      };
      ensureFirebaseAuth = async () => ({
        currentUser: null,
        signInWithCustomToken: async () => ({ user: fakeAuthUser() }),
        onAuthStateChanged: callback => { setTimeout(() => callback(fakeAuthUser()), 0); return () => {}; }
      });
      db = { collection: name => {
        if (name !== 'members') throw new Error('Unexpected collection: ' + name);
        return { doc: id => ({
          get: async () => {
            photoReads++;
            if (photoReadDelay) await new Promise(resolve => setTimeout(resolve, photoReadDelay));
            if (photoReadMode === 'failure') throw new Error('Test offline');
            return { id, exists: photoReadMode !== 'missing', data: () => ({ ...photoMember }) };
          },
          update: async changes => {
            if (photoSaveFails) throw new Error('Test save failure');
            photoWrites++; Object.assign(photoMember, changes);
          }
        }) };
      } };
      window.photoLogin = async (id = 'account-a', memberId = 'member-a') => {
        currentUser = { id, name: '테스트 단원', part: 'S1', memberId };
        updateUserBar();
        await refreshAfterSecureAuth(false);
        await new Promise(resolve => setTimeout(resolve, 0));
      };
    });
    const guide = page.locator('#modalProfilePhotoGuide');
    for (const delay of [0, 250]) {
      await page.evaluate(delay => {
        currentUser = null; updateUserBar();
        photoReadDelay = delay; photoReads = 0; photoAuthAccount = 'manual-account-' + delay;
        openUserModal();
      }, delay);
      await page.locator('#userNameInput').fill('테스트 단원');
      await page.locator('#userPinInput').fill('1234');
      await page.locator('#userModalBody button[onclick="loginUser()"]').click();
      await page.waitForFunction(() => !document.getElementById('modalUser').classList.contains('active'));
      await page.waitForTimeout(delay + 900);
      const loginState = await page.evaluate(() => ({
        eligible: !!needsProfilePhotoGuide(), handled: profilePhotoGuide.handled,
        visible: document.getElementById('modalProfilePhotoGuide').classList.contains('active'), reads: photoReads
      }));
      assert.ok(loginState.visible, 'real PIN login must display guide: ' + JSON.stringify(loginState));
      assert.equal(loginState.reads, 1, 'PIN login should not load a hidden profile a second time');
      await page.keyboard.press('Escape');
    }
    await page.evaluate(async () => {
      currentUser = null; updateUserBar(); photoReads = 0; photoReadDelay = 0;
      photoAuthAccount = 'restored-account'; firebaseAuthReadyPromise = null; firebaseAuthChecking = false;
      localStorage.setItem('choir_user', JSON.stringify({ id: photoAuthAccount, name: '테스트 단원', memberId: 'member-a', part: 'S1' }));
      await restoreUser();
    });
    await guide.waitFor({ state: 'visible', timeout: 3000 });
    assert.equal(await page.evaluate(() => photoReads), 1, 'restored login reuses member read');
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => {
      profilePhotoGuide.handled = false;
      renderCurrentUserProfile(photoMember, 'ready');
      return profilePhotoGuide.handled;
    }), false, 'rendering a hidden profile is not a user acknowledgement');
    await page.evaluate(() => openUserModal());
    await page.locator('#myProfilePhotoSelectBtn').waitFor({ state: 'visible' });
    await page.evaluate(() => closeModal('modalUser'));
    await page.waitForTimeout(800);
    assert.equal(await guide.isVisible(), false, 'explicitly opening profile suppresses another prompt this session');
    await page.evaluate(async () => {
      currentUser = null; updateUserBar(); photoReadDelay = 250;
      photoAuthAccount = 'restored-with-dialog'; firebaseAuthReadyPromise = null; firebaseAuthChecking = true;
      localStorage.setItem('choir_user', JSON.stringify({ id: photoAuthAccount, name: '테스트 단원', memberId: 'member-a', part: 'S1' }));
      openUserModal();
      await restoreUser();
      closeModal('modalUser');
    });
    await guide.waitFor({ state: 'visible', timeout: 3000 });
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      currentUser = null; updateUserBar(); photoReadDelay = 0; photoAuthReject = true; openUserModal();
    });
    await page.locator('#userNameInput').fill('테스트 단원');
    await page.locator('#userPinInput').fill('1234');
    await page.locator('#userModalBody button[onclick="loginUser()"]').click();
    await page.waitForTimeout(800);
    assert.equal(await guide.isVisible(), false, 'failed authentication must not display guide');
    assert.equal(await page.locator('#userModalBody button[onclick="loginUser()"]').isEnabled(), true);
    await page.evaluate(() => { photoAuthReject = false; closeModal('modalUser'); photoReads = 0; });
    await page.evaluate(() => photoLogin());
    await guide.waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => photoReads), 1, 'reuse the existing login member read');
    const screenshotDir = path.join(__dirname, '../tmp/profile-photo-guide');
    fs.mkdirSync(screenshotDir, { recursive: true });
    for (const [name, viewport, dark] of [
      ['phone', { width: 390, height: 844 }, false],
      ['small-phone', { width: 320, height: 568 }, false],
      ['landscape', { width: 844, height: 390 }, false],
      ['tablet-dark', { width: 820, height: 1180 }, true],
      ['desktop', { width: 1440, height: 900 }, false]
    ]) {
      await page.setViewportSize(viewport);
      await page.evaluate(dark => { document.body.classList.toggle('dark', dark); positionProfilePhotoGuide(); }, dark);
      const geometry = await page.evaluate(() => {
        const target = document.getElementById('profileButton').getBoundingClientRect();
        const spot = document.getElementById('profilePhotoSpotlight').getBoundingClientRect();
        const panel = document.getElementById('profilePhotoGuidePanel').getBoundingClientRect();
        return {
          anchored: Math.abs(spot.left - (target.left - 5)) < 1 && Math.abs(spot.top - (target.top - 5)) < 1,
          visible: panel.left >= 0 && panel.right <= innerWidth && panel.bottom <= innerHeight,
          noOverlap: panel.top > spot.bottom,
          hit: document.elementFromPoint(target.left + target.width / 2, target.top + target.height / 2).id
        };
      });
      assert.ok(geometry.anchored && geometry.visible && geometry.noOverlap, name + ' geometry');
      assert.equal(geometry.hit, 'profilePhotoSpotlight', name + ' clickable spotlight');
      await page.screenshot({ path: path.join(screenshotDir, name + '.png') });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#profilePhotoSpotlight').focus();
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement.textContent), '사진 등록', 'focus stays inside guide');
    await page.locator('#profilePhotoSpotlight').click();
    await page.locator('#myProfilePhotoSelectBtn').waitFor({ state: 'visible' });
    assert.equal(await guide.isVisible(), false);
    assert.equal(await page.evaluate(() => photoReads), 1, 'guided profile reuses freshly loaded member');
    await page.locator('#modalUser .modal-content').evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)));
    assert.ok(await page.locator('#myProfilePhotoSelectBtn').evaluate(el => {
      const rect = el.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight;
    }), 'photo registration action is visible without manual scrolling');
    await page.screenshot({ path: path.join(screenshotDir, 'profile.png') });

    // Exercise the real file picker and crop UI, but never upload to production storage.
    const png = await page.locator('#profileButton').screenshot();
    const picker = page.waitForEvent('filechooser');
    await page.locator('#myProfilePhotoSelectBtn').click();
    await (await picker).setFiles({ name: 'profile-test.png', mimeType: 'image/png', buffer: png });
    await page.locator('#modalPhotoCrop.active').waitFor();
    await page.evaluate(() => closeModal('modalPhotoCrop'));
    const failed = await page.evaluate(async () => {
      document.getElementById('myProfilePhotoUrl').value = 'https://example.invalid/profile-test.jpg';
      photoSaveFails = true;
      return saveMyProfilePhoto();
    });
    assert.equal(failed, false);
    assert.equal(await page.locator('#myProfilePhotoSaveBtn').isVisible(), true, 'failed save exposes retry action');
    assert.equal(await page.locator('#myProfilePhotoSaveBtn').isEnabled(), true);
    assert.equal(await page.locator('#myProfilePhotoUrl').inputValue(), 'https://example.invalid/profile-test.jpg');
    const saved = await page.evaluate(async () => { photoSaveFails = false; return saveMyProfilePhoto(); });
    assert.equal(saved, true);
    assert.equal(await page.evaluate(() => photoWrites), 1);
    await page.evaluate(() => { closeModal('modalUser'); profilePhotoGuide.handled = false; scheduleProfilePhotoGuide(); });
    await page.waitForTimeout(800);
    assert.equal(await guide.isVisible(), false, 'saved photo stops the guide');
    await page.evaluate(() => photoLogin('account-with-photo'));
    await page.waitForTimeout(800);
    assert.equal(await guide.isVisible(), false, 'existing photo skips guide on new session');

    await page.evaluate(async () => { photoMember.photo = ''; await photoLogin('account-b'); });
    await guide.waitFor({ state: 'visible' });
    await page.getByRole('button', { name: '나중에', exact: true }).click();
    await page.evaluate(() => { updateUserBar(); syncLayoutState(); scheduleProfilePhotoGuide(); });
    await page.waitForTimeout(800);
    assert.equal(await guide.isVisible(), false, 'dismissed guide does not repeat during session');
    await page.evaluate(() => { currentUser = null; updateUserBar(); });
    await page.evaluate(() => photoLogin('account-b'));
    await guide.waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    assert.equal(await guide.isVisible(), false);

    for (const mode of ['failure', 'missing', 'inactive', 'unlinked']) {
      await page.evaluate(async mode => {
        photoReadMode = ['failure', 'missing'].includes(mode) ? mode : 'ok';
        photoMember.status = mode === 'inactive' ? 'inactive' : 'active';
        await photoLogin('account-' + mode, mode === 'unlinked' ? '' : 'member-a');
      }, mode);
      await page.waitForTimeout(800);
      assert.equal(await guide.isVisible(), false, mode + ' must not falsely ask for a photo');
    }
    await page.evaluate(async () => {
      photoReadMode = 'ok'; photoMember.status = 'active';
      openModal('modalFeatureUpdate'); await photoLogin('account-deferred');
    });
    await page.waitForTimeout(800);
    assert.equal(await guide.isVisible(), false, 'do not cover an existing dialog');
    await page.evaluate(() => closeModal('modalFeatureUpdate'));
    await guide.waitFor({ state: 'visible' });
    await page.evaluate(() => { currentUser = null; updateUserBar(); });
    assert.equal(await guide.isVisible(), false, 'logout immediately removes guide');
    assert.equal(await page.evaluate(() => document.body.classList.contains('modal-open')), false);

    await page.evaluate(async () => {
      let finish;
      db.collection = () => ({ doc: id => ({ get: () => new Promise(resolve => { finish = () => resolve({ id, exists: true, data: () => photoMember }); }) }) });
      currentUser = { id: 'old-account', name: '이전 단원', memberId: 'old-member' }; updateUserBar();
      const pending = hydrateUserLinkedMember(currentUser);
      currentUser = { id: 'new-account', name: '새 단원', memberId: 'new-member' }; updateUserBar();
      finish(); await pending;
    });
    await page.waitForTimeout(800);
    assert.equal(await guide.isVisible(), false, 'late old-account reads cannot trigger new-account guide');
    assert.deepEqual(errors, [], 'no uncaught browser errors');
    console.log('PASS: real PIN login (fast/slow), restored login (with/without dialog), rejected login, explicit profile acknowledgement, read reuse, responsive spotlight, picker/crop, save, dismissal, account isolation');
    console.log('Screenshots: ' + screenshotDir);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
