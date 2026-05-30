import * as React from 'react';
import { AllStak, AllStakClient } from './client';
import type { AllStakConfig } from './client';

export interface AllStakProviderProps {
  children: React.ReactNode;
  apiKey: string;
  environment?: string;
  release?: string;
  host?: string;
  tunnel?: string;
  user?: { id?: string; email?: string };
  tags?: Record<string, string>;
  debug?: boolean;
  /**
   * Default true (browser). Auto-instrument outbound HTTP for distributed
   * tracing: inject the W3C `traceparent` header on matching calls and emit a
   * lightweight `http.client` span per request, so client→server traces link
   * up with zero per-call code. Bodies/headers are never captured by this
   * path — set {@link enableHttpTracking} to opt into that. Set `false` to
   * disable header propagation + client spans.
   */
  enableDistributedTracing?: boolean;
  /** Default false. Opt into request/response body + header capture on top of distributed tracing. */
  enableHttpTracking?: boolean;
  httpTracking?: AllStakConfig['httpTracking'];
  /** URLs that should receive distributed tracing headers. Defaults to all non-AllStak HTTP calls. */
  tracePropagationTargets?: AllStakConfig['tracePropagationTargets'];
  /**
   * Master switch for the expensive performance samplers (long-task +
   * sampled-stack). Web Vitals and the pageload span ship by default and are
   * NOT gated by this. Set `false` to also drop the pageload span.
   */
  enablePerformance?: boolean;
  captureScreenshotOnError?: AllStakConfig['captureScreenshotOnError'];
  screenshotRedaction?: AllStakConfig['screenshotRedaction'];
  screenshotMaxBytes?: AllStakConfig['screenshotMaxBytes'];
  screenshotUploadTimeoutMs?: AllStakConfig['screenshotUploadTimeoutMs'];
  screenshotSampleRate?: AllStakConfig['screenshotSampleRate'];
  screenshotOnUnhandledOnly?: AllStakConfig['screenshotOnUnhandledOnly'];
  screenshotMaskStyle?: AllStakConfig['screenshotMaskStyle'];
  maskSelectors?: AllStakConfig['maskSelectors'];
  ignoreSelectors?: AllStakConfig['ignoreSelectors'];
  allowSelectors?: AllStakConfig['allowSelectors'];
  beforeScreenshotUpload?: AllStakConfig['beforeScreenshotUpload'];
  /**
   * Per-console-method capture flags. Defaults: warn + error captured,
   * log + info NOT captured (to avoid breadcrumb spam from typical app
   * logging). Set `{ log: true, info: true }` to opt-in.
   */
  captureConsole?: AllStakConfig['captureConsole'];
  sampleRate?: number;
  beforeSend?: AllStakConfig['beforeSend'];
  replay?: AllStakConfig['replay'];
  tracesSampleRate?: number;
  service?: string;
  dist?: string;
  /** Default true. Capture window error + unhandledrejection. */
  autoCaptureBrowserErrors?: boolean;
  /** Default true. Wrap fetch for breadcrumbs. */
  autoBreadcrumbsFetch?: boolean;
  /** Default true. Wrap console for breadcrumbs (per-method via captureConsole). */
  autoBreadcrumbsConsole?: boolean;
  /**
   * Default true. Capture privacy-safe UI click breadcrumbs using selector
   * summaries only; input values and full text are never captured.
   */
  autoBreadcrumbsClick?: boolean;
  beforeBreadcrumb?: AllStakConfig['beforeBreadcrumb'];
  clickBreadcrumbMaxSelectorLength?: AllStakConfig['clickBreadcrumbMaxSelectorLength'];
  /** Default true. Patch history.pushState/replaceState + popstate listener. */
  autoBreadcrumbsNavigation?: boolean;
  /** Default true. Collect Web Vitals via PerformanceObserver. */
  autoWebVitals?: boolean;
  /**
   * Tear down the SDK when the provider unmounts. Default `false`.
   *
   * Most apps mount `AllStakProvider` once at the root and never unmount
   * it. Setting this to `true` risks disabling telemetry if the provider
   * re-mounts (Fast Refresh in dev, route key changes, React 18 Strict
   * Mode double-mount, etc.) — there is a brief window between unmount
   * and remount where captures throw.
   *
   * Leave at the default unless you genuinely need to dispose the SDK.
   */
  destroyOnUnmount?: boolean;
  fallback?:
    | React.ReactNode
    | ((props: { error: Error; resetError: () => void }) => React.ReactNode);
  onError?: (error: Error, componentStack?: string) => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

const AllStakContext = React.createContext<AllStakClient | null>(null);

// Module-level guard so re-mounts of <AllStakProvider> reuse the existing
// singleton instead of destroying + re-creating it (which would briefly
// break captureException calls and clear breadcrumbs).
let __providerOwnedInstance: AllStakClient | null = null;

class AllStakErrorBoundaryInner extends React.Component<
  {
    children: React.ReactNode;
    fallback?: AllStakProviderProps['fallback'];
    onError?: AllStakProviderProps['onError'];
    debug?: boolean;
  },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    try {
      AllStak.addBreadcrumb('ui', 'React error boundary caught error', 'error', {
        componentStack: info.componentStack ?? '',
      });
      AllStak.captureException(error, {
        componentStack: info.componentStack ?? '',
        source: 'AllStakProvider.ErrorBoundary',
      });
      if (this.props.debug) {
        // eslint-disable-next-line no-console
        console.log(`[AllStak] Captured render error: ${error.message}`);
      }
    } catch { /* never break the host app */ }
    try { this.props.onError?.(error, info.componentStack ?? undefined); }
    catch { /* ignore */ }
  }

  private resetError = () => this.setState({ error: null });

  render(): React.ReactNode {
    if (this.state.error) {
      const { fallback } = this.props;
      if (typeof fallback === 'function') {
        return fallback({ error: this.state.error, resetError: this.resetError });
      }
      if (fallback !== undefined) return fallback;
      return null;
    }
    return this.props.children;
  }
}

export function AllStakProvider({
  children,
  apiKey,
  environment,
  release,
  host,
  tunnel,
  user,
  tags,
  debug,
  enableDistributedTracing,
  enableHttpTracking,
  httpTracking,
  tracePropagationTargets,
  enablePerformance,
  captureScreenshotOnError,
  screenshotRedaction,
  screenshotMaxBytes,
  screenshotUploadTimeoutMs,
  screenshotSampleRate,
  screenshotOnUnhandledOnly,
  screenshotMaskStyle,
  maskSelectors,
  ignoreSelectors,
  allowSelectors,
  beforeScreenshotUpload,
  captureConsole,
  sampleRate,
  beforeSend,
  replay,
  tracesSampleRate,
  service,
  dist,
  autoCaptureBrowserErrors,
  autoBreadcrumbsFetch,
  autoBreadcrumbsConsole,
  autoBreadcrumbsClick,
  beforeBreadcrumb,
  clickBreadcrumbMaxSelectorLength,
  autoBreadcrumbsNavigation,
  autoWebVitals,
  destroyOnUnmount = false,
  fallback,
  onError,
}: AllStakProviderProps): React.ReactElement {
  const clientRef = React.useRef<AllStakClient | null>(null);

  if (!clientRef.current) {
    // If a previous provider mount left an instance live, reuse it.
    // Covers React 18 Strict Mode double-mount and Fast Refresh.
    const existing = AllStak._getInstance();
    if (existing && __providerOwnedInstance === existing) {
      clientRef.current = existing;
      if (debug) {
        // eslint-disable-next-line no-console
        console.log(`[AllStak] Reusing session ${AllStak.getSessionId()}`);
      }
    } else {
      const config: AllStakConfig = {
        apiKey,
        environment,
        release,
        host,
        tunnel,
        user,
        tags,
        enableDistributedTracing,
        enableHttpTracking,
        httpTracking,
        tracePropagationTargets,
        enablePerformance,
        captureScreenshotOnError,
        screenshotRedaction,
        screenshotMaxBytes,
        screenshotUploadTimeoutMs,
        screenshotSampleRate,
        screenshotOnUnhandledOnly,
        screenshotMaskStyle,
        maskSelectors,
        ignoreSelectors,
        allowSelectors,
        beforeScreenshotUpload,
        captureConsole,
        sampleRate,
        beforeSend,
        replay,
        tracesSampleRate,
        service,
        dist,
        autoCaptureBrowserErrors,
        autoBreadcrumbsFetch,
        autoBreadcrumbsConsole,
        autoBreadcrumbsClick,
        beforeBreadcrumb,
        clickBreadcrumbMaxSelectorLength,
        autoBreadcrumbsNavigation,
        autoWebVitals,
      };
      clientRef.current = AllStak.init(config);
      __providerOwnedInstance = clientRef.current;

      if (debug) {
        // eslint-disable-next-line no-console
        console.log(`[AllStak] Initialized — session ${AllStak.getSessionId()}`);
        if (autoBreadcrumbsNavigation !== false) {
          // eslint-disable-next-line no-console
          console.log('[AllStak] Navigation auto-instrumentation enabled');
        } else {
          // eslint-disable-next-line no-console
          console.log('[AllStak] Navigation auto-instrumentation not applied; use manual fallback');
        }
      }
    }
  }

  React.useEffect(() => {
    return () => {
      if (destroyOnUnmount) {
        AllStak.destroy();
        __providerOwnedInstance = null;
        clientRef.current = null;
        if (debug) {
          // eslint-disable-next-line no-console
          console.log('[AllStak] Destroyed on unmount');
        }
      }
    };
  }, [destroyOnUnmount, debug]);

  return (
    <AllStakContext.Provider value={clientRef.current}>
      <AllStakErrorBoundaryInner fallback={fallback} onError={onError} debug={debug}>
        {children}
      </AllStakErrorBoundaryInner>
    </AllStakContext.Provider>
  );
}

/**
 * Convenience hook — exposes the most common capture/context APIs with
 * a stable identity so components don't have to import the namespace.
 */
export function useAllStak() {
  return React.useMemo(
    () => ({
      captureException: (error: Error, ctx?: Record<string, unknown>) =>
        AllStak.captureException(error, ctx),
      captureMessage: (
        msg: string,
        level: 'fatal' | 'error' | 'warning' | 'info' = 'info',
      ) => AllStak.captureMessage(msg, level),
      setUser: (user: { id?: string; email?: string }) => AllStak.setUser(user),
      setTag: (key: string, value: string) => AllStak.setTag(key, value),
      setContext: (name: string, ctx: Record<string, unknown> | null) =>
        AllStak.setContext(name, ctx),
      addBreadcrumb: (
        type: string,
        message: string,
        level?: string,
        data?: Record<string, unknown>,
      ) => AllStak.addBreadcrumb(type, message, level, data),
      flush: (timeoutMs?: number) => AllStak.flush(timeoutMs),
    }),
    [],
  );
}

/** @internal — for tests. Resets the module-level remount-guard. */
export function __resetProviderInstanceForTest(): void {
  __providerOwnedInstance = null;
}
