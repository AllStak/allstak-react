/**
 * Smoke tests for @allstak/react standalone client surface. Validates:
 *   - init/captureException posts to /ingest/v1/errors
 *   - breadcrumbs are batched + cleared on capture
 *   - setUser/setTag flow through the wire payload
 *   - dist contains no @allstak/js or @allstak-io references
 *
 * The React-specific exports (AllStakErrorBoundary / useAllStak / withAllStakProfiler)
 * are render-time and exercised in downstream integration tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sent = [];
const mockFetch = async (url, init) => {
  sent.push({ url, init });
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
};
Object.defineProperty(globalThis, 'fetch', { get() { return mockFetch; }, configurable: false });

const { AllStak, AllStakErrorBoundary, useAllStak, withAllStakProfiler } =
  await import('../dist/index.mjs');

test('init throws when apiKey missing', () => {
  assert.throws(() => AllStak.init({}), /apiKey is required/);
});

test('captureException posts to /ingest/v1/errors with X-AllStak-Key', async () => {
  AllStak.init({ apiKey: 'ask_test_key', environment: 'test', release: 'web@1.0.0' });
  AllStak.captureException(new Error('boom'));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent.length, 1);
  assert.match(sent[0].url, /\/ingest\/v1\/errors$/);
  assert.equal(sent[0].init.headers['X-AllStak-Key'], 'ask_test_key');
  const body = JSON.parse(sent[0].init.body);
  assert.equal(body.message, 'boom');
  assert.equal(body.platform, 'browser');
  assert.equal(body.sdkName, 'allstak-react');
  assert.equal(body.environment, 'test');
  assert.equal(body.release, 'web@1.0.0');
});

test('breadcrumb is attached to next capture and cleared after', async () => {
  sent.length = 0;
  AllStak.addBreadcrumb('navigation', 'open Home', 'info');
  AllStak.captureException(new Error('after-crumb'));
  await new Promise((r) => setTimeout(r, 50));
  const body = JSON.parse(sent[0].init.body);
  assert.equal(body.breadcrumbs.length, 1);
  assert.equal(body.breadcrumbs[0].message, 'open Home');

  sent.length = 0;
  AllStak.captureException(new Error('after-clear'));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(JSON.parse(sent[0].init.body).breadcrumbs, undefined);
});

test('setUser / setTag / setIdentity flow through wire payload', async () => {
  sent.length = 0;
  AllStak.setUser({ id: 'u-1', email: 'a@b.com' });
  AllStak.setTag('feature', 'checkout');
  AllStak.setIdentity({ dist: 'web-prod' });
  AllStak.captureException(new Error('with-meta'));
  await new Promise((r) => setTimeout(r, 50));
  const body = JSON.parse(sent[0].init.body);
  assert.deepEqual(body.user, { id: 'u-1', email: 'a@b.com' });
  assert.equal(body.dist, 'web-prod');
  assert.equal(body.metadata['feature'], 'checkout');
});

test('captureMessage routes info -> logs and error -> both', async () => {
  sent.length = 0;
  AllStak.captureMessage('hello info', 'info');
  AllStak.captureMessage('boom error', 'error');
  await new Promise((r) => setTimeout(r, 50));
  const paths = sent.map((s) => new URL(s.url).pathname);
  assert.equal(paths.filter((p) => p === '/ingest/v1/logs').length, 2);
  assert.equal(paths.filter((p) => p === '/ingest/v1/errors').length, 1);
});

test('React-side exports are present', () => {
  assert.equal(typeof AllStakErrorBoundary, 'function');
  assert.equal(typeof useAllStak, 'function');
  assert.equal(typeof withAllStakProfiler, 'function');
});

test('dist must not reference any @allstak/* sibling SDK or @allstak-io', () => {
  const src = readFileSync(new URL('../dist/index.mjs', import.meta.url), 'utf8');
  for (const re of [/@allstak\/js\b/, /@allstak\/core\b/, /@allstak\/browser\b/, /@allstak-io/]) {
    assert.ok(!re.test(src), `dist must not reference ${re}`);
  }
});
