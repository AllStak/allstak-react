/**
 * Standalone AllStak client for the browser/React environment. No external
 * AllStak SDK dependencies — only the browser's native `fetch`, AbortController,
 * Date, JSON, and (optionally) `window` for unhandled error auto-capture.
 *
 * Surface mirrors the public AllStak API used by web apps:
 *   init / captureException / captureMessage / addBreadcrumb / clearBreadcrumbs
 *   setUser / setTag / setIdentity / getSessionId
 */

import { HttpTransport } from './transport';
import { parseStack } from './stack';
import { instrumentFetch, instrumentConsole } from './auto-breadcrumbs';
import { instrumentBrowserNavigation, __setDefaultBreadcrumbForwarder } from './navigation';
import { Scope, mergeScopes } from './scope';
import { TracingModule, Span } from './tracing';
import { ReplayRecorder, ReplayOptions } from './replay';
import { resolveDebugId } from './debug-id';

export const INGEST_HOST = 'https://api.allstak.sa';
export const SDK_NAME = 'allstak-react';
export const SDK_VERSION = '0.2.0';

export { Scope } from './scope';
export { Span, TracingModule } from './tracing';
export type { SpanData } from './tracing';

const ERRORS_PATH = '/ingest/v1/errors';
const LOGS_PATH = '/ingest/v1/logs';

const VALID_BREADCRUMB_TYPES = new Set(['http', 'log', 'ui', 'navigation', 'query', 'default']);
const VALID_BREADCRUMB_LEVELS = new Set(['info', 'warn', 'error', 'debug']);
const DEFAULT_MAX_BREADCRUMBS = 50;

export interface AllStakConfig {
  /** Project API key (`ask_live_…`). Required. */
  apiKey: string;
  /** Optional ingest host override; defaults to {@link INGEST_HOST}. */
  host?: string;
  environment?: string;
  release?: string;
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
  /** Service name attached to every span (defaults to release if unset). */
  service?: string;
  maxBreadcrumbs?: number;
  /** Auto-capture unhandled `error` and `unhandledrejection` on `window`. Default: true */
  autoCaptureBrowserErrors?: boolean;
  /** Wrap `globalThis.fetch` to record HTTP breadcrumbs. Default: true */
  autoBreadcrumbsFetch?: boolean;
  /** Wrap `console.warn` and `console.error` to record log breadcrumbs. Default: true */
  autoBreadcrumbsConsole?: boolean;
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
  user?: { id?: string; email?: string };
  metadata?: Record<string, unknown>;
  breadcrumbs?: Breadcrumb[];
  requestContext?: { method?: string; path?: string; host?: string; userAgent?: string };
  fingerprint?: string[];
}

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

function browserRequestContext(): ErrorIngestPayload['requestContext'] {
  if (typeof window === 'undefined' || typeof location === 'undefined') return undefined;
  return {
    method: 'GET',
    path: location.pathname || '/',
    host: location.host || '',
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
  };
}

export class AllStakClient {
  private transport: HttpTransport;
  private config: AllStakConfig;
  private sessionId: string;
  private breadcrumbs: Breadcrumb[] = [];
  private maxBreadcrumbs: number;
  private scopeStack: Scope[] = [];
  private tracing: TracingModule;
  private replay: ReplayRecorder | null = null;
  private onErrorHandler: ((ev: ErrorEvent) => void) | null = null;
  private onRejectionHandler: ((ev: PromiseRejectionEvent) => void) | null = null;

  constructor(config: AllStakConfig) {
    if (!config.apiKey) throw new Error('AllStak: config.apiKey is required');
    this.config = { ...config };
    if (!this.config.environment) this.config.environment = 'production';
    if (!this.config.sdkName) this.config.sdkName = SDK_NAME;
    if (!this.config.sdkVersion) this.config.sdkVersion = SDK_VERSION;
    if (!this.config.platform) this.config.platform = 'browser';
    this.sessionId = generateId();
    this.maxBreadcrumbs = config.maxBreadcrumbs ?? DEFAULT_MAX_BREADCRUMBS;
    const baseUrl = (config.host ?? INGEST_HOST).replace(/\/$/, '');
    this.transport = new HttpTransport(baseUrl, config.apiKey);
    this.tracing = new TracingModule(this.transport, {
      service: config.service ?? config.release ?? '',
      environment: this.config.environment ?? 'production',
      tracesSampleRate: config.tracesSampleRate,
    });

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
      try { instrumentConsole(safeAddBreadcrumb); }
      catch { /* ignore */ }
    }
    if (config.autoBreadcrumbsNavigation !== false) {
      try { instrumentBrowserNavigation(safeAddBreadcrumb); }
      catch { /* ignore */ }
    }
    if (config.replay && (config.replay.enabled ?? true)) {
      try {
        this.replay = new ReplayRecorder(this.transport, this.sessionId, safeAddBreadcrumb, config.replay);
        this.replay.start();
      } catch { /* never break init */ }
    }
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
    // Auto-attach the active trace/span so the error groups with the
    // surrounding tracing context server-side.
    const traceContext: Record<string, unknown> = {};
    const traceId = this.tracing.getTraceId();
    if (traceId) traceContext.traceId = traceId;
    const spanId = this.tracing.getCurrentSpanId();
    if (spanId) traceContext.spanId = spanId;

    const payload: ErrorIngestPayload = {
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
      user: eff.user,
      metadata: { ...this.buildMetadata(context), ...traceContext },
      breadcrumbs: currentBreadcrumbs,
      requestContext: browserRequestContext(),
      fingerprint: eff.fingerprint,
    };
    this.sendThroughBeforeSend(payload);
  }

  /** Start a new span — auto-parented to any currently-active span. */
  startSpan(operation: string, options?: { description?: string; tags?: Record<string, string> }): Span {
    return this.tracing.startSpan(operation, options);
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
    level: 'fatal' | 'error' | 'warning' | 'info' = 'info',
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
   * Wait for the in-flight retry-buffer to drain. Resolves `true` if the
   * buffer empties within `timeoutMs` (default 2000ms), `false` otherwise.
   */
  flush(timeoutMs?: number): Promise<boolean> {
    return this.transport.flush(timeoutMs);
  }

  /** Set the default severity level applied to subsequent captures. */
  setLevel(level: 'fatal' | 'error' | 'warning' | 'info' | 'debug'): void {
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

  destroy(): void {
    if (typeof window !== 'undefined') {
      if (this.onErrorHandler) window.removeEventListener('error', this.onErrorHandler as EventListener);
      if (this.onRejectionHandler) window.removeEventListener('unhandledrejection', this.onRejectionHandler as EventListener);
    }
    this.onErrorHandler = null;
    this.onRejectionHandler = null;
    this.tracing.destroy();
    if (this.replay) { this.replay.destroy(); this.replay = null; }
    this.breadcrumbs = [];
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

  private sendLog(level: string, message: string): void {
    this.transport.send(LOGS_PATH, {
      timestamp: new Date().toISOString(),
      level,
      message,
      sessionId: this.sessionId,
      environment: this.config.environment,
      release: this.config.release,
      platform: this.config.platform,
      sdkName: this.config.sdkName,
      sdkVersion: this.config.sdkVersion,
      metadata: { ...this.releaseTags(), ...this.config.tags },
    });
  }

  private passesSampleRate(): boolean {
    const r = this.config.sampleRate;
    if (typeof r !== 'number' || r >= 1) return true;
    if (r <= 0) return false;
    return Math.random() < r;
  }

  /**
   * Returns the effective config layer = base config + every active scope.
   * Scope-only overrides (set inside `withScope`) flow into the wire
   * payload without leaking out of the callback.
   */
  private effective(): AllStakConfig {
    return mergeScopes(this.config, this.scopeStack);
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
    this.scopeStack.push(scope);
    let popped = false;
    const pop = () => { if (!popped) { popped = true; this.scopeStack.pop(); } };
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
    return this.scopeStack[this.scopeStack.length - 1] ?? null;
  }

  private async sendThroughBeforeSend(payload: ErrorIngestPayload): Promise<void> {
    let final: ErrorIngestPayload | null | undefined = payload;
    if (this.config.beforeSend) {
      try { final = await this.config.beforeSend(payload); }
      catch { final = payload; /* never let a buggy hook drop telemetry */ }
    }
    if (!final) return; // explicit drop
    this.transport.send(ERRORS_PATH, final);
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
    level: 'fatal' | 'error' | 'warning' | 'info' = 'info',
    options?: { as?: 'log' | 'error' | 'both' },
  ): void {
    ensureInit().captureMessage(message, level, options);
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
  setContext(name: string, ctx: Record<string, unknown> | null): void { ensureInit().setContext(name, ctx); },
  setLevel(level: 'fatal' | 'error' | 'warning' | 'info' | 'debug'): void { ensureInit().setLevel(level); },
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
  startSpan(operation: string, options?: { description?: string; tags?: Record<string, string> }): Span {
    return ensureInit().startSpan(operation, options);
  },
  getTraceId(): string { return ensureInit().getTraceId(); },
  setTraceId(traceId: string): void { ensureInit().setTraceId(traceId); },
  getCurrentSpanId(): string | null { return ensureInit().getCurrentSpanId(); },
  resetTrace(): void { ensureInit().resetTrace(); },
  getSessionId(): string { return ensureInit().getSessionId(); },
  getConfig(): AllStakConfig | null { return instance?.getConfig() ?? null; },
  destroy(): void { instance?.destroy(); instance = null; },
  /** @internal */ _getInstance(): AllStakClient | null { return instance; },
};
