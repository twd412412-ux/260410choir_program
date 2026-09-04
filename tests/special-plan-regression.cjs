const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');

(async () => {
  // Exercise real rendering/aggregation with fixture data, without the live Firebase bootstrap.
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'),'utf8')
    .replace(/^init\(\);\r?$/m,'').replace(/^initInstallUi\(\);\r?$/m,'');
  const server = http.createServer((req, res) => {
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); }
    else { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({headless:true, channel:'msedge'});
    const page = await browser.newPage({viewport:{width:390,height:844}});
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto('http://127.0.0.1:'+server.address().port+'/',{waitUntil:'load'});
    const result = await page.evaluate(() => {
      const emptySnapshot={docs:[],empty:true,exists:false,forEach:function(){},data:function(){return {};}};
      const fixtureQuery={get:function(){return Promise.resolve(emptySnapshot);},collection:function(){return this;},doc:function(){return this;},where:function(){return this;},orderBy:function(){return this;},limit:function(){return this;}};
      db=fixtureQuery;
      fixtureQuery.onSnapshot=function(){return function(){};};
      adminRole='admin';specialPlanReviewRules={};
      specialPlanHistorySongs=[];allSongs=[];specialPlanSavedRows=[];
      function item(title,members,pianists,dateValue='2026-09-11'){
        return {date:specialPlanParseLocalDate(dateValue),dateValue:dateValue,timeValue:'19:30',
          event:'시각선교부',songName:title,members:members,pianists:pianists,location:'',rolePeople:{},memberChecks:[],pianistChecks:[]};
      }
      const a=item('당신은 특별한 사람 (당특사)',['김수아','이가원'],['김미례']);
      const b=item('당특사',['이가원','김수아'],['김미례']);
      const c=item('다른 특송',['이가원','김수아'],['박지효']);
      specialPlanItems=[a,b,c];
      let data=buildSpecialPlanRangePeople(specialPlanItems,'2026-09-06','2026-09-06');
      const unconfirmed=data.records.length;
      specialPlanRules()[specialPlanSongPair(a.songName,b.songName)]='same';
      specialPlanRules()[specialPlanSongPair(a.songName,c.songName)]='different';
      specialPlanRules()[specialPlanSongPair(b.songName,c.songName)]='different';
      data=buildSpecialPlanRangePeople(specialPlanItems,'2026-09-06','2026-09-06');
      const confirmed=data.records.length;
      const origins=data.records[0].origins.length;
      // Date/song/pianist equality must still merge different rosters, retaining every participant.
      const extra=item('당신은 특별한 사람',['새단원'],['김미례']);
      let union=buildSpecialPlanRangePeople([a,extra],'2026-09-06','2026-09-06');
      const unionMembers=union.records[0].item.members.length;
      const originalMembers=a.members.length;
      const separateDay=buildSpecialPlanRangePeople([a,item(a.songName,a.members,a.pianists,'2026-09-12')],'2026-09-06','2026-09-06').records.length;
      specialPlanHistorySongs=[{id:'sunday',year:2026,month:9,day:13,category:'주일찬송',songName:'제외',members:'김수아',pianist:'김미례'}];
      const sunday=buildSpecialPlanRangePeople([],'2026-09-13','2026-09-13').records.length;
      specialPlanHistorySongs=[];
      const weeks=buildSpecialPlanWeeks(specialPlanItems);
      const weekTotal=specialPlanPeopleRows(weeks[0].members).find(x=>x.name==='김수아').total;
      document.querySelectorAll('.page,.admin-sub').forEach(el=>el.classList.add('hidden'));
      document.getElementById('pageAdmin').classList.remove('hidden');
      document.getElementById('subSongRecommend').classList.remove('hidden');
      document.getElementById('specialPlanTool').classList.remove('hidden');
      specialPlanRangeFilter={start:'2026-09-06',end:'2026-09-20',min:1,sort:'desc',search:''};
      renderSpecialPlanResults(specialPlanItems);
      const matrixColumns=document.querySelectorAll('.sp-matrix thead th').length;
      document.querySelectorAll('.special-plan-members').forEach(el=>el.open=true);
      selectSpecialPlanMessage(0,true);
      specialPlanMessageIntro='안녕하세요~~ 맛점하시었나요\n시각선교부 특송합니다';
      updateSpecialPlanMessage();
      const message=document.getElementById('spMessageOutput').value;
      document.getElementById('specialPlanRangeStart').value='2026-08-26';
      updateSpecialPlanRangeFilter();
      const normalizedStart=specialPlanRangeFilter.start;
      const differentTitleKey=specialPlanComparableSongKey('나의 사랑')!==specialPlanComparableSongKey('나의 소망');
      const mr=buildSpecialPlanRangePeople([item('동일 곡',['가'],['MR']),item('동일 곡',['나'],['MR'])],'2026-09-06','2026-09-06');
      selectSpecialPlanMessage(1,true);
      const multi=document.getElementById('spMessageOutput').value;
      document.getElementById('spMessageOutput').value='직접 고친 전달문';
      document.getElementById('spMessageOutput').dispatchEvent(new Event('input'));
      renderSpecialPlanRangeSummary(specialPlanItems);
      const preserved=document.getElementById('spMessageOutput').value;
      specialPlanReviewRules={};renderSpecialPlanResults(specialPlanItems);
      const pairIndex=specialPlanCurrentData.candidates.findIndex(p=>p.a.item.songName===a.songName&&p.b.item.songName===b.songName);
      specialPlanReviewPair(pairIndex,'same');specialPlanReviewRules=null;
      const remembered=specialPlanSongEquivalent(a.songName,b.songName);
      return {unconfirmed,confirmed,origins,unionMembers,originalMembers,separateDay,sunday,weekTotal,matrixColumns,message,normalizedStart,differentTitleKey,mr:mr.records.length,mrPeople:Object.keys(mr.pianists).length,multi,preserved,remembered};
    });
    assert.equal(result.unconfirmed,3);
    assert.equal(result.confirmed,2);
    assert.equal(result.origins,2);
    assert.equal(result.unionMembers,3);
    assert.equal(result.originalMembers,2);
    assert.equal(result.separateDay,2);
    assert.equal(result.sunday,0);
    assert.equal(result.weekTotal,2);
    assert.equal(result.matrixColumns,4);
    assert.ok(result.message.includes('9월11일(금) 오후7시30분'));
    assert.ok(result.message.includes('장소: ?'));
    assert.ok(result.message.startsWith('안녕하세요~~'));
    assert.equal(result.normalizedStart,'2026-08-23');
    assert.ok(result.differentTitleKey);
    assert.equal(result.mr,1);
    assert.equal(result.mrPeople,0);
    assert.ok(result.multi.includes('곡명: 다른 특송'));
    assert.equal(result.preserved,'직접 고친 전달문');
    assert.ok(result.remembered);
    for(const width of [390,768,1280]){
      await page.setViewportSize({width,height:900});
      await page.evaluate(()=>document.querySelectorAll('.special-plan-members').forEach(el=>el.open=true));
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'overflow at '+width);
    }
    await page.setViewportSize({width:390,height:844});
    await page.locator('#specialPlanResults').screenshot({path:require('node:os').tmpdir()+'/choir-special-plan-review.png'});
    assert.deepEqual(errors,[]);
    console.log('PASS: dedupe, evidence, weekly counts, Sunday exclusion, date normalization, message format and responsive layouts');
    console.log(JSON.stringify(result,null,2));
  } finally {
    if(browser)await browser.close();
    await new Promise(resolve=>server.close(resolve));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
