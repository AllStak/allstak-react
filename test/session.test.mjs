/**
 * Release-health session tracking tests for @allstak/react.
 *
 * Covers:
 *   1. SessionTracker start payload shape (always sent, reuses sessionId,
 *      release falls back to sdkVersion, carries userId/sdk identity).
 *   2. SessionTracker end payload shape + status transitions ok→errored→crashed
 *      (crashed is terminal — never downgraded).
 *   3. No-release skip keeps the in-memory tracker but emits no network I/O.
 *   4. Client `enableAutoSessionTracking: false` opt-out.
 *   5. Client auto-skip under a unit-test runtime.
 *   6. Client wiring: handled error → errored, unhandled → crashed, end on
 *      destroy posts /sessions/end with the accumulated status.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const sent = [];
const mockFetch = async (url, init) => {
  sent.push({ url: String(url), init });
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
};
Object.defineProperty(globalThis, 'fetch', { get() { return mockFetch; }, configurable: true });

// Minimal window stub so the client installs/removes its listeners and unload
// hooks without a real DOM. Mirrors core-paths.test.mjs.
const listeners = new Map();
globalThis.window = {
  addEventListener: (type, h) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(h);
  },
  removeEventListener: (type, h) => { listeners.get(type)?.delete(h); },
};
Object.defineProperty(globalThis, 'location', {
  value: { pathname: '/test', host: 'localhost' },
  configurable: true,
});

const dispatch = (type, ev) => { for (const h of (listeners.get(type) ?? [])) h(ev); };

const { AllStak, SessionTracker, __setForceSessionTrackingForTest } =
  await import('../dist/index.mjs');

// ── A fake transport capturing send(path, payload, options) ──────
function makeTransport() {
  const calls = [];
  return {
    calls,
    send(path, payload, options) { calls.push({ path, payload, options }); return Promise.resolve(); },
  };
}

function makeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem(key) { return data.get(key) ?? null; },
    setItem(key, value) { data.set(key, value); },
    removeItem(key) { data.delete(key); },
  };
}

const SESSION_ID = '00000000-0000-4000-8000-000000000000';

// ───────────────────────────────────────────────────────────────
// 1. start payload shape
// ───────────────────────────────────────────────────────────────

test('SessionTracker.start posts /ingest/v1/sessions/start with the reused sessionId', () => {
  const tx = makeTransport();
  const tracker = new SessionTracker(tx, {
    release: 'web@2.0.0',
    environment: 'production',
    getUserId: () => 'user-42',
    sdkName: 'allstak-react',
    sdkVersion: '0.4.0',
    platform: 'browser',
  }, SESSION_ID);

  tracker.start();

  assert.equal(tx.calls.length, 1);
  const { path, payload } = tx.calls[0];
  assert.equal(path, '/ingest/v1/sessions/start');
  assert.equal(payload.sessionId, SESSION_ID);
  assert.equal(payload.release, 'web@2.0.0');
  assert.equal(payload.environment, 'production');
  assert.equal(payload.userId, 'user-42');
  assert.equal(payload.sdkName, 'allstak-react');
  assert.equal(payload.sdkVersion, '0.4.0');
  assert.equal(payload.platform, 'browser');
});

test('SessionTracker.start falls back to sdkVersion when no release is set', () => {
  const tx = makeTransport();
  const tracker = new SessionTracker(tx, { sdkVersion: '0.4.0', platform: 'browser' }, SESSION_ID);
  tracker.start();
  assert.equal(tx.calls.length, 1);
  assert.equal(tx.calls[0].payload.release, '0.4.0');
});

test('SessionTracker.start is idempotent — a second start is a no-op', () => {
  const tx = makeTransport();
  const tracker = new SessionTracker(tx, { release: 'r' }, SESSION_ID);
  tracker.start();
  tracker.start();
  assert.equal(tx.calls.filter((c) => c.path.endsWith('/sessions/start')).length, 1);
});

test('SessionTracker with no resolvable release skips network I/O but keeps in-memory status', () => {
  const tx = makeTransport();
  const tracker = new SessionTracker(tx, { environment: 'production' }, SESSION_ID);
  tracker.start();
  assert.equal(tx.calls.length, 0);
  // In-memory tracker still works.
  assert.equal(tracker.getStatus(), 'ok');
  tracker.recordError();
  assert.equal(tracker.getStatus(), 'errored');
  tracker.end();
  // Still no I/O because no release was attributable.
  assert.equal(tx.calls.length, 0);
});

// ───────────────────────────────────────────────────────────────
// 2. end payload shape + status transitions
// ───────────────────────────────────────────────────────────────

test('status transitions ok → errored → crashed and end posts the final status', () => {
  const tx = makeTransport();
  const tracker = new SessionTracker(tx, { release: 'web@2.0.0' }, SESSION_ID);

  tracker.start();
  assert.equal(tracker.getStatus(), 'ok');

  tracker.recordError();
  assert.equal(tracker.getStatus(), 'errored');

  tracker.recordCrash();
  assert.equal(tracker.getStatus(), 'crashed');

  tracker.end();

  const endCall = tx.calls.find((c) => c.path === '/ingest/v1/sessions/end');
  assert.ok(endCall, 'must post /ingest/v1/sessions/end');
  assert.equal(endCall.payload.sessionId, SESSION_ID);
  assert.equal(endCall.payload.status, 'crashed');
  assert.equal(typeof endCall.payload.durationMs, 'number');
  assert.ok(endCall.payload.durationMs >= 0);
  // Best-effort short timeout passed through to the transport.
  assert.equal(typeof endCall.options.timeoutMs, 'number');
});

test('end posts status "ok" for a clean session', () => {
  const tx = makeTransport();
  const tracker = new SessionTracker(tx, { release: 'r' }, SESSION_ID);
  tracker.start();
  tracker.end();
  const endCall = tx.calls.find((c) => c.path.endsWith('/sessions/end'));
  assert.equal(endCall.payload.status, 'ok');
});

test('crashed status is terminal — a later recordError does not downgrade it', () => {
  const tx = makeTransport();
  const tracker = new SessionTracker(tx, { release: 'r' }, SESSION_ID);
  tracker.start();
  tracker.recordCrash();
  tracker.recordError(); // must NOT downgrade crashed → errored
  assert.equal(tracker.getStatus(), 'crashed');
  tracker.end();
  assert.equal(tx.calls.find((c) => c.path.endsWith('/sessions/end')).payload.status, 'crashed');
});

test('end is idempotent and does not re-arm', () => {
  const tx = makeTransport();
  const tracker = new SessionTracker(tx, { release: 'r' }, SESSION_ID);
  tracker.start();
  tracker.end();
  tracker.end();
  assert.equal(tx.calls.filter((c) => c.path.endsWith('/sessions/end')).length, 1);
  assert.equal(tracker.current(), null);
});

test('an explicit finalStatus overrides the accumulated status', () => {
  const tx = makeTransport();
  const tracker = new SessionTracker(tx, { release: 'r' }, SESSION_ID);
  tracker.start();
  tracker.recordError();
  tracker.end('abnormal');
  assert.equal(tx.calls.find((c) => c.path.endsWith('/sessions/end')).payload.status, 'abnormal');
});

test('abnormal recovery: clean shutdown does not report abnormal on next start', () => {
  const storage = makeStorage();
  const key = 'allstak.session.react.clean';
  const first = makeTransport();
  const tracker = new SessionTracker(first, { release: 'r' }, 'sid-clean', { storage, storageKey: key });
  tracker.start();
  tracker.end();

  const second = makeTransport();
  new SessionTracker(second, { release: 'r' }, 'sid-next', { storage, storageKey: key }).start();

  assert.equal(second.calls.filter((c) => c.path.endsWith('/sessions/end')).length, 0);
  assert.equal(second.calls.filter((c) => c.path.endsWith('/sessions/start')).length, 1);
});

test('abnormal recovery: previous open session is reported abnormal on next start', () => {
  const storage = makeStorage();
  const key = 'allstak.session.react.abnormal';
  new SessionTracker(makeTransport(), { release: 'r' }, 'sid-open', { storage, storageKey: key }).start();

  const second = makeTransport();
  new SessionTracker(second, { release: 'r' }, 'sid-next', { storage, storageKey: key }).start();

  const recovered = second.calls.find((c) => c.path.endsWith('/sessions/end'));
  assert.ok(recovered);
  assert.equal(recovered.payload.sessionId, 'sid-open');
  assert.equal(recovered.payload.status, 'abnormal');
});

test('abnormal recovery: previous crashed open session is reported crashed', () => {
  const storage = makeStorage();
  const key = 'allstak.session.react.crashed';
  const tracker = new SessionTracker(makeTransport(), { release: 'r' }, 'sid-crashed', { storage, storageKey: key });
  tracker.start();
  tracker.recordCrash();

  const second = makeTransport();
  new SessionTracker(second, { release: 'r' }, 'sid-next', { storage, storageKey: key }).start();

  const recovered = second.calls.find((c) => c.path.endsWith('/sessions/end'));
  assert.ok(recovered);
  assert.equal(recovered.payload.sessionId, 'sid-crashed');
  assert.equal(recovered.payload.status, 'crashed');
});

test('abnormal recovery: corrupt session state is dropped safely', () => {
  const key = 'allstak.session.react.corrupt';
  const storage = makeStorage({ [key]: '{not-json' });
  const tx = makeTransport();
  assert.doesNotThrow(() => new SessionTracker(tx, { release: 'r' }, 'sid-new', { storage, storageKey: key }).start());
  assert.equal(tx.calls.filter((c) => c.path.endsWith('/sessions/end')).length, 0);
  assert.equal(tx.calls.filter((c) => c.path.endsWith('/sessions/start')).length, 1);
});

test('abnormal recovery: repeated starts do not duplicate the recovered abnormal report', () => {
  const storage = makeStorage();
  const key = 'allstak.session.react.dedupe';
  new SessionTracker(makeTransport(), { release: 'r' }, 'sid-open', { storage, storageKey: key }).start();

  const second = makeTransport();
  const secondTracker = new SessionTracker(second, { release: 'r' }, 'sid-second', { storage, storageKey: key });
  secondTracker.start();
  secondTracker.end();

  const third = makeTransport();
  new SessionTracker(third, { release: 'r' }, 'sid-third', { storage, storageKey: key }).start();

  assert.equal(second.calls.filter((c) => c.path.endsWith('/sessions/end') && c.payload.status === 'abnormal').length, 1);
  assert.equal(third.calls.filter((c) => c.path.endsWith('/sessions/end') && c.payload.status === 'abnormal').length, 0);
});

// ───────────────────────────────────────────────────────────────
// 3. Client opt-out + test-runtime auto-skip
// ───────────────────────────────────────────────────────────────

test('client auto-skips session tracking under a unit-test runtime', async () => {
  sent.length = 0;
  __setForceSessionTrackingForTest(false); // honour the real test-runtime guard
  AllStak.init({ apiKey: 'k', release: 'web@1.0.0', autoCaptureBrowserErrors: false });
  await new Promise((r) => setTimeout(r, 30));
  const startPosts = sent.filter((s) => s.url.endsWith('/ingest/v1/sessions/start'));
  assert.equal(startPosts.length, 0, 'no /sessions/start under test runtime');
  AllStak.destroy();
});

test('enableAutoSessionTracking:false opts out even when tracking is otherwise enabled', async () => {
  sent.length = 0;
  __setForceSessionTrackingForTest(true); // bypass the test-runtime guard
  try {
    AllStak.init({
      apiKey: 'k', release: 'web@1.0.0',
      enableAutoSessionTracking: false,
      autoCaptureBrowserErrors: false,
    });
    await new Promise((r) => setTimeout(r, 30));
    const startPosts = sent.filter((s) => s.url.endsWith('/ingest/v1/sessions/start'));
    assert.equal(startPosts.length, 0, 'opt-out must not post /sessions/start');
    AllStak.destroy();
  } finally {
    __setForceSessionTrackingForTest(false);
  }
});

// ───────────────────────────────────────────────────────────────
// 4. Client wiring: start on init, errored/crashed, end on destroy
// ───────────────────────────────────────────────────────────────

test('client posts /sessions/start on init and /sessions/end on destroy with errored→crashed status', async () => {
  sent.length = 0;
  listeners.clear();
  __setForceSessionTrackingForTest(true);
  try {
    AllStak.init({
      apiKey: 'k',
      release: 'web@3.0.0',
      environment: 'production',
      user: { id: 'u-7' },
    });
    await new Promise((r) => setTimeout(r, 30));

    const startPost = sent.find((s) => s.url.endsWith('/ingest/v1/sessions/start'));
    assert.ok(startPost, 'init must post /sessions/start');
    const startBody = JSON.parse(startPost.init.body);
    assert.equal(startBody.release, 'web@3.0.0');
    assert.equal(startBody.userId, 'u-7');
    const sessionId = startBody.sessionId;
    assert.equal(sessionId, AllStak.getSessionId());

    // Handled error → errored.
    AllStak.captureException(new Error('handled-boom'));
    await new Promise((r) => setTimeout(r, 20));

    // Unhandled error via the window handler → crashed (terminal).
    dispatch('error', { error: new Error('unhandled-boom'), message: 'unhandled-boom' });
    await new Promise((r) => setTimeout(r, 20));

    // Every error payload carries the session id (backend marks crash/error by it).
    const errPosts = sent.filter((s) => s.url.endsWith('/ingest/v1/errors'));
    assert.ok(errPosts.length >= 2);
    for (const e of errPosts) {
      assert.equal(JSON.parse(e.init.body).sessionId, sessionId);
    }

    sent.length = 0;
    AllStak.destroy();
    await new Promise((r) => setTimeout(r, 20));

    const endPost = sent.find((s) => s.url.endsWith('/ingest/v1/sessions/end'));
    assert.ok(endPost, 'destroy must post /sessions/end');
    const endBody = JSON.parse(endPost.init.body);
    assert.equal(endBody.sessionId, sessionId);
    assert.equal(endBody.status, 'crashed'); // crash wins over the earlier handled error
    assert.equal(typeof endBody.durationMs, 'number');
  } finally {
    __setForceSessionTrackingForTest(false);
    AllStak.destroy();
  }
});

test('a purely handled error yields an "errored" session at end', async () => {
  sent.length = 0;
  listeners.clear();
  __setForceSessionTrackingForTest(true);
  try {
    AllStak.init({ apiKey: 'k', release: 'web@3.0.0', autoCaptureBrowserErrors: false });
    await new Promise((r) => setTimeout(r, 20));
    AllStak.captureException(new Error('only-handled'));
    await new Promise((r) => setTimeout(r, 20));
    sent.length = 0;
    AllStak.destroy();
    await new Promise((r) => setTimeout(r, 20));
    const endPost = sent.find((s) => s.url.endsWith('/ingest/v1/sessions/end'));
    assert.ok(endPost);
    assert.equal(JSON.parse(endPost.init.body).status, 'errored');
  } finally {
    __setForceSessionTrackingForTest(false);
    AllStak.destroy();
  }
});
