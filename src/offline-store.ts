/**
 * Offline / persistent event queue for the browser SDK.
 *
 * Goal: buffered telemetry must survive a process/app restart
 * AND a network outage. When the transport cannot deliver an event (offline,
 * retries exhausted, circuit open at shutdown) it writes the *already
 * PII-scrubbed* payload here. On the next SDK init the transport drains the
 * store and re-sends every entry through the normal retry/backoff/circuit
 * pipeline, removing an entry only once it is accepted (2xx) or is permanently
 * undeliverable (4xx other than 429).
 *
 * Privacy: every payload that reaches the transport has already passed through
 * the SDK's PII pipeline — `redactUrl` / `sanitizeHeaders` for HTTP, the
 * screenshot redactor, the user `beforeSend` hook, and event processors all run
 * *before* `transport.send()`. So persisting what the transport receives never
 * writes unredacted data to disk; this store adds no payload of its own.
 *
 * Default mechanism is `localStorage` (a capped JSON array under one key).
 * The backing store is pluggable via {@link OfflineStorage} so RN/test code can
 * inject `AsyncStorage`-style or in-memory storage. If no storage is available
 * (SSR, sandboxed iframe, privacy mode that throws on `localStorage`) every
 * method degrades to a silent no-op — it NEVER throws and NEVER blocks.
 *
 * Bounded by THREE limits, oldest-dropped-first when any is exceeded:
 *   - count   (MAX_ENTRIES, default 50)
 *   - bytes   (MAX_BYTES, default ~1 MB of serialized JSON)
 *   - max age (MAX_AGE_MS, default 48h — stale entries are discarded on read)
 */

/**
 * Minimal synchronous key/value contract — the `localStorage` subset the store
 * needs. RN can supply a thin wrapper around a global `AsyncStorage` cache, or
 * any object exposing these three methods.
 */
export interface OfflineStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** One persisted, already-scrubbed telemetry entry. */
export interface PersistedEvent {
  /** Stable id so a re-sent entry can be removed without re-reading the path. */
  id: string;
  /** Ingest path (e.g. `/ingest/v1/errors`). Session paths are never persisted. */
  path: string;
  /** The PII-scrubbed payload exactly as the transport would POST it. */
  payload: unknown;
  /** Epoch ms when the entry was first persisted (for max-age eviction). */
  ts: number;
}

export interface OfflineStoreOptions {
  /** Backing storage. Defaults to `globalThis.localStorage` when present. */
  storage?: OfflineStorage | null;
  /** localStorage key the JSON array lives under. */
  key?: string;
  /** Max entries kept. Default 50. */
  maxEntries?: number;
  /** Max serialized bytes kept. Default ~1 MB. */
  maxBytes?: number;
  /** Max entry age in ms before it is discarded on read. Default 48h. */
  maxAgeMs?: number;
}

const DEFAULT_KEY = 'allstak.offline.v1';
const DEFAULT_MAX_ENTRIES = 50;
const DEFAULT_MAX_BYTES = 1_000_000; // ~1 MB
const DEFAULT_MAX_AGE_MS = 48 * 60 * 60 * 1000; // 48h

/**
 * Resolve the default backing storage. Reading `globalThis.localStorage` can
 * throw in sandboxed iframes / strict privacy modes, so it is guarded. A probe
 * write confirms the store is actually usable (Safari private mode exposes the
 * object but throws on write).
 */
export function defaultOfflineStorage(): OfflineStorage | null {
  try {
    const ls = (globalThis as { localStorage?: OfflineStorage }).localStorage;
    if (!ls || typeof ls.getItem !== 'function' || typeof ls.setItem !== 'function') return null;
    const probe = '__allstak_probe__';
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return ls;
  } catch {
    return null;
  }
}

export class OfflineStore {
  private readonly storage: OfflineStorage | null;
  private readonly key: string;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly maxAgeMs: number;
  private seq = 0;

  constructor(options: OfflineStoreOptions = {}) {
    // `undefined` ⇒ resolve the platform default; explicit `null` ⇒ disabled.
    this.storage = options.storage === undefined ? defaultOfflineStorage() : options.storage;
    this.key = options.key ?? DEFAULT_KEY;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  }

  /** True when a usable backing store was resolved. */
  isAvailable(): boolean {
    return this.storage != null;
  }

  /**
   * Persist one already-scrubbed entry. Returns the generated id, or `null`
   * when the store is unavailable (caller keeps its in-memory copy). Enforces
   * all three caps, dropping the OLDEST entries first. Fail-open — never throws.
   */
  persist(path: string, payload: unknown): string | null {
    if (!this.storage) return null;
    try {
      const id = `${Date.now().toString(36)}-${(this.seq++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const entries = this.readRaw();
      entries.push({ id, path, payload, ts: Date.now() });
      this.writeBounded(entries);
      return id;
    } catch {
      return null;
    }
  }

  /**
   * Load all live (non-expired) entries, oldest first. Expired entries are
   * dropped from the store as a side effect. Returns `[]` when unavailable.
   */
  load(): PersistedEvent[] {
    if (!this.storage) return [];
    try {
      const entries = this.readRaw();
      const cutoff = Date.now() - this.maxAgeMs;
      const live = entries.filter((e) => e.ts >= cutoff);
      if (live.length !== entries.length) this.write(live);
      return live;
    } catch {
      return [];
    }
  }

  /** Remove a single entry by id (called once it is delivered or dropped). */
  remove(id: string): void {
    if (!this.storage) return;
    try {
      const entries = this.readRaw();
      const next = entries.filter((e) => e.id !== id);
      if (next.length !== entries.length) this.write(next);
    } catch {
      /* fail-open */
    }
  }

  /** Drop everything. */
  clear(): void {
    if (!this.storage) return;
    try {
      this.storage.removeItem(this.key);
    } catch {
      /* fail-open */
    }
  }

  /** Current persisted entry count (post-expiry). For tests/diagnostics. */
  size(): number {
    return this.load().length;
  }

  // ── internals ──────────────────────────────────────────────────

  private readRaw(): PersistedEvent[] {
    if (!this.storage) return [];
    const raw = this.storage.getItem(this.key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Defensively keep only well-formed entries.
    return parsed.filter(
      (e): e is PersistedEvent =>
        e && typeof e.id === 'string' && typeof e.path === 'string' && typeof e.ts === 'number',
    );
  }

  private write(entries: PersistedEvent[]): void {
    if (!this.storage) return;
    if (entries.length === 0) {
      this.storage.removeItem(this.key);
      return;
    }
    this.storage.setItem(this.key, JSON.stringify(entries));
  }

  /**
   * Persist `entries` after enforcing the count + byte caps, dropping the
   * OLDEST first. The serialized size is checked against `maxBytes`; oversized
   * sets shed their head until they fit (or only one entry remains).
   */
  private writeBounded(entries: PersistedEvent[]): void {
    if (!this.storage) return;
    let kept = entries;
    if (kept.length > this.maxEntries) kept = kept.slice(kept.length - this.maxEntries);

    let serialized = JSON.stringify(kept);
    while (serialized.length > this.maxBytes && kept.length > 1) {
      kept = kept.slice(1); // drop oldest
      serialized = JSON.stringify(kept);
    }
    // setItem may still throw (quota) on a single huge entry — let the caller's
    // try/catch swallow it; the entry simply stays in memory.
    this.storage.setItem(this.key, serialized);
  }
}
