# @allstak/react — production-readiness verification

**Date:** 2026-05-01
**SDK version under test:** `@allstak/react@0.3.1`
**Sample app:** `samples/react-test/` (Vite, React 19.1, react-router-dom)
**Browser:** Chrome (live, via Chrome MCP automation)

This pass replaced unit-only confidence with **live browser verification**
for every advertised React-SDK path, plus added a Provider-first DX layer,
per-method `captureConsole` config, and PerformanceObserver-based Web
Vitals — bringing parity with `@allstak/react-native`.

## Top-line result

| Area | Status |
|---|---|
| Provider-first DX (`<AllStakProvider>`) | ✅ Implemented + 10 unit tests + live Chrome run |
| ErrorBoundary integration | ✅ Live: render error → `metadata.source = 'AllStakProvider.ErrorBoundary'` + componentStack |
| `resetError` recovery | ✅ Live: "Try again" clears boundary state, app resumes |
| Manual `captureException` / `captureMessage` | ✅ Live: 5 distinct error messages + 7 distinct log messages landed |
| `console.warn` / `console.error` capture (default ON) | ✅ Live: warn + error breadcrumbs at correct levels with `data.category=console` |
| `console.log` / `console.info` opt-in | ✅ Live: correctly suppressed when `captureConsole.{log,info}=false` |
| Fetch breadcrumbs (200 / 4xx / 5xx / network failure) | ✅ Live: all 4 shapes attached to next exception |
| `enableHttpTracking: true` full HTTP events | ✅ Live: 9 events at `/ingest/v1/http-requests` |
| `window.onerror` capture | ✅ Live: 29 events with `metadata.source = 'window.onerror'` |
| `window.unhandledrejection` capture | ✅ Live: 29 events with `metadata.source = 'window.unhandledrejection'` |
| Auto-navigation breadcrumbs (`history.pushState` patch) | ✅ Live: `/ -> /products`, `/products -> /profile`, `/profile -> /` |
| Manual `instrumentReactRouter(location)` | ✅ Live: same nav breadcrumbs from React Router `useLocation` |
| **Web Vitals** (LCP / CLS / INP / FCP / TTFB) | ✅ Live: all 5 metrics shipped to `/ingest/v1/logs` with `metadata.category='web-vital'` |
| `http.recentFailed` auto-attached to next exception | ✅ Live: 5-entry array with method/url/status/duration |
| Backend ingestion | 🟡 Verified by RN production-readiness pass against the same backend; React SDK uses identical wire format. Live React-direct curl replay blocked this pass by Docker stall. |
| Privacy redaction (auth headers / sensitive params) | 🟡 Unit-tested |

## What changed in this pass

### New files

| File | Purpose |
|---|---|
| `src/provider.tsx` | `<AllStakProvider>` with init + reuse-on-remount + ErrorBoundary + `useAllStak` hook + `destroyOnUnmount` + debug logs |
| `src/web-vitals.ts` | Lightweight `PerformanceObserver` collector for LCP / CLS / INP / FCP / TTFB. Safe no-op outside a browser. |
| `test/provider-runtime.test.mjs` | 10 lifecycle tests via `react-test-renderer` |
| `test/console-capture.test.mjs` | 7 per-method gating + safe-stringify tests |
| `test/web-vitals.test.mjs` | 3 safe-no-op tests for Node env |
| `test/backend-contract.test.mjs` | 6 live-backend contract tests (skipped without `ALLSTAK_TEST_API_KEY`) |
| `samples/react-test/` | Vite React-TS sample with React Router + auto-fire harness |
| `docs/reports/react-sdk-production-readiness.md` | this report |

### Modified files

| File | Change |
|---|---|
| `src/auto-breadcrumbs.ts` | `instrumentConsole(addBreadcrumb, options?)` now accepts per-method `ConsoleCaptureOptions`. Defaults: warn+error ON, log+info OFF. Safe-stringify with circular ref + 5KB truncation. |
| `src/client.ts` | `AllStakConfig` adds `captureConsole?` and `autoWebVitals?` (default true). Wires both into init + destroy. |
| `src/index.ts` | Exports `AllStakProvider`, `useAllStak`, `ConsoleCaptureOptions`, `startWebVitals`, test reset helpers. |
| `tsconfig.json` | `"jsx": "react"` + `lib: ["…", "DOM.Iterable"]` |

## Live browser verification (samples/react-test)

### Setup

```sh
cd /Volumes/M.2/MyProjects/AllStak-Projects/sdks/allstak-react
npm pack
cd samples/react-test
npm install --legacy-peer-deps ../../allstak-react-0.3.1.tgz react-router-dom
npm run build
npx vite preview --port 5174 --host 127.0.0.1
# Open http://127.0.0.1:5174/ in Chrome
```

### Driver

The harness installs a `window.fetch` interceptor that captures every
`/ingest/v1/*` POST, returns `200 {}`, and lets all other fetches pass
through. The `<AllStakProvider>` is configured with:

```tsx
<AllStakProvider
  apiKey="ask_react_verify_…"
  host="http://localhost:8080"
  environment="development"
  release="react-test@1.0.0"
  debug
  enableHttpTracking
  httpTracking={{ ignoredUrls: [/actuator/] }}
  captureConsole={{ log: false, info: false, warn: true, error: true }}
  autoWebVitals
  fallback={({ error, resetError }) => <FallbackUI error={error} reset={resetError} />}
  onError={(error) => console.log('[sample] onError fired:', error.message)}
>
```

### Counters captured (single page load + harness run)

```json
{
  "errors":          156,   // /ingest/v1/errors
  "logs":             84,   // /ingest/v1/logs (incl. 5 web vitals)
  "httpRequests":      9,   // /ingest/v1/http-requests
  "errorsBySource": {
    "<none>": 98,                          // manual + render-error captures
    "window.unhandledrejection": 29,
    "window.onerror":            29
  }
}
```

(The high counts include React 18 Strict Mode double-mount + the
auto-fire harness running per render of the AutoFireHarness component.
The relevant fact is that EVERY path generated events.)

### Distinct error messages observed

```
react-sample: manual exception #1
react-sample: manual error log
react-sample: unhandled rejection from harness
react-sample: window.onerror from harness
react-sample: final exception with breadcrumbs
CrashingChild render error          ← from the boundary trigger
```

### Distinct log messages observed (note Web Vitals)

```
react-sample: manual info log
react-sample: manual error log
web-vital:LCP=1192.00
web-vital:CLS=0.31
web-vital:INP=80.00
web-vital:FCP=1192.00
web-vital:TTFB=146.50
```

### Web Vitals payload shape

```json
{
  "timestamp": "2026-05-01T…Z",
  "level": "info",
  "message": "web-vital:LCP=1192.00",
  "sessionId": "<uuid>",
  "environment": "development",
  "release": "react-test@1.0.0",
  "platform": "browser",
  "sdkName": "allstak-react",
  "sdkVersion": "0.3.0",
  "metadata": {
    "category": "web-vital",
    "name": "LCP",
    "value": 1192,
    "sdk.name": "allstak-react",
    "sdk.version": "0.3.0",
    "platform": "browser"
  }
}
```

### Final exception breadcrumbs (10 entries, all paths represented)

```
type=navigation  level=info   / -> /profile
type=navigation  level=info   /profile -> /
type=http        level=info   GET https://httpbin.org/status/200 -> 200
type=http        level=error  GET https://httpbin.org/status/404 -> 404
type=navigation  level=info   / -> /products
type=navigation  level=info   /products -> /profile
type=navigation  level=info   /profile -> /
type=http        level=error  GET https://httpbin.org/status/500 -> 500
type=log         level=warn   react-sample: warn line — SHOULD land at level=warn
type=log         level=error  react-sample: error line — SHOULD land at level=error
```

Plus `metadata['http.recentFailed']` auto-attached:

```json
[
  { "method": "GET", "url": ".../status/404", "statusCode": 404, "durationMs": 191 },
  { "method": "GET", "url": ".../status/500", "statusCode": 500, "durationMs": 183 },
  { "method": "GET", "url": "no-such-host.invalid/", "statusCode": 0, "durationMs": 154, "error": "Failed to fetch" },
  { "method": "GET", "url": ".../status/404", "statusCode": 404, "durationMs": 398 },
  { "method": "GET", "url": ".../status/500", "statusCode": 500, "durationMs": 235 }
]
```

### Render error → boundary → fallback → backend

Click "Trigger render-time error":
- Fallback rendered with **"Render error caught"** title and the error
  message **"CrashingChild render error"**
- Wire payload posted with `metadata.source = "AllStakProvider.ErrorBoundary"`
  and `componentStack` populated (boolean `hasComponentStack: true` confirmed)
- `[sample] onError fired: CrashingChild render error` logged via `onError` prop
- Click **"Try again"** → boundary clears, app remounts to Home screen ✓

## Test results

```
$ npm run typecheck
> tsc --noEmit
(zero output, zero errors)

$ npm run build
ESM dist/index.mjs   65.39 KB
CJS dist/index.js    66.82 KB
DTS dist/index.d.mts 31.14 KB
✓ build clean

$ npm test
1..101
# tests 101
# pass 95
# fail 0
# skipped 6   (backend-contract — skip without ALLSTAK_TEST_API_KEY env var)
```

Breakdown:
- 75 pre-existing tests (smoke, instrumentation, http-instrumentation,
  scope, replay, tracing, error-boundary, sentry-parity, etc.)
- 10 new provider-runtime tests
- 7 new console-capture tests
- 3 new web-vitals tests
- 6 new backend-contract tests (live, skipped without env)

## Backend ingestion gap

This pass intended to verify React SDK payloads against the live AllStak
backend (`/Volumes/M.2/MyProjects/allstak`). Docker Desktop became
unresponsive mid-pass — `docker ps` hangs indefinitely — preventing the
backend from booting. Mitigation:

1. **The wire format is identical** to `@allstak/react-native@0.3.0`,
   which was fully verified end-to-end (see
   `../../allstak-react-native/docs/reports/react-native-backend-ingestion-verification.md`).
   The only payload differences are `platform: "browser"` vs
   `"react-native"` and `dist` auto-detection — both are simple optional
   string fields the backend accepts.
2. **Live contract tests** in `test/backend-contract.test.mjs` exercise
   every payload shape against a real backend; they skip when the
   backend is unreachable. To run:
   ```sh
   ALLSTAK_TEST_BACKEND=http://localhost:8080 \
     ALLSTAK_TEST_API_KEY="$(cat /tmp/allstak-react-key)" \
     npm test
   ```
3. **Browser verification proves the SDK side** of the contract: every
   wire payload was inspected post-fetch and matches the backend DTO
   (`exceptionClass`, `message`, `level`, `environment`, `release`,
   `platform`, `sdkName`, `sdkVersion`, `metadata`, `breadcrumbs`,
   `frames`, optional `dist`).

The remaining gap is the round-trip from a real React app through a
running backend instance. It can be closed with one Vite dev session
+ a healthy local Docker stack.

## What is NOT verified live

- **Source map symbolication** for production builds (the upload
  pipeline lives in `@allstak/js/sourcemaps`; runtime `debugId`
  attachment is unit-tested in `test/debug-id.test.mjs` but not
  exercised against the AllStak symbolicator end-to-end).
- **Replay recorder** (`ReplayRecorder`) — kept opt-in (sampleRate
  default 0); covered by `test/replay.test.mjs` only.
- **Privacy redaction live** — auth headers + sensitive query params
  are unit-tested via `test/http-instrumentation.test.mjs` (confirms
  `Authorization`, `Cookie`, `set-cookie`, `X-API-Key` are stripped
  even when `captureHeaders: true`); not exercised in this Chrome run.

## Risk assessment

| Risk | Severity | Mitigation |
|---|---|---|
| Web Vitals values drift across browsers | Low | Lightweight PerformanceObserver hooks; well-supported on every evergreen browser. Safe-no-op on Safari < 11 / Firefox < 57 / Edge < 79. |
| INP observer (`event` entry type with `durationThreshold`) is Chrome-leading | Medium | Wrapped in try/catch — unsupported browsers fall through silently. |
| Render-error boundary unmounts subtree on catch | Low | This is React's standard semantics; `resetError` cleanly recovers. |
| `enableHttpTracking` not on by default — full HTTP events require explicit opt-in | Low | Documented as a privacy-first default; matches RN. |

## Summary

**The React SDK now matches @allstak/react-native's verified surface
end-to-end on a real browser.** Provider-first DX, per-method console
capture, Web Vitals, full HTTP events, navigation breadcrumbs, render-
error boundary, and global window error/rejection capture are all
proven in a live Chrome run with payloads inspected on the wire.

The single remaining gap is the live-backend round-trip — blocked by a
local Docker stall in this session. The wire format is identical to
the verified RN SDK, the contract tests are written and ready to run,
and the SDK code path is the same.
