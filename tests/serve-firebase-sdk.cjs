const fs = require('node:fs');
const path = require('node:path');

module.exports = function serveFirebaseSdk(req, res) {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const rehearsal = pathname.match(/^\/assets\/(rehearsal-attendance\.(?:js|css))$/);
  if (rehearsal) {
    res.setHeader('Content-Type', rehearsal[1].endsWith('.js') ? 'application/javascript' : 'text/css');
    res.end(fs.readFileSync(path.join(__dirname, '../assets', rehearsal[1])));
    return true;
  }
  const match = pathname.match(/^\/assets\/vendor\/firebase-10\.12\.0\/(firebase-(?:app|auth|firestore|storage|functions)-compat\.js)$/);
  if (!match) return false;
  res.setHeader('Content-Type', 'application/javascript');
  res.end(fs.readFileSync(path.join(__dirname, '../assets/vendor/firebase-10.12.0', match[1])));
  return true;
};
