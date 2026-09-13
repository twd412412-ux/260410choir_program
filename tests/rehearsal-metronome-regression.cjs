const fs=require('node:fs'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium,webkit}=require('playwright');
const html=fs.readFileSync(process.env.SEATING_TEST_HTML||'index.html','utf8').replace(/^init\(\);\r?$/m,'').replace(/^initInstallUi\(\);\r?$/m,'');
(async()=>{
 const server=http.createServer((req,res)=>{if(require('./serve-firebase-sdk.cjs')(req,res))return;res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html)});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=process.env.TEST_WEBKIT?await webkit.launch():await chromium.launch({channel:'msedge'});
 try{
  const page=await browser.newPage({viewport:{width:820,height:1180},hasTouch:true});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route(/googleapis\.com|cloudfunctions\.net/,r=>r.abort());
  await page.goto('http://127.0.0.1:'+server.address().port);
  const audioSupported=await page.evaluate(()=>{
   adminRole='admin';rehearsalOwnerId='fixture';rehearsalScheduleId='fixture';allSchedules=[{id:'fixture',title:'리허설 테스트',date:'2099-10-17',program:'첫 곡\n둘째 곡'}];
   rehearsalItems=rehearsalItemsFromSchedule(allSchedules[0]);document.getElementById('modalRehearsalCue').classList.add('active');renderRehearsalCue();
   window.ticks=[];window.peak=0;
   const Audio=window.AudioContext||window.webkitAudioContext;if(!Audio)return false;
   const ctx=new Audio();rehearsalMetro.context=ctx;
   const analyser=ctx.createAnalyser();analyser.connect(ctx.destination);
   const createGain=ctx.createGain.bind(ctx);ctx.createGain=function(){const gain=createGain();const connect=gain.connect.bind(gain);gain.connect=function(){return connect(analyser)};return gain;};
   const create=ctx.createOscillator.bind(ctx);ctx.createOscillator=function(){const node=create(),start=node.start.bind(node);node.start=function(at){ticks.push({at,freq:node.frequency.value});return start(at)};return node;};
   window.sampleTimer=setInterval(()=>{const samples=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(samples);for(const sample of samples)peak=Math.max(peak,Math.abs(sample));},10);
   setRehearsalMetronome('bpm',240);setRehearsalMetronome('beats',3);
   return true;
  });
  if(!audioSupported){await page.locator('#rehearsalMetroToggle').click();assert.equal(await page.evaluate(()=>rehearsalMetro.starting||rehearsalMetro.running),false);assert.match(await page.locator('#toast').innerText(),/소리를 켤 수 없습니다/);assert.deepEqual(errors,[]);console.log('PASS unsupported-audio fallback only; this engine cannot validate sound');return;}
  await page.locator('#rehearsalMetroToggle').click();await page.waitForTimeout(1200);
  const audio=await page.evaluate(()=>({running:rehearsalMetro.running,ticks,peak}));
  assert(audio.running);assert(audio.peak>0.001,'non-silent generated audio');assert(audio.ticks.length>=4);
  assert.deepEqual(audio.ticks.slice(0,4).map(t=>t.freq),[1320,880,880,1320]);
  for(let i=1;i<audio.ticks.length;i++)assert(Math.abs(audio.ticks[i].at-audio.ticks[i-1].at-.25)<.001,'audio clock spacing');
  await page.locator('#rehearsalMetroToggle').click();
  assert.equal(await page.evaluate(()=>rehearsalMetro.running||rehearsalMetro.nodes.length>0),false);
  for(const size of [{width:320,height:844},{width:820,height:1180},{width:1180,height:820}]){
   await page.setViewportSize(size);
   for(const light of [false,true]){
    await page.evaluate(light=>document.getElementById('modalRehearsalCue').classList.toggle('theme-light',light),light);
    await page.locator('#rehearsalMetronome').scrollIntoViewIfNeeded();
    assert.equal(await page.locator('#rehearsalMetronome').evaluate(el=>el.scrollWidth>el.clientWidth),false);
    await page.screenshot({path:`tmp/metronome-${size.width}-${light?'light':'dark'}.png`});
   }
  }
  await page.evaluate(()=>{setRehearsalMetronome('bpm',1000);});assert.equal(await page.locator('#rehearsalMetroBpm').inputValue(),'240');
  await page.locator('#rehearsalMetroToggle').click();await page.waitForTimeout(100);
  await page.evaluate(()=>selectRehearsalCue(1));assert.equal(await page.evaluate(()=>rehearsalMetro.running),false);
  await page.locator('#rehearsalMetroToggle').click();await page.waitForTimeout(100);
  await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')));assert.equal(await page.evaluate(()=>rehearsalMetro.running),false);
  await page.evaluate(()=>{clearInterval(sampleTimer);teardownRehearsalCue();});
  assert.deepEqual(errors,[]);console.log('PASS audible samples, accent/tempo timing, stop cleanup, song/page exit, limits and responsive light/dark controls');
 }finally{await browser.close();await new Promise(r=>server.close(r))}
})().catch(e=>{console.error(e);process.exitCode=1});
