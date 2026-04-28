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
