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

## Configuration

| Option | Type | Default | Description |
|---|---|---|---|
| `apiKey` | `string` | -- | Project API key (required) |
| `environment` | `string` | -- | Deployment environment |
| `release` | `string` | -- | Version or git SHA |
| `host` | `string` | `https://api.allstak.sa` | Ingest endpoint |
| `user` | `{ id?, email? }` | -- | Default user context |
| `tags` | `Record<string, string>` | -- | Default tags |
| `debug` | `boolean` | `false` | Log SDK activity to console |
| `enableHttpTracking` | `boolean` | `false` | Full HTTP request events |
| `autoWebVitals` | `boolean` | `true` | Collect CLS, LCP, INP, FCP, TTFB |
| `autoCaptureBrowserErrors` | `boolean` | `true` | onerror and unhandledrejection |
| `autoBreadcrumbsConsole` | `boolean` | `true` | console.warn/error breadcrumbs |
| `autoBreadcrumbsFetch` | `boolean` | `true` | Fetch/XHR breadcrumbs |
| `autoBreadcrumbsNavigation` | `boolean` | `true` | Navigation breadcrumbs |

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
