/**
 * Standalone AllStak client for the browser/React environment. No external
 * AllStak SDK dependencies — only the browser's native `fetch`, AbortController,
 * Date, JSON, and (optionally) `window` for unhandled error auto-capture.
 *
 * Surface mirrors the public AllStak API used by web apps:
 *   init / captureException / captureMessage / addBreadcrumb / clearBreadcrumbs
 *   setUser / setTag / setIdentity / getSessionId
 */

import { HttpTransport, type TransportStats } from './transport';
import { parseStack } from './stack';
import { instrumentFetch, instrumentConsole } from './auto-breadcrumbs';
import { instrumentBrowserNavigation, __setDefaultBreadcrumbForwarder } from './navigation';
import { Scope, mergeScopes } from './scope';
import { TracingModule, Span, type SpanData, type SpanOptions } from './tracing';
import { ReplayRecorder, ReplayOptions } from './replay';
import { resolveDebugId } from './debug-id';
import { HttpRequestModule } from './http-requests';
import type { HttpTrackingOptions } from './http-redact';
import { installHttpInstrumentation } from './http-instrumentation';
import type { ConsoleCaptureOptions } from './auto-breadcrumbs';
import { startWebVitals, WebVitalsHandle } from './web-vitals';
import { resolveRelease } from './release-detect';
import { SessionTracker } from './session';
import { OfflineStore, type OfflineStorage } from './offline-store';
import { scrubEventValues, scrubDeep, scrubString, type ValueScrubOptions } from './pii-scrub';
import {
  blobToBase64,
  capturePrivacySafeScreenshot,
  type ScreenshotCapture,
  type ScreenshotRedactionMode,
} from './screenshot';

interface AsyncScopeStorage {
  getStore(): Scope[] | undefined;
  run<T>(store: Scope[], callback: () => T): T;
}

declare const require: undefined | ((id: string) => { AsyncLocalStorage?: new () => AsyncScopeStorage });

export const INGEST_HOST = 'https://api.allstak.sa';
export const SDK_NAME = 'allstak-react';
// SDK_VERSION is replaced at build time by tsup `define` (see tsup.config.ts)
// using the version from package.json. The fallback string below is only used
// when the source is imported directly (tests, ts-node) without that build step.
// Keep this in sync with package.json on every version bump.
declare const __ALLSTAK_REACT_VERSION__: string;
export const SDK_VERSION: string =
  typeof __ALLSTAK_REACT_VERSION__ !== 'undefined' ? __ALLSTAK_REACT_VERSION__ : '0.5.0';

export { Scope } from './scope';
export { Span, TracingModule } from './tracing';
export type { SpanData, SpanOptions } from './tracing';

const ERRORS_PATH = '/ingest/v1/errors';
const LOGS_PATH = '/ingest/v1/logs';
const PROFILES_PATH = '/ingest/v1/profiles';

const VALID_BREADCRUMB_TYPES = new Set(['http', 'log', 'ui', 'navigation', 'query', 'default']);
const VALID_BREADCRUMB_LEVELS = new Set(['info', 'warn', 'error', 'debug']);
const DEFAULT_MAX_BREADCRUMBS = 50;
const DEFAULT_IGNORE_ERRORS: EventFilterPattern[] = [
  /^Script error\.?$/i,
  /ResizeObserver loop limit exceeded/i,
  /ResizeObserver loop completed with undelivered notifications/i,
  /^Non-Error promise rejection captured with value: (?:null|undefined)$/i,
];

export interface AllStakConfig {
  /** Project API key (`ask_live_…`). Required. */
  apiKey: string;
  /** Optional ingest host override; defaults to {@link INGEST_HOST}. */
  host?: string;
  /**
   * Optional browser-side tunnel endpoint. Keeps the public API compatible
   * with namespace-compatible tunneling while preserving AllStak's `apiKey` identity.
   */
  tunnel?: string;
  environment?: string;
  release?: string;
  /**
   * Auto-detect `release` from env vars and a never-empty SDK-version fallback
   * when it is not set explicitly. Default: `true`.
   *
   * NOTE: allstak-react is browser-only, so RUNTIME local-git detection is not
   * possible here (no `child_process`) — the git step is a documented no-op.
   * The practical effect is: explicit → env (ALLSTAK_RELEASE, VERCEL_GIT_*, …)
   * → SDK version, so `release` is never empty. Set `false` to disable the
   * git probe AND the version fallback (release may then be left empty).
   */
  autoDetectRelease?: boolean;
  /**
   * Register the resolved release with AllStak at SDK init. Default: false in
   * browser SDKs to avoid one registration request per visitor.
   */
  autoRegisterRelease?: boolean;
  /**
   * Release-health "one session per app-launch". When enabled
   * (default `true`), init opens a session (`/ingest/v1/sessions/start`),
   * tracks an in-memory ok/errored/crashed status, and closes the session on
   * graceful shutdown (`/ingest/v1/sessions/end`). Sessions are NEVER sampled
   * and the whole lifecycle is fail-open. Auto-skipped under a unit-test
   * runtime. Set `false` to opt out.
   */
  enableAutoSessionTracking?: boolean;
  /**
   * Persist undelivered telemetry to `localStorage` so it survives a page
   * reload / browser restart AND a network outage. On the next init the SDK
   * drains the store and re-sends each (already PII-scrubbed) event through the
   * normal retry/backoff/circuit-breaker. On tab close, buffered events are
   * flushed via `navigator.sendBeacon`. Bounded (count/bytes/age, oldest
   * dropped); session lifecycle calls are never persisted. Default `true`.
   * Degrades silently to in-memory-only when no usable storage is available.
   */
  enableOfflineQueue?: boolean;
  /**
   * Custom backing storage for the offline queue (RN/test injection). Must
   * expose synchronous `getItem`/`setItem`/`removeItem`. Defaults to the
   * browser `localStorage`. Pass `null` to force the in-memory-only path.
   */
  offlineStorage?: OfflineStorage | null;
  /** localStorage key for the offline queue. Default `allstak.offline.v1`. */
  offlineQueueKey?: string;
  /**
   * Opt into sending personally-identifiable free-text values. Default
   * `false`. This ONLY governs the value-pattern scrubbers
   * that strip PII from free-text values (error messages, breadcrumbs,
   * extras, logs, captured HTTP fields):
   *
   *   - When `false` (default): email addresses and IPv4/IPv6 literals found
   *     in free-text values are replaced with `[REDACTED]`, and any
   *     auto-collected client IP is dropped.
   *   - When `true`: those email/IP value scrubbers are disabled (the host
   *     has explicitly opted into PII) and an auto-collected client IP is
   *     allowed.
   *
   * Credit-card numbers (Luhn-valid) and US SSNs are ALWAYS scrubbed
   * regardless of this flag. The explicit `user` object set via `setUser`
   * (id / email) is NEVER scrubbed by this flag — explicitly-provided user
   * identification ships as before. Key-name based secret redaction
   * (password / token / cookie / api_key …) is unaffected and always on.
   */
  sendDefaultPii?: boolean;
  user?: { id?: string; email?: string };
  tags?: Record<string, string>;
  /** Per-event extra data attached to every capture (override per call via context arg). */
  extras?: Record<string, unknown>;
  /** Named context bags (e.g. `app`, `device`). Each lives under `metadata['context.<name>']`. */
  contexts?: Record<string, Record<string, unknown>>;
  /**
   * Default severity level for events that don't specify their own.
   * Customer-set default severity, mirrors `setLevel`.
   */
  level?: 'fatal' | 'error' | 'warning' | 'info' | 'debug';
  /**
   * Custom grouping fingerprint applied to every event. Customer-set grouping override —
   * `setFingerprint`. Pass an empty array or `null` to clear.
   */
  fingerprint?: string[];
  /** Probability in [0, 1] that any new span is recorded. Default 1. */
  tracesSampleRate?: number;
  /**
   * Master switch for the **expensive** performance samplers — the long-task
   * profiler and the sampled-stack profiler (both additionally gated by
   * {@link profilesSampleRate}/{@link tracesSampleRate}). Default behavior:
   * those samplers turn on when `enablePerformance: true` OR a numeric
   * `tracesSampleRate` is set.
   *
   * The **cheap, privacy-safe** signals — Web Vitals ({@link autoWebVitals})
   * and the one-shot `pageload` span — are NO LONGER gated by this flag; they
   * ship by default in the browser. Set `enablePerformance: false` to opt out
   * of the pageload span (and the samplers); Web Vitals are governed solely by
   * {@link autoWebVitals}/{@link enableWebVitals}.
   */
  enablePerformance?: boolean;
  /** Mutate or drop a performance span before it leaves the SDK. */
  beforeSendSpan?: (span: SpanData) => SpanData | null | undefined;
  /** URLs that should receive distributed tracing headers. Defaults to all non-AllStak HTTP calls. */
  tracePropagationTargets?: (string | RegExp)[];
  /**
   * Auto-instrument outbound HTTP for **distributed tracing**: wrap `fetch`,
   * `XMLHttpRequest`, and (when present) `axios` to (1) inject the W3C
   * `traceparent` header (plus AllStak trace baggage) on calls matching
   * {@link tracePropagationTargets}, and (2) emit a lightweight `http.client`
   * span per request so client→server traces link up. Default: **true** in
   * the browser (mirrors {@link autoBreadcrumbsFetch}).
   *
   * This is the cheap, privacy-safe slice of HTTP instrumentation:
   * request/response **bodies and headers are NEVER captured** by this path
   * regardless of {@link httpTracking} — only method/url/status/duration plus
   * the trace context. URL query params are still redacted. To additionally
   * capture bodies/headers (opt-in, off by default) set
   * {@link enableHttpTracking} `true` and configure {@link httpTracking}.
   *
   * Set `false` to disable header propagation + client spans entirely.
   */
  enableDistributedTracing?: boolean;
  /** Alias for autoWebVitals. Default: true. */
  enableWebVitals?: boolean;
  /** Browser profile/long-task sampling rate. Default follows tracesSampleRate. */
  profilesSampleRate?: number;
  /** Service name attached to every span (defaults to release if unset). */
  service?: string;
  maxBreadcrumbs?: number;
  /** Auto-capture unhandled `error` and `unhandledrejection` on `window`. Default: true */
  autoCaptureBrowserErrors?: boolean;
  /** Wrap `globalThis.fetch` to record HTTP breadcrumbs. Default: true */
  autoBreadcrumbsFetch?: boolean;
  /** Wrap `console.*` methods to record log breadcrumbs. Default: true.
   * Per-method capture is controlled by `captureConsole` (warn + error
   * default on, log + info default off). */
  autoBreadcrumbsConsole?: boolean;
  /**
   * Per-console-method capture flags. Defaults: warn + error captured,
   * log + info NOT captured (to avoid breadcrumb spam from typical app
   * logging). Set `{ log: true, info: true }` to opt-in.
   */
  captureConsole?: ConsoleCaptureOptions;
  /**
   * Auto-capture Web Vitals (CLS, LCP, INP, FCP, TTFB) via the browser's
   * PerformanceObserver. Default: true (in browser contexts). On the
   * standard reporting moment (visibilitychange→hidden / pagehide) the
   * collected metrics ship as a single `web.vital` span whose
   * `measurements` map (`{ LCP, CLS, INP, FCP, TTFB }`) is what the
   * backend surfaces on the web-vitals dashboard. A per-metric
   * `web-vital` log is also sent for backward-compat.
   */
  autoWebVitals?: boolean;
  /** Wrap `history.pushState`/`replaceState` and listen to `popstate` for SPA navigation breadcrumbs. Default: true */
  autoBreadcrumbsNavigation?: boolean;
  /**
   * Experimental session-replay surrogate. **Off by default.** Enable with
   * `replay: { sampleRate: 0.1 }`. Captures sanitized initial DOM snapshot +
   * subsequent mutations + masked input events. See `src/replay.ts` for
   * the full privacy contract.
   */
  replay?: ReplayOptions;
  /**
   * Opt into **full** HTTP capture on top of distributed tracing — enables the
   * request/response body + header capture controlled by {@link httpTracking}.
   * Default: false (bodies/headers stay off).
   *
   * NOTE: the fetch/XHR/axios wrappers + `traceparent` propagation + per-request
   * `http.client` spans are installed by {@link enableDistributedTracing}
   * (default true), so client→server traces work out of the box without this
   * flag. Setting `enableHttpTracking: true` only unlocks the privacy-gated
   * body/header capture; it does NOT re-enable wrappers that
   * `enableDistributedTracing: false` turned off.
   */
  enableHttpTracking?: boolean;
  /**
   * Privacy + capture controls for HTTP instrumentation. Bodies and
   * headers are OFF by default; auth headers and sensitive query params
   * are ALWAYS redacted.
   */
  httpTracking?: HttpTrackingOptions;
  /**
   * Capture a privacy-redacted screenshot when an exception is captured.
   * Off by default. Requires `html2canvas` to be installed by the wizard
   * or app. Capture/upload is async and fail-open.
   */
  captureScreenshotOnError?: boolean;
  /** Redaction policy for screenshots. Default: strict. */
  screenshotRedaction?: ScreenshotRedactionMode;
  /** Maximum encoded screenshot size in bytes. Default: 500 KB. */
  screenshotMaxBytes?: number;
  /** Screenshot upload timeout in milliseconds. Default: transport timeout. */
  screenshotUploadTimeoutMs?: number;
  /** Probability in [0, 1] that a captured error includes a screenshot. Default: 1. */
  screenshotSampleRate?: number;
  /** Only capture screenshots for unhandled/browser or ErrorBoundary events. Default: false. */
  screenshotOnUnhandledOnly?: boolean;
  /** Screenshot mask rendering style. Default: solid. */
  screenshotMaskStyle?: 'solid' | 'blur';
  /** Additional CSS selectors to mask before screenshot rendering. */
  maskSelectors?: string[];
  /** Additional CSS selectors to exclude from screenshot rendering. */
  ignoreSelectors?: string[];
  /** CSS selectors allowed only in custom redaction mode. Sensitive fields are still masked. */
  allowSelectors?: string[];
  /**
   * Last-chance hook before screenshot upload. Return false/null to drop
   * the screenshot. Never put secrets in metadata returned from this hook.
   */
  beforeScreenshotUpload?: (
    screenshot: ScreenshotCapture,
    event: ErrorIngestPayload,
  ) => ScreenshotCapture | false | null | undefined | Promise<ScreenshotCapture | false | null | undefined>;
  /**
   * Probability in [0, 1] that any given error is sent. Default: 1 (no sampling).
   * Applied per event before {@link beforeSend}.
   */
  sampleRate?: number;
  /**
   * Mutate or drop an event before it is sent. Return `null` (or a falsy
   * value) to drop. Sync or async. Errors thrown inside the hook are caught
   * — the event is sent as-is so a buggy hook can't black-hole telemetry.
   */
  beforeSend?: (event: ErrorIngestPayload) =>
    | ErrorIngestPayload | null | undefined
    | Promise<ErrorIngestPayload | null | undefined>;
  /** namespace-compatible event processors. Return null/undefined to drop. */
  eventProcessors?: ErrorEventProcessor[];
  /** Drop errors whose message/class matches any pattern. */
  ignoreErrors?: EventFilterPattern[];
  /** Only send errors whose stack/request URL matches one of these patterns. */
  allowUrls?: EventFilterPattern[];
  /** Drop errors whose stack/request URL matches one of these patterns. */
  denyUrls?: EventFilterPattern[];
  /** Disable built-in browser-noise ignores. Default: false. */
  disableDefaultIgnoreErrors?: boolean;
  /** Drop consecutive duplicate errors/messages. Default: true. */
  dedupe?: boolean;
  /** SDK identity overrides. */
  sdkName?: string;
  sdkVersion?: string;
  platform?: string;
  dist?: string;
  commitSha?: string;
  branch?: string;
}

export interface Breadcrumb {
  timestamp: string;
  type: string;
  message: string;
  level: string;
  data?: Record<string, unknown>;
}

export interface SdkDiagnostics {
  transport: TransportStats;
  breadcrumbs: number;
  sessionId: string;
}

interface PayloadFrame {
  filename?: string;
  absPath?: string;
  function?: string;
  lineno?: number;
  colno?: number;
  inApp?: boolean;
  platform?: string;
  debugId?: string;
}

export interface ErrorIngestPayload {
  eventId?: string;
  exceptionClass: string;
  message: string;
  stackTrace?: string[];
  frames?: PayloadFrame[];
  platform?: string;
  sdkName?: string;
  sdkVersion?: string;
  dist?: string;
  level: string;
  environment?: string;
  release?: string;
  sessionId?: string;
  traceId?: string;
  spanId?: string;
  requestId?: string;
  user?: { id?: string; email?: string };
  metadata?: Record<string, unknown>;
  breadcrumbs?: Breadcrumb[];
  requestContext?: { method?: string; path?: string; host?: string; userAgent?: string };
  fingerprint?: string[];
}

type SeverityLevel = 'fatal' | 'error' | 'warning' | 'info' | 'debug';
type LogLevel = 'fatal' | 'error' | 'warn' | 'warning' | 'info' | 'debug' | 'log';
type EventFilterPattern = string | RegExp;
export type ErrorEventProcessor = (
  event: ErrorIngestPayload,
) => ErrorIngestPayload | null | undefined | Promise<ErrorIngestPayload | null | undefined>;
type SpanContextInput = string | {
  op?: string;
  operation?: string;
  name?: string;
  description?: string;
  tags?: Record<string, string>;
  attributes?: Record<string, string | number | boolean>;
  measurements?: Record<string, number>;
  platform?: string;
  startTimeMillis?: number;
};

function frameToString(f: PayloadFrame): string {
  const fn = f.function && f.function.length > 0 ? f.function : '<anonymous>';
  const file = f.filename || f.absPath || '<anonymous>';
  return `    at ${fn} (${file}:${f.lineno ?? 0}:${f.colno ?? 0})`;
}

function generateId(): string {
  const hex = (n: number) => Math.floor(Math.random() * n).toString(16).padStart(1, '0');
  const seg = (len: number) => Array.from({ length: len }, () => hex(16)).join('');
  return `${seg(8)}-${seg(4)}-4${seg(3)}-${(8 + Math.floor(Math.random() * 4)).toString(16)}${seg(3)}-${seg(12)}`;
}

function createAsyncScopeStorage(): AsyncScopeStorage | null {
  const proc = (globalThis as any).process;
  if (!proc?.versions?.node) return null;
  try {
    const fromProcess = proc.getBuiltinModule?.('node:async_hooks')?.AsyncLocalStorage;
    if (fromProcess) return new fromProcess();
    const req = typeof require === 'function' ? require : undefined;
    const AsyncLocalStorage = req?.('node:async_hooks').AsyncLocalStorage;
    return AsyncLocalStorage ? new AsyncLocalStorage() : null;
  } catch {
    return null;
  }
}

function browserRequestContext(): ErrorIngestPayload['requestContext'] {
  if (typeof window === 'undefined' || typeof location === 'undefined') return undefined;
  return {
    method: 'GET',
    path: location.pathname || '/',
    host: location.host || '',
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
  };
}

/**
 * Heuristic "are we under a unit-test runner?" guard. Mirrors the Java SDK's
 * `isLikelyTestRuntime` so unit tests don't open release-health sessions
 * against the live `/ingest/v1/sessions/*` endpoints. Browser-only, so the
 * signal is `process.env` (`NODE_ENV=test`, Jest/Vitest markers) plus Node's
 * own `--test` runner flag. Returns false in real browsers (no `process`).
 */
/**
 * Test seam: when set true, {@link isLikelyTestRuntime} returns false so the
 * session-tracking wiring can be exercised under the unit-test runner. Mirrors
 * the Java SDK's "visible for testing" override. Not part of the public API.
 * @internal
 */
let __forceSessionTrackingForTest = false;
/** @internal — flip the test-runtime guard for session-tracking tests. */
export function __setForceSessionTrackingForTest(force: boolean): void {
  __forceSessionTrackingForTest = force;
}

function isLikelyTestRuntime(): boolean {
  if (__forceSessionTrackingForTest) return false;
  try {
    const proc = (globalThis as any).process;
    if (!proc) return false;
    const env = proc.env ?? {};
    if (env.NODE_ENV === 'test') return true;
    if (env.JEST_WORKER_ID !== undefined) return true;
    if (env.VITEST !== undefined || env.VITEST_WORKER_ID !== undefined) return true;
    // Node's built-in test runner sets this; also covers `node --test`.
    if (Array.isArray(proc.execArgv) && proc.execArgv.some((a: string) => a === '--test' || a.startsWith('--test'))) {
      return true;
    }
    if (proc.env?.NODE_TEST_CONTEXT !== undefined) return true;
  } catch {
    /* ignore — never break init */
  }
  return false;
}

function registerRuntimeRelease(config: AllStakConfig, transport: HttpTransport): void {
  if (config.autoRegisterRelease !== true || !config.release) return;
  void transport.send('/ingest/v1/releases', {
    version: config.release,
    environment: config.environment,
    commitSha: config.commitSha,
    branch: config.branch,
    author: null,
    message: null,
  });
}

export class AllStakClient {
  private transport: HttpTransport;
  private config: AllStakConfig;
  private sessionId: string;
  private breadcrumbs: Breadcrumb[] = [];
  private maxBreadcrumbs: number;
  private globalScopeStack: Scope[] = [];
  private asyncScopeStorage: AsyncScopeStorage | null = createAsyncScopeStorage();
  private tracing: TracingModule;
  private replay: ReplayRecorder | null = null;
  private httpRequests: HttpRequestModule | null = null;
  private _instrumentAxios: ((axios: any) => any) | null = null;
  private onErrorHandler: ((ev: ErrorEvent) => void) | null = null;
  private onRejectionHandler: ((ev: PromiseRejectionEvent) => void) | null = null;
  private webVitals: WebVitalsHandle | null = null;
  private profileTimer: ReturnType<typeof setInterval> | null = null;
  private eventProcessors: ErrorEventProcessor[] = [];
  private lastEventKey: string | null = null;
  private sessionTracker: SessionTracker | null = null;
  private offlineStore: OfflineStore | null = null;
  private onPageHideHandler: (() => void) | null = null;
  private onVisibilityHandler: (() => void) | null = null;

  constructor(config: AllStakConfig) {
    if (!config.apiKey) throw new Error('AllStak: config.apiKey is required');
    this.config = { ...config };
    if (!this.config.environment) this.config.environment = 'production';
    if (!this.config.sdkName) this.config.sdkName = SDK_NAME;
    if (!this.config.sdkVersion) this.config.sdkVersion = SDK_VERSION;
    if (!this.config.platform) this.config.platform = 'browser';
    // Resolve release: explicit → env vars → local git (browser no-op) →
    // SDK-version fallback. Gated by autoDetectRelease (default true).
    this.config.release = resolveRelease(
      this.config.release,
      this.config.sdkVersion ?? SDK_VERSION,
      this.config.autoDetectRelease !== false,
    );
    this.sessionId = generateId();
    this.maxBreadcrumbs = config.maxBreadcrumbs ?? DEFAULT_MAX_BREADCRUMBS;
    const baseUrl = (config.host ?? INGEST_HOST).replace(/\/$/, '');
    // Offline/persistent queue: survive a reload/restart + network outage by
    // persisting undelivered (already PII-scrubbed) telemetry. Default ON;
    // degrades silently to in-memory-only when storage is unavailable.
    this.offlineStore = this.createOfflineStore();
    this.transport = new HttpTransport(baseUrl, config.apiKey, {
      tunnel: config.tunnel,
      ...(this.offlineStore ? { offlineStore: this.offlineStore } : {}),
    });
    // Replay anything persisted on a previous launch. Async + fail-open.
    if (this.offlineStore) {
      try { this.transport.drain(); } catch { /* never break init */ }
    }
    registerRuntimeRelease(this.config, this.transport);
    this.startSession();
    // Page/tab close hooks: end the session AND beacon-flush buffered telemetry
    // so nothing is lost on unload. Installed whenever either feature is active.
    this.installUnloadHooks();
    this.tracing = new TracingModule(this.transport, {
      service: config.service ?? config.release ?? '',
      environment: this.config.environment ?? 'production',
      release: this.config.release,
      sessionId: this.sessionId,
      platform: this.config.platform,
      tracesSampleRate: config.tracesSampleRate,
      beforeSendSpan: config.beforeSendSpan,
    });
    // The EXPENSIVE samplers (long-task observer + sampled-stack profiler)
    // stay opt-in: on when `enablePerformance: true` OR a numeric
    // `tracesSampleRate` is set. The CHEAP pageload span + Web Vitals are
    // decoupled below so a bare `<AllStakProvider apiKey=… />` still ships
    // privacy-safe performance data.
    const expensiveProfilersEnabled = this.config.enablePerformance === true ||
      (this.config.enablePerformance !== false && typeof this.config.tracesSampleRate === 'number');
    // Pageload span is cheap + privacy-safe (one navigation-timing span per
    // launch). Ship it by default; only `enablePerformance: false` opts out.
    const pageloadSpanEnabled = this.config.enablePerformance !== false;
    if (pageloadSpanEnabled) {
      this.capturePageLoadSpan();
    }
    if (expensiveProfilersEnabled) {
      this.installLongTaskProfiler();
      this.installSampledStackProfiler();
    }

    if (config.autoCaptureBrowserErrors !== false && typeof window !== 'undefined') {
      this.installBrowserHandlers();
    }
    // Route auto-breadcrumbs through the current singleton so that
    // re-init (which destroys this instance) doesn't leave the wrappers
    // dispatching into a dead client.
    if (config.autoBreadcrumbsFetch !== false) {
      try { instrumentFetch(safeAddBreadcrumb, baseUrl); }
      catch { /* ignore — never break init */ }
    }
    if (config.autoBreadcrumbsConsole !== false) {
      try { instrumentConsole(safeAddBreadcrumb, config.captureConsole); }
      catch { /* ignore */ }
    }
    if (config.autoBreadcrumbsNavigation !== false) {
      try { instrumentBrowserNavigation(safeAddBreadcrumb); }
      catch { /* ignore */ }
    }
    // Web Vitals are cheap + privacy-safe (no user content — just CLS/LCP/INP/
    // FCP/TTFB numbers) and are now governed SOLELY by `autoWebVitals` /
    // `enableWebVitals` (both default true). Previously this was also gated by
    // the performance master switch, which made the documented `autoWebVitals:
    // true` default a silent no-op unless `tracesSampleRate`/`enablePerformance`
    // was also set.
    if (config.autoWebVitals !== false && config.enableWebVitals !== false) {
      try {
        // Core Web Vitals are read off the SPAN `measurements` column by the
        // backend (PerformanceRepository classifies op='web.vital' into the
        // "web" performance category). We emit ALL collected metrics as a
        // single `web.vital` span with the uppercase-keyed measurements map
        // — that is how vitals reach the web-vitals dashboard. Per-metric
        // logs are kept for backward-compat with the older log channel.
        const send = (metrics: Record<string, number>) => {
          const names = Object.keys(metrics);
          if (names.length === 0) return;
          const route = typeof location !== 'undefined' ? location.pathname || '/' : '/';
          const span = this.tracing.startSpan('web.vital', {
            op: 'web.vital',
            platform: 'web',
            description: 'Core Web Vitals',
            measurements: { ...metrics },
            attributes: {
              metrics: names.join(','),
              route,
              session_id: this.sessionId,
            },
            tags: { route },
          });
          span.finish('ok');
          for (const name of names) {
            const value = metrics[name];
            this.transport.send(LOGS_PATH, {
              timestamp: new Date().toISOString(),
              level: 'info',
              message: `web-vital:${name}=${value.toFixed(2)}`,
              sessionId: this.sessionId,
              environment: this.config.environment,
              release: this.config.release,
              platform: this.config.platform,
              sdkName: this.config.sdkName,
              sdkVersion: this.config.sdkVersion,
              metadata: {
                category: 'web-vital',
                name,
                value,
                ...this.releaseTags(),
              },
            });
          }
        };
        this.webVitals = startWebVitals(send);
      } catch { /* never break init */ }
    }
    if (config.replay && (config.replay.enabled ?? true)) {
      try {
        this.replay = new ReplayRecorder(this.transport, this.sessionId, safeAddBreadcrumb, config.replay);
        this.replay.start();
      } catch { /* never break init */ }
    }
    // HTTP instrumentation installs the fetch/XHR/axios wrappers that do TWO
    // things: (1) inject the W3C `traceparent` header + AllStak trace baggage
    // and emit a per-request `http.client` span (distributed tracing), and
    // (2) — only when opted in — capture request/response bodies + headers.
    //
    // Distributed tracing is DEFAULT-ON in the browser (mirrors
    // autoBreadcrumbsFetch); full body/header capture stays opt-in behind
    // `enableHttpTracking`. We install the module when EITHER is requested.
    const fullHttpCapture = config.enableHttpTracking === true;
    const distributedTracing = config.enableDistributedTracing !== false;
    if (fullHttpCapture || distributedTracing) {
      try {
        this.httpRequests = new HttpRequestModule(this.transport);
        this.httpRequests.setValueScrubOptions(this.valueScrubOptions());
        this.httpRequests.setDefaults({
          environment: this.config.environment,
          release: this.config.release,
          dist: this.config.dist,
          platform: this.config.platform,
          sdkName: this.config.sdkName,
          sdkVersion: this.config.sdkVersion,
        });
        // When only distributed tracing is on (no full capture), FORCE
        // body/header capture off regardless of any `httpTracking` opts so the
        // default-on path can never exfiltrate payloads. Query-param redaction
        // + ignored/allowed-URL filtering still apply.
        const httpOptions: HttpTrackingOptions = fullHttpCapture
          ? (config.httpTracking ?? {})
          : {
              ...(config.httpTracking ?? {}),
              captureRequestBody: false,
              captureResponseBody: false,
              captureHeaders: false,
            };
        const { instrumentAxios } = installHttpInstrumentation(
          this.httpRequests,
          httpOptions,
          baseUrl,
          {
            tracing: this.tracing,
            release: this.config.release,
            dist: this.config.dist,
            platform: this.config.platform,
            environment: this.config.environment,
            sessionId: this.sessionId,
            tracePropagationTargets: config.tracePropagationTargets,
          },
        );
        this._instrumentAxios = instrumentAxios;
      } catch { /* never break init */ }
    }
  }

  /** Manually instrument an axios instance. No-op when HTTP tracking is off. */
  instrumentAxios<T = any>(axios: T): T {
    if (!this._instrumentAxios) return axios;
    return this._instrumentAxios(axios) as T;
  }

  /** Snapshot of recent failed HTTP requests for error-linking. */
  getRecentFailedHttp() {
    return this.httpRequests?.getRecentFailed() ?? [];
  }

  captureException(error: Error, context?: Record<string, unknown>): void {
    if (!this.passesSampleRate()) return;
    const frames = parseStack(error.stack).map((f) => ({
      ...f,
      platform: this.config.platform,
      debugId: resolveDebugId(f.filename),
    }));
    const stackTrace = frames.length > 0 ? frames.map(frameToString) : undefined;
    const currentBreadcrumbs = this.breadcrumbs.length > 0 ? [...this.breadcrumbs] : undefined;
    this.breadcrumbs = [];

    // Prefer an explicit `error.name` override; fall back to constructor
    // name then to 'Error'. `new Error()` always has constructor.name ===
    // 'Error', so an explicit name set after construction would otherwise
    // be silently dropped.
    const exceptionClass =
      (error.name && error.name !== 'Error' ? error.name : undefined) ||
      error.constructor?.name ||
      'Error';
    const eff = this.effective();
    const traceContext: Record<string, unknown> = {};
    const traceId = this.tracing.getTraceId();
    if (traceId) traceContext.traceId = traceId;
    const spanId = this.tracing.getCurrentSpanId();
    if (spanId) traceContext.spanId = spanId;
    const recentFailed = this.httpRequests?.getRecentFailed() ?? [];
    if (recentFailed.length > 0) {
      traceContext['http.recentFailed'] = recentFailed.map((r) => ({
        method: r.method, url: r.url, statusCode: r.statusCode,
        durationMs: r.durationMs, error: r.error,
      }));
    }

    const payload: ErrorIngestPayload = {
      eventId: generateId(),
      exceptionClass,
      message: error.message,
      stackTrace,
      frames: frames.length > 0 ? frames : undefined,
      platform: this.config.platform,
      sdkName: this.config.sdkName,
      sdkVersion: this.config.sdkVersion,
      dist: this.config.dist,
      level: eff.level ?? 'error',
      environment: this.config.environment,
      release: this.config.release,
      sessionId: this.sessionId,
      traceId,
      spanId: spanId ?? undefined,
      requestId: recentFailed[recentFailed.length - 1]?.requestId,
      user: eff.user,
      metadata: { ...this.buildMetadata(context), ...traceContext },
      breadcrumbs: currentBreadcrumbs,
      requestContext: browserRequestContext(),
      fingerprint: eff.fingerprint,
    };
    this.recordSessionStatusForEvent(payload, context);
    void this.sendErrorThroughBeforeSend(payload);
  }

  /**
   * Escalate the release-health session for a captured exception. An UNHANDLED
   * / fatal event (`level: 'fatal'`, or an auto-captured `window.onerror` /
   * `unhandledrejection` / React error-boundary / root-error-handler source)
   * crashes the session; any other captured exception marks it errored. No
   * I/O — the terminal `/sessions/end` POST carries the final status. Mirrors
   * the Java SessionTracker `recordCrash` / `recordError` semantics.
   */
  private recordSessionStatusForEvent(
    payload: ErrorIngestPayload,
    context?: Record<string, unknown>,
  ): void {
    const tracker = this.sessionTracker;
    if (!tracker) return;
    try {
      const source = context?.source;
      const isUnhandled =
        payload.level === 'fatal' ||
        source === 'window.onerror' ||
        source === 'window.unhandledrejection' ||
        source === 'react-error-boundary' ||
        source === 'react.root.error-handler';
      if (isUnhandled) tracker.recordCrash();
      else tracker.recordError();
    } catch { /* never break capture */ }
  }

  /** Start a new span — auto-parented to any currently-active span. */
  startSpan(operation: SpanContextInput, options?: SpanOptions): Span;
  startSpan<T>(
    operation: SpanContextInput,
    callback: (span: Span) => T,
  ): T;
  startSpan<T>(
    operation: SpanContextInput,
    optionsOrCallback?: SpanOptions | ((span: Span) => T),
  ): Span | T {
    const normalized = normalizeSpanInput(
      operation,
      typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback,
    );
    const span = this.tracing.startSpan(normalized.operation, {
      description: normalized.description,
      tags: normalized.tags,
      op: normalized.op,
      platform: normalized.platform,
      measurements: normalized.measurements,
      attributes: normalized.attributes,
      startTimeMillis: normalized.startTimeMillis,
    });
    if (typeof optionsOrCallback !== 'function') return span;
    try {
      const result = optionsOrCallback(span);
      if (result && typeof (result as any).then === 'function') {
        return (result as any).then(
          (value: any) => { span.finish('ok'); return value; },
          (error: any) => { span.finish('error'); throw error; },
        );
      }
      span.finish('ok');
      return result;
    } catch (error) {
      span.finish('error');
      throw error;
    }
  }
  /** Get (and lazily create) the active trace ID. */
  getTraceId(): string { return this.tracing.getTraceId(); }
  /** Override the active trace ID, e.g. from an inbound request header. */
  setTraceId(traceId: string): void { this.tracing.setTraceId(traceId); }
  /** ID of the currently-active span, or null. */
  getCurrentSpanId(): string | null { return this.tracing.getCurrentSpanId(); }
  /** Reset the trace ID and the active span stack. */
  resetTrace(): void { this.tracing.resetTrace(); }

  captureMessage(
    message: string,
    level: SeverityLevel = 'info',
    options: { as?: 'log' | 'error' | 'both' } = {},
  ): void {
    const as = options.as ?? (level === 'fatal' || level === 'error' ? 'both' : 'log');
    if (as === 'log' || as === 'both') {
      this.sendLog(level === 'warning' ? 'warn' : level, message);
    }
    if (as === 'error' || as === 'both') {
      if (!this.passesSampleRate()) return;
      const eff = this.effective();
      const payload: ErrorIngestPayload = {
        eventId: generateId(),
        exceptionClass: 'Message',
        message,
        platform: this.config.platform,
        sdkName: this.config.sdkName,
        sdkVersion: this.config.sdkVersion,
        dist: this.config.dist,
        level,
        environment: this.config.environment,
        release: this.config.release,
        sessionId: this.sessionId,
        user: eff.user,
        metadata: this.buildMetadata(),
        requestContext: browserRequestContext(),
        fingerprint: eff.fingerprint,
      };
      this.sendThroughBeforeSend(payload);
    }
  }

  captureLog(level: LogLevel, message: string, attributes?: Record<string, unknown>): void {
    this.sendLog(normalizeLogLevel(level), message, attributes);
  }

  addBreadcrumb(type: string, message: string, level?: string, data?: Record<string, unknown>): void {
    const crumb: Breadcrumb = {
      timestamp: new Date().toISOString(),
      type: VALID_BREADCRUMB_TYPES.has(type) ? type : 'default',
      message,
      level: level && VALID_BREADCRUMB_LEVELS.has(level) ? level : 'info',
      ...(data ? { data } : {}),
    };
    if (this.breadcrumbs.length >= this.maxBreadcrumbs) this.breadcrumbs.shift();
    this.breadcrumbs.push(crumb);
  }

  clearBreadcrumbs(): void { this.breadcrumbs = []; }
  setUser(user: { id?: string; email?: string }): void { this.config.user = user; }
  setTag(key: string, value: string): void {
    if (!this.config.tags) this.config.tags = {};
    this.config.tags[key] = value;
  }
  /** Bulk-set tags. Merges with existing tags. */
  setTags(tags: Record<string, string>): void {
    if (!this.config.tags) this.config.tags = {};
    Object.assign(this.config.tags, tags);
  }
  /** Set a single extra value. */
  setExtra(key: string, value: unknown): void {
    if (!this.config.extras) this.config.extras = {};
    this.config.extras[key] = value;
  }
  /** Bulk-set extras. Merges with existing extras. */
  setExtras(extras: Record<string, unknown>): void {
    if (!this.config.extras) this.config.extras = {};
    Object.assign(this.config.extras, extras);
  }
  /** Register a namespace-compatible event processor. */
  addEventProcessor(processor: ErrorEventProcessor): void {
    this.eventProcessors.push(processor);
  }
  /**
   * Attach a named context bag (e.g. `app`, `device`, `runtime`) — appears
   * under `metadata['context.<name>']` on every subsequent event. Pass
   * `null` to remove a previously-set context.
   */
  setContext(name: string, ctx: Record<string, unknown> | null): void {
    if (!this.config.contexts) this.config.contexts = {};
    if (ctx === null) delete this.config.contexts[name];
    else this.config.contexts[name] = ctx;
  }
  /**
   * Flush queued module batches and wait for in-flight transport work to drain.
   * Resolves `true` if telemetry drains within `timeoutMs` (default 2000ms),
   * `false` otherwise.
   */
  flush(timeoutMs?: number): Promise<boolean> {
    this.httpRequests?.flush();
    this.tracing.flush();
    this.replay?.flush();
    return this.transport.flush(timeoutMs);
  }

  /** Set the default severity level applied to subsequent captures. */
  setLevel(level: SeverityLevel): void {
    this.config.level = level;
  }

  /**
   * Set a custom grouping fingerprint applied to subsequent events.
   * Pass `null` or an empty array to clear and revert to default grouping.
   */
  setFingerprint(fingerprint: string[] | null): void {
    this.config.fingerprint = fingerprint && fingerprint.length > 0 ? fingerprint : undefined;
  }
  setIdentity(identity: { sdkName?: string; sdkVersion?: string; platform?: string; dist?: string }): void {
    if (identity.sdkName) this.config.sdkName = identity.sdkName;
    if (identity.sdkVersion) this.config.sdkVersion = identity.sdkVersion;
    if (identity.platform) this.config.platform = identity.platform;
    if (identity.dist) this.config.dist = identity.dist;
  }
  getSessionId(): string { return this.sessionId; }
  getConfig(): AllStakConfig { return this.config; }
  getDiagnostics(): SdkDiagnostics {
    return {
      transport: this.transport.getStats(),
      breadcrumbs: this.breadcrumbs.length,
      sessionId: this.sessionId,
    };
  }

  destroy(): void {
    // Close the release-health session BEFORE tearing down the transport so
    // the /sessions/end POST has a chance to land. Status is whatever the
    // session accumulated during its life.
    try { this.sessionTracker?.end(); } catch { /* never throw on shutdown */ }
    if (typeof window !== 'undefined') {
      if (this.onErrorHandler) window.removeEventListener('error', this.onErrorHandler as EventListener);
      if (this.onRejectionHandler) window.removeEventListener('unhandledrejection', this.onRejectionHandler as EventListener);
      if (this.onPageHideHandler) window.removeEventListener('pagehide', this.onPageHideHandler);
      if (this.onVisibilityHandler) window.removeEventListener('visibilitychange', this.onVisibilityHandler);
    }
    this.sessionTracker = null;
    this.offlineStore = null;
    this.onPageHideHandler = null;
    this.onVisibilityHandler = null;
    this.onErrorHandler = null;
    this.onRejectionHandler = null;
    this.tracing.destroy();
    if (this.replay) { this.replay.destroy(); this.replay = null; }
    if (this.httpRequests) { this.httpRequests.destroy(); this.httpRequests = null; }
    if (this.webVitals) { this.webVitals.destroy(); this.webVitals = null; }
    if (this.profileTimer) { clearInterval(this.profileTimer); this.profileTimer = null; }
    this._instrumentAxios = null;
    this.breadcrumbs = [];
    this.eventProcessors = [];
    this.lastEventKey = null;
    this.transport.close();
  }

  /**
   * Build the offline/persistent queue store, or return `null` to keep the
   * transport's in-memory-only behavior. Disabled when `enableOfflineQueue` is
   * `false`. When no custom storage is supplied the store resolves the browser
   * `localStorage` and silently no-ops if it is unavailable/unwritable. Never
   * throws — a store-construction failure leaves the SDK in-memory-only.
   */
  private createOfflineStore(): OfflineStore | null {
    if (this.config.enableOfflineQueue === false) return null;
    try {
      const store = new OfflineStore({
        ...(this.config.offlineStorage !== undefined ? { storage: this.config.offlineStorage } : {}),
        ...(this.config.offlineQueueKey ? { key: this.config.offlineQueueKey } : {}),
      });
      return store.isAvailable() ? store : null;
    } catch {
      return null;
    }
  }

  /**
   * Open the release-health session for this app-launch. Reuses the SDK's
   * existing {@link sessionId} so it matches every error/event payload.
   * Skipped when opted out (`enableAutoSessionTracking: false`) or under a
   * unit-test runtime. Fully fail-open — never blocks or throws into init.
   */
  private startSession(): void {
    if (this.config.enableAutoSessionTracking === false) return;
    if (isLikelyTestRuntime()) return;
    try {
      this.sessionTracker = new SessionTracker(
        this.transport,
        {
          release: this.config.release,
          environment: this.config.environment,
          getUserId: () => this.config.user?.id,
          sdkName: this.config.sdkName,
          sdkVersion: this.config.sdkVersion,
          platform: this.config.platform,
        },
        this.sessionId,
      );
      this.sessionTracker.start();
    } catch {
      this.sessionTracker = null; // never break init
    }
  }

  /**
   * Page/tab-close hooks. On `pagehide` (and the iOS-Safari `visibilitychange →
   * hidden` fallback) we (1) end the release-health session so a tab close is a
   * graceful shutdown, and (2) flush buffered telemetry via
   * `navigator.sendBeacon` so in-flight events are not lost — anything that
   * can't be beaconed is persisted to survive the next launch. Both actions are
   * idempotent and fail-open. Installed whenever session tracking or the
   * offline queue is active.
   */
  private installUnloadHooks(): void {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    if (!this.sessionTracker && !this.offlineStore) return;
    const onHidden = () => {
      try { this.sessionTracker?.end(); } catch { /* ignore */ }
      try { this.transport.flushToBeacon(); } catch { /* ignore */ }
    };
    this.onPageHideHandler = onHidden;
    this.onVisibilityHandler = () => {
      try {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') onHidden();
      } catch { /* ignore */ }
    };
    window.addEventListener('pagehide', this.onPageHideHandler);
    window.addEventListener('visibilitychange', this.onVisibilityHandler);
  }

  private installBrowserHandlers(): void {
    this.onErrorHandler = (ev: ErrorEvent) => {
      const err = ev.error instanceof Error ? ev.error : new Error(ev.message || 'Unknown error');
      this.captureException(err, { source: 'window.onerror' });
    };
    this.onRejectionHandler = (ev: PromiseRejectionEvent) => {
      const err = ev.reason instanceof Error ? ev.reason : new Error(String(ev.reason));
      this.captureException(err, { source: 'window.unhandledrejection' });
    };
    window.addEventListener('error', this.onErrorHandler as EventListener);
    window.addEventListener('unhandledrejection', this.onRejectionHandler as EventListener);
  }

  private sendLog(level: string, message: string, attributes?: Record<string, unknown>): void {
    const opts = this.valueScrubOptions();
    // Scrub the free-text log message + user-supplied attributes only. The
    // release/sdk/session identity fields below are not free text and are not
    // scanned. Fail-open: scrubbers never throw, but guard the whole build.
    let scrubbedMessage = message;
    let scrubbedAttributes = attributes;
    try {
      scrubbedMessage = scrubString(message, opts);
      scrubbedAttributes = attributes ? scrubDeep(attributes, opts) : attributes;
    } catch { /* fall back to unscrubbed — never drop the log */ }
    this.transport.send(LOGS_PATH, {
      timestamp: new Date().toISOString(),
      level,
      message: scrubbedMessage,
      sessionId: this.sessionId,
      environment: this.config.environment,
      release: this.config.release,
      platform: this.config.platform,
      sdkName: this.config.sdkName,
      sdkVersion: this.config.sdkVersion,
      metadata: { ...this.releaseTags(), ...this.config.tags, ...(scrubbedAttributes ?? {}) },
    });
  }

  private passesSampleRate(): boolean {
    const r = this.config.sampleRate;
    if (typeof r !== 'number' || r >= 1) return true;
    if (r <= 0) return false;
    return Math.random() < r;
  }

  /**
   * Options for the value-pattern PII scrubbers. `sendDefaultPii` defaults to
   * `false`: email + IP value scrubbing on, CC + SSN always
   * on. When `true`, only the email/IP value scrubbers are disabled.
   */
  private valueScrubOptions(): ValueScrubOptions {
    return { sendDefaultPii: this.config.sendDefaultPii === true };
  }

  /**
   * Returns the effective config layer = base config + every active scope.
   * Scope-only overrides (set inside `withScope`) flow into the wire
   * payload without leaking out of the callback.
   */
  private effective(): AllStakConfig {
    return mergeScopes(this.config, this.scopeStack());
  }

  private scopeStack(): Scope[] {
    return this.asyncScopeStorage?.getStore() ?? this.globalScopeStack;
  }

  private buildMetadata(perCallContext?: Record<string, unknown>): Record<string, unknown> {
    const eff = this.effective();
    const out: Record<string, unknown> = {
      ...this.releaseTags(),
      ...eff.tags,
      ...(eff.extras ?? {}),
      ...(perCallContext ?? {}),
    };
    if (eff.contexts) {
      for (const [name, ctx] of Object.entries(eff.contexts)) {
        out[`context.${name}`] = ctx;
      }
    }
    return out;
  }

  /**
   * Run `callback` with a fresh, temporary {@link Scope} that isolates
   * any user/tag/extra/context/fingerprint/level it sets. The scope is
   * popped automatically when the callback returns or throws — including
   * for `Promise`-returning callbacks (the pop runs in `.finally`).
   *
   * Use this on the server (SSR / RSC / API route handlers) to attach
   * per-request user/tags without leaking that data into another request
   * being processed concurrently.
   */
  withScope<T>(callback: (scope: Scope) => T): T {
    const scope = new Scope();
    if (this.asyncScopeStorage) {
      const parent = this.scopeStack();
      return this.asyncScopeStorage.run([...parent, scope], () => callback(scope));
    }

    this.globalScopeStack.push(scope);
    let popped = false;
    const pop = () => { if (!popped) { popped = true; this.globalScopeStack.pop(); } };
    try {
      const result = callback(scope);
      if (result && typeof (result as any).then === 'function') {
        return (result as any).then(
          (v: any) => { pop(); return v; },
          (e: any) => { pop(); throw e; },
        );
      }
      pop();
      return result;
    } catch (err) {
      pop();
      throw err;
    }
  }

  /** Direct access to the topmost active scope, or null. @internal */
  getCurrentScope(): Scope | null {
    const stack = this.scopeStack();
    return stack[stack.length - 1] ?? null;
  }

  configureScope(callback: (scope: Scope) => void): void {
    const current = this.getCurrentScope();
    if (current) {
      callback(current);
      return;
    }
    const scope = new Scope();
    callback(scope);
    const eff = mergeScopes(this.config, [scope]);
    this.config.user = eff.user;
    this.config.tags = eff.tags;
    this.config.extras = eff.extras;
    this.config.contexts = eff.contexts;
    this.config.fingerprint = eff.fingerprint;
    this.config.level = eff.level;
  }

  private async sendThroughBeforeSend(payload: ErrorIngestPayload): Promise<void> {
    const final = await this.applyBeforeSend(payload);
    if (!final) return;
    this.transport.send(ERRORS_PATH, final);
  }

  private async sendErrorThroughBeforeSend(payload: ErrorIngestPayload): Promise<void> {
    const final = await this.applyBeforeSend(payload);
    if (!final) return;
    this.transport.send(ERRORS_PATH, final);
    if (this.shouldCaptureScreenshot(final)) {
      void this.captureAndUploadScreenshot(final).catch(() => undefined);
    }
  }

  private async applyBeforeSend(payload: ErrorIngestPayload): Promise<ErrorIngestPayload | null | undefined> {
    let final: ErrorIngestPayload | null | undefined = payload;
    // Built-in value-pattern PII scrubber runs FIRST on the wire path so that
    // user-supplied processors + beforeSend see already-scrubbed free text.
    // Fail-open: scrubEventValues never throws, but guard anyway.
    try { final = scrubEventValues(payload, this.valueScrubOptions()); }
    catch { final = payload; }
    for (const processor of [...(this.config.eventProcessors ?? []), ...this.eventProcessors]) {
      if (!final) return null;
      try { final = await processor(final); }
      catch { /* never let a buggy processor break capture */ }
    }
    if (!final || this.shouldDropByFilters(final)) return null;
    if (this.config.beforeSend) {
      try { final = await this.config.beforeSend(final); }
      catch { final = payload; /* never let a buggy hook drop telemetry */ }
    }
    try { final = final ? scrubEventValues(final, this.valueScrubOptions()) : final; }
    catch { /* final scrubber is fail-open, but transport must never throw here */ }
    if (!final || this.shouldDropDuplicate(final)) return null;
    return final;
  }

  private shouldDropByFilters(event: ErrorIngestPayload): boolean {
    const ignorePatterns = this.config.disableDefaultIgnoreErrors
      ? (this.config.ignoreErrors ?? [])
      : [...DEFAULT_IGNORE_ERRORS, ...(this.config.ignoreErrors ?? [])];
    const message = `${event.exceptionClass || ''}: ${event.message || ''}`;
    if (ignorePatterns.some((pattern) => matchesPattern(message, pattern) || matchesPattern(event.message, pattern))) {
      return true;
    }

    const urls = eventUrls(event);
    const allowUrls = this.config.allowUrls ?? [];
    if (allowUrls.length > 0 && !urls.some((url) => allowUrls.some((pattern) => matchesPattern(url, pattern)))) {
      return true;
    }

    const denyUrls = this.config.denyUrls ?? [];
    if (denyUrls.length > 0 && urls.some((url) => denyUrls.some((pattern) => matchesPattern(url, pattern)))) {
      return true;
    }

    return false;
  }

  private shouldDropDuplicate(event: ErrorIngestPayload): boolean {
    if (this.config.dedupe === false) return false;
    const key = eventDedupeKey(event);
    if (key && key === this.lastEventKey) return true;
    this.lastEventKey = key;
    return false;
  }

  private async captureAndUploadScreenshot(event: ErrorIngestPayload): Promise<void> {
    if (!event.eventId) return;
    const captured = await capturePrivacySafeScreenshot({
      redactionMode: this.config.screenshotRedaction ?? 'strict',
      maskStyle: this.config.screenshotMaskStyle ?? 'solid',
      maskSelectors: this.config.maskSelectors,
      ignoreSelectors: this.config.ignoreSelectors,
      allowSelectors: this.config.allowSelectors,
      maxBytes: this.config.screenshotMaxBytes,
    });
    if (!captured) return;
    let final: ScreenshotCapture | false | null | undefined = captured;
    if (this.config.beforeScreenshotUpload) {
      try { final = await this.config.beforeScreenshotUpload(captured, event); }
      catch { final = false; }
    }
    if (!final) return;
    const dataBase64 = await blobToBase64(final.blob);
    this.transport.uploadAttachment(event.eventId, {
      contentType: final.contentType,
      dataBase64,
      width: final.width,
      height: final.height,
      redactionMode: final.redactionMode,
      captureMethod: final.captureMethod,
      sizeBytes: final.sizeBytes,
      metadata: final.metadata,
    }, { timeoutMs: this.config.screenshotUploadTimeoutMs });
  }

  private shouldCaptureScreenshot(event: ErrorIngestPayload): boolean {
    if (this.config.captureScreenshotOnError !== true) return false;
    const screenshotRate = this.config.screenshotSampleRate;
    if (typeof screenshotRate === 'number') {
      if (screenshotRate <= 0) return false;
      if (screenshotRate < 1 && Math.random() >= screenshotRate) return false;
    }
    if (this.config.screenshotOnUnhandledOnly === true) {
      const source = event.metadata?.source;
      return source === 'window.onerror' ||
        source === 'window.unhandledrejection' ||
        source === 'AllStakProvider.ErrorBoundary';
    }
    return true;
  }

  private releaseTags(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (this.config.sdkName) out['sdk.name'] = this.config.sdkName;
    if (this.config.sdkVersion) out['sdk.version'] = this.config.sdkVersion;
    if (this.config.platform) out['platform'] = this.config.platform;
    if (this.config.dist) out['dist'] = this.config.dist;
    if (this.config.commitSha) out['commit.sha'] = this.config.commitSha;
    if (this.config.branch) out['commit.branch'] = this.config.branch;
    return out;
  }

  private capturePageLoadSpan(): void {
    if (typeof performance === 'undefined' || typeof window === 'undefined') return;
    try {
      const nav = performance.getEntriesByType?.('navigation')?.[0] as PerformanceNavigationTiming | undefined;
      if (!nav) return;
      const origin = performance.timeOrigin || Date.now();
      const start = Math.round(origin + (nav?.startTime ?? 0));
      const endOffset = nav?.loadEventEnd && nav.loadEventEnd > 0 ? nav.loadEventEnd : performance.now();
      const end = Math.round(origin + endOffset);
      const measurements: Record<string, number> = {};
      if (nav) {
        measurements.ttfb = Math.max(0, nav.responseStart - nav.requestStart);
        measurements.dom_interactive_ms = Math.max(0, nav.domInteractive - nav.startTime);
        measurements.load_event_ms = Math.max(0, nav.loadEventEnd - nav.startTime);
      }
      const span = this.tracing.startSpan('pageload', {
        op: 'pageload',
        platform: 'web',
        description: window.location?.pathname || '/',
        startTimeMillis: start,
        measurements,
        attributes: {
          route: window.location?.pathname || '/',
          url: window.location?.href?.split('?')[0] || '',
          session_id: this.sessionId,
        },
      });
      span.finish('ok', end);
    } catch { /* never break init */ }
  }

  private installLongTaskProfiler(): void {
    const rate = this.config.profilesSampleRate ?? this.config.tracesSampleRate ?? 0;
    if (rate <= 0 || Math.random() >= rate) return;
    if (typeof PerformanceObserver === 'undefined' || typeof performance === 'undefined') return;
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const duration = Number(entry.duration || 0);
          if (!Number.isFinite(duration) || duration <= 0) continue;
          const origin = performance.timeOrigin || Date.now();
          const span = this.tracing.startSpan('profile.long_task', {
            op: 'profile.long_task',
            platform: 'web',
            description: 'Long task',
            startTimeMillis: Math.round(origin + entry.startTime),
            measurements: { long_task_ms: duration },
            attributes: {
              route: typeof location !== 'undefined' ? location.pathname || '/' : '/',
              session_id: this.sessionId,
            },
          });
          span.finish('ok', Math.round(origin + entry.startTime + duration));
        }
      });
      observer.observe({ type: 'longtask', buffered: true } as PerformanceObserverInit);
    } catch { /* unsupported browser */ }
  }

  private installSampledStackProfiler(): void {
    const rate = this.config.profilesSampleRate ?? 0;
    if (rate <= 0 || Math.random() >= rate) return;
    if (typeof window === 'undefined') return;

    const startedAt = Date.now();
    const profileId = generateId();
    const intervalMs = 100;
    const flushEveryMs = 10_000;
    const samples: Array<{
      elapsedMs: number;
      thread: string;
      stack: Array<{ function?: string; file?: string; line?: number; column?: number }>;
    }> = [];

    const flush = () => {
      if (samples.length === 0) return;
      const chunk = samples.splice(0, samples.length);
      this.transport.send(PROFILES_PATH, {
        profiles: [{
          profileId,
          traceId: this.tracing.getTraceId(),
          spanId: this.tracing.getCurrentSpanId() ?? undefined,
          sessionId: this.sessionId,
          release: this.config.release,
          environment: this.config.environment,
          platform: this.config.platform ?? 'browser',
          runtime: 'browser',
          profileType: 'sampled_stack',
          durationMs: Date.now() - startedAt,
          sampleCount: chunk.length,
          samples: chunk,
          measurements: { sample_interval_ms: intervalMs },
          attributes: {
            route: typeof location !== 'undefined' ? location.pathname || '/' : '/',
            sdk_name: this.config.sdkName ?? SDK_NAME,
            sdk_version: this.config.sdkVersion ?? SDK_VERSION,
          },
          timestampMillis: Date.now(),
        }],
      });
    };

    this.profileTimer = setInterval(() => {
      const elapsedMs = Date.now() - startedAt;
      const stack = parseStack(new Error('AllStak profile sample').stack)
        .slice(1, 65)
        .map((f) => ({
          function: f.function,
          file: f.filename || f.absPath,
          line: f.lineno,
          column: f.colno,
        }));
      samples.push({ elapsedMs, thread: 'main', stack });
      if (elapsedMs > 0 && elapsedMs % flushEveryMs < intervalMs) flush();
    }, intervalMs);
    (this.profileTimer as any)?.unref?.();

    window.addEventListener('pagehide', flush, { once: false });
    window.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
  }
}

function normalizeLogLevel(level: LogLevel): string {
  if (level === 'warning') return 'warn';
  if (level === 'log') return 'info';
  return level;
}

function matchesPattern(value: string | undefined, pattern: EventFilterPattern): boolean {
  if (!value) return false;
  return typeof pattern === 'string' ? value.includes(pattern) : pattern.test(value);
}

function eventUrls(event: ErrorIngestPayload): string[] {
  const urls = new Set<string>();
  for (const frame of event.frames ?? []) {
    if (frame.filename) urls.add(frame.filename);
    if (frame.absPath) urls.add(frame.absPath);
  }
  for (const line of event.stackTrace ?? []) urls.add(line);
  const request = event.requestContext;
  if (request?.host || request?.path) urls.add(`${request.host ?? ''}${request.path ?? ''}`);
  return [...urls];
}

function eventDedupeKey(event: ErrorIngestPayload): string {
  const fingerprint = event.fingerprint?.join('|') ?? '';
  const firstFrame = event.frames?.[0]
    ? `${event.frames[0].filename ?? event.frames[0].absPath ?? ''}:${event.frames[0].lineno ?? ''}:${event.frames[0].colno ?? ''}:${event.frames[0].function ?? ''}`
    : event.stackTrace?.[0] ?? '';
  return [event.exceptionClass, event.message, fingerprint, firstFrame].join('|');
}

function normalizeSpanInput(
  input: SpanContextInput,
  options?: SpanOptions,
): {
  operation: string;
  op?: string;
  platform?: string;
  description?: string;
  tags?: Record<string, string>;
  measurements?: Record<string, number>;
  attributes?: Record<string, string | number | boolean | null | undefined>;
  startTimeMillis?: number;
} {
  if (typeof input === 'string') {
    return {
      operation: input,
      op: options?.op,
      platform: options?.platform,
      description: options?.description,
      tags: options?.tags,
      measurements: options?.measurements,
      attributes: options?.attributes,
      startTimeMillis: options?.startTimeMillis,
    };
  }
  const tags: Record<string, string> = { ...(input.tags ?? {}), ...(options?.tags ?? {}) };
  const attributes = { ...(input.attributes ?? {}), ...(options?.attributes ?? {}) };
  for (const [key, value] of Object.entries(attributes)) {
    if (value != null && tags[key] == null) tags[key] = String(value);
  }
  return {
    operation: input.op ?? input.operation ?? input.name ?? 'custom',
    op: options?.op ?? input.op,
    platform: options?.platform ?? input.platform,
    description: options?.description ?? input.description ?? input.name,
    tags,
    measurements: { ...(input.measurements ?? {}), ...(options?.measurements ?? {}) },
    attributes,
    startTimeMillis: options?.startTimeMillis ?? input.startTimeMillis,
  };
}

let instance: AllStakClient | null = null;
function ensureInit(): AllStakClient {
  if (!instance) throw new Error('AllStak.init() must be called before using the SDK');
  return instance;
}

/**
 * Module-level breadcrumb forwarder used by the auto-instrumentation
 * wrappers so they always target the current `instance` (after re-init)
 * and silently no-op when there is none.
 */
function safeAddBreadcrumb(
  type: string,
  message: string,
  level?: string,
  data?: Record<string, unknown>,
): void {
  try { instance?.addBreadcrumb(type, message, level, data); }
  catch { /* never break host */ }
}

// Wire the navigation module's default-forwarder so router helpers
// dispatch into the active singleton without an extra import dance.
__setDefaultBreadcrumbForwarder(safeAddBreadcrumb);

export const AllStak = {
  init(config: AllStakConfig): AllStakClient {
    if (instance) instance.destroy();
    instance = new AllStakClient(config);
    return instance;
  },
  captureException(error: Error, context?: Record<string, unknown>): void {
    ensureInit().captureException(error, context);
  },
  captureMessage(
    message: string,
    level: SeverityLevel = 'info',
    options?: { as?: 'log' | 'error' | 'both' },
  ): void {
    ensureInit().captureMessage(message, level, options);
  },
  logger: {
    debug(message: string, attributes?: Record<string, unknown>): void {
      ensureInit().captureLog('debug', message, attributes);
    },
    info(message: string, attributes?: Record<string, unknown>): void {
      ensureInit().captureLog('info', message, attributes);
    },
    log(message: string, attributes?: Record<string, unknown>): void {
      ensureInit().captureLog('log', message, attributes);
    },
    warn(message: string, attributes?: Record<string, unknown>): void {
      ensureInit().captureLog('warn', message, attributes);
    },
    error(message: string, attributes?: Record<string, unknown>): void {
      ensureInit().captureLog('error', message, attributes);
    },
    fatal(message: string, attributes?: Record<string, unknown>): void {
      ensureInit().captureLog('fatal', message, attributes);
    },
  },
  addBreadcrumb(type: string, message: string, level?: string, data?: Record<string, unknown>): void {
    ensureInit().addBreadcrumb(type, message, level, data);
  },
  clearBreadcrumbs(): void { ensureInit().clearBreadcrumbs(); },
  setUser(user: { id?: string; email?: string }): void { ensureInit().setUser(user); },
  setTag(key: string, value: string): void { ensureInit().setTag(key, value); },
  setTags(tags: Record<string, string>): void { ensureInit().setTags(tags); },
  setExtra(key: string, value: unknown): void { ensureInit().setExtra(key, value); },
  setExtras(extras: Record<string, unknown>): void { ensureInit().setExtras(extras); },
  addEventProcessor(processor: ErrorEventProcessor): void { ensureInit().addEventProcessor(processor); },
  setContext(name: string, ctx: Record<string, unknown> | null): void { ensureInit().setContext(name, ctx); },
  setLevel(level: SeverityLevel): void { ensureInit().setLevel(level); },
  setFingerprint(fingerprint: string[] | null): void { ensureInit().setFingerprint(fingerprint); },
  flush(timeoutMs?: number): Promise<boolean> { return ensureInit().flush(timeoutMs); },
  setIdentity(identity: { sdkName?: string; sdkVersion?: string; platform?: string; dist?: string }): void {
    ensureInit().setIdentity(identity);
  },
  /**
   * Run `callback` with a fresh, temporary {@link Scope}. Any user/tag/
   * extra/context/fingerprint/level set on the scope is visible only inside
   * the callback. Pop is automatic (sync, async, throwing).
   */
  withScope<T>(callback: (scope: Scope) => T): T { return ensureInit().withScope(callback); },
  getCurrentScope(): Scope | null { return ensureInit().getCurrentScope(); },
  configureScope(callback: (scope: Scope) => void): void { ensureInit().configureScope(callback); },
  startSpan<T = Span>(
    operation: SpanContextInput,
    optionsOrCallback?: SpanOptions | ((span: Span) => T),
  ): Span | T {
    return ensureInit().startSpan(operation as any, optionsOrCallback as any);
  },
  getTraceId(): string { return ensureInit().getTraceId(); },
  setTraceId(traceId: string): void { ensureInit().setTraceId(traceId); },
  getCurrentSpanId(): string | null { return ensureInit().getCurrentSpanId(); },
  resetTrace(): void { ensureInit().resetTrace(); },
  /** Manually instrument an axios instance. No-op when HTTP tracking is off. */
  instrumentAxios<T = any>(axios: T): T { return ensureInit().instrumentAxios(axios); },
  getSessionId(): string { return ensureInit().getSessionId(); },
  getDiagnostics(): SdkDiagnostics | null { return instance?.getDiagnostics() ?? null; },
  getConfig(): AllStakConfig | null { return instance?.getConfig() ?? null; },
  close(): void { instance?.destroy(); instance = null; },
  destroy(): void { instance?.destroy(); instance = null; },
  /** @internal */ _getInstance(): AllStakClient | null { return instance; },
};
