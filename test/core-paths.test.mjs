/**
 * Core-path tests for @allstak/react — exercise the critical wiring
 * production depends on:
 *
 *   1. window.onerror auto-capture
 *   2. window.unhandledrejection auto-capture
 *   3. Stack parser correctness across V8, Hermes, and Gecko traces
 *   4. Transport offline buffer + retry on next successful send
 *   5. ErrorBoundary captures render-tree errors via componentDidCatch
 *
 * No JSDOM — we install a minimal fake `window` that records listeners,
 * sufficient to prove the SDK actually calls addEventListener and that
 * dispatched events trigger captureException.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const sent = [];
let failNextN = 0;
const mockFetch = async (url, init) => {
  if (failNextN > 0) {
    failNextN -= 1;
    throw new Error('network');
  }
  sent.push({ url, init });
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
};
Object.defineProperty(globalThis, 'fetch', { get() { return mockFetch; }, configurable: false });

// Minimal window stub. The SDK only uses addEventListener/removeEventListener
// on `window` plus reads location/navigator. We make those benign.
const listeners = new Map();
globalThis.window = {
  addEventListener: (type, h) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(h);
  },
  removeEventListener: (type, h) => {
    listeners.get(type)?.delete(h);
  },
};
// `navigator` is a non-configurable getter in modern Node — only stub
// `location`. The SDK tolerates a missing `navigator` (userAgent ends up
// undefined in requestContext, which is fine for tests).
Object.defineProperty(globalThis, 'location', {
  value: { pathname: '/test', host: 'localhost' },
  configurable: true,
});

const dispatch = (type, ev) => {
  for (const h of (listeners.get(type) ?? [])) h(ev);
};

const { AllStak, AllStakErrorBoundary } = await import('../dist/index.mjs');

// ───────────────────────────────────────────────────────────────
// 1. window.onerror auto-capture
// ───────────────────────────────────────────────────────────────

test('AllStak.init registers a window error listener that captures unhandled errors', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k', environment: 'test' });

  assert.ok(listeners.get('error')?.size, 'window.addEventListener("error", …) must be called');

  dispatch('error', { error: new Error('boom-window-error'), message: 'boom-window-error' });
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(sent.length, 1);
  const body = JSON.parse(sent[0].init.body);
  assert.equal(body.message, 'boom-window-error');
  assert.equal(body.metadata.source, 'window.onerror');
  assert.equal(body.platform, 'browser');
});

test('window error event with non-Error payload is wrapped via message', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k' });
  dispatch('error', { error: null, message: 'string-only-error' });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(JSON.parse(sent[0].init.body).message, 'string-only-error');
});

// ───────────────────────────────────────────────────────────────
// 2. window.unhandledrejection auto-capture
// ───────────────────────────────────────────────────────────────

test('AllStak.init registers an unhandledrejection listener', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k' });
  assert.ok(listeners.get('unhandledrejection')?.size, 'must register unhandledrejection');

  dispatch('unhandledrejection', { reason: new Error('rejected!') });
  await new Promise((r) => setTimeout(r, 50));

  const body = JSON.parse(sent[0].init.body);
  assert.equal(body.message, 'rejected!');
  assert.equal(body.metadata.source, 'window.unhandledrejection');
});

test('unhandled rejection with non-Error reason is wrapped', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k' });
  dispatch('unhandledrejection', { reason: 'plain-string-reason' });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(JSON.parse(sent[0].init.body).message, 'plain-string-reason');
});

test('autoCaptureBrowserErrors=false skips listener registration', async () => {
  // Reset listeners for a clean check.
  listeners.clear();
  AllStak.init({ apiKey: 'k', autoCaptureBrowserErrors: false });
  assert.equal(listeners.get('error'), undefined);
  assert.equal(listeners.get('unhandledrejection'), undefined);
});

// ───────────────────────────────────────────────────────────────
// 3. Stack parser correctness
// ───────────────────────────────────────────────────────────────

test('stack parser produces frames for V8 / Hermes traces', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k', autoCaptureBrowserErrors: false });
  const err = new Error('boom');
  err.stack = [
    'Error: boom',
    '    at handler (file:///app/src/index.js:42:15)',
    '    at Object.<anonymous> (file:///app/main.js:7:1)',
  ].join('\n');
  AllStak.captureException(err);
  await new Promise((r) => setTimeout(r, 50));

  const body = JSON.parse(sent[0].init.body);
  assert.equal(body.frames.length, 2);
  assert.equal(body.frames[0].function, 'handler');
  assert.equal(body.frames[0].lineno, 42);
  assert.equal(body.frames[0].colno, 15);
});

test('stack parser handles Gecko-style traces', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k', autoCaptureBrowserErrors: false });
  const err = new Error('gecko');
  err.stack = ['doThing@file:///app/lib.js:10:5', '@file:///app/main.js:1:1'].join('\n');
  AllStak.captureException(err);
  await new Promise((r) => setTimeout(r, 50));

  const body = JSON.parse(sent[0].init.body);
  assert.equal(body.frames.length, 2);
  assert.equal(body.frames[0].function, 'doThing');
});

test('stack parser tolerates missing stacks without crashing', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k', autoCaptureBrowserErrors: false });
  const err = new Error('no stack');
  err.stack = undefined;
  AllStak.captureException(err);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent.length, 1);
});

// ───────────────────────────────────────────────────────────────
// 4. Transport offline buffer + retry
// ───────────────────────────────────────────────────────────────

test('failed send is buffered and re-sent on next successful capture', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k', autoCaptureBrowserErrors: false });

  failNextN = 1;
  AllStak.captureException(new Error('first-fail'));
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(sent.length, 0);

  AllStak.captureException(new Error('second-success'));
  await new Promise((r) => setTimeout(r, 100));

  const messages = sent.map((s) => JSON.parse(s.init.body).message).sort();
  assert.deepEqual(messages, ['first-fail', 'second-success'].sort());
});

// ───────────────────────────────────────────────────────────────
// 5. ErrorBoundary componentDidCatch capture path
// ───────────────────────────────────────────────────────────────

test('AllStakErrorBoundary.componentDidCatch reports the error with component stack', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k', autoCaptureBrowserErrors: false });

  // Synthesize what React would do: instantiate the boundary with props,
  // then call its componentDidCatch directly. (RTL would do the same path,
  // we just don't drag it in.)
  const boundary = new AllStakErrorBoundary({ children: null, tags: { feature: 'cart' } });
  const err = new Error('render-crashed');
  boundary.componentDidCatch(err, { componentStack: '\n    in Cart\n    in App' });
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(sent.length, 1);
  const body = JSON.parse(sent[0].init.body);
  assert.equal(body.message, 'render-crashed');
  assert.equal(body.metadata.source, 'react-error-boundary');
  assert.match(body.metadata.componentStack, /in Cart/);
  assert.equal(body.metadata['tag.feature'], 'cart');
});
