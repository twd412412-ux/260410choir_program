const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const listeners = [];
let loggedIn = true, modalOpen = false, homeRenders = 0, modalRenders = 0, reads = 0;
let cache = null, resolveGet;
let scroll = { scrollTop: 123, scrollLeft: 45 };
const document = {
  visibilityState: 'visible',
  getElementById: () => ({ classList: { contains: () => modalOpen } }),
  querySelector: () => scroll
};
const c = vm.createContext({
  console, Date, JSON, Promise, document,
  currentTab: 'home', firebaseAuthReady: true,
  publishedSeatingUnsubscribe: null, publishedSeatingLiveGeneration: 0,
  publishedSeatingPlans: [], publishedSeatingPlan: null, publishedSeatingLoaded: false,
  publishedSeatingPromise: null, publishedSeatingLastCheckedAt: 0, publishedSeatingRequestId: 0,
  publicSeatingSelectedPlanId: '', publicSeatingZoom: 1.7, publicSeatingView: 'member', publicSeatingSearch: 'name',
  PUBLISHED_SEATING_CACHE_KEY: 'published', PUBLISHED_SEATING_ACTIVE_TTL_MS: 120000,
  PUBLISHED_SEATING_EMPTY_TTL_MS: 600000,
  canViewPublishedSeating: () => loggedIn,
  normalizePublishedSeatingPlans: data => clone(data?.plans || []),
  trimPublishedSeatingPlans: plans => plans,
  renderSeatingPlanSelect() {},
  saveCache: (key, data) => { cache = clone(data); },
  loadCacheEntry: () => ({ hit: !!cache, data: cache, age: 0, ts: Date.now() }),
  localStorage: { removeItem: () => { cache = null; } },
  requestHomeRender: () => { homeRenders++; },
  renderPublicSeatingModalBody: () => { modalRenders++; scroll = { scrollTop: 0, scrollLeft: 0 }; },
  db: { collection: name => {
    assert.equal(name, 'settings');
    return { doc: id => {
      assert.equal(id, 'publishedSeatingPlan');
      return {
        onSnapshot: (options, next, error) => {
          assert.equal(options.includeMetadataChanges, true);
          const listener = { next, error, stopped: false };
          listeners.push(listener);
          return () => { listener.stopped = true; };
        },
        get: () => { reads++; return new Promise(resolve => { resolveGet = resolve; }); }
      };
    } };
  } }
});
for (const name of [
  'setPublishedSeatingState', 'savePublishedSeatingCache', 'publishedSeatingCacheTtl',
  'invalidatePublishedSeatingCache', 'getPublishedSeatingPlan', 'isPublicSeatingModalOpen',
  'shouldWatchPublishedSeating', 'stopPublishedSeatingLive', 'syncPublishedSeatingLive',
  'refreshPublishedSeatingOnResume'
]) {
  const match = html.match(new RegExp('^function ' + name + '\\([^]*?^}', 'm'));
  assert.ok(match, name);
  vm.runInContext(match[0], c);
}
const snapshot = (plans, metadata = {}) => ({ exists: plans !== null, data: () => ({ plans }), metadata });
const a = { publicId: 'a', rows: [{ seats: ['old'] }] };
const b = { publicId: 'b', rows: [{ seats: ['other'] }] };
(async () => {
  // Cached members subscribe immediately instead of waiting for the old TTL.
  cache = { plans: [a, b] };
  await c.getPublishedSeatingPlan(false);
  assert.equal(listeners.length, 1);
  assert.equal(reads, 0);
  c.syncPublishedSeatingLive();
  assert.equal(listeners.length, 1, 'must not duplicate subscriptions');
  modalOpen = true;
  c.publicSeatingSelectedPlanId = 'b';
  const next = [Object.assign({}, a, { rows: [{ seats: ['new'] }] }), b];
  listeners[0].next(snapshot(next, { fromCache: true }));
  assert.equal(c.publishedSeatingPlans[0].rows[0].seats[0], 'old');
  listeners[0].next(snapshot(next, { hasPendingWrites: true }));
  assert.equal(homeRenders, 0);
  listeners[0].next(snapshot(next));
  assert.equal(c.publishedSeatingPlans[0].rows[0].seats[0], 'new');
  assert.equal(c.publicSeatingSelectedPlanId, 'b');
  assert.equal(homeRenders, 1);
  assert.equal(modalRenders, 1);
  assert.deepEqual(scroll, { scrollTop: 123, scrollLeft: 45 });
  assert.equal(c.publicSeatingZoom, 1.7);
  assert.equal(c.publicSeatingView, 'member');
  assert.equal(c.publicSeatingSearch, 'name');
  listeners[0].next(snapshot(next));
  assert.equal(modalRenders, 1, 'unchanged metadata must not reset viewer');
  await c.getPublishedSeatingPlan(false);
  assert.equal(reads, 0, 'live state must not trigger redundant gets');

  // Background and non-viewing tabs stop reads; returning starts a new server check.
  document.visibilityState = 'hidden';
  c.syncPublishedSeatingLive();
  assert.equal(listeners[0].stopped, true);
  listeners[0].next(snapshot([]));
  assert.equal(c.publishedSeatingPlans.length, 2, 'late callback ignored');
  document.visibilityState = 'visible';
  c.refreshPublishedSeatingOnResume();
  assert.equal(listeners.length, 2);
  listeners[1].next(snapshot([a]));
  assert.equal(c.publicSeatingSelectedPlanId, 'a', 'unpublished selection falls back');
  c.currentTab = 'scores';
  c.syncPublishedSeatingLive();
  assert.equal(listeners[1].stopped, false, 'open viewer keeps subscription');
  modalOpen = false;
  c.syncPublishedSeatingLive();
  assert.equal(listeners[1].stopped, true);
  c.currentTab = 'home';
  c.syncPublishedSeatingLive();
  listeners[2].next(snapshot(null));
  assert.equal(c.publishedSeatingPlan, null);
  assert.equal(cache.plans.length, 0, 'unpublish clears local cache');

  // A slow one-shot fetch must not overwrite a newer server notification.
  const staleGet = c.getPublishedSeatingPlan(true);
  listeners[2].next(snapshot(next));
  resolveGet(snapshot([a]));
  await staleGet;
  assert.equal(c.publishedSeatingPlans[0].rows[0].seats[0], 'new');
  loggedIn = false;
  c.invalidatePublishedSeatingCache(true);
  listeners[2].next(snapshot(next));
  assert.equal(c.publishedSeatingPlan, null);
  assert.equal(cache, null);
  c.syncPublishedSeatingLive();
  assert.equal(listeners.length, 3);

  loggedIn = true;
  c.syncPublishedSeatingLive();
  listeners[3].error(new Error('test disconnect'));
  assert.equal(c.publishedSeatingUnsubscribe, null);
  c.refreshPublishedSeatingOnResume();
  assert.equal(listeners.length, 5, 'resume can recover terminated listener');
  listeners[4].next(snapshot([]));
  resolveGet(snapshot([]));
  await Promise.resolve();
  assert.equal(c.publishedSeatingLoaded, true);
  console.log('Published seating realtime regression passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
