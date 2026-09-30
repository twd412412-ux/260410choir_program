const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, '../functions/index.js'), 'utf8');
const rules = fs.readFileSync(path.join(__dirname, '../firestore.rules'), 'utf8');
const storageRules = fs.readFileSync(path.join(__dirname, '../storage.rules'), 'utf8');

class HttpsError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const DELETE = Symbol('delete');
const docs = new Map();
let clock = Date.UTC(2026, 8, 30, 3, 0, 0);
let queue = Promise.resolve();
// Serialises transactions like Firestore's server-side locks, so concurrent callers see each other's writes.
const runTransaction = fn => {
  const run = queue.then(async () => {
    const writes = [];
    const result = await fn({
      get: async ref => ({ exists: docs.has(ref.path), id: ref.id, ref, data: () => structuredClone(docs.get(ref.path)) }),
      set: (ref, data, options) => writes.push({ ref, data, options })
    });
    writes.forEach(({ ref, data, options }) => docs.set(ref.path, options && options.merge ? mergeDoc(docs.get(ref.path) || {}, data) : data));
    return result;
  });
  queue = run.catch(() => {});
  return run;
};
function mergeDoc(target, patch) {
  const next = structuredClone(target);
  Object.keys(patch).forEach(key => {
    const value = patch[key];
    if (value === DELETE) delete next[key];
    else if (value && typeof value === 'object' && !Array.isArray(value) && next[key] && typeof next[key] === 'object' && !Array.isArray(next[key])) next[key] = mergeDoc(next[key], value);
    else next[key] = value;
  });
  return next;
}
const ref = (collection, id) => ({ id, path: collection + '/' + id });
const deletedPrefixes = [];
const context = vm.createContext({
  HttpsError, crypto, Buffer, console,
  Date: class extends Date { static now() { return clock; } },
  FieldValue: { delete: () => DELETE },
  db: { collection: collection => ({ doc: id => ref(collection, id) }), runTransaction },
  getStorage: () => ({ bucket: () => ({ deleteFiles: async ({ prefix }) => { deletedPrefixes.push(prefix); } }) })
});
for (const name of ['RATE_WINDOW_MS', 'RATE_LOCK_MEMORY_MS', 'SCORE_CATALOG_VERSION', 'SCORE_CATALOG_SHARDS', 'SCORE_LEGACY_MIRROR_MAX_BYTES']) {
  const match = source.match(new RegExp('^const ' + name + ' = .*;$', 'm'));
  assert.ok(match, name);
  vm.runInContext(match[0].replace(/^const /, 'var '), context);
}
for (const name of ['nowIso', 'cleanString', 'isValidDocumentId', 'isElevationValid', 'isAdminRequest', 'requireAuth', 'requireAdmin',
  'nextRateLimitState', 'reserveRateAttempt', 'archiveFileOwnedBy', 'normalizeScoreKind', 'scoreItemsById', 'scoreCatalogShardCount',
  'scoreCatalogShardId', 'scoreCatalogItemsFromSnapshot', 'scoreCatalogTransactionState', 'scoreCatalogFindItem', 'scoreActor', 'deleteStoredScore']) {
  const match = source.match(new RegExp('^(?:async )?function ' + name + '\\([^]*?^}', 'm'));
  assert.ok(match, name);
  vm.runInContext(match[0], context);
}

(async () => {
  // 1. A burst of parallel guesses must not all pass a stale lock check.
  const rule = { key: 'legacy-admin', limit: 5, lockMs: 15 * 60 * 1000, maxLockMs: 6 * 60 * 60 * 1000 };
  const burst = await Promise.allSettled(Array.from({ length: 50 }, () => context.reserveRateAttempt([rule])));
  assert.equal(burst.filter(row => row.status === 'fulfilled').length, 5, 'only the limit may reach the password check');
  assert.ok(burst.filter(row => row.status === 'rejected').every(row => row.reason.code === 'resource-exhausted'));
  const firstLock = docs.get('securityRateLimits/legacy-admin');
  assert.equal(firstLock.lockedUntil - clock, 15 * 60 * 1000);
  assert.equal(firstLock.lockCount, 1);

  // Repeated lockouts within a day double, capped by maxLockMs.
  const lockLengths = [firstLock.lockedUntil - clock];
  for (let round = 0; round < 6; round++) {
    clock = docs.get('securityRateLimits/legacy-admin').lockedUntil + 1;
    for (let i = 0; i < 5; i++) await context.reserveRateAttempt([rule]);
    lockLengths.push(docs.get('securityRateLimits/legacy-admin').lockedUntil - clock);
  }
  assert.deepEqual(lockLengths.map(ms => ms / 60000), [15, 30, 60, 120, 240, 360, 360]);
  await assert.rejects(context.reserveRateAttempt([rule]), { code: 'resource-exhausted' });

  // A quiet day resets the escalation; a second key (ip) is checked in the same transaction.
  clock += 25 * 60 * 60 * 1000;
  await context.reserveRateAttempt([rule, { key: 'ip-a', limit: 20, lockMs: 60000 }]);
  assert.equal(docs.get('securityRateLimits/legacy-admin').lockCount, 0);
  assert.equal(docs.get('securityRateLimits/ip-a').failures, 1);
  docs.set('securityRateLimits/ip-b', { lockedUntil: clock + 1000 });
  const beforeBlocked = JSON.stringify(docs.get('securityRateLimits/legacy-admin'));
  await assert.rejects(context.reserveRateAttempt([rule, { key: 'ip-b', limit: 20, lockMs: 60000 }]), { code: 'resource-exhausted' });
  assert.equal(JSON.stringify(docs.get('securityRateLimits/legacy-admin')), beforeBlocked, 'a blocked attempt must not write partial counters');
  assert.doesNotMatch(source, /assertRateAllowed|recordRateFailure/, 'old check-then-record helpers must be gone');

  // 4. Archive cleanup only trusts paths inside the uploader's own folder.
  assert.equal(context.archiveFileOwnedBy('archive/u1/S1/1_a.jpg', 'u1'), 'archive/u1/S1/1_a.jpg');
  assert.equal(context.archiveFileOwnedBy('archive/victim/S1/1_a.jpg', 'u1'), '');
  assert.equal(context.archiveFileOwnedBy('archive/u1/../victim/a.jpg', 'u1'), '');
  assert.equal(context.archiveFileOwnedBy('archive/u1//a.jpg', 'u1'), '');
  assert.equal(context.archiveFileOwnedBy('scores/x/a.pdf', 'u1'), '');
  assert.equal(context.archiveFileOwnedBy('archive/S1/old.jpg', 'u1'), 'archive/S1/old.jpg', 'legacy objects are still cleaned up');
  assert.match(rules, /request\.resource\.data\.path\.matches\('archive\/' \+ request\.auth\.uid \+ '\/\[\^\/\]\+\/\[\^\/\]\+'\)/);
  assert.match(storageRules, /match \/archive\/\{legacyPart\}\/\{legacyFile\} \{[^}]*allow create, update: if validImage\(\) && isAdmin\(\);/);

  // 5. Deleting a score removes it from the merge:true legacy mirror as well.
  const admin = { auth: { uid: 'legacy-admin', token: { admin: true, elevatedUntil: clock + 60000 } }, data: { scoreId: 'score_a' } };
  const shardA = context.scoreCatalogShardId('score_a', 'singer'), shardB = context.scoreCatalogShardId('score_b', 'singer');
  docs.set('scoreCatalog/_meta', { version: 1, count: 2, counts: { singer: 2, orchestra: 0 } });
  docs.set('scoreCatalog/' + shardA, { items: { score_a: { id: 'score_a', scoreKind: 'singer' } } });
  docs.set('scoreCatalog/' + shardB, mergeDoc(docs.get('scoreCatalog/' + shardB) || {}, { items: { score_b: { id: 'score_b', scoreKind: 'singer' } } }));
  docs.set('settings/scores', { items: { score_a: { id: 'score_a' }, score_b: { id: 'score_b' } } });
  await context.deleteStoredScore(admin);
  assert.deepEqual(Object.keys(docs.get('settings/scores').items), ['score_b'], 'deleted score must leave the legacy mirror');
  assert.equal(Object.keys(docs.get('scoreCatalog/' + shardA).items).includes('score_a'), false);
  assert.deepEqual(deletedPrefixes, ['scores/score_a/']);
  docs.set('scoreCatalog/_meta', { version: 1, count: 1, counts: { singer: 1, orchestra: 0 } });
  docs.set('settings/scores', { items: [{ id: 'score_b' }, { id: 'score_c' }] });
  admin.data.scoreId = 'score_b';
  await context.deleteStoredScore(admin);
  assert.deepEqual(Object.keys(docs.get('settings/scores').items), ['score_c'], 'array-shaped legacy mirrors are rewritten without the row');
  await assert.rejects(context.deleteStoredScore({ auth: { uid: 'u', token: {} }, data: { scoreId: 'score_c' } }), { code: 'permission-denied' });

  console.log('PASS: atomic login attempt reservation, escalating lockouts, archive path ownership, legacy score mirror deletion');
})().catch(error => { console.error(error); process.exitCode = 1; });
