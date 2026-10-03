const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
(async()=>{
  const html=fs.readFileSync(path.join(root,'index.html'),'utf8').replace(/^init\(\);\r?$/m,'').replace(/^initInstallUi\(\);\r?$/m,'');
  const server=http.createServer((req,res)=>{if(require('./serve-firebase-sdk.cjs')(req,res))return;res.setHeader('Content-Type','text/html;charset=utf-8');res.end(html);});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const browser=await chromium.launch({channel:'msedge'});
  try{
    const page=await browser.newPage({viewport:{width:390,height:844},colorScheme:'light'});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route(/firestore\.googleapis\.com|firebasestorage\.googleapis\.com|cloudfunctions\.net/,r=>r.abort());
    await page.goto('http://127.0.0.1:'+server.address().port);
    const checks=await page.evaluate(async()=>{
      window.claims={admin:true,elevatedUntil:Date.now()+600000};window.refreshes=[];
      const user={getIdTokenResult:async force=>{refreshes.push(force);return {claims};}};
      window.testAuth={currentUser:user};ensureFirebaseAuth=async()=>testAuth;
      async function code(c){claims=c;try{await prepareScoreFileUpload();return 'ok';}catch(e){return e.code;}}
      const values=[await code({admin:true,elevatedUntil:Date.now()+600000}),
        await code({admin:true,elevatedUntil:1}),await code({account:true,permissions:['score.manage']}),
        await code({account:true,permissions:[]}),await code({account:false,permissions:['score.manage']})];
      user.getIdTokenResult=async()=>{secureAuthSessionEpoch++;return {claims:{admin:true,elevatedUntil:Date.now()+600000}};};
      try{await prepareScoreFileUpload();values.push('unexpected');}catch(e){values.push(e.code);}
      user.getIdTokenResult=async force=>{refreshes.push(force);return {claims};};
      return {values,refreshes,messages:['storage/unauthorized','storage/retry-limit-exceeded','storage/quota-exceeded'].map(code=>scoreUploadErrorMessage({code}))};
    });
    assert.deepEqual(checks.values,['ok','score/admin-expired','ok','storage/unauthorized','storage/unauthorized','storage/unauthenticated']);
    assert(checks.refreshes.every(Boolean),'fresh token required before upload');
    assert(new Set(checks.messages).size===3,'specific failures must not share generic message');
    await page.evaluate(()=>{
      adminRole='admin';currentUser=null;allSongs=[];allScores=[];
      canManageScores=()=>true;renderScoreManage=()=>{};requestHomeRender=()=>{};writeLog=()=>{};
      ensureScoreRealtimeSync=async()=>allScores;
      window.puts=[];window.saved=[];window.failFile=true;
      storage={ref:()=>({child:filePath=>({put:()=>{
        puts.push(filePath);
        return {on:(event,progress,error,complete)=>queueMicrotask(()=>{
          if(failFile&&filePath.includes('flute'))error({code:'storage/retry-limit-exceeded'});
          else complete();
        })};
      }})})};
      scoreAdminCall=async(action,input)=>{saved.push(input);return {items:input.items};};
      document.querySelectorAll('.tab-page').forEach(el=>el.classList.add('hidden'));
      document.getElementById('pageAdmin').classList.remove('hidden');document.getElementById('subScoreManage').classList.remove('hidden');
      setScoreFormKind('orchestra');document.getElementById('scoreTitle').value='업로드 테스트';
    });
    await page.locator('#scoreFile').setInputFiles([
      {name:'violin.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-test-one')},
      {name:'flute.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-test-two')}
    ]);
    const guitar=await page.evaluate(()=>{
      const guesses=['여호와의유월절-Guitar.pdf','여호와의유월절-Bass Guitar.pdf','곡-기타.pdf','곡-베이스기타.pdf','곡-Double Bass.pdf','곡-Bassoon.pdf'].map(guessScoreInstrumentFromFileName);
      populateScoreInstrumentSelect();
      return {guesses,labels:scoreUploadReviewOptionLabels(),review:scoreUploadReviewInstrument('기타'),other:scoreInstrumentLabel('etc'),defaultParts:getScoreUploadExpectedParts()};
    });
    assert.deepEqual(guitar.guesses,['guitar','bassguitar','guitar','bassguitar','bass','bassoon']);
    assert(guitar.labels.includes('기타')&&guitar.labels.includes('베이스 기타')&&guitar.labels.includes('그 외 악기'));
    assert.equal(guitar.review,'guitar');assert.equal(guitar.other,'그 외 악기');
    assert.equal(guitar.defaultParts.includes('guitar'),false,'do not silently expand existing missing-part checklist');
    async function save(){await page.evaluate(async()=>{syncScoreUploadReviewRows(Array.from(document.getElementById('scoreFile').files));scoreUploadReviewConfirmed=true;scoreBatchReplacementConfirmed=true;await saveScoreUpload();});}
    await page.evaluate(()=>{claims={admin:true,elevatedUntil:1};});
    await save();
    assert.equal(await page.evaluate(()=>puts.length),0,'expired administrator cannot start file uploads');
    assert((await page.locator('#scoreUploadReviewList').innerText()).includes('관리자 인증이 만료'));
    assert.equal(await page.locator('#scoreFile').evaluate(el=>el.files.length),2,'files retained after failed preflight');
    await page.evaluate(()=>{claims={admin:true,elevatedUntil:Date.now()+600000};});
    await save();
    assert.equal(await page.evaluate(()=>puts.length),2);
    assert.equal(await page.evaluate(()=>saved.length),0,'partial failed batch must not change versions');
    assert((await page.locator('#scoreUploadReviewList').innerText()).includes('네트워크 연결'));
    await page.evaluate(()=>{failFile=false;});await save();
    assert.equal(await page.evaluate(()=>puts.length),3,'retry reuses successful uploaded file');
    assert.equal(await page.evaluate(()=>saved.length),1);
    assert.equal(await page.evaluate(()=>saved[0].items.length),2);
    assert.deepEqual(errors,[]);
    console.log('PASS: fresh auth, expired admin, revoked permission, session change, specific failure messages, file preservation, partial batch and safe retry');
  }finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
