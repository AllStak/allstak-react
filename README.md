# @allstak/react

**Drop-in error tracking for React. One `<AllStakErrorBoundary>`, zero config beyond your API key.**

[![npm version](https://img.shields.io/npm/v/@allstak/react.svg)](https://www.npmjs.com/package/@allstak/react)
[![CI](https://github.com/AllStak/allstak-react/actions/workflows/ci.yml/badge.svg)](https://github.com/AllStak/allstak-react/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Official AllStak SDK for React — error boundary component, hooks, and a profiler HOC on top of the browser SDK.

## Dashboard

View captured events live at [app.allstak.sa](https://app.allstak.sa).

![AllStak dashboard](https://app.allstak.sa/images/dashboard-preview.png)

## Features

- `<AllStakErrorBoundary>` component for render-tree error capture
- `useAllStak()` hook for in-component capture and context
- `withAllStakProfiler` HOC for mount/update timing
- Inherits automatic fetch, console, and window error capture from the core SDK
- Works with React 17, 18, and 19
- Full TypeScript types

## What You Get

Once integrated, every event flows to your AllStak dashboard:

- **Errors** — render-tree crashes, caught hook errors, stack traces with component names
- **Logs** — console warnings and errors as structured breadcrumbs
- **HTTP** — outbound `fetch` timing, status codes, failed calls
- **Performance** — mount and update timing from the profiler HOC
- **Alerts** — email and webhook notifications on regressions

## Installation

```bash
npm install @allstak/react
```

## Quick Start

> Create a project at [app.allstak.sa](https://app.allstak.sa) to get your API key.

```tsx
import { AllStak, AllStakErrorBoundary } from '@allstak/react';

AllStak.init({
  apiKey: import.meta.env.VITE_ALLSTAK_API_KEY,
  environment: 'production',
});

AllStak.captureException(new Error('test: hello from allstak-react'));

export function App() {
  return (
    <AllStakErrorBoundary fallback={<p>Something went wrong.</p>}>
      <Routes />
    </AllStakErrorBoundary>
  );
}
```

Load the app — the test error appears in your dashboard within seconds.

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
export default withAllStakProfiler(Dashboard, { name: 'Dashboard' });
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

## Source maps

Production stack traces are minified — to see real function names and
line numbers in the AllStak dashboard you need to upload the source maps
that your bundler emits. The CLI lives in `@allstak/js/sourcemaps`; you
do **not** need to install `@allstak/js` as a runtime dependency, only
as a `devDependency` for the build step.

### Vite

```bash
npm install -D @allstak/js
```

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { allstakSourcemaps } from '@allstak/js/vite';

export default defineConfig({
  build: { sourcemap: 'hidden' },
  plugins: [
    allstakSourcemaps({
      release: process.env.RELEASE!,
      token: process.env.ALLSTAK_UPLOAD_TOKEN!,
    }),
  ],
});
```

### Webpack / Next / generic

The plugin exists for `@allstak/js/webpack` and `@allstak/js/next`; for
any other bundler call the underlying API after your build:

```ts
import { processBuildOutput } from '@allstak/js/sourcemaps';

await processBuildOutput({
  dir: 'dist',
  release: process.env.RELEASE!,
  token: process.env.ALLSTAK_UPLOAD_TOKEN!,
});
```

This injects a stable `debugId` into every chunk and uploads the matching
`.map`. The runtime resolver in `@allstak/react` reads `globalThis._allstakDebugIds`
to attach the right debug-id to each captured frame, so the symbolicator
picks the correct map even after long-tail caching of bundles.

## Links

- Documentation: https://docs.allstak.sa
- Dashboard: https://app.allstak.sa
- Source: https://github.com/AllStak/allstak-react

## License

MIT © AllStak
