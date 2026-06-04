/**
 * Shared route-transaction primitive for the Sentry-compatible browser/router
 * tracing integrations. Emits a REAL `pageload` / `navigation` span (op +
 * route-named description) through the core TracingModule — not a breadcrumb.
 *
 * The span finishes on the next idle tick so any `http.client` spans started
 * while the new route renders attach as children, mirroring Sentry's idle
 * pageload/navigation transactions.
 */

import { AllStak } from './client';

let routerActive = false;
let pageloadEmitted = false;
let historyHooked = false;
let replayRouteHook: ((route: string) => void) | null = null;

/** Register a callback invoked with the route name on every pageload/navigation.
 *  The client uses it to feed the replay timeline + stamp errors with `route`. */
export function setReplayRouteHook(fn: ((route: string) => void) | null): void {
  replayRouteHook = fn;
}

/** Marks that a framework router integration owns navigation spans, so the
 *  generic history-based emitter in `browserTracingIntegration` stands down. */
export function markRouterInstrumentationActive(): void {
  routerActive = true;
}

export function isRouterInstrumentationActive(): boolean {
  return routerActive;
}

function currentRoute(): string {
  try {
    if (typeof location !== 'undefined') return location.pathname || '/';
  } catch {
    /* ignore */
  }
  return '/';
}

interface FinishableSpan {
  finish?: (status?: 'ok' | 'error' | 'timeout', endTimeMillis?: number) => void;
}

/**
 * Emit a pageload (first call) or navigation (subsequent) span for the given
 * route. Fail-open and a no-op when the SDK is not initialized.
 */
export function emitRouteSpan(kind: 'pageload' | 'navigation', name?: string): void {
  if (!AllStak._getInstance()) return;
  const op = kind === 'pageload' && !pageloadEmitted ? 'pageload' : 'navigation';
  pageloadEmitted = true;
  const description = name ?? currentRoute();
  try { replayRouteHook?.(description); } catch { /* never break navigation */ }
  // Each pageload/navigation gets its OWN trace (Sentry parity). Without this
  // every span collapses into one session-long trace, making the waterfall
  // unusable — especially now that navigation spans are auto-on.
  try {
    AllStak.resetTrace();
  } catch {
    /* ignore */
  }
  try {
    const span = AllStak.startSpan(op, {
      op,
      platform: 'web',
      description,
      tags: { route: description, 'routing.instrumentation': 'allstak.react-router' },
    }) as unknown as FinishableSpan;
    const finish = () => {
      try {
        span.finish?.('ok');
      } catch {
        /* ignore */
      }
    };
    // Finish on the next macrotask. Uses setTimeout — NOT requestAnimationFrame
    // — because rAF is paused entirely for hidden/backgrounded tabs, which would
    // silently drop the navigation transaction.
    setTimeout(finish, 0);
  } catch {
    /* never break navigation */
  }
}

/**
 * Generic, router-agnostic navigation spans: wrap `history.pushState` /
 * `replaceState` and listen for `popstate`. Used by `browserTracingIntegration`
 * when no framework router integration is wired. Idempotent.
 */
export function installHistoryNavigationSpans(): void {
  if (historyHooked) return;
  if (typeof window === 'undefined' || typeof history === 'undefined') return;
  historyHooked = true;
  const fire = () => emitRouteSpan('navigation');
  const wrap = (method: 'pushState' | 'replaceState') => {
    const orig = history[method];
    if (typeof orig !== 'function') return;
    history[method] = function patched(this: History, ...args: unknown[]): void {
      const ret = (orig as (...a: unknown[]) => unknown).apply(this, args);
      try {
        fire();
      } catch {
        /* ignore */
      }
      return ret as void;
    } as History[typeof method];
  };
  wrap('pushState');
  wrap('replaceState');
  window.addEventListener('popstate', fire);
}

/** @internal — reset module state between tests. */
export function __resetRouteTracingForTest(): void {
  routerActive = false;
  pageloadEmitted = false;
  historyHooked = false;
}
