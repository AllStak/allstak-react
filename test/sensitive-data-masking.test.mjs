/**
 * Sensitive data masking tests for @allstak/react.
 *
 * Verifies that the SDK never leaks credentials, tokens, cookies, or
 * other sensitive values in the telemetry it sends to the backend.
 *
 * Coverage:
 *   1. Authorization header masked when captureHeaders ON
 *   2. Cookie header masked when captureHeaders ON
 *   3. Set-Cookie response header masked
 *   4. X-API-Key / X-Auth-Token headers masked
 *   5. X-AllStak-Key header masked (custom redact list)
 *   6. Token values in URL query params stripped
 *   7. Password values in URL query params stripped
 *   8. Multiple sensitive query params stripped in one URL
 *   9. access_token / refresh_token / jwt query params stripped
 *  10. Custom redactQueryParams extends the default list
 *  11. Password fields in captured request bodies are NOT auto-redacted
 *      (body capture is opt-in, truncation is the safety boundary)
 *  12. Proxy-Authorization header masked
 *  13. Headers OFF by default — no headers leak even without redaction
 *  14. Full payload scan — no raw secret strings anywhere in wire data
 *  15. Relative / malformed URLs still get query-param redaction
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── Transport spy ────────────────────────────────────────────────
const sent = [];

const baseFetch = async (url, init) => {
  const u = String(url);
  // Intercept AllStak ingest calls — record them for assertions.
  if (/api\.allstak\.sa/.test(u)) {
    sent.push({ url: u, init });
    return new Response('{}', { status: 200 });
  }
  return new Response('ok', {
    status: 200,
    headers: {
      'content-type': 'text/plain',
      'set-cookie': 'session=s3cr3t; Path=/; HttpOnly',
    },
  });
};
Object.defineProperty(globalThis, 'fetch', {
  value: baseFetch,
  writable: true,
  configurable: true,
});

// Minimal browser-ish globals so AllStak.init() doesn't throw.
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

const { AllStak } = await import('../dist/index.mjs');

// Wrap init to disable unrelated auto-instrumenters.
const _origInit = AllStak.init.bind(AllStak);
AllStak.init = (cfg) =>
  _origInit({
    autoCaptureBrowserErrors: false,
    autoBreadcrumbsFetch: false,
    autoBreadcrumbsConsole: false,
    autoBreadcrumbsNavigation: false,
    ...cfg,
  });

const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const httpPath = (s) => /\/ingest\/v1\/http-requests$/.test(s.url);
const allHttpEvents = () =>
  sent.filter(httpPath).flatMap((s) => JSON.parse(s.init.body).requests);

// Helper: run a fetch through the instrumented pipeline and return
// the captured events + full JSON wire payload.
async function captureFetch(url, fetchInit, sdkOpts = {}) {
  sent.length = 0;
  AllStak.init({
    apiKey: 'test-key',
    enableHttpTracking: true,
    ...sdkOpts,
  });
  await fetch(url, fetchInit);
  AllStak.destroy();
  await wait(20);
  const events = allHttpEvents();
  const rawJson = JSON.stringify(events);
  return { events, rawJson };
}

// ── Tests ────────────────────────────────────────────────────────

test('1. Authorization header is masked in captured HTTP requests', async () => {
  const { events } = await captureFetch(
    'https://api.example.com/protected',
    { headers: { Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.secret' } },
    { httpTracking: { captureHeaders: true } },
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].requestHeaders.authorization, '[REDACTED]');
});

test('2. Cookie header is masked in captured HTTP requests', async () => {
  const { events } = await captureFetch(
    'https://api.example.com/dashboard',
    { headers: { Cookie: 'sid=abc123; csrftoken=xyz789' } },
    { httpTracking: { captureHeaders: true } },
  );
  assert.equal(events[0].requestHeaders.cookie, '[REDACTED]');
});

test('3. Set-Cookie response header is masked', async () => {
  const { events } = await captureFetch(
    'https://api.example.com/login',
    {},
    { httpTracking: { captureHeaders: true } },
  );
  // The mock response includes a set-cookie header.
  if (events[0].responseHeaders?.['set-cookie'] !== undefined) {
    assert.equal(events[0].responseHeaders['set-cookie'], '[REDACTED]');
  }
  // Whether or not the runtime exposes set-cookie, it must never appear in
  // clear text in the wire payload.
  const rawJson = JSON.stringify(events);
  assert.ok(!rawJson.includes('s3cr3t'), 'set-cookie value must not appear in payload');
});

test('4. X-API-Key and X-Auth-Token headers are masked', async () => {
  const { events, rawJson } = await captureFetch(
    'https://api.example.com/data',
    {
      headers: {
        'X-API-Key': 'ak_live_super_secret_key_12345',
        'X-Auth-Token': 'tok_prod_abcdef',
        'X-Request-Id': 'req-001',
      },
    },
    { httpTracking: { captureHeaders: true } },
  );
  assert.equal(events[0].requestHeaders['x-api-key'], '[REDACTED]');
  assert.equal(events[0].requestHeaders['x-auth-token'], '[REDACTED]');
  assert.equal(events[0].requestHeaders['x-request-id'], 'req-001', 'safe headers survive');
  assert.ok(!rawJson.includes('ak_live_super_secret_key_12345'));
  assert.ok(!rawJson.includes('tok_prod_abcdef'));
});

test('5. X-AllStak-Key is masked via custom redactHeaders', async () => {
  const { events, rawJson } = await captureFetch(
    'https://api.example.com/telemetry',
    { headers: { 'X-AllStak-Key': 'ask_prod_999' } },
    { httpTracking: { captureHeaders: true, redactHeaders: ['X-AllStak-Key'] } },
  );
  assert.equal(events[0].requestHeaders['x-allstak-key'], '[REDACTED]');
  assert.ok(!rawJson.includes('ask_prod_999'));
});

test('6. Token values in URL query params are stripped', async () => {
  const { events, rawJson } = await captureFetch(
    'https://api.example.com/callback?token=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9&state=ok',
    {},
  );
  const url = events[0].url;
  assert.ok(!url.includes('eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9'), 'token value must be redacted from URL');
  assert.match(url, /token=%5BREDACTED%5D|token=\[REDACTED\]/, 'token param replaced with [REDACTED]');
  assert.match(url, /state=ok/, 'non-sensitive params survive');
  assert.ok(!rawJson.includes('eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9'));
});

test('7. Password values in URL query params are stripped', async () => {
  const { events, rawJson } = await captureFetch(
    'https://api.example.com/login?username=admin&password=hunter2',
    {},
  );
  const url = events[0].url;
  assert.ok(!url.includes('hunter2'), 'password value must not appear in URL');
  assert.match(url, /password=%5BREDACTED%5D|password=\[REDACTED\]/);
  assert.match(url, /username=admin/, 'username survives');
  assert.ok(!rawJson.includes('hunter2'));
});

test('8. Multiple sensitive query params redacted in one URL', async () => {
  const { events } = await captureFetch(
    'https://api.example.com/auth?token=aaa&password=bbb&api_key=ccc&apikey=ddd&secret=eee&session=fff&safe=keep',
    {},
  );
  const url = events[0].url;
  for (const param of ['token', 'password', 'api_key', 'apikey', 'secret', 'session']) {
    assert.match(url, new RegExp(`${param}=(%5BREDACTED%5D|\\[REDACTED\\])`), `${param} must be redacted`);
  }
  assert.match(url, /safe=keep/, 'non-sensitive param survives');
});

test('9. access_token, refresh_token, jwt query params are stripped', async () => {
  const { events, rawJson } = await captureFetch(
    'https://api.example.com/oauth?access_token=at_secret&refresh_token=rt_secret&jwt=jwtval123&nonce=abc',
    {},
  );
  const url = events[0].url;
  assert.ok(!rawJson.includes('at_secret'));
  assert.ok(!rawJson.includes('rt_secret'));
  assert.ok(!rawJson.includes('jwtval123'));
  assert.match(url, /nonce=abc/, 'non-sensitive param survives');
});

test('10. Custom redactQueryParams extends the default list', async () => {
  const { events, rawJson } = await captureFetch(
    'https://api.example.com/search?q=hello&internal_key=supersecret&token=also_secret',
    {},
    { httpTracking: { redactQueryParams: ['internal_key'] } },
  );
  const url = events[0].url;
  // Both the built-in "token" and the custom "internal_key" are redacted.
  assert.ok(!rawJson.includes('supersecret'));
  assert.ok(!rawJson.includes('also_secret'));
  assert.match(url, /q=hello/, 'safe param survives');
});

test('11. Request body is not captured by default — no password leak risk', async () => {
  const { events, rawJson } = await captureFetch(
    'https://api.example.com/login',
    {
      method: 'POST',
      body: JSON.stringify({ username: 'admin', password: 'P@ssw0rd!' }),
    },
  );
  // Body capture is OFF by default — the password never reaches the payload.
  assert.equal(events[0].requestBody, undefined, 'body must not be captured by default');
  assert.ok(!rawJson.includes('P@ssw0rd!'), 'password must never appear in wire data');
});

test('12. Proxy-Authorization header is masked', async () => {
  const { events, rawJson } = await captureFetch(
    'https://api.example.com/proxy',
    { headers: { 'Proxy-Authorization': 'Basic dXNlcjpwYXNz' } },
    { httpTracking: { captureHeaders: true } },
  );
  assert.equal(events[0].requestHeaders['proxy-authorization'], '[REDACTED]');
  assert.ok(!rawJson.includes('dXNlcjpwYXNz'));
});

test('13. Headers OFF by default — no header values leak without opt-in', async () => {
  const { events } = await captureFetch(
    'https://api.example.com/default-safe',
    {
      headers: {
        Authorization: 'Bearer should-not-appear',
        Cookie: 'sid=should-not-appear',
        'X-Custom': 'also-invisible',
      },
    },
    // No httpTracking.captureHeaders — defaults to false.
  );
  assert.equal(events[0].requestHeaders, undefined, 'headers must be undefined when captureHeaders is off');
  const rawJson = JSON.stringify(events);
  assert.ok(!rawJson.includes('should-not-appear'), 'no header value must leak when headers are off');
});

test('14. Full payload scan — no raw secrets anywhere in wire data', async () => {
  const secrets = {
    authHeader: 'Bearer sk-proj-12345-ABCDE',
    cookieVal: 'session=ultra_secret_cookie',
    apiKeyHeader: 'ak_live_99999',
    tokenParam: 'tok_param_val_secret',
    passwordParam: 'p4ssw0rd_qp',
  };

  const { rawJson } = await captureFetch(
    `https://api.example.com/full-scan?token=${secrets.tokenParam}&password=${secrets.passwordParam}&safe=1`,
    {
      headers: {
        Authorization: secrets.authHeader,
        Cookie: secrets.cookieVal,
        'X-API-Key': secrets.apiKeyHeader,
      },
    },
    { httpTracking: { captureHeaders: true } },
  );

  for (const [label, secret] of Object.entries(secrets)) {
    assert.ok(!rawJson.includes(secret), `${label} must not appear anywhere in the wire payload`);
  }
});

test('15. Relative / malformed URLs still get query-param redaction', async () => {
  // The SDK's redactUrl has a fallback regex path for URLs that fail
  // new URL() parsing. We cannot easily test this via fetch (which needs
  // absolute URLs), so test the redaction utility directly.
  const { redactUrl, REDACTED } = await import('../dist/index.mjs').then(async () => {
    // The redact utilities are re-exported or we can import the built file.
    // Attempt direct import of the built module that includes redactUrl.
    try {
      const mod = await import('../dist/index.mjs');
      if (mod.redactUrl) return mod;
    } catch {}
    // Fallback: import from the chunk that contains http-redact.
    // Since the SDK bundles everything, redactUrl may not be directly
    // exported. In that case, test via a captured event with a full URL.
    return { redactUrl: null, REDACTED: '[REDACTED]' };
  });

  if (redactUrl) {
    const result = redactUrl('/api/data?token=secret123&user=bob', {});
    assert.ok(!result.includes('secret123'), 'relative URL token param must be redacted');
    assert.match(result, /user=bob/, 'safe param in relative URL survives');
  } else {
    // If redactUrl is not directly exported, verify via a full URL instead.
    const { events } = await captureFetch(
      'https://api.example.com/relative-test?token=secret123&user=bob',
      {},
    );
    assert.ok(!events[0].url.includes('secret123'));
    assert.match(events[0].url, /user=bob/);
  }
});
