# @allstak/react

AllStak React SDK for browser error capture, component error boundaries, breadcrumbs, user context, HTTP metadata, traces, Web Vitals, and source-map release support.

Stability: stable SDK runtime, beta live certification. Live dashboard proof is not claimed until you run a project with real AllStak credentials.

## 1. Automatic Setup With Wizard

Recommended flow:

```bash
npx @allstak/wizard setup --integration react
```

The only value you may need to enter is the AllStak ingest API key. The wizard detects Vite React, CRA-style React, React Router, JavaScript, and TypeScript entry files. If the project is Next.js, use `@allstak/next` instead:

```bash
npx @allstak/wizard setup --integration next
```

## 2. What The Wizard Changes

The wizard:

- Installs `@allstak/react`.
- Writes managed env vars to `.env.local` for Vite or `.env` for non-Vite React.
- Detects `src/main.tsx`, `src/main.jsx`, `src/index.tsx`, or `src/index.jsx`.
- Wraps the existing render tree with `AllStakProvider`.
- Preserves `React.StrictMode`, React Router, and existing providers.
- Enables provider-managed component error boundary capture.
- Wires Vite source-map upload hooks when a Vite config is present.
- Prints the changed files.
- Supports dry-run, repair, idempotent re-runs, and uninstall.

## 3. Verification

After setup:

```bash
npm run build
npx @allstak/wizard doctor --integration react
```

With live credentials, send a test event from your app:

```ts
import { AllStak } from '@allstak/react';

AllStak.captureMessage('AllStak React setup verification', {
  source: 'manual-verification',
});
```

Dashboard appearance is not guaranteed by local tests. Confirm the event in AllStak before claiming live certification.

## 4. Rollback / Uninstall

```bash
npx @allstak/wizard uninstall --integration react
```

Uninstall removes wizard-managed env blocks, source-map config, imports, and provider wrappers. User-owned code outside wizard markers is preserved.

## 5. Manual Setup Fallback

Use manual setup only when the wizard cannot safely patch a custom entry file:

```bash
npm install @allstak/react
```

```tsx
import { AllStakProvider } from '@allstak/react';

export function Root({ children }: { children: React.ReactNode }) {
  return (
    <AllStakProvider
      apiKey={import.meta.env.VITE_ALLSTAK_API_KEY}
      host={import.meta.env.VITE_ALLSTAK_HOST}
      environment={import.meta.env.VITE_ALLSTAK_ENVIRONMENT ?? 'production'}
      release={import.meta.env.VITE_ALLSTAK_RELEASE}
      enableHttpTracking
    >
      {children}
    </AllStakProvider>
  );
}
```

For manual capture:

```ts
import { AllStak } from '@allstak/react';

AllStak.captureException(new Error('checkout failed'));
AllStak.captureMessage('user opened checkout');
AllStak.setUser({ id: 'user_123' });
AllStak.addBreadcrumb({ type: 'navigation', message: 'Checkout' });
```

## 6. Configuration

Provider props include:

| Option | Default | Notes |
| --- | --- | --- |
| `apiKey` | required | Public browser ingest key. |
| `host` | `https://api.allstak.sa` | Override for self-hosted ingest. |
| `environment` | `production` | Release environment tag. |
| `release` | unset | Use app version or commit SHA. |
| `debug` | `false` | Enables SDK diagnostic logs. |
| `enableHttpTracking` | `false` | Captures HTTP metadata with redaction. |
| `autoCaptureBrowserErrors` | `true` | Captures `window.onerror` and `unhandledrejection`. |
| `autoBreadcrumbsFetch` | `true` | Adds fetch/XHR breadcrumbs. |
| `autoBreadcrumbsConsole` | `true` | Captures `warn`/`error`; `log`/`info` stay off by default. |
| `beforeSend` | unset | Last-chance event scrub/drop hook. |

## 7. Privacy / PII / Redaction

Privacy defaults are conservative:

- Authorization, cookie, API key, token, and secret headers are always redacted.
- Sensitive query parameters are redacted.
- Request/response bodies are disabled unless explicitly enabled.
- Console `log` and `info` breadcrumbs are off by default.
- Use `beforeSend` for app-specific PII removal.

Do not send passwords, payment data, national IDs, raw tokens, or raw request/response bodies unless you have verified redaction in your app.

## 8. Source Maps / Releases

For Vite, the wizard wires the AllStak source-map plugin automatically when possible. Manual fallback:

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { allstakSourcemaps } from '@allstak/react/vite';

export default defineConfig({
  plugins: [
    react(),
    allstakSourcemaps({
      release: process.env.VITE_ALLSTAK_RELEASE,
      token: process.env.ALLSTAK_SOURCEMAP_TOKEN,
    }),
  ],
});
```

Use the same `release` value in the provider and source-map upload.

## 9. Troubleshooting

- No events: verify `VITE_ALLSTAK_API_KEY` exists and the provider is present once.
- Duplicate events: rerun `npx @allstak/wizard doctor --integration react` and check for multiple providers.
- Next.js detected: use `@allstak/next`.
- Build fails after setup: run `npx @allstak/wizard uninstall --integration react`, then rerun with `--dry-run` and inspect the planned diff.
- Source maps missing: confirm `ALLSTAK_SOURCEMAP_TOKEN` and matching `release`.

## 10. Limitations

- Live dashboard delivery is not proven by local tests.
- Session replay is privacy-first and limited compared with full DOM replay tools.
- Edge runtimes should use framework-specific packages.
- Stable production launch requires live certification against your dashboard.
