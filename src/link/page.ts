import type { PlaidEnvName } from '../config.js';

const PLAID_LINK_SCRIPT = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';

interface PageText {
  title: string;
  intro: string;
  button: string;
}

const TEXT: Record<'create' | 'update', PageText> = {
  create: {
    title: 'Connect a bank',
    intro:
      'Sign in to your bank through Plaid. When you finish, the access token and the list of accounts are printed in your terminal.',
    button: 'Connect bank',
  },
  update: {
    title: 'Fix a bank login',
    intro:
      'Sign in to your bank again to repair an existing connection. The access token does not change, and you can choose which accounts Plaid shares.',
    button: 'Fix bank login',
  },
};

// Runs in the browser. Plain JS, no template literals, so it can live inside a TS template string.
const PAGE_SCRIPT = `
const button = document.getElementById('action');
const statusEl = document.getElementById('status');
let handler = null;
let pendingPublicToken = null;

function setStatus(message, kind) {
  statusEl.textContent = message;
  statusEl.className = kind || '';
}

async function postJson(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  let data = {};
  try {
    data = await res.json();
  } catch (e) {
    data = {};
  }
  if (!res.ok) {
    throw new Error(data.error || 'Request failed with HTTP ' + res.status);
  }
  return data;
}

async function finish(publicToken) {
  button.disabled = true;
  setStatus('Saving the connection…');
  try {
    await postJson('/api/complete', { publicToken: publicToken });
    pendingPublicToken = null;
    button.hidden = true;
    setStatus('Done — return to your terminal.', 'ok');
  } catch (err) {
    // Keep the public token so Retry does not start a new Link session (which could create a second Item).
    pendingPublicToken = publicToken;
    button.textContent = 'Retry';
    button.disabled = false;
    setStatus('Could not finish: ' + err.message + '. Check the terminal, then click Retry.', 'error');
  }
}

async function startLink() {
  if (typeof Plaid === 'undefined') {
    setStatus('Plaid Link did not load. Check your network connection and reload this page.', 'error');
    return;
  }
  button.disabled = true;
  setStatus('Opening Plaid Link…');
  try {
    const data = await postJson('/api/link-token');
    if (handler) {
      handler.destroy();
    }
    handler = Plaid.create({
      token: data.linkToken,
      onSuccess: function (public_token, metadata) {
        finish(public_token);
      },
      onExit: function (err, metadata) {
        button.disabled = false;
        if (err) {
          setStatus('Plaid Link closed with an error: ' + (err.display_message || err.error_message), 'error');
        } else {
          setStatus('Plaid Link was closed. Click the button to try again.');
        }
      },
    });
    handler.open();
  } catch (err) {
    button.disabled = false;
    setStatus('Could not start Plaid Link: ' + err.message, 'error');
  }
}

button.addEventListener('click', function () {
  if (pendingPublicToken) {
    finish(pendingPublicToken);
  } else {
    startLink();
  }
});
`;

// Pinned to the left so it stays readable beside Plaid Link's centered modal.
const SANDBOX_NOTES = `<aside aria-label="Sandbox test values">
  <h2>Sandbox test values</h2>
  <dl>
    <div><dt>Username</dt><dd><code>user_good</code></dd></div>
    <div><dt>Password</dt><dd><code>pass_good</code></dd></div>
    <div><dt>Phone number</dt><dd>Any phone number works</dd></div>
    <div><dt>Verification code</dt><dd><code>123456</code></dd></div>
  </dl>
</aside>
`;

export function renderLinkPage(mode: 'create' | 'update', plaidEnv: PlaidEnvName): string {
  const text = TEXT[mode];
  const notes = plaidEnv === 'sandbox' ? SANDBOX_NOTES : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>actual-plaid-sync: ${text.title}</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
  body { margin: 0; min-height: 100vh; display: flex; }
  aside { flex: 0 0 15rem; padding: 1.5rem 1.25rem; border-right: 1px solid color-mix(in srgb, currentColor 20%, transparent); }
  aside h2 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; margin: 0 0 1rem; opacity: 0.7; }
  aside dl { margin: 0; display: flex; flex-direction: column; gap: 1rem; }
  aside dt { font-size: 0.85rem; opacity: 0.7; }
  aside dd { margin: 0.2rem 0 0; }
  aside code { font-size: 1rem; }
  main { flex: 1; display: grid; place-items: center; padding: 1rem; }
  .panel { width: 100%; max-width: 32rem; }
  @media (max-width: 48rem) {
    body { flex-direction: column; }
    aside { flex: none; border-right: 0; border-bottom: 1px solid color-mix(in srgb, currentColor 20%, transparent); }
  }
  h1 { font-size: 1.5rem; margin: 0 0 0.5rem; }
  p { line-height: 1.5; }
  button { font: inherit; font-size: 1.1rem; padding: 0.75rem 1.5rem; border: 0; border-radius: 0.5rem; background: #0b7a5a; color: #fff; cursor: pointer; }
  button:disabled { opacity: 0.6; cursor: progress; }
  #status { min-height: 1.5em; margin-top: 1rem; }
  #status.ok { color: #0b9a6f; font-weight: 600; }
  #status.error { color: #d9443a; }
</style>
</head>
<body>
${notes}<main>
  <div class="panel">
    <h1>${text.title}</h1>
    <p>${text.intro}</p>
    <button id="action" type="button">${text.button}</button>
    <p id="status" role="status" aria-live="polite"></p>
  </div>
</main>
<script src="${PLAID_LINK_SCRIPT}"></script>
<script>${PAGE_SCRIPT}</script>
</body>
</html>
`;
}
