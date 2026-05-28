/**
 * Fail-open HTTP transport for browser/React. Telemetry sends are best-effort:
 * they use a short timeout, never reject into the host app, and fall into a
 * bounded in-memory ring buffer with circuit-breaker backoff when AllStak is
 * unavailable.
 *
 * When an {@link OfflineStore} is supplied the transport additionally PERSISTS
 * un-delivered events (already PII-scrubbed by the upstream pipeline) so they
 * survive a process/app restart and a network outage. Persisted events are
 * drained and re-sent on the next init. Session lifecycle calls are excluded —
 * a replayed stale session would skew durations. See `offline-store.ts`.
 *
 * No window, no AbortController fallback shims — RN exposes both natively.
 */

import type { OfflineStore } from './offline-store';

const REQUEST_TIMEOUT = 2000;
const MAX_BUFFER = 100;
const FAILURE_THRESHOLD = 3;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 30_000;
const RETRY_AFTER_MAX_MS = 300_000;

/**
 * Paths that are LIVE-only and must never be persisted/replayed. A stale
 * `sessions/start`/`sessions/end` re-sent on the next launch would corrupt
 * release-health durations, so they stay best-effort in-memory.
 */
const NON_PERSISTABLE_PATHS = ['/ingest/v1/sessions/start', '/ingest/v1/sessions/end'];

function isPersistablePath(path: string): boolean {
  return !NON_PERSISTABLE_PATHS.includes(path);
}

/**
 * Error thrown for a non-2xx HTTP response, carrying the status and the
 * server's `Retry-After` header (when present) so the retry/circuit-breaker
 * logic can honour real rate-limit signals instead of regex-scraping a string.
 */
class HttpResponseError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfter: string | null,
  ) {
    super(`HTTP ${status}`);
    this.name = 'HttpResponseError';
  }
}

interface Pending {
  path: string;
  payload: unknown;
  dedupeKey?: string;
  timeoutMs?: number;
  /**
   * Id of the matching {@link OfflineStore} entry, if this item is already
   * persisted (i.e. it was drained from disk or persisted on a prior failure).
   * Used to remove the entry exactly once it is delivered or permanently
   * undeliverable, and to avoid persisting the same event twice.
   */
  persistedId?: string;
}

export interface HttpTransportOptions {
  /**
   * Browser-side tunnel endpoint. When set, telemetry is posted to this URL
   * instead of directly to the AllStak ingest host. The application server is
   * expected to forward the JSON body to `X-AllStak-Target-Path`.
   */
  tunnel?: string;
  /**
   * Optional persistent store for offline survival. When supplied, undelivered
   * events are written to it and re-sent on the next init via {@link drain}.
   * Payloads are persisted exactly as received here — already PII-scrubbed by
   * the upstream pipeline. Omit (or pass an unavailable store) to keep the
   * existing in-memory-only behavior.
   */
  offlineStore?: OfflineStore;
}

export interface AttachmentUpload {
  contentType: string;
  dataBase64: string;
  width?: number;
  height?: number;
  redactionMode: string;
  captureMethod: string;
  sizeBytes: number;
  metadata?: Record<string, unknown>;
}

export class HttpTransport {
  private buffer: Pending[] = [];
  private bufferedKeys = new Set<string>();
  private inFlightKeys = new Set<string>();
  private inFlight = new Set<Promise<void>>();
  private flushing = false;
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;

  constructor(
    private baseUrl: string,
    private apiKey: string,
    private options: HttpTransportOptions = {},
  ) {}

  send(path: string, payload: unknown, options: { timeoutMs?: number } = {}): Promise<void> {
    this.enqueueOrDispatch({ path, payload, timeoutMs: options.timeoutMs });
    return Promise.resolve();
  }

  uploadAttachment(eventId: string, attachment: AttachmentUpload, options: { timeoutMs?: number } = {}): Promise<void> {
    const dedupeKey = `attachment:${eventId}:screenshot`;
    this.enqueueOrDispatch({
      path: `/ingest/v1/errors/${encodeURIComponent(eventId)}/attachments`,
      dedupeKey,
      timeoutMs: options.timeoutMs,
      payload: {
        kind: 'screenshot',
        contentType: attachment.contentType,
        dataBase64: attachment.dataBase64,
        width: attachment.width,
        height: attachment.height,
        redactionMode: attachment.redactionMode,
        captureMethod: attachment.captureMethod,
        sizeBytes: attachment.sizeBytes,
        metadata: attachment.metadata ?? {},
      },
    });
    return Promise.resolve();
  }

  private enqueueOrDispatch(item: Pending): void {
    if (item.dedupeKey && (this.bufferedKeys.has(item.dedupeKey) || this.inFlightKeys.has(item.dedupeKey))) return;
    if (Date.now() < this.circuitOpenUntil) {
      this.push(item);
      return;
    }
    this.track(this.dispatch(item));
  }

  private track(promise: Promise<void>): void {
    this.inFlight.add(promise);
    promise.finally(() => this.inFlight.delete(promise)).catch(() => undefined);
  }

  private async dispatch(item: Pending): Promise<void> {
    if (item.dedupeKey) this.inFlightKeys.add(item.dedupeKey);
    try {
      await this.doFetch(item.path, item.payload, item.timeoutMs);
      this.consecutiveFailures = 0;
      this.circuitOpenUntil = 0;
      this.onDelivered(item);
      this.scheduleFlush();
    } catch (err) {
      if (this.isPermanentDrop(err)) {
        // 4xx (non-429): the server rejected it for good. Don't retry or keep
        // persisting — drop it (and remove any persisted copy).
        this.onDelivered(item);
        return;
      }
      this.recordFailure(err);
      this.persistOnFailure(item);
      this.push(item);
    } finally {
      if (item.dedupeKey) this.inFlightKeys.delete(item.dedupeKey);
    }
  }

  /**
   * A 4xx other than 429 is permanently undeliverable — the payload is bad, not
   * the network. Retrying or persisting it forever would be pointless, so the
   * caller drops it (and removes any persisted copy). 429 and 5xx remain
   * retryable.
   */
  private isPermanentDrop(error: unknown): boolean {
    return (
      error instanceof HttpResponseError &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 429
    );
  }

  /**
   * Persist an undelivered, already-scrubbed item so it survives a restart.
   * Session calls are skipped. Already-persisted items keep their id (no
   * duplicate write). Fully fail-open via the store's own guards.
   */
  private persistOnFailure(item: Pending): void {
    const store = this.options.offlineStore;
    if (!store || !store.isAvailable()) return;
    if (!isPersistablePath(item.path)) return;
    if (item.persistedId) return;
    const id = store.persist(item.path, item.payload);
    if (id) item.persistedId = id;
  }

  /** Remove an item's persisted copy once it is delivered or permanently dropped. */
  private onDelivered(item: Pending): void {
    if (!item.persistedId) return;
    this.options.offlineStore?.remove(item.persistedId);
    item.persistedId = undefined;
  }

  private async doFetch(path: string, payload: unknown, timeoutMs = REQUEST_TIMEOUT): Promise<void> {
    const url = this.options.tunnel || `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-AllStak-Key': this.apiKey,
          ...(this.options.tunnel ? { 'X-AllStak-Target-Path': path } : {}),
        },
        body: JSON.stringify(this.options.tunnel ? { path, payload } : payload),
        signal: controller.signal,
      });
      if (!res.ok) throw new HttpResponseError(res.status, res.headers.get('Retry-After'));
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private push(item: Pending): void {
    if (item.dedupeKey && this.bufferedKeys.has(item.dedupeKey)) return;
    if (this.buffer.length >= MAX_BUFFER) this.buffer.shift();
    this.buffer.push(item);
    if (item.dedupeKey) this.bufferedKeys.add(item.dedupeKey);
  }

  private scheduleFlush(): void {
    if (this.flushing || this.buffer.length === 0) return;
    const delay = Math.max(0, this.circuitOpenUntil - Date.now());
    const timer = setTimeout(() => {
      void this.flushBuffer().catch(() => undefined);
    }, delay);
    if (typeof timer === 'object' && typeof timer.unref === 'function') timer.unref();
  }

  private async flushBuffer(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;
    try {
      const items = this.buffer.splice(0, this.buffer.length);
      this.bufferedKeys.clear();
      for (const item of items) {
        if (Date.now() < this.circuitOpenUntil) {
          this.push(item);
          continue;
        }
        try {
          await this.doFetch(item.path, item.payload, item.timeoutMs);
          this.consecutiveFailures = 0;
          this.circuitOpenUntil = 0;
          this.onDelivered(item);
        } catch (err) {
          if (this.isPermanentDrop(err)) {
            this.onDelivered(item);
            continue;
          }
          this.recordFailure(err);
          this.persistOnFailure(item);
          this.push(item);
        }
      }
    } finally {
      this.flushing = false;
      if (this.buffer.length > 0) this.scheduleFlush();
    }
  }

  private recordFailure(error: unknown): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures < FAILURE_THRESHOLD) return;
    const backoff = jitteredBackoff(this.consecutiveFailures);
    // A real `Retry-After` from a 429/503 response overrides the computed
    // backoff; otherwise fall back to the jittered exponential backoff.
    const retryAfterMs = retryAfterFromResponse(error);
    this.circuitOpenUntil = Date.now() + (retryAfterMs > 0 ? retryAfterMs : backoff);
  }

  getBufferSize(): number {
    return this.buffer.length;
  }

  /**
   * Wait for queued and in-flight telemetry to drain. Resolves `true` if
   * telemetry drains within `timeoutMs` (default 2000ms), `false` otherwise.
   * Useful at process exit / before navigation away.
   */
  async flush(timeoutMs = 2000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      if (this.buffer.length > 0 && !this.flushing && Date.now() >= this.circuitOpenUntil) {
        await this.flushBuffer();
      }
      if (this.buffer.length === 0 && this.inFlight.size === 0 && !this.flushing) {
        return true;
      }
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /**
   * Load events persisted on a previous app-launch and re-send them through the
   * normal pipeline (respecting retry/backoff/circuit-breaker). Each entry
   * carries its persisted id so it is removed only once delivered (2xx) or
   * permanently undeliverable (4xx ≠ 429). Asynchronous and fail-open — never
   * throws, never blocks init. A no-op when no store is configured.
   */
  drain(): void {
    const store = this.options.offlineStore;
    if (!store || !store.isAvailable()) return;
    let persisted: ReturnType<OfflineStore['load']>;
    try {
      persisted = store.load();
    } catch {
      return;
    }
    for (const entry of persisted) {
      // Defensive: never replay a session lifecycle call even if one somehow
      // landed in the store.
      if (!isPersistablePath(entry.path)) {
        store.remove(entry.id);
        continue;
      }
      this.enqueueOrDispatch({ path: entry.path, payload: entry.payload, persistedId: entry.id });
    }
  }

  /**
   * Best-effort synchronous flush for page/tab close. The async transport may
   * not drain before the tab is torn down, so we (a) `navigator.sendBeacon`
   * everything still buffered and (b) persist whatever cannot be beaconed so it
   * is replayed on the next launch. Either way, in-flight telemetry is not lost.
   *
   * `sendBeacon` cannot set the `X-AllStak-Key` header. We therefore only beacon
   * when a `tunnel` is configured — the app server forwards the JSON body
   * (carrying `path` + `payload`) using its own credentials, exactly like the
   * normal tunnel POST. For the DIRECT ingest host (which authenticates via the
   * header) we skip the beacon and persist instead, so the next launch re-sends
   * it with proper auth. This keeps the ingest auth contract unchanged.
   *
   * Fail-open — never throws. Returns the number of items beaconed.
   */
  flushToBeacon(): number {
    if (this.buffer.length === 0) return 0;
    const nav = (globalThis as { navigator?: { sendBeacon?: (url: string, data?: BodyInit) => boolean } }).navigator;
    // Beacon is only viable on the tunnel path (auth-by-header otherwise).
    const canBeacon = !!this.options.tunnel && !!nav && typeof nav.sendBeacon === 'function';

    const items = this.buffer.splice(0, this.buffer.length);
    this.bufferedKeys.clear();
    let beaconed = 0;
    for (const item of items) {
      if (!isPersistablePath(item.path)) continue; // sessions are handled live
      let ok = false;
      if (canBeacon) {
        try {
          const body = JSON.stringify({ path: item.path, payload: item.payload });
          const data = typeof Blob !== 'undefined'
            ? new Blob([body], { type: 'application/json' })
            : body;
          ok = nav!.sendBeacon!(this.options.tunnel!, data as BodyInit);
        } catch {
          ok = false;
        }
      }
      if (ok) {
        beaconed++;
        this.onDelivered(item);
      } else {
        // Couldn't beacon — persist so it survives to the next launch.
        this.persistOnFailure(item);
      }
    }
    return beaconed;
  }
}

function jitteredBackoff(failures: number): number {
  const exp = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(8, failures - FAILURE_THRESHOLD));
  return Math.floor(exp / 2 + Math.random() * (exp / 2));
}

/**
 * Compute the rate-limit delay (ms) to honour for a failed dispatch. Returns 0
 * unless the error is a 429/503 `HttpResponseError` carrying a parseable
 * `Retry-After` header, in which case the caller uses it instead of backoff.
 */
function retryAfterFromResponse(error: unknown): number {
  if (!(error instanceof HttpResponseError)) return 0;
  if (error.status !== 429 && error.status !== 503) return 0;
  return parseRetryAfter(error.retryAfter, Date.now());
}

/**
 * Parse an HTTP `Retry-After` header value into milliseconds.
 *
 * Accepts either delta-seconds (e.g. "120") or an HTTP-date, per RFC 7231.
 * Returns the delay clamped to [0, 300000] ms. Returns 0 when the header is
 * absent or invalid, signalling the caller to fall back to computed backoff.
 */
export function parseRetryAfter(headerValue: string | null, now: number): number {
  if (headerValue == null) return 0;
  const value = headerValue.trim();
  if (value === '') return 0;

  // delta-seconds: a non-negative integer.
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds)) return 0;
    return clampRetryAfter(seconds * 1000);
  }

  // HTTP-date: compute the delta from `now`.
  const dateMs = Date.parse(value);
  if (Number.isNaN(dateMs)) return 0;
  const delta = dateMs - now;
  if (delta <= 0) return 0;
  return clampRetryAfter(delta);
}

function clampRetryAfter(ms: number): number {
  if (ms <= 0) return 0;
  return Math.min(ms, RETRY_AFTER_MAX_MS);
}
