/**
 * Browser navigation breadcrumbs — minimal fallback that doesn't depend on
 * any specific router library. Wraps `history.pushState`/`replaceState` and
 * listens to `popstate` so SPA navigation transitions appear in the
 * breadcrumb feed regardless of which router (React Router, Next, Remix,
 * none) the app uses.
 *
 * Idempotent — calling twice is safe (the wrappers tag themselves).
 *
 * For framework-specific instrumentation (React Router's `useNavigate`,
 * Next's `router.events`), bind manually with `AllStak.addBreadcrumb`.
 */

type AddBreadcrumbFn = (
  type: string,
  msg: string,
  level?: string,
  data?: Record<string, unknown>,
) => void;

const FLAG = '__allstak_history_patched__';

export function instrumentBrowserNavigation(addBreadcrumb: AddBreadcrumbFn): void {
  if (typeof window === 'undefined' || typeof history === 'undefined') return;
  if ((history as any)[FLAG]) return;

  const emit = (from: string, to: string) => {
    if (from === to) return;
    try { addBreadcrumb('navigation', `${from} -> ${to}`, 'info', { from, to }); }
    catch { /* never break host */ }
  };

  const origPush = history.pushState.bind(history);
  const origReplace = history.replaceState.bind(history);

  history.pushState = function (state: any, unused: string, url?: string | URL | null) {
    const from = location.pathname + location.search;
    const ret = origPush(state, unused, url ?? null);
    emit(from, location.pathname + location.search);
    return ret;
  };
  history.replaceState = function (state: any, unused: string, url?: string | URL | null) {
    const from = location.pathname + location.search;
    const ret = origReplace(state, unused, url ?? null);
    emit(from, location.pathname + location.search);
    return ret;
  };

  let last = location.pathname + location.search;
  window.addEventListener('popstate', () => {
    const next = location.pathname + location.search;
    emit(last, next);
    last = next;
  });

  (history as any)[FLAG] = true;
}

/**
 * React Router v6+ helper. Pass a `Location` object whenever the app's
 * top-level `useLocation()` value changes — usually inside a small effect
 * in the route layout. No hard dependency on `react-router-dom`.
 *
 *   import { useLocation } from 'react-router-dom';
 *   import { instrumentReactRouter } from '@allstak/react';
 *   useEffect(() => instrumentReactRouter(useLocation()), [useLocation()]);
 *
 * Each call records a `navigation` breadcrumb if the path differs from
 * the last one we saw. Idempotent on the same path.
 */
let lastReactRouterPath: string | undefined;
export function instrumentReactRouter(
  location: { pathname: string; search?: string },
  addBreadcrumb: AddBreadcrumbFn = (...args) => __defaultBreadcrumb(...args),
): void {
  const next = `${location.pathname}${location.search ?? ''}`;
  if (next === lastReactRouterPath) return;
  const from = lastReactRouterPath ?? '<initial>';
  lastReactRouterPath = next;
  try { addBreadcrumb('navigation', `${from} -> ${next}`, 'info', { router: 'react-router', from, to: next }); }
  catch { /* ignore */ }
}

/**
 * Next.js (Pages router) helper. Hook into `router.events.on('routeChangeComplete', ...)`
 * inside `_app.tsx` and call this with the new URL. No hard dependency on `next`.
 *
 *   import Router from 'next/router';
 *   import { instrumentNextRouter } from '@allstak/react';
 *   Router.events.on('routeChangeComplete', (url) => instrumentNextRouter(url));
 *
 * For the Next.js App Router, instead use `usePathname()` + `useSearchParams()`
 * and call `instrumentReactRouter({ pathname, search })`.
 */
let lastNextPath: string | undefined;
export function instrumentNextRouter(
  url: string,
  addBreadcrumb: AddBreadcrumbFn = (...args) => __defaultBreadcrumb(...args),
): void {
  if (url === lastNextPath) return;
  const from = lastNextPath ?? '<initial>';
  lastNextPath = url;
  try { addBreadcrumb('navigation', `${from} -> ${url}`, 'info', { router: 'next', from, to: url }); }
  catch { /* ignore */ }
}

// Default forwarder — set by the client at init so callers can pass `addBreadcrumb`
// implicitly. Avoids a circular import on `./client`.
let __defaultBreadcrumb: AddBreadcrumbFn = () => {};
export function __setDefaultBreadcrumbForwarder(fn: AddBreadcrumbFn): void {
  __defaultBreadcrumb = fn;
}
