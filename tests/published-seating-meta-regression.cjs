const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, '..', 'functions/index.js'), 'utf8');
const rules = fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

// Server state: the ~160KB publication and the small version doc the trigger maintains.
const server = { plans: [{ publicId: 'a', rows: [{ seats: ['one'] }] }], version: 'v1', metaFails: false };
const metaListeners = [], planListeners = [], log = [];
let cache = null, homeRenders = 0;
const document = { visibilityState: 'visible', getElementById: () => ({ classList: { contains: () => false } }), querySelector: () => null };
const c = vm.createContext({
  console: { warn() {}, error() {}, log() {} }, Date, JSON, Promise, String, document,
  currentTab: 'home', firebaseAuthReady: true,
  publishedSeatingUnsubscribe: null, publishedSeatingLiveGeneration: 0,
  publishedSeatingPlans: [], publishedSeatingPlan: null, publishedSeatingLoaded: false,
  publishedSeatingPromise: null, publishedSeatingLastCheckedAt: 0, publishedSeatingRequestId: 0,
  publicSeatingSelectedPlanId: '',
  PUBLISHED_SEATING_CACHE_KEY: 'published', PUBLISHED_SEATING_ACTIVE_TTL_MS: 120000, PUBLISHED_SEATING_EMPTY_TTL_MS: 600000,
  canViewPublishedSeating: () => true,
  normalizePublishedSeatingPlans: data => clone((data && data.plans) || []),
  trimPublishedSeatingPlans: plans => plans,
  renderSeatingPlanSelect() {}, renderPublicSeatingModalBody() {},
  saveCache: (key, data) => { cache = { ts: Date.now(), data: clone(data) }; },
  loadCacheEntry: (key, maxAge) => cache && Date.now() - cache.ts < maxAge ? { hit: true, data: clone(cache.data), age: Date.now() - cache.ts, ts: cache.ts } : { hit: false, data: null, age: 0, ts: 0 },
  localStorage: { removeItem: () => { cache = null; } },
  requestHomeRender: () => { homeRenders++; },
  db: { collection: () => ({ doc: id => id === 'publishedSeatingMeta' ? {
    onSnapshot: (options, next, error) => { const l = { next, error, stopped: false }; metaListeners.push(l); return () => { l.stopped = true; }; },
    get: async () => { log.push('meta'); if (server.metaFails) throw new Error('denied'); return { exists: !!server.version, data: () => ({ version: server.version }) }; }
  } : {
    onSnapshot: (options, next, error) => { const l = { next, error, stopped: false }; planListeners.push(l); return () => { l.stopped = true; }; },
    get: async () => { log.push('plan'); return { exists: true, data: () => ({ plans: clone(server.plans) }) }; }
  } }) }
});
vm.runInContext("var publishedSeatingVersion='';", c);
for (const name of ['setPublishedSeatingState', 'savePublishedSeatingCache', 'fetchPublishedSeatingDocument', 'publishedSeatingCacheTtl',
  'invalidatePublishedSeatingCache', 'getPublishedSeatingPlan', 'isPublicSeatingModalOpen', 'shouldWatchPublishedSeating',
  'stopPublishedSeatingLive', 'applyPublishedSeatingSnapshot', 'syncPublishedSeatingLive', 'refreshPublishedSeatingOnResume']) {
  const match = html.match(new RegExp('^function ' + name + '\\([^]*?^}', 'm'));
  assert.ok(match, name); vm.runInContext(match[0], c);
}
const metaSnap = version => ({ exists: !!version, data: () => ({ version }), metadata: {} });
const seat = () => c.publishedSeatingPlans[0] && c.publishedSeatingPlans[0].rows[0].seats[0];

(async () => {
  // First open on a device: meta, then the publication; the version is cached with the plans.
  await c.getPublishedSeatingPlan(false);
  assert.deepEqual(log, ['meta', 'plan']);
  assert.equal(cache.data.version, 'v1');
  assert.equal(metaListeners.length, 1);
  assert.equal(planListeners.length, 0, 'the publication itself is not watched');

  // Live meta with the same version: no publication download.
  log.length = 0;
  metaListeners[0].next(metaSnap('v1'));
  await tick();
  assert.deepEqual(log, []);

  // A new publication: exactly one download, even if the same version is delivered twice.
  server.plans = [{ publicId: 'a', rows: [{ seats: ['two'] }] }]; server.version = 'v2';
  metaListeners[0].next(metaSnap('v2'));
  metaListeners[0].next(metaSnap('v2'));
  await tick();
  assert.deepEqual(log, ['plan']);
  assert.equal(seat(), 'two');
  assert.equal(homeRenders, 1);
  assert.equal(cache.data.version, 'v2');

  // Backgrounding stops; resuming re-watches only the meta doc.
  document.visibilityState = 'hidden'; c.syncPublishedSeatingLive();
  assert.equal(metaListeners[0].stopped, true);
  document.visibilityState = 'visible'; c.refreshPublishedSeatingOnResume();
  assert.equal(metaListeners.length, 2);
  log.length = 0;
  metaListeners[1].next(metaSnap('v2'));
  await tick();
  assert.deepEqual(log, [], 'resume with an unchanged version downloads nothing');

  // A reopened app with an expired short cache but the same version needs only the meta read.
  c.invalidatePublishedSeatingCache(false);
  cache.ts -= 3 * 60 * 60 * 1000;
  log.length = 0;
  await c.getPublishedSeatingPlan(false);
  assert.deepEqual(log, ['meta']);
  assert.equal(seat(), 'two');

  // Manual refresh (force) always re-reads the publication.
  log.length = 0;
  await c.getPublishedSeatingPlan(true);
  assert.deepEqual(log, ['meta', 'plan']);

  // Unpublish arrives as a new version whose document no longer exists.
  server.plans = []; server.version = 'v3';
  const live = metaListeners[metaListeners.length - 1];
  live.next(metaSnap('v3'));
  await tick();
  assert.equal(c.publishedSeatingPlan, null);

  // Meta unavailable (rules not deployed yet): fall back to watching the publication, as before.
  c.stopPublishedSeatingLive();
  c.syncPublishedSeatingLive();
  metaListeners[metaListeners.length - 1].error(new Error('permission-denied'));
  assert.equal(planListeners.length, 1);
  server.metaFails = true; log.length = 0;
  await c.getPublishedSeatingPlan(true);
  assert.deepEqual(log, ['meta', 'plan'], 'a failing meta read still loads the publication');

  // Server trigger: versions only move forward, even for redelivered or out-of-order events.
  const docs = new Map();
  const fx = vm.createContext({ crypto, Date, String, Math, Boolean, nowIso: () => '2026-10-01T00:00:00Z',
    db: { collection: () => ({ doc: id => ({ id }) }), runTransaction: async fn => fn({
      get: async ref => ({ exists: docs.has(ref.id), data: () => clone(docs.get(ref.id)) }),
      set: (ref, data) => docs.set(ref.id, clone(data)) }) } });
  for (const name of ['firestoreTimeStamp', 'syncPublishedSeatingMeta']) vm.runInContext(source.match(new RegExp('^(?:async )?function ' + name + '\\([^]*?^}', 'm'))[0], fx);
  const event = (seconds, nanos) => ({ data: { after: { exists: true, updateTime: { seconds, nanoseconds: nanos } } } });
  await fx.syncPublishedSeatingMeta(event(100, 5));
  const first = docs.get('publishedSeatingMeta').version;
  await fx.syncPublishedSeatingMeta(event(100, 5));
  assert.equal(docs.get('publishedSeatingMeta').version, first, 'redelivery keeps the version');
  await fx.syncPublishedSeatingMeta(event(100, 7));
  const second = docs.get('publishedSeatingMeta').version;
  assert.notEqual(second, first, 'a later write in the same millisecond still bumps');
  await fx.syncPublishedSeatingMeta(event(99, 0));
  assert.equal(docs.get('publishedSeatingMeta').version, second, 'an older event cannot roll back');
  await fx.syncPublishedSeatingMeta({ time: new Date(200000).toISOString(), data: { after: { exists: false } } });
  assert.equal(docs.get('publishedSeatingMeta').exists, false);
  assert.match(source, /onDocumentWritten\(\{\s*document: "settings\/publishedSeatingPlan",\s*retry: true,\s*\}, syncPublishedSeatingMeta\)/);
  assert.match(rules, /match \/settings\/publishedSeatingMeta \{\s*allow read: if isAppUser\(\);\s*allow write: if false;/);

  console.log('PASS published seating meta: cold load, unchanged meta, single download per version, resume, stale cache, forced refresh, unpublish, fallback, ordered trigger');
})().catch(error => { console.error(error); process.exitCode = 1; });
