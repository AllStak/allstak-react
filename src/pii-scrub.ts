/**
 * Value-pattern PII scrubbing.
 *
 * The SDK already redacts by KEY NAME (password / token / cookie / api_key …)
 * in `http-redact.ts`. This module adds VALUE-PATTERN scrubbing for PII that
 * leaks into free-text values (error messages, breadcrumbs, extras, logs, …).
 *
 * Layering (implemented exactly):
 *
 *   A) ALWAYS scrub — regardless of `sendDefaultPii`. High-risk
 *      financial / identity data that is never legitimately wanted in
 *      telemetry:
 *        - Credit-card numbers: 13-19 digit runs (spaces / hyphens allowed
 *          as separators) that PASS the Luhn checksum. Digit runs that FAIL
 *          Luhn are preserved (avoids nuking order ids / timestamps).
 *        - US SSN: `\b\d{3}-\d{2}-\d{4}\b` — the hyphens are REQUIRED so a
 *          bare 9-digit number is never matched.
 *
 *   B) Scrub UNLESS `sendDefaultPii === true` (default false = parity):
 *        - Email addresses.
 *        - IPv4 (octets validated 0-255). IPv6 best-effort.
 *
 * Everything is replaced with `[REDACTED]`.
 *
 * The caller is responsible for the field allowlist (do NOT scrub stack
 * frame paths, release/sdk fields, URLs, the explicit `setUser` object, or
 * the SDK's own `sessionId`). This module only scrubs the string values it
 * is handed.
 *
 * Performance: regexes are compiled once at module load. Recursion depth and
 * scanned-string length are capped; oversized strings are left untouched
 * rather than scanned. Fail-open: any error returns the input unchanged.
 */

import { REDACTED } from './http-redact';

/** Max recursion depth when walking nested metadata/contexts/data. */
const MAX_DEPTH = 8;
/**
 * Strings longer than this are skipped entirely (returned as-is). Free-text
 * telemetry values are small; a multi-KB blob is far more likely to be an
 * encoded body / base64 / minified source than PII, and scanning it with
 * global regexes on the wire path is the expensive case we want to avoid.
 */
const MAX_SCAN_LENGTH = 8192;

export interface ValueScrubOptions {
  /**
   * When true the user has opted into PII collection — the (B) scrubbers
   * (email + IP) are disabled. The (A) scrubbers (CC + SSN) are ALWAYS on.
   * Default false.
   */
  sendDefaultPii?: boolean;
}

// ── Compiled patterns (compile once) ─────────────────────────────

/**
 * Candidate credit-card run: 13-19 digits where single spaces or hyphens
 * may separate digit groups. We then strip separators and Luhn-validate; a
 * run that fails Luhn is left untouched so legitimate long numbers (order
 * ids, epoch-millis pairs, tracking numbers) are NOT corrupted.
 *
 * `\d(?:[ -]?\d){12,18}` = a leading digit followed by 12-18 more digits,
 * each optionally preceded by a single space or hyphen ⇒ 13-19 total digits.
 * Word boundaries keep it from matching inside a longer digit string.
 */
const CC_CANDIDATE = /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g;

/** US SSN — hyphens REQUIRED. A bare 9-digit number is never matched. */
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;

/** Standard email. Deliberately conservative; matches the common shape. */
const EMAIL = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

/** IPv4 with each octet validated to 0-255. */
const IPV4 =
  /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;

/**
 * IPv6 — best-effort, deliberately CONSERVATIVE to avoid corrupting clock
 * times (`12:34:56`, `01:02:03:04`) and similar colon-separated tokens. We
 * match only:
 *   1. the FULL uncompressed form — exactly 8 hex groups, OR
 *   2. a `::`-compressed form — which contains the literal `::` that never
 *      appears in a time string.
 * A bare `a:b:c` (no `::`, fewer than 8 groups) is NOT treated as an address.
 */
const IPV6 =
  /(?<![:.\w])(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}(?![:.\w])|(?<![:.\w])(?:[0-9a-fA-F]{1,4})?::(?:[0-9a-fA-F]{1,4}:?){0,7}[0-9a-fA-F]{0,4}(?![:.\w])/g;

/** Authorization/token values in free text. Always scrubbed. */
const BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const JWT_VALUE = /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;

const SENSITIVE_KEY_PARTS = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'password',
  'passwd',
  'passphrase',
  'secret',
  'token',
  'api-key',
  'api_key',
  'apikey',
  'access-token',
  'access_token',
  'refresh-token',
  'refresh_token',
  'id-token',
  'id_token',
  'jwt',
  'bearer',
  'private-key',
  'private_key',
  'client-secret',
  'client_secret',
];

function normalizedKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[.\s]+/g, '-')
    .toLowerCase();
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

/**
 * Luhn checksum. Operates on a digits-only string. Returns false for empty
 * or out-of-range lengths so the regex candidate is rejected cheaply.
 */
function luhnValid(digits: string): boolean {
  const len = digits.length;
  if (len < 13 || len > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = len - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48; // '0' === 48
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Scrub a single string value. Applies (A) always, (B) only when
 * `sendDefaultPii` is not true. Returns the input unchanged on any error,
 * when it is too long to scan, or when nothing matched.
 */
export function scrubString(input: string, opts: ValueScrubOptions = {}): string {
  if (typeof input !== 'string' || input.length === 0) return input;
  if (input.length > MAX_SCAN_LENGTH) return input;
  try {
    let out = input;

    // (A) Credit cards — only redact runs that pass Luhn.
    if (CC_CANDIDATE.test(out)) {
      CC_CANDIDATE.lastIndex = 0;
      out = out.replace(CC_CANDIDATE, (match) => {
        const digits = match.replace(/[ -]/g, '');
        return luhnValid(digits) ? REDACTED : match;
      });
    }
    CC_CANDIDATE.lastIndex = 0;

    // (A) SSN — hyphens required.
    out = replaceAll(out, SSN);

    // (A) bearer/JWT tokens — credentials are never valid telemetry.
    out = replaceAll(out, BEARER_VALUE);
    out = replaceAll(out, JWT_VALUE);

    // (B) email + IP — only when the user has NOT opted into PII.
    if (opts.sendDefaultPii !== true) {
      out = replaceAll(out, EMAIL);
      out = replaceAll(out, IPV4);
      out = replaceAll(out, IPV6);
    }

    return out;
  } catch {
    return input; // fail-open
  }
}

function replaceAll(input: string, re: RegExp): string {
  re.lastIndex = 0;
  if (!re.test(input)) {
    re.lastIndex = 0;
    return input;
  }
  re.lastIndex = 0;
  const out = input.replace(re, REDACTED);
  re.lastIndex = 0;
  return out;
}

/**
 * Recursively scrub a value (string / array / plain object). Non-string
 * leaves are returned untouched. Mutation-free: arrays and plain objects are
 * rebuilt; the input is never modified in place. Caps recursion at
 * {@link MAX_DEPTH}; deeper structures are returned as-is. Fail-open.
 */
export function scrubDeep<T>(value: T, opts: ValueScrubOptions = {}, depth = 0): T {
  if (value == null) return value;
  if (typeof value === 'string') return scrubString(value, opts) as unknown as T;
  if (typeof value !== 'object') return value; // number / boolean / bigint / symbol
  if (depth >= MAX_DEPTH) return value;

  try {
    if (Array.isArray(value)) {
      let changed = false;
      const next = value.map((v) => {
        const scrubbed = scrubDeep(v, opts, depth + 1);
        if (scrubbed !== v) changed = true;
        return scrubbed;
      });
      return (changed ? (next as unknown as T) : value);
    }

    // Only walk plain objects — skip class instances / exotic objects (Date,
    // RegExp, Map, …) whose internals we shouldn't rewrite.
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;

    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(k)) {
        changed = true;
        out[k] = REDACTED;
        continue;
      }
      const scrubbed = scrubDeep(v, opts, depth + 1);
      if (scrubbed !== v) changed = true;
      out[k] = scrubbed;
    }
    return (changed ? (out as unknown as T) : value);
  } catch {
    return value; // fail-open
  }
}

// ── Event-level scrubbing (allowlist-aware) ──────────────────────

/**
 * Minimal structural shape of the error/message ingest payload this
 * processor operates on. Kept local to avoid a circular import with
 * `client.ts`; only the fields we scrub (or explicitly skip) are listed.
 */
interface ScrubbableBreadcrumb {
  message?: string;
  data?: Record<string, unknown>;
}

export interface ScrubbablePayload {
  message?: string;
  metadata?: Record<string, unknown>;
  breadcrumbs?: ScrubbableBreadcrumb[];
  user?: object;
  requestContext?: object;
  fingerprint?: string[];
  // Fields we DELIBERATELY never touch are not read here, but listing the
  // common ones documents intent for future maintainers:
  //   user (explicit setUser — intentional identification, ships as-is)
  //   frames / stackTrace (filename / function / absPath)
  //   release / sdkName / sdkVersion / dist / environment / platform
  //   traceId / spanId / sessionId / requestId / eventId / fingerprint
  //   requestContext (URLs/paths/host have their own URL redactor)
}

/**
 * Scrub the free-text string values of an error/message event in place-free
 * fashion (returns the same object, with scrubbed sub-trees rebuilt). Only
 * the allowlisted carriers of user-supplied free text are scrubbed:
 *
 *   - `message`            (error/exception message)
 *   - `metadata`           (extras / tags / contexts / per-call context)
 *   - `requestContext`
 *   - `user`               (key/value secrets only; explicit email/id survive)
 *   - `fingerprint`
 *   - `breadcrumbs[].message` + `breadcrumbs[].data`
 *
 * Everything else (frames, release/sdk/version, trace/session ids) is left untouched.
 * Fail-open: any error returns
 * the event unchanged so a scrubber bug can never drop telemetry.
 */
export function scrubEventValues<T extends ScrubbablePayload>(
  event: T,
  opts: ValueScrubOptions = {},
): T {
  if (!event || typeof event !== 'object') return event;
  try {
    if (typeof event.message === 'string') {
      event.message = scrubString(event.message, opts);
    }
    if (event.metadata && typeof event.metadata === 'object') {
      event.metadata = scrubDeep(event.metadata, opts);
    }
    if (event.requestContext && typeof event.requestContext === 'object') {
      event.requestContext = scrubDeep(event.requestContext, opts);
    }
    if (event.user && typeof event.user === 'object') {
      event.user = scrubDeep(event.user, { ...opts, sendDefaultPii: true });
    }
    if (Array.isArray(event.fingerprint)) {
      event.fingerprint = event.fingerprint.map((part) => scrubString(String(part), opts));
    }
    if (Array.isArray(event.breadcrumbs)) {
      event.breadcrumbs = event.breadcrumbs.map((crumb) => {
        if (!crumb || typeof crumb !== 'object') return crumb;
        const next = { ...crumb };
        if (typeof next.message === 'string') next.message = scrubString(next.message, opts);
        if (next.data && typeof next.data === 'object') next.data = scrubDeep(next.data, opts);
        return next;
      });
    }
    return event;
  } catch {
    return event; // fail-open
  }
}

/**
 * Build a default value-scrubber event processor. Wired into the SDK's
 * `beforeSend` pipeline so it runs on the wire path for every error/message
 * event. Honors {@link ValueScrubOptions.sendDefaultPii}.
 */
export function makeValueScrubberProcessor<T extends ScrubbablePayload>(
  opts: ValueScrubOptions = {},
): (event: T) => T {
  return (event: T) => scrubEventValues(event, opts);
}
