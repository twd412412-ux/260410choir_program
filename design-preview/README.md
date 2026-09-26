# Home Design Preview

Isolated visual comparison built from the home renderer at the source commit recorded in the HTML meta tag. Production index.html is not changed.

## Safety

- Fictional sample schedule and published seating plans. No roster or account information.
- Deployed files contain no Firebase SDK, app configuration, login, writes, notifications or service worker.
- All deployed requests stay on the preview origin. CSP forbids external connections and workers.
- Existing and refined views use identical source-generated home markup and sample data.
- Search, theme, event tabs and sample dialogs are interactive; other app workflows are not implemented in this home-only preview.
- Production GitHub Pages remains unchanged. The preview is deployed to a separate repository and URL.

## Build

Run `node design-preview/build.cjs` with Playwright available in NODE_PATH. Copy a pinned Lucide UMD bundle to `design-preview/site/assets/lucide.min.js` before testing or deployment.

Never deploy the full app repository as this preview. Publish only `design-preview/site`.
