/**
 * Value-pattern PII scrubbing tests for @allstak/react.
 *
 * Complements `sensitive-data-masking.test.mjs` (key-name redaction) by
 * exercising the value-pattern scrubbers + the `sendDefaultPii` toggle:
 *
 *   A) ALWAYS scrubbed (regardless of sendDefaultPii):
 *      - Credit cards — ONLY when the digit run passes Luhn. A Luhn-invalid
 *        run (e.g. an order id) is preserved.
 *      - US SSN — hyphens required; a bare 9-digit number is preserved.
 *   B) Scrubbed UNLESS sendDefaultPii === true (default false = parity):
 *      - Email addresses, IPv4.
 *
 * Plus: the explicit setUser object is NEVER scrubbed; key-based redaction
 * still works; stack frame paths are NOT corrupted; and the scrubbers are
 * fail-open on pathological input.
 *
 * Pure-function coverage (scrubString / scrubDeep) sits alongside the
 * wire-path coverage so a regex regression is caught directly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── Transport spy ────────────────────────────────────────────────
const sent = [];
const mockFetch = async (url, init) => {
  sent.push({ url: String(url), init });
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
};
Object.defineProperty(globalThis, 'fetch', {
  value: mockFetch,
  writable: true,
  configurable: true,
});

// Minimal browser-ish globals so init() doesn't throw / auto-instrument.
const winListeners = new Map();
globalThis.window = {
  addEventListener: (t, h) => {
    if (!winListeners.has(t)) winListeners.set(t, new Set());
    winListeners.get(t).add(h);
  },
  removeEventListener: (t, h) => winListeners.get(t)?.delete(h),
};
globalThis.history = { pushState() {}, replaceState() {} };
Object.defineProperty(globalThis, 'location', {
  value: { pathname: '/test', search: '', host: 'localhost' },
  configurable: true,
  writable: true,
});

const { AllStak, scrubString, scrubDeep, scrubEventValues, makeValueScrubberProcessor } =
  await import('../dist/index.mjs');

const _origInit = AllStak.init.bind(AllStak);
AllStak.init = (cfg) =>
  _origInit({
    autoCaptureBrowserErrors: false,
    autoBreadcrumbsFetch: false,
    autoBreadcrumbsConsole: false,
    autoBreadcrumbsNavigation: false,
    enableOfflineQueue: false,
    ...cfg,
  });

const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const errorsPath = (s) => /\/ingest\/v1\/errors$/.test(s.url);
const logsPath = (s) => /\/ingest\/v1\/logs$/.test(s.url);

/** Init, capture an exception, return the wire error payload. */
async function captureError(error, context, sdkOpts = {}) {
  sent.length = 0;
  AllStak.init({ apiKey: 'ask_test_key', release: 'web@1.0.0', ...sdkOpts });
  AllStak.captureException(error, context);
  await wait();
  const ev = sent.find(errorsPath);
  AllStak.destroy();
  return ev ? JSON.parse(ev.init.body) : null;
}

// Luhn-valid test cards: 4111111111111111 (Visa), 5500005555555559 (MC).
// Luhn-INVALID 16-digit run: 4111111111111112.

// ── Pure-function: credit cards (group A — always) ───────────────

test('CC: Luhn-valid 16-digit run is redacted', () => {
  assert.equal(scrubString('charge 4111111111111111 ok'), 'charge [REDACTED] ok');
  assert.equal(scrubString('mc 5500005555555559'), 'mc [REDACTED]');
});

test('CC: spaces/hyphens as separators still match (Luhn over digits only)', () => {
  assert.equal(scrubString('card 4111 1111 1111 1111 end'), 'card [REDACTED] end');
  assert.equal(scrubString('card 4111-1111-1111-1111 end'), 'card [REDACTED] end');
});

test('CC: Luhn-INVALID digit run is PRESERVED (no over-redaction)', () => {
  // Flips the last digit of a valid Visa — fails Luhn, must survive.
  assert.equal(scrubString('order 4111111111111112 x'), 'order 4111111111111112 x');
  // A 13-digit order-id-like run that fails Luhn must survive.
  assert.equal(scrubString('order 1234567890123 x'), 'order 1234567890123 x');
});

test('CC: redacted even when sendDefaultPii=true (group A is always on)', () => {
  assert.equal(scrubString('c 4111111111111111', { sendDefaultPii: true }), 'c [REDACTED]');
});

// ── Pure-function: SSN (group A — always, hyphens required) ──────

test('SSN: hyphenated SSN is redacted', () => {
  assert.equal(scrubString('ssn 123-45-6789 done'), 'ssn [REDACTED] done');
});

test('SSN: bare 9-digit number is NOT matched (hyphens required)', () => {
  assert.equal(scrubString('id 123456789 ok'), 'id 123456789 ok');
});

test('SSN: redacted even when sendDefaultPii=true', () => {
  assert.equal(scrubString('s 123-45-6789', { sendDefaultPii: true }), 's [REDACTED]');
});

// ── Pure-function: email + IPv4 (group B — gated) ────────────────

test('email + IPv4 redacted when sendDefaultPii=false (default)', () => {
  assert.equal(scrubString('contact a.b+x@example.co.uk now'), 'contact [REDACTED] now');
  assert.equal(scrubString('from 192.168.1.1 port'), 'from [REDACTED] port');
  assert.equal(scrubString('client 10.0.0.255'), 'client [REDACTED]');
});

test('email + IPv4 PRESERVED when sendDefaultPii=true', () => {
  assert.equal(
    scrubString('contact a@example.com from 192.168.1.1', { sendDefaultPii: true }),
    'contact a@example.com from 192.168.1.1',
  );
});

test('IPv4: out-of-range octet is NOT matched (no over-redaction)', () => {
  assert.equal(scrubString('ver 999.1.1.1 build'), 'ver 999.1.1.1 build');
  assert.equal(scrubString('ver 256.0.0.1 build'), 'ver 256.0.0.1 build');
});

test('IPv6: clock times and short hex tokens are NOT corrupted', () => {
  assert.equal(scrubString('at 12:34:56 today'), 'at 12:34:56 today');
  assert.equal(scrubString('ts 01:02:03:04 x'), 'ts 01:02:03:04 x');
});

// ── Pure-function: scrubDeep + fail-open ─────────────────────────

test('scrubDeep walks nested objects/arrays and leaves non-strings intact', () => {
  const input = {
    note: 'reach me a@b.com',
    nested: { ip: '8.8.8.8', count: 42, ok: true },
    list: ['ssn 111-22-3333', 999],
  };
  const out = scrubDeep(input);
  assert.equal(out.note, 'reach me [REDACTED]');
  assert.equal(out.nested.ip, '[REDACTED]');
  assert.equal(out.nested.count, 42);
  assert.equal(out.nested.ok, true);
  assert.equal(out.list[0], 'ssn [REDACTED]');
  assert.equal(out.list[1], 999);
});

test('fail-open: pathological / huge inputs never throw and are returned safely', () => {
  // Oversized string is skipped (returned unchanged) rather than scanned.
  const huge = 'x'.repeat(20000) + ' a@b.com';
  assert.equal(scrubString(huge), huge);
  // Non-string / nullish inputs return unchanged.
  assert.equal(scrubString(undefined), undefined);
  assert.equal(scrubString(null), null);
  assert.deepEqual(scrubDeep({ a: undefined, b: null }), { a: undefined, b: null });
  // Circular structure must not throw (depth/own-prototype guards + try/catch).
  const circular = { msg: 'a@b.com' };
  circular.self = circular;
  assert.doesNotThrow(() => scrubDeep(circular));
});

// ── Wire path: error events ──────────────────────────────────────

test('wire: error message + metadata are scrubbed by default', async () => {
  const body = await captureError(
    new Error('login failed for a@b.com from 192.168.0.10'),
    { ssn: '123-45-6789', cardOnFile: '4111111111111111' },
  );
  assert.ok(body, 'error event was sent');
  assert.equal(body.message, 'login failed for [REDACTED] from [REDACTED]');
  assert.equal(body.metadata.ssn, '[REDACTED]');
  assert.equal(body.metadata.cardOnFile, '[REDACTED]');
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes('a@b.com'));
  assert.ok(!raw.includes('192.168.0.10'));
  assert.ok(!raw.includes('123-45-6789'));
  assert.ok(!raw.includes('4111111111111111'));
});

test('wire: email/IP PRESERVED with sendDefaultPii=true, but CC/SSN still scrubbed', async () => {
  const body = await captureError(
    new Error('user a@b.com from 192.168.0.10'),
    { ssn: '123-45-6789', card: '4111111111111111' },
    { sendDefaultPii: true },
  );
  assert.equal(body.message, 'user a@b.com from 192.168.0.10', 'opted-in PII survives');
  // Group A is ALWAYS on even with sendDefaultPii=true.
  assert.equal(body.metadata.ssn, '[REDACTED]');
  assert.equal(body.metadata.card, '[REDACTED]');
});

test('wire: explicit setUser email is NOT scrubbed (intentional identification)', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'ask_test_key', release: 'web@1.0.0' });
  AllStak.setUser({ id: 'u-1', email: 'real.user@example.com' });
  AllStak.captureException(new Error('boom'));
  await wait();
  const body = JSON.parse(sent.find(errorsPath).init.body);
  AllStak.destroy();
  assert.deepEqual(body.user, { id: 'u-1', email: 'real.user@example.com' });
});

test('wire: explicit setUser email survives even with sendDefaultPii=false default', async () => {
  // Same assertion as Sentry: sendDefaultPii does NOT strip explicit user.
  sent.length = 0;
  AllStak.init({ apiKey: 'ask_test_key', release: 'web@1.0.0', sendDefaultPii: false });
  AllStak.setUser({ id: 'u-2', email: 'explicit@corp.io' });
  AllStak.captureException(new Error('e2'));
  await wait();
  const body = JSON.parse(sent.find(errorsPath).init.body);
  AllStak.destroy();
  assert.equal(body.user.email, 'explicit@corp.io');
});

test('wire: breadcrumb message + data are scrubbed', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'ask_test_key', release: 'web@1.0.0' });
  AllStak.addBreadcrumb('default', 'mailed receipt to a@b.com', 'info', {
    ip: '203.0.113.7',
    card: '4111111111111111',
  });
  AllStak.captureException(new Error('crumb-pii'));
  await wait();
  const body = JSON.parse(sent.find(errorsPath).init.body);
  AllStak.destroy();
  assert.equal(body.breadcrumbs.length, 1);
  assert.equal(body.breadcrumbs[0].message, 'mailed receipt to [REDACTED]');
  assert.equal(body.breadcrumbs[0].data.ip, '[REDACTED]');
  assert.equal(body.breadcrumbs[0].data.card, '[REDACTED]');
});

test('wire: stack frame paths / release / sdk fields are NOT corrupted', async () => {
  const err = new Error('boom');
  // Synthesize a stack with a file path that contains @-and-dot tokens that
  // a naive email scrubber could mangle.
  err.stack = [
    'Error: boom',
    '    at handler (https://cdn.app.io/assets/main.4f2a@1.0.0.js:10:5)',
    '    at runtime (webpack://app/./src/index.tsx:42:9)',
  ].join('\n');
  const body = await captureError(err, undefined);
  const raw = JSON.stringify(body);
  // The release string survives untouched.
  assert.equal(body.release, 'web@1.0.0');
  // Frame filenames survive — they are NOT run through value scrubbing.
  assert.ok(
    body.frames.some((f) => /cdn\.app\.io\/assets\/main/.test(f.filename || f.absPath || '')),
    'stack frame filename preserved',
  );
  assert.ok(raw.includes('cdn.app.io/assets/main'), 'frame path not corrupted in wire data');
});

test('wire: key-based query-param redaction still works (regression guard)', async () => {
  // The existing key-name redactor (http-redact) is independent of value
  // scrubbing — confirm a request URL value scrubber pass does not break it.
  assert.equal(
    scrubString('https://api.example.com/cb?token=secret&state=ok'),
    'https://api.example.com/cb?token=secret&state=ok',
    'value scrubber leaves a non-PII URL untouched (key redaction handled upstream)',
  );
});

// ── Wire path: log events (sendLog bypasses applyBeforeSend) ─────

test('wire: captureMessage log message + attributes are scrubbed', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'ask_test_key', release: 'web@1.0.0' });
  AllStak.logger.info('note for a@b.com', { peerIp: '198.51.100.23', card: '5500005555555559' });
  await wait();
  const logEv = sent.find(logsPath);
  AllStak.destroy();
  assert.ok(logEv, 'a log event was sent');
  const body = JSON.parse(logEv.init.body);
  assert.equal(body.message, 'note for [REDACTED]');
  assert.equal(body.metadata.peerIp, '[REDACTED]');
  assert.equal(body.metadata.card, '[REDACTED]');
});

test('wire: log PII preserved (email/IP) but CC scrubbed when sendDefaultPii=true', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'ask_test_key', release: 'web@1.0.0', sendDefaultPii: true });
  AllStak.logger.info('note for a@b.com', { peerIp: '198.51.100.23', card: '5500005555555559' });
  await wait();
  const body = JSON.parse(sent.find(logsPath).init.body);
  AllStak.destroy();
  assert.equal(body.message, 'note for a@b.com');
  assert.equal(body.metadata.peerIp, '198.51.100.23');
  assert.equal(body.metadata.card, '[REDACTED]', 'CC is always scrubbed');
});

// ── Event-processor helpers ──────────────────────────────────────

test('scrubEventValues: only allowlisted carriers are touched', () => {
  const event = {
    message: 'a@b.com',
    metadata: { note: 'ip 8.8.8.8' },
    breadcrumbs: [{ message: 'card 4111111111111111', data: { ssn: '123-45-6789' } }],
    release: 'web@1.0.0',
    sessionId: 'sess-a@b.com-id', // not free text — must NOT be scrubbed
    user: { id: 'u', email: 'keep@me.com' }, // explicit user — must NOT be scrubbed
  };
  const out = scrubEventValues(event);
  assert.equal(out.message, '[REDACTED]');
  assert.equal(out.metadata.note, 'ip [REDACTED]');
  assert.equal(out.breadcrumbs[0].message, 'card [REDACTED]');
  assert.equal(out.breadcrumbs[0].data.ssn, '[REDACTED]');
  // Allowlisted-skip fields untouched:
  assert.equal(out.release, 'web@1.0.0');
  assert.equal(out.sessionId, 'sess-a@b.com-id');
  assert.deepEqual(out.user, { id: 'u', email: 'keep@me.com' });
});

test('makeValueScrubberProcessor honors sendDefaultPii', () => {
  const off = makeValueScrubberProcessor({ sendDefaultPii: false });
  const on = makeValueScrubberProcessor({ sendDefaultPii: true });
  assert.equal(off({ message: 'a@b.com' }).message, '[REDACTED]');
  assert.equal(on({ message: 'a@b.com' }).message, 'a@b.com');
  // CC always scrubbed regardless.
  assert.equal(on({ message: '4111111111111111' }).message, '[REDACTED]');
});
