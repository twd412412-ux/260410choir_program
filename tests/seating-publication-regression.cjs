const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const html=fs.readFileSync(process.env.SEATING_TEST_HTML||path.join(__dirname,'../index.html'),'utf8');
const clone=value=>JSON.parse(JSON.stringify(value));
const plan=id=>({sourcePlanId:id,publicId:'plan:'+id,name:id,date:'2026-09-13',program:'choir',rows:[{label:'0',seats:[{memberId:id,name:id}]}]});
function fixture(plans){
 const state={stored:{schemaVersion:2,plans:clone(plans)},commits:0,reads:0,toasts:[],local:[],retry:false};
 const c=vm.createContext({
  Blob,console:{error(){}},PUBLISHED_SEATING_MAX_PLANS:8,PUBLISHED_SEATING_MAX_BYTES:600000,
  seatingRows:[{}],publishedSeatingRequestId:0,publishedSeatingLoaded:false,publishedSeatingPromise:null,publishedSeatingLastCheckedAt:0,seatingPublishPreviewData:null,publicSeatingSearch:'',
  cloneSeatingValue:clone,normalizePublishedSeatingPlans:data=>clone(data?.plans||[]),canUseSeatingPlan:()=>true,currentActorName:()=> 'editor',
  showToast:message=>state.toasts.push(message),setPublishedSeatingState:plans=>state.local.push(clone(plans)),savePublishedSeatingCache(){},writeLog(){},requestHomeRender(){},
  buildPublishedSeatingPlanDataFromSavedPlan:saved=>({...plan(saved.id),...saved,sourcePlanId:saved.id}),
  db:{collection:()=>({doc:()=>({})}),runTransaction:async callback=>{
   async function attempt(){
    let pending;
    const result=await callback({get:async()=>{state.reads++;return {exists:true,data:()=>clone(state.stored)};},set:(_,data)=>{pending=clone(data);}});
    return {result,pending};
   }
   if(state.retry){await attempt();state.stored={plans:[]};}
   const {result,pending}=await attempt();
   if(pending){state.stored=pending;state.commits++;}
   return result;
  }}
 });
 for(const name of ['publishedSeatingPayloadBytes','publishedSeatingDocumentData','publishedSeatingSamePlan','createPublishedSeatingPublicId','publishSeatingPlan','syncPublishedSeatingPlanAfterSave']){
  const source=html.match(new RegExp('^function '+name+'\\([^]*?^}','m'));assert.ok(source,name);vm.runInContext(source[0],c);
 }
 return {c,state};
}
(async()=>{
 const originals=Array.from({length:8},(_,i)=>plan('p'+i));
 const full=fixture(originals);
 await full.c.publishSeatingPlan(plan('ninth'));
 assert.equal(full.state.commits,0);assert.deepEqual(full.state.stored.plans,originals);assert.equal(full.state.local.length,0);
 assert.match(full.state.toasts.at(-1),/8/);
 const replace=fixture(originals),changed={...plan('p2'),centerOffset:5};
 await replace.c.publishSeatingPlan(changed);
 assert.equal(replace.state.commits,1);assert.equal(replace.state.stored.plans.length,8);
 assert.equal(replace.state.stored.plans[0].centerOffset,5);
 assert.deepEqual(replace.state.stored.plans.slice(1),originals.filter(p=>p.sourcePlanId!=='p2'));
 const large=fixture([plan('old')]);
 await large.c.publishSeatingPlan({...plan('large'),name:'x'.repeat(400000)});
 assert.equal(large.state.commits,0);assert.deepEqual(large.state.stored.plans,[plan('old')]);
 const sync=fixture(originals);
 assert.equal(await sync.c.syncPublishedSeatingPlanAfterSave({id:'p2'},null,changed),true);
 assert.equal(sync.state.stored.plans.length,8);assert.equal(sync.state.stored.plans[0].centerOffset,5);
 const oversizedSync=fixture(originals);
 await assert.rejects(oversizedSync.c.syncPublishedSeatingPlanAfterSave({id:'p2'},null,{...changed,name:'x'.repeat(400000)}),{code:'published_seating_capacity'});
 assert.equal(oversizedSync.state.commits,0);assert.deepEqual(oversizedSync.state.stored.plans,originals);
 const cancelled=fixture([plan('p2')]);cancelled.state.retry=true;
 assert.equal(await cancelled.c.syncPublishedSeatingPlanAfterSave({id:'p2'},null,changed),false);
 assert.equal(cancelled.state.commits,0);assert.equal(cancelled.state.local.length,0);assert.deepEqual(cancelled.state.stored.plans,[]);
 console.log('PASS: publication count/payload limits preserve all existing plans, updates at capacity, saved center, transaction retry after unpublish, no spurious local publication.');
})().catch(error=>{console.error(error);process.exitCode=1;});
