/**
 * Debug-ID resolution end-to-end test.
 *
 * Simulates the build-time inject step having populated
 * `globalThis._allstakDebugIds`, captures an error whose stack frames
 * point at registered files, and verifies the resolved UUID is attached
 * to each frame in the wire payload — which is what the symbolicator
 * uses server-side to pick the correct .map.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const sent = [];
Object.defineProperty(globalThis, 'fetch', {
  value: async (url, init) => { sent.push({ url: String(url), init }); return new Response('{}', { status: 200 }); },
  writable: true, configurable: true,
});

const winListeners = new Map();
globalThis.window = {
  addEventListener: (t, h) => { if (!winListeners.has(t)) winListeners.set(t, new Set()); winListeners.get(t).add(h); },
  removeEventListener: (t, h) => winListeners.get(t)?.delete(h),
};
Object.defineProperty(globalThis, 'location', {
  value: { pathname: '/test', search: '', host: 'localhost' },
  configurable: true, writable: true,
});

const { AllStak } = await import('../dist/index.mjs');

const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const cfgOff = { autoCaptureBrowserErrors: false, autoBreadcrumbsFetch: false, autoBreadcrumbsConsole: false, autoBreadcrumbsNavigation: false };

test('debug-id from globalThis._allstakDebugIds is attached to matching frames', async () => {
  globalThis._allstakDebugIds = {
    'http://app/main.js': '11111111-2222-3333-4444-555555555555',
    'http://app/vendor.js': 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  };

  sent.length = 0;
  AllStak.init({ apiKey: 'k', ...cfgOff });
  const err = new Error('boom');
  err.stack = [
    'Error: boom',
    '    at handler (http://app/main.js:42:15)',
    '    at run (http://app/vendor.js:7:1)',
  ].join('\n');
  AllStak.captureException(err);
  await wait();

  const body = JSON.parse(sent[0].init.body);
  assert.equal(body.frames.length, 2);
  assert.equal(body.frames[0].debugId, '11111111-2222-3333-4444-555555555555');
  assert.equal(body.frames[1].debugId, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  delete globalThis._allstakDebugIds;
});

test('frames without a registered filename get no debug-id (no false positive)', async () => {
  globalThis._allstakDebugIds = { 'http://app/main.js': 'uuid-known' };

  sent.length = 0;
  AllStak.init({ apiKey: 'k', ...cfgOff });
  const err = new Error('boom');
  err.stack = [
    'Error: boom',
    '    at unknown (http://app/never-registered.js:1:1)',
  ].join('\n');
  AllStak.captureException(err);
  await wait();

  const body = JSON.parse(sent[0].init.body);
  assert.equal(body.frames[0].debugId, undefined,
    'unregistered filename must not be assigned a stale debug-id');
  delete globalThis._allstakDebugIds;
});

test('debug-id resolution tolerates relative-suffix matches (Vite dev server style)', async () => {
  // The build-time inject step may register the bundle by relative path
  // (e.g. '/assets/main.js') even when the runtime stack carries the
  // full URL. The resolver falls back to suffix-matching.
  globalThis._allstakDebugIds = { '/assets/main.js': 'suffix-uuid' };

  sent.length = 0;
  AllStak.init({ apiKey: 'k', ...cfgOff });
  const err = new Error('boom');
  err.stack = ['    at fn (https://app.example.com/assets/main.js:1:1)'].join('\n');
  AllStak.captureException(err);
  await wait();

  const body = JSON.parse(sent[0].init.body);
  assert.equal(body.frames[0].debugId, 'suffix-uuid');
  delete globalThis._allstakDebugIds;
});
