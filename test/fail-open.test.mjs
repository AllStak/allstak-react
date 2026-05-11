import { test } from 'node:test';
import assert from 'node:assert/strict';

const calls = [];
Object.defineProperty(globalThis, 'fetch', {
  value: async (url, init) => {
    calls.push({ url: String(url), init });
    throw new Error('AllStak DNS failed');
  },
  writable: true,
  configurable: true,
});

globalThis.window = {
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};

const { AllStak } = await import('../dist/index.mjs');

test('SDK capture fails open when AllStak ingest is unavailable', async () => {
  AllStak.init({ apiKey: 'k', release: 'r' });
  assert.doesNotThrow(() => AllStak.captureException(new Error('react fail-open')));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(calls.some((call) => /\/ingest\/v1\/errors$/.test(call.url)));
});
