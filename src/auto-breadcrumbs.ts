/**
 * Idempotent instrumentation of `globalThis.fetch`, `console.warn/error`,
 * and safe browser click breadcrumbs
 * to feed breadcrumbs into the AllStak client. Safe to call once at init.
 *
 * - `instrumentFetch`: wraps fetch and records a breadcrumb per request
 *   (success and failure). Skips requests targeting the SDK's own ingest
 *   host so the wrap never recurses. Preserves the original return type
 *   and rethrows fetch errors after the breadcrumb is recorded.
 * - `instrumentConsole`: wraps `console.warn` and `console.error` to
 *   record `log`-type breadcrumbs at the corresponding level.
 *
 * Both patches use a flag on the wrapper function so a second call is a
 * no-op — important because hot-module-reload in dev would otherwise
 * stack patches and double-fire breadcrumbs.
 */

type AddBreadcrumbFn = (
  type: string,
  msg: string,
  level?: string,
  data?: Record<string, unknown>,
) => void;

export interface AutoBreadcrumb {
  type: string;
  message: string;
  level?: string;
  data?: Record<string, unknown>;
}

export type BeforeBreadcrumb = (breadcrumb: AutoBreadcrumb) => AutoBreadcrumb | null | undefined;

const FETCH_FLAG = '__allstak_fetch_patched__';
const CONSOLE_FLAG = '__allstak_console_patched__';
const CLICK_FLAG = '__allstak_click_patched__';

// The HTTP-tracking module (src/http-instrumentation.ts) also wraps
// `globalThis.fetch`, tagging its wrapper with this flag. Both wrappers are
// installed at init (distributed tracing is default-on), so each must carry
// forward the OTHER's flag onto the new top-level function — otherwise a
// second `init()` (Fast Refresh, re-mount) sees a wrapper that lacks its own
// flag and stacks a duplicate, double-firing breadcrumbs / events.
const HTTP_FETCH_FLAG = '__allstak_http_fetch_patched__';

export function instrumentFetch(
  addBreadcrumb: AddBreadcrumbFn,
  ownBaseUrl?: string,
): void {
  const g: any = globalThis as any;
  if (typeof g.fetch !== 'function') return;
  if (g.fetch[FETCH_FLAG]) return;

  const originalFetch = g.fetch;

  const wrapped = async function (this: any, input: any, init?: any) {
    const method = (init?.method || (input && typeof input === 'object' && input.method) || 'GET').toUpperCase();
    let url: string;
    if (typeof input === 'string') url = input;
    else if (input && typeof input.href === 'string') url = input.href;
    else if (input && typeof input.url === 'string') url = input.url;
    else url = String(input);

    // Strip query string from the breadcrumb to avoid leaking secrets.
    const safePath = url.split('?')[0];
    const isOwnIngest = !!(ownBaseUrl && url.startsWith(ownBaseUrl));

    const start = Date.now();
    try {
      const response = await originalFetch.call(this, input, init);
      const durationMs = Date.now() - start;
      if (!isOwnIngest) {
        addBreadcrumb(
          'http',
          `${method} ${safePath} -> ${response.status}`,
          response.status >= 400 ? 'error' : 'info',
          { method, url: safePath, statusCode: response.status, durationMs },
        );
      }
      return response;
    } catch (err) {
      const durationMs = Date.now() - start;
      if (!isOwnIngest) {
        addBreadcrumb('http', `${method} ${safePath} -> failed`, 'error', {
          method, url: safePath, error: String(err), durationMs,
        });
      }
      throw err;
    }
  };
  (wrapped as any)[FETCH_FLAG] = true;
  // Preserve the HTTP-tracking wrapper's flag (if it wrapped first) so it is
  // still visible on the new top-level fetch and never gets re-applied.
  if ((originalFetch as any)[HTTP_FETCH_FLAG]) {
    (wrapped as any)[HTTP_FETCH_FLAG] = true;
  }
  g.fetch = wrapped;
}

/**
 * Per-console-method capture flags. Defaults: warn + error captured,
 * log + info NOT captured (typical React apps emit thousands of debug
 * lines per session — flooding the dashboard with them creates pure
 * noise, so they're opt-in).
 *
 *   <AllStakProvider captureConsole={{ log: true, info: true }} />
 */
export interface ConsoleCaptureOptions {
  log?: boolean;
  info?: boolean;
  warn?: boolean;
  error?: boolean;
}

const CONSOLE_DEFAULTS: Required<ConsoleCaptureOptions> = {
  log: false,
  info: false,
  warn: true,
  error: true,
};

const CONSOLE_METHOD_TO_LEVEL: Record<keyof ConsoleCaptureOptions, string> = {
  log: 'info',
  info: 'info',
  warn: 'warn',
  error: 'error',
};

/** Max bytes per stringified arg. Anything longer is suffixed with `…[truncated]`. */
const MAX_ARG_BYTES = 5000;

export function instrumentConsole(
  addBreadcrumb: AddBreadcrumbFn,
  options: ConsoleCaptureOptions = {},
): void {
  if (typeof console === 'undefined') return;
  if ((console as any)[CONSOLE_FLAG]) return;

  const opts: Required<ConsoleCaptureOptions> = {
    log: options.log ?? CONSOLE_DEFAULTS.log,
    info: options.info ?? CONSOLE_DEFAULTS.info,
    warn: options.warn ?? CONSOLE_DEFAULTS.warn,
    error: options.error ?? CONSOLE_DEFAULTS.error,
  };

  const wrap = (method: keyof ConsoleCaptureOptions): void => {
    const orig = (console as any)[method];
    if (typeof orig !== 'function') return;
    const level = CONSOLE_METHOD_TO_LEVEL[method];
    (console as any)[method] = function (...args: unknown[]) {
      if (opts[method]) {
        try {
          const serialized = args.map(safeStringifyArg);
          const message = truncate(serialized.join(' '));
          addBreadcrumb('log', message, level, {
            category: 'console',
            method,
            args: serialized,
          });
        } catch { /* never break host */ }
      }
      return orig.apply(console, args);
    };
  };

  if (opts.log) wrap('log');
  if (opts.info) wrap('info');
  if (opts.warn) wrap('warn');
  if (opts.error) wrap('error');

  (console as any)[CONSOLE_FLAG] = true;
}

export interface ClickBreadcrumbOptions {
  beforeBreadcrumb?: BeforeBreadcrumb;
  maxSelectorLength?: number;
}

export function instrumentClicks(
  addBreadcrumb: AddBreadcrumbFn,
  options: ClickBreadcrumbOptions = {},
): void {
  const doc = (globalThis as any).document;
  if (!doc || typeof doc.addEventListener !== 'function') return;
  if ((doc as any)[CLICK_FLAG]) return;

  const maxSelectorLength = Math.max(32, options.maxSelectorLength ?? 160);
  const handler = (event: Event) => {
    try {
      const target = closestClickable((event as any).target);
      if (!target || isSensitiveClickable(target)) return;
      const selector = selectorSummary(target, maxSelectorLength);
      if (!selector) return;
      const crumb: AutoBreadcrumb = {
        type: 'ui',
        message: `click ${selector}`,
        level: 'info',
        data: { action: 'click', selector, tag: tagName(target) },
      };
      const finalCrumb = options.beforeBreadcrumb ? options.beforeBreadcrumb(crumb) : crumb;
      if (!finalCrumb) return;
      addBreadcrumb(finalCrumb.type, finalCrumb.message, finalCrumb.level, finalCrumb.data);
    } catch {
      /* never break host */
    }
  };

  doc.addEventListener('click', handler, true);
  (doc as any)[CLICK_FLAG] = true;
}

function closestClickable(target: unknown): Element | null {
  let el = asElement(target);
  while (el) {
    const tag = tagName(el);
    if (
      tag === 'button' ||
      tag === 'a' ||
      tag === 'input' ||
      tag === 'select' ||
      tag === 'textarea' ||
      attr(el, 'role') === 'button' ||
      attr(el, 'data-allstak-click') !== null
    ) {
      return el;
    }
    el = asElement((el as unknown as { parentElement?: unknown }).parentElement);
  }
  return asElement(target);
}

function asElement(value: unknown): Element | null {
  if (!value || typeof value !== 'object') return null;
  const maybe = value as { tagName?: unknown; nodeType?: unknown };
  return typeof maybe.tagName === 'string' || maybe.nodeType === 1 ? value as Element : null;
}

function isSensitiveClickable(el: Element): boolean {
  const tag = tagName(el);
  if (tag !== 'input') return false;
  const type = (attr(el, 'type') ?? '').toLowerCase();
  return type === 'password' || type === 'hidden';
}

function selectorSummary(el: Element, maxLength: number): string {
  const tag = tagName(el) || 'element';
  const parts = [tag];
  const id = cleanSelectorPart(attr(el, 'id'));
  if (id) parts.push(`#${id}`);
  const classes = classNames(el).slice(0, 3).map(cleanSelectorPart).filter(Boolean);
  if (classes.length) parts.push(classes.map((c) => `.${c}`).join(''));
  const role = cleanSelectorPart(attr(el, 'role'));
  if (role) parts.push(`[role="${role}"]`);
  const type = cleanSelectorPart(attr(el, 'type'));
  if (type && tag === 'input') parts.push(`[type="${type}"]`);
  return truncateSelector(parts.join(''), maxLength);
}

function tagName(el: Element): string {
  return ((el as unknown as { tagName?: string }).tagName ?? '').toLowerCase();
}

function attr(el: Element, name: string): string | null {
  try {
    const getter = (el as unknown as { getAttribute?: (n: string) => string | null }).getAttribute;
    if (typeof getter === 'function') return getter.call(el, name);
    const value = (el as unknown as Record<string, unknown>)[name];
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

function classNames(el: Element): string[] {
  try {
    const list = (el as unknown as { classList?: Iterable<string>; className?: unknown }).classList;
    if (list) return Array.from(list).filter((v): v is string => typeof v === 'string');
    const className = (el as unknown as { className?: unknown }).className;
    return typeof className === 'string' ? className.split(/\s+/).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function cleanSelectorPart(value: string | null): string {
  if (!value) return '';
  return value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
}

function truncateSelector(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return value.slice(0, Math.max(0, maxLength - 12)) + '[truncated]';
}

/** @internal — for tests. Resets the wrap-once flag. */
export function __resetConsoleInstrumentationFlagForTest(): void {
  if (typeof console !== 'undefined') {
    delete (console as any)[CONSOLE_FLAG];
  }
}

/** @internal - for tests. Resets the click wrap-once flag. */
export function __resetClickInstrumentationFlagForTest(): void {
  const doc = (globalThis as any).document;
  if (doc) delete (doc as any)[CLICK_FLAG];
}

/**
 * Safely stringify a single console arg. Handles primitives, Errors,
 * arrays, plain objects, and circular references. Falls back to
 * Object.prototype.toString.call(v) on any failure.
 */
function safeStringifyArg(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  if (typeof v === 'symbol') return v.toString();
  if (typeof v === 'function') return `[Function${v.name ? ` ${v.name}` : ''}]`;
  if (v instanceof Error) {
    return `${v.name || 'Error'}: ${v.message}${v.stack ? `\n${v.stack}` : ''}`;
  }
  if (typeof v === 'object') {
    try {
      const seen = new WeakSet<object>();
      const out = JSON.stringify(v, (_key, val) => {
        if (typeof val === 'object' && val !== null) {
          if (seen.has(val as object)) return '[Circular]';
          seen.add(val as object);
        }
        if (typeof val === 'bigint') return val.toString();
        if (typeof val === 'function') return `[Function${val.name ? ` ${val.name}` : ''}]`;
        if (typeof val === 'symbol') return val.toString();
        return val;
      });
      return out ?? Object.prototype.toString.call(v);
    } catch {
      return Object.prototype.toString.call(v);
    }
  }
  return String(v);
}

function truncate(s: string): string {
  if (s.length <= MAX_ARG_BYTES) return s;
  return s.slice(0, MAX_ARG_BYTES) + '…[truncated]';
}
