const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium, webkit } = require('playwright');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
  .replace(/^init\(\);\r?$/m, '').replace(/^initInstallUi\(\);\r?$/m, '');
(async () => {
  const server = http.createServer((req, res) => {
    if (require('./serve-firebase-sdk.cjs')(req, res)) return;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const engine of [chromium, webkit]) {
      const browser = await engine.launch(engine === chromium ? { channel: 'msedge' } : {});
      try {
        for (const width of [390, 820]) {
          const page = await browser.newPage({ viewport: { width, height: 1180 } });
          const errors = [];
          page.on('pageerror', error => errors.push(error.message));
          await page.route(/firestore\.googleapis\.com|firebasestorage\.googleapis\.com|cloudfunctions\.net/, route => route.abort());
          await page.goto('http://127.0.0.1:' + server.address().port);
          await page.evaluate(() => {
            firebaseAuthReady = true;
            ensureScoreRealtimeSync = () => Promise.resolve([]);
            resumeScoreRealtimeSync = () => {};
            canViewPublishedSeating = () => true;
            canViewSeatingPlan = () => false;
            currentTab = 'home';
            currentUser = { id: 'viewer', name: 'viewer' };
            requestHomeRender = () => {
              document.getElementById('pageHome').innerHTML = renderPublicSeatingHomeCard(publishedSeatingPlan, false);
            };
            db = { collection: () => ({ doc: () => ({ onSnapshot: (options, next) => {
              window.deliverPublication = next;
              return () => {};
            } }) }) };
            const rows = createSeatingRows(4, 10);
            rows[0].seats[0] = { memberId: 'member', name: 'BEFORE', part: 'S1' };
            window.livePlan = { publicId: 'plan:live', sourcePlanId: 'live', name: 'LIVE PLAN', rows, publishedAt: '2026-09-20T01:00:00Z' };
            setPublishedSeatingState([livePlan]);
            publishedSeatingLoaded = true;
            publishedSeatingLastCheckedAt = Date.now();
            requestHomeRender();
            // Unsaved editor data must stay independent of incoming publications.
            seatingRows = [{ label: 'draft', seats: [{ name: 'UNSAVED' }] }];
            seatingDirty = true;
            return openPublicSeatingModal('plan:live');
          });
          await page.locator('#modalPublicSeating.active').waitFor();
          assert.ok((await page.locator('#publicSeatingBody').innerText()).includes('BEFORE'));
          await page.evaluate(() => {
            publicSeatingAutoFit = false;
            publicSeatingZoom = 1.5;
            livePlan.rows[0].seats[0].name = 'AFTER';
            livePlan.name = 'UPDATED PLAN';
            deliverPublication({ exists: true, data: () => ({ plans: [livePlan] }), metadata: { fromCache: false, hasPendingWrites: false } });
          });
          assert.ok((await page.locator('#publicSeatingBody').innerText()).includes('AFTER'));
          assert.ok(!(await page.locator('#publicSeatingBody').innerText()).includes('BEFORE'));
          assert.ok((await page.locator('#pageHome').innerText()).includes('UPDATED PLAN'));
          assert.deepEqual(await page.evaluate(() => [publicSeatingZoom, publicSeatingView, seatingRows[0].seats[0].name, seatingDirty]), [1.5, 'member', 'UNSAVED', true]);
          await page.evaluate(() => deliverPublication({ exists: false, metadata: { fromCache: false } }));
          assert.ok((await page.locator('#publicSeatingBody').innerText()).includes('아직 공개된 자리배치가 없습니다'));
          assert.deepEqual(errors, []);
          await page.close();
          console.log(engine.name(), width, 'cached viewer update/unpublish/editor preservation passed');
        }
      } finally { await browser.close(); }
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
