const fs = require('node:fs');
const path = require('node:path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { doc, getDoc, setDoc, updateDoc, deleteDoc } = require('firebase/firestore');
const { ref, uploadBytes, uploadBytesResumable } = require('firebase/storage');
(async () => {
  const root = path.join(__dirname, '..');
  const env = await initializeTestEnvironment({
    projectId: 'demo-choir-attendance',
    firestore: { rules: fs.readFileSync(path.join(root, 'firestore.rules'), 'utf8') },
    storage: { rules: fs.readFileSync(path.join(root, 'storage.rules'), 'utf8') }
  });
  try {
    const key = 'attendance/2026-09-19_오전';
    await env.withSecurityRulesDisabled(c => setDoc(doc(c.firestore(), key), { records: { singer: '출석' } }));
    const account = { account: true, admin: false, elevatedUntil: 0, permissions: ['attendance.check', 'attendance.delete'], attendanceScope: ['S1'] };
    for (const token of [account, { ...account, admin: true, elevatedUntil: Date.now() + 600000 }]) {
      const db = env.authenticatedContext('editor', token).firestore();
      await assertSucceeds(getDoc(doc(db, key)));
      await assertFails(setDoc(doc(db, 'attendance/new'), { records: {} }));
      await assertFails(updateDoc(doc(db, key), { records: {} }));
      await assertFails(deleteDoc(doc(db, key)));
    }
    await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), key)));
    const photo = new Uint8Array([1, 2, 3]);
    const storage = token => env.authenticatedContext('editor', token).storage();
    await assertSucceeds(uploadBytes(ref(storage(account), 'profiles/editor/test.png'), photo, { contentType: 'image/png' }));
    for (const elevatedUntil of [0, String(Date.now() + 600000)]) {
      await assertFails(uploadBytes(ref(storage({ account: false, admin: true, elevatedUntil, permissions: [] }), 'profiles/other/test.png'), photo, { contentType: 'image/png' }));
    }
    await assertSucceeds(uploadBytes(ref(storage({ account: false, admin: true, elevatedUntil: Date.now() + 600000, permissions: [] }), 'profiles/other/test.png'), photo, { contentType: 'image/png' }));
    const pdf=new Uint8Array(300*1024);
    const administrator=storage({admin:true,elevatedUntil:Date.now()+600000});
    await assertSucceeds(uploadBytes(ref(administrator,'scores/admin/uploads/one/file.pdf'),photo,{contentType:'application/pdf'}));
    await assertSucceeds(uploadBytesResumable(ref(administrator,'scores/admin/uploads/two/file.pdf'),pdf,{contentType:'application/pdf'}));
    const editor=storage({account:true,permissions:['score.manage']});
    await assertSucceeds(uploadBytesResumable(ref(editor,'scores/editor/uploads/one/file.pdf'),pdf,{contentType:'application/pdf'}));
    await assertFails(uploadBytes(ref(storage({account:true,permissions:[]}),'scores/no-permission/uploads/one/file.pdf'),photo,{contentType:'application/pdf'}));
    console.log('PASS: PDF upload, administrator without account claims, authorized editor and resumable transfer');
    console.log('PASS: direct attendance writes denied, authorized reads, own photo upload, valid/expired/malformed elevated storage claims');
  } finally { await env.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
