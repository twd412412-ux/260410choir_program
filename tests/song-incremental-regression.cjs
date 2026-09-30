const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));

// Server-side song index: 3 shards + _meta, mirroring functions/index.js shapes.
function server() {
  const shards = {
    shard_00: {a: {songName: '갈보리'}, b: {songName: '엘샤다이'}},
    shard_01: {c: {songName: '축복하노라'}},
    shard_02: {d: {songName: '하나님의 사랑은'}}
  };
  const versions = {shard_00: 'v0', shard_01: 'v1', shard_02: 'v2'};
  const meta = () => ({count: Object.values(shards).reduce((n, items) => n + Object.keys(items).length, 0), shardCount: 3, version: 1, shardVersions: {...versions}});
  return {shards, versions, meta};
}
function fixture(srv) {
  const storage = new Map(), reads = [];
  const ctx = vm.createContext({
    console: {warn() {}, error() {}}, Date, Promise, JSON, Math, Object, Number, Array,
    localStorage: {getItem: key => storage.has(key) ? storage.get(key) : null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key)},
    document: {getElementById: () => ({innerHTML: '', hidden: true})},
    setTimeout: () => 0, clearTimeout() {},
    allSongs: [], filteredSongs: [], songsLoaded: false, songsLoadPromise: null, songLoadError: false,
    canViewSongList: () => true,
    renderSongLoginRequired() {}, buildFilters() {}, buildCatOptions() {}, buildYearOptions() {}, doFilter() {}, requestHomeRender() {},
    songRowFromDoc: doc => ({id: doc.id, ...doc.data()}),
    db: {collection: name => ({
      get: async () => {
        reads.push(name + '/*');
        const docs = [{id: '_meta', data: () => clone(srv.meta())}].concat(Object.keys(srv.shards).map(id => ({id, data: () => clone({items: srv.shards[id]})})));
        return {forEach: fn => docs.forEach(fn)};
      },
      doc: id => ({get: async () => {
        reads.push(name + '/' + id);
        if (id === '_meta') return {exists: true, data: () => clone(srv.meta())};
        return {exists: !!srv.shards[id], data: () => clone({items: srv.shards[id] || {}})};
      }})
    })}
  });
  for (const name of ['saveCache', 'loadCacheEntry', 'withLoadDeadline', 'songShardIdsFromMeta', 'withSongShardState', 'readSongShardState', 'saveSongRowsCache', 'loadAllSongIndexRows', 'loadSongIndexRows', 'loadSongsFromCollection', 'applyLoadedSongs', 'setSongLoadStatus', 'initSongs']) {
    const match = html.match(new RegExp('^function ' + name + '\\([^]*?^}', 'm'));
    assert.ok(match, name); vm.runInContext(match[0], ctx);
  }
  // Pretend the cache is older than the 10 minute quiet window so a network check happens.
  const age = () => { const cached = JSON.parse(storage.get('choir_songs')); cached.ts -= 11 * 60 * 1000; storage.set('choir_songs', JSON.stringify(cached)); };
  const names = () => [...ctx.allSongs].map(row => row.id + ':' + row.songName).sort();
  return {ctx, reads, storage, age, names};
}

(async () => {
  const srv = server();
  const f = fixture(srv);
  await f.ctx.initSongs();
  assert.deepEqual(f.reads, ['songIndex/*'], 'a new device downloads the whole index once');
  assert.deepEqual(f.names(), ['a:갈보리', 'b:엘샤다이', 'c:축복하노라', 'd:하나님의 사랑은']);
  assert.ok(f.storage.get('choir_song_shards_v1'), 'shard versions are remembered');

  // Nothing changed: one tiny read instead of the whole index.
  f.reads.length = 0; f.age();
  await f.ctx.initSongs();
  assert.deepEqual(f.reads, ['songIndex/_meta']);
  assert.equal(f.names().length, 4);

  // One song edited, one added, one deleted in two shards: only those shards are fetched.
  srv.shards.shard_01.c.songName = '축복하노라 (수정)';
  srv.shards.shard_01.e = {songName: '새 곡'};
  delete srv.shards.shard_02.d;
  srv.versions.shard_01 = 'v1b'; srv.versions.shard_02 = 'v2b';
  f.reads.length = 0; f.age();
  await f.ctx.initSongs();
  assert.deepEqual(f.reads, ['songIndex/_meta', 'songIndex/shard_01', 'songIndex/shard_02']);
  assert.deepEqual(f.names(), ['a:갈보리', 'b:엘샤다이', 'c:축복하노라 (수정)', 'e:새 곡']);

  // A song moved between shards (or any count surprise) falls back to a full, correct load.
  srv.shards.shard_00.z = {songName: '버전 누락'};
  f.reads.length = 0; f.age();
  await f.ctx.initSongs();
  assert.deepEqual(f.reads, ['songIndex/_meta', 'songIndex/*'], 'count mismatch without a version change forces a full load');
  assert.ok(f.names().includes('z:버전 누락'));
  srv.versions.shard_00 = 'v0b';

  // Any other rewrite of choir_songs (local edits use saveCache) breaks the token link, so the next check is a full load.
  f.ctx.saveCache('choir_songs', f.ctx.allSongs);
  f.reads.length = 0; f.age();
  await f.ctx.initSongs();
  assert.deepEqual(f.reads, ['songIndex/*']);

  // Manual refresh (force) always downloads everything.
  f.reads.length = 0;
  await f.ctx.initSongs(true);
  assert.deepEqual(f.reads, ['songIndex/*']);

  // Old servers without shardVersions keep today's behaviour and store no shard state.
  const legacy = server(); legacy.meta = () => ({count: 4});
  const g = fixture(legacy);
  await g.ctx.initSongs(); g.age(); g.reads.length = 0;
  await g.ctx.initSongs();
  assert.deepEqual(g.reads, ['songIndex/*']);
  assert.equal(g.storage.has('choir_song_shards_v1'), false);

  // A cache write failure must not leave versions pointing at older rows.
  const h = fixture(server());
  await h.ctx.initSongs();
  const setItem = h.ctx.localStorage.setItem;
  h.ctx.localStorage.setItem = (key, value) => { if (key === 'choir_songs') throw new Error('quota'); return setItem(key, value); };
  h.ctx.saveSongRowsCache([], {versions: {}, ids: {}});
  assert.equal(h.storage.has('choir_song_shards_v1'), false);

  console.log('PASS incremental song index: cold load, unchanged meta-only check, changed shards only, edits/adds/deletes, count fallback, token break, forced refresh, legacy meta, quota safety');
})().catch(error => { console.error(error); process.exitCode = 1; });
