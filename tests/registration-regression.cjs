const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, '../functions/index.js'), 'utf8');
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
class HttpsError extends Error {
  constructor(code, message, details) { super(message); this.code = code; this.details = details; }
}

function fixture() {
  const documents = new Map(), versions = new Map();
  let counter = 0, retries = 0, failCommit = false;
  function put(key, data) { documents.set(key, clone(data)); versions.set(key, (versions.get(key) || 0) + 1); }
  function docSnapshot(ref) {
    const data = clone(documents.get(ref.key));
    return { id: ref.id, ref, exists: data !== undefined, data: () => clone(data) };
  }
  function querySnapshot(ref) {
    const docs = [...documents.keys()].filter(key => key.startsWith(ref.collection + '/'))
      .map(key => docSnapshot({ key, id: key.split('/')[1] }))
      .filter(doc => !ref.field || doc.data()[ref.field] === ref.value).slice(0, ref.count || Infinity);
    return { docs, empty: !docs.length };
  }
  function collection(name) {
    return {
      collection: name,
      doc(id = 'new-' + (++counter)) { const ref = { key: name + '/' + id, id }; ref.get = async () => docSnapshot(ref); return ref; },
      where(field, op, value) { return { ...this, field, value }; },
      limit(count) { return { ...this, count }; },
      get: async function () { return querySnapshot(this); }
    };
  }
  const db = {
    collection,
    runTransaction: async callback => {
      for (let attempt = 0; attempt < 10; attempt++) {
        const reads = new Map(), writes = [];
        const result = await callback({
          get: async ref => {
            if (!ref.key) return querySnapshot(ref);
            reads.set(ref.key, versions.get(ref.key) || 0);
            return docSnapshot(ref);
          },
          set: (ref, value, options) => writes.push({ ref, value: clone(value), merge: options && options.merge })
        });
        if ([...reads].some(([key, version]) => (versions.get(key) || 0) !== version)) { retries++; continue; }
        assert.ok(writes.length <= 500, 'Firestore transaction write limit');
        if (failCommit) throw new Error('fixture-network-error');
        writes.forEach(({ ref, value, merge }) => put(ref.key, merge ? { ...documents.get(ref.key), ...value } : value));
        return result;
      }
      throw new Error('retry limit');
    }
  };
  const context = vm.createContext({
    db, crypto, Buffer, HttpsError, ACCOUNT_PIN_PATTERN: /^\d{4}$/, MAX_SAME_NAME_ACCOUNTS: 12,
    requirePermission: (request, permission) => { if (!request.permissions.includes(permission)) throw new HttpsError('permission-denied', 'denied'); },
    isValidDocumentId: id => /^[\w-]+$/.test(id),
    accountPinEncryptionKey: () => Buffer.alloc(32, 7),
    buildAccountPinSecret: async (id, pin) => ({ testPin: pin }),
    verifyPassword: async (pin, secret) => pin === secret.testPin,
    safeProfile: (id, data) => ({ id, ...data }),
    setAccountPinDirectoryEntries: (tx, secrets) => tx.set(db.collection('authSecrets').doc('directory'), { pins: secrets }, { merge: true })
  });
  for (const name of ['cleanString', 'normalizeName', 'nowIso', 'mapLimit', 'accountSecret', 'accountPinMatch', 'sameNameAccountRows', 'assertPinAvailableForName', 'assertMemberLinkValid', 'accountCreateData', 'registrationOperation', 'registrationReplay', 'readRegistrationLocks', 'commitAccountRegistrations', 'adminCreateAccount', 'handbookRegistrationData', 'sameHandbookPerson', 'adminCreateHandbookMember', 'adminBulkCreateAccounts']) {
    const match = source.match(new RegExp('^(?:async )?function ' + name + '\\([^]*?^}', 'm'));
    assert.ok(match, name); vm.runInContext(match[0], context);
  }
  return { context, put, documents, count: name => [...documents.keys()].filter(key => key.startsWith(name + '/')).length,
    retries: () => retries, fail: value => { failCommit = value; } };
}
const request = (data, permissions = ['member.manage', 'account.manage']) => ({ data, permissions, auth: { uid: 'fixture-user', token: { choirName: 'fixture' } } });
const member = { name: '이금희', part: 'S2', subPart: '신입단원', phone: '010-0000-1111', birthday: '1970-01-01', joinDate: '2026-09-06' };
const registration = (id, data = member, extra = {}) => request({ member: data, requestId: id, ...extra });

(async () => {
  let f = fixture(), c = f.context;
  const same = await Promise.all([c.adminCreateHandbookMember(registration('request-0001')), c.adminCreateHandbookMember(registration('request-0001'))]);
  assert.equal(f.count('members'), 1);
  assert.equal(same[0].memberId, same[1].memberId);
  assert.ok(same.some(result => result.replayed));
  await assert.rejects(c.adminCreateHandbookMember(registration('request-0002')), { code: 'already-exists' });
  await assert.rejects(c.adminCreateHandbookMember(registration('request-0001', { ...member, part: 'S1' })), { code: 'failed-precondition' });
  const homonym = { ...member, phone: '010-0000-2222', birthday: '1980-01-01' };
  await assert.rejects(c.adminCreateHandbookMember(registration('request-0003', homonym)), error => error.details.kind === 'member-same-name');
  await c.adminCreateHandbookMember(registration('request-0003', homonym, { allowSameName: true }));
  assert.equal(f.count('members'), 2);
  await assert.rejects(c.adminCreateHandbookMember(request({ member, requestId: 'request-0004' }, [])), { code: 'permission-denied' });
  f = fixture(); c = f.context;
  f.put('members/legacy', member);
  await assert.rejects(c.adminCreateHandbookMember(registration('request-0005')), { code: 'already-exists' });
  f = fixture(); c = f.context;
  const attempts = await Promise.allSettled([c.adminCreateHandbookMember(registration('request-0006')), c.adminCreateHandbookMember(registration('request-0007'))]);
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(f.count('members'), 1);
  assert.ok(f.retries() > 0, 'distinct requests must serialize even with empty query results');
  f = fixture(); c = f.context;
  f.fail(true);
  await assert.rejects(c.adminCreateHandbookMember(registration('request-0008')));
  assert.equal(f.count('members'), 0); assert.equal(f.count('registrationRequests'), 0);
  f.fail(false);
  await c.adminCreateHandbookMember(registration('request-0008'));
  assert.equal(f.count('members'), 1);

  f = fixture(); c = f.context;
  f.put('members/member-a', { name: '박주안' });
  const account = { name: '박주안', part: 'T1', memberId: 'member-a', pin: '1234', requestId: 'account-0001' };
  const accounts = await Promise.all([c.adminCreateAccount(request(account)), c.adminCreateAccount(request(account))]);
  assert.equal(f.count('accounts'), 1); assert.equal(accounts[0].account.id, accounts[1].account.id);
  await assert.rejects(c.adminCreateAccount(request({ ...account, requestId: 'account-0002', pin: '2345' })), { code: 'already-exists' });
  await c.adminCreateAccount(request({ ...account, memberId: '', pin: '3456', requestId: 'account-0003' }));
  assert.equal(f.count('accounts'), 2, 'homonymous accounts with different PINs are valid');
  await assert.rejects(c.adminCreateAccount(request({ ...account, memberId: '', requestId: 'account-0004' })), { code: 'already-exists' });

  f = fixture(); c = f.context;
  const rows = [{ name: '가단원', part: 'S1', pin: '1234', memberId: '' }, { name: '나단원', part: 'S2', pin: '2345', memberId: '' }];
  const bulk = request({ rows, requestId: 'bulk-test-0001' });
  await Promise.all([c.adminBulkCreateAccounts(bulk), c.adminBulkCreateAccounts(bulk)]);
  assert.equal(f.count('accounts'), 2);
  assert.ok((await c.adminBulkCreateAccounts(bulk)).replayed);
  f = fixture(); c = f.context;
  const race = await Promise.allSettled([c.adminBulkCreateAccounts(bulk), c.adminCreateAccount(request({ ...rows[0], requestId: 'single-race-0001' }))]);
  assert.ok(race.some(result => result.status === 'fulfilled'));
  assert.equal([...f.documents.entries()].filter(([key, data]) => key.startsWith('accounts/') && data.name === '가단원').length, 1);
  f = fixture(); c = f.context;
  const largeRows = Array.from({ length: 250 }, (_, i) => {
    f.put('members/member-' + i, { name: '단원' + i });
    return { name: '단원' + i, part: 'S1', memberId: 'member-' + i, pin: '1234' };
  });
  const largeRequest = request({ rows: largeRows, requestId: 'large-bulk-0001' });
  await c.adminBulkCreateAccounts(largeRequest);
  assert.equal(f.count('accounts'), 250);
  await c.adminBulkCreateAccounts(largeRequest);
  assert.equal(f.count('accounts'), 250);
  console.log('PASS: repeated and concurrent member/account requests, atomic failure, legacy roster duplicates, homonyms, permissions, bulk retries and bulk/single race');
})().catch(error => { console.error(error); process.exitCode = 1; });
