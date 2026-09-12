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
  assert.equal(await page.locator('#seatingPlanSelect option[value="a"]').textContent(),'여성');
  const storedPlans=await page.evaluate(()=>JSON.stringify(seatingPlans));
  await page.evaluate(()=>setPublishedSeatingState([{...seatingPlans[0],sourcePlanId:'a'}]));
  assert.equal(await page.locator('#seatingPlanSelect option[value="a"]').textContent(),'여성 · 공개 중');
  assert.equal(await page.locator('#seatingPlanSelect option[value="b"]').textContent(),'남성');
  assert.equal(await page.locator('#seatingPlanSelect').inputValue(),'a');
  // A saved plan may be renamed; publication identity must remain tied to its ID.
  await page.evaluate(()=>setPublishedSeatingState([{...seatingPlans[1],sourcePlanId:'a'}]));
  assert.equal(await page.locator('#seatingPlanSelect option[value="a"]').textContent(),'여성 · 공개 중');
  assert.equal(await page.locator('#seatingPlanSelect option[value="b"]').textContent(),'남성');
  await page.evaluate(()=>setPublishedSeatingState([]));
  assert.equal(await page.locator('#seatingPlanSelect option[value="a"]').textContent(),'여성');
  await page.evaluate(()=>setPublishedSeatingState([{...seatingPlans[0],sourcePlanId:'a'}]));
  await page.evaluate(()=>invalidatePublishedSeatingCache(false));
  assert.equal(await page.locator('#seatingPlanSelect option[value="a"]').textContent(),'여성');
  assert.equal(await page.evaluate(()=>JSON.stringify(seatingPlans)),storedPlans);
  // Mixed row lengths must center on the staggered seats, not the microphone grid.
  for(const counts of [[16,15,16,15],[10,10,10,10],[9,10,9,10]]){
   await page.evaluate(counts=>{
    seatingRows=counts.map((n,i)=>({label:['3단','2단','1단','0단앞'][i],seats:Array(n).fill(null)}));
    seatingCenterOffset=0;seatingMicVisible=true;renderSeatingBoard();
   },counts);
   for(const width of [390,820,1280]){
    await page.setViewportSize({width,height:900});
    const geometry=await page.evaluate(()=>{
     const rects=[...document.querySelectorAll('#seatingBoard .seating-seat')].map(e=>e.getBoundingClientRect());
     const center=(Math.min(...rects.map(r=>r.left))+Math.max(...rects.map(r=>r.right)))/2;
     const mic=document.querySelector('#seatingBoard .seating-mic-line').getBoundingClientRect();
     const line=document.querySelector('#seatingBoard .seating-center-line').getBoundingClientRect();
     return {center,mic:(mic.left+mic.right)/2,line:line.left,count:seatingMicSlots.length};
    });
    assert.ok(Math.abs(geometry.mic-geometry.center)<0.2,'microphone row off-center: '+JSON.stringify(geometry));
    assert.ok(Math.abs(geometry.line-geometry.center)<0.2,'center marker off-center: '+JSON.stringify(geometry));
    assert.equal(geometry.count,Math.max(...counts));
   }
   const stable=await page.evaluate(()=>({rows:JSON.stringify(seatingRows),lefts:[...document.querySelectorAll('#seatingBoard .seating-line')].map(e=>e.getBoundingClientRect().left-document.getElementById('seatingBoard').getBoundingClientRect().left)}));
   const exportedGeometry=await page.evaluate(()=>{
    const boxes=[],labels=[];
    const round=seatingDrawRoundRect,fill=CanvasRenderingContext2D.prototype.fillText,blob=HTMLCanvasElement.prototype.toBlob;
    seatingDrawRoundRect=function(ctx,x,y,w,h,...rest){boxes.push({x,y,w,h});return round(ctx,x,y,w,h,...rest);};
    CanvasRenderingContext2D.prototype.fillText=function(t,x,y,...rest){labels.push({t,x,y});return fill.call(this,t,x,y,...rest);};
    HTMLCanvasElement.prototype.toBlob=function(){};
    try{downloadSeatingImage(false);}finally{seatingDrawRoundRect=round;CanvasRenderingContext2D.prototype.fillText=fill;HTMLCanvasElement.prototype.toBlob=blob;}
    const micLabel=labels.find(l=>l.t==='마이크');
    const mics=boxes.filter(b=>b.h===34&&b.y===micLabel.y-18);
    return {mic:(mics[0].x+mics.at(-1).x+mics.at(-1).w)/2,center:labels.find(l=>l.t==='센터').x};
   });
   assert.ok(Math.abs(exportedGeometry.mic-exportedGeometry.center)<0.2,'image export microphone center');
   for(const view of ['audience','member']){
    const publicGeometry=await page.evaluate(view=>{
     let body=document.getElementById('publicSeatingBody');
     const fixture=document.createElement('div');document.body.appendChild(fixture);fixture.appendChild(body);
     publishedSeatingPlan={id:'fixture',rows:JSON.parse(JSON.stringify(seatingRows)),centerOffset:0};
     publicSeatingView=view;publicSeatingBoardTab='choir';publicSeatingSearch='';renderPublicSeatingModalBody();
     const rects=[...body.querySelectorAll('.public-seating-seat')].map(e=>e.getBoundingClientRect());
     const center=(Math.min(...rects.map(r=>r.left))+Math.max(...rects.map(r=>r.right)))/2;
     const marker=body.querySelector('.public-seating-center-line').getBoundingClientRect().left;
     fixture.style.display='none';return {center,marker};
    },view);
    assert.ok(Math.abs(publicGeometry.center-publicGeometry.marker)<0.2,view+' public center: '+JSON.stringify(publicGeometry));
   }
   if(counts[0]===16){
    fs.mkdirSync(path.join(root,'tmp','folder-mic'),{recursive:true});
    await page.locator('#seatingBoard').screenshot({path:path.join(root,'tmp','folder-mic','stagger-center.png')});
   }
   await page.evaluate(()=>{seatingCenterOffset=1;renderSeatingBoard();});
   assert.deepEqual(await page.evaluate(()=>({rows:JSON.stringify(seatingRows),lefts:[...document.querySelectorAll('#seatingBoard .seating-line')].map(e=>e.getBoundingClientRect().left-document.getElementById('seatingBoard').getBoundingClientRect().left)})),stable);
  }
  await page.evaluate(()=>applySeatingPlan(seatingPlans[0]));
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
