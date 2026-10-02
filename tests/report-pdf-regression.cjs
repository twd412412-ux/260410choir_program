const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium, webkit } = require('playwright');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/^init\(\);\r?$/m, '').replace(/^initInstallUi\(\);\r?$/m, '');
(async () => {
  const server = http.createServer((req, res) => {
    if (require('./serve-firebase-sdk.cjs')(req, res)) return;
    if (req.url.startsWith('/assets/vendor/html2pdf-0.14.0.bundle.min.js')) {
      res.setHeader('Content-Type', 'application/javascript'); res.end(fs.readFileSync(path.join(root, 'assets/vendor/html2pdf-0.14.0.bundle.min.js'))); return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const engine of [chromium, webkit]) {
      const browser = await engine.launch(engine === chromium ? { channel: 'msedge' } : {});
      try {
        const page = await browser.newPage({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
        const errors = []; page.on('pageerror', e => errors.push(e.message));
        await page.route(/firestore\.googleapis\.com|cloudfunctions\.net/, route => route.abort());
        await page.goto('http://127.0.0.1:' + server.address().port);
        await page.evaluate(() => {
          canUseReport = () => false; showToast = text => { window.lastToast = text; };
          window.logs = []; writeLog = (...args) => logs.push(args); window.print = () => { throw Error('must not print'); };
        });
        assert.equal(await page.evaluate(() => saveReportPdf()), false);
        await page.evaluate(() => { canUseReport = () => true; });
        assert.equal(await page.evaluate(() => saveReportPdf()), false);
        await page.evaluate(() => {
          document.body.classList.add('dark');
          const box = document.getElementById('reportCanvas');
          box.dataset.reportMonth = '2026-09';
          box.innerHTML = '<div style="padding:20px;color:#222;background:#fff"><h2>2026년 9월 광주교회 찬양대 결산 보고서</h2><h3>1. 출석 현황</h3><p>오전 95% · 오후 90%</p><h3>2. 특송 현황</h3><table style="width:100%;border-collapse:collapse">' + Array.from({length:70}, (_,i) => '<tr><td style="border:1px solid #ccc;padding:8px">'+(i+1)+' · 한국어 테스트 곡</td><td style="border:1px solid #ccc;padding:8px">테스트 단원</td></tr>').join('') + '</table><h3>5. 단원 변동 현황</h3><p>마지막 항목 · 신규 등록 없음</p></div>';
          document.getElementById('reportMonthSel').value = '2026-10';
        });
        const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
        const results = await page.evaluate(() => Promise.all([saveReportPdf(), saveReportPdf()]));
        assert.deepEqual(results, [true, false], 'duplicate click must not export twice');
        const download = await downloadPromise;
        assert.equal(download.suggestedFilename(), '광주교회_찬양대_결산보고서_2026-09.pdf');
        const folder = path.join(root, 'tmp/report-pdf'); fs.mkdirSync(folder, { recursive:true });
        const pdf = path.join(folder, engine.name() + '.pdf'); await download.saveAs(pdf);
        const bytes = fs.readFileSync(pdf), text = bytes.toString('latin1');
        assert.equal(bytes.subarray(0,5).toString(), '%PDF-');
        assert(bytes.length > 30000, 'PDF appears empty');
        const pages = (text.match(/\/Type \/Page\b/g)||[]).length;
        assert(pages >= 3, 'long report must have multiple pages');
        assert.equal(await page.evaluate(() => reportPdfBusy), false);
        assert.equal(await page.locator('iframe[title="결산 보고서 PDF"]').count(), 0);
        assert.equal(await page.evaluate(() => logs.length), 1);
        // A failed renderer keeps the source report and permits a retry.
        await page.evaluate(() => { loadScriptOnce = () => Promise.reject(Error('test library failure')); });
        assert.equal(await page.evaluate(() => saveReportPdf()), false);
        assert.equal(await page.evaluate(() => reportPdfBusy), false);
        assert.equal(await page.evaluate(() => document.getElementById('reportCanvas').dataset.reportMonth), '2026-09');
        assert.deepEqual(errors, []);
        console.log('PASS ' + engine.name() + ': real named PDF, '+pages+' A4 pages, Korean/dark-mode report, generated-month snapshot, permissions, double click, cleanup and retry');
      } finally { await browser.close(); }
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode=1; });
