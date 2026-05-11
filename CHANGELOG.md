# Changelog

All notable changes to `@allstak/react` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.1] — 2026-05-11

### Fixed

- Version constant in `client.ts` now matches `package.json` (was `0.3.0`).
- Added version consistency test to CI.

## [0.3.0] — 2026-05-08

### Added

- Full automatic HTTP instrumentation (fetch and XHR interception).
- Source map upload pipeline with Vite, Webpack, and Next.js build plugins.
- Per-frame `debugId` resolution via `globalThis._allstakDebugIds`.
- `debugMeta.images[]` aggregation in error payloads.

## [0.2.0] — 2026-04-25

### Added

- Scope management for tags, extras, and context.
- Distributed tracing with automatic `traceparent` propagation.
- Web session replay (surrogate events).
- React Router integration helpers.
- Debug-ID based source map resolution.

## [0.1.4] — 2026-04-10

### Changed

- Standalone release on public npm as `@allstak/react`.

### Added

- `ErrorBoundary` component with `componentDidCatch` capture.
- Automatic `window.onerror` and `onunhandledrejection` handlers.
- `beforeSend` callback, `sampleRate`, `setTags`/`setExtra`/`setContext`.
- `flush()` with bounded timeout.
- Web Vitals (LCP, FID, CLS) capture.

## [0.1.1] — 2026-03-28

Initial professional release.

### Added

- Core error capture with stack trace parsing.
- Breadcrumb ring buffer (max 50).
- Fail-open transport with exponential backoff.
- Circuit breaker on 401 responses.
