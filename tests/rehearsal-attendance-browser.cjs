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
          // 9/20 was never checked: it is reported as unchecked, not as an absence in the rate.
          const rateRow=await page.locator('.ra-member-table tbody tr',{hasText:'단원4-10'}).locator('td').allTextContents();
          assert.deepEqual(rateRow.slice(1),['·','✓','1/1','1','100%'],'per-date marks, rate over checked days only, future dates excluded');
          assert.equal(await page.locator('.ra-member-table thead th').count(),6,'name, two elapsed dates, present, unchecked, rate');
          const overview=await page.locator('.ra-part-overview tbody tr',{hasText:'S1'}).locator('td').allTextContents();
          assert.equal(overview[0],'미체크','a session nobody checked is flagged per part');
          assert.match(overview[1],/^1\/30 미체크 29$/);
          // A failed save can reload the latest server records while keeping the unsaved checks.
          await page.locator('[data-member-id="m2-0"]').click();
          await page.evaluate(()=>testFail=true);
          await page.locator('#raSave').click();
          await page.getByRole('button',{name:'최신 불러오기 (내 체크 유지)',exact:true}).waitFor();
          await page.evaluate(()=>{testFail=false;testData.sessions={'2026-10-04':{records:{'m4-10':'출석','m3-0':'출석'},memberIds:testData.members.map(m=>m.id),updatedAt:'2026-10-04T00:00:00Z',updatedBy:'다른 파트장'}};});
          await page.getByRole('button',{name:'최신 불러오기 (내 체크 유지)',exact:true}).click();
          await page.waitForFunction(()=>document.getElementById('raSaveStatus').textContent==='미저장 1명');
          assert.equal(await page.locator('[data-member-id="m3-0"] small').textContent(),'출석','latest server checks are loaded');
          assert.equal(await page.locator('[data-member-id="m2-0"] small').textContent(),'출석','unsaved check is kept');
          await page.locator('#raSave').click();await page.waitForFunction(()=>document.getElementById('raSaveStatus').textContent.startsWith('저장'));
          assert.deepEqual(await page.evaluate(()=>testSaves.at(-1).changes),[{id:'m2-0',status:'출석',baselineStatus:''}]);
          await page.locator('#raDate').selectOption('2026-10-11');
          assert(await page.locator('[data-member-id="m4-10"]').isDisabled(),'future dates read-only');
          await page.locator('#raDate').selectOption('2026-10-04');
          await page.locator('[data-member-id="m4-10"]').click();
          page.once('dialog',d=>d.dismiss());
          await page.evaluate(()=>closeModal('modalRehearsalAttendance'));
          assert(await page.locator('#modalRehearsalAttendance').evaluate(el=>el.classList.contains('active')),'dirty close protected');
          await page.locator('#raSave').click();await page.waitForFunction(()=>document.getElementById('raSaveStatus').textContent.startsWith('저장'));
          // Bulk absence follows the part filter, not the name search.
          await page.locator('.ra-view-row input[type=search]').fill('단원0-0');
          let bulkMessage='';page.once('dialog',d=>{bulkMessage=d.message();d.accept();});
          await page.getByRole('button',{name:'미체크 결석',exact:true}).click();
          assert.match(bulkMessage,/^S1 미체크 \d+명을 결석으로 표시할까요\?\n검색어와 관계없이 적용됩니다\.$/);
          const bulkCount=Number(bulkMessage.match(/미체크 (\d+)명/)[1]);
          assert(bulkCount>1,'search must not narrow the bulk absence to one member');
          assert.equal(await page.locator('#raSaveStatus').textContent(),'미저장 '+bulkCount+'명');
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
            await page.getByRole('button',{name:'명단',exact:true}).click();
            const parts=await page.locator('.ra-member small').allTextContents();
            assert(parts.slice(0,30).every(t=>t.startsWith('S1'))&&parts.slice(30).every(t=>t.startsWith('T1')),'part groups before name ordering');
            assert.equal(await page.locator('#raPart option[value="관현악"]').count(),0);
            assert.equal(await page.locator('.ra-summary summary').textContent(),'리허설 출석 현황');
            // Attendance board: low-rate first by default, header toggles, part tabs, under-50% filter, details, remembered choices.
            await page.evaluate(()=>{const ids=testData.members.map(m=>m.id);testData.sessions={'2026-09-20':{records:{'m0-0':'결석','m0-2':'출석','m0-4':'출석','m0-1':'결석','m0-3':'출석'},memberIds:ids,updatedAt:'2026-09-20T10:00:00Z',updatedBy:'S1 파트장'}};RehearsalAttendance.reload();});
            await page.waitForSelector('.ra-summary');await page.locator('.ra-summary summary').click();
            const names=()=>page.locator('.ra-member-table .ra-name').allTextContents();
            const s1=(await names()).filter(n=>/^단원\d+-(0|2|4|6|8|10)$/.test(n));
            assert.deepEqual(s1.slice(0,3),['단원0-0','단원0-2','단원0-4'],'lowest rate first, then unrated members by name');
            assert.equal(await page.locator('.ra-sort[data-key="rate"]').textContent(),'출석률 ▲');
            await page.locator('.ra-sort[data-key="rate"]').click();
            assert.equal(await page.locator('.ra-sort[data-key="rate"]').textContent(),'출석률 ▼');
            assert.deepEqual((await names()).slice(0,3),['단원0-2','단원0-4','단원0-0'],'highest first inside the S1 group; unrated stay last');
            assert.equal(await page.locator('.ra-part-row').count(),2,'all tab keeps part groups');
            await page.locator('.ra-low-filter input').check();
            assert.deepEqual(await names(),['단원0-0','단원0-1'],'under 50% only');
            await page.locator('.ra-summary-tabs button',{hasText:'T1'}).click();
            assert.deepEqual(await names(),['단원0-1']);
            assert.equal(await page.locator('.ra-part-row').count(),0);
            await page.locator('.ra-name',{hasText:'단원0-1'}).click();
            assert.match(await page.locator('.ra-detail-row').textContent(),/09\/20 \(일\) 결석.*S1 파트장 저장/);
            await page.evaluate(()=>RehearsalAttendance.reload());
            await page.waitForSelector('.ra-summary');await page.locator('.ra-summary summary').click();
            assert.equal(await page.locator('.ra-summary-tabs button[aria-selected="true"]').textContent(),'T1','tab is remembered');
            assert(await page.locator('.ra-low-filter input').isChecked(),'filter is remembered');
            assert.equal(await page.locator('.ra-sort[data-key="rate"]').textContent(),'출석률 ▼','sort is remembered');
            assert.equal(await page.evaluate(()=>document.querySelector('.ra-member-table').scrollWidth<=document.querySelector('#modalRehearsalAttendance .modal-content').clientWidth+400),true);
            await page.screenshot({path:path.join(root,'tmp/rehearsal-attendance',engine.name()+'-390-summary.png'),fullPage:false});
            await page.evaluate(()=>{localStorage.removeItem('choir_ra_summary_v1');testData.sessions={};});
            await page.getByRole('button',{name:'자리표',exact:true}).click();
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
