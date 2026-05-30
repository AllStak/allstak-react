/**
 * @allstak/react — standalone React SDK.
 *
 * Self-contained: no @allstak/js or @allstak-io/* dependencies. Ships its own
 * AllStak client (init/capture/breadcrumbs/transport) plus React-specific
 * helpers (Provider, ErrorBoundary, useAllStak hook, withAllStakProfiler HOC).
 *
 * Recommended usage (one-liner):
 *
 *   import { AllStakProvider } from '@allstak/react';
 *
 *   export function App() {
 *     return (
 *       <AllStakProvider apiKey="ask_live_..." environment="production" debug>
 *         <AppRoot />
 *       </AllStakProvider>
 *     );
 *   }
 *
 * Advanced / manual usage:
 *
 *   import { AllStak } from '@allstak/react';
 *   AllStak.init({ apiKey, environment, release });
 *   <AllStakErrorBoundary>...</AllStakErrorBoundary>
 *   const { captureException } = useAllStak();
 */

import * as React from 'react';
import { AllStak } from './client';

// ── Primary API: AllStakProvider (recommended) ──────────────────
export {
  AllStakProvider,
  useAllStak,
  __resetProviderInstanceForTest,
} from './provider';
export type { AllStakProviderProps } from './provider';

// ── Core client + manual setup ──────────────────────────────────
export { AllStak } from './client';
export type { AllStakConfig, Breadcrumb, ErrorEventProcessor, SdkDiagnostics } from './client';
export type { TransportStats } from './transport';
export { AllStakClient, INGEST_HOST, SDK_NAME, SDK_VERSION, Scope, __setForceSessionTrackingForTest } from './client';
export { parseGitRelease, resolveRelease, releaseFromEnv, isNodeRuntime, __resetGitReleaseCacheForTest } from './release-detect';
export type { GitRunner } from './release-detect';
export { capturePrivacySafeScreenshot } from './screenshot';
export type { ScreenshotCapture, ScreenshotCaptureOptions, ScreenshotRedactionMode } from './screenshot';

// ── Navigation helpers ──────────────────────────────────────────
export { instrumentBrowserNavigation, instrumentReactRouter, instrumentNextRouter } from './navigation';

// ── Auto-breadcrumb helpers ─────────────────────────────────────
export {
  instrumentFetch,
  instrumentConsole,
  instrumentClicks,
  __resetConsoleInstrumentationFlagForTest,
  __resetClickInstrumentationFlagForTest,
} from './auto-breadcrumbs';
export type { BeforeBreadcrumb, ClickBreadcrumbOptions, ConsoleCaptureOptions } from './auto-breadcrumbs';

// ── Web Vitals ──────────────────────────────────────────────────
export { startWebVitals, __resetWebVitalsFlagForTest } from './web-vitals';
export type { WebVitalsHandle, VitalsReporter } from './web-vitals';

// ── Replay surrogate ────────────────────────────────────────────
export { ReplayRecorder } from './replay';
export type { ReplayOptions } from './replay';

// ── HTTP tracking ───────────────────────────────────────────────
export type { HttpTrackingOptions } from './http-redact';
export { HttpRequestModule } from './http-requests';
export type { HttpRequestEvent } from './http-requests';

// ── Value-pattern PII scrubbing ─────────────────────────────────
// `sendDefaultPii` (AllStakConfig) toggles email/IP scrubbing (default
// false). CC (Luhn-valid) + SSN are always scrubbed. The
// scrubbers are exported for unit tests and advanced/custom processors.
export {
  scrubString,
  scrubDeep,
  scrubEventValues,
  makeValueScrubberProcessor,
} from './pii-scrub';
export type { ValueScrubOptions, ScrubbablePayload } from './pii-scrub';

// ── Transport internals (test surface) ──────────────────────────
// Exposed for unit-testing the Retry-After parser. Not part of the
// public API contract.
export { parseRetryAfter as __parseRetryAfterForTest } from './transport';

// ── Offline / persistent event queue ────────────────────────────
// `OfflineStore` is wired automatically by the client (default ON in the
// browser). Exported so RN/host code can supply a custom backing storage
// (`OfflineStorage`) via `offlineStorage`, and for unit tests.
export { OfflineStore, defaultOfflineStorage } from './offline-store';
export type { OfflineStorage, PersistedEvent, OfflineStoreOptions } from './offline-store';

// ── Release-health session tracking (test surface) ──────────────
// `SessionTracker` is wired automatically by the client; exported for
// unit-testing the start/end payload shape + status transitions.
export { SessionTracker } from './session';
export type { SessionStatus, SessionContext } from './session';

// namespace-compatible namespace import support:
//
//   import * as AllStak from '@allstak/react';
//   AllStak.init({ apiKey: 'ask_live_...' });
//
// The `apiKey` name is intentional and remains the AllStak project identity.
export const init = AllStak.init;
export const captureException = AllStak.captureException;
export const captureMessage = AllStak.captureMessage;
export const logger = AllStak.logger;
export const startSpan = AllStak.startSpan;
export const addBreadcrumb = AllStak.addBreadcrumb;
export const clearBreadcrumbs = AllStak.clearBreadcrumbs;
export const setUser = AllStak.setUser;
export const setTag = AllStak.setTag;
export const setTags = AllStak.setTags;
export const setExtra = AllStak.setExtra;
export const setExtras = AllStak.setExtras;
export const addEventProcessor = AllStak.addEventProcessor;
export const setContext = AllStak.setContext;
export const setLevel = AllStak.setLevel;
export const setFingerprint = AllStak.setFingerprint;
export const flush = AllStak.flush;
export const withScope = AllStak.withScope;
export const getCurrentScope = AllStak.getCurrentScope;
export const configureScope = AllStak.configureScope;
export const getTraceId = AllStak.getTraceId;
export const setTraceId = AllStak.setTraceId;
export const continueTrace = AllStak.continueTrace;
export const getCurrentSpanId = AllStak.getCurrentSpanId;
export const resetTrace = AllStak.resetTrace;
export const instrumentAxios = AllStak.instrumentAxios;
export const getSessionId = AllStak.getSessionId;
export const getConfig = AllStak.getConfig;
export const destroy = AllStak.destroy;

export interface ReactRootErrorInfo {
  componentStack?: string;
  digest?: string;
  [key: string]: unknown;
}

export type ReactRootErrorCallback = (error: unknown, errorInfo: ReactRootErrorInfo) => void;

/**
 * React 19 root error hook adapter, matching familiar React error-hook setup shape:
 *
 *   createRoot(container, {
 *     onUncaughtError: AllStak.reactErrorHandler(),
 *     onCaughtError: AllStak.reactErrorHandler(),
 *     onRecoverableError: AllStak.reactErrorHandler(),
 *   });
 */
export function reactErrorHandler(callback?: ReactRootErrorCallback): ReactRootErrorCallback {
  return (error: unknown, errorInfo: ReactRootErrorInfo = {}) => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    try {
      AllStak.captureException(normalized, {
        source: 'react.root.error-handler',
        componentStack: errorInfo.componentStack ?? '',
        ...(errorInfo.digest ? { digest: errorInfo.digest } : {}),
      });
    } catch { /* never break React's error flow */ }
    try { callback?.(error, errorInfo); } catch { /* match fail-open SDK behavior */ }
  };
}

// ── ErrorBoundary (legacy standalone — provider's boundary is preferred) ──

export interface AllStakErrorBoundaryProps {
  children: React.ReactNode;
  fallback?:
    | React.ReactNode
    | ((props: { error: Error; reset: () => void }) => React.ReactNode);
  /** Extra tags attached only to errors captured by this boundary. */
  tags?: Record<string, string>;
  /** Called after the error has been captured. */
  onError?: (error: Error, info: React.ErrorInfo) => void;
}

interface AllStakErrorBoundaryState {
  error: Error | null;
}

export class AllStakErrorBoundary extends React.Component<
  AllStakErrorBoundaryProps,
  AllStakErrorBoundaryState
> {
  state: AllStakErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AllStakErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    try {
      AllStak.addBreadcrumb('ui', 'React error boundary caught error', 'error', {
        componentStack: info.componentStack ?? '',
      });
      const context: Record<string, unknown> = {
        componentStack: info.componentStack ?? '',
        source: 'react-error-boundary',
      };
      if (this.props.tags) {
        for (const [k, v] of Object.entries(this.props.tags)) {
          context[`tag.${k}`] = v;
        }
      }
      AllStak.captureException(error, context);
    } catch { /* never break the host app */ }
    try { this.props.onError?.(error, info); } catch { /* ignore */ }
  }

  private reset = () => this.setState({ error: null });

  render(): React.ReactNode {
    if (this.state.error) {
      const { fallback } = this.props;
      if (typeof fallback === 'function') {
        return fallback({ error: this.state.error, reset: this.reset });
      }
      if (fallback !== undefined) return fallback;
      return null;
    }
    return this.props.children;
  }
}

/**
 * HOC: drops a navigation breadcrumb when a component mounts. Useful
 * for marking screen boundaries without a router.
 */
export function withAllStakProfiler<P extends object>(
  Component: React.ComponentType<P>,
  name?: string,
): React.FC<P> {
  const displayName =
    name ?? Component.displayName ?? Component.name ?? 'AnonymousComponent';
  const Wrapped: React.FC<P> = (props) => {
    React.useEffect(() => {
      AllStak.addBreadcrumb('navigation', `Mounted <${displayName}>`, 'info');
    }, []);
    return React.createElement(Component, props);
  };
  Wrapped.displayName = `withAllStakProfiler(${displayName})`;
  return Wrapped;
}
