# Changelog

All notable changes to `@allstak/react` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

> Publish status: npm `latest` is still **0.3.8**. Versions **0.3.9** and
> **0.3.10** were tagged but their publishes never reached the registry
> (sigstore transparency-log / OIDC failures), so the registry has no 0.3.7,
> 0.3.9, or 0.3.10. The features below are committed on top of the `v0.3.10`
> tag and are unreleased. The next successful publish should ship at a single
> clean version chosen at the release gate.

### Added

- **Release-health session tracking** (`SessionTracker`). One session per
  app-launch: posts `/ingest/v1/sessions/start` on init and
  `/ingest/v1/sessions/end` on shutdown with a terminal status
  (`ok` / `errored` / `crashed` / `abnormal`) and total duration, enabling
  crash-free session/user metrics. Handled errors escalate the session to
  `errored` and unhandled/fatal errors to `crashed` in-memory, so per-error
  latency is unaffected (only the terminal end POST does extra I/O). Reuses the
  SDK session id, never sampled, fully fail-open. `SessionTracker`,
  `SessionStatus`, and `SessionContext` are exported.
- **Offline / persistent transport queue** (`OfflineStore`). Telemetry that
  cannot be delivered (offline, retries exhausted, circuit open at shutdown) is
  persisted — already PII-scrubbed — and drained through the normal
  retry/backoff/circuit pipeline on the next init, so events survive a process
  restart *and* a network outage. Defaults to `localStorage` with a pluggable
  `OfflineStorage` backend (RN/test injection), bounded by count (50), bytes
  (~1 MB), and age (48h), oldest-dropped-first. Silent no-op when no storage is
  available (SSR / sandboxed iframe / private mode). On by default in the
  browser. `OfflineStore`, `defaultOfflineStorage`, `OfflineStorage`,
  `PersistedEvent`, and `OfflineStoreOptions` are exported.
- **Value-pattern PII scrubbing + `sendDefaultPii`**. Adds value-pattern
  scrubbing on top of the existing key-name redaction: credit-card numbers
  (13–19 digits, Luhn-validated to avoid corrupting order ids) and US SSNs are
  **always** redacted; email addresses and IP addresses are redacted unless the
  new `sendDefaultPii` config flag is `true` (default `false` = Sentry parity).
  Depth- and length-capped, compiled once, fail-open. `scrubString`,
  `scrubDeep`, `scrubEventValues`, `makeValueScrubberProcessor`,
  `ValueScrubOptions`, and `ScrubbablePayload` are exported.
- **Release auto-detection**. Resolves `release` in priority order: explicit
  `config.release` → build-time env vars (`ALLSTAK_RELEASE`, `VERCEL_GIT_*`, …)
  → SDK-version fallback (never empty). Local-git detection is an intentional
  documented no-op in the browser. Runtime releases are auto-registered.
  `parseGitRelease`, `resolveRelease`, `releaseFromEnv`, `isNodeRuntime`, and
  the `GitRunner` type are exported.

### Changed

- **Core Web Vitals shipped as a `web.vital` span.** CLS, LCP, INP, FCP, and
  TTFB are now emitted once on page-hide as a single `web.vital` span carrying
  an uppercase-keyed `measurements` map (the wire shape the backend's web-vitals
  dashboard reads), with double-send guarded across the
  `visibilitychange` + `pagehide` paths.

### Fixed

- **Transport honours the real `Retry-After` header.** A `Retry-After` returned
  on `429` / `503` responses now drives the retry / circuit-breaker open
  duration instead of the locally computed exponential backoff.

## [0.3.10] — 2026-05-22 (tagged, unpublished)

Production-release prep on top of 0.3.9. Tag `v0.3.10` exists but the publish
never reached npm (registry `latest` remained 0.3.8).

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
