/**
 * Web Vitals tests.
 *
 * Two layers:
 *  1. Node (no window / no PerformanceObserver) → the module safely no-ops.
 *  2. A jsdom + fake-PerformanceObserver browser shim → verifies that the
 *     collected vitals are reported as a single uppercase-keyed map on the
 *     hide/unload moment, and that AllStak.init ships them as a
 *     `web.vital` SPAN (POST /ingest/v1/spans) with the metric values in
 *     the `measurements` map — the wire shape the backend reads for the
 *     web-vitals dashboard.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { startWebVitals, __resetWebVitalsFlagForTest } = await import('../dist/index.mjs');

test('startWebVitals returns no-op handle in Node (no window)', () => {
  __resetWebVitalsFlagForTest();
  const reports = [];
  const handle = startWebVitals((m) => reports.push(m));
  assert.equal(typeof handle.destroy, 'function');
  // No reports should have fired in Node.
  assert.equal(reports.length, 0);
  // destroy is idempotent
  handle.destroy();
  handle.destroy();
});

test('startWebVitals second call without reset is also a no-op (flag-guarded)', () => {
  __resetWebVitalsFlagForTest();
  const a = startWebVitals(() => {});
  const b = startWebVitals(() => {});
  // Both return functioning handles; second one's destroy should be safe.
  a.destroy();
  b.destroy();
});

test('autoWebVitals=false on AllStak.init does not start observers', async () => {
  const { AllStak, __resetConsoleInstrumentationFlagForTest } = await import('../dist/index.mjs');
  AllStak.destroy();
  __resetConsoleInstrumentationFlagForTest();
  __resetWebVitalsFlagForTest();
  // Stub fetch to swallow ingest calls.
  Object.defineProperty(globalThis, 'fetch', {
    value: async () => new Response('{}', { status: 200 }),
    writable: true, configurable: true,
  });
  AllStak.init({ apiKey: 'k', autoWebVitals: false });
  // Just ensure init didn't throw and no observer leaked.
  AllStak.destroy();
});

// ── Browser-shim layer ─────────────────────────────────────────────
// jsdom has no PerformanceObserver, so we install a minimal fake that
// lets the test feed entries to whichever observers the module registers.

const { JSDOM } = await import('jsdom');

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/dashboard' });
const set = (k, v) => Object.defineProperty(globalThis, k, { value: v, writable: true, configurable: true });
set('window', dom.window);
set('document', dom.window.document);
set('navigator', dom.window.navigator);
set('location', dom.window.location);
set('history', dom.window.history);
set('Event', dom.window.Event);

// Registry of live observers keyed by the entry `type` they observe.
const fakeObservers = new Map(); // type -> [{ cb }]
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
    for (const [, arr] of fakeObservers) {
      const i = arr.indexOf(this);
      if (i >= 0) arr.splice(i, 1);
    }
  }
  _emit(entries) {
    this._cb({ getEntries: () => entries });
  }
}
function feed(type, entries) {
  for (const obs of fakeObservers.get(type) ?? []) obs._emit(entries);
}
set('PerformanceObserver', FakePerformanceObserver);

// performance.getEntriesByType('navigation') drives TTFB.
set('performance', {
  getEntriesByType: (kind) => (kind === 'navigation' ? [{ responseStart: 123 }] : []),
});

function fireHidden() {
  // jsdom returns 'prerender' by default; force 'hidden' for the visibility path.
  Object.defineProperty(dom.window.document, 'visibilityState', { value: 'hidden', configurable: true });
  dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
}

test('startWebVitals reports a single uppercase-keyed measurements map on hide', () => {
  __resetWebVitalsFlagForTest();
  fakeObservers.clear();
  const reports = [];
  const handle = startWebVitals((m) => reports.push(m));

  // Drive each observer with representative entries.
  feed('largest-contentful-paint', [{ startTime: 2500 }]);
  feed('layout-shift', [{ value: 0.05, hadRecentInput: false }, { value: 0.02, hadRecentInput: true }]);
  feed('event', [{ duration: 180 }, { duration: 60 }]);
  feed('paint', [{ name: 'first-contentful-paint', startTime: 800 }]);

  fireHidden();

  assert.equal(reports.length, 1, 'exactly one report on the hide moment');
  const m = reports[0];
  assert.equal(m.LCP, 2500);
  // CLS only sums entries without recent input.
  assert.ok(Math.abs(m.CLS - 0.05) < 1e-9);
  assert.equal(m.INP, 180);
  assert.equal(m.FCP, 800);
  assert.equal(m.TTFB, 123);

  handle.destroy();
});

test('startWebVitals guards against double-send (visibility + pagehide)', () => {
  __resetWebVitalsFlagForTest();
  fakeObservers.clear();
  const reports = [];
  const handle = startWebVitals((m) => reports.push(m));
  feed('largest-contentful-paint', [{ startTime: 1000 }]);

  fireHidden();
  dom.window.dispatchEvent(new dom.window.Event('pagehide'));

  assert.equal(reports.length, 1, 'finalize fires at most once even if both signals fire');
  handle.destroy();
});

test('AllStak.init ships vitals as a web.vital SPAN with a measurements map', async () => {
  const { AllStak, __resetConsoleInstrumentationFlagForTest } = await import('../dist/index.mjs');
  AllStak.destroy();
  __resetConsoleInstrumentationFlagForTest();
  __resetWebVitalsFlagForTest();
  fakeObservers.clear();

  const sent = [];
  Object.defineProperty(globalThis, 'fetch', {
    value: async (url, init) => { sent.push({ url: String(url), init }); return new Response('{}', { status: 200 }); },
    writable: true, configurable: true,
  });

  AllStak.init({
    apiKey: 'k',
    environment: 'test',
    release: 'react@1.2.3',
    enablePerformance: true,   // gates the web.vital span path
    tracesSampleRate: 1,
    autoCaptureBrowserErrors: false,
    autoBreadcrumbsFetch: false,
    autoBreadcrumbsConsole: false,
    autoBreadcrumbsNavigation: false,
    autoWebVitals: true,
  });

  feed('largest-contentful-paint', [{ startTime: 2200 }]);
  feed('layout-shift', [{ value: 0.1, hadRecentInput: false }]);
  feed('paint', [{ name: 'first-contentful-paint', startTime: 700 }]);

  fireHidden();

  // Force the tracing batch to flush, then settle the async transport.
  AllStak.destroy();
  await new Promise((r) => setTimeout(r, 50));

  const spanReq = sent.find((s) => s.url.endsWith('/ingest/v1/spans'));
  assert.ok(spanReq, 'a /ingest/v1/spans request must be sent');
  const body = JSON.parse(spanReq.init.body);
  const vital = (body.spans || []).find((s) => s.op === 'web.vital');
  assert.ok(vital, 'a span with op=web.vital must be present');
  assert.equal(vital.operation, 'web.vital');
  assert.equal(vital.measurements.LCP, 2200);
  assert.ok(Math.abs(vital.measurements.CLS - 0.1) < 1e-9);
  assert.equal(vital.measurements.FCP, 700);
  assert.equal(vital.measurements.TTFB, 123);
});
