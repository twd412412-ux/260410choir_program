const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const http = require('node:http');
const { chromium } = require('playwright');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'functions/index.js'), 'utf8');
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const parts = Array.from({ length: 20 }, (_, i) => ({
  id: 'score-' + i, title: 'El Shaddai', searchKey: 'elshaddai', scoreKind: 'orchestra',
  instrument: 'part-' + i, instrumentLabel: 'Part ' + i, public: i !== 19,
  currentFilePath: 'scores/score-' + i + '/original.pdf', currentFileName: 'Original ' + i + '.pdf',
  currentFileSize: 100, currentUploadedAt: '2026-09-01T00:00:00Z', versionNumber: i === 1 ? 2 : 1,
  archived: false, linkedSongId: '', linkedSongIds: [], linkedSongName: '',
  createdById: 'owner', createdAt: '2026-09-01T00:00:00Z', extraMetadata: { keep: true }
}));
const group = { ids: parts.map(p => p.id), expectedKey: 'title:elshaddai', title: '엘샤다이(El Shaddai)', linkedSongIds: ['song-sep27'], linkedSongName: '엘샤다이(El Shaddai)' };

function backend() {
  const docs = new Map(); let counter = 0, fail = false, beforeCommit = null;
  const db = {
    collection: name => ({ doc: (id = 'auto-' + (++counter)) => ({ key: name + '/' + id, id }) }),
    runTransaction: async callback => {
      for (;;) {
        const writes = [];
        await callback({
          get: async ref => ({ id: ref.id, ref, exists: docs.has(ref.key), data: () => clone(docs.get(ref.key)) }),
          set: (ref, value, options) => writes.push({ ref, value: clone(value), merge: options && options.merge })
        });
        if (beforeCommit) { const hook = beforeCommit; beforeCommit = null; hook(); continue; }
        if (fail) throw new Error('fixture-save-failed');
        writes.forEach(({ ref, value, merge }) => docs.set(ref.key, merge ? { ...docs.get(ref.key), ...value } : value));
        break;
      }
    }
  };
  class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
  const context = vm.createContext({
    db, crypto, Buffer, HttpsError, SCORE_CATALOG_VERSION: 1, SCORE_CATALOG_SHARDS: { singer: 2, orchestra: 8 }, SCORE_LEGACY_MIRROR_MAX_BYTES: 800000,
    isValidDocumentId: id => typeof id === 'string' && /^[\w-]+$/.test(id),
    isAdminRequest: req => req.auth.token.admin === true,
    hasPermission: (req, p) => req.permissions.includes(p),
    requirePermission: (req, p) => { if (!req.permissions.includes(p)) throw new HttpsError('permission-denied', p); },
    cleanupReplacedScoreFiles: async rows => assert.equal(rows.length, 0, 'metadata edit must never delete files')
  });
  for (const name of ['cleanString', 'nowIso', 'normalizeScoreKind', 'scoreItemsById', 'scoreCatalogShardCount', 'scoreCatalogShardId', 'scoreCatalogShardIds', 'scoreCatalogItemsFromSnapshot', 'scoreCatalogSummary', 'assertScoreCatalogShardSize', 'normalizeScoreLinkedSongIds', 'scoreArchiveGroupKey', 'scoreActor', 'canEditStoredScore', 'scoreCatalogTransactionState', 'scoreCatalogFindItem', 'scoreCatalogMetaUpdate', 'scoreGroupMetadataItems', 'upsertScores']) {
    const match = source.match(new RegExp('^(?:async )?function ' + name + '\\([^]*?^}', 'm'));
    assert.ok(match, name); vm.runInContext(match[0], context);
  }
  function put(part) {
    const key = 'scoreCatalog/' + context.scoreCatalogShardId(part.id, part.scoreKind);
    docs.set(key, { items: { ...(docs.get(key) || {}).items, [part.id]: clone(part) } });
  }
  parts.forEach(put); docs.set('scoreCatalog/_meta', { version: 1 });
  function read(id) { return clone(docs.get('scoreCatalog/' + context.scoreCatalogShardId(id, 'orchestra')).items[id]); }
  const request = data => ({ data: { action: 'updateGroup', group: data }, permissions: ['score.manage'], auth: { uid: 'owner', token: {} } });
  return { context, docs, read, put, request, fail: value => { fail = value; }, retry: fn => { beforeCommit = fn; } };
}

(async () => {
  const f = backend();
  const snapshot = JSON.stringify([...f.docs]);
  await assert.rejects(f.context.upsertScores({ ...f.request(group), permissions: [] }), { code: 'permission-denied' });
  await assert.rejects(f.context.upsertScores(f.request({ ...group, ids: group.ids.slice(1) })), { code: 'failed-precondition' });
  await assert.rejects(f.context.upsertScores(f.request({ ...group, ids: ['missing'] })), { code: 'failed-precondition' });
  const unauthorized = f.request(group); unauthorized.auth.uid = 'other';
  await assert.rejects(f.context.upsertScores(unauthorized), { code: 'permission-denied' });
  f.fail(true); await assert.rejects(f.context.upsertScores(f.request(group)), /fixture-save-failed/); f.fail(false);
  assert.equal(JSON.stringify([...f.docs]), snapshot, 'rejections must not partly update the group');
  // Simulate another editor replacing one file while metadata save retries.
  f.retry(() => f.put({ ...f.read('score-0'), versionNumber: 3, currentFilePath: 'scores/score-0/new.pdf', currentUploadedAt: '2026-09-06T00:00:00Z' }));
  const result = await f.context.upsertScores(f.request({ ...group, public: true, currentFilePath: 'tampered' }));
  assert.equal(result.items.length, 20);
  for (const part of parts) {
    const saved = f.read(part.id);
    assert.equal(saved.title, group.title); assert.equal(saved.linkedSongId, 'song-sep27');
    for (const field of ['instrument', 'instrumentLabel', 'public', 'archived', 'currentFileName', 'currentFileSize', 'createdAt', 'createdById', 'extraMetadata']) assert.deepEqual(saved[field], part[field], field);
    if (part.id !== 'score-0') {
      for (const field of ['versionNumber', 'currentFilePath', 'currentUploadedAt']) assert.equal(saved[field], part[field], field);
    }
  }
  assert.equal(f.read('score-0').versionNumber, 3); assert.equal(f.read('score-0').currentFilePath, 'scores/score-0/new.pdf');
  assert.ok(![...f.docs.keys()].some(key => key.startsWith('scoreChangeEvents/')), 'metadata must not send score update notifications');
  await assert.rejects(f.context.upsertScores(f.request(group)), { code: 'failed-precondition' });
  const collision = backend(); collision.put({ ...parts[0], id: 'other', title: group.title, searchKey: '엘샤다이elshaddai', linkedSongIds: group.linkedSongIds });
  await assert.rejects(collision.context.upsertScores(collision.request(group)), { code: 'already-exists' });
  const removed = backend(); removed.put({ ...parts[0], createdById: 'another-owner' });
  await assert.rejects(removed.context.upsertScores(removed.request(group)), { code: 'permission-denied' });

  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/^init\(\);\r?$/m, '').replace(/^initInstallUi\(\);\r?$/m, '');
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, channel: 'msedge' });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.route(/firestore\.googleapis\.com|firebasestorage\.googleapis\.com|cloudfunctions\.net/, route => route.abort());
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const checks = await page.evaluate(parts => {
      function check(value, message) { if (!value) throw new Error(message); }
      adminRole = 'admin'; currentUser = null; songsLoaded = true; scoresLoaded = scoresLoadedPrivate = true;
      canManageScores = () => true; canEditScoreItem = () => true; canViewScoreItem = score => score.public !== false;
      allScores = parts; allSongs = [{ id: 'song-sep27', songName: '엘샤다이(El Shaddai)', category: '주일찬송', year: 2026, month: 9, day: 27 }];
      check(findScoresForSong(allSongs[0], true).length === 20, 'existing bilingual song must find all parts without resaving');
      check(findScoresForSong(allSongs[0], false).length === 19, 'private score leak');
      check(findSongForScore(parts[0]).id === 'song-sep27', 'reverse detail lookup failed');
      check(scoreTitlesMatch('El Shaddai', '엘샤다이(El Shaddai)'), 'English alias');
      check(scoreTitlesMatch('엘샤다이', 'El Shaddai(엘샤다이)'), 'Korean alias');
      check(!scoreTitlesMatch('엘샤다이', 'El Shaddai'), 'must not guess translations');
      check(!scoreTitlesMatch('갈보리', '갈보리 산 위에'), 'must not match partial names');
      check(!scoreTitlesMatch('은혜', '은혜 아니면'), 'must not match partial names');
      check(!scoreTitlesMatch('SATB', '엘샤다이(SATB)'), 'part label is not a title');
      check(!scoreTitlesMatch('Violin', '엘샤다이(Violin)'), 'instrument label is not a title');
      check(!scoreTitlesMatch('El Shaddai reprise', '엘샤다이(El Shaddai)'), 'English partial title');
      markScoreFolderRead(parts[0]);
      allScores = parts.map(score => ({ ...score, title: '엘샤다이', linkedSongIds: ['song-sep27'] }));
      check(!isScoreFolderUnread(allScores), 'rename/relink should not mark the same files NEW');
      allScores[0].versionNumber++;
      check(isScoreFolderUnread(allScores), 'actual new version should be NEW');
      allScores = parts;
      check(renderScoreFolderCard(scoreFolderGroups(parts)[0], true).includes('openScoreGroupEdit('), 'group header edit shortcut missing');
      window.fixtureCalls = [];
      scoreAdminCall = async (action, data) => { window.fixtureCalls.push({ action, data }); return { items: parts.map(score => ({ ...score, title: data.group.title, linkedSongIds: data.group.linkedSongIds, linkedSongId: data.group.linkedSongIds[0], linkedSongName: data.group.linkedSongName })) }; };
      renderScoreManage = () => {}; renderScoresPage = () => {}; requestHomeRender = () => {};
      openScoreGroupEdit(scoreFolderKey(parts[0]));
      return true;
    }, clone(parts));
    assert.ok(checks);
    await page.locator('#scoreGroupEditSearch').fill('엘샤다이');
    await page.locator('#scoreGroupEditSongs input[type=checkbox]').check();
    await page.locator('#scoreGroupEditTitle').fill('엘샤다이(El Shaddai)');
    for (const viewport of [{ width: 390, height: 844 }, { width: 820, height: 1180 }, { width: 1280, height: 900 }]) {
      await page.setViewportSize(viewport);
      assert.ok(await page.locator('#modalScoreGroupEdit .modal-content').evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'modal overflow');
      await page.screenshot({ path: path.join(root, 'tmp', 'score-group-edit-' + viewport.width + '.png') });
    }
    await page.locator('#scoreGroupEditSaveBtn').click();
    await page.waitForFunction(() => window.fixtureCalls.length === 1 && !scoreGroupEditState.busy);
    const saved = await page.evaluate(() => ({ calls: window.fixtureCalls, groups: scoreFolderGroups(allScores).length, files: allScores.map(score => [score.id, score.currentFilePath, score.versionNumber]) }));
    assert.equal(saved.calls[0].action, 'updateGroup'); assert.equal(saved.calls[0].data.group.ids.length, 20);
    assert.deepEqual(saved.calls[0].data.group.linkedSongIds, ['song-sep27']); assert.equal(saved.groups, 1);
    assert.deepEqual(saved.files, parts.map(score => [score.id, score.currentFilePath, score.versionNumber]));
    assert.deepEqual(errors, []);
    console.log('PASS: bilingual matching, explicit group linking, whole-group atomic metadata save, permissions, collision/stale guard, concurrent file replacement, NEW preservation, 390/820/1280px UI');
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
