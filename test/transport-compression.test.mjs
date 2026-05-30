import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { CompressionStream } from 'node:stream/web';

const sent = [];
Object.defineProperty(globalThis, 'CompressionStream', {
  value: CompressionStream,
  writable: true,
  configurable: true,
});
Object.defineProperty(globalThis, 'fetch', {
  value: async (url, init) => {
    sent.push({ url: String(url), init });
    return new Response('{}', { status: 200 });
  },
  writable: true,
  configurable: true,
});

const { AllStak } = await import('../dist/index.mjs');

afterEach(() => {
  sent.length = 0;
  AllStak.destroy();
});

const config = {
  apiKey: 'ask_test_key',
  autoCaptureBrowserErrors: false,
  autoBreadcrumbsFetch: false,
  autoBreadcrumbsConsole: false,
  autoBreadcrumbsClick: false,
  autoBreadcrumbsNavigation: false,
  autoWebVitals: false,
  enableDistributedTracing: false,
  enablePerformance: false,
};

test('transport leaves tiny payloads uncompressed', async () => {
  AllStak.init(config);
  AllStak.captureMessage('tiny');
  await settle();
  await AllStak.flush(1000);

  const req = ingestRequest('/ingest/v1/logs');
  assert.equal(header(req.init.headers, 'Content-Encoding'), undefined);
  assert.equal(typeof req.init.body, 'string');
  assert.match(req.init.body, /tiny/);
  const stats = AllStak.getDiagnostics().transport;
  assert.equal(stats.uncompressed, 1);
  assert.equal(stats.compressed, 0);
});

test('transport gzip-compresses large payloads and counts savings', async () => {
  AllStak.init(config);
  AllStak.captureException(new Error('x'.repeat(50_000)));
  await settle();
  await AllStak.flush(1000);

  const req = ingestRequest('/ingest/v1/errors');
  assert.equal(header(req.init.headers, 'Content-Encoding'), 'gzip');
  assert.match(gunzipSync(bodyBuffer(req.init.body)).toString('utf8'), /x{500}/);
  const stats = AllStak.getDiagnostics().transport;
  assert.equal(stats.compressed, 1);
  assert.equal(stats.uncompressed, 0);
  assert.ok(stats.compressionBytesSaved > 0);
});

function ingestRequest(path) {
  const req = [...sent].reverse().find((item) => item.url.endsWith(path));
  assert.ok(req, `expected an ${path} request`);
  return req;
}

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

function header(headers, name) {
  const value = new Headers(headers).get(name);
  return value ?? undefined;
}

function bodyBuffer(body) {
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (typeof body === 'string') return Buffer.from(body);
  throw new Error(`Unsupported body type: ${Object.prototype.toString.call(body)}`);
}
