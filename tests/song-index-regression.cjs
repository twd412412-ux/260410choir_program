const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../functions/index.js'), 'utf8');
const clone = x => x === undefined ? x : JSON.parse(JSON.stringify(x));
const docs = new Map([['songIndex/_meta', {count: 0}]]);
let commits = 0, fail = false, beforeCommit;
const db = {
  collection: name => ({doc: id => ({key: name + '/' + id})}),
  runTransaction: async callback => {
    for (;;) {
      const reads = new Map(), writes = [];
      const result = await callback({
        get: async ref => {
          const value = clone(docs.get(ref.key));
          reads.set(ref.key, JSON.stringify(value));
          return {exists: value !== undefined, data: () => value};
        },
        set: (ref, value) => writes.push([ref.key, clone(value)])
      });
      if (beforeCommit) { const hook = beforeCommit; beforeCommit = null; hook(); }
      if ([...reads].some(([key, value]) => JSON.stringify(docs.get(key)) !== value)) continue;
      if (fail) throw new Error('unavailable');
      if (writes.length) commits++;
      writes.forEach(([key, value]) => docs.set(key, value));
      return result;
    }
  }
};
const ctx = vm.createContext({db, Buffer, songIndexShardId: () => 'shard_00', SONG_INDEX_SHARDS: 16, nowIso: () => '2026-09-08T00:00:00Z'});
vm.runInContext(source.match(/^async function syncSongIndexWrite\([^]*?^}/m)[0], ctx);
const send = (id, stale = {}) => ctx.syncSongIndexWrite({params: {songId: id}, data: stale});
const count = () => docs.get('songIndex/_meta').count;
const item = id => docs.get('songIndex/shard_00').items[id];
(async () => {
  docs.set('songs/a', {songName: 'new'});
  await send('a');
  await send('a');
  assert.equal(count(), 1);
  assert.equal(commits, 1, 'duplicate delivery must not write again');
  docs.set('songs/a', {songName: 'newest'});
  await send('a', {after: {songName: 'old'}});
  assert.equal(item('a').songName, 'newest', 'ignore stale event contents');
  beforeCommit = () => docs.set('songs/a', {songName: 'concurrent'});
  await send('a');
  assert.equal(item('a').songName, 'concurrent', 'retry when original changes');
  docs.set('songs/b', {songName: 'second'});
  docs.set('songs/c', {songName: 'third'});
  await Promise.all([send('b'), send('c'), send('b')]);
  assert.equal(count(), 3, 'shared shard concurrent updates preserve count');
  docs.delete('songs/a');
  await send('a', {after: {songName: 'old create'}});
  await send('a');
  assert.equal(item('a'), undefined);
  assert.equal(count(), 2);
  docs.set('songs/a', {songName: 'recreated'});
  await send('a', {after: null});
  assert.equal(item('a').songName, 'recreated', 'old delete must not delete recreated source');
  assert.equal(count(), 3);
  const before = JSON.stringify(docs.get('songIndex/shard_00'));
  docs.set('songs/a', {songName: 'pending'});
  fail = true;
  await assert.rejects(send('a'), /unavailable/);
  assert.equal(JSON.stringify(docs.get('songIndex/shard_00')), before);
  fail = false;
  await send('a');
  assert.equal(item('a').songName, 'pending');
  assert.match(source, /onDocumentWritten\(\{document: "songs\/\{songId\}", retry: true\}, syncSongIndexWrite\)/);
  console.log('PASS song index duplicates, old deliveries, concurrent writes, delete/recreate, atomic failure and retry');
})().catch(error => {console.error(error); process.exitCode = 1;});
