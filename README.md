# @allstak/react

Full-stack error tracking, Web Vitals, and HTTP observability for React.

[![npm version](https://img.shields.io/npm/v/@allstak/react.svg)](https://www.npmjs.com/package/@allstak/react)
[![CI](https://github.com/AllStak/allstak-react/actions/workflows/ci.yml/badge.svg)](https://github.com/AllStak/allstak-react/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](https://www.typescriptlang.org/)

```bash
npm install @allstak/react
```

```tsx
import { AllStakProvider } from '@allstak/react';

export function App() {
  return (
    <AllStakProvider apiKey="ask_live_YOUR_KEY" environment="production">
      <AppRoot />
    </AllStakProvider>
  );
}
```

Open [app.allstak.sa](https://app.allstak.sa) -- errors appear within seconds.

---

## Why AllStak?

AllStak gives you errors, performance, and HTTP observability in a single SDK with zero configuration. One provider component handles everything: error boundaries, global handlers, Web Vitals, network breadcrumbs, and source map symbolication. Self-hosted and cloud options available.

## Features

- **One-wrapper setup** -- `<AllStakProvider>` initializes everything
- React error boundary with custom fallback UI and `resetError`
- `window.onerror` and `unhandledrejection` capture
- `console.warn` and `console.error` capture (log/info opt-in)
- `fetch` and `XMLHttpRequest` breadcrumbs (success, 4xx/5xx, network failure)
- Full HTTP request tracking with privacy-first redaction
- Navigation breadcrumbs (pushState, popstate)
- Web Vitals via PerformanceObserver (CLS, LCP, INP, FCP, TTFB)
- React Router and Next.js helpers
- `useAllStak()` hook with stable identity
- Full TypeScript types
- React 17, 18, and 19

## Quickstart

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
      apiKey="ask_live_YOUR_KEY"
      environment="production"
      release="web@1.0.0"
    >
      <AppRoot />
    </AllStakProvider>
  );
}
```

### 3. Verify

```tsx
import { AllStak } from '@allstak/react';

AllStak.captureException(new Error('hello from allstak-react'));
```

Check [app.allstak.sa](https://app.allstak.sa) -- the error appears within seconds.

## Sentry-style APIs

AllStak keeps project identity as `apiKey` (`ask_live_...`) instead of `dsn`, while matching the common Sentry React setup patterns.

```tsx
import * as AllStak from '@allstak/react';

AllStak.init({
  apiKey: 'ask_live_YOUR_KEY',
  environment: 'production',
});
```

### React 19 root error hooks

```tsx
import { createRoot } from 'react-dom/client';
import { reactErrorHandler } from '@allstak/react';

const root = createRoot(document.getElementById('root')!, {
  onUncaughtError: reactErrorHandler(),
  onCaughtError: reactErrorHandler(),
  onRecoverableError: reactErrorHandler(),
});

root.render(<App />);
```

### Structured logs

```tsx
import { AllStak } from '@allstak/react';

AllStak.logger.info('User action', { userId: '123' });
AllStak.logger.warn('Slow response', { duration: 5000 });
AllStak.logger.error('Operation failed', { reason: 'timeout' });
```

### Spans

```tsx
AllStak.startSpan({ op: 'test', name: 'Example Frontend Span' }, () => {
  // work to measure
});
```

### Tunneling

Route telemetry through your own server to avoid browser extensions or network policy blocking direct ingest calls:

```tsx
<AllStakProvider apiKey="ask_live_YOUR_KEY" tunnel="/allstak-tunnel">
  <AppRoot />
</AllStakProvider>
```

Your tunnel receives the original target path in `X-AllStak-Target-Path` and the body as `{ path, payload }`. Forward `payload` to `https://api.allstak.sa${path}` with the same `X-AllStak-Key`.

## Error Boundary

`AllStakProvider` wraps your app in an error boundary automatically. For fine-grained control, use `AllStakErrorBoundary` directly:

```tsx
import { AllStakErrorBoundary } from '@allstak/react';

<AllStakErrorBoundary fallback={({ resetError }) => (
  <div>
    <p>Something went wrong.</p>
    <button onClick={resetError}>Try again</button>
  </div>
)}>
  <Dashboard />
</AllStakErrorBoundary>
```

## Hooks

### useAllStak

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

### User context

```tsx
import { AllStak } from '@allstak/react';

AllStak.setUser({ id: user.id, email: user.email });
```

### Profiler

```tsx
import { withAllStakProfiler } from '@allstak/react';

export default withAllStakProfiler(Dashboard, 'Dashboard');
```

## HTTP Tracking

Enable full HTTP tracking with `enableHttpTracking: true` (off by default). This wraps `fetch`, `XMLHttpRequest`, and `axios` automatically.

```tsx
<AllStakProvider
  apiKey="ask_live_YOUR_KEY"
  enableHttpTracking
  httpTracking={{
    captureRequestBody: true,
    captureResponseBody: true,
    captureHeaders: true,
    ignoredUrls: [/health/i, '/metrics'],
    maxBodyBytes: 4096,
  }}
>
```

When an exception fires after a failed request, the most recent failed HTTP calls are automatically attached to the error for easy triage.

## Privacy

AllStak defaults to minimal data collection. HTTP tracking ships with aggressive redaction:

- Request and response bodies are **not** captured by default
- Headers are **not** captured by default
- `Authorization`, `Cookie`, `Set-Cookie`, and token headers are **always** redacted
- Sensitive query parameters (`token`, `password`, `api_key`, `secret`, `jwt`, and others) are **always** redacted from URLs

Additional redaction rules can be configured via `httpTracking.redactHeaders` and `httpTracking.redactQueryParams`.

## Privacy-safe error screenshots

Screenshot capture is **off by default**. Enable it only after confirming it fits your privacy policy:

```bash
npx @allstak/wizard@latest init --integration react --enable-screenshots
```

The wizard installs `html2canvas`, writes explicit `VITE_ALLSTAK_CAPTURE_SCREENSHOTS=true` env vars, and patches `AllStakProvider`. Manual fallback (you must install `html2canvas` yourself — see below):

```bash
npm install html2canvas
```

```tsx
<AllStakProvider
  apiKey="ask_live_YOUR_KEY"
  captureScreenshotOnError
  screenshotRedaction="strict"
/>
```

`html2canvas` is a peer dependency declared `optional`: the SDK loads it via dynamic `import()` only when screenshot capture is enabled, and silently degrades to "no screenshot" if it is missing. **If you enable `captureScreenshotOnError` you must `npm install html2canvas` in your host app**, otherwise no screenshot is captured and the error event still sends (fail-open).

Before upload, the SDK masks `input`, `textarea`, `select`, `contenteditable`, `data-allstak-mask`, `data-sensitive`, and fields whose `type`, `name`, `id`, `autocomplete`, or `aria-label` looks like password, OTP, token, card, phone, email, or ID data. Use `data-allstak-ignore` to exclude a region entirely. `data-allstak-allow` is honored only in `custom` mode and never overrides fields classified as sensitive. Uploads are async, capped at 500 KB, and fail open: the error event still sends if capture fails.

Additional controls:

- `screenshotMaskStyle="solid" | "blur"` controls how masked regions render before capture.
- `maskSelectors`, `ignoreSelectors`, and `allowSelectors` add app-specific CSS selector policy.
- `screenshotSampleRate` samples screenshots independently from event sampling.
- `screenshotOnUnhandledOnly` restricts screenshot capture to browser unhandled errors and ErrorBoundary errors.
- `screenshotUploadTimeoutMs` caps attachment upload latency.

## Configuration

| Option | Type | Default | Description |
|---|---|---|---|
| `apiKey` | `string` | -- | Project API key (required) |
| `environment` | `string` | -- | Deployment environment |
| `release` | `string` | -- | Version or git SHA |
| `host` | `string` | `https://api.allstak.sa` | Ingest endpoint |
| `tunnel` | `string` | -- | Browser-side tunnel endpoint; preserves `apiKey` and sends `{ path, payload }` |
| `user` | `{ id?, email? }` | -- | Default user context |
| `tags` | `Record<string, string>` | -- | Default tags |
| `debug` | `boolean` | `false` | Log SDK activity to console |
| `enableHttpTracking` | `boolean` | `false` | Full HTTP request events |
| `autoWebVitals` | `boolean` | `true` | Collect CLS, LCP, INP, FCP, TTFB |
| `autoCaptureBrowserErrors` | `boolean` | `true` | onerror and unhandledrejection |
| `autoBreadcrumbsConsole` | `boolean` | `true` | console.warn/error breadcrumbs |
| `autoBreadcrumbsFetch` | `boolean` | `true` | Fetch/XHR breadcrumbs |
| `autoBreadcrumbsNavigation` | `boolean` | `true` | Navigation breadcrumbs |
| `captureScreenshotOnError` | `boolean` | `false` | Opt-in redacted screenshot attachment for exceptions |
| `screenshotRedaction` | `'strict' \| 'balanced' \| 'custom'` | `'strict'` | Screenshot redaction mode |
| `screenshotMaskStyle` | `'solid' \| 'blur'` | `'solid'` | How masked regions are rendered before capture |
| `maskSelectors` | `string[]` | -- | Extra CSS selectors to mask |
| `ignoreSelectors` | `string[]` | -- | Extra CSS selectors to exclude from screenshots |
| `allowSelectors` | `string[]` | -- | Custom-mode allowlist; never overrides sensitive fields |
| `screenshotSampleRate` | `number` | `1` | Independent screenshot sampling rate |
| `screenshotOnUnhandledOnly` | `boolean` | `false` | Capture screenshots only for unhandled/ErrorBoundary errors |
| `screenshotUploadTimeoutMs` | `number` | transport default | Attachment upload timeout |
| `beforeScreenshotUpload` | `function` | -- | Last-chance hook to drop or adjust screenshot metadata |

## Source Maps

Upload source maps so production stack traces resolve to real file names and line numbers. The build plugins ship inside `@allstak/react` -- no extra package needed.

### Vite

```ts
// vite.config.ts
import { allstakSourcemaps } from '@allstak/react/vite';

export default defineConfig({
  build: { sourcemap: true },
  plugins: [
    react(),
    allstakSourcemaps({
      release: process.env.ALLSTAK_RELEASE,
      token: process.env.ALLSTAK_UPLOAD_TOKEN,
    }),
  ],
});
```

### Webpack

```js
const { AllStakWebpackPlugin } = require('@allstak/react/webpack');

module.exports = {
  devtool: 'source-map',
  plugins: [
    new AllStakWebpackPlugin({
      release: process.env.ALLSTAK_RELEASE,
      token: process.env.ALLSTAK_UPLOAD_TOKEN,
    }),
  ],
};
```

### Next.js

```js
const { withAllStak } = require('@allstak/react/next');

module.exports = withAllStak(
  {
    release: process.env.ALLSTAK_RELEASE,
    token: process.env.ALLSTAK_UPLOAD_TOKEN,
  },
  { reactStrictMode: true }
);
```

To strip embedded source content from uploaded maps, set `stripSources: true`.

## Troubleshooting

Run `npx @allstak/wizard@latest doctor --integration react` first — it checks the most common failure modes automatically. If you still see issues:

- **Events not appearing in the dashboard.** Confirm the API key is correct and active in [app.allstak.sa](https://app.allstak.sa). Open the browser devtools Network panel and look for `POST` requests to `https://api.allstak.sa/ingest/v1/...` — a non-2xx response (especially `401`/`403`) means the key, project, or environment header is wrong. Set `debug: true` on the provider to see SDK activity in the console. If requests never leave the browser, a content-security-policy or ad-blocker is likely stripping them; whitelist `api.allstak.sa` (or your self-hosted host).
- **Source maps not resolving (stack traces stay minified).** The release in the dashboard must match the release the SDK reports. Set `ALLSTAK_RELEASE` and `release` on the provider to the same string. Confirm `ALLSTAK_UPLOAD_TOKEN` is set in the build environment — the Vite/Webpack/Next plugin logs `skipping upload — no token` and only injects debug IDs when it is missing. Confirm your bundler actually emits `.map` files (`build.sourcemap: true` for Vite, `devtool: 'source-map'` for Webpack). The plugin logs each uploaded bundle/map pair plus the debug ID on `npm run build`.
- **Screenshots not capturing.** `captureScreenshotOnError` must be `true` (it is `false` by default). `html2canvas` must be installed in the host app — the SDK loads it dynamically and silently returns `null` if it is missing. The error event still sends in either case (fail-open). If a screenshot is captured but the dashboard shows nothing, check the dashboard's attachment audit log for upload failures (rate-limited, oversized, encryption-error).
- **TypeScript types missing or wrong.** Use the package's named exports (`AllStakProvider`, `AllStakErrorBoundary`, `useAllStak`, `AllStak`, etc.). Make sure `"moduleResolution": "bundler"` (or `"node16"` / `"nodenext"`) is set in your `tsconfig.json` so the `exports` map resolves correctly. Subpath imports (`@allstak/react/vite`, `/webpack`, `/next`, `/sourcemaps`) ship dedicated `.d.ts` files.

## Limitations

- **Browser-only.** This SDK runs in the browser. It does not capture errors thrown during SSR (`getServerSideProps`, route handlers, server components). For server-side error capture in Next.js, also configure server-side error reporting in your Next.js error handlers or use a server-side AllStak SDK.
- **Screenshots are DOM-only.** `html2canvas` renders from the DOM tree. It cannot capture: cross-origin iframes, tainted `<canvas>` content, WebGL surfaces, `<video>` frames, or native browser dialogs. Foreign-object/SVG rendering quirks apply.
- **Screenshot size cap: 500 KB.** The SDK re-encodes to WebP at decreasing quality, then scales down, then falls back to PNG — always enforced before upload. Very-large viewports may end up heavily downscaled.
- **Breadcrumb buffer: 50.** Older breadcrumbs are dropped when the limit is reached. Adjust via `maxBreadcrumbs` if needed.
- **Event buffer: 100.** The transport layer keeps at most 100 in-flight events; the oldest is dropped when full.
- **No Web Worker context.** `AllStak.init()` and the provider hook into `window`, `document`, and global `fetch`/`XMLHttpRequest`. Errors thrown inside a dedicated Web Worker must be forwarded manually (`worker.onerror` → `AllStak.captureException`).
- **Web Vitals coverage follows the browser.** `INP`, `LCP`, etc. depend on `PerformanceObserver` support; older browsers report only what they support.
- **HTTP request/response bodies are off by default.** Enable explicitly via `httpTracking.captureRequestBody` / `captureResponseBody`. Headers also off by default. See the Privacy section.

## Self-Hosted

Override the default endpoint to point at your own AllStak instance:

```tsx
AllStak.init({ apiKey: '...', host: 'https://allstak.mycorp.com' });
```

## Links

- [Documentation](https://docs.allstak.sa)
- [Dashboard](https://app.allstak.sa)
- [Source](https://github.com/AllStak/allstak-react)

## License

MIT -- AllStak
