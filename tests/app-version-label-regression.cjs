const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/^init\(\);\r?$/m, '').replace(/^initInstallUi\(\);\r?$/m, '');
const version = html.match(/var APP_RELEASE_VERSION='([^']+)'/)[1];

(async () => {
  const server = http.createServer((req, res) => {
    if (require('./serve-firebase-sdk.cjs')(req, res)) return;
    if (req.url.startsWith('/deploy-info.json')) {
      // Deployed at 08:23 KST on 10/1, which is still 9/30 in UTC.
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ sha: 'a'.repeat(40), deployed_at: '2026-09-30T23:23:16Z' }));
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'msedge' });
  try {
    for (const timezoneId of ['UTC', 'Asia/Seoul']) {
      const context = await browser.newContext({ timezoneId, viewport: { width: 390, height: 844 } });
      const page = await context.newPage();
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.route(/googleapis\.com|cloudfunctions\.net/, route => route.abort());
      await page.goto('http://127.0.0.1:' + server.address().port + '/');
      const labels = await page.evaluate(async () => {
        APP_BUILD_SHA = 'a'.repeat(40);
        renderAppReleaseVersion();
        const before = [...document.querySelectorAll('[data-app-release-version]')].map(el => el.textContent);
        const result = await checkForAppUpdate(true);
        const after = [...document.querySelectorAll('[data-app-release-version]')].map(el => el.textContent);
        return { before, after, upToDate: !!(result && result.upToDate) };
      });
      assert.equal(labels.upToDate, true, 'deploy info was actually read');
      assert.deepEqual(labels.after, labels.before, timezoneId + ': label must not change after deploy info arrives');
      assert.ok(labels.after.every(text => text.endsWith(version)), timezoneId + ': label keeps the full release version ' + JSON.stringify(labels.after));
      assert.ok(labels.after.every(text => !text.includes('26.09.30')), timezoneId + ': no UTC deploy date');
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log('PASS app version label stays ' + version + ' after the deploy check in UTC and Asia/Seoul');
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
