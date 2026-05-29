# @allstak/react

AllStak React SDK for error boundaries, global browser errors, logs, HTTP telemetry, Web Vitals, spans, replay metadata, and source maps.

## Install

```bash
npm install @allstak/react
```

## Setup

```tsx
import { AllStakProvider } from '@allstak/react';

export function App() {
  return (
    <AllStakProvider
      apiKey={import.meta.env.VITE_ALLSTAK_API_KEY}
      environment={import.meta.env.MODE}
      release={import.meta.env.VITE_ALLSTAK_RELEASE}
      service="web"
    >
      <AppRoot />
    </AllStakProvider>
  );
}
```

## Manual capture

```tsx
import { AllStak, useAllStak } from '@allstak/react';

AllStak.captureMessage('cart opened', 'info');
AllStak.captureException(new Error('checkout failed'));
AllStak.setUser({ id: 'user_123', email: 'user@example.com' });

function CheckoutButton() {
  const { captureException } = useAllStak();
  return <button onClick={() => captureException(new Error('failed'))}>Pay</button>;
}
```

## React error handler

```tsx
import { createRoot } from 'react-dom/client';
import * as AllStak from '@allstak/react';

createRoot(document.getElementById('root')!, {
  onUncaughtError: AllStak.reactErrorHandler(),
  onCaughtError: AllStak.reactErrorHandler(),
  onRecoverableError: AllStak.reactErrorHandler(),
}).render(<App />);
```

## Vite source maps

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { allstakVitePlugin } from '@allstak/react/vite';

export default defineConfig({
  build: { sourcemap: true },
  plugins: [
    react(),
    allstakVitePlugin({
      release: process.env.ALLSTAK_RELEASE,
      uploadToken: process.env.ALLSTAK_UPLOAD_TOKEN,
    }),
  ],
});
```

## Configuration

| Prop | Description |
| --- | --- |
| `apiKey` | Project API key. |
| `environment` | Deployment environment. |
| `release` | App version or commit SHA. |
| `service` | Logical frontend service name. |
| `user` | Initial user context. |
| `tags` | Tags added to every event. |
| `tracesSampleRate` | Span sample rate from `0` to `1`. |
| `enableDistributedTracing` | Default `true`. Auto-injects the W3C `traceparent` header and emits an `http.client` span per outbound request, with no per-call code. Privacy-safe: never captures bodies/headers. Set `false` to opt out. |
| `enableHttpTracking` | Default `false`. Opt into request/response body + header capture (configured via `httpTracking`) on top of distributed tracing. |
| `tracePropagationTargets` | URLs that should receive the trace headers. Defaults to all non-AllStak HTTP calls. |
| `enableWebVitals` / `autoWebVitals` | Default `true`. Captures CLS, LCP, INP, FCP, and TTFB. Ships by default — no `tracesSampleRate` / `enablePerformance` required. |
| `enablePerformance` | Default behavior: pageload span ships by default (`false` opts out); also gates the long-task / sampled-stack profilers (on when `true` or a numeric `tracesSampleRate` is set). |
| `autoCaptureBrowserErrors` | Captures global browser errors. |
| `autoBreadcrumbsFetch` | Adds fetch breadcrumbs. |
| `captureConsole` | Controls console capture by level. |
| `beforeSend` | Optional hook to modify or drop error events. |

## Privacy

The SDK redacts common sensitive headers, query params, and body fields. Use `beforeSend` and HTTP redaction options for app-specific rules.

## Troubleshooting

- No events: confirm the API key is exposed to the browser build and not empty.
- Source maps missing: use the same `release` in the SDK and upload plugin.
- Browser requests blocked: allow `https://api.allstak.sa` in your content security policy.

## Contributing and Support

- Report bugs with the GitHub bug report template: https://github.com/AllStak/allstak-react/issues/new/choose
- Open pull requests using the checklist in [CONTRIBUTING.md](CONTRIBUTING.md).
- Report security vulnerabilities privately through [SECURITY.md](SECURITY.md).

## License

MIT
