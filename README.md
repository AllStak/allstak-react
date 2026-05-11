# @allstak/react

**One wrapper. Full error tracking + Web Vitals + breadcrumbs + HTTP. For React 17, 18, and 19.**

[![npm version](https://img.shields.io/npm/v/@allstak/react.svg)](https://www.npmjs.com/package/@allstak/react)
[![CI](https://github.com/AllStak/allstak-react/actions/workflows/ci.yml/badge.svg)](https://github.com/AllStak/allstak-react/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Official AllStak SDK for React — provider component, error boundary, hooks, and Web Vitals on top of a self-contained browser client.

## Dashboard

View captured events live at [app.allstak.sa](https://app.allstak.sa).

![AllStak dashboard](https://app.allstak.sa/images/dashboard-preview.png)

## Features

- **One-wrapper setup** — `<AllStakProvider>` initializes everything
- React error boundary with custom fallback UI + `resetError`
- `window.onerror` + `unhandledrejection` capture
- `console.warn` + `console.error` capture by default; `log`/`info` opt-in
- `fetch` and `XMLHttpRequest` breadcrumbs (200 / 4xx / 5xx / network failure)
- Full HTTP request events with `enableHttpTracking: true` + privacy-first redaction
- Auto navigation breadcrumbs (history.pushState patch + popstate)
- Web Vitals via PerformanceObserver (CLS / LCP / INP / FCP / TTFB)
- React Router + Next.js helpers
- `useAllStak()` hook with stable identity
- Full TypeScript types

## Quick Start

> **Time to first event: under 2 minutes.**
> Create a project at [app.allstak.sa](https://app.allstak.sa) to get your API key.

### 1. Install

```bash
npm install @allstak/react
```

### 2. Wrap your app

```tsx
import { AllStakProvider } from '@allstak/react';

export function App() {
  return (
    <AllStakProvider
      apiKey="ask_live_YOUR_KEY_HERE"
      environment="production"
      release="web@1.0.0"
      debug
    >
      <AppRoot />
    </AllStakProvider>
  );
}
```

### 3. Trigger a test error

```tsx
import { AllStak } from '@allstak/react';

// On a button press or on mount:
AllStak.captureException(new Error('test: hello from allstak-react'));
```

### 4. Check your dashboard

Open [app.allstak.sa](https://app.allstak.sa) — the error appears within seconds.

When `debug` is enabled you'll see `[AllStak] Initialized — session <id>` and `[AllStak] Navigation auto-instrumentation enabled` in your browser console.

`AllStakProvider` handles everything:
- Initializes the SDK
- Wraps your app in an `AllStakErrorBoundary`
- Hooks `window.onerror`, `unhandledrejection`, `console.*`, `fetch`, `history.*`
- Starts Web Vitals collection
- Tags every event with `platform: 'browser'`, sdk name + version

## Automatic Capture Matrix

Status legend:
- ✅ **Auto by default** — works the moment the provider mounts
- ⚙️ **Auto when enabled by config** — set the listed prop
- 🛠 **Manual only** — call the listed function yourself
- 🟡 **Implemented but not browser-verified end-to-end yet**
- ❌ **Not supported yet** (roadmap)

| Capability | Status | Config / API | Wire form |
|---|---|---|---|
| Render errors via `<AllStakProvider>` boundary | ✅ | always-on inside the provider | `POST /ingest/v1/errors` with `metadata.source = 'AllStakProvider.ErrorBoundary'` + `componentStack` |
| `window.onerror` global handler | ✅ | `autoCaptureBrowserErrors` (default `true`) | `POST /ingest/v1/errors` with `metadata.source = 'window.onerror'` |
| `window.unhandledrejection` | ✅ | `autoCaptureBrowserErrors` | `POST /ingest/v1/errors` with `metadata.source = 'window.unhandledrejection'` |
| Manual `AllStak.captureException` | 🛠 | `AllStak.captureException(err, ctx?)` | `POST /ingest/v1/errors` |
| Manual `AllStak.captureMessage` | 🛠 | `AllStak.captureMessage(msg, level)` | `/ingest/v1/logs` (`info`/`warn`); both `errors` + `logs` for `error`/`fatal` |
| `console.warn` / `console.error` | ✅ | `autoBreadcrumbsConsole` (default `true`); per-method via `captureConsole={ warn: true, error: true }` | `breadcrumb` of `type: 'log'`, `level: 'warn'` / `'error'`, `data.category: 'console'` |
| `console.log` / `console.info` | ⚙️ | `captureConsole={{ log: true, info: true }}` (default `false` to avoid spam) | `breadcrumb` of `type: 'log'`, `level: 'info'`, `data.method: 'log'` / `'info'` |
| HTTP `fetch` breadcrumbs (success) | ✅ | `autoBreadcrumbsFetch` (default `true`) | `breadcrumb` of `type: 'http'`, `level: 'info'` |
| HTTP `fetch` 4xx / 5xx breadcrumbs | ✅ | `autoBreadcrumbsFetch` | `breadcrumb` of `type: 'http'`, `level: 'error'` when status ≥ 400 |
| HTTP `fetch` network failure | ✅ | `autoBreadcrumbsFetch` | `breadcrumb` with `data.error`; original error rethrown |
| HTTP `XMLHttpRequest` breadcrumbs | ✅ | `enableHttpTracking` (also covers fetch full events) | breadcrumb same shape |
| Full HTTP request events (method / URL / headers / body) | ⚙️ | `enableHttpTracking: true` (default `false`); `httpTracking: { ... }` for redaction control | `POST /ingest/v1/http-requests` |
| Recent failed HTTP attached to next exception | ⚙️ | `enableHttpTracking: true` | `metadata['http.recentFailed']` (last 5 failed requests) |
| Auto navigation breadcrumbs (pushState / popstate) | ✅ | `autoBreadcrumbsNavigation` (default `true`) | `breadcrumb` of `type: 'navigation'`, `data.from`/`data.to` |
| React Router integration | 🛠 | `instrumentReactRouter(useLocation())` in a `useEffect` | same shape |
| Next.js Pages Router | 🛠 | `instrumentNextRouter(url)` from `Router.events.on('routeChangeComplete')` | same shape |
| **Web Vitals (CLS / LCP / INP / FCP / TTFB)** | ✅ | `autoWebVitals` (default `true`) | `POST /ingest/v1/logs` with `metadata.category = 'web-vital'`, `metadata.name`, `metadata.value` |
| User context | 🛠 | `AllStak.setUser({ id, email })` | `payload.user` |
| Custom tags / extras / contexts | 🛠 | `AllStak.setTag` / `setExtra` / `setContext` | `payload.metadata.<key>` |
| `release`, `environment`, `dist` | 🛠 via init | `<AllStakProvider release="web@1.0.0">` etc. | top-level fields on every payload |
| Source maps | 🛠 build-time | `@allstak/js/sourcemaps` plugin (Vite / Webpack / Next) | injected `debugId` per chunk |
| Session replay (DOM-mutation) | ⚙️ | `replay={ sampleRate: 0.1, maskAllInputs: true }` (default OFF) | `POST /ingest/v1/replay` |
| Offline event queue (in-memory only — see roadmap) | ✅ | n/a; configured via transport (max 100 in-RAM, drops oldest) | retried on next successful send; lost on page navigation |

### Roadmap

- Persistent offline queue (currently RAM-only; lost on page navigation)
- React Query / SWR breadcrumbs
- Vue / Svelte / Solid sister packages

## Verification status

The capabilities marked ✅ in the matrix above were verified live in
Chrome against the SDK's own wire format (see
[docs/reports/react-sdk-production-readiness.md](docs/reports/react-sdk-production-readiness.md)
for command-by-command details). 156 error events, 84 logs (including
5 web vitals), 9 full HTTP events, and a working render-error → fallback
→ resetError → recovery cycle were all observed end-to-end.

The live-backend round-trip is documented in the report. The wire format
is identical to `@allstak/react-native`, which was fully round-trip
verified against the same backend in
`../../allstak-react-native/docs/reports/react-native-backend-ingestion-verification.md`.

## Manual setup (advanced)

If you need full control over initialization order, you can skip
`AllStakProvider` and set up manually:

```ts
import { AllStak, AllStakErrorBoundary } from '@allstak/react';

AllStak.init({
  apiKey: 'ask_live_…',
  environment: 'production',
});

AllStak.captureException(new Error('test'));

export function App() {
  return (
    <AllStakErrorBoundary fallback={<p>Something went wrong.</p>}>
      <Routes />
    </AllStakErrorBoundary>
  );
}
```

## Get Your API Key

1. Sign up at [app.allstak.sa](https://app.allstak.sa)
2. Create a project
3. Copy your API key from **Project Settings → API Keys**
4. Export it as `ALLSTAK_API_KEY` or pass it to `AllStak.init(...)`

## Configuration

| Option | Type | Required | Default | Description |
|---|---|---|---|---|
| `apiKey` | `string` | yes | — | Project API key (`ask_live_…`) |
| `environment` | `string` | no | — | Deployment env |
| `release` | `string` | no | — | Version or git SHA |
| `host` | `string` | no | `https://api.allstak.sa` | Ingest host override |
| `user` | `{ id?, email? }` | no | — | Default user context |
| `tags` | `Record<string,string>` | no | — | Default tags |

## Example Usage

Capture an error inside a component:

```tsx
import { useAllStak } from '@allstak/react';

function CheckoutButton() {
  const allstak = useAllStak();
  return (
    <button onClick={() => {
      try { checkout(); }
      catch (e) { allstak.captureException(e as Error); }
    }}>Pay</button>
  );
}
```

Wrap a component with the profiler:

```tsx
import { withAllStakProfiler } from '@allstak/react';
export default withAllStakProfiler(Dashboard, 'Dashboard');
```

Set user context on login:

```tsx
import { AllStak } from '@allstak/react';
AllStak.setUser({ id: user.id, email: user.email });
```

## HTTP tracking

Setting `enableHttpTracking: true` (off by default) auto-wraps `fetch`,
`XMLHttpRequest`, and `axios` (when installed) so every outbound HTTP
call is recorded as an `http_request` event.

**Privacy defaults are aggressive:**

- request/response bodies are **not** captured
- headers are **not** captured
- `Authorization`, `Cookie`, `Set-Cookie`, `X-API-Key`, `X-Auth-Token`,
  `Proxy-Authorization` are **always** redacted
- query params named `token`, `password`, `api_key`, `apikey`,
  `authorization`, `auth`, `secret`, `access_token`, `refresh_token`,
  `session`, `sessionid`, `jwt` are **always** redacted in the URL

To enable richer capture (only on routes you control):

```ts
AllStak.init({
  apiKey: '...',
  enableHttpTracking: true,
  httpTracking: {
    captureRequestBody: true,
    captureResponseBody: true,
    captureHeaders: true,             // auth headers still hard-redacted
    redactHeaders: ['x-tenant'],
    redactQueryParams: ['custom_id'],
    ignoredUrls: [/health/i, '/metrics'],
    allowedUrls: [],
    maxBodyBytes: 4096,
  },
});

// axios with custom adapter (rare):
import axios from 'axios';
const api = AllStak.instrumentAxios(axios.create({ baseURL: 'https://api.example.com' }));
```

When an exception fires after a failed request, the most recent failed
HTTP requests (last 10) are automatically attached to the error
metadata under `http.recentFailed` for easy triage.

## Production Endpoint

Production endpoint: `https://api.allstak.sa`. Override via `host` for self-hosted installs:

```tsx
AllStak.init({ apiKey: '...', host: 'https://allstak.mycorp.com' });
```

## Source maps — automatic via build plugin

Production stack traces are minified. To see real function names and
line numbers in the AllStak dashboard you need to upload your source
maps. The build-time tooling ships **inside `@allstak/react` itself** —
no extra package to install — and runs **automatically** as part of
your normal build via the Vite / Webpack / Next.js plugin.

The plugins inject a stable `debugId` into every chunk and (when a
token is present) upload the matching `.map` to the AllStak ingest. The
runtime resolver in `@allstak/react` reads `globalThis._allstakDebugIds`
at capture time and attaches the right debug-id to each frame, so the
symbolicator picks the correct map even after long-tail caching of
bundles.

### Vite

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { allstakSourcemaps } from '@allstak/react/vite';

export default defineConfig({
  build: { sourcemap: true },
  plugins: [
    react(),
    allstakSourcemaps({
      release: process.env.ALLSTAK_RELEASE!,
      token: process.env.ALLSTAK_UPLOAD_TOKEN!,
      dist: 'web',
    }),
  ],
});
```

### Webpack

```js
// webpack.config.js
const { AllStakWebpackPlugin } = require('@allstak/react/webpack');

module.exports = {
  devtool: 'source-map',
  plugins: [
    new AllStakWebpackPlugin({
      release: process.env.ALLSTAK_RELEASE,
      token: process.env.ALLSTAK_UPLOAD_TOKEN,
      dist: 'web',
    }),
  ],
};
```

### Next.js

```js
// next.config.js
const { withAllStak } = require('@allstak/react/next');

module.exports = withAllStak(
  {
    release: process.env.ALLSTAK_RELEASE,
    token: process.env.ALLSTAK_UPLOAD_TOKEN,
    dist: 'web',
  },
  {
    reactStrictMode: true,
    // …rest of your Next config…
  }
);
```

The `withAllStak` wrapper sets `productionBrowserSourceMaps: true` for
you and only attaches the plugin to the client bundle (Node-side stack
traces are already symbolicated).

### Other bundlers / programmatic use

```ts
import { processBuildOutput } from '@allstak/react/sourcemaps';

await processBuildOutput({
  dir: 'dist',
  release: process.env.ALLSTAK_RELEASE!,
  token: process.env.ALLSTAK_UPLOAD_TOKEN!,
  dist: 'web',
});
```

### What gets sent

Each map is POSTed as `multipart/form-data` to
`POST /api/v1/artifacts/upload` with these fields:

- `debugId` — UUID injected into the bundle and the map (matching across both)
- `type` — `"sourcemap"` (and `"bundle"` if `uploadBundles: true`)
- `release` — your release identifier (e.g. `web@1.4.2`)
- `dist` — your distribution tag (e.g. `web`)
- `file` — the map content as a Blob

Auth uses `X-AllStak-Upload-Token` (a project-scoped upload token, NOT
the runtime API key). Generate one in **Project Settings → Upload Tokens**.

### Privacy

By default the map is uploaded as-is, which includes embedded
`sourcesContent`. To strip it (smaller payloads, no source code stored
on AllStak's side), set `stripSources: true`:

```ts
allstakSourcemaps({
  release: '…',
  token: '…',
  stripSources: true,
});
```

The backend rejects uploads in privacy-mode projects when the map still
contains `sourcesContent` — the SDK side surfaces a clear error.

## Links

- Documentation: https://docs.allstak.sa
- Dashboard: https://app.allstak.sa
- Source: https://github.com/AllStak/allstak-react

## License

MIT © AllStak
