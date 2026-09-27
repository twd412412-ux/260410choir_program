const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), vm = require('node:vm');
const { chromium, webkit } = require('playwright');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/^init\(\);\r?$/m, '').replace(/^initInstallUi\(\);\r?$/m, '');
const source = fs.readFileSync(path.join(root, 'functions/index.js'), 'utf8');
const serverContext = vm.createContext({});
for (const name of ['ALLOWED_PERMISSIONS', 'PRESET_PERMISSIONS', 'LEGACY_PERMISSIONS']) {
  const match = source.match(new RegExp('^const ' + name + ' = [^]*?^\\](?:\\))?;|^const ' + name + ' = [^]*?^};', 'm'));
  assert.ok(match, name);
  vm.runInContext(match[0], serverContext);
}
for (const name of ['cleanString', 'uniqueAllowed', 'accountPermissions']) {
  vm.runInContext(source.match(new RegExp('^function ' + name + '\\([^]*?^}', 'm'))[0], serverContext);
}
assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext("accountPermissions({permissionPreset:'custom',permissions:['rehearsal.view','rehearsal.view','not.allowed']})", serverContext))), ['rehearsal.view']);
assert.equal(vm.runInContext("accountPermissions({permissionPreset:'partLeader'}).includes('rehearsal.view')", serverContext), false);

(async () => {
  const server = http.createServer((req, res) => { if (require('./serve-firebase-sdk.cjs')(req, res)) return; res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const engine of [chromium, webkit]) {
      const browser = await engine.launch(engine === chromium ? { channel: 'msedge' } : {});
      try {
        const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
        const errors = []; page.on('pageerror', error => errors.push(error.stack));
        await page.route(/googleapis\.com|cloudfunctions\.net/, route => route.abort());
        await page.goto(`http://127.0.0.1:${server.address().port}`);
        await page.evaluate(() => {
          firebaseAuthReady = true; adminRole = 'custom';
          currentUser = { id: 'viewer', name: '조회 단원', part: 'S1', permissionPreset: 'custom', permissions: ['rehearsal.view'] };
          ensureScoreRealtimeSync = async () => []; resumeScoreRealtimeSync = syncPublishedSeatingLive = () => {};
          refreshPublishedSeatingOnResume = async () => null;
          window.toasts = []; showToast = message => toasts.push(message);
          window.fixture = { reads: 0, writes: 0 };
          db = { runTransaction: async () => { fixture.writes++; throw Error('unexpected write'); } };
          allSchedules = [{ id: 'concert', title: '찬양의밤', date: '2026-10-18', useBriefing: true, program: '첫 곡\n둘째 곡', createdById: 'author' }];
          document.getElementById('pageHome').classList.add('hidden');
          window.editorMarkup = renderPermissionEditor('custom', ['rehearsal.view'], [], 'default');
          openRehearsalCue('concert');
        });
        assert.equal(await page.evaluate(() => canUseRehearsalCue()), true);
        assert.equal(await page.evaluate(() => canOpenAdminArea()), false, 'cue-only viewers must not see an empty management area');
        assert.equal(await page.evaluate(() => showScheduleCueShortcut(allSchedules[0])), true);
        assert.match(await page.evaluate(() => editorMarkup), /value="rehearsal\.view" checked/);
        assert.equal(await page.locator('#modalRehearsalCue').evaluate(el => el.classList.contains('active')), true);
        assert.equal(await page.getByRole('button', { name: '큐 구성', exact: true }).count(), 0);
        assert.equal(await page.evaluate(async () => { openConcertEditor(); return [rehearsalPlanDraft === null, await saveConcertPlan(), fixture.writes]; }).then(JSON.stringify), JSON.stringify([true, false, 0]));
        assert.deepEqual(await page.evaluate(() => {
          const schedule = allSchedules[0];
          currentUser.permissions = ['rehearsal.view', 'schedule.manage'];
          const other = canEditScheduleItem(schedule);
          const own = canEditScheduleItem({ ...schedule, createdById: currentUser.id });
          currentUser.permissions.push('schedule.editAny');
          return [other, own, canEditScheduleItem(schedule)];
        }), [false, true, true]);
        await page.evaluate(() => {
          openConcertEditor();
          db = { collection: () => ({ doc: id => ({ id }) }), runTransaction: async fn => fn({
            get: async () => { fixture.reads++; currentUser.permissions = ['schedule.editAny']; return { exists: true, data: () => allSchedules[0] }; },
            update: () => { fixture.writes++; }
          }) };
        });
        assert.equal(await page.evaluate(() => saveConcertPlan()), false, 'revoked view access must stop an in-flight save');
        assert.equal(await page.evaluate(() => fixture.writes), 0);
        assert.deepEqual(await page.evaluate(() => {
          cancelConcertEditor(); currentUser.permissions = []; openRehearsalCue('concert');
          const denied = !canUseRehearsalCue() && toasts.at(-1).includes('권한');
          currentUser.part = '지휘'; const conductor = canUseRehearsalCue();
          currentUser = null; adminRole = 'admin'; const admin = canUseRehearsalCue();
          adminRole = ''; firebaseAuthReady = false;
          currentUser = { id: 'cached', name: '캐시 단원', permissions: ['rehearsal.view'] };
          return [denied, conductor, admin, canUseRehearsalCue()];
        }), [true, true, true, false]);
        assert.deepEqual(errors, []);
        console.log('PASS ' + engine.name() + ': cue view permission, editor checkbox, no implicit edit rights, own/other schedule scope, in-flight revocation, admin/conductor compatibility');
      } finally { await browser.close(); }
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
