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
export type { AllStakConfig, Breadcrumb } from './client';
export { AllStakClient, INGEST_HOST, SDK_NAME, SDK_VERSION, Scope } from './client';
export { capturePrivacySafeScreenshot } from './screenshot';
export type { ScreenshotCapture, ScreenshotCaptureOptions, ScreenshotRedactionMode } from './screenshot';

// ── Navigation helpers ──────────────────────────────────────────
export { instrumentBrowserNavigation, instrumentReactRouter, instrumentNextRouter } from './navigation';

// ── Auto-breadcrumb helpers ─────────────────────────────────────
export { instrumentFetch, instrumentConsole, __resetConsoleInstrumentationFlagForTest } from './auto-breadcrumbs';
export type { ConsoleCaptureOptions } from './auto-breadcrumbs';

// ── Web Vitals ──────────────────────────────────────────────────
export { startWebVitals, __resetWebVitalsFlagForTest } from './web-vitals';
export type { WebVitalsHandle } from './web-vitals';

// ── Replay surrogate ────────────────────────────────────────────
export { ReplayRecorder } from './replay';
export type { ReplayOptions } from './replay';

// ── HTTP tracking ───────────────────────────────────────────────
export type { HttpTrackingOptions } from './http-redact';
export { HttpRequestModule } from './http-requests';
export type { HttpRequestEvent } from './http-requests';

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
