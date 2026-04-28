/**
 * React Router + Next.js router helper tests.
 *
 * Both helpers must:
 *   - record a navigation breadcrumb on path change
 *   - skip when called twice with the same path (idempotent)
 *   - NOT pull react-router-dom or next as a runtime dependency
 *     (verified by the dist `@allstak/*` audit elsewhere)
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
  value: { pathname: '/start', search: '', host: 'localhost' },
  configurable: true, writable: true,
});

const { AllStak, instrumentReactRouter, instrumentNextRouter } = await import('../dist/index.mjs');

const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const cfgOff = {
  autoCaptureBrowserErrors: false, autoBreadcrumbsFetch: false,
  autoBreadcrumbsConsole: false, autoBreadcrumbsNavigation: false,
};

test('instrumentReactRouter records a navigation breadcrumb on path change', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k', ...cfgOff });
  instrumentReactRouter({ pathname: '/home' });
  instrumentReactRouter({ pathname: '/cart', search: '?id=1' });
  AllStak.captureException(new Error('after-route-changes'));
  await wait();
  const body = JSON.parse(sent[0].init.body);
  const navCrumbs = (body.breadcrumbs ?? []).filter((c) => c.type === 'navigation' && c.data?.router === 'react-router');
  assert.equal(navCrumbs.length, 2);
  assert.match(navCrumbs[0].message, /<initial> -> \/home/);
  assert.match(navCrumbs[1].message, /\/home -> \/cart\?id=1/);
});

test('instrumentReactRouter is idempotent on the same path', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k', ...cfgOff });
  instrumentReactRouter({ pathname: '/same' });
  instrumentReactRouter({ pathname: '/same' });
  instrumentReactRouter({ pathname: '/same' });
  AllStak.captureException(new Error('after'));
  await wait();
  const body = JSON.parse(sent[0].init.body);
  const navCrumbs = (body.breadcrumbs ?? []).filter((c) => c.type === 'navigation' && c.data?.router === 'react-router');
  // Module-level `lastReactRouterPath` persists across init — at most one
  // new breadcrumb should fire because /same was already the cached value
  // from the previous test (which set it to /cart?id=1 last). So this
  // test confirms idempotence: 1 breadcrumb for /cart->/same, 0 for the
  // two subsequent /same->/same calls.
  assert.equal(navCrumbs.length, 1);
});

test('instrumentNextRouter records a navigation breadcrumb on URL change', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k', ...cfgOff });
  instrumentNextRouter('/dashboard');
  instrumentNextRouter('/settings');
  AllStak.captureException(new Error('after-next-routes'));
  await wait();
  const body = JSON.parse(sent[0].init.body);
  const navCrumbs = (body.breadcrumbs ?? []).filter((c) => c.type === 'navigation' && c.data?.router === 'next');
  assert.equal(navCrumbs.length, 2);
  assert.match(navCrumbs[0].message, /<initial> -> \/dashboard/);
  assert.match(navCrumbs[1].message, /\/dashboard -> \/settings/);
});

test('dist contains no hard imports of react-router or next', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../dist/index.mjs', import.meta.url), 'utf8');
  assert.ok(!/from ["']react-router/.test(src), 'must not import react-router');
  assert.ok(!/require\(['"]react-router/.test(src), 'must not require react-router');
  assert.ok(!/from ["']next\//.test(src), 'must not import next/*');
  assert.ok(!/require\(['"]next\//.test(src), 'must not require next/*');
});
