// Targeted, reversible repair. Defaults to inspection; --apply requires all expected values.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const args = process.argv.slice(2);
const value = name => args[args.indexOf(name) + 1];
for (const key of ['--score', '--song', '--score-title', '--song-title']) {
  if (!args.includes(key) || !value(key) || value(key).startsWith('--')) throw new Error('Missing ' + key);
}
const scoreId = value('--score'), songId = value('--song');
if (![scoreId, songId].every(id => /^[A-Za-z0-9_-]+$/.test(id))) throw new Error('Invalid document ID');
const config = JSON.parse(fs.readFileSync(path.join(process.env.USERPROFILE, '.config/configstore/firebase-tools.json'), 'utf8'));
const projectId = 'choir-project-f3b67';
const base = 'https://firestore.googleapis.com/v1/projects/' + projectId + '/databases/(default)/documents';
async function request(suffix, body) {
  const response = await fetch(base + suffix, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: 'Bearer ' + config.tokens.access_token, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || 'Firestore request failed: ' + response.status);
  return result;
}
const digest = crypto.createHash('sha256').update(scoreId).digest();
const shardId = 'singer_' + String(digest.readUInt16BE(0) % 2).padStart(2, '0');
const refs = ['/scoreCatalog/' + shardId, '/scoreCatalog/_meta', '/settings/scores', '/songs/' + songId];
const backupDir = path.resolve(__dirname, '../../firebase-backups');
const backupPath = path.join(backupDir, 'stale-score-link-' + scoreId + '-' + Date.now() + '.json');
let transaction;

(async () => {
    if (args.includes('--apply')) transaction = (await request(':beginTransaction', { options: { readWrite: {} } })).transaction;
    const docs = [];
    for (const ref of refs) docs.push(await request(ref + (transaction ? '?transaction=' + encodeURIComponent(transaction) : '')));
    const [catalog, meta, legacy, song] = docs;
    const score = catalog.fields?.items?.mapValue?.fields?.[scoreId]?.mapValue?.fields;
    if (!score || !song.fields || !meta.fields) throw new Error('Required document missing');
    const linkedIds = [...new Set([score.linkedSongId?.stringValue, ...(score.linkedSongIds?.arrayValue?.values || []).map(v => v.stringValue)].filter(Boolean))];
    const title = score.title?.stringValue, songTitle = song.fields.songName?.stringValue;
    if (title !== value('--score-title') || songTitle !== value('--song-title') || score.scoreKind?.stringValue !== 'singer') throw new Error('Titles/type changed; no repair performed');
    if (!linkedIds.includes(songId)) { console.log('Target link already absent; no writes.'); return; }
    if (linkedIds.length !== 1 || score.linkedSongName?.stringValue !== title) throw new Error('Unexpected link state; no repair performed');
    if (title === songTitle) throw new Error('The titles match; do not remove this link');
    const now = { stringValue: new Date().toISOString() };
    const repaired = { ...score, linkedSongId: { stringValue: '' }, linkedSongIds: { arrayValue: { values: [] } }, linkedSongName: { stringValue: '' }, updatedAt: now };
    console.log(JSON.stringify({ mode: args.includes('--apply') ? 'apply' : 'inspect', scoreId, title, removedSongId: songId, linkedTitle: songTitle, version: score.versionNumber }));
    if (!args.includes('--apply')) return;
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(backupPath, JSON.stringify({ projectId, savedAt: new Date().toISOString(), score, song: { id: songId, title: songTitle }, catalogUpdateTime: catalog.updateTime, legacyItem: legacy.fields?.items?.mapValue?.fields?.[scoreId] || null }, null, 2));
    function itemWrite(doc) {
      return { update: { name: doc.name, fields: { items: { mapValue: { fields: { [scoreId]: { mapValue: { fields: repaired } } } } }, updatedAt: now } }, updateMask: { fieldPaths: ['items.' + scoreId, 'updatedAt'] }, currentDocument: { updateTime: doc.updateTime } };
    }
    const writes = [itemWrite(catalog), { update: { name: meta.name, fields: { updatedAt: now } }, updateMask: { fieldPaths: ['updatedAt'] }, currentDocument: { updateTime: meta.updateTime } }];
    if (legacy.fields?.items?.mapValue?.fields?.[scoreId]) writes.push(itemWrite(legacy));
    await request(':commit', { transaction, writes });
    transaction = null;
    const saved = (await request(refs[0])).fields.items.mapValue.fields[scoreId].mapValue.fields;
    for (const [key, before] of Object.entries(score)) {
      if (['linkedSongId', 'linkedSongIds', 'linkedSongName', 'updatedAt'].includes(key)) continue;
      if (!isDeepStrictEqual(saved[key], before)) throw new Error('Unexpected change: ' + key);
    }
    if (saved.linkedSongId?.stringValue || saved.linkedSongIds?.arrayValue?.values?.length || saved.linkedSongName?.stringValue) throw new Error('Link repair verification failed');
    console.log('Verified: file, version, public status and other metadata unchanged. Backup: ' + backupPath);
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
  if (transaction) await request(':rollback', { transaction }).catch(() => {});
});
