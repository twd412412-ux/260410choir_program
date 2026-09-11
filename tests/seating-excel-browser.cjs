const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const ExcelJS=require('../assets/vendor/exceljs-4.4.0.min.js');
const {boardGeometry,reserveRows}=require('../assets/seating-workbook.js');
const root=path.join(__dirname,'..');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8').replace(/^init\(\);\r?$/m,'').replace(/^initInstallUi\(\);\r?$/m,'');
const photoPath=process.env.SEATING_PHOTO_PLAN;
const fixture=photoPath?JSON.parse(fs.readFileSync(photoPath,'utf8')):{id:'test-source',name:'배치 테스트',title:'합창',date:'2026-09-11',program:'전체 합창',attendees:{a:true,b:true},rows:[{label:'1단',offset:.5,seats:[{memberId:'a',name:'가단원',part:'S1',highlight:false,locked:false},{memberId:'b',name:'나단원',part:'T2',highlight:false,locked:false}]},{label:'0단',offset:0,seats:[null,null]}],orchestraRows:[],specialSlots:{conductor:null,accompanist:null,staff:[null]}};
(async()=>{
  const server=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://localhost');
    if(url.pathname.startsWith('/assets/')){
      const p=path.resolve(root,'.'+url.pathname);
      if(!p.startsWith(path.join(root,'assets')+path.sep)||!fs.existsSync(p)){res.writeHead(404);res.end();return;}
      res.setHeader('Content-Type','application/javascript');res.end(fs.readFileSync(p));return;
    }
    res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
  try{
    browser=await chromium.launch({channel:'msedge',headless:true});
    const page=await browser.newPage({viewport:{width:820,height:1180},acceptDownloads:true});
    const errors=[],assets=[];
    page.on('pageerror',e=>errors.push(e.message));
    page.on('request',r=>{if(r.url().includes('/assets/'))assets.push(r.url());});
    await page.route(/firestore\.googleapis\.com|firebasestorage\.googleapis\.com|cloudfunctions\.net/,r=>r.abort());
    await page.goto('http://127.0.0.1:'+server.address().port+'/');
    await page.evaluate(p=>{
      ensureScoreRealtimeSync=()=>Promise.resolve([]);canUseSeatingPlan=()=>true;saveSeatingDraftNow=()=>{};
      window.confirm=()=>true;showToast=m=>{window.lastToast=m;};
      const sub=document.getElementById('subSeatingPlan');document.body.appendChild(sub);
      [...document.body.children].forEach(e=>{if(e!==sub&&!e.classList.contains('modal-overlay')&&e.tagName!=='SCRIPT')e.style.display='none';});
      sub.classList.remove('hidden');sub.style.removeProperty('display');sub.classList.add('seating-fullscreen');
      seatingPlans=[p];seatingMembers=p.rows.flatMap(r=>r.seats).filter(Boolean).map(s=>({id:s.memberId,name:s.name,part:s.part}));
      seatingMemberPanelCollapsed=true;seatingSettingsOpen=true;applySeatingPlan(p);
    },fixture);
    assert.ok(!assets.some(u=>/excel|workbook/.test(u)),'Excel code loaded before use');
    await page.locator('.seating-settings-actions [onclick="openSeatingExcel()"]').click();
    await page.locator('#modalSeatingExcel.active').waitFor();
    const downloadPromise=page.waitForEvent('download');
    await page.locator('#seatingExcelDownload').click();
    const download=await downloadPromise;
    assert.equal(download.suggestedFilename(),fixture.name+'.xlsx');
    const out=path.join(root,'tmp','seating-excel');fs.mkdirSync(out,{recursive:true});
    const file=path.join(out,download.suggestedFilename());await download.saveAs(file);
    const wb=new ExcelJS.Workbook();await wb.xlsx.load(fs.readFileSync(file));
    const grid=wb.getWorksheet('합창 배치');
    const geometry=boardGeometry(reserveRows(fixture.rows)),first=geometry[0],last=geometry[geometry.length-1];
    assert.equal(grid.getCell(last.row,last.start).dataValidation.type,'list');
    assert.deepEqual(grid.getCell(last.row,last.start).dataValidation.formulae,['ChoirMemberNames']);
    assert.ok(wb.getWorksheet('_단원목록').rowCount>0);
    assert.equal(wb.getWorksheet('_단원목록').state,'veryHidden');
    grid.getCell(last.row,last.start).value=grid.getCell(first.row,first.start).value;grid.getCell(first.row,first.start).value=null;
    const edited=Buffer.from(await wb.xlsx.writeBuffer());
    await page.locator('#seatingExcelFile').setInputFiles({name:'edited.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:edited});
    await page.locator('#seatingExcelPreview:not([hidden])').waitFor();
    assert.match(await page.locator('#seatingExcelStatus').innerText(),/배치/);
    for(const viewport of [{width:820,height:1180},{width:390,height:844},{width:844,height:390}]){
      await page.setViewportSize(viewport);
      await page.locator('#seatingExcelApply').scrollIntoViewIfNeeded();
      const box=await page.locator('#seatingExcelApply').boundingBox();
      assert.ok(box.x>=0&&box.x+box.width<=viewport.width+1&&box.y>=0&&box.y+box.height<=viewport.height+1,'apply not reachable');
      await page.screenshot({path:path.join(out,`preview-${viewport.width}.png`)});
    }
    await page.locator('#seatingExcelApply').click();
    const state=await page.evaluate(()=>({id:seatingPlanId,first:seatingRows[0].seats[0],front:seatingRows[seatingRows.length-1].seats[0],dirty:seatingDirty}));
    assert.equal(state.id,'');assert.equal(state.first,null);assert.equal(state.front.memberId,fixture.rows[0].seats[0].memberId);assert.equal(state.dirty,true);
    await page.evaluate(()=>undoSeatingChange());assert.equal(await page.evaluate(()=>seatingPlanId),fixture.id);
    await page.evaluate(()=>SeatingExcel.open());
    await page.locator('#seatingExcelFile').setInputFiles({name:'edited.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:edited});
    await page.locator('#seatingExcelPreview:not([hidden])').waitFor();
    await page.evaluate(()=>{seatingRows[0].seats[0].highlight=true;});
    await page.locator('#seatingExcelApply').click();assert.equal(await page.evaluate(()=>seatingPlanId),fixture.id);
    assert.match(await page.locator('#seatingExcelStatus').innerText(),/변경되었습니다/);
    await page.evaluate(()=>{closeModal('modalSeatingExcel');canUseSeatingPlan=()=>false;openSeatingExcel();});
    assert.equal(await page.locator('#modalSeatingExcel').getAttribute('class'),'modal-overlay modal-center seating-special-modal');
    assert.deepEqual(errors,[]);
    console.log('PASS: lazy load, real XLSX download/edit/upload, front row move, preview, mobile/tablet reachability, new ID, undo, stale preview, permissions. Output: '+file);
  }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
