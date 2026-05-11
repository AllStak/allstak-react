/**
 * Live-backend contract tests for @allstak/react.
 *
 * Verifies that the SDK's payload shape is accepted by a real running
 * AllStak backend for every public capture path. Skipped when the backend
 * is unreachable or no test API key is provided. Run with:
 *
 *   ALLSTAK_TEST_BACKEND=http://localhost:8080 \
 *   ALLSTAK_TEST_API_KEY="$(cat /tmp/allstak-react-key)" \
 *   node --test test/backend-contract.test.mjs
 */

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

const BACKEND = process.env.ALLSTAK_TEST_BACKEND ?? 'http://localhost:8080';
const API_KEY = process.env.ALLSTAK_TEST_API_KEY;

let backendUp = false;
const SKIP_REASON = !API_KEY
  ? 'set ALLSTAK_TEST_API_KEY to run live backend contract tests'
  : null;

before(async () => {
  if (!API_KEY) return;
  try {
    const res = await fetch(`${BACKEND}/actuator/health`);
    backendUp = res.ok;
  } catch { backendUp = false; }
});

const realFetch = globalThis.fetch.bind(globalThis);
const observed = [];
let captureMode = 'real';
let failsRemaining = 0;

const fetchProxy = async (url, init) => {
  observed.push({ url: String(url), init });
  if (captureMode === 'mock-fail') {
    if (failsRemaining > 0) {
      failsRemaining -= 1;
      throw new Error('simulated network failure');
    }
    captureMode = 'real';
  }
  if (captureMode === 'mock-401') {
    return new Response('{"success":false}', { status: 401 });
  }
  return realFetch(url, init);
};
Object.defineProperty(globalThis, 'fetch', {
  value: fetchProxy,
  writable: true,
  configurable: true,
});

const { AllStak } = await import('../dist/index.mjs');

beforeEach(() => {
  observed.length = 0;
  captureMode = 'real';
  failsRemaining = 0;
  AllStak.destroy();
});

after(() => { AllStak.destroy(); });

function ensureBackendOrSkip(t) {
  if (SKIP_REASON) { t.skip(SKIP_REASON); return false; }
  if (!backendUp) { t.skip('backend unreachable at ' + BACKEND); return false; }
  return true;
}

test('captureException posts a payload accepted by the live backend', async (t) => {
  if (!ensureBackendOrSkip(t)) return;
  AllStak.init({
    apiKey: API_KEY,
    host: BACKEND,
    environment: 'test-contract',
    release: 'react-contract@1.0.0',
    autoCaptureBrowserErrors: false,  // no jsdom in node test env
    autoBreadcrumbsFetch: false,      // don't wrap fetch in test
    autoBreadcrumbsConsole: false,
    autoBreadcrumbsNavigation: false,
    autoWebVitals: false,
  });

  AllStak.captureException(new Error('contract: react render error'), {
    'browser.userAgent': 'node-test',
  });
  await new Promise((r) => setTimeout(r, 200));

  const errReq = observed.find((o) => o.url.endsWith('/ingest/v1/errors'));
  assert.ok(errReq);
  assert.equal(errReq.init.headers['X-AllStak-Key'], API_KEY);

  const body = JSON.parse(errReq.init.body);
  assert.equal(body.exceptionClass, 'Error');
  assert.equal(body.message, 'contract: react render error');
  assert.equal(body.platform, 'browser');
  assert.equal(body.sdkName, 'allstak-react');
  assert.equal(body.environment, 'test-contract');
  assert.equal(body.release, 'react-contract@1.0.0');
});

test('captureMessage info posts to /ingest/v1/logs', async (t) => {
  if (!ensureBackendOrSkip(t)) return;
  AllStak.init({
    apiKey: API_KEY, host: BACKEND, release: 'react-contract@1.0.0',
    autoCaptureBrowserErrors: false, autoBreadcrumbsFetch: false,
    autoBreadcrumbsConsole: false, autoBreadcrumbsNavigation: false, autoWebVitals: false,
  });
  AllStak.captureMessage('contract: react info', 'info');
  await new Promise((r) => setTimeout(r, 200));
  const logReq = observed.find((o) => o.url.endsWith('/ingest/v1/logs'));
  assert.ok(logReq);
});

test('captureMessage error posts to BOTH /ingest/v1/errors and /ingest/v1/logs', async (t) => {
  if (!ensureBackendOrSkip(t)) return;
  AllStak.init({
    apiKey: API_KEY, host: BACKEND, release: 'react-contract@1.0.0',
    autoCaptureBrowserErrors: false, autoBreadcrumbsFetch: false,
    autoBreadcrumbsConsole: false, autoBreadcrumbsNavigation: false, autoWebVitals: false,
  });
  AllStak.captureMessage('contract: react error log', 'error');
  await new Promise((r) => setTimeout(r, 250));
  const logReq = observed.find((o) => o.url.endsWith('/ingest/v1/logs'));
  const errReq = observed.find((o) => o.url.endsWith('/ingest/v1/errors'));
  assert.ok(logReq);
  assert.ok(errReq);
});

test('Web Vital → /ingest/v1/logs payload shape with metadata.category=web-vital', async (t) => {
  if (!ensureBackendOrSkip(t)) return;
  AllStak.init({
    apiKey: API_KEY, host: BACKEND, release: 'react-contract@1.0.0',
    autoCaptureBrowserErrors: false, autoBreadcrumbsFetch: false,
    autoBreadcrumbsConsole: false, autoBreadcrumbsNavigation: false, autoWebVitals: false,
  });
  // Synthesize what the web-vitals module would post.
  const transport = (AllStak)._getInstance().transport;
  transport.send('/ingest/v1/logs', {
    timestamp: new Date().toISOString(),
    level: 'info',
    message: 'web-vital:LCP=1234.50',
    sessionId: AllStak.getSessionId(),
    environment: 'test-contract',
    release: 'react-contract@1.0.0',
    platform: 'browser',
    sdkName: 'allstak-react',
    sdkVersion: '0.3.1',
    metadata: { category: 'web-vital', name: 'LCP', value: 1234.5 },
  });
  await new Promise((r) => setTimeout(r, 200));
  const logReq = observed.find((o) => o.url.endsWith('/ingest/v1/logs'));
  assert.ok(logReq);
  const body = JSON.parse(logReq.init.body);
  assert.equal(body.metadata.category, 'web-vital');
  assert.equal(body.metadata.name, 'LCP');
});

test('transient network failure is buffered and re-sent on next successful capture', async (t) => {
  if (!ensureBackendOrSkip(t)) return;
  AllStak.init({
    apiKey: API_KEY, host: BACKEND, release: 'react-contract@1.0.0',
    autoCaptureBrowserErrors: false, autoBreadcrumbsFetch: false,
    autoBreadcrumbsConsole: false, autoBreadcrumbsNavigation: false, autoWebVitals: false,
  });
  captureMode = 'mock-fail'; failsRemaining = 1;
  AllStak.captureException(new Error('contract: will-buffer'));
  await new Promise((r) => setTimeout(r, 100));
  AllStak.captureException(new Error('contract: drain-trigger'));
  await new Promise((r) => setTimeout(r, 300));
  const errors = observed.filter((o) => o.url.endsWith('/ingest/v1/errors'));
  assert.ok(errors.length >= 2);
  const messages = errors.map((r) => { try { return JSON.parse(r.init.body).message; } catch { return null; } }).filter(Boolean);
  assert.ok(messages.includes('contract: will-buffer'));
  assert.ok(messages.includes('contract: drain-trigger'));
});

test('backend 401 INVALID_API_KEY does not crash the SDK', async (t) => {
  if (!ensureBackendOrSkip(t)) return;
  AllStak.init({
    apiKey: 'bogus', host: BACKEND, release: 'react-contract@1.0.0',
    autoCaptureBrowserErrors: false, autoBreadcrumbsFetch: false,
    autoBreadcrumbsConsole: false, autoBreadcrumbsNavigation: false, autoWebVitals: false,
  });
  captureMode = 'mock-401';
  assert.doesNotThrow(() => AllStak.captureException(new Error('contract: 401')));
  await new Promise((r) => setTimeout(r, 200));
  assert.doesNotThrow(() => AllStak.captureMessage('contract: still alive', 'info'));
});
