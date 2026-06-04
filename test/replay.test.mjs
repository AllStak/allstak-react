/**
 * Privacy-default tests for the web replay recorder.
 *
 * Hard rule (asserted below): inputs ARE masked by default. Password
 * fields are masked even when `maskAllInputs: false`. Elements tagged
 * with `data-allstak-mask` have their text content replaced with `***`
 * in the initial snapshot.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM(`<!doctype html><html><body>
  <div id="root">
    <h1>Hello</h1>
    <input id="email" type="text" value="user@example.com">
    <input id="pw" type="password" value="hunter2">
    <div data-allstak-mask>SECRET-API-KEY-XYZ</div>
  </div>
</body></html>`, { url: 'http://localhost/test' });
const set = (k, v) => Object.defineProperty(globalThis, k, { value: v, writable: true, configurable: true });
set('window', dom.window);
set('document', dom.window.document);
set('navigator', dom.window.navigator);
set('HTMLElement', dom.window.HTMLElement);
set('Node', dom.window.Node);
set('Element', dom.window.Element);
set('Event', dom.window.Event);
set('MutationObserver', dom.window.MutationObserver);
set('location', dom.window.location);
set('history', dom.window.history);

const sent = [];
Object.defineProperty(globalThis, 'fetch', {
  value: async (url, init) => { sent.push({ url: String(url), init }); return new Response('{}', { status: 200 }); },
  writable: true, configurable: true,
});

const { AllStak, ReplayRecorder } = await import('../dist/index.mjs');
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));
// The recorder snapshots on the first DOM mutation (the framework's commit);
// in this static jsdom we trigger one to stand in for the app's first render.
const mutate = () => document.body.appendChild(document.createElement('span'));

test('replay is ON by default (zero-config) and opt-out via autoReplay:false', async () => {
  // Zero-config default: replay is on → a replay batch is sent.
  sent.length = 0;
  AllStak.init({ apiKey: 'k', autoCaptureBrowserErrors: false, autoBreadcrumbsFetch: false, autoBreadcrumbsConsole: false, autoBreadcrumbsNavigation: false });
  AllStak.captureException(new Error('boom'));
  mutate(); await wait(25); // first mutation triggers the snapshot
  AllStak.destroy();
  await wait(30);
  assert.ok(sent.find((s) => s.url.endsWith('/ingest/v1/replay')),
    'replay is on by default (zero-config) — a replay batch must be sent');

  // Opt-out: autoReplay:false disables replay.
  sent.length = 0;
  AllStak.init({ apiKey: 'k', autoReplay: false, autoCaptureBrowserErrors: false, autoBreadcrumbsFetch: false, autoBreadcrumbsConsole: false, autoBreadcrumbsNavigation: false });
  AllStak.captureException(new Error('boom2'));
  AllStak.destroy();
  await wait(20);
  assert.equal(sent.find((s) => s.url.endsWith('/ingest/v1/replay')), undefined,
    'autoReplay:false must disable replay');
});

test('replay batch inherits the SDK global release + environment (no double-config)', async () => {
  sent.length = 0;
  AllStak.init({
    apiKey: 'k',
    release: 'shopdesk-admin@9.9.9',
    environment: 'staging',
    autoCaptureBrowserErrors: false, autoBreadcrumbsFetch: false, autoBreadcrumbsConsole: false, autoBreadcrumbsNavigation: false,
  });
  AllStak.captureException(new Error('boom'));
  mutate(); await wait(25);
  AllStak.destroy();
  await wait(30);
  const replay = sent.find((s) => s.url.endsWith('/ingest/v1/replay'));
  assert.ok(replay, 'replay batch must have been sent');
  const body = JSON.parse(replay.init.body);
  assert.equal(body.release, 'shopdesk-admin@9.9.9', 'replay must inherit the global release');
  assert.equal(body.environment, 'staging', 'replay must inherit the global environment');
});

test('initial snapshot masks input values, password fields, and data-allstak-mask elements', async () => {
  sent.length = 0;
  AllStak.init({
    apiKey: 'k',
    autoCaptureBrowserErrors: false,
    autoBreadcrumbsFetch: false,
    autoBreadcrumbsConsole: false,
    autoBreadcrumbsNavigation: false,
    replay: { sampleRate: 1, maskAllInputs: true },
  });
  mutate(); await wait(25); // first mutation triggers the snapshot
  AllStak.destroy();
  await wait(30);
  const replay = sent.find((s) => s.url.endsWith('/ingest/v1/replay'));
  assert.ok(replay, 'replay snapshot must have been sent');
  const body = JSON.parse(replay.init.body);
  const snap = body.events.find((e) => e.k === 'fsnap');
  assert.ok(snap, 'fsnap (full snapshot) event must be present');
  const snapJson = JSON.stringify(snap.data.node);
  // Every input value (including password) must be masked in the serialized tree.
  assert.ok(!/user@example\.com/.test(snapJson),
    'input value must NOT appear in the snapshot when maskAllInputs is true');
  assert.ok(!/hunter2/.test(snapJson),
    'password value must NOT appear in any case');
  assert.ok(!/SECRET-API-KEY-XYZ/.test(snapJson),
    'data-allstak-mask subtree content must be redacted');
});

test('password is ALWAYS masked even with maskAllInputs: false', async () => {
  sent.length = 0;
  AllStak.init({
    apiKey: 'k',
    autoCaptureBrowserErrors: false, autoBreadcrumbsFetch: false, autoBreadcrumbsConsole: false, autoBreadcrumbsNavigation: false,
    replay: { sampleRate: 1, maskAllInputs: false },
  });
  mutate(); await wait(25); // first mutation triggers the snapshot
  AllStak.destroy();
  await wait(30);
  const body = JSON.parse(sent.find((s) => s.url.endsWith('/ingest/v1/replay')).init.body);
  const snap = body.events.find((e) => e.k === 'fsnap');
  assert.ok(!/hunter2/.test(JSON.stringify(snap.data.node)),
    'password must remain masked even when maskAllInputs is disabled');
});

test('user input event records masked value (***), never the raw value', async () => {
  sent.length = 0;
  AllStak.init({
    apiKey: 'k',
    autoCaptureBrowserErrors: false, autoBreadcrumbsFetch: false, autoBreadcrumbsConsole: false, autoBreadcrumbsNavigation: false,
    replay: { sampleRate: 1, maskAllInputs: true },
  });
  const input = document.getElementById('email');
  input.value = 'leaked@nope.com';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  AllStak.destroy();
  await wait(30);
  const body = JSON.parse(sent.find((s) => s.url.endsWith('/ingest/v1/replay')).init.body);
  const inputEv = body.events.find((e) => e.k === 'input');
  assert.ok(inputEv, 'input event must be recorded');
  assert.equal(inputEv.data.value, '***', 'input value must always be masked');
  // Final guarantee: the raw value never appears anywhere in the payload.
  assert.ok(!JSON.stringify(body).includes('leaked@nope.com'),
    'raw input value must NOT appear anywhere in the replay payload');
});
