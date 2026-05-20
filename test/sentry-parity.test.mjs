/**
 * Sentry-parity API tests for @allstak/react-native:
 *   beforeSend / sampleRate / setTags / setExtra(s) / setContext / flush()
 *   logger / tunnel / React 19 root error hooks / Sentry-style startSpan()
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const sent = [];
const mockFetch = async (url, init) => {
  sent.push({ url, init });
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
};
Object.defineProperty(globalThis, 'fetch', { get() { return mockFetch; }, configurable: false });

const SDK = await import('../dist/index.mjs');
const { AllStak, reactErrorHandler } = SDK;

test('beforeSend can mutate the event', async () => {
  AllStak.init({
    apiKey: 'k',
    beforeSend: (ev) => ({ ...ev, message: `[scrubbed] ${ev.message}` }),
  });
  AllStak.captureException(new Error('secret-token-12345'));
  await new Promise((r) => setTimeout(r, 50));
  const body = JSON.parse(sent.at(-1).init.body);
  assert.match(body.message, /^\[scrubbed\] /);
});

test('namespace-style imports expose init/capture/logger like Sentry', async () => {
  sent.length = 0;
  SDK.init({ apiKey: 'k' });
  SDK.captureException(new Error('namespace capture'));
  SDK.logger.info('namespace log', { ok: true });
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(typeof SDK.init, 'function');
  assert.equal(typeof SDK.captureException, 'function');
  assert.equal(typeof SDK.logger.info, 'function');
  assert.ok(sent.some((r) => String(r.url).endsWith('/ingest/v1/errors')));
  assert.ok(sent.some((r) => String(r.url).endsWith('/ingest/v1/logs')));
});

test('beforeSend can drop the event by returning null', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k', beforeSend: () => null });
  AllStak.captureException(new Error('drop-me'));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent.length, 0);
});

test('beforeSend supports async hooks', async () => {
  sent.length = 0;
  AllStak.init({
    apiKey: 'k',
    beforeSend: async (ev) => { await new Promise((r) => setTimeout(r, 5)); return { ...ev, message: 'async-' + ev.message }; },
  });
  AllStak.captureException(new Error('payload'));
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(JSON.parse(sent[0].init.body).message, 'async-payload');
});

test('a throwing beforeSend never drops telemetry — sends original payload', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k', beforeSend: () => { throw new Error('hook-broken'); } });
  AllStak.captureException(new Error('original'));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent.length, 1);
  assert.equal(JSON.parse(sent[0].init.body).message, 'original');
});

test('sampleRate=0 drops everything', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k', sampleRate: 0 });
  for (let i = 0; i < 10; i++) AllStak.captureException(new Error(`e${i}`));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent.length, 0);
});

test('sampleRate=1 sends everything', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k', sampleRate: 1 });
  for (let i = 0; i < 5; i++) AllStak.captureException(new Error(`e${i}`));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent.length, 5);
});

test('setTags merges with existing tags', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k', tags: { region: 'eu' } });
  AllStak.setTags({ feature: 'login', tier: 'pro' });
  AllStak.captureException(new Error('e'));
  await new Promise((r) => setTimeout(r, 50));
  const meta = JSON.parse(sent[0].init.body).metadata;
  assert.equal(meta.region, 'eu');
  assert.equal(meta.feature, 'login');
  assert.equal(meta.tier, 'pro');
});

test('setExtra and setExtras land in metadata', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k' });
  AllStak.setExtra('cart_id', 'c-42');
  AllStak.setExtras({ ab_bucket: 'B', flag_x: true });
  AllStak.captureException(new Error('e'));
  await new Promise((r) => setTimeout(r, 50));
  const meta = JSON.parse(sent[0].init.body).metadata;
  assert.equal(meta.cart_id, 'c-42');
  assert.equal(meta.ab_bucket, 'B');
  assert.equal(meta.flag_x, true);
});

test('setContext stores under metadata["context.<name>"]', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k' });
  AllStak.setContext('app', { version: '1.2.3', startedAt: 'now' });
  AllStak.captureException(new Error('e'));
  await new Promise((r) => setTimeout(r, 50));
  const meta = JSON.parse(sent[0].init.body).metadata;
  assert.deepEqual(meta['context.app'], { version: '1.2.3', startedAt: 'now' });
});

test('setContext(name, null) removes a context bag', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k' });
  AllStak.setContext('app', { v: 1 });
  AllStak.setContext('app', null);
  AllStak.captureException(new Error('e'));
  await new Promise((r) => setTimeout(r, 50));
  const meta = JSON.parse(sent[0].init.body).metadata;
  assert.equal(meta['context.app'], undefined);
});

test('flush() resolves true when buffer is empty', async () => {
  AllStak.init({ apiKey: 'k' });
  const ok = await AllStak.flush(500);
  assert.equal(ok, true);
});

test('logger API posts structured logs without creating error events', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k' });
  AllStak.logger.info('User action', { userId: '123' });
  AllStak.logger.warn('Slow response', { duration: 5000 });
  AllStak.logger.error('Operation failed', { reason: 'timeout' });
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(sent.length, 3);
  assert.ok(sent.every((r) => String(r.url).endsWith('/ingest/v1/logs')));
  const bodies = sent.map((r) => JSON.parse(r.init.body));
  assert.equal(bodies[0].level, 'info');
  assert.equal(bodies[0].metadata.userId, '123');
  assert.equal(bodies[1].level, 'warn');
  assert.equal(bodies[1].metadata.duration, 5000);
  assert.equal(bodies[2].level, 'error');
  assert.equal(bodies[2].metadata.reason, 'timeout');
});

test('tunnel option posts to local tunnel while preserving apiKey identity', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'ask_live_test', tunnel: '/allstak-tunnel' });
  AllStak.captureException(new Error('via tunnel'));
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, '/allstak-tunnel');
  assert.equal(sent[0].init.headers['X-AllStak-Key'], 'ask_live_test');
  assert.equal(sent[0].init.headers['X-AllStak-Target-Path'], '/ingest/v1/errors');
  const body = JSON.parse(sent[0].init.body);
  assert.equal(body.path, '/ingest/v1/errors');
  assert.equal(body.payload.message, 'via tunnel');
});

test('reactErrorHandler captures React 19 root errors and invokes callback', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k' });
  let called = false;
  const handler = reactErrorHandler((error, info) => {
    called = true;
    assert.equal(error.message, 'root boom');
    assert.equal(info.componentStack, '<App />');
  });
  handler(new Error('root boom'), { componentStack: '<App />', digest: 'd1' });
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(called, true);
  const payload = JSON.parse(sent[0].init.body);
  assert.equal(payload.message, 'root boom');
  assert.equal(payload.metadata.source, 'react.root.error-handler');
  assert.equal(payload.metadata.componentStack, '<App />');
  assert.equal(payload.metadata.digest, 'd1');
});

test('startSpan accepts Sentry-style object input and callback', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k', release: 'r' });
  const value = AllStak.startSpan(
    { op: 'test', name: 'Example Frontend Span', attributes: { route: '/checkout' } },
    () => 42,
  );
  AllStak.destroy();
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(value, 42);
  const spanReq = sent.find((r) => String(r.url).endsWith('/ingest/v1/spans'));
  assert.ok(spanReq);
  const span = JSON.parse(spanReq.init.body).spans[0];
  assert.equal(span.operation, 'test');
  assert.equal(span.description, 'Example Frontend Span');
  assert.equal(span.tags.route, '/checkout');
  assert.equal(span.status, 'ok');
});
