# Changelog

All notable changes to `@allstak/react` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.9] — 2026-05-20

- Added performance trace sampling metadata, propagation headers, web vitals spans, page-load spans, HTTP spans, long-task spans, and sampled profile chunks.

## [0.3.8] — 2026-05-18

Reissue of 0.3.7 (publish failed at sigstore transparency log step,
tarball never reached the registry). No code differences from 0.3.7.

## [0.3.7] — 2026-05-18 (unpublished)

### Fixed
- `SDK_VERSION` constant is now injected at build time from `package.json`
  via `tsup` `define` (see `tsup.config.ts`), so the runtime-reported SDK
  version cannot drift from the published version. The fallback string in
  `src/client.ts` is only used when the source is consumed directly
  (tests, ts-node) without the build step.
- `sideEffects: false` declared in `package.json` for better tree-shaking.
  All entry points are pure: provider/error boundary/hook/profiler are
  React components and helpers; `AllStak` is a singleton instance that
  only runs work when `init()` / `capture*()` / `instrument*()` is called.

### Docs
- README: documented that `html2canvas` is an optional peer dependency
  and that host apps which enable `captureScreenshotOnError` must install
  it themselves (the SDK dynamic-imports it and silently degrades to
  "no screenshot, error still sent" if missing — fail-open).
- README: added **Troubleshooting** section covering events not arriving,
  source maps not resolving, screenshots not capturing, and TypeScript
  type-resolution issues.
- README: added **Limitations** section (browser-only, screenshot DOM-only
  constraints, 500 KB cap, breadcrumb/event buffer sizes, no Web Worker
  context, Web Vitals browser-support caveats).
- README: updated wizard snippet from `setup` to `init` to match the
  actual CLI command shipped by `@allstak/wizard`.

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
