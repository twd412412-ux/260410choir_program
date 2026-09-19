// Read-only production probe: an anonymous save must reach the callable and be rejected by auth.
const assert = require('node:assert/strict');
(async () => {
  const response = await fetch('https://asia-northeast3-choir-project-f3b67.cloudfunctions.net/attendanceAdmin', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: { action: 'save' } }), signal: AbortSignal.timeout(30000)
  });
  assert.equal(response.status, 401, 'Attendance backend is missing or unavailable; deploy it before the web app.');
  const body = await response.json();
  assert.equal(body.error && body.error.status, 'UNAUTHENTICATED');
  console.log('PASS: deployed attendance callable is reachable and rejects anonymous writes');
})().catch(error => { console.error(error); process.exitCode = 1; });
