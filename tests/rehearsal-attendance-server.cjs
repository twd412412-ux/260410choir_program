const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {createHandler,DEFAULT_DATES,validDate}=require('../functions/rehearsal-attendance');
const copy=v=>JSON.parse(JSON.stringify(v));
class HttpsError extends Error{constructor(code,message){super(message);this.code=code;}}
const source=fs.readFileSync(require('node:path').join(__dirname,'../functions/index.js'),'utf8');
const data={
  'settings/publishedSeatingPlan':{plans:[{publicId:'entire',name:'전체',rows:[{seats:[{memberId:'s1',name:'가'},{memberId:'t1',name:'나'},{memberId:'old',name:'다'}]}],specialSlots:{accompanist:{memberId:'piano',name:'라'}}}]},
  'members/s1':{name:'가',part:'S1'},'members/t1':{name:'나',part:'T1'},'members/old':{name:'다',part:'S1',noAtt:true},'members/piano':{name:'라',part:'반주'}
};
let writes=0;
const snap=ref=>({id:ref.id,exists:!!data[ref.path],data:()=>copy(data[ref.path])});
const db={collection:name=>({doc:id=>({id,path:name+'/'+id,get:async()=>snap({id,path:name+'/'+id})})}),
  getAll:async(...refs)=>refs.map(snap),runTransaction:async fn=>{const pending=[];await fn({get:async ref=>snap(ref),set:(ref,value)=>pending.push([ref,value])});pending.forEach(([ref,value])=>{data[ref.path]=copy(value);writes++;});}};
const context=vm.createContext({db,HttpsError});
vm.runInContext("const ALLOWED_PERMISSIONS=new Set(['attendance.view','attendance.check']);",context);
for(const name of ['nowIso','cleanString','isValidDocumentId','uniqueAllowed','normalizeAttendanceScope','isElevationValid','isAdminRequest','requestPermissions','hasPermission','requireAuth','requirePermission','requireAdmin','attendanceScopeForRequest','memberInAttendanceScope','assertAttendanceScope'])vm.runInContext(source.match(new RegExp('^(?:async )?function '+name+'\\([^]*?^}','m'))[0],context);
const handler=createHandler(Object.assign({db,HttpsError},Object.fromEntries(['nowIso','cleanString','isValidDocumentId','requirePermission','requireAdmin','hasPermission','isAdminRequest','attendanceScopeForRequest','memberInAttendanceScope','assertAttendanceScope'].map(n=>[n,context[n]]))));
const req=(action,extra={},part='S1')=>({auth:{token:{permissions:['attendance.view','attendance.check'],attendanceScope:[part],choirName:'파트장'}},data:{action,...extra}});
const admin=r=>({...r,auth:{token:{admin:true,elevatedUntil:Date.now()+60000}}});
const change=(id,status,baselineStatus='')=>({id,status,baselineStatus});
(async()=>{
  assert.equal(validDate('2026-02-30'),false);assert.equal(DEFAULT_DATES.includes('2026-09-27'),false);
  assert.deepEqual((await handler(req('rehearsalLoad'))).config.dates,DEFAULT_DATES);
  await assert.rejects(handler({auth:{token:{permissions:[]}},data:{action:'rehearsalLoad'}}),{code:'permission-denied'});
  await assert.rejects(handler(req('rehearsalConfigure',{planId:'entire',dates:DEFAULT_DATES})),{code:'permission-denied'});
  await handler(admin(req('rehearsalConfigure',{planId:'entire',dates:DEFAULT_DATES,baselineVersion:''})));
  const loaded=await handler(req('rehearsalLoad'));assert.equal(loaded.members.length,3);assert.equal(loaded.plan.publicId,'entire');
  const save=changes=>req('rehearsalSave',{date:'2026-09-20',planId:'entire',changes});
  await handler(save([change('s1','출석')]));
  await handler({...save([change('t1','결석')]),auth:req('',{},'T1').auth});
  assert.deepEqual(data['rehearsalAttendance/2026-09-20'].records,{s1:'출석',t1:'결석'});
  const before=writes;
  await assert.rejects(handler({...save([change('s1','출석')]),auth:{token:{permissions:['attendance.view']}}}),{code:'permission-denied'});
  await assert.rejects(handler(save([change('t1','출석','결석')])),{code:'permission-denied'});
  await assert.rejects(handler(save([change('s1','결석')])),{code:'aborted'});
  await assert.rejects(handler(save([change('old','출석')])),{code:'permission-denied'});
  await assert.rejects(handler(req('rehearsalSave',{date:'2026-09-27',planId:'entire',changes:[change('s1','출석')]})),{code:'failed-precondition'});
  await assert.rejects(handler(req('rehearsalSave',{date:'2099-10-04',planId:'entire',changes:[change('s1','출석')]})),{code:'invalid-argument'});
  await assert.rejects(handler({...save([change('s1','출석')]),auth:null}));
  await assert.rejects(handler(admin(req('rehearsalConfigure',{planId:'entire',dates:['2026-02-30'],baselineVersion:loaded.config.version}))),{code:'invalid-argument'});
  await assert.rejects(handler(admin(req('rehearsalConfigure',{planId:'entire',dates:DEFAULT_DATES,baselineVersion:'stale'}))),{code:'aborted'});
  assert.equal(writes,before);
  await handler(save([change('s1','출석')])); // Same-result retry is safe.
  await handler(save([change('s1','','출석')]));assert.equal(data['rehearsalAttendance/2026-09-20'].records.s1,undefined);
  await handler(admin(req('rehearsalConfigure',{planId:'entire',dates:['2026-10-04'],baselineVersion:loaded.config.version})));
  assert(data['rehearsalAttendance/2026-09-20'],'excluding date preserves history');
  assert(!Object.keys(data).some(key=>key.startsWith('attendance/')),'regular attendance untouched');
  await handler(admin(req('rehearsalConfigure',{planId:'entire',dates:DEFAULT_DATES,baselineVersion:data['settings/rehearsalAttendance'].version})));
  data['attendance/2026-09-20_오후']={records:{s1:'출석',t1:'지각',old:'출석',piano:'사유결석'},updatedBy:'원본'};
  const original=copy(data['attendance/2026-09-20_오후']);
  await handler(req('rehearsalLoad'));
  assert.equal(data['rehearsalAttendance/2026-09-20'].afternoonImportedAt,undefined,'part leader load does not import other parts');
  const adminLoaded=await handler(admin(req('rehearsalLoad')));
  assert.equal(adminLoaded.canEdit,true);assert.deepEqual(Array.from(adminLoaded.scope),['ALL']);
  assert.deepEqual(adminLoaded.sessions['2026-09-20'].records,{s1:'출석',t1:'결석'},'existing rehearsal decisions win');
  assert.equal(adminLoaded.sessions['2026-09-20'].afternoonImportedCount,1);
  await handler(admin(save([change('s1','','출석'),change('t1','출석','결석'),change('piano','출석')])));
  await handler(admin(req('rehearsalLoad')));
  assert.equal(data['rehearsalAttendance/2026-09-20'].records.s1,undefined,'one-time import never resurrects an unchecked member');
  assert.equal(data['rehearsalAttendance/2026-09-20'].records.t1,'출석','admin can check another part');
  assert.deepEqual(data['attendance/2026-09-20_오후'],original,'rehearsal edits never write regular attendance');
  delete data['rehearsalAttendance/2026-09-20'];
  const imported=await handler(admin(req('rehearsalLoad')));
  assert.deepEqual(imported.sessions['2026-09-20'].records,{s1:'출석',t1:'출석'},'afternoon late arrival counts, excluded and absent members do not');
  console.log('PASS rehearsal attendance: exact dates, admin configuration, scope, targets, future/invalid dates, concurrent merge/conflict, safe retry, history, separate regular attendance');
})().catch(e=>{console.error(e);process.exitCode=1;});
