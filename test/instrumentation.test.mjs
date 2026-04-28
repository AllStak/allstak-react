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
} = await import('../dist/index.mjs');

// ───────────────────────────────────────────────────────────────
// setLevel + setFingerprint
// ───────────────────────────────────────────────────────────────

test('setLevel changes payload.level', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k', autoCaptureBrowserErrors: false, autoBreadcrumbsFetch: false, autoBreadcrumbsConsole: false, autoBreadcrumbsNavigation: false });
  AllStak.setLevel('warning');
  AllStak.captureException(new Error('warn-me'));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(JSON.parse(sent[0].init.body).level, 'warning');
});

test('setFingerprint propagates; setFingerprint(null) clears it', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k', autoCaptureBrowserErrors: false, autoBreadcrumbsFetch: false, autoBreadcrumbsConsole: false, autoBreadcrumbsNavigation: false });
  AllStak.setFingerprint(['feat-a', 'v2']);
  AllStak.captureException(new Error('group-me'));
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(JSON.parse(sent[0].init.body).fingerprint, ['feat-a', 'v2']);

  sent.length = 0;
  AllStak.setFingerprint(null);
  AllStak.captureException(new Error('cleared'));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(JSON.parse(sent[0].init.body).fingerprint, undefined);
});

test('error.name override survives as exceptionClass', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k', autoCaptureBrowserErrors: false, autoBreadcrumbsFetch: false, autoBreadcrumbsConsole: false, autoBreadcrumbsNavigation: false });
  const err = new Error('renamed');
  err.name = 'CustomDomainError';
  AllStak.captureException(err);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(JSON.parse(sent[0].init.body).exceptionClass, 'CustomDomainError');
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
  await new Promise((r) => setTimeout(r, 50));
  const body = JSON.parse(sent[0].init.body);
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
  await new Promise((r) => setTimeout(r, 50));
  const body = JSON.parse(sent[0].init.body);
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
  await new Promise((r) => setTimeout(r, 50));
  const body = JSON.parse(sent[0].init.body);
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
  await new Promise((r) => setTimeout(r, 50));
  const body = JSON.parse(sent[0].init.body);
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
  await new Promise((r) => setTimeout(r, 50));
  const body = JSON.parse(sent[0].init.body);
  const navCrumbs = body.breadcrumbs.filter((c) => c.type === 'navigation');
  // At least the two pushState transitions + the popstate
  assert.ok(navCrumbs.length >= 2, `expected at least 2 nav breadcrumbs, got ${navCrumbs.length}`);
});
