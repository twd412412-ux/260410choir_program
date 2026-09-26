const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const stored = new Map(), calls = [];
let actor = 'editor', permitted = true, fail = true, hold = null;
const elements = Object.fromEntries(['seatingPublicationStatus', 'seatingPublicationStatusText', 'seatingPublicationRetry'].map(id => [id, { classList: { toggle() {} } }]));
const c = vm.createContext({
  console: { warn() {} }, Promise, Object, JSON,
  seatingPublicationStatusCache: {}, seatingPublicationRetries: {}, seatingPlanId: 'plan',
  currentActorId: () => actor, canUseSeatingPlan: () => permitted,
  seatingPlanVersion: p => p.updatedAt || '', SEATING_PLAN_COLLECTION: 'seatingPlans',
  localStorage: { getItem: k => stored.get(k), setItem: (k, v) => stored.set(k, v) },
  document: { getElementById: id => elements[id] }, showToast() {},
  syncPublishedSeatingPlanAfterSave: async (saved, previous, publication) => {
    calls.push({ saved: JSON.parse(JSON.stringify(saved)), previous, publication });
    if (hold) await hold;
    if (fail) throw new Error('offline');
    return true;
  },
  db: { collection: () => ({ doc: () => ({ get: async () => ({ exists: true, data: () => ({ updatedAt: '2026-09-26T02:00:00Z', rows: [{ seats: ['LATEST SAVED'] }] }) }) }) }) }
});
for (const name of ['seatingPublicationStatuses', 'setSeatingPublicationStatus', 'renderSeatingPublicationStatus', 'syncSeatingPublicationWithStatus', 'retrySeatingPublication']) {
  const match = html.match(new RegExp('^function ' + name + '\\([^]*?^}', 'm'));
  assert.ok(match, name); vm.runInContext(match[0], c);
}
(async () => {
  const saved = { id: 'plan', updatedAt: '2026-09-26T01:00:00Z', rows: [{ seats: ['BEFORE'] }] };
  await assert.rejects(c.syncSeatingPublicationWithStatus(saved, { id: 'plan', name: 'old name' }), /offline/);
  assert.equal(c.seatingPublicationStatuses().states.plan.state, 'failed');
  assert.equal(elements.seatingPublicationStatus.hidden, false);
  assert.equal(elements.seatingPublicationRetry.hidden, false);
  assert.match(elements.seatingPublicationStatusText.textContent, /저장 완료 · 공개 반영 대기/);
  c.seatingPublicationStatusCache = {};
  c.renderSeatingPublicationStatus();
  assert.equal(c.seatingPublicationStatuses().states.plan.state, 'failed', 'reload lost failure');
  fail = false;
  let release; hold = new Promise(resolve => { release = resolve; });
  const retry = c.retrySeatingPublication();
  assert.equal(c.retrySeatingPublication(), retry, 'duplicate retries');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(elements.seatingPublicationRetry.hidden, true);
  c.seatingPlanId = 'other-plan';
  release(); await retry; hold = null;
  assert.equal(c.seatingPlanId, 'other-plan', 'retry switched editor');
  assert.equal(calls.at(-1).saved.rows[0].seats[0], 'LATEST SAVED', 'retry published unsaved editor data');
  assert.equal(calls.at(-1).previous.name, 'old name', 'legacy identity missing');
  assert.equal(c.seatingPublicationStatuses().states.plan.state, 'complete');
  assert.equal(elements.seatingPublicationStatus.hidden, true, 'other plan shows stale status');
  actor = 'other-editor';
  assert.equal(c.seatingPublicationStatuses().states.plan, undefined, 'account leakage');
  actor = 'editor'; c.seatingPlanId = 'plan';
  c.setSeatingPublicationStatus('plan', { version: '2026-09-26T03:00:00Z', state: 'failed' });
  c.setSeatingPublicationStatus('plan', { version: '2026-09-26T01:00:00Z', state: 'complete' });
  assert.equal(c.seatingPublicationStatuses().states.plan.state, 'failed', 'older response cleared newer failure');
  permitted = false;
  const before = calls.length;
  assert.equal(await c.retrySeatingPublication(), false);
  assert.equal(calls.length, before, 'read-only user retried publication');
  c.renderSeatingPublicationStatus();
  assert.equal(elements.seatingPublicationRetry.hidden, true);
  console.log('PASS persistent failure, latest saved retry, legacy matching, duplicate blocking, actor/plan isolation and stale response protection');
})().catch(error => { console.error(error); process.exitCode = 1; });
