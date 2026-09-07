const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const clone = x => JSON.parse(JSON.stringify(x));
const noop = () => {};
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function load(ctx, names) {
  for (const name of names) {
    const match = html.match(new RegExp('^function ' + name + '\\([^]*?^}', 'm'));
    assert.ok(match, name); vm.runInContext(match[0], ctx);
  }
}
function seating() {
  const pending = deferred(); const values = { seatingPlanName: 'test', seatingTitle: 'test', seatingProgram: 'test', seatingDate: '2026-09-13' };
  const state = { writes: [], drafts: 0, clears: 0, sync: [], reloads: 0 };
  const c = vm.createContext({
    console: { error: noop }, document: { getElementById: id => ({ value: values[id] || '' }) },
    seatingPlanId: 'plan', seatingPlans: [{ id: 'plan', updatedAt: 'old' }], seatingPlanLoadedVersions: { plan: 'old' }, seatingPlanHistory: [],
    seatingAttendees: {}, seatingAttendeesLocked: false, seatingAutoFit: false, seatingPartSubmissions: {},
    seatingRows: [{ label: '0단', seats: [{ name: 'before' }] }], seatingOrchestraRows: [], seatingMicSlots: [], seatingSpecialSlots: {}, seatingCenterOffset: 0,
    seatingDirty: true, seatingUndoStack: [1], seatingRedoStack: [], seatingSaveBusy: false, seatingEditorEpoch: 0,
    canUseSeatingPlan: () => true, currentActorName: () => 'editor', seatingPlacementStats: () => ({}), seatingCreatePlanId: () => 'new-plan',
    cloneSeatingValue: clone, normalizeSeatingPartSubmissions: clone, normalizeSeatingSpecialSlots: clone, normalizeSeatingCenterOffset: x => x,
    showToast: noop, writeLog: noop, upsertLocalSeatingPlan: noop, renderSeatingPlanSelect: noop,
    renderSeatingDraftBar: noop, renderSeatingWorkspaceShell: noop, renderSeatingHistory: noop,
    saveSeatingPlanRecord: data => { state.writes.push(clone(data)); return pending.promise; },
    clearSeatingDraft: () => { state.clears++; }, markSeatingDirty: () => { c.seatingDirty = true; },
    saveSeatingDraftNow: () => { state.drafts++; },
    loadSeatingPlans: () => { state.reloads++; return Promise.resolve([]); },
    syncPublishedSeatingPlanAfterSave: (data, old, publication) => { state.sync.push(clone(publication)); return Promise.resolve(false); },
    buildPublishedSeatingPlanData: () => ({ rows: clone(c.seatingRows) }),
    seatingSnapshot: () => ({ planId: c.seatingPlanId, planName: values.seatingPlanName, rows: c.seatingRows })
  });
  load(c, ['clearSeatingDirty', 'seatingSaveFingerprint', 'saveSeatingPlan']);
  return { c, pending, state, values };
}
function schedules() {
  const elements = {};
  const doc = { getElementById: id => elements[id] || (elements[id] = { value: '', checked: false, disabled: false, textContent: '', dataset: {} }) };
  doc.getElementById('schDate').value = doc.getElementById('schEndDate').value = '2026-09-13';
  doc.getElementById('schTitle').value = 'test';
  doc.getElementById('schSaveBtn').textContent = '일정 추가';
  const store = new Map(); const state = { transactions: 0, writes: 0, logs: 0, failAfterCommit: false, gate: null, updatedIds: [] };
  const c = vm.createContext({
    console: { error: noop }, document: doc, window: { crypto: webcrypto }, Uint32Array,
    adminRole: 'admin', currentUser: { id: 'editor' }, registrationBusy: {}, registrationAttempts: {},
    scheduleEditId: '', scheduleDirectEditActive: false, scheduleDirectEditReturnDate: '', scheduleProgramTypeDraft: [], selColor: 'green', allSchedules: [],
    canManageSchedules: () => true, canEditScheduleItem: () => true, currentActorName: () => 'editor', currentActorId: () => 'editor',
    scheduleMonthKeysForRange: () => ['2026-09'], scheduleDateRangeLabel: () => 'date', currentTab: 'home',
    saveLoadedScheduleMonthCaches: noop, invalidateHomeEventHubCache: noop, loadSchAdmin: noop, showToast: noop,
    writeLog: () => { state.logs++; }, getTodayInputDate: () => '2026-09-07', securityErrorMessage: (error, message) => message,
    resetScheduleForm: () => { doc.getElementById('schTitle').value = ''; c.scheduleEditId = ''; },
    db: {
      collection: () => ({ doc: id => ({ id, update: async data => { state.updatedIds.push(id); if (state.gate) await state.gate.promise; store.set(id, clone(data)); } }) }),
      runTransaction: async callback => {
        state.transactions++;
        if (state.gate) await state.gate.promise;
        const result = await callback({
          get: async ref => ({ exists: store.has(ref.id), data: () => clone(store.get(ref.id)) }),
          set: (ref, data) => { state.writes++; store.set(ref.id, clone(data)); }
        });
        if (state.failAfterCommit) { state.failAfterCommit = false; throw new Error('response-lost'); }
        return result;
      }
    }
  });
  load(c, ['startRegistration', 'finishRegistration', 'registrationRequestId', 'scheduleFormState', 'addSchedule']);
  return { c, doc, state, store };
}
(async () => {
  for (const mode of ['unchanged', 'edited', 'switched', 'failed']) {
    const { c, pending, state, values } = seating();
    const save = c.saveSeatingPlan(); c.saveSeatingPlan(); await tick();
    assert.equal(state.writes.length, 1, 'concurrent saves not blocked');
    if (mode === 'edited') { c.seatingRows[0].seats[0].name = 'after'; values.seatingPlanName = 'new name'; c.seatingUndoStack.push(2); }
    if (mode === 'switched') { c.seatingPlanId = 'other'; c.seatingEditorEpoch++; c.seatingRows = [{ label: 'other', seats: [] }]; }
    if (mode === 'failed') pending.reject(new Error('failed')); else pending.resolve('doc');
    await save;
    assert.equal(c.seatingSaveBusy, false);
    assert.equal(state.reloads, 0, 'save must not reload and overwrite current editor');
    if (mode === 'unchanged') { assert.equal(c.seatingDirty, false); assert.equal(state.clears, 1); }
    else { assert.equal(c.seatingDirty, true); assert.equal(state.clears, 0); assert.ok(c.seatingUndoStack.length); }
    if (mode === 'edited') {
      assert.equal(c.seatingRows[0].seats[0].name, 'after'); assert.equal(state.drafts, 1);
      assert.equal(state.writes[0].rows[0].seats[0].name, 'before');
      assert.equal(state.sync[0].rows[0].seats[0].name, 'before', 'uncommitted edits leaked to publication');
    }
    if (mode === 'switched') assert.equal(c.seatingPlanId, 'other');
  }
  const freshPlan = seating(); freshPlan.c.seatingPlanId = ''; freshPlan.c.seatingUndoStack = [{ planId: '' }];
  const freshSave = freshPlan.c.saveSeatingPlan(); await tick();
  freshPlan.c.seatingRows[0].seats[0].name = 'new edit';
  freshPlan.pending.resolve('doc'); await freshSave;
  assert.equal(freshPlan.c.seatingPlanId, 'new-plan');
  assert.equal(freshPlan.c.seatingUndoStack[0].planId, 'new-plan', 'undo after first save detaches the saved plan');
  const s = schedules(); s.state.gate = deferred();
  const first = s.c.addSchedule(); s.c.addSchedule(); await tick();
  assert.equal(s.state.transactions, 1); assert.equal(s.doc.getElementById('schSaveBtn').disabled, true);
  s.state.gate.resolve(); await first;
  assert.equal(s.store.size, 1); assert.equal(s.doc.getElementById('schSaveBtn').disabled, false);
  const replay = schedules(); replay.state.failAfterCommit = true;
  await replay.c.addSchedule();
  assert.equal(replay.doc.getElementById('schTitle').value, 'test');
  assert.equal(replay.c.registrationBusy.schedule, false);
  await replay.c.addSchedule();
  assert.equal(replay.store.size, 1); assert.equal(replay.state.writes, 1); assert.equal(replay.state.logs, 0);
  const edit = schedules(); edit.c.scheduleEditId = 'old-id'; edit.c.allSchedules = [{ id: 'old-id' }]; edit.state.gate = deferred();
  const saving = edit.c.addSchedule(); await tick();
  edit.c.scheduleEditId = 'other-id'; edit.doc.getElementById('schTitle').value = 'other title';
  edit.state.gate.resolve(); await saving;
  assert.deepEqual(edit.state.updatedIds, ['old-id']);
  assert.equal(edit.doc.getElementById('schTitle').value, 'other title');
  assert.equal(edit.c.allSchedules[0].id, 'old-id');

  let requests = 0; let pending = deferred();
  const q = { where() { return this; }, limit() { return this; }, get() { requests++; return pending.promise; } };
  const month = vm.createContext({
    console: { error: noop }, setTimeout, clearTimeout, allSchedules: [], schedulesLoaded: false,
    scheduleLoadedMonths: {}, scheduleMonthPromises: {}, scheduleMonthErrors: {}, scheduleMonthRequestTokens: {},
    scheduleMonthKey: key => key, scheduleMonthCacheKey: key => key, loadCache: () => null, saveCache: noop,
    scheduleRowMonthKeys: row => [row.month], scheduleRowFromDoc: doc => doc,
    mergeScheduleMonthRows: (key, rows) => { month.allSchedules = rows; month.scheduleLoadedMonths[key] = true; },
    db: { collection: () => q }
  });
  load(month, ['withLoadDeadline', 'loadScheduleMonth']);
  const deadline = month.withLoadDeadline;
  month.withLoadDeadline = promise => deadline(promise, 30);
  await month.loadScheduleMonth('2026-09', false);
  assert.equal(month.scheduleLoadedMonths['2026-09'], undefined); assert.ok(month.scheduleMonthErrors['2026-09']);
  await month.loadScheduleMonth('2026-09', false); assert.equal(requests, 1, 'error caused automatic retry loop');
  pending = deferred();
  const recovery = month.loadScheduleMonth('2026-09', true);
  assert.equal(month.loadScheduleMonth('2026-09', false), recovery, 'inflight request not reused');
  pending.resolve({ forEach: fn => fn({ id: 'fresh', month: '2026-09' }) }); await recovery;
  assert.equal(month.allSchedules[0].id, 'fresh'); assert.equal(month.scheduleMonthErrors['2026-09'], undefined);
  pending = deferred(); const stalePending = pending;
  const stale = month.loadScheduleMonth('2026-09', true); await tick();
  pending = deferred(); const latest = month.loadScheduleMonth('2026-09', true); await tick();
  pending.resolve({ forEach: fn => fn({ id: 'latest', month: '2026-09' }) }); await latest;
  stalePending.resolve({ forEach: fn => fn({ id: 'stale', month: '2026-09' }) }); await stale;
  assert.equal(month.allSchedules[0].id, 'latest');
  console.log('PASS: seating save/edit/switch/failure and publication snapshot; schedule double click, committed retry replay, input preservation, captured edit ID; load timeout, explicit retry, request reuse and stale response protection');
  const http = require('node:http');
  const { chromium } = require('playwright');
  const pageHtml = html.replace(/^init\(\);\r?$/m, '').replace(/^initInstallUi\(\);\r?$/m, '');
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(pageHtml); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.route(/firestore\.googleapis\.com|firebasestorage\.googleapis\.com|cloudfunctions\.net/, route => route.abort());
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(() => {
      ensureScoreRealtimeSync = () => Promise.resolve([]); requestHomeRender = () => {};
      calYear = 2026; calMonth = 8; currentTab = 'calendar'; allSongs = []; allSchedules = [];
      window.fixtureMonthRequests = 0;
      const query = { where() { return this; }, limit() { return this; }, get() {
        window.fixtureMonthRequests++;
        if (window.fixtureMonthRequests === 1) return Promise.reject(new Error('fixture-offline'));
        return Promise.resolve({ forEach: fn => fn({ id: 'fixture-event', data: () => ({ date: '2026-09-13', endDate: '2026-09-13', title: '테스트 일정', monthKeys: ['2026-09'] }) }) });
      } };
      db = { collection: () => query };
      document.querySelectorAll('.tab-page').forEach(el => el.classList.add('hidden'));
      document.getElementById('pageCalendar').classList.remove('hidden');
      renderCal();
    });
    const retry = page.locator('#calGrid').getByRole('button', { name: '다시 시도' });
    await retry.waitFor();
    for (const width of [390, 820]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(await page.locator('#calGrid').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
      fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
      await page.locator('#pageCalendar').screenshot({ path: path.join(root, 'tmp', 'calendar-retry-' + width + '.png') });
    }
    await retry.click();
    await page.waitForFunction(() => scheduleLoadedMonths['2026-09'] && !scheduleMonthPromises['2026-09']);
    assert.equal(await retry.count(), 0);
    assert.equal(await page.evaluate(() => window.fixtureMonthRequests), 2);
    assert.equal(await page.evaluate(() => allSchedules[0].id), 'fixture-event');
    await page.evaluate(() => {
      currentTab = 'admin'; canManageSchedules = () => true;
      document.getElementById('pageCalendar').classList.add('hidden');
      document.getElementById('pageAdmin').classList.remove('hidden');
      document.getElementById('subSchedule').classList.remove('hidden');
      resetScheduleForm('2026-09-13');
      window.fixtureWrites = 0;
      db = {
        collection: () => ({ doc: id => ({ id }) }),
        runTransaction: () => { window.fixtureWrites++; return new Promise((resolve, reject) => { window.rejectFixtureWrite = reject; }); }
      };
    });
    await page.locator('#schTitle').fill('실패 후에도 유지할 일정');
    await page.locator('#schSaveBtn').click();
    assert.equal(await page.locator('#schSaveBtn').isDisabled(), true);
    await page.evaluate(() => { addSchedule(); window.rejectFixtureWrite(new Error('fixture-save-failed')); });
    await page.waitForFunction(() => !registrationBusy.schedule);
    assert.equal(await page.evaluate(() => window.fixtureWrites), 1);
    assert.equal(await page.locator('#schTitle').inputValue(), '실패 후에도 유지할 일정');
    assert.equal(await page.locator('#schSaveBtn').isEnabled(), true);
    assert.deepEqual(errors, []);
    console.log('PASS: calendar retry UI 390/820px, successful recovery, real save button lock and input retention after failure');
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
