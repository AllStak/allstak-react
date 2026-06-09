/**
 * C1 — HTTPS enforcement for `config.host` and `config.tunnel`.
 *
 * Contract (hardening spec 2026-06-10):
 *   - `https://` anything is accepted.
 *   - `http://` is accepted ONLY for loopback hosts (localhost, 127.0.0.1,
 *     ::1, [::1], 0.0.0.0, *.localhost).
 *   - Any other `http://` (or a non-http(s) scheme) FAILS init with a
 *     TypeError naming the host.
 *   - `allowInsecureHost: true` accepts plaintext http but emits a LOUD
 *     console warning (escape hatch for trusted internal networks).
 *   - Relative tunnel URLs ('/allstak-tunnel') inherit the page scheme and
 *     are accepted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Minimal browser-ish globals so init() doesn't throw / auto-instrument.
const winListeners = new Map();
globalThis.window = {
  addEventListener: (t, h) => {
    if (!winListeners.has(t)) winListeners.set(t, new Set());
    winListeners.get(t).add(h);
  },
  removeEventListener: (t, h) => winListeners.get(t)?.delete(h),
};
globalThis.history = { pushState() {}, replaceState() {} };
Object.defineProperty(globalThis, 'location', {
  value: { pathname: '/test', search: '', host: 'localhost' },
  configurable: true,
  writable: true,
});

const sent = [];
Object.defineProperty(globalThis, 'fetch', {
  value: async (url, init) => { sent.push({ url: String(url), init }); return new Response('{}', { status: 200 }); },
  writable: true,
  configurable: true,
});

const { AllStak, isInsecureIngestUrl } = await import('../dist/index.mjs');

const BASE = {
  apiKey: 'ask_test_key',
  autoCaptureBrowserErrors: false,
  autoBreadcrumbsFetch: false,
  autoBreadcrumbsConsole: false,
  autoBreadcrumbsNavigation: false,
  enableOfflineQueue: false,
  autoReplay: false,
};

const INSECURE_MSG = /insecure ingest host .* rejected\. Use https:\/\/ \(or set allowInsecureHost: true/;

test('init REJECTS a plaintext http:// host with a TypeError', () => {
  assert.throws(
    () => AllStak.init({ ...BASE, host: 'http://ingest.internal.corp:8080' }),
    (err) => err instanceof TypeError && INSECURE_MSG.test(err.message) &&
      err.message.includes('http://ingest.internal.corp:8080'),
    'http:// to a non-loopback host must fail init with a TypeError naming the host',
  );
  // The SDK is left uninitialized — captures error out instead of silently sending.
  assert.throws(() => AllStak.captureException(new Error('x')), /init\(\) must be called/);
});

test('init REJECTS a non-http(s) scheme host', () => {
  assert.throws(() => AllStak.init({ ...BASE, host: 'ws://ingest.example.com' }), TypeError);
  assert.throws(() => AllStak.init({ ...BASE, host: 'ftp://ingest.example.com' }), TypeError);
});

test('init REJECTS a plaintext http:// tunnel with a TypeError', () => {
  assert.throws(
    () => AllStak.init({ ...BASE, tunnel: 'http://collector.internal.corp/t' }),
    (err) => err instanceof TypeError && INSECURE_MSG.test(err.message),
  );
});

test('init ACCEPTS https hosts and relative tunnels', async () => {
  assert.doesNotThrow(() => AllStak.init({ ...BASE })); // default https://api.allstak.sa
  assert.doesNotThrow(() => AllStak.init({ ...BASE, host: 'https://ingest.internal.corp:8443' }));
  assert.doesNotThrow(() => AllStak.init({ ...BASE, tunnel: '/allstak-tunnel' }));
  AllStak.destroy();
});

test('init ACCEPTS plaintext http to loopback hosts (local dev)', () => {
  for (const host of [
    'http://localhost:8080',
    'http://127.0.0.1:8080',
    'http://[::1]:8080',
    'http://0.0.0.0:8080',
    'http://api.localhost',
  ]) {
    assert.doesNotThrow(() => AllStak.init({ ...BASE, host }), `loopback host must be accepted: ${host}`);
  }
  AllStak.destroy();
});

test('allowInsecureHost: true accepts http but emits a LOUD warning, and telemetry flows', async () => {
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    sent.length = 0;
    assert.doesNotThrow(() =>
      AllStak.init({ ...BASE, host: 'http://ingest.internal.corp:8080', allowInsecureHost: true }));
    assert.ok(
      warnings.some((w) => w.includes('allowInsecureHost') && w.includes('http://ingest.internal.corp:8080')),
      'a console warning naming the insecure host must be emitted',
    );
    AllStak.captureException(new Error('over-http'));
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(
      sent.some((s) => s.url.startsWith('http://ingest.internal.corp:8080/ingest/v1/errors')),
      'with the escape hatch, telemetry is delivered to the http host',
    );
    AllStak.destroy();
  } finally {
    console.warn = origWarn;
  }
});

test('isInsecureIngestUrl unit contract', () => {
  assert.equal(isInsecureIngestUrl('https://api.allstak.sa'), false);
  assert.equal(isInsecureIngestUrl('http://localhost:9000'), false);
  assert.equal(isInsecureIngestUrl('http://sub.localhost'), false);
  assert.equal(isInsecureIngestUrl('http://[::1]:9000'), false);
  assert.equal(isInsecureIngestUrl('/relative/tunnel'), false);
  assert.equal(isInsecureIngestUrl('http://10.0.0.5:9000'), true);
  assert.equal(isInsecureIngestUrl('http://ingest.example.com'), true);
  assert.equal(isInsecureIngestUrl('ws://ingest.example.com'), true);
  assert.equal(isInsecureIngestUrl('file:///etc/passwd'), true);
});
