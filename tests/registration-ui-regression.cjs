const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
(async () => {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8')
    .replace(/^init\(\);\r?$/m, '').replace(/^initInstallUi\(\);\r?$/m, '');
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, channel: 'msedge' });
    const page = await browser.newPage();
    await page.route(/firestore\.googleapis\.com|firebasestorage\.googleapis\.com|cloudfunctions\.net/, route => route.abort());
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const result = await page.evaluate(async () => {
      adminRole = 'admin'; allMembers = []; currentUser = null;
      canManageHandbookMembers = () => true; canManageLoginAccounts = () => true;
      loadAccountLinkMembers = async () => [];
      findAutoAccountMemberLink = () => ({ status: 'none', memberId: '' });
      validateAccountMemberLinkName = () => true; accountMemberLinkConflict = () => null;
      upsertLocalAccount = () => {}; cacheAccountPin = () => {}; renderCachedAccountManagement = () => {};
      populateAccountMemberSelect = () => {}; invalidateSharedMembers = () => {}; loadHandbook = () => {};
      syncMemberAddOpen = () => {};
      let logs = 0, calls = [], release, fail = true;
      writeLog = () => { logs++; };
      document.getElementById('memName').value = '테스트';
      document.getElementById('memPart').value = 'S1';
      document.getElementById('memPin').value = '1234';
      accountAdminCall = (action, data) => { calls.push({ action, data }); return new Promise((resolve, reject) => { release = () => fail ? reject({ code: 'functions/unavailable' }) : resolve({ account: { id: 'test-id', name: '테스트' }, replayed: true }); }); };
      const first = addMember(); addMember();
      await new Promise(resolve => setTimeout(resolve, 0));
      const locked = calls.length === 1 && document.getElementById('accountRegisterBtn').disabled;
      release(); await first;
      const kept = document.getElementById('memName').value === '테스트' && !document.getElementById('accountRegisterBtn').disabled;
      fail = false;
      const retry = addMember(); await new Promise(resolve => setTimeout(resolve, 0)); release(); await retry;
      const reused = calls[0].data.requestId === calls[1].data.requestId && logs === 0;
      calls = []; fail = true;
      document.getElementById('hbName').value = '동명단원';
      document.getElementById('hbPart').value = 'S2';
      document.getElementById('hbPhone').value = '010-0000-0000';
      accountAdminCall = (action, data) => { calls.push({ action, data }); return new Promise((resolve, reject) => { release = () => fail ? reject({ code: 'functions/already-exists', message: '기존 명부 확인' }) : resolve({ memberId: 'member-id', replayed: false }); }); };
      const memberFirst = addHandbookMember(); addHandbookMember();
      const memberLocked = calls.length === 1 && document.getElementById('handbookRegisterBtn').disabled;
      release(); await memberFirst;
      const memberKept = document.getElementById('hbName').value === '동명단원' && !document.getElementById('handbookRegisterBtn').disabled;
      fail = false;
      const memberRetry = addHandbookMember(); release(); await memberRetry;
      const memberReused = calls[0].data.requestId === calls[1].data.requestId;
      const reset = document.getElementById('hbName').value === '' && logs === 1;
      document.getElementById('hbName').value = '동명이인'; document.getElementById('hbPart').value = 'S2';
      calls = []; window.confirm = () => true;
      accountAdminCall = async (action, data) => {
        calls.push({ action, data });
        if (!data.allowSameName) throw { details: { kind: 'member-same-name', parts: ['S1'] } };
        return { memberId: 'other-member', replayed: false };
      };
      await addHandbookMember();
      const confirmed = calls.length === 2 && calls[1].data.allowSameName && calls[0].data.requestId === calls[1].data.requestId;
      return { locked, kept, reused, memberLocked, memberKept, memberReused, reset, confirmed };
    });
    Object.entries(result).forEach(([key, value]) => assert.ok(value, key));
    console.log('PASS: registration click lock, preserved input, same request ID on retry, no duplicate replay logs, homonym confirmation');
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
