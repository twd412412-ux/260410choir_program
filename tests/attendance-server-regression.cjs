const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../functions/index.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const copy = value => JSON.parse(JSON.stringify(value));
class HttpsError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
let saved = { records: { other: '출석' }, reasons: {}, excludeFromReport: true, excludeReason: 'existing' };
let writes = 0;
const members = { singer: { part: 'S1' }, other: { part: 'T1' } };
const context = vm.createContext({
  HttpsError,
  db: {
    collection: collection => ({ doc: id => ({ collection, id }) }),
    getAll: async (...refs) => refs.map(ref => ({ exists: !!members[ref.id], data: () => members[ref.id] })),
    runTransaction: async fn => fn({
      get: async () => ({ exists: true, data: () => copy(saved) }),
      set: (ref, data) => { writes++; saved = copy(data); }
    })
  }
});
vm.runInContext("const ALLOWED_PERMISSIONS = new Set(['attendance.check','attendance.delete']); const ATTENDANCE_STATUSES = new Set(['출석','지각','사유결석','무단결석']);", context);
for (const name of ['nowIso', 'cleanString', 'isValidDocumentId', 'uniqueAllowed', 'normalizeAttendanceScope', 'isElevationValid', 'isAdminRequest', 'requestPermissions', 'hasPermission', 'requireAuth', 'requirePermission', 'requireAdmin', 'attendanceScopeForRequest', 'memberInAttendanceScope', 'normalizeAttendanceChanges', 'attendanceDocumentInfo', 'assertAttendanceScope', 'saveScopedAttendance', 'handleAttendanceAdmin']) {
  const match = source.match(new RegExp('^(?:async )?function ' + name + '\\([^]*?^}', 'm'));
  assert.ok(match, name);
  vm.runInContext(match[0], context);
}
const request = (changes, extra = {}) => ({
  auth: { token: { permissions: ['attendance.check'], attendanceScope: ['S1'], choirName: 'tester' } },
  data: { action: 'save', docId: '2026-09-19_오전', date: '2026-09-19', session: '오전', changes, ...extra }
});
const change = (id, status, baselineStatus = '') => ({ id, status, baselineStatus });
(async () => {
  const client = vm.createContext({
    currentUser: null, adminRole: null, secureElevatedSession: false,
    uniqueArray: rows => [...new Set(rows)],
    attendanceAdminCall: (action, data) => context.handleAttendanceAdmin({ ...request([]), data: { action, ...data } })
  });
  for (const name of ['normalizePartName', 'normalizeAttendanceScopeArray', 'scopeFromAccountPart', 'getAttendanceScopeKeys', 'saveAttendanceChanges']) {
    vm.runInContext(html.match(new RegExp('^function ' + name + '\\([^]*?^}', 'm'))[0], client);
  }
  for (const entry of [
    { role: 'chongmu', part: 'S1', attendanceScope: ['S1'] },
    { role: 'chongmu', part: 'S1', attendanceScope: [] },
    { role: 'attendance', part: 'T1', attendanceScope: ['T1', 'T2'] },
    { role: 'custom', part: '지휘', attendanceScope: [] },
    { role: 'custom', part: 'S1', attendanceScope: ['ALL'] }
  ]) {
    client.currentUser = entry; client.adminRole = entry.role;
    const scope = context.attendanceScopeForRequest({ auth: { token: { ...entry, choirPart: entry.part } } });
    assert.deepEqual(copy(client.getAttendanceScopeKeys()), copy(scope), JSON.stringify(entry));
  }
  client.secureElevatedSession = true; client.adminRole = 'chongmu';
  assert.deepEqual(copy(client.getAttendanceScopeKeys()), ['ALL']);
  await client.saveAttendanceChanges('2026-09-19_오전', copy(saved), [{ id: 'singer', status: '지각' }], { date: '2026-09-19', session: '오전' }, null);
  assert.equal(saved.records.singer, '지각');
  await assert.rejects(client.saveAttendanceChanges('bad', {}, [], {}, null));
  saved = { records: { other: '출석' }, reasons: {}, excludeFromReport: true, excludeReason: 'existing' };
  await context.handleAttendanceAdmin(request([change('singer', '출석')]));
  assert.deepEqual(saved.records, { other: '출석', singer: '출석' });
  assert.equal(saved.excludeReason, 'existing');
  const before = writes;
  await assert.rejects(context.handleAttendanceAdmin(request([change('other', '지각', '출석')])), { code: 'permission-denied' });
  await assert.rejects(context.handleAttendanceAdmin(request([change('singer', '지각')])), { code: 'aborted' });
  await assert.rejects(context.handleAttendanceAdmin(request([], { reportChange: { excludeFromReport: false } })), { code: 'permission-denied' });
  await assert.rejects(context.handleAttendanceAdmin({ data: request([]).data }), { code: 'unauthenticated' });
  assert.equal(writes, before);
  await context.handleAttendanceAdmin(request([change('singer', '출석')]));
  await context.handleAttendanceAdmin(request([{ ...change('singer', '사유결석', '출석'), reason: 'test' }]));
  assert.equal(saved.reasons.singer, 'test');
  const clear = request([{ ...change('singer', '', '사유결석'), baselineReason: 'test' }], { action: 'clear' });
  clear.auth.token.permissions.push('attendance.delete');
  await context.handleAttendanceAdmin(clear);
  assert.deepEqual(saved.records, { other: '출석' });
  assert.deepEqual(saved.reasons, {});
  console.log('PASS: client/server scope parity, real callable payload, scoped save, other-part preservation, conflict rejection, retry, report permissions, authentication, scoped clear');
})().catch(error => { console.error(error); process.exitCode = 1; });
