/**
 * Sentry-style release-health "one session per process / app-launch".
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

const PATH_START = '/ingest/v1/sessions/start';
const PATH_END = '/ingest/v1/sessions/end';

/** Short timeout for the terminal `/sessions/end` POST so shutdown never blocks. */
const SESSION_END_TIMEOUT_MS = 1000;

/**
 * Lifecycle status of a release-health session. Vocabulary matches the
 * AllStak backend's `/ingest/v1/sessions/end` contract and Sentry's
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

  constructor(
    private readonly transport: HttpTransport,
    private readonly context: SessionContext,
    /** Reuse the SDK's existing session id so it matches error/event payloads. */
    private readonly sessionId: string,
  ) {}

  /**
   * Idempotent. Records the start timestamp + in-memory `ok` status and POSTs
   * `/sessions/start`. Sessions are NEVER sampled — always sent (subject only
   * to a resolvable release, which the SDK guarantees via its SDK-version
   * fallback). Fail-open: a transport error never escapes.
   */
  start(): void {
    if (this.active || this.ended) return;
    const session = new Session(this.sessionId, Date.now());
    this.active = session;

    const release = this.context.release || this.context.sdkVersion;
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
    this.current()?.recordError();
  }

  /** Record an UNHANDLED / fatal crash. No I/O — the end POST carries it. */
  recordCrash(): void {
    this.current()?.recordCrash();
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
    if (!release) return; // matched the start-time skip — nothing was opened server-side

    const status = finalStatus ?? session.status;
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
}
