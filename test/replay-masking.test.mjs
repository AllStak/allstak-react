/**
 * C3 — replay privacy regression suite against a fake banking screen.
 *
 * Hard rules asserted here (hardening spec 2026-06-10):
 *   - `maskAllText: true` and `maskAllInputs: true` are the DEFAULTS — replay
 *     stays enabled by default ONLY because everything is masked by default.
 *   - Text nodes are replaced with same-length `*` masking (layout preserved)
 *     unless the element is allowlisted via `unmask` (or carries
 *     `data-allstak-unmask`).
 *   - Everything leaving via the replay stream (DOM text, click target text,
 *     console args, input values, attribute values like placeholder/title/alt)
 *     passes through the same PII value-scrubber as the error path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM(`<!doctype html><html><body>
  <div id="bank-root">
    <h1>Acme Bank — حسابي</h1>
    <label>Password <input id="pw" type="password" value="superSecret1"></label>
    <p id="otp">Your one-time code is 123456</p>
    <p id="iban">IBAN: SA4420000001234567891234</p>
    <p id="card">Card on file: 4111 1111 1111 1111</p>
    <p id="email">Registered email: user@bank.sa</p>
    <p id="phone">Phone: +966501234567</p>
    <p id="balance">Available balance: 98,7654.32 SAR</p>
    <input id="search" type="text" value="" placeholder="search payee user@bank.sa">
    <button id="paybtn" title="pay card 4111 1111 1111 1111">Pay 4111 1111 1111 1111 now</button>
    <span id="brand" data-allstak-unmask>AcmeBank Secure Portal</span>
    <span id="footer-note">plain footer text</span>
  </div>
</body></html>`, { url: 'http://localhost/account' });
const set = (k, v) => Object.defineProperty(globalThis, k, { value: v, writable: true, configurable: true });
set('window', dom.window);
set('document', dom.window.document);
set('navigator', dom.window.navigator);
set('HTMLElement', dom.window.HTMLElement);
set('Node', dom.window.Node);
set('Element', dom.window.Element);
set('Event', dom.window.Event);
set('MutationObserver', dom.window.MutationObserver);
set('location', dom.window.location);
set('history', dom.window.history);

const sent = [];
Object.defineProperty(globalThis, 'fetch', {
  value: async (url, init) => { sent.push({ url: String(url), init }); return new Response('{}', { status: 200 }); },
  writable: true, configurable: true,
});

const { AllStak } = await import('../dist/index.mjs');
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));
// The recorder snapshots on the first DOM mutation (the framework's commit);
// in this static jsdom we trigger one to stand in for the app's first render.
const mutate = () => document.body.appendChild(document.createElement('span'));

const BASE = {
  apiKey: 'k',
  autoCaptureBrowserErrors: false,
  autoBreadcrumbsFetch: false,
  autoBreadcrumbsConsole: false,
  autoBreadcrumbsNavigation: false,
  enableOfflineQueue: false,
};

/** Replay payload JSON with volatile numeric fields (ts) neutralized so a
 *  timestamp can never coincidentally contain a tested digit string. */
function replayJson() {
  const batches = sent.filter((s) => s.url.endsWith('/ingest/v1/replay'));
  assert.ok(batches.length > 0, 'at least one replay batch must be sent');
  const events = batches.flatMap((b) => JSON.parse(b.init.body).events);
  return JSON.stringify(events).replace(/"ts":\d+/g, '"ts":0');
}

const SECRETS = [
  ['password value', 'superSecret1'],
  ['OTP code', '123456'],
  ['IBAN', 'SA4420000001234567891234'],
  ['card (spaced)', '4111 1111 1111 1111'],
  ['card (compact)', '4111111111111111'],
  ['email', 'user@bank.sa'],
  ['phone', '+966501234567'],
  ['account balance', '98,7654.32'],
];

test('banking screen: NO sensitive value reaches the replay stream by default; unmask allowlist works', async () => {
  sent.length = 0;
  AllStak.init({ ...BASE }); // zero-config: replay on, maskAllText + maskAllInputs default true
  mutate(); await wait(25); // first mutation triggers the snapshot

  // Live text mutation must follow the same masking policy as the snapshot.
  document.getElementById('balance').firstChild.nodeValue = 'New balance: 55,5444.33 SAR card 4111 1111 1111 1111';
  await wait(25);

  // Click on the pay button — target text must not leak the card number.
  document.getElementById('paybtn').dispatchEvent(new dom.window.Event('click', { bubbles: true }));

  // Console output captured into the replay must be value-scrubbed.
  console.log('charging card 4111111111111111 for user@bank.sa');

  AllStak.destroy();
  await wait(30);

  const json = replayJson();
  for (const [label, value] of SECRETS) {
    assert.ok(!json.includes(value), `${label} must NOT appear anywhere in the replay output`);
  }
  assert.ok(!json.includes('55,5444.33'), 'mutated balance text must NOT appear (characterData path)');

  // Same-length `*` masking preserves layout: the OTP line survives as a
  // masked text node of identical shape.
  assert.ok(json.includes('Your one-time code is 123456'.replace(/\S/g, '*').slice(0, 10)) || json.includes('****'),
    'masked text nodes use `*` masking');

  // The unmask-allowlisted element DOES appear in clear text.
  assert.ok(json.includes('AcmeBank Secure Portal'),
    'data-allstak-unmask element text must appear unmasked');
  // Non-allowlisted plain text is masked too (mask-by-default, not deny-list).
  assert.ok(!json.includes('plain footer text'), 'ordinary page text is masked by default');
});

test('unmask selector option allowlists an element; mask attribute still wins', async () => {
  sent.length = 0;
  document.getElementById('footer-note').textContent = 'plain footer text';
  const masked = document.createElement('p');
  masked.setAttribute('data-allstak-mask', '');
  masked.id = 'masked-anyway';
  masked.textContent = 'redacted-even-if-unmask-matches';
  document.getElementById('bank-root').appendChild(masked);

  AllStak.init({
    ...BASE,
    replay: { sampleRate: 1, unmask: ['#footer-note', '#masked-anyway'] },
  });
  mutate(); await wait(25);
  AllStak.destroy();
  await wait(30);

  const json = replayJson();
  assert.ok(json.includes('plain footer text'), 'unmask CSS selector must allowlist the element text');
  assert.ok(!json.includes('redacted-even-if-unmask-matches'),
    'data-allstak-mask must always win over unmask');
  for (const [label, value] of SECRETS) {
    assert.ok(!json.includes(value), `${label} must stay masked with a custom unmask list`);
  }
});

test('maskAllText: false still routes text through the PII value-scrubber (CC/email/etc.)', async () => {
  sent.length = 0;
  AllStak.init({ ...BASE, replay: { sampleRate: 1, maskAllText: false } });
  mutate(); await wait(25);
  AllStak.destroy();
  await wait(30);

  const json = replayJson();
  // Opted out of blanket masking: benign text appears…
  assert.ok(json.includes('plain footer text'), 'maskAllText:false leaves benign text visible');
  // …but the error-path value scrubber still strips CC / IBAN-grade PII patterns.
  assert.ok(!json.includes('4111 1111 1111 1111'), 'credit card is ALWAYS value-scrubbed');
  assert.ok(!json.includes('user@bank.sa'), 'email is value-scrubbed by default (sendDefaultPii=false)');
  assert.ok(!json.includes('superSecret1'), 'password input stays masked regardless');
  // Attribute values (placeholder/title) are scrubbed too.
  assert.ok(!json.includes('search payee user@bank.sa'), 'placeholder attribute is scrubbed');
});
