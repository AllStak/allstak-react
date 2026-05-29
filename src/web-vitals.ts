/**
 * Lightweight Web Vitals collection via the browser's PerformanceObserver.
 *
 * Captures CLS, LCP, INP, FCP, TTFB without pulling in the `web-vitals`
 * package as a runtime dependency. On the standard reporting moment
 * (visibilitychange→hidden / pagehide) every collected metric is handed
 * to the reporter as a single uppercase-keyed map so the caller can ship
 * it as one `web.vital` SPAN with a `measurements` map — that is the wire
 * shape the backend reads for the web-vitals dashboard (op='web.vital').
 *
 * Privacy: only numeric values + the metric name are sent. No URLs,
 * referrers, or user-identifiable data.
 *
 * Browser compatibility: PerformanceObserver is available in every
 * evergreen browser (Chrome 51+, Safari 11+, Firefox 57+, Edge 79+).
 * Older browsers silently no-op via the `typeof PerformanceObserver`
 * guard.
 *
 *   - **CLS** (Cumulative Layout Shift) — layout-shift entries with
 *     `hadRecentInput=false`, summed for the session
 *   - **LCP** (Largest Contentful Paint) — biggest paint entry's startTime
 *   - **INP** (Interaction to Next Paint) — longest event-timing duration
 *   - **FCP** (First Contentful Paint) — first paint named `first-contentful-paint`
 *   - **TTFB** (Time to First Byte) — `responseStart` from the navigation
 *     timing entry
 */

/**
 * Receives the finalized Web Vitals as a single map of uppercase metric
 * names → numeric values (only the metrics that were actually collected
 * are present). Called at most once per page (guarded against
 * double-send). The caller is expected to emit this as a `web.vital` span
 * with the map as its `measurements`.
 */
export type VitalsReporter = (metrics: Record<string, number>) => void;

const FLAG = '__allstak_web_vitals_started__';

export interface WebVitalsHandle {
  /** Disconnects all observers. Idempotent. */
  destroy(): void;
}

/**
 * Start collecting Web Vitals. Returns a handle whose `destroy()` cleans
 * up all PerformanceObservers. Safe no-op on non-browser runtimes.
 *
 * The `report` callback is invoked once, on the first hide/unload signal,
 * with the full set of collected metrics in a single uppercase-keyed map
 * (e.g. `{ LCP, CLS, INP, FCP, TTFB }`) so the caller can emit a single
 * `web.vital` span.
 */
export function startWebVitals(report: VitalsReporter): WebVitalsHandle {
  const noop: WebVitalsHandle = { destroy: () => {} };
  if (typeof window === 'undefined') return noop;
  if (typeof PerformanceObserver === 'undefined') return noop;
  if ((window as any)[FLAG]) return noop;
  (window as any)[FLAG] = true;

  const observers: PerformanceObserver[] = [];

  // ── LCP ──────────────────────────────────────────────────────────
  // Reports the LCP value when the page is hidden or unloaded.
  let lastLcp = 0;
  try {
    const obs = new PerformanceObserver((list) => {
      const entries = list.getEntries();
      const last = entries[entries.length - 1] as any;
      if (last && typeof last.startTime === 'number') {
        lastLcp = last.startTime;
      }
    });
    obs.observe({ type: 'largest-contentful-paint', buffered: true } as any);
    observers.push(obs);
  } catch { /* unsupported entry type */ }

  // ── CLS ──────────────────────────────────────────────────────────
  let cls = 0;
  try {
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as any[]) {
        if (!entry.hadRecentInput && typeof entry.value === 'number') {
          cls += entry.value;
        }
      }
    });
    obs.observe({ type: 'layout-shift', buffered: true } as any);
    observers.push(obs);
  } catch { /* unsupported */ }

  // ── INP ──────────────────────────────────────────────────────────
  let maxInteraction = 0;
  try {
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as any[]) {
        if (typeof entry.duration === 'number' && entry.duration > maxInteraction) {
          maxInteraction = entry.duration;
        }
      }
    });
    // 'event' includes both keyboard and pointer events; durationThreshold
    // 40ms keeps observer overhead low on busy pages.
    obs.observe({ type: 'event', buffered: true, durationThreshold: 40 } as any);
    observers.push(obs);
  } catch { /* unsupported */ }

  // ── FCP ──────────────────────────────────────────────────────────
  let fcp = 0;
  try {
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.name === 'first-contentful-paint') {
          fcp = entry.startTime;
        }
      }
    });
    obs.observe({ type: 'paint', buffered: true } as any);
    observers.push(obs);
  } catch { /* unsupported */ }

  // ── TTFB ─────────────────────────────────────────────────────────
  // From the navigation timing entry: responseStart is the time-to-first-byte
  // relative to navigation start.
  const readTtfb = (): number | null => {
    try {
      const navEntry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      if (navEntry && typeof navEntry.responseStart === 'number') {
        return Math.max(0, navEntry.responseStart);
      }
    } catch { /* ignore */ }
    return null;
  };

  // Final flush on hide/unload — this is when LCP/CLS/INP are most
  // accurate (after the page is done interacting). Guarded so we emit at
  // most one span per page even if both visibilitychange and pagehide fire.
  let sent = false;
  const finalize = (): void => {
    if (sent) return;
    sent = true;
    const metrics: Record<string, number> = {};
    if (lastLcp > 0) metrics.LCP = lastLcp;
    metrics.CLS = cls;
    if (maxInteraction > 0) metrics.INP = maxInteraction;
    if (fcp > 0) metrics.FCP = fcp;
    const ttfb = readTtfb();
    if (ttfb != null) metrics.TTFB = ttfb;
    try { report(metrics); } catch { /* never break on report */ }
  };

  // visibilitychange is the most reliable signal — pagehide / unload
  // can be unreliable on mobile Safari but visibilitychange always
  // fires before either. We intentionally do NOT use unload (deprecated
  // and disables back/forward cache).
  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') finalize();
  };
  document.addEventListener('visibilitychange', onVisibility);
  // Also try at pagehide for browsers that fire it before visibilitychange.
  const onPagehide = (): void => finalize();
  window.addEventListener('pagehide', onPagehide);

  return {
    destroy: () => {
      for (const o of observers) {
        try { o.disconnect(); } catch { /* ignore */ }
      }
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPagehide);
      (window as any)[FLAG] = false;
    },
  };
}

/** @internal — reset the started flag so tests can re-init. */
export function __resetWebVitalsFlagForTest(): void {
  if (typeof window !== 'undefined') {
    (window as any)[FLAG] = false;
  }
}
