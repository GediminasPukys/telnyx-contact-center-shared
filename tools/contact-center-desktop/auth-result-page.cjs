const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const {createHash} = require('node:crypto');

// Embed the bundled logo: the one-use listener closes after the callback, so
// this page must render without another request or any external resources.
const logo = readFileSync(join(__dirname, 'assets/telnyx-logo.png')).toString('base64');
const styles = `
:root { color-scheme: dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #f4f5f5; background: #0b0d0e; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; min-height: 100svh; display: grid; place-items: center; padding: 40px 20px; }
main { width: 100%; max-width: 560px; }
.brand { display: flex; align-items: center; gap: 20px; margin: 0 0 26px 4px; }
.brand img { display: block; width: 128px; height: auto; }
.brand span { border-left: 1px solid #353a3c; padding-left: 20px; color: #a8b0b3; font-size: 11px; font-weight: 600; letter-spacing: 1.6px; }
.card { background: #151819; border: 1px solid #303638; border-radius: 24px; padding: 40px; box-shadow: 0 20px 64px #0004; }
.status { display: flex; align-items: center; gap: 10px; margin-bottom: 28px; color: #68e4c4; font-size: 13px; font-weight: 600; }
.status svg { width: 19px; height: 19px; flex-shrink: 0; }
.cancelled .status { color: #d8bd7d; }
.app-icon { display: grid; place-items: center; width: 64px; height: 64px; border: 1px solid #285046; border-radius: 18px; background: #17332b; color: #63e5c3; margin-bottom: 24px; }
.app-icon svg { width: 32px; height: 32px; }
h1 { font-size: 32px; font-weight: 650; line-height: 1.18; letter-spacing: -.8px; margin: 0 0 16px; text-wrap: balance; }
.description { color: #b2babd; font-size: 16px; line-height: 1.65; margin: 0; }
.next { margin-top: 30px; padding: 20px; border: 1px solid #343a3d; border-radius: 14px; background: #1d2123; display: flex; align-items: flex-start; gap: 14px; }
.next svg { width: 22px; height: 22px; flex-shrink: 0; color: #a2b4bb; margin-top: 1px; }
.next strong { display: block; font-size: 14px; font-weight: 600; margin-bottom: 6px; }
.next p { margin: 0; color: #a8b1b5; font-size: 13px; line-height: 1.6; }
footer { display: flex; justify-content: center; align-items: center; gap: 8px; margin: 24px 0 0; color: #949ea2; font-size: 13px; text-align: center; line-height: 1.5; }
footer svg { width: 16px; height: 16px; flex-shrink: 0; }
@media (max-width: 480px) { body { padding: 24px 16px; } .card { padding: 28px 24px; border-radius: 20px; } h1 { font-size: 28px; } .brand { gap: 14px; } .brand span { padding-left: 14px; font-size: 10px; letter-spacing: 1px; } .brand img { width: 112px; } }
`;
const contentSecurityPolicy = `default-src 'none'; style-src 'sha256-${createHash('sha256').update(styles).digest('base64')}'; img-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`;
const svg = (paths) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

function renderAuthResultPage({cancelled = false} = {}) {
  const appLocation = process.platform === 'win32' ? 'taskbar' : process.platform === 'darwin' ? 'Dock' : 'app launcher';
  const title = cancelled ? 'Sign-in cancelled' : 'Continue in Contact Center';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · Telnyx</title><style>${styles}</style></head>
<body><main${cancelled ? ' class="cancelled"' : ''}>
  <header class="brand"><img src="data:image/png;base64,${logo}" alt="Telnyx" width="128" height="34"><span>CONTACT CENTER</span></header>
  <section class="card" aria-labelledby="page-title">
    <div class="status">${svg(cancelled ? '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6m0-6-6 6"/>' : '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>')}${cancelled ? 'Sign-in stopped' : 'Browser step complete'}</div>
    <div class="app-icon">${svg('<rect x="3" y="3" width="18" height="13" rx="2"/><path d="M8 21h8m-4-5v5m-5-11h10m-3-3 3 3-3 3"/>')}</div>
    <h1 id="page-title">${title}</h1>
    <p class="description">${cancelled ? 'No sign-in was completed. Return to the desktop app whenever you’re ready to try again.' : 'Your sign-in response has been sent to the desktop app. Contact Center is finishing your sign-in, then you can choose your phone.'}</p>
    <div class="next">${svg('<rect x="3" y="5" width="18" height="15" rx="2"/><path d="M3 10h18m-13-3h.01M6 7h.01"/>')}<div><strong>${cancelled ? 'Ready to try again?' : 'Your app should open automatically'}</strong><p>${cancelled ? 'Open Telnyx Contact Center and select “Continue with Google”.' : `If it’s still in the background, select Telnyx Contact Center in your ${appLocation}.`}</p></div></div>
  </section>
  <footer>${svg('<path d="M5 12h14m-4-4 4 4-4 4"/>')}You can close this browser tab.</footer>
</main></body></html>`;
}

module.exports = {renderAuthResultPage, contentSecurityPolicy};
