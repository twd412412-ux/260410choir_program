const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium, webkit } = require('playwright');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/^init\(\);\r?$/m, '').replace(/^initInstallUi\(\);\r?$/m, '');

(async () => {
  const server = http.createServer((req, res) => { if (require('./serve-firebase-sdk.cjs')(req, res)) return; res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const engine of [chromium, webkit]) {
      const browser = await engine.launch(engine === chromium ? { channel: 'msedge' } : {});
      try {
        const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        await page.route(/googleapis\.com|cloudfunctions\.net/, route => route.abort());
        await page.goto('http://127.0.0.1:' + server.address().port);
        const result = await page.evaluate(() => {
          window.pwned = 0;
          const evil = '<img src=x onerror="window.pwned++">';
          attLoadError = null; attLoading = false; attPartFilter = 'all'; attStatusFilter = 'all';
          canCheckAttendance = () => true;
          attMembers = [
            { id: "a'b", name: evil + '홍길동', part: 'S1', subPart: evil },
            { id: 'c', name: evil + '미체크', part: 'S2' }
          ];
          attData = { "a'b": '사유결석' }; attReasons = { "a'b": evil + '출장' };
          renderAttList();
          const list = document.getElementById('attList'), count = document.getElementById('attCount');
          const bars = renderMiniBarRows([{ label: evil + '단원 (S1)', value: 3 }], '회');
          const holder = document.createElement('div'); holder.innerHTML = bars;
          return {
            images: list.querySelectorAll('img').length + count.querySelectorAll('img').length + holder.querySelectorAll('img').length,
            name: list.querySelector('.att-name').textContent,
            reason: list.querySelector('.att-reason').textContent,
            unchecked: count.textContent.includes('<img'),
            barLabel: holder.textContent.includes('<img'),
            quoteIdSafe: !!list.querySelector('.att-btn')
          };
        });
        await page.waitForTimeout(100);
        assert.equal(result.images, 0, 'user text must not become markup');
        assert.match(result.name, /^<img src=x/);
        assert.match(result.reason, /<img src=x .*출장/);
        assert.equal(result.unchecked, true);
        assert.equal(result.barLabel, true);
        assert.equal(result.quoteIdSafe, true);
        assert.equal(await page.evaluate(() => window.pwned), 0);
        await page.evaluate(() => document.querySelector('#attList .att-btn').click());
        assert.deepEqual(errors, [], 'a quote in a member id must not break the inline handler');
        console.log('PASS ' + engine.name() + ': attendance names, parts, reasons, unchecked list and bar labels are escaped');
      } finally { await browser.close(); }
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
