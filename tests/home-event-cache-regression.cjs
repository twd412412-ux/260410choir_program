const fs=require('node:fs'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const html=fs.readFileSync(process.env.SEATING_TEST_HTML||'index.html','utf8').replace(/^init\(\);\r?$/m,'').replace(/^initInstallUi\(\);\r?$/m,'');
(async()=>{
 const server=http.createServer((req,res)=>{if(require('./serve-firebase-sdk.cjs')(req,res))return;res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html)});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({channel:'msedge'});
 try{
  const page=await browser.newPage();
  await page.route(/googleapis\.com|cloudfunctions\.net/,r=>r.abort());
  await page.goto('http://127.0.0.1:'+server.address().port);
  const result=await page.evaluate(async()=>{
   adminRole='admin';requestHomeRender=()=>{};
   const event={id:'night',date:'2099-10-17',endDate:'2099-10-17',title:'찬양의 밤',showEventHub:true,useBriefing:true,program:'1. 전체 합창'};
   let reads=0,fail=false,serverOnly=true;
   db={collection:()=>({where:()=>({get:async options=>{reads++;serverOnly=serverOnly&&options.source==='server';if(fail)throw Error('offline');return {forEach:fn=>fn({id:event.id,data:()=>event})}}})})};
   invalidateHomeEventHubCache();saveCache(HOME_EVENT_CACHE_KEY,[]);
   await loadHomeEventSchedules(false);
   const emptyCacheRecovered=selectHomeEventSchedule(homeEventSchedules)?.id==='night';
   const card=renderHomeEventHubCard(selectHomeEventSchedule(homeEventSchedules));
   await loadHomeEventSchedules(false);
   const deduped=reads===1;
   invalidateHomeEventHubCache();saveCache(HOME_EVENT_CACHE_KEY,[event]);fail=true;
   let rejected=false;try{await loadHomeEventSchedules(false)}catch(e){rejected=true}
   const retained=homeEventSchedules[0]?.id==='night'&&!homeEventSchedulesLoaded;
   fail=false;await loadHomeEventSchedules(false);
   return {emptyCacheRecovered,deduped,rejected,retained,serverOnly,retried:reads===3,card:card.includes('행사 프로그램')&&card.includes('전체 합창')};
  });
  for(const [key,value] of Object.entries(result))assert.equal(value,true,key);
  console.log('PASS empty cache recovery, cached content retention, server verification, deduplication, failed-load retry and program rendering');
 }finally{await browser.close();await new Promise(r=>server.close(r))}
})().catch(e=>{console.error(e);process.exitCode=1});
