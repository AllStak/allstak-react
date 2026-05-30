/**
 * Instrumentation + filtering-control tests for @allstak/react:
 *   - setLevel propagates to payload.level
 *   - setFingerprint propagates to payload.fingerprint
 *   - instrumentFetch records breadcrumbs (success + failure); skips own
 *     ingest URLs; preserves response/throw.
 *   - instrumentConsole wraps warn/error and forwards to the originals.
 *   - instrumentBrowserNavigation emits breadcrumbs on
 *     pushState/replaceState/popstate; idempotent across re-init.
 *   - error.name override (e.g. CustomError) is preserved as exceptionClass.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';

const sent = [];
let failNextN = 0;
const baseFetch = async (url, init) => {
  if (/api\.allstak\.sa/.test(String(url))) {
    sent.push({ url: String(url), init });
    return new Response('{}', { status: 200 });
  }
  if (failNextN > 0) { failNextN -= 1; throw new Error('network'); }
  return new Response('ok', { status: 200, headers: { 'Content-Type': 'text/plain' } });
};
Object.defineProperty(globalThis, 'fetch', { value: baseFetch, writable: true, configurable: true });

// Minimal browser globals so client.ts's auto-capture and navigation paths
// don't blow up at init.
const winListeners = new Map();
globalThis.window = {
  addEventListener: (t, h) => {
    if (!winListeners.has(t)) winListeners.set(t, new Set());
    winListeners.get(t).add(h);
  },
  removeEventListener: (t, h) => winListeners.get(t)?.delete(h),
};
const docListeners = new Map();
globalThis.document = {
  addEventListener: (t, h) => {
    if (!docListeners.has(t)) docListeners.set(t, new Set());
    docListeners.get(t).add(h);
  },
  removeEventListener: (t, h) => docListeners.get(t)?.delete(h),
};
const histState = { stack: [{ url: '/start' }] };
globalThis.history = {
  pushState: (_state, _u, url) => { histState.stack.push({ url }); globalThis.location.pathname = String(url); },
  replaceState: (_state, _u, url) => { histState.stack[histState.stack.length - 1] = { url }; globalThis.location.pathname = String(url); },
};
Object.defineProperty(globalThis, 'location', {
  value: { pathname: '/start', search: '', host: 'localhost', href: 'http://localhost/start' },
  configurable: true, writable: true,
});

const {
  AllStak,
  instrumentBrowserNavigation,
  instrumentFetch,
  instrumentConsole,
  __resetClickInstrumentationFlagForTest,
} = await import('../dist/index.mjs');

// Distributed tracing is default-on, so `init` now also ships `http.client`
// spans + `/http-requests` events when the app makes a fetch. Those batches
// flush on their own timers and can interleave with the error POST in the
// shared `sent` array — so select the error payload by its ingest path
// instead of assuming it is `sent[0]`.
const isErrorReq = (s) => /\/ingest\/v1\/errors$/.test(s.url);
const errorBody = () => {
  const req = [...sent].reverse().find(isErrorReq);
  assert.ok(req, 'an /ingest/v1/errors request must have been sent');
  return JSON.parse(requestBodyText(req));
};
const waitForSend = () => new Promise((r) => setTimeout(r, 50));
const resetClicks = () => {
  docListeners.clear();
  __resetClickInstrumentationFlagForTest();
};
const element = (tagName, attrs = {}, parentElement = null) => ({
  tagName,
  nodeType: 1,
  parentElement,
  classList: typeof attrs.class === 'string' ? attrs.class.split(/\s+/).filter(Boolean) : [],
  getAttribute(name) {
    if (Object.prototype.hasOwnProperty.call(attrs, name)) return String(attrs[name]);
    return null;
  },
});
const click = (target) => {
  for (const h of (docListeners.get('click') ?? [])) h({ target });
};

function requestBodyText(req) {
  const encoding = new Headers(req.init.headers).get('Content-Encoding');
  if (encoding === 'gzip') return gunzipSync(bodyBuffer(req.init.body)).toString('utf8');
  return String(req.init.body);
}

function bodyBuffer(body) {
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (typeof body === 'string') return Buffer.from(body);
  throw new Error(`Unsupported body type: ${Object.prototype.toString.call(body)}`);
}

// ───────────────────────────────────────────────────────────────
// setLevel + setFingerprint
// ───────────────────────────────────────────────────────────────

test('setLevel changes payload.level', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k', autoCaptureBrowserErrors: false, autoBreadcrumbsFetch: false, autoBreadcrumbsConsole: false, autoBreadcrumbsNavigation: false });
  AllStak.setLevel('warning');
  AllStak.captureException(new Error('warn-me'));
  await waitForSend();
  assert.equal(errorBody().level, 'warning');
});

test('setFingerprint propagates; setFingerprint(null) clears it', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k', autoCaptureBrowserErrors: false, autoBreadcrumbsFetch: false, autoBreadcrumbsConsole: false, autoBreadcrumbsNavigation: false });
  AllStak.setFingerprint(['feat-a', 'v2']);
  AllStak.captureException(new Error('group-me'));
  await waitForSend();
  assert.deepEqual(errorBody().fingerprint, ['feat-a', 'v2']);

  sent.length = 0;
  AllStak.setFingerprint(null);
  AllStak.captureException(new Error('cleared'));
  await waitForSend();
  assert.equal(errorBody().fingerprint, undefined);
});

test('error.name override survives as exceptionClass', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k', autoCaptureBrowserErrors: false, autoBreadcrumbsFetch: false, autoBreadcrumbsConsole: false, autoBreadcrumbsNavigation: false });
  const err = new Error('renamed');
  err.name = 'CustomDomainError';
  AllStak.captureException(err);
  await waitForSend();
  assert.equal(errorBody().exceptionClass, 'CustomDomainError');
});

// ───────────────────────────────────────────────────────────────
// instrumentFetch (auto-wired by init)
// ───────────────────────────────────────────────────────────────

test('init wraps fetch — successful request adds an http breadcrumb', async () => {
  sent.length = 0;
  AllStak.init({
    apiKey: 'k',
    autoCaptureBrowserErrors: false,
    autoBreadcrumbsFetch: true,
    autoBreadcrumbsConsole: false,
    autoBreadcrumbsNavigation: false,
  });

  const res = await fetch('https://example.com/api/data?secret=hide');
  assert.equal(res.status, 200);

  AllStak.captureException(new Error('after-fetch'));
  await waitForSend();
  const body = errorBody();
  const httpCrumb = body.breadcrumbs?.find((c) => c.type === 'http');
  assert.ok(httpCrumb, 'an http breadcrumb must be recorded');
  assert.match(httpCrumb.message, /^GET https:\/\/example\.com\/api\/data -> 200$/);
});

test('instrumentFetch records breadcrumb + rethrows on network failure', async () => {
  sent.length = 0;
  AllStak.init({
    apiKey: 'k',
    autoCaptureBrowserErrors: false,
    autoBreadcrumbsFetch: true,
    autoBreadcrumbsConsole: false,
    autoBreadcrumbsNavigation: false,
  });
  failNextN = 1;
  await assert.rejects(() => fetch('https://example.com/will-fail'), /network/);

  AllStak.captureException(new Error('after-failed-fetch'));
  await waitForSend();
  const body = errorBody();
  const failCrumb = body.breadcrumbs.find((c) => c.type === 'http' && /failed$/.test(c.message));
  assert.ok(failCrumb);
  assert.equal(failCrumb.level, 'error');
});

test('instrumentFetch is idempotent — second init does not double-wrap', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k', autoCaptureBrowserErrors: false, autoBreadcrumbsFetch: true, autoBreadcrumbsConsole: false, autoBreadcrumbsNavigation: false });
  AllStak.init({ apiKey: 'k', autoCaptureBrowserErrors: false, autoBreadcrumbsFetch: true, autoBreadcrumbsConsole: false, autoBreadcrumbsNavigation: false });
  await fetch('https://example.com/once');
  AllStak.captureException(new Error('after'));
  await waitForSend();
  const body = errorBody();
  const httpCrumbs = body.breadcrumbs.filter((c) => c.type === 'http' && /example\.com/.test(c.message));
  assert.equal(httpCrumbs.length, 1, 'fetch wrap must not double-fire');
});

// ───────────────────────────────────────────────────────────────
// instrumentConsole
// ───────────────────────────────────────────────────────────────

test('instrumentConsole wraps warn/error + forwards to originals', async () => {
  sent.length = 0;

  const origWarn = console.warn;
  const origError = console.error;
  const calls = [];
  console.warn = (...a) => calls.push(['warn', a.join(' ')]);
  console.error = (...a) => calls.push(['error', a.join(' ')]);

  AllStak.init({
    apiKey: 'k',
    autoCaptureBrowserErrors: false,
    autoBreadcrumbsFetch: false,
    autoBreadcrumbsConsole: true,
    autoBreadcrumbsNavigation: false,
  });

  console.warn('a-warning');
  console.error('an-error');

  assert.deepEqual(calls, [['warn', 'a-warning'], ['error', 'an-error']]);
  console.warn = origWarn;
  console.error = origError;

  AllStak.captureException(new Error('after-logs'));
  await waitForSend();
  const body = errorBody();
  const logCrumbs = body.breadcrumbs.filter((c) => c.type === 'log');
  assert.equal(logCrumbs.length, 2);
  assert.equal(logCrumbs[0].level, 'warn');
  assert.equal(logCrumbs[1].level, 'error');
});

// ───────────────────────────────────────────────────────────────
// instrumentBrowserNavigation
// ───────────────────────────────────────────────────────────────

test('pushState / popstate emit navigation breadcrumbs', async () => {
  sent.length = 0;

  AllStak.init({
    apiKey: 'k',
    autoCaptureBrowserErrors: false,
    autoBreadcrumbsFetch: false,
    autoBreadcrumbsConsole: false,
    autoBreadcrumbsNavigation: true,
  });

  history.pushState({}, '', '/foo');
  history.pushState({}, '', '/bar');
  // simulate popstate back to /foo
  globalThis.location.pathname = '/foo';
  for (const h of (winListeners.get('popstate') ?? [])) h({});

  AllStak.captureException(new Error('after-nav'));
  await waitForSend();
  const body = errorBody();
  const navCrumbs = body.breadcrumbs.filter((c) => c.type === 'navigation');
  // At least the two pushState transitions + the popstate
  assert.ok(navCrumbs.length >= 2, `expected at least 2 nav breadcrumbs, got ${navCrumbs.length}`);
});

// ───────────────────────────────────────────────────────────────
// privacy-safe click breadcrumbs
// ───────────────────────────────────────────────────────────────

test('privacy-safe click breadcrumbs capture selector summaries only', async () => {
  sent.length = 0;
  resetClicks();
  AllStak.init({
    apiKey: 'k',
    autoCaptureBrowserErrors: false,
    autoBreadcrumbsFetch: false,
    autoBreadcrumbsConsole: false,
    autoBreadcrumbsClick: true,
    autoBreadcrumbsNavigation: false,
  });

  const button = element('BUTTON', {
    id: 'pay-now',
    class: 'primary checkout',
    value: '4111111111111111',
    'data-secret': 'bearer super-secret-token',
  });
  click(button);
  AllStak.captureException(new Error('after-click'));
  await waitForSend();

  const body = errorBody();
  const uiCrumb = body.breadcrumbs.find((c) => c.type === 'ui');
  assert.ok(uiCrumb, 'a ui click breadcrumb must be recorded');
  assert.equal(uiCrumb.message, 'click button#pay-now.primary.checkout');
  assert.equal(uiCrumb.data.selector, 'button#pay-now.primary.checkout');
  assert.equal(uiCrumb.data.tag, 'button');
  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, /4111111111111111/);
  assert.doesNotMatch(serialized, /super-secret-token/);
});

test('password input clicks are ignored', async () => {
  sent.length = 0;
  resetClicks();
  AllStak.init({
    apiKey: 'k',
    autoCaptureBrowserErrors: false,
    autoBreadcrumbsFetch: false,
    autoBreadcrumbsConsole: false,
    autoBreadcrumbsClick: true,
    autoBreadcrumbsNavigation: false,
  });

  click(element('INPUT', { type: 'password', id: 'account-password' }));
  AllStak.captureException(new Error('after-password-click'));
  await waitForSend();
  const body = errorBody();
  assert.equal(body.breadcrumbs, undefined);
});

test('beforeBreadcrumb can drop click breadcrumbs', async () => {
  sent.length = 0;
  resetClicks();
  AllStak.init({
    apiKey: 'k',
    autoCaptureBrowserErrors: false,
    autoBreadcrumbsFetch: false,
    autoBreadcrumbsConsole: false,
    autoBreadcrumbsClick: true,
    autoBreadcrumbsNavigation: false,
    beforeBreadcrumb: () => null,
  });

  click(element('A', { id: 'download', href: '/private?token=secret' }));
  AllStak.captureException(new Error('after-dropped-click'));
  await waitForSend();
  const body = errorBody();
  assert.equal(body.breadcrumbs, undefined);
});

test('long click selectors are truncated', async () => {
  sent.length = 0;
  resetClicks();
  AllStak.init({
    apiKey: 'k',
    autoCaptureBrowserErrors: false,
    autoBreadcrumbsFetch: false,
    autoBreadcrumbsConsole: false,
    autoBreadcrumbsClick: true,
    clickBreadcrumbMaxSelectorLength: 48,
    autoBreadcrumbsNavigation: false,
  });

  click(element('BUTTON', {
    id: 'payment-button-with-a-very-long-generated-identifier',
    class: 'primary checkout elevated enterprise billing',
  }));
  AllStak.captureException(new Error('after-long-click'));
  await waitForSend();
  const body = errorBody();
  const uiCrumb = body.breadcrumbs.find((c) => c.type === 'ui');
  assert.ok(uiCrumb.message.length <= 'click '.length + 48);
  assert.match(uiCrumb.message, /\[truncated]$/);
});
