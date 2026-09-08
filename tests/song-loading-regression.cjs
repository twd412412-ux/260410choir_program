const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
function fixture() {
  const storage = new Map(), elements = {}, reads = [], timers = new Map();
  let timerId = 0, response;
  const ctx = vm.createContext({
    console: {warn() {}, error() {}}, Date, Promise,
    localStorage: {getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value)},
    document: {getElementById: id => elements[id] || (elements[id] = {innerHTML: '', hidden: true})},
    setTimeout: (fn, ms) => {timers.set(++timerId, {fn, ms}); return timerId;},
    clearTimeout: id => timers.delete(id),
    allSongs: [], filteredSongs: [], songsLoaded: false, songsLoadPromise: null, songLoadError: false,
    allowed: true, canViewSongList: () => ctx.allowed,
    renderSongLoginRequired() {}, buildFilters() {}, buildCatOptions() {}, buildYearOptions() {}, doFilter() {}, requestHomeRender() {},
    songRowFromDoc: doc => ({id: doc.id, ...doc.data()}),
    db: {collection: name => ({get: () => {reads.push(name); return response(name);}})}
  });
  for (const name of ['saveCache', 'loadCacheEntry', 'withLoadDeadline', 'loadSongIndexRows', 'loadSongsFromCollection', 'applyLoadedSongs', 'setSongLoadStatus', 'initSongs']) {
    const match = html.match(new RegExp('^function ' + name + '\\([^]*?^}', 'm'));
    assert.ok(match, name); vm.runInContext(match[0], ctx);
  }
  const index = title => ({forEach: fn => {
    fn({id: '_meta', data: () => ({count: 1})});
    fn({id: 'shard_00', data: () => ({items: {a: {songName: title}}})});
  }});
  return {ctx, reads, elements, timers, index,
    response: fn => {response = fn;},
    cache: age => storage.set('choir_songs', JSON.stringify({ts: Date.now() - age, data: [{id: 'a', songName: 'cached'}]})),
    expire: () => { const timer = [...timers.values()][0]; assert.equal(timer.ms, 8000); timer.fn(); }
  };
}
const flush = async () => {for (let i = 0; i < 8; i++) await Promise.resolve();};
(async () => {
  let f = fixture();
  f.cache(1000);
  await f.ctx.initSongs();
  assert.equal(f.reads.length, 0, 'fresh cache makes no Firestore reads');
  f = fixture();
  f.cache(700000);
  let resolve;
  f.response(() => new Promise(r => {resolve = r;}));
  const pending = f.ctx.initSongs();
  assert.equal(f.ctx.allSongs[0].songName, 'cached', 'stale cache renders synchronously');
  resolve(f.index('latest'));
  await pending;
  assert.equal(f.ctx.allSongs[0].songName, 'latest');
  assert.deepEqual(f.reads, ['songIndex']);
  f = fixture();
  let rejectOld;
  f.response(() => new Promise((resolve, reject) => {rejectOld = reject;}));
  const hanging = f.ctx.initSongs();
  f.expire();
  await hanging;
  assert.equal(f.ctx.songsLoadPromise, null);
  assert.equal(f.ctx.songLoadError, true);
  assert.equal(f.elements.songLoadStatus.hidden, false);
  assert.equal(f.elements.songList.innerHTML, '', 'no infinite spinner');
  rejectOld(new Error('late failure'));
  await flush();
  assert.deepEqual(f.reads, ['songIndex'], 'expired lookup must not launch an expensive fallback');
  f.response(() => Promise.resolve(f.index('retried')));
  await f.ctx.initSongs(true);
  assert.equal(f.ctx.allSongs[0].songName, 'retried');
  assert.equal(f.ctx.songLoadError, false);
  assert.equal(f.elements.songLoadStatus.hidden, true);
  f = fixture();
  f.cache(700000);
  f.response(() => new Promise(r => {resolve = r;}));
  const staleHang = f.ctx.initSongs();
  f.expire(); await staleHang;
  assert.equal(f.ctx.allSongs[0].songName, 'cached');
  f.response(() => Promise.resolve(f.index('new request')));
  await f.ctx.initSongs(true);
  resolve(f.index('late old request')); await flush();
  assert.equal(f.ctx.allSongs[0].songName, 'new request');
  f = fixture();
  f.response(name => Promise.resolve(name === 'songIndex' ? {forEach: () => {}} : {forEach: fn => fn({id: 'a', data: () => ({songName: 'fallback'})})}));
  await f.ctx.initSongs();
  assert.deepEqual(f.reads, ['songIndex', 'songs']);
  assert.equal(f.ctx.allSongs[0].songName, 'fallback');
  f = fixture();
  f.response(() => new Promise(r => {resolve = r;}));
  const logout = f.ctx.initSongs();
  f.ctx.allowed = false; f.ctx.songsLoadPromise = null;
  resolve(f.index('private stale response')); await logout;
  assert.equal(f.ctx.allSongs.length, 0, 'late response after logout must not restore data');
  f = fixture();
  f.response(() => new Promise(r => {resolve = r;}));
  const revoked = f.ctx.initSongs();
  f.ctx.allowed = false;
  resolve(f.index('revoked')); await revoked;
  assert.equal(f.ctx.songsLoadPromise, null, 'permission changes must not leave a settled request pinned');
  const refresh = html.match(/^function refreshData\([^]*?^}/m)[0];
  assert.match(refresh, /initSongs\(true\)/);
  assert.doesNotMatch(refresh, /collection\('songs'\)/);
  assert.match(refresh, /songLoadError/);
  f = fixture();
  vm.runInContext(refresh, f.ctx);
  const messages = [];
  Object.assign(f.ctx, {
    showToast: message => messages.push(message),
    invalidateHomeAttendanceCache() {}, invalidatePublishedSeatingCache() {},
    canManageScores: () => false, initSongs: () => Promise.resolve([]),
    initSchedules: () => Promise.resolve([]), loadScores: () => Promise.resolve([]),
    getPublishedSeatingPlan: () => Promise.resolve(null), currentTab: 'home',
    db: {collection: () => ({doc: () => ({get: () => new Promise(() => {})})})}
  });
  const refreshPending = f.ctx.refreshData();
  const refreshTimer = [...f.timers.values()][0];
  assert.equal(refreshTimer.ms, 20000);
  refreshTimer.fn(); await refreshPending;
  assert.equal(messages.length, 2, 'manual refresh reports failure instead of waiting forever');
  console.log('PASS fresh/stale/cold caches, bounded waits, retry, late response, logout, index fallback and lightweight refresh');
})().catch(error => {console.error(error); process.exitCode = 1;});
