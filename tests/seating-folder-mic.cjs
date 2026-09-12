const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
const html=fs.readFileSync(process.env.SEATING_TEST_HTML||path.join(root,'index.html'),'utf8').replace(/^init\(\);\r?$/m,'').replace(/^initInstallUi\(\);\r?$/m,'');
(async()=>{
 const server=http.createServer((q,r)=>{r.setHeader('Content-Type','text/html; charset=utf-8');r.end(html);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
 try{
  browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage();const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route(/firestore\.googleapis\.com|firebasestorage\.googleapis\.com|cloudfunctions\.net/,r=>r.abort());
  await page.goto('http://127.0.0.1:'+server.address().port);
  await page.evaluate(()=>{
   ensureScoreRealtimeSync=()=>Promise.resolve([]);canUseSeatingPlan=()=>true;saveSeatingDraftNow=()=>{};writeLog=()=>{};window.confirm=()=>true;
   window.saved=[];saveSeatingPlanRecord=async data=>{window.saved.push(JSON.parse(JSON.stringify(data)));return 'doc';};syncPublishedSeatingPlanAfterSave=async()=>false;
   const sub=document.getElementById('subSeatingPlan');document.body.appendChild(sub);
   [...document.body.children].forEach(e=>{if(e!==sub&&!e.classList.contains('modal-overlay')&&e.tagName!=='SCRIPT')e.style.display='none';});
   sub.classList.remove('hidden');sub.style.removeProperty('display');sub.classList.add('seating-fullscreen');
   seatingMembers=[{id:'a',name:'테스트',part:'S1'}];
   const p={id:'a',name:'여성',date:'2026-09-12',program:'여성합창',folder:'찬양의밤',rows:[{label:'1단',seats:[{memberId:'a',name:'테스트',part:'S1'},null,null]},{label:'0단',seats:[null,null,null]}],micSlots:[false,true,false],attendees:{a:true}};
   seatingPlans=[p,{...p,id:'b',name:'남성',folder:'수양회'},{...p,id:'c',name:'미분류',folder:''}];
   seatingMemberPanelCollapsed=true;applySeatingPlan(p);renderSeatingPlanSelect();seatingZoom=1;updateSeatingZoom();
  });
  assert.deepEqual(await page.locator('#seatingPlanSelect optgroup').evaluateAll(es=>es.map(e=>e.label)),['수양회 · 1','찬양의밤 · 1','미분류 · 1']);
  const before=await page.evaluate(()=>({rows:JSON.stringify(seatingRows),center:document.querySelector('#seatingBoard .seating-center-line').style.left,mics:seatingMicSlots.slice()}));
  await page.evaluate(()=>setSeatingMicVisible(false));
  assert.equal(await page.locator('#seatingBoard .seating-mic-row').count(),0);
  assert.deepEqual(await page.evaluate(()=>({rows:JSON.stringify(seatingRows),center:document.querySelector('#seatingBoard .seating-center-line').style.left,mics:seatingMicSlots.slice()})),before);
  assert.equal(await page.evaluate(()=>buildPublishedSeatingPlanData().micVisible),false);
  await page.evaluate(()=>undoSeatingChange());assert.equal(await page.locator('#seatingBoard .seating-mic-row').count(),1);
  await page.evaluate(()=>{setSeatingMicVisible(false);setSeatingInputValue('seatingFolder','새 폴더');markSeatingDirty();});
  await page.evaluate(()=>saveSeatingPlan());
  assert.deepEqual(await page.evaluate(()=>saved.map(p=>({id:p.id,folder:p.folder,micVisible:p.micVisible}))),[{id:'a',folder:'새 폴더',micVisible:false}]);
  assert.equal(await page.evaluate(()=>seatingPlans.find(p=>p.id==='b').folder),'수양회');
  await page.evaluate(()=>applySeatingPlan(seatingPlans.find(p=>p.id==='a')));
  assert.equal(await page.locator('#seatingFolder').inputValue(),'새 폴더');assert.equal(await page.locator('#seatingBoard .seating-mic-row').count(),0);
  // Inspect canvas drawing rather than just relying on the hidden DOM row.
  const exported=await page.evaluate(()=>{
   const drawn=[];const fill=CanvasRenderingContext2D.prototype.fillText;
   CanvasRenderingContext2D.prototype.fillText=function(text,...args){drawn.push(text);return fill.call(this,text,...args);};
   const blob=HTMLCanvasElement.prototype.toBlob;HTMLCanvasElement.prototype.toBlob=function(){};
   try{downloadSeatingImage(false);}finally{CanvasRenderingContext2D.prototype.fillText=fill;HTMLCanvasElement.prototype.toBlob=blob;}
   return drawn;
  });
  assert.ok(!exported.includes('마이크'));assert.ok(exported.includes('센터'));
  for(const viewport of [{width:390,height:844},{width:820,height:1180},{width:844,height:390}]){
   await page.setViewportSize(viewport);
   await page.evaluate(()=>{seatingSettingsOpen=true;seatingViewControlsOpen=true;renderSeatingWorkspaceShell();document.getElementById('subSeatingPlan').classList.add('seating-settings-open','seating-view-open');});
   await page.locator('#seatingFolder').scrollIntoViewIfNeeded();
   const b=await page.locator('#seatingFolder').boundingBox();assert.ok(b.x>=0&&b.x+b.width<=viewport.width+1,'folder overflow');
   await page.locator('#seatingMicVisible').scrollIntoViewIfNeeded();
   const m=await page.locator('#seatingMicVisible').boundingBox();assert.ok(m.x>=0&&m.x+m.width<=viewport.width+1,'mic control overflow');
   fs.mkdirSync(path.join(root,'tmp','folder-mic'),{recursive:true});await page.screenshot({path:path.join(root,'tmp','folder-mic',viewport.width+'.png')});
  }
  await page.evaluate(()=>{canUseSeatingPlan=()=>false;setSeatingMicVisible(true);});assert.equal(await page.evaluate(()=>seatingMicVisible),false);
  assert.deepEqual(errors,[]);
  console.log('PASS: folder groups/edit/save/reopen, original IDs, unrelated plans, mic visibility, undo, center and seats unchanged, publication metadata, image export, mobile/tablet layout, permissions.');
 }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
