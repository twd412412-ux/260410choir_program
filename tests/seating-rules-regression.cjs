const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { doc, getDoc, getDocs, collection, setDoc, updateDoc, deleteDoc } = require('firebase/firestore');
(async () => {
  const root = path.resolve(__dirname, '..');
  const env = await initializeTestEnvironment({ projectId: 'demo-choir-seating', firestore: { rules: fs.readFileSync(path.join(root, 'firestore.rules'), 'utf8') } });
  try {
    const privatePaths = ['seatingPlans/existing', 'settings/seatingPlans'];
    const allPaths = [...privatePaths, 'settings/seatingMemberDirectory', 'settings/publishedSeatingPlan'];
    await env.withSecurityRulesDisabled(async context => {
      for (const p of allPaths) await setDoc(doc(context.firestore(), p), { plans: [], name: 'original' });
    });
    const user = (permissions, extra = {}) => env.authenticatedContext('user', { account: true, admin: false, elevatedUntil: 0, legacyRole: '', permissions, ...extra }).firestore();
    const viewer = user(['seating.manage', 'attendance.check', 'account.manage']);
    for (const p of allPaths) await assertSucceeds(getDoc(doc(viewer, p)));
    await assertSucceeds(getDocs(collection(viewer, 'seatingPlans')));
    for (const p of [...privatePaths, 'settings/publishedSeatingPlan', 'settings/seatingMemberDirectory']) {
      await assertFails(setDoc(doc(viewer, p), { name: 'forbidden' }));
      await assertFails(updateDoc(doc(viewer, p), { name: 'forbidden' }));
      await assertFails(deleteDoc(doc(viewer, p)));
    }
    await assertFails(setDoc(doc(viewer, 'seatingPlans/new'), { name: 'forbidden' }));
    const member = user([]);
    await assertSucceeds(getDoc(doc(member, 'settings/publishedSeatingPlan')));
    for (const p of [...privatePaths, 'settings/seatingMemberDirectory']) await assertFails(getDoc(doc(member, p)));
    await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), 'seatingPlans/existing')));
    for (const db of [user(['seating.edit']), user([], { admin: true, elevatedUntil: Date.now() + 3600000 })]) {
      for (const p of allPaths) await assertSucceeds(getDoc(doc(db, p)));
      for (const p of [...privatePaths, 'settings/publishedSeatingPlan']) {
        await assertSucceeds(setDoc(doc(db, p), { name: 'allowed' }));
        await assertSucceeds(updateDoc(doc(db, p), { name: 'updated' }));
        await assertSucceeds(deleteDoc(doc(db, p)));
        await assertSucceeds(setDoc(doc(db, p), { name: 'restored' }));
      }
    }
    await assertFails(setDoc(doc(user(['seating.edit']), 'settings/seatingMemberDirectory'), { members: [] }));
    // Existing account grants and presets must never acquire the new write capability implicitly.
    const source = fs.readFileSync(path.join(root, 'functions/index.js'), 'utf8');
    const c = vm.createContext({});
    vm.runInContext(source.slice(source.indexOf('const ALLOWED_PERMISSIONS'), source.indexOf('function nowIso')), c);
    for (const name of ['cleanString', 'uniqueAllowed', 'accountPermissions']) {
      vm.runInContext(source.match(new RegExp('^function ' + name + '\\([^]*?^}', 'm'))[0], c);
    }
    for (const preset of ['none', 'partLeader', 'operations', 'chongmu', 'handbook', 'custom']) {
      const actual = c.accountPermissions({ permissions: ['seating.manage'], permissionPreset: preset });
      assert.ok(actual.includes('seating.manage')); assert.ok(!actual.includes('seating.edit'));
    }
    assert.ok(c.accountPermissions({ permissions: ['seating.edit'] }).includes('seating.edit'));
    console.log('PASS: Firestore emulator read/write matrix, cached legacy grants denied writes, new editor/admin grants work, presets do not auto-grant editing.');
  } finally { await env.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
