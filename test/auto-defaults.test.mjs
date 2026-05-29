/**
 * Default-on auto-instrumentation tests for @allstak/react.
 *
 * These lock in that a bare `AllStak.init({ apiKey })` — no `enableHttpTracking`,
 * no `tracesSampleRate`, no `enablePerformance` — ships:
 *
 *   1. Distributed tracing: outbound fetch gets the W3C `traceparent` header
 *      and an `http.client` span, so client→server traces link up with zero
 *      per-call code.
 *   2. Distributed tracing does NOT capture bodies/headers (privacy-safe) and
 *      DOES still redact sensitive query params.
 *   3. Web Vitals ship as a `web.vital` span WITHOUT `enablePerformance` /
 *      `tracesSampleRate` (the previously-misleading `autoWebVitals` default).
 *   4. The pageload span ships by default.
 *   5. Individual toggles still work:
 *        - enableDistributedTracing:false → no traceparent, no http.client span
 *        - enablePerformance:false        → no pageload span (but vitals stay)
 *        - autoWebVitals:false            → no web.vital span (but pageload stays)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const sent = [];
const baseFetch = async (url, init) => {
  const u = String(url);
  if (/api\.allstak\.sa/.test(u)) { sent.push({ url: u, init }); return new Response('{}', { status: 200 }); }
  return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain', 'content-length': '2' } });
};
Object.defineProperty(globalThis, 'fetch', { value: baseFetch, writable: true, configurable: true });

// ── Browser-ish globals + fake PerformanceObserver (web-vitals path) ──
const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/dashboard' });
const set = (k, v) => Object.defineProperty(globalThis, k, { value: v, writable: true, configurable: true });
set('window', dom.window);
set('document', dom.window.document);
set('navigator', dom.window.navigator);
set('location', dom.window.location);
set('history', dom.window.history);
set('Event', dom.window.Event);

const fakeObservers = new Map();
class FakePerformanceObserver {
  constructor(cb) { this._cb = cb; }
  observe(opts) {
    const type = opts && opts.type;
    if (!type) return;
    const arr = fakeObservers.get(type) ?? [];
    arr.push(this);
    fakeObservers.set(type, arr);
  }
  disconnect() {
    for (const [, arr] of fakeObservers) { const i = arr.indexOf(this); if (i >= 0) arr.splice(i, 1); }
  }
  _emit(entries) { this._cb({ getEntries: () => entries }); }
}
function feed(type, entries) { for (const obs of fakeObservers.get(type) ?? []) obs._emit(entries); }
set('PerformanceObserver', FakePerformanceObserver);
// performance.getEntriesByType drives both TTFB (web-vitals) and the pageload span.
set('performance', {
  timeOrigin: 0,
  now: () => 1000,
  getEntriesByType: (kind) => (kind === 'navigation'
    ? [{ startTime: 0, responseStart: 123, requestStart: 23, domInteractive: 400, loadEventEnd: 900 }]
    : []),
});
function fireHidden() {
  Object.defineProperty(dom.window.document, 'visibilityState', { value: 'hidden', configurable: true });
  dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
}

const {
  AllStak,
  __resetConsoleInstrumentationFlagForTest,
  __resetWebVitalsFlagForTest,
} = await import('../dist/index.mjs');

const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const spanReqs = () => sent.filter((s) => s.url.endsWith('/ingest/v1/spans'));
const allSpans = () => spanReqs().flatMap((s) => JSON.parse(s.init.body).spans);
const httpReqs = () => sent.filter((s) => s.url.endsWith('/ingest/v1/http-requests'));
const allHttp = () => httpReqs().flatMap((s) => JSON.parse(s.init.body).requests);

// Quiet the other auto-instrumenters so each test isolates the feature it asserts.
const _origInit = AllStak.init.bind(AllStak);
const initBare = (cfg) => {
  __resetConsoleInstrumentationFlagForTest();
  __resetWebVitalsFlagForTest();
  fakeObservers.clear();
  return _origInit({
    apiKey: 'k',
    release: 'react@1.0.0',
    autoCaptureBrowserErrors: false,
    autoBreadcrumbsFetch: false,
    autoBreadcrumbsConsole: false,
    autoBreadcrumbsNavigation: false,
    ...cfg,
  });
};

// ───────────────────────────────────────────────────────────────
// 1. Distributed tracing is default-ON (no enableHttpTracking).
// ───────────────────────────────────────────────────────────────

test('default init propagates traceparent on outbound fetch (no enableHttpTracking)', async () => {
  sent.length = 0;
  let captured;
  const probe = async (url, init) => {
    if (!/api\.allstak\.sa/.test(String(url))) captured = init;
    return baseFetch(url, init);
  };
  Object.defineProperty(globalThis, 'fetch', { value: probe, writable: true, configurable: true });

  initBare({});
  await fetch('https://api.example.com/users');
  AllStak.destroy();
  await wait(20);

  // Restore the plain fetch for later tests.
  Object.defineProperty(globalThis, 'fetch', { value: baseFetch, writable: true, configurable: true });

  assert.ok(captured && captured.headers, 'traced fetch must receive merged headers');
  const tp = captured.headers.get
    ? captured.headers.get('traceparent')
    : captured.headers.traceparent;
  assert.ok(tp, 'traceparent header must be injected by default');
  assert.match(tp, /^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/);
});

test('default init emits an http.client span for outbound fetch (no enableHttpTracking)', async () => {
  sent.length = 0;
  initBare({});
  await fetch('https://api.example.com/orders');
  AllStak.destroy();
  await wait(20);
  const client = allSpans().find((s) => s.op === 'http.client');
  assert.ok(client, 'an http.client span must ship by default');
  assert.equal(client.tags.method, 'GET');
  assert.equal(client.status, 'ok');
});

test('default tracing does NOT capture bodies/headers but DOES redact query params', async () => {
  sent.length = 0;
  initBare({
    // Even if a host passes httpTracking opts, the default tracing-only path
    // forces body/header capture OFF (privacy-safe).
    httpTracking: { captureRequestBody: true, captureResponseBody: true, captureHeaders: true },
  });
  await fetch('https://api.example.com/pay?token=secret-xyz&user=1', {
    method: 'POST',
    body: JSON.stringify({ card: '1111' }),
    headers: { authorization: 'Bearer leak' },
  });
  AllStak.destroy();
  await wait(20);
  const e = allHttp().find((x) => x.path === '/pay');
  assert.ok(e, 'request still recorded');
  assert.equal(e.requestBody, undefined, 'body stays OFF on the default tracing-only path');
  assert.equal(e.responseBody, undefined, 'body stays OFF on the default tracing-only path');
  assert.equal(e.requestHeaders, undefined, 'headers stay OFF on the default tracing-only path');
  assert.match(e.url, /token=%5BREDACTED%5D|token=\[REDACTED\]/, 'sensitive query params still redacted');
  assert.match(e.url, /user=1/);
  const json = JSON.stringify(allHttp());
  assert.ok(!json.includes('secret-xyz'), 'no secret query value leaks');
  assert.ok(!json.includes('Bearer leak'), 'no auth header leaks');
});

test('enableDistributedTracing:false disables traceparent + http.client span', async () => {
  sent.length = 0;
  let captured;
  const probe = async (url, init) => {
    if (!/api\.allstak\.sa/.test(String(url))) captured = init;
    return baseFetch(url, init);
  };
  Object.defineProperty(globalThis, 'fetch', { value: probe, writable: true, configurable: true });

  initBare({ enableDistributedTracing: false });
  await fetch('https://api.example.com/nope');
  AllStak.destroy();
  await wait(20);
  Object.defineProperty(globalThis, 'fetch', { value: baseFetch, writable: true, configurable: true });

  // When the wrapper is not installed, the probe sees the original init (no
  // injected headers) OR the call never carries a traceparent.
  const tp = captured && captured.headers && (captured.headers.get
    ? captured.headers.get('traceparent')
    : captured.headers.traceparent);
  assert.ok(!tp, 'no traceparent when distributed tracing is disabled');
  assert.equal(allSpans().filter((s) => s.op === 'http.client').length, 0,
    'no http.client span when distributed tracing is disabled');
  assert.equal(allHttp().length, 0, 'no http-request events when distributed tracing is disabled');
});

// ───────────────────────────────────────────────────────────────
// 2. Web Vitals + pageload span are decoupled from enablePerformance.
// ───────────────────────────────────────────────────────────────

test('Web Vitals ship by default WITHOUT enablePerformance/tracesSampleRate', async () => {
  sent.length = 0;
  initBare({ autoWebVitals: true }); // the documented default — must not be a no-op
  feed('largest-contentful-paint', [{ startTime: 2200 }]);
  feed('layout-shift', [{ value: 0.1, hadRecentInput: false }]);
  feed('paint', [{ name: 'first-contentful-paint', startTime: 700 }]);
  fireHidden();
  AllStak.destroy();
  await wait(40);
  const vital = allSpans().find((s) => s.op === 'web.vital');
  assert.ok(vital, 'a web.vital span must ship on a bare init');
  assert.equal(vital.measurements.LCP, 2200);
  assert.ok(Math.abs(vital.measurements.CLS - 0.1) < 1e-9);
  assert.equal(vital.measurements.FCP, 700);
  assert.equal(vital.measurements.TTFB, 123);
});

test('pageload span ships by default WITHOUT enablePerformance/tracesSampleRate', async () => {
  sent.length = 0;
  initBare({});
  AllStak.destroy();
  await wait(20);
  const pageload = allSpans().find((s) => s.op === 'pageload');
  assert.ok(pageload, 'a pageload span must ship on a bare init');
  assert.ok(pageload.measurements && typeof pageload.measurements.ttfb === 'number');
});

test('enablePerformance:false drops the pageload span but keeps Web Vitals', async () => {
  sent.length = 0;
  initBare({ enablePerformance: false });
  feed('largest-contentful-paint', [{ startTime: 1500 }]);
  fireHidden();
  AllStak.destroy();
  await wait(40);
  assert.equal(allSpans().filter((s) => s.op === 'pageload').length, 0,
    'enablePerformance:false opts out of the pageload span');
  assert.ok(allSpans().some((s) => s.op === 'web.vital'),
    'Web Vitals are governed by autoWebVitals, not enablePerformance');
});

test('autoWebVitals:false drops the web.vital span but keeps the pageload span', async () => {
  sent.length = 0;
  initBare({ autoWebVitals: false });
  feed('largest-contentful-paint', [{ startTime: 1500 }]);
  fireHidden();
  AllStak.destroy();
  await wait(40);
  assert.equal(allSpans().filter((s) => s.op === 'web.vital').length, 0,
    'autoWebVitals:false disables Web Vitals');
  assert.ok(allSpans().some((s) => s.op === 'pageload'),
    'pageload span still ships');
});
