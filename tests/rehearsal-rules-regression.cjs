const fs = require('node:fs'), path = require('node:path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { doc, setDoc, updateDoc, deleteDoc, deleteField } = require('firebase/firestore');

(async () => {
  const env = await initializeTestEnvironment({ projectId: 'demo-choir-rehearsal', firestore: {
    rules: fs.readFileSync(path.join(__dirname, '../firestore.rules'), 'utf8')
  } });
  try {
    await env.withSecurityRulesDisabled(async context => {
      await setDoc(doc(context.firestore(), 'schedules/concert'), {
        title: 'Concert', createdById: 'user', rehearsalPlan: { cues: [], startTime: '19:00', durations: {} }
      });
    });
    const user = (permissions, extra = {}) => env.authenticatedContext('user', {
      account: true, permissions, admin: false, elevatedUntil: 0, ...extra
    }).firestore();
    const patch = { rehearsalPlan: { cues: [], startTime: '20:00', durations: {} }, updatedAt: '2026-09-27', updatedBy: 'Editor' };
    for (const permissions of [[], ['rehearsal.view'], ['rehearsal.edit'], ['schedule.manage'], ['schedule.editAny'], ['rehearsal.view', 'schedule.editAny']]) {
      const db = user(permissions);
      await assertFails(updateDoc(doc(db, 'schedules/concert'), patch));
      await assertFails(updateDoc(doc(db, 'schedules/concert'), { rehearsalPlan: deleteField() }));
    }
    const editor = user(['rehearsal.view', 'rehearsal.edit']);
    await assertSucceeds(updateDoc(doc(editor, 'schedules/concert'), patch));
    await assertFails(updateDoc(doc(editor, 'schedules/concert'), { ...patch, title: 'Changed' }));
    await assertFails(updateDoc(doc(editor, 'schedules/concert'), { rehearsalPlan: 'invalid' }));
    await assertFails(deleteDoc(doc(editor, 'schedules/concert')));
    await assertFails(setDoc(doc(editor, 'schedules/new'), { title: 'New' }));
    for (const permission of ['schedule.manage', 'schedule.editAny']) {
      await assertSucceeds(updateDoc(doc(user([permission]), 'schedules/concert'), { title: permission }));
    }
    await assertSucceeds(setDoc(doc(user(['schedule.manage']), 'schedules/new'), { title: 'New', createdById: 'user' }));
    await assertFails(setDoc(doc(user(['schedule.manage']), 'schedules/with-cues'), { ...patch, title: 'New' }));
    await assertFails(updateDoc(doc(user(['rehearsal.edit'], { choirPart: '지휘' }), 'schedules/concert'), patch));
    await assertSucceeds(updateDoc(doc(user([], { admin: true, elevatedUntil: Date.now() + 3600000 }), 'schedules/concert'), patch));
    console.log('PASS: cue view/edit pair required; cue-only writes restricted; schedule editing remains independent; admin access retained');
  } finally { await env.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
