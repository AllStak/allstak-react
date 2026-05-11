/**
 * Tests for the per-method console capture surface — mirrors the React
 * Native test contract:
 *   - default: warn + error captured, log + info NOT
 *   - opt-in via captureConsole={ log: true, info: true }
 *   - per-method opt-out
 *   - safe stringification (Errors, circular refs, oversized args)
 *   - underlying console fns still receive calls
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const sent = [];
Object.defineProperty(globalThis, 'fetch', {
  value: async (url, init) => {
    if (/api\.allstak\.sa/.test(String(url))) sent.push({ url: String(url), init });
    return new Response('{}', { status: 200 });
  },
  writable: true,
  configurable: true,
});

const {
  AllStak,
  __resetConsoleInstrumentationFlagForTest,
} = await import('../dist/index.mjs');

function fresh(captureConsole) {
  // Silence the underlying console BEFORE init so the SDK's wrappers
  // capture the silenced functions as their `orig`. After this, calling
  // console.warn etc. fires the SDK breadcrumb AND a silent stub.
  console.log = () => {};
  console.info = () => {};
  console.warn = () => {};
  console.error = () => {};
  AllStak.destroy();
  __resetConsoleInstrumentationFlagForTest();
  sent.length = 0;
  AllStak.init({ apiKey: 'k', captureConsole });
}


async function captureAndExtract() {
  AllStak.captureException(new Error('flush-marker'));
  await new Promise((r) => setTimeout(r, 50));
  const body = JSON.parse(sent[0].init.body);
  return body.breadcrumbs ?? [];
}

test('default: warn+error captured, log+info NOT', async () => {
  fresh();
  console.log('debug-line');
  console.info('info-line');
  console.warn('warn-line');
  console.error('error-line');
  const crumbs = await captureAndExtract();
  const messages = crumbs.filter((c) => c.type === 'log').map((c) => c.message);
  assert.ok(messages.includes('warn-line'));
  assert.ok(messages.includes('error-line'));
  assert.ok(!messages.includes('debug-line'));
  assert.ok(!messages.includes('info-line'));
});

test('captureConsole={log:true,info:true}: log + info captured at level=info', async () => {
  fresh({ log: true, info: true });
  console.log('debug-2');
  console.info('info-2');
  const crumbs = await captureAndExtract();
  const logCrumb = crumbs.find((c) => c.message === 'debug-2');
  const infoCrumb = crumbs.find((c) => c.message === 'info-2');
  assert.ok(logCrumb);
  assert.equal(logCrumb.level, 'info');
  assert.equal(logCrumb.data.category, 'console');
  assert.equal(logCrumb.data.method, 'log');
  assert.ok(infoCrumb);
  assert.equal(infoCrumb.data.method, 'info');
});

test('captureConsole={warn:false,error:false}: warn + error suppressed', async () => {
  fresh({ warn: false, error: false });
  console.warn('not');
  console.error('not2');
  const crumbs = await captureAndExtract();
  assert.equal(crumbs.filter((c) => c.type === 'log').length, 0);
});

test('object args are JSON-stringified and circular refs become [Circular]', async () => {
  fresh({ log: true });
  const cyclic = { name: 'root' };
  cyclic.self = cyclic;
  console.log('payload', { id: 42 }, cyclic);
  const crumbs = await captureAndExtract();
  const crumb = crumbs.find((c) => c.data?.method === 'log');
  assert.ok(crumb);
  assert.equal(crumb.data.args[0], 'payload');
  assert.equal(crumb.data.args[1], '{"id":42}');
  assert.match(crumb.data.args[2], /\[Circular\]/);
});

test('Error args keep name + message + stack', async () => {
  fresh({ log: true });
  console.log(new TypeError('whoops'));
  const crumbs = await captureAndExtract();
  const crumb = crumbs.find((c) => c.data?.method === 'log');
  assert.ok(crumb);
  assert.match(crumb.data.args[0], /^TypeError: whoops/);
});

test('args >5KB are truncated with marker', async () => {
  fresh({ log: true });
  console.log('X'.repeat(8000));
  const crumbs = await captureAndExtract();
  const crumb = crumbs.find((c) => c.data?.method === 'log');
  assert.ok(crumb);
  assert.ok(crumb.message.endsWith('…[truncated]'));
});

test('passthrough: underlying console method still called', async () => {
  fresh({ log: true });
  const calls = [];
  const orig = { log: console.log, warn: console.warn };
  console.log = (...a) => calls.push(['log', a.join(' ')]);
  console.warn = (...a) => calls.push(['warn', a.join(' ')]);

  // Re-init so wrappers grab the stubs.
  AllStak.destroy();
  __resetConsoleInstrumentationFlagForTest();
  AllStak.init({ apiKey: 'k', captureConsole: { log: true, warn: true } });

  console.log('a');
  console.warn('b');
  console.log = orig.log;
  console.warn = orig.warn;
  assert.deepEqual(calls, [['log', 'a'], ['warn', 'b']]);
});
