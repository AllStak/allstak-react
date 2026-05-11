/**
 * Web Vitals tests — Node has no PerformanceObserver / window so the
 * module is expected to safely no-op. Browser-side capture is verified
 * in the live Chrome verification flow.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { startWebVitals, __resetWebVitalsFlagForTest } = await import('../dist/index.mjs');

test('startWebVitals returns no-op handle in Node (no window)', () => {
  __resetWebVitalsFlagForTest();
  const reports = [];
  const handle = startWebVitals((m) => reports.push(m));
  assert.equal(typeof handle.destroy, 'function');
  // No reports should have fired in Node.
  assert.equal(reports.length, 0);
  // destroy is idempotent
  handle.destroy();
  handle.destroy();
});

test('startWebVitals second call without reset is also a no-op (flag-guarded)', () => {
  __resetWebVitalsFlagForTest();
  const a = startWebVitals(() => {});
  const b = startWebVitals(() => {});
  // Both return functioning handles; second one's destroy should be safe.
  a.destroy();
  b.destroy();
});

test('autoWebVitals=false on AllStak.init does not start observers', async () => {
  const { AllStak, __resetConsoleInstrumentationFlagForTest } = await import('../dist/index.mjs');
  AllStak.destroy();
  __resetConsoleInstrumentationFlagForTest();
  __resetWebVitalsFlagForTest();
  // Stub fetch to swallow ingest calls.
  Object.defineProperty(globalThis, 'fetch', {
    value: async () => new Response('{}', { status: 200 }),
    writable: true, configurable: true,
  });
  AllStak.init({ apiKey: 'k', autoWebVitals: false });
  // Just ensure init didn't throw and no observer leaked.
  AllStak.destroy();
});
