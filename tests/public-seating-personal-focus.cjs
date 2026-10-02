const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium, webkit } = require('playwright');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/^init\(\);\r?$/m, '').replace(/^initInstallUi\(\);\r?$/m, '');

(async () => {
  const server = http.createServer((req, res) => {
    if (require('./serve-firebase-sdk.cjs')(req, res)) return;
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const engine of [chromium, webkit]) {
      const browser = await engine.launch(engine === chromium ? { channel: 'msedge' } : {});
      try {
        for (const viewport of [{ width: 390, height: 844 }, { width: 820, height: 1180 }]) {
          const page = await browser.newPage({ viewport, hasTouch: true, colorScheme: 'light' });
          const errors = []; page.on('pageerror', error => errors.push(error.message));
          await page.route(/firestore\.googleapis\.com|cloudfunctions\.net/, route => route.abort());
          await page.goto('http://127.0.0.1:' + server.address().port);
          await page.evaluate(() => {
            document.documentElement.classList.remove('dark'); document.body.classList.remove('dark');
            ensureScoreRealtimeSync = () => Promise.resolve([]); canUseSeatingPlan = () => false;
            publicMovementMarkup = () => ''; publicMovementOpen = false;
            currentUser = { id: 'account', memberId: 'm2-18', name: '내이름' };
            const rows = createSeatingRows(5, 38);
            rows.forEach((row, r) => row.seats = row.seats.map((_, c) => ({ memberId: 'm' + r + '-' + c, name: '단원' + r + '-' + c, part: c % 2 ? 'S1' : 'T1' })));
            rows[2].seats[18].name = '내이름';
            publishedSeatingPlan = { publicId: 'fixture', name: '전체 합창', rows, orchestraRows: [], publishedAt: '2026-10-02T09:00:00+09:00', specialSlots: {} };
            publishedSeatingPlans = [publishedSeatingPlan];
            publicSeatingBoardTab = 'choir'; publicSeatingView = 'member'; publicSeatingSearch = '';
            publicSeatingPersonalFocus = true; publicSeatingAutoFit = true;
            openModal('modalPublicSeating'); renderPublicSeatingModalBody();
          });
          await page.waitForFunction(() => publicSeatingZoom === 1 && document.querySelector('.public-seating-board-scroll.personal-focus'));
          const result = await page.evaluate(() => {
            const board = document.getElementById('publicSeatingBoard'), scroller = board.closest('.public-seating-board-scroll');
            const seat = board.querySelector('.mine').getBoundingClientRect(), box = scroller.getBoundingClientRect();
            const mine = findPublicSeatingMine(publishedSeatingPlan)[0];
            const neighbors = publicSeatingNeighbors(publishedSeatingPlan, mine);
            return { dx: Math.abs(seat.left + seat.width / 2 - box.left - scroller.clientWidth / 2), dy: Math.abs(seat.top + seat.height / 2 - box.top - scroller.clientHeight / 2), neighbors, zoom: publicSeatingZoom, width: scroller.clientWidth, bodyOverflow: document.body.scrollWidth > innerWidth + 1 };
          });
          assert(result.dx < 3 && result.dy < 3, JSON.stringify(result));
          assert.equal(result.zoom, 1); assert.equal(result.bodyOverflow, false);
          assert.equal(result.neighbors.left, '단원2-19'); assert.equal(result.neighbors.right, '단원2-17');
          assert.equal(result.neighbors.frontLeft, '단원3-19'); assert.equal(result.neighbors.frontRight, '단원3-18');
          assert.equal(await page.locator('.public-seating-neighbors header').count(), 0);
          const positions=await page.evaluate(() => {
            const rect=c=>document.querySelector(c).getBoundingClientRect();
            const left=rect('.side-left'),self=rect('.public-seating-neighbor-self'),right=rect('.side-right'),front=rect('.front-left'),frontRight=rect('.front-right');
            const center=r=>r.left+r.width/2;
            return [left.right<=self.left,self.right<=right.left,front.bottom<=left.top,
              Math.abs(center(front)-(center(left)+center(self))/2)<1,
              Math.abs(center(frontRight)-(center(self)+center(right))/2)<1];
          });
          assert.deepEqual(positions,[true,true,true,true,true],'forward neighbors must be staggered half a seat between the side and own seats');
          await page.locator('.public-seating-board-scroll').scrollIntoViewIfNeeded();
          fs.mkdirSync(path.join(root, 'tmp/personal-focus'), { recursive: true });
          await page.screenshot({ path: path.join(root, 'tmp/personal-focus', engine.name() + '-' + viewport.width + '.png'), fullPage: false });
          await page.evaluate(() => resetPublicSeatingZoom());
          await page.waitForFunction(() => publicSeatingZoom < 0.5);
          await page.getByRole('button', { name: '내 자리로', exact: true }).click();
          await page.waitForFunction(() => publicSeatingZoom === 1);
          await page.evaluate(() => {
            const rows = publishedSeatingPlan.rows;
            rows[2].seats[19] = null;
            const neighbors = publicSeatingNeighbors(publishedSeatingPlan, findPublicSeatingMine(publishedSeatingPlan)[0]);
            if (neighbors.left !== '없음') throw Error('empty neighbor skipped');
            currentUser.memberId = 'm4-0'; publicSeatingAutoFit = true; renderPublicSeatingModalBody();
          });
          await page.waitForTimeout(100);
          assert.equal(await page.locator('.public-seating-neighbor.front-left').count(),0,'front row hides forward neighbors');
          assert.equal(await page.locator('.side-right b').textContent(),'없음');
          await page.evaluate(async () => {
            canViewPublishedSeating=()=>true;canViewSeatingPlan=()=>true;canUseSeatingPlan=()=>false;
            getPublishedSeatingPlan=()=>Promise.resolve(publishedSeatingPlan);
            publicSeatingView='audience';openPublicSeatingModal('fixture');
          });
          await page.waitForFunction(()=>publicSeatingView==='member');
          await page.evaluate(() => { currentUser = null; renderPublicSeatingModalBody(); });
          await page.waitForFunction(() => publicSeatingZoom < 0.5);
          assert.equal(await page.locator('.public-seating-neighbors').count(), 0);
          assert.deepEqual(errors, []);
          await page.close();
        }
        console.log('PASS ' + engine.name() + ': member focus, centered 100%, mirrored neighbors, stagger, empty/front boundaries, overview, no-user fallback, phone/tablet');
      } finally { await browser.close(); }
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
