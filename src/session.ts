/**
 * Release-health "one session per process / app-launch".
 *
 * On {@link SessionTracker.start} the SDK posts a `sessions/start` envelope
 * with the SDK's session id, the resolved release, and the SDK identity. On
 * {@link SessionTracker.end} it posts `sessions/end` with the final status +
 * total duration. Errored / crashed transitions are recorded in-memory; only
 * the terminal call performs extra network I/O so per-error latency stays
 * unaffected.
 *
 * One instance per {@link AllStakClient}. Re-entrancy safe: once started a
 * second {@link SessionTracker.start} is a no-op; once ended the tracker does
 * not re-arm. Every method is fail-open — a network or runtime error must
 * never propagate into the host application.
 *
 * Mirrors the AllStak Java SDK `dev.allstak.session.SessionTracker` /
 * `Session` / `SessionStatus` lifecycle and status model.
 */

import type { HttpTransport } from './transport';
import { defaultOfflineStorage, type OfflineStorage } from './offline-store';

const PATH_START = '/ingest/v1/sessions/start';
const PATH_END = '/ingest/v1/sessions/end';
const SESSION_STATE_VERSION = 1;
const SESSION_STATE_PREFIX = 'allstak.session.v1';
const SESSION_STATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_RECOVERY_LOCK_MS = 30_000;
const SESSION_RECOVERY_MAX_ATTEMPTS = 3;

/** Short timeout for the terminal `/sessions/end` POST so shutdown never blocks. */
const SESSION_END_TIMEOUT_MS = 1000;

/**
 * Lifecycle status of a release-health session. Vocabulary matches the
 * AllStak backend's `/ingest/v1/sessions/end` contract and standard
 * release-health conventions:
 *
 *   - `ok`       — session ended normally with at most non-fatal logs.
 *   - `errored`  — at least one HANDLED error landed during the session, but
 *                  the process kept running.
 *   - `crashed`  — an UNHANDLED / fatal exception ended the session.
 *   - `abnormal` — ended without a normal flush. Reserved for future use.
 */
export type SessionStatus = 'ok' | 'errored' | 'crashed' | 'abnormal';

/** Identity + context posted alongside `sessions/start`. */
export interface SessionContext {
  /** Resolved release (callers fall back to sdkVersion when no release). */
  release?: string;
  environment?: string;
  /** Resolves the current user id lazily — a user may be set after init. */
  getUserId?: () => string | undefined;
  sdkName?: string;
  sdkVersion?: string;
  platform?: string;
}

interface PersistedSessionState {
  version: 1;
  sessionId: string;
  startedAt: number;
  updatedAt: number;
  status: SessionStatus;
  release?: string;
  environment?: string;
  userId?: string;
  sdkName?: string;
  sdkVersion?: string;
  platform?: string;
  closed?: boolean;
  endedAt?: number;
  recoveryAttempts?: number;
  recoveryLockOwner?: string;
  recoveryLockUntil?: number;
  recoveredAt?: number;
}

export interface SessionTrackerOptions {
  storage?: OfflineStorage | null;
  storageKey?: string;
}

/**
 * A single release-health session. Mutable status so handled/unhandled
 * captures can escalate it without per-error I/O. Mirrors the Java `Session`.
 */
class Session {
  readonly id: string;
  readonly startedAt: number;
  status: SessionStatus = 'ok';
  errorCount = 0;

  constructor(id: string, startedAt: number) {
    this.id = id;
    this.startedAt = startedAt;
  }

  /**
   * Increment the error counter and bump status to `errored` unless the
   * session has already escalated to a terminal `crashed` status.
   */
  recordError(): void {
    this.errorCount += 1;
    if (this.status === 'ok') this.status = 'errored';
  }

  /** Mark a terminal `crashed` status (overrides `errored`). */
  recordCrash(): void {
    this.status = 'crashed';
    this.errorCount += 1;
  }

  /** Duration from start to now, floored at 0. */
  durationMs(): number {
    return Math.max(0, Date.now() - this.startedAt);
  }
}

export class SessionTracker {
  private active: Session | null = null;
  private ended = false;
  private readonly storage: OfflineStorage | null;
  private readonly storageKey: string;

  constructor(
    private readonly transport: HttpTransport,
    private readonly context: SessionContext,
    /** Reuse the SDK's existing session id so it matches error/event payloads. */
    private readonly sessionId: string,
    options: SessionTrackerOptions = {},
  ) {
    this.storageKey = options.storageKey ?? sessionStorageKey(context);
    this.storage = options.storage === undefined ? defaultOfflineStorage() : options.storage;
  }

  /**
   * Idempotent. Records the start timestamp + in-memory `ok` status and POSTs
   * `/sessions/start`. Sessions are NEVER sampled — always sent (subject only
   * to a resolvable release, which the SDK guarantees via its SDK-version
   * fallback). Fail-open: a transport error never escapes.
   */
  start(): void {
    if (this.active || this.ended) return;
    this.recoverPreviousSession();
    const session = new Session(this.sessionId, Date.now());
    this.active = session;

    const release = this.context.release || this.context.sdkVersion;
    this.writeState({
      version: SESSION_STATE_VERSION,
      sessionId: session.id,
      startedAt: session.startedAt,
      updatedAt: Date.now(),
      status: session.status,
      release,
      environment: this.context.environment,
      userId: this.context.getUserId?.(),
      sdkName: this.context.sdkName,
      sdkVersion: this.context.sdkVersion,
      platform: this.context.platform,
      closed: false,
    });
    if (!release) return; // No release ⇒ keep the in-memory tracker, skip I/O.

    try {
      this.transport.send(PATH_START, {
        sessionId: session.id,
        release,
        environment: this.context.environment,
        userId: this.context.getUserId?.(),
        sdkName: this.context.sdkName,
        sdkVersion: this.context.sdkVersion,
        platform: this.context.platform,
      });
    } catch {
      /* network/runtime failure must not break SDK init */
    }
  }

  /** The active session or `null` when not started / already ended. */
  current(): Session | null {
    return this.ended ? null : this.active;
  }

  /** Record a HANDLED error against the active session. No I/O. */
  recordError(): void {
    const session = this.current();
    session?.recordError();
    if (session) this.updateOpenState(session);
  }

  /** Record an UNHANDLED / fatal crash. No I/O — the end POST carries it. */
  recordCrash(): void {
    const session = this.current();
    session?.recordCrash();
    if (session) this.updateOpenState(session);
  }

  /** Current in-memory status, for assertions/tests. */
  getStatus(): SessionStatus | null {
    return this.active ? this.active.status : null;
  }

  /**
   * Terminate the session and POST `/sessions/end` (best-effort, short
   * timeout). Idempotent. When `finalStatus` is omitted the session's own
   * accumulated status is used. Fail-open.
   */
  end(finalStatus?: SessionStatus): void {
    if (this.ended) return;
    const session = this.active;
    this.active = null;
    if (!session) return;
    this.ended = true;

    const release = this.context.release || this.context.sdkVersion;
    const status = finalStatus ?? session.status;
    this.writeState({
      version: SESSION_STATE_VERSION,
      sessionId: session.id,
      startedAt: session.startedAt,
      updatedAt: Date.now(),
      status,
      release,
      environment: this.context.environment,
      userId: this.context.getUserId?.(),
      sdkName: this.context.sdkName,
      sdkVersion: this.context.sdkVersion,
      platform: this.context.platform,
      closed: true,
      endedAt: Date.now(),
    });
    if (!release) return; // matched the start-time skip — nothing was opened server-side

    try {
      this.transport.send(PATH_END, {
        sessionId: session.id,
        durationMs: session.durationMs(),
        status,
      }, { timeoutMs: SESSION_END_TIMEOUT_MS });
    } catch {
      /* shutdown must not throw */
    }
  }

  private recoverPreviousSession(): void {
    const previous = this.readState();
    if (!previous) return;

    const now = Date.now();
    if (previous.closed) {
      this.removeState();
      return;
    }
    if (now - previous.startedAt > SESSION_STATE_MAX_AGE_MS) {
      this.removeState();
      return;
    }
    if ((previous.recoveryAttempts ?? 0) >= SESSION_RECOVERY_MAX_ATTEMPTS) {
      this.removeState();
      return;
    }
    if (previous.recoveryLockUntil && previous.recoveryLockUntil > now) return;

    const owner = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const locked: PersistedSessionState = {
      ...previous,
      recoveryAttempts: (previous.recoveryAttempts ?? 0) + 1,
      recoveryLockOwner: owner,
      recoveryLockUntil: now + SESSION_RECOVERY_LOCK_MS,
      updatedAt: now,
    };
    this.writeState(locked);
    const claimed = this.readState();
    if (!claimed || claimed.recoveryLockOwner !== owner) return;

    const status: SessionStatus = previous.status === 'crashed' ? 'crashed' : 'abnormal';
    try {
      this.transport.send(PATH_END, {
        sessionId: previous.sessionId,
        durationMs: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, (previous.updatedAt || now) - previous.startedAt)),
        status,
      }, { timeoutMs: SESSION_END_TIMEOUT_MS });
      this.writeState({
        ...locked,
        status,
        closed: true,
        endedAt: now,
        recoveredAt: now,
        recoveryLockUntil: undefined,
      });
    } catch {
      this.writeState({
        ...locked,
        recoveryLockUntil: 0,
      });
    }
  }

  private updateOpenState(session: Session): void {
    const current = this.readState();
    if (!current || current.sessionId !== session.id || current.closed) return;
    this.writeState({
      ...current,
      status: session.status,
      updatedAt: Date.now(),
      userId: this.context.getUserId?.(),
    });
  }

  private readState(): PersistedSessionState | null {
    if (!this.storage) return null;
    try {
      const raw = this.storage.getItem(this.storageKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!isPersistedSessionState(parsed)) {
        this.removeState();
        return null;
      }
      return parsed;
    } catch {
      this.removeState();
      return null;
    }
  }

  private writeState(state: PersistedSessionState): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(this.storageKey, JSON.stringify(state));
    } catch {
      /* fail-open */
    }
  }

  private removeState(): void {
    if (!this.storage) return;
    try {
      this.storage.removeItem(this.storageKey);
    } catch {
      /* ignore */
    }
  }
}

function isPersistedSessionState(value: unknown): value is PersistedSessionState {
  if (!value || typeof value !== 'object') return false;
  const s = value as Partial<PersistedSessionState>;
  return (
    s.version === SESSION_STATE_VERSION &&
    typeof s.sessionId === 'string' &&
    s.sessionId.length > 0 &&
    typeof s.startedAt === 'number' &&
    Number.isFinite(s.startedAt) &&
    typeof s.updatedAt === 'number' &&
    Number.isFinite(s.updatedAt) &&
    (s.status === 'ok' || s.status === 'errored' || s.status === 'crashed' || s.status === 'abnormal')
  );
}

function sessionStorageKey(context: SessionContext): string {
  return `${SESSION_STATE_PREFIX}.${stableHash([
    context.release ?? '',
    context.sdkName ?? '',
    context.sdkVersion ?? '',
    context.platform ?? '',
  ].join('|'))}`;
}

function stableHash(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
