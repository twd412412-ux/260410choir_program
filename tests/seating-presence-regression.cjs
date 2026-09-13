const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium } = require('playwright');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { doc, setDoc, deleteDoc, getDocs, collection, serverTimestamp, Timestamp } = require('firebase/firestore');
const root = path.resolve(__dirname, '..'), projectId = 'demo-choir-presence';
const html = fs.readFileSync(process.env.SEATING_TEST_HTML || path.join(root, 'index.html'), 'utf8').replace(/^init\(\);\r?$/m, '').replace(/^initInstallUi\(\);\r?$/m, '');
(async () => {
  const env = await initializeTestEnvironment({ projectId, firestore: { rules: fs.readFileSync(path.join(root, 'firestore.rules'), 'utf8') } });
  const server = http.createServer((req, res) => { if (require('./serve-firebase-sdk.cjs')(req, res)) return; res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  const claims = (uid, permissions) => ({ sub: uid, user_id: uid, account: true, admin: false, elevatedUntil: 0, legacyRole: '', choirName: uid, permissions });
  try {
    const editor = env.authenticatedContext('editor', claims('editor', ['seating.edit'])).firestore();
    const viewer = env.authenticatedContext('viewer', claims('viewer', ['seating.manage'])).firestore();
    const member = env.authenticatedContext('member', claims('member', [])).firestore();
    const payload = (uid, state) => ({ uid, name: uid, state, seenAt: serverTimestamp(), expiresAt: Timestamp.fromMillis(Date.now() + 600000) });
    const ref = 'seatingPlans/rules/seatingPresence/session';
    await assertSucceeds(setDoc(doc(editor, ref), payload('editor', 'editing')));
    await assertFails(setDoc(doc(viewer, ref), payload('viewer', 'viewing')));
    await assertFails(deleteDoc(doc(viewer, ref)));
    await assertFails(setDoc(doc(viewer, ref + '-v'), payload('viewer', 'editing')));
    await assertSucceeds(setDoc(doc(viewer, ref + '-v'), payload('viewer', 'viewing')));
    await assertFails(setDoc(doc(editor, ref), { ...payload('editor', 'viewing'), name: '다른사람' }));
    await assertFails(setDoc(doc(editor, ref), { ...payload('editor', 'viewing'), seenAt: Timestamp.fromMillis(1) }));
    await assertFails(setDoc(doc(editor, ref), { ...payload('editor', 'viewing'), expiresAt: Timestamp.fromMillis(Date.now() + 86400000) }));
    await assertFails(getDocs(collection(member, 'seatingPlans/rules/seatingPresence')));
    await assertFails(getDocs(collection(env.unauthenticatedContext().firestore(), 'seatingPlans/rules/seatingPresence')));
    await assertSucceeds(getDocs(collection(viewer, 'seatingPlans/rules/seatingPresence')));
    await assertSucceeds(deleteDoc(doc(editor, ref)));
    const plan = { id: 'plan-a', name: '전체 합창', date: '2026-10-18', program: '전체 합창', title: '찬양의밤', updatedAt: '2026-09-13T00:00:00.000Z',
      rows: [{ label: '1단', seats: [null, null, null, null] }, { label: '0단', seats: [null, null, null, null] }], attendees: { m1: true }, orchestraRows: [] };
    await env.withSecurityRulesDisabled(async context => {
      await setDoc(doc(context.firestore(), 'seatingPlans/plan-a'), plan);
      await setDoc(doc(context.firestore(), 'seatingPlans/plan-b'), { ...plan, id: 'plan-b', name: '여성 합창' });
      await setDoc(doc(context.firestore(), 'settings/seatingPlans'), { plans: [] });
    });
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const errors = [];
    async function open(uid, permissions, width, height) {
      const page = await browser.newPage({ viewport: { width, height } });
      page.on('pageerror', e => errors.push(e.stack));
      await page.route(/firestore\.googleapis\.com|firebasestorage\.googleapis\.com|cloudfunctions\.net/, route => route.abort());
      await page.goto('http://127.0.0.1:' + server.address().port);
      await page.evaluate(({ uid, permissions, plan, host, projectId, token }) => {
        fixture = { uid, writes: 0, toasts: [] };
        const app = firebase.initializeApp({ ...firebase.app().options, projectId }, uid);
        db = app.firestore(); const parts = host.split(':'); db.useEmulator(parts[0], Number(parts[1]), { mockUserToken: token });
        seatingPresenceAuthUser = () => ({ uid });
        firebaseAuthReady = true; firebaseAuthChecking = false; currentTab = 'admin'; adminRole = 'custom';
        currentUser = { id: uid, name: uid, permissions };
        ensureScoreRealtimeSync = () => Promise.resolve([]); getPublishedSeatingPlan = () => Promise.resolve(null);
        scheduleSecureAuthClaimsRefresh = () => {}; refreshSecureAuthClaims = () => Promise.resolve(false);
        showToast = text => fixture.toasts.push(text); writeLog = () => {};
        syncPublishedSeatingPlanAfterSave = () => Promise.resolve(false);
        const makePayload = seatingPresencePayload;
        seatingPresencePayload = (state, mode) => { fixture.writes++; return makePayload(state, mode); };
        const sub = document.getElementById('subSeatingPlan'); document.body.appendChild(sub);
        [...document.body.children].forEach(el => { if (el !== sub && el.tagName !== 'SCRIPT' && !el.classList.contains('modal-overlay')) el.style.display = 'none'; });
        document.getElementById('pageAdmin').classList.remove('hidden'); sub.classList.remove('hidden'); sub.style.removeProperty('display'); sub.classList.add('seating-fullscreen');
        seatingSettingsOpen = false; seatingMemberPanelCollapsed = true;
        seatingMembers = [{ id: 'm1', name: '단원', part: 'S1' }]; seatingPlans = [plan, { ...plan, id: 'plan-b', name: '여성 합창' }]; rememberSeatingPlanVersions(seatingPlans);
        applySeatingPlan(plan);
      }, { uid, permissions, plan, host: process.env.FIRESTORE_EMULATOR_HOST, projectId, token: claims(uid, permissions) });
      await page.waitForFunction(() => seatingPresence && seatingPresence.ready && !seatingPresence.writePromise, null, { timeout: 20000 });
      return page;
    }
    const a = await open('지휘자', ['seating.edit'], 820, 1180);
    const b = await open('파트장', ['seating.edit'], 390, 844);
    await a.waitForFunction(() => seatingPresencePeers(seatingPresence).some(p => p.name === '파트장'));
    const top = await a.locator('#seatingBoard').evaluate(el => el.getBoundingClientRect().top);
    await b.evaluate(() => { seatingPresence.lastWriteAt = 0; seatingRows[0].seats[0] = { memberId: 'm1', name: '단원', part: 'S1' }; markSeatingDirty(); });
    await a.waitForFunction(() => document.getElementById('seatingPresenceSummary').textContent.includes('파트장 편집 중'));
    assert.equal(await a.locator('#seatingBoard').evaluate(el => el.getBoundingClientRect().top), top, 'presence change must not shift seating targets');
    await a.evaluate(() => { seatingRows[1].seats[2] = { memberId: 'm1', name: '내 수정', part: 'S1' }; markSeatingDirty(); });
    assert.ok((await a.locator('#seatingPresenceSummary').textContent()).includes('동시 편집'));
    await b.evaluate(() => saveSeatingPlan());
    await a.waitForFunction(() => !document.getElementById('seatingPresenceLoad').hidden);
    assert.equal(await a.evaluate(() => seatingRows[1].seats[2].name), '내 수정');
    await a.evaluate(() => { window.confirm = () => false; loadSeatingPresenceLatest(); });
    assert.equal(await a.evaluate(() => seatingRows[1].seats[2].name), '내 수정');
    await a.evaluate(() => { window.confirm = () => true; loadSeatingPresenceLatest(); });
    assert.equal(await a.evaluate(() => seatingRows[0].seats[0].name), '단원');
    assert.equal(await a.evaluate(() => seatingDirty), false);
    const count = await a.evaluate(() => fixture.writes);
    await a.evaluate(() => { for (let i = 0; i < 40; i++) markSeatingDirty(); });
    assert.ok((await a.evaluate(() => fixture.writes)) <= count + 1, 'seat edits must not emit one presence write each');
    await b.evaluate(() => { seatingPresence.lastWriteAt = 0; seatingPresence.lastActiveAt = Date.now() - SEATING_PRESENCE_IDLE_MS - 1; writeSeatingPresence(seatingPresence); });
    await a.waitForFunction(() => seatingPresencePeers(seatingPresence).some(p => p.state === 'away'));
    await b.evaluate(() => { stopSeatingPresence(true); });
    await b.evaluate(() => { syncSeatingPresence(); });
    await a.waitForFunction(() => seatingPresencePeers(seatingPresence).some(p => p.name === '파트장' && p.state !== 'away'));
    assert.equal(await a.evaluate(() => seatingPresencePeers(seatingPresence).filter(p => p.name === '파트장').length), 1, 'same-account sessions should not duplicate the name');
    await b.evaluate(() => applySeatingPlan(seatingPlans.find(p => p.id === 'plan-b')));
    // The earlier background marker expires independently and must never look like an active editor.
    await a.waitForFunction(() => !seatingPresencePeers(seatingPresence).some(p => p.name === '파트장' && p.state !== 'away'));
    const viewerPage = await open('조회자', ['seating.manage'], 844, 390);
    assert.equal(await viewerPage.evaluate(() => seatingPresenceMode(seatingPresence)), 'viewing');
    assert.equal(await viewerPage.evaluate(() => canUseSeatingPlan()), false);
    await a.evaluate(() => { seatingPresence.people.push({ uid: 'expired', name: '만료됨', state: 'editing', seenAt: { toMillis: () => Date.now() - SEATING_PRESENCE_STALE_MS - 1 } }); });
    assert.equal(await a.evaluate(() => seatingPresencePeers(seatingPresence).some(p => p.name === '만료됨')), false);
    await a.context().setOffline(true);
    await a.waitForFunction(() => seatingPresence === null);
    assert.ok((await a.locator('#seatingPresenceSummary').textContent()).includes('연결 확인'));
    await a.context().setOffline(false);
    await a.waitForFunction(() => seatingPresence && seatingPresence.ready && !seatingPresence.writePromise);
    assert.equal(await a.evaluate(() => seatingDirty), true, 'reconnect must retain the local draft');
    const out = path.join(root, 'tmp/seating-presence'); fs.mkdirSync(out, { recursive: true });
    for (const [page, label] of [[a, 'ipad'], [b, 'iphone'], [viewerPage, 'landscape']]) {
      const bounds = await page.locator('#seatingPresenceBar').boundingBox(); const viewport = page.viewportSize();
      assert.ok(bounds.width > 0 && bounds.x >= -1 && bounds.x + bounds.width <= viewport.width + 1);
      await page.screenshot({ path: path.join(out, label + '.png') });
    }
    for (const page of [a, b, viewerPage]) await page.evaluate(() => { currentTab = 'home'; syncSeatingPresence(); if (seatingPresence) throw Error('listener retained outside seating'); });
    assert.deepEqual(errors, []);
    console.log('PASS: Firestore rules, two-client viewing/editing/idle, fixed-height status, save notification, dirty draft protection, explicit reload, write throttling, expiry, plan isolation, offline/reconnect, viewer access and responsive layouts');
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); await env.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
