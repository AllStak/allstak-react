/**
 * Offline / persistent event-queue tests for @allstak/react.
 *
 * Goal: buffered telemetry survives a process/app restart AND a
 * network outage. Coverage:
 *
 *   A. OfflineStore unit behavior
 *      1. persist + load round-trips an entry
 *      2. cap by count drops the OLDEST first
 *      3. cap by bytes drops the OLDEST first
 *      4. max-age expiry discards stale entries on read
 *      5. graceful no-op when storage is null (unavailable)
 *      6. graceful no-op when storage throws (private-mode / quota)
 *
 *   B. Transport / client integration
 *      7. persist-on-send-failure: a network error writes the event to the store
 *      8. drain-and-resend-on-init: a fresh init replays the persisted event and
 *         removes it once accepted (2xx)
 *      9. scrub-before-persist: only the already-redacted payload hits disk —
 *         no raw secret string is ever written to storage
 *     10. session lifecycle calls (/sessions/start|end) are NEVER persisted
 *     11. opt-out (enableOfflineQueue:false) disables persistence entirely
 *     12. permanent 4xx (≠429) is NOT re-persisted/replayed forever
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── Controllable transport fetch ─────────────────────────────────
const sent = [];
let mode = 'ok'; // 'ok' | 'network' | 'http400'
// Only AllStak telemetry calls are subject to the failure mode. The host app's
// own requests (e.g. to api.example.com, used by the HTTP-instrumentation test)
// always succeed so the SDK can record + redact them before persistence.
const isAllStakUrl = (u) => /api\.allstak\.sa|\/ingest\/v1\//.test(u);
const mockFetch = async (url, init) => {
  const u = String(url);
  if (!isAllStakUrl(u)) {
    return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
  }
  if (mode === 'network') throw new Error('network down');
  if (mode === 'http400') {
    sent.push({ url: u, init, status: 400 });
    return new Response('bad', { status: 400 });
  }
  sent.push({ url: u, init, status: 200 });
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
};
// `writable` so the HTTP instrumentation can wrap `globalThis.fetch`.
Object.defineProperty(globalThis, 'fetch', { value: mockFetch, writable: true, configurable: true });
const baseFetch = mockFetch;
const restoreBaseFetch = () => {
  Object.defineProperty(globalThis, 'fetch', { value: baseFetch, writable: true, configurable: true });
};

// Minimal window stub (records listeners; SDK installs unload hooks on it).
const listeners = new Map();
globalThis.window = {
  addEventListener: (type, h) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(h);
  },
  removeEventListener: (type, h) => { listeners.get(type)?.delete(h); },
};
globalThis.history = { pushState() {}, replaceState() {} };
Object.defineProperty(globalThis, 'location', {
  value: { pathname: '/test', host: 'localhost', search: '' },
  configurable: true,
});

const { AllStak, OfflineStore } = await import('../dist/index.mjs');

const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const dispatch = (type, ev) => { for (const h of (listeners.get(type) ?? [])) h(ev); };

// In-memory OfflineStorage double (the localStorage subset the store needs).
function makeStorage() {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

// ════════════════════════════════════════════════════════════════
// A. OfflineStore unit behavior
// ════════════════════════════════════════════════════════════════

test('1. persist + load round-trips an entry', () => {
  const storage = makeStorage();
  const store = new OfflineStore({ storage, key: 'k1' });
  assert.equal(store.isAvailable(), true);
  const id = store.persist('/ingest/v1/errors', { message: 'boom' });
  assert.ok(id, 'persist returns an id when available');
  const loaded = store.load();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].path, '/ingest/v1/errors');
  assert.deepEqual(loaded[0].payload, { message: 'boom' });
});

test('2. cap by count drops the OLDEST first', () => {
  const storage = makeStorage();
  const store = new OfflineStore({ storage, key: 'k2', maxEntries: 3 });
  for (let i = 0; i < 6; i++) store.persist('/ingest/v1/logs', { n: i });
  const loaded = store.load();
  assert.equal(loaded.length, 3, 'never grows past the cap');
  // The OLDEST (n:0,1,2) were dropped; n:3,4,5 survive.
  assert.deepEqual(loaded.map((e) => e.payload.n), [3, 4, 5]);
});

test('3. cap by bytes drops the OLDEST first', () => {
  const storage = makeStorage();
  // ~each entry is well over 200 bytes thanks to the big string; allow only a
  // couple to fit.
  const big = 'x'.repeat(400);
  const store = new OfflineStore({ storage, key: 'k3', maxEntries: 100, maxBytes: 1200 });
  for (let i = 0; i < 10; i++) store.persist('/ingest/v1/logs', { n: i, big });
  const loaded = store.load();
  assert.ok(loaded.length >= 1 && loaded.length < 10, 'byte cap sheds entries');
  // Whatever survives must be the NEWEST contiguous tail (oldest dropped).
  const ns = loaded.map((e) => e.payload.n);
  for (let i = 1; i < ns.length; i++) assert.equal(ns[i], ns[i - 1] + 1);
  assert.equal(ns[ns.length - 1], 9, 'the newest entry always survives');
});

test('4. max-age expiry discards stale entries on read', () => {
  const storage = makeStorage();
  const store = new OfflineStore({ storage, key: 'k4', maxAgeMs: 1000 });
  // Hand-write one fresh + one stale entry.
  const now = Date.now();
  storage.setItem('k4', JSON.stringify([
    { id: 'old', path: '/ingest/v1/errors', payload: { a: 1 }, ts: now - 5000 },
    { id: 'new', path: '/ingest/v1/errors', payload: { a: 2 }, ts: now },
  ]));
  const loaded = store.load();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, 'new');
  // The stale one was pruned from storage too.
  assert.equal(JSON.parse(storage.getItem('k4')).length, 1);
});

test('5. graceful no-op when storage is null (unavailable)', () => {
  const store = new OfflineStore({ storage: null });
  assert.equal(store.isAvailable(), false);
  assert.equal(store.persist('/ingest/v1/errors', { a: 1 }), null);
  assert.deepEqual(store.load(), []);
  // remove/clear must not throw.
  store.remove('whatever');
  store.clear();
});

test('6. graceful no-op when storage throws (private-mode / quota)', () => {
  const throwing = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('quota'); },
    removeItem() { throw new Error('blocked'); },
  };
  const store = new OfflineStore({ storage: throwing, key: 'k6' });
  // Constructed as "available" (object present), but every op fails-open.
  assert.doesNotThrow(() => store.persist('/ingest/v1/errors', { a: 1 }));
  assert.deepEqual(store.load(), []);
  assert.doesNotThrow(() => store.remove('x'));
});

// ════════════════════════════════════════════════════════════════
// B. Transport / client integration
// ════════════════════════════════════════════════════════════════

test('7. persist-on-send-failure writes the event to the store', async () => {
  const storage = makeStorage();
  mode = 'network';
  AllStak.init({
    apiKey: 'k',
    enableOfflineQueue: true,
    offlineStorage: storage,
    offlineQueueKey: 'tx7',
    autoCaptureBrowserErrors: false,
    enableAutoSessionTracking: false,
  });
  AllStak.captureException(new Error('offline-boom'));
  await wait();
  AllStak.destroy();

  const raw = storage.getItem('tx7');
  assert.ok(raw, 'failed event is persisted to the store');
  const entries = JSON.parse(raw);
  assert.ok(entries.length >= 1);
  assert.equal(entries[0].path, '/ingest/v1/errors');
  assert.match(JSON.stringify(entries[0].payload), /offline-boom/);
});

test('7b. transport retries a failed buffered event without a new user event', async () => {
  const storage = makeStorage();
  let errorCalls = 0;
  Object.defineProperty(globalThis, 'fetch', {
    value: async (url) => {
      if (String(url).endsWith('/ingest/v1/errors')) {
        errorCalls++;
        if (errorCalls === 1) throw new Error('backend down');
      }
      return new Response('{}', { status: 202 });
    },
    writable: true,
    configurable: true,
  });

  AllStak.init({
    apiKey: 'k',
    enableOfflineQueue: true,
    offlineStorage: storage,
    offlineQueueKey: 'tx7b',
    autoCaptureBrowserErrors: false,
    enableAutoSessionTracking: false,
    autoRegisterRelease: false,
    enablePerformance: false,
    autoWebVitals: false,
    enableDistributedTracing: false,
    autoBreadcrumbsFetch: false,
    autoBreadcrumbsNavigation: false,
    autoBreadcrumbsConsole: false,
  });
  AllStak.captureException(new Error('retry-me'));
  await wait(700);

  assert.equal(errorCalls, 2, 'retry timer re-sends without another event');
  const diagnostics = AllStak.getDiagnostics();
  assert.equal(diagnostics.transport.queued, 0);
  assert.equal(diagnostics.transport.sent, 1);
  assert.equal(diagnostics.transport.persisted, 1);
  assert.equal(storage.getItem('tx7b'), null);
  AllStak.destroy();
  restoreBaseFetch();
});

test('7c. circuit-open events are persisted and buffer overflow is counted', async () => {
  const storage = makeStorage();
  Object.defineProperty(globalThis, 'fetch', {
    value: async () => { throw new Error('still down'); },
    writable: true,
    configurable: true,
  });
  AllStak.init({
    apiKey: 'k',
    enableOfflineQueue: true,
    offlineStorage: storage,
    offlineQueueKey: 'tx7c',
    autoCaptureBrowserErrors: false,
    enableAutoSessionTracking: false,
    autoRegisterRelease: false,
    enablePerformance: false,
    autoWebVitals: false,
    enableDistributedTracing: false,
    autoBreadcrumbsFetch: false,
    autoBreadcrumbsNavigation: false,
    autoBreadcrumbsConsole: false,
  });
  for (let i = 0; i < 4; i++) AllStak.captureException(new Error(`circuit-${i}`));
  await wait(80);
  assert.ok(AllStak.getDiagnostics().transport.circuitOpenUntil > Date.now(), 'circuit is open after repeated failures');

  AllStak.captureException(new Error('duringCircuit'));
  await wait(20);
  const persisted = JSON.parse(storage.getItem('tx7c') || '[]');
  assert.ok(persisted.some((e) => /duringCircuit/.test(JSON.stringify(e.payload))), 'circuit-open item is persisted');
  AllStak.destroy();

  AllStak.init({
    apiKey: 'k',
    enableOfflineQueue: false,
    autoCaptureBrowserErrors: false,
    enableAutoSessionTracking: false,
    autoRegisterRelease: false,
    enablePerformance: false,
    autoWebVitals: false,
    enableDistributedTracing: false,
    autoBreadcrumbsFetch: false,
    autoBreadcrumbsNavigation: false,
    autoBreadcrumbsConsole: false,
  });
  for (let i = 0; i < 150; i++) AllStak.captureException(new Error(`overflow-${i}`));
  await wait(80);
  assert.ok(AllStak.getDiagnostics().transport.dropped > 0, 'overflow drops are counted when persistence is unavailable');
  AllStak.destroy();
  restoreBaseFetch();
});

test('8. drain-and-resend-on-init replays a persisted event then removes it on 2xx', async () => {
  const storage = makeStorage();
  // Seed the store as if a previous launch had persisted an undelivered error.
  storage.setItem('tx8', JSON.stringify([
    {
      id: 'seed-1',
      path: '/ingest/v1/errors',
      payload: { exceptionClass: 'Error', message: 'from-last-launch', level: 'error' },
      ts: Date.now(),
    },
  ]));

  sent.length = 0;
  mode = 'ok'; // network is back this launch
  AllStak.init({
    apiKey: 'k',
    enableOfflineQueue: true,
    offlineStorage: storage,
    offlineQueueKey: 'tx8',
    autoCaptureBrowserErrors: false,
    enableAutoSessionTracking: false,
  });
  await wait();
  AllStak.destroy();

  // The persisted event was re-sent.
  const replayed = sent.filter((s) => s.url.endsWith('/ingest/v1/errors'));
  assert.ok(replayed.length >= 1, 'persisted event is replayed on init');
  assert.match(replayed[0].init.body, /from-last-launch/);
  // And removed from the store once accepted (2xx).
  assert.equal(storage.getItem('tx8'), null, 'delivered entry is removed from the store');
});

test('9. scrub-before-persist: no raw secret ever reaches the store', async () => {
  const storage = makeStorage();
  mode = 'network'; // force everything into the store
  AllStak.init({
    apiKey: 'k',
    enableOfflineQueue: true,
    offlineStorage: storage,
    offlineQueueKey: 'tx9',
    enableHttpTracking: true,
    httpTracking: { captureHeaders: true },
    autoCaptureBrowserErrors: false,
    autoBreadcrumbsFetch: false,
    autoBreadcrumbsConsole: false,
    enableAutoSessionTracking: false,
  });
  // An instrumented request whose URL carries a secret token that the SDK's
  // PII pipeline redacts BEFORE the transport (and thus the store) sees it.
  await fetch('https://api.example.com/cb?token=eyJSUPERSECRET123&safe=ok', {
    headers: { Authorization: 'Bearer eyJSUPERSECRET123' },
  });
  await wait();
  // The HTTP-request batch flushes on destroy → transport → fetch rejects
  // (network mode) → persist. Give that async dispatch time to land.
  AllStak.destroy();
  await wait(120);

  const raw = storage.getItem('tx9') ?? '';
  assert.ok(!raw.includes('eyJSUPERSECRET123'), 'redacted secret must never hit the store');
  // The http-request envelope did get persisted (proving we tested the right path).
  assert.match(raw, /http-requests|REDACTED|safe=ok/);
});

test('10. session lifecycle calls are NEVER persisted', async () => {
  const storage = makeStorage();
  // Directly drive the transport-equivalent path through the store guard: even
  // when offline, /sessions/start|end must not be written. We assert via the
  // store contents after a failing session-tracked init.
  mode = 'network';
  // Enable session tracking AND force it past the unit-test runtime guard.
  const { __setForceSessionTrackingForTest } = await import('../dist/index.mjs');
  __setForceSessionTrackingForTest(true);
  try {
    AllStak.init({
      apiKey: 'k',
      release: 'web@1.0.0',
      enableOfflineQueue: true,
      offlineStorage: storage,
      offlineQueueKey: 'tx10',
      autoCaptureBrowserErrors: false,
    });
    // Also produce a persistable error so we know the store IS being written to.
    AllStak.captureException(new Error('persist-me'));
    await wait();
    AllStak.destroy();
    await wait();
  } finally {
    __setForceSessionTrackingForTest(false);
  }

  const raw = storage.getItem('tx10') ?? '[]';
  const entries = JSON.parse(raw);
  const paths = entries.map((e) => e.path);
  assert.ok(!paths.includes('/ingest/v1/sessions/start'), 'sessions/start must not be persisted');
  assert.ok(!paths.includes('/ingest/v1/sessions/end'), 'sessions/end must not be persisted');
  assert.ok(paths.includes('/ingest/v1/errors'), 'error telemetry IS persisted (control)');
});

test('11. opt-out (enableOfflineQueue:false) disables persistence', async () => {
  const storage = makeStorage();
  mode = 'network';
  AllStak.init({
    apiKey: 'k',
    enableOfflineQueue: false,
    offlineStorage: storage,
    offlineQueueKey: 'tx11',
    autoCaptureBrowserErrors: false,
    enableAutoSessionTracking: false,
  });
  AllStak.captureException(new Error('should-not-persist'));
  await wait();
  AllStak.destroy();
  assert.equal(storage.getItem('tx11'), null, 'opt-out writes nothing to the store');
});

test('12. permanent 4xx (≠429) is dropped, not persisted forever', async () => {
  const storage = makeStorage();
  mode = 'http400';
  AllStak.init({
    apiKey: 'k',
    enableOfflineQueue: true,
    offlineStorage: storage,
    offlineQueueKey: 'tx12',
    autoCaptureBrowserErrors: false,
    enableAutoSessionTracking: false,
  });
  AllStak.captureException(new Error('bad-request'));
  await wait();
  AllStak.destroy();
  // A 400 is the server rejecting the payload — retrying/persisting is pointless.
  assert.equal(storage.getItem('tx12'), null, '4xx (non-429) must not be persisted');
});

test('13. pagehide flush persists buffered telemetry so it is not lost on tab close', async () => {
  const storage = makeStorage();
  mode = 'network'; // nothing can be delivered this session
  AllStak.init({
    apiKey: 'k',
    enableOfflineQueue: true,
    offlineStorage: storage,
    offlineQueueKey: 'tx13',
    autoCaptureBrowserErrors: false,
    enableAutoSessionTracking: false,
  });
  AllStak.captureException(new Error('in-flight-on-close'));
  await wait();
  // Simulate a tab close — the client's pagehide hook calls flushToBeacon,
  // which (no tunnel ⇒ no header auth via beacon) persists buffered items.
  assert.doesNotThrow(() => dispatch('pagehide', {}));
  await wait();
  AllStak.destroy();

  const raw = storage.getItem('tx13') ?? '';
  assert.match(raw, /in-flight-on-close/, 'buffered event survives the tab close via the store');
});
