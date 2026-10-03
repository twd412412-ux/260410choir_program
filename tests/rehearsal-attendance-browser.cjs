const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium,webkit}=require('playwright');
const root=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8').replace(/^init\(\);\r?$/m,'').replace(/^initInstallUi\(\);\r?$/m,'');
(async()=>{
  const server=http.createServer((req,res)=>{
    if(require('./serve-firebase-sdk.cjs')(req,res))return;
    const pathname=new URL(req.url,'http://local').pathname;
    if(pathname.startsWith('/assets/rehearsal-attendance.')){res.setHeader('Content-Type',pathname.endsWith('.css')?'text/css':'text/javascript');return res.end(fs.readFileSync(path.join(root,pathname)));}
    res.setHeader('Content-Type','text/html;charset=utf-8');res.end(html);
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{
    for(const engine of [chromium,webkit]){
      const browser=await engine.launch(engine===chromium?{channel:'msedge'}:{});
      try{
        for(const viewport of [{width:390,height:844},{width:820,height:1180},{width:844,height:390}]){
          const page=await browser.newPage({viewport,hasTouch:true,colorScheme:'light'}),errors=[];
          page.on('pageerror',e=>errors.push(e.message));
          await page.route(/firestore\.googleapis\.com|cloudfunctions\.net/,r=>r.abort());
          await page.goto('http://127.0.0.1:'+server.address().port);
          await page.evaluate(()=>{
            canViewAttendance=()=>true;canCheckAttendance=()=>true;writeLog=()=>{};
            window.testFail=false;window.testSaves=[];window.testConfig=[];
            const rows=createSeatingRows(5,12),members=[];
            rows.forEach((row,r)=>row.seats=row.seats.map((_,c)=>{const member={id:'m'+r+'-'+c,name:'단원'+r+'-'+c,part:c%2?'T1':'S1',subPart:'',startDate:''};members.push(member);return {memberId:member.id,name:member.name,part:member.part};}));
            window.testData={config:{dates:['2026-09-20','2026-10-04','2026-10-11','2026-10-12','2026-10-16'],planId:'entire',version:'v1'},
              plan:{publicId:'entire',name:'전체',rows,orchestraRows:[]},plans:[{id:'entire',name:'전체'}],members,sessions:{},today:'2026-10-04',scope:['S1'],canEdit:true,canManage:false};
            attendanceAdminCall=async(action,input)=>{
              if(action==='rehearsalLoad')return JSON.parse(JSON.stringify(testData));
              if(action==='rehearsalSave'){
                testSaves.push(input);if(testFail)throw Error('저장 실패');
                const record=Object.assign({},(testData.sessions[input.date]||{}).records||{});
                input.changes.forEach(c=>record[c.id]=c.status);
                return {session:{records:record,memberIds:members.map(m=>m.id),updatedAt:'2026-10-04T00:00:00Z',updatedBy:'테스트'}};
              }
              if(action==='rehearsalConfigure'){testConfig.push(input);testData.config={dates:input.dates,planId:input.planId,version:'v2'};return {ok:true};}
            };
          });
          await page.evaluate(()=>openRehearsalAttendance());
          await page.waitForSelector('.ra-board');
          assert.equal(await page.locator('#raDate').inputValue(),'2026-10-04');
          assert.equal(await page.locator('#raDate option').count(),5);
          assert.equal(await page.locator('.ra-config').count(),0);
          if(viewport.width===390||viewport.height===390){
            const modal=await page.locator('#modalRehearsalAttendance .modal-content').boundingBox();
            assert(modal.height>=viewport.height-2,'phone fills viewport instead of legacy 70vh modal');
            const save=await page.locator('#raSave').boundingBox();
            assert(save.y+save.height<=viewport.height,'save button remains visible without scrolling');
          }
          assert(await page.locator('[data-member-id="m0-1"]').isDisabled(),'other part cannot check');
          const layout=await page.evaluate(()=>{
            const rect=id=>document.querySelector('[data-member-id="'+id+'"]').getBoundingClientRect();
            const a=rect('m0-0'),b=rect('m0-1'),next=rect('m1-0'),scroll=document.querySelector('.ra-scroll'),content=document.querySelector('.ra-content');
            return {mirror:a.left>b.left,stagger:Math.abs(a.left-next.left)>20,pageOverflow:document.body.scrollWidth>innerWidth+1,
              scrollX:scroll.scrollWidth>scroll.clientWidth,scrollY:content.scrollHeight>content.clientHeight};
          });
          assert.equal(layout.mirror,true,JSON.stringify(layout));assert.equal(layout.stagger,true,JSON.stringify(layout));assert.equal(layout.pageOverflow,false,JSON.stringify(layout));
          if(viewport.width===390)assert.equal(layout.scrollX,true,JSON.stringify(layout));
          if(viewport.height===390)assert.equal(layout.scrollY,true);
          fs.mkdirSync(path.join(root,'tmp/rehearsal-attendance'),{recursive:true});
          await page.screenshot({path:path.join(root,'tmp/rehearsal-attendance',engine.name()+'-'+viewport.width+'-board.png')});
          await page.getByRole('button',{name:'명단',exact:true}).click();
          assert.equal(await page.locator('.ra-member').count(),30,'list respects assigned part');
          await page.locator('[data-member-id="m0-0"]').check();
          await page.screenshot({path:path.join(root,'tmp/rehearsal-attendance',engine.name()+'-'+viewport.width+'-list.png')});
          await page.getByRole('button',{name:'자리표',exact:true}).click();
          assert.equal(await page.locator('[data-member-id="m0-0"] small').textContent(),'출석','both views share edits');
          await page.locator('[data-member-id="m0-0"]').click();
          await page.locator('[data-member-id="m4-10"]').click();
          assert.equal(await page.locator('#raSaveStatus').textContent(),'미저장 1명');
          assert.equal(await page.locator('[data-member-id="m4-10"] small').textContent(),'출석');
          await page.evaluate(()=>testFail=true);
          await page.locator('#raSave').click();await page.waitForSelector('.ra-error');
          assert.equal(await page.locator('#raSaveStatus').textContent(),'미저장 1명','failed save preserves changes');
          await page.evaluate(()=>testFail=false);
          await page.locator('#raSave').click();await page.waitForFunction(()=>document.getElementById('raSaveStatus').textContent.startsWith('저장'));
          assert.deepEqual(await page.evaluate(()=>testSaves[1].changes),[{id:'m4-10',status:'출석',baselineStatus:''}]);
          await page.locator('.ra-summary summary').click();
          assert((await page.locator('.ra-summary tbody').textContent()).includes('50%'),'only elapsed configured dates count');
          await page.locator('#raDate').selectOption('2026-10-11');
          assert(await page.locator('[data-member-id="m4-10"]').isDisabled(),'future dates read-only');
          await page.locator('#raDate').selectOption('2026-10-04');
          await page.locator('[data-member-id="m4-10"]').click();
          page.once('dialog',d=>d.dismiss());
          await page.evaluate(()=>closeModal('modalRehearsalAttendance'));
          assert(await page.locator('#modalRehearsalAttendance').evaluate(el=>el.classList.contains('active')),'dirty close protected');
          await page.locator('#raSave').click();await page.waitForFunction(()=>document.getElementById('raSaveStatus').textContent.startsWith('저장'));
          fs.mkdirSync(path.join(root,'tmp/rehearsal-attendance'),{recursive:true});
          await page.screenshot({path:path.join(root,'tmp/rehearsal-attendance',engine.name()+'-'+viewport.width+'.png')});
          await page.evaluate(()=>{testData.canManage=true;RehearsalAttendance.reload();});
          await page.waitForSelector('.ra-config');await page.locator('.ra-config summary').click();
          await page.locator('#raAddDate').fill('2026-10-10');
          await page.getByRole('button',{name:'날짜 추가',exact:true}).click();
          await page.locator('#raConfigSave').click();
          await page.waitForFunction(()=>testConfig.length===1&&document.querySelectorAll('#raDate option').length===6);
          assert((await page.evaluate(()=>testConfig[0].dates)).includes('2026-10-10'));
          if(viewport.width===390){
            await page.evaluate(()=>{testData.today='2026-10-03';testData.scope=['ALL'];testData.canEdit=true;closeModal('modalRehearsalAttendance');});
            await page.evaluate(()=>openRehearsalAttendance());
            assert.equal(await page.locator('#raDate').inputValue(),'2026-09-20','defaults to last elapsed date instead of disabled future');
            assert(!(await page.locator('[data-member-id="m0-1"]').isDisabled()),'administrator checks all parts');
            await page.evaluate(()=>{testData.plan=null;testData.config.planId='';RehearsalAttendance.reload();});
            await page.waitForFunction(()=>document.getElementById('raPlan')&&document.getElementById('raPlan').value==='');
            assert.equal(await page.locator('.ra-board').count(),0,'unconfigured plan must not guess a target');
            await page.locator('#raPlan').selectOption('entire');
            await page.locator('#raConfigSave').click();
            await page.waitForFunction(()=>testConfig.length===2);
            await page.evaluate(()=>{testData.plan={publicId:'entire',name:'전체',rows:createSeatingRows(1,2),orchestraRows:[]};testData.canManage=false;testData.canEdit=false;RehearsalAttendance.reload();});
            await page.waitForSelector('.ra-board');assert.equal(await page.locator('.ra-config').count(),0);
            assert(await page.locator('#raSave').isDisabled(),'view-only cannot save');
            await page.evaluate(()=>{canViewAttendance=()=>false;canCheckAttendance=()=>false;RehearsalAttendance.syncAccess();});
            assert.equal(await page.locator('#rehearsalAttendanceBody').textContent(),'','revoked permission clears attendance data');
          }
          assert.deepEqual(errors,[]);await page.close();
        }
        console.log('PASS '+engine.name()+': member orientation/stagger, scoped tap, save/retry, date selection, elapsed rate, dirty protection, admin configuration, phone/tablet/landscape scroll');
      }finally{await browser.close();}
    }
  }finally{await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
