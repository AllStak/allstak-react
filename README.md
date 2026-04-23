# @allstak/react

**Drop-in error tracking for React. One `<AllStakErrorBoundary>`, zero config beyond your API key.**

[![npm version](https://img.shields.io/npm/v/@allstak/react.svg)](https://www.npmjs.com/package/@allstak/react)
[![CI](https://github.com/allstak-io/allstak-react/actions/workflows/ci.yml/badge.svg)](https://github.com/allstak-io/allstak-react/actions)
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

## Production Endpoint

Production endpoint: `https://api.allstak.sa`. Override via `host` for self-hosted installs:

```tsx
AllStak.init({ apiKey: '...', host: 'https://allstak.mycorp.com' });
```

## Links

- Documentation: https://docs.allstak.sa
- Dashboard: https://app.allstak.sa
- Source: https://github.com/allstak-io/allstak-react

## License

MIT © AllStak
