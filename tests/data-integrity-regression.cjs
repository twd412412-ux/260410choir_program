const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');

(async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8')
    .replace(/^init\(\);\r?$/m, '').replace(/^initInstallUi\(\);\r?$/m, '');
  const server = http.createServer((req, res) => {
    if (req.url === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(html);
    } else if (/^\/assets\/[a-zA-Z0-9_.-]+$/.test(req.url)) {
      const asset = path.join(__dirname, '..', req.url.slice(1));
      if (fs.existsSync(asset)) { res.setHeader('Content-Type', 'image/png'); res.end(fs.readFileSync(asset)); }
      else { res.statusCode = 404; res.end(); }
    } else { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, channel: 'msedge' });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    // Firebase SDK assets are allowed; all production database/storage requests are blocked.
    await page.route(/firestore\.googleapis\.com|firebasestorage\.googleapis\.com|cloudfunctions\.net/, route => route.abort());
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const integrity = await page.evaluate(async () => {
      function check(value, message) { if (!value) throw new Error(message); }
      const clone = value => JSON.parse(JSON.stringify(value));
      const store = new Map(), revisions = new Map();
      let failCommit = false, retries = 0, writes = 0;
      function put(key, value) { store.set(key, clone(value)); revisions.set(key, (revisions.get(key) || 0) + 1); }
      function snapshot(key) { return { id: key.split('/').pop(), exists: store.has(key), data: () => clone(store.get(key)) }; }
      db = {
        collection: collection => ({ doc: id => ({ key: collection + '/' + id, get: async () => snapshot(collection + '/' + id) }) }),
        runTransaction: async callback => {
          for (let attempt = 0; attempt < 8; attempt++) {
            const reads = new Map(), pending = [];
            const result = await callback({
              get: async ref => { reads.set(ref.key, revisions.get(ref.key) || 0); return snapshot(ref.key); },
              set: (ref, value, options) => pending.push({ ref, value: clone(value), merge: options && options.merge }),
              delete: ref => pending.push({ ref, remove: true })
            });
            if ([...reads].some(([key, version]) => (revisions.get(key) || 0) !== version)) { retries++; continue; }
            if (failCommit) throw new Error('fixture-commit-failed');
            for (const op of pending) {
              if (op.remove) { store.delete(op.ref.key); revisions.set(op.ref.key, (revisions.get(op.ref.key) || 0) + 1); }
              else put(op.ref.key, op.merge ? Object.assign({}, store.get(op.ref.key), op.value) : op.value);
              writes++;
            }
            return result;
          }
          throw new Error('fixture-retries-exhausted');
        }
      };
      const key = 'attendance/2026-09-06_오전';
      const baseline = { records: { a: '출석', b: '출석', c: '지각' }, reasons: {}, preserved: 'keep' };
      put(key, baseline);
      await Promise.all([
        saveAttendanceChanges('2026-09-06_오전', baseline, [{ id: 'a', name: 'S1', status: '지각', reason: '' }], {}, null),
        saveAttendanceChanges('2026-09-06_오전', baseline, [{ id: 'b', name: 'S2', status: '사유결석', reason: '출장' }], {}, null)
      ]);
      check(store.get(key).records.a === '지각' && store.get(key).records.b === '사유결석', 'concurrent parts lost records');
      check(store.get(key).records.c === '지각' && store.get(key).preserved === 'keep', 'untouched records/metadata changed');
      check(retries > 0, 'transaction retry not exercised');
      let conflict = false;
      try { await saveAttendanceChanges('2026-09-06_오전', baseline, [{ id: 'a', name: 'S1', status: '', reason: '' }], {}, null); }
      catch (error) { conflict = error.code === 'attendance-conflict'; }
      check(conflict && store.get(key).records.a === '지각', 'same member conflict overwritten');
      await saveAttendanceChanges('2026-09-06_오전', clone(store.get(key)), [{ id: 'b', name: 'S2', status: '', reason: '' }], {}, null);
      check(!store.get(key).records.b && !store.get(key).reasons.b && store.get(key).records.a === '지각', 'clear touched other part');
      const fresh = clone(store.get(key));
      await saveAttendanceChanges('2026-09-06_오전', fresh, [{ id: 'c', name: 'T1', status: '출석', reason: '' }], {}, { excludeFromReport: true, excludeReason: '행사' });
      await saveAttendanceChanges('2026-09-06_오전', fresh, [{ id: 'a', name: 'S1', status: '출석', reason: '' }], {}, null);
      check(store.get(key).excludeFromReport && store.get(key).excludeReason === '행사', 'report setting lost');
      check(attendanceChanges(baseline, { a: '출석', b: '출석', c: '지각' }, {}, [{ id: 'a' }, { id: 'b' }, { id: 'c' }]).length === 0, 'unchanged rows should not write');

      currentActorName = () => 'fixture';
      const legacyKey = 'settings/' + SEATING_PLAN_LEGACY_DOC;
      const planKey = id => SEATING_PLAN_COLLECTION + '/' + id;
      const old = { id: 'one', name: 'old', updatedAt: '2026-09-01', rows: [], attendees: {} };
      const newer = { ...old, name: 'newer legacy', updatedAt: '2026-09-02' };
      const other = { ...old, id: 'two' };
      put(planKey('one'), old);
      put(legacyKey, { plans: [newer, other], preserved: true });
      check(mergeSeatingPlanLists([old], [newer])[0].name === 'newer legacy', 'newer legacy lost');
      const updated = { ...newer, name: 'canonical', updatedAt: '2026-09-03' };
      failCommit = true;
      let rejected = false;
      try { await saveSeatingPlanRecord(updated, newer.updatedAt, false); } catch { rejected = true; }
      check(rejected && store.get(planKey('one')).name === 'old' && store.get(legacyKey).plans.length === 2, 'partial save reported success');
      failCommit = false;
      await Promise.all([
        saveSeatingPlanRecord(updated, newer.updatedAt, false),
        saveSeatingPlanRecord({ ...other, name: 'second', updatedAt: '2026-09-04' }, other.updatedAt, false)
      ]);
      check(store.get(planKey('one')).name === 'canonical' && store.get(planKey('two')).name === 'second', 'different plans overwrote each other');
      check(store.get(legacyKey).plans.length === 0 && store.get(legacyKey).preserved, 'migration lost unrelated settings');
      let seatingConflict = false;
      try { await saveSeatingPlanRecord({ ...updated, name: 'stale' }, newer.updatedAt, false); }
      catch (error) { seatingConflict = error.code === 'seating_plan_conflict'; }
      check(seatingConflict && store.get(planKey('one')).name === 'canonical', 'seating conflict overwritten');
      seatingPlanLoadedVersions = { one: updated.updatedAt };
      failCommit = true;
      try { await deleteSeatingPlanRecord('one'); } catch {}
      check(store.has(planKey('one')), 'failed deletion removed plan');
      failCommit = false;
      await deleteSeatingPlanRecord('one');
      check(!store.has(planKey('one')) && store.has(planKey('two')), 'deletion touched other plan');
      let resurrected = false;
      try { await saveSeatingPlanRecord(updated, updated.updatedAt, false); resurrected = true; } catch {}
      check(!resurrected, 'stale save resurrected deleted plan');
      const realLoadDocs = loadSeatingPlanDocs, realLoadLegacy = loadLegacySeatingPlans, realApply = applyLoadedSeatingPlans;
      let applied = false;
      loadSeatingPlanDocs = async () => { throw new Error('fixture-doc-read-failed'); };
      loadLegacySeatingPlans = async () => [old];
      applyLoadedSeatingPlans = () => { applied = true; };
      try { await loadSeatingPlans(); } catch {}
      check(!applied, 'incomplete seating load replaced current screen');
      loadSeatingPlanDocs = realLoadDocs; loadLegacySeatingPlans = realLoadLegacy; applyLoadedSeatingPlans = realApply;
      return { retries, writes, conflict, seatingConflict };
    });
    assert.ok(integrity.conflict && integrity.seatingConflict);

    const attendance = await page.evaluate(async () => {
      adminRole = 'admin';
      currentUser = null;
      canViewAttendance = () => true;
      canCheckAttendance = () => true;
      getAttendanceAllowedParts = () => ['all', 'S1', 'S2'];
      loadSharedMembers = async () => [{ id: 'a', name: '테스트 단원', part: 'S1' }];
      isAttendanceTargetMember = () => true;
      filterAttendanceMembersForDate = rows => rows;
      attMembersLoaded = false; attMembersSourceLoaded = false;
      document.getElementById('attDate').value = '2026-09-06';
      let fail = true;
      db = { collection: () => ({ doc: () => ({ get: async () => {
        if (fail) throw new Error('fixture-load-failed');
        return { exists: true, data: () => ({ records: { a: '출석' }, reasons: {} }) };
      } }) }) };
      attData = { retained: '출석' };
      await loadAttendance();
      const failure = attLoadError && document.getElementById('attSaveBtn').disabled && !!document.querySelector('#attList button');
      const retained = attData.retained === '출석';
      setAtt('a', '지각');
      const blocked = !attData.a;
      await saveAttendance();
      fail = false;
      await loadAttendance();
      const recovered = !attLoadError && !document.getElementById('attSaveBtn').disabled && attData.a === '출석';
      attData.a = '지각';
      setAttSession('오후'); setAttSession('오전');
      const retainedSession = attData.a === '지각' && attBaselines['2026-09-06_오전'].records.a === '출석';
      // Delayed older requests must not replace the selected date.
      let release;
      db.collection = () => ({ doc: id => ({ get: () => id.startsWith('2026-09-13')
        ? new Promise(resolve => { (release || (release = [])).push(() => resolve({ exists: true, data: () => ({ records: { a: '무단결석' } }) })); })
        : Promise.resolve({ exists: true, data: () => ({ records: { a: '출석' } }) }) }) });
      document.getElementById('attDate').value = '2026-09-13';
      const oldRequest = loadAttendance();
      await new Promise(resolve => setTimeout(resolve, 0));
      document.getElementById('attDate').value = '2026-09-20';
      await loadAttendance();
      release.forEach(resolve => resolve()); await oldRequest;
      const latestOnly = attLoadedDate === '2026-09-20' && attData.a === '출석';
      let timedOut = false;
      try { await withLoadDeadline(new Promise(() => {}), 5); } catch { timedOut = true; }
      attMembersLoaded = false; attMembersSourceLoaded = false;
      loadSharedMembers = async () => { throw new Error('fixture-member-read-failed'); };
      await loadAttendance();
      const memberFailure = attLoadError && !attLoading && document.getElementById('attSaveBtn').disabled;
      return { failure, retained, blocked, recovered, retainedSession, latestOnly, timedOut, memberFailure };
    });
    Object.entries(attendance).forEach(([key, value]) => assert.ok(value, key));

    const saveScope = await page.evaluate(async () => {
      attLoading = false; attLoadError = false; attSaving = false;
      attLoadedDate = '2026-09-06'; attSession = '오전'; attPartFilter = 'S1';
      document.getElementById('attDate').value = attLoadedDate;
      document.getElementById('attSaveBtn').disabled = false;
      attMembers = [{ id: 'a', name: 'S1 단원', part: 'S1' }, { id: 'b', name: 'S2 단원', part: 'S2' }, { id: 'c', name: 'T1 단원', part: 'T1' }];
      getAttendanceAllowedParts = () => ['S1', 'S2'];
      canManageAttendanceReportExclusion = () => false;
      attBaselines = { '2026-09-06_오전': { records: { a: '출석', b: '출석', c: '출석' }, reasons: {} } };
      attData = { a: '지각', b: '사유결석', c: '무단결석' }; attReasons = { b: '출장' };
      const original = saveAttendanceChanges, originalLoad = loadAttendance;
      let captured;
      saveAttendanceChanges = async (id, baseline, changes) => { captured = changes; };
      loadAttendance = async () => {};
      writeLog = () => {};
      await saveAttendance();
      const ids = captured.map(change => change.id).sort();
      saveAttendanceChanges = async () => { throw new Error('fixture-save-failed'); };
      await saveAttendance();
      const preserved = attData.a === '지각' && attData.b === '사유결석' && !attSaving;
      saveAttendanceChanges = original; loadAttendance = originalLoad;
      return { ids, preserved };
    });
    assert.deepEqual(saveScope.ids, ['a', 'b'], 'save must include edits across allowed parts, excluding unauthorized parts');
    assert.ok(saveScope.preserved, 'failed save lost edits');

    await page.evaluate(() => {
      currentTab = 'home'; adminRole = ''; currentUser = null;
      document.querySelectorAll('.page').forEach(el => el.classList.add('hidden'));
      document.getElementById('pageHome').classList.remove('hidden');
      canAccessHomeAttendance = () => false;
      canViewSongList = () => true;
      canViewScores = () => false;
      canShowHomeEventHub = () => false;
      canUseMemberHandbook = () => false;
      canUseRehearsalCue = () => false;
      canSeeHomePianistAssignments = () => false;
      findVisibleScoresForSong = () => [];
      loadCache = () => null;
      allSongs = []; allSchedules = []; songsLoaded = false; schedulesLoaded = false;
      publishedSeatingLoaded = false; publishedSeatingPlan = null; publishedSeatingPlans = [];
      homeEventSchedules = [];
      window.homeFixture = { counts: { songs: 0, schedules: 0, seating: 0 }, failSchedules: true };
      initSongs = () => {
        homeFixture.counts.songs++;
        return new Promise(resolve => { homeFixture.finishSongs = () => {
          const date = getFeaturedSunday(new Date());
          allSongs = [{ id: 'fixture', songName: '먼저 도착한 찬송곡', year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() }];
          songsLoaded = true; resolve(allSongs);
        }; });
      };
      ensureScheduleRange = async () => {
        homeFixture.counts.schedules++;
        if (homeFixture.failSchedules) throw new Error('fixture-schedule-failure');
        allSchedules = [{ id: 'schedule', title: '정상 일정', date: getTodayInputDate(), endDate: getTodayInputDate(), time: '16:00' }];
        return allSchedules;
      };
      getPublishedSeatingPlan = () => {
        homeFixture.counts.seating++;
        return new Promise(resolve => { homeFixture.finishSeating = () => { publishedSeatingLoaded = true; resolve(null); }; });
      };
      renderHome();
    });
    await page.waitForSelector('[data-home-retry="schedules"]');
    await page.evaluate(() => homeFixture.finishSongs());
    await page.waitForFunction(() => document.getElementById('homeContent').textContent.includes('먼저 도착한 찬송곡'));
    assert.equal(await page.evaluate(() => publishedSeatingLoaded), false, 'songs waited for seating');
    await page.evaluate(() => { homeFixture.failSchedules = false; homeFixture.songNode = document.querySelector('[data-home-region="songs"] .home-dashboard'); });
    await page.click('[data-home-retry="schedules"]');
    await page.waitForFunction(() => document.getElementById('homeContent').textContent.includes('정상 일정'));
    assert.deepEqual(await page.evaluate(() => homeFixture.counts), { songs: 1, schedules: 2, seating: 1 });
    assert.ok(await page.evaluate(() => homeFixture.songNode === document.querySelector('[data-home-region="songs"] .home-dashboard')), 'unrelated home section replaced');
    await page.evaluate(() => homeFixture.finishSeating());
    await page.waitForFunction(() => document.querySelector('.home-hymn-art img').complete && document.querySelector('.home-hymn-art img').naturalWidth > 0);
    for (const width of [390, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'home overflow at ' + width);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => document.getElementById('toast').classList.remove('show'));
    await page.screenshot({ path: path.join(__dirname, '..', 'tmp', 'data-integrity-home-mobile.png'), fullPage: true });
    assert.deepEqual(errors, []);
    console.log('PASS: concurrent attendance, conflict protection, clear/reasons, report preservation, seating migration/delete atomicity, failure/retry, stale responses, independent home updates, responsive layouts');
    console.log(JSON.stringify({ integrity, attendance, saveScope }, null, 2));
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
