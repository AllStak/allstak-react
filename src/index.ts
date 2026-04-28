/**
 * @allstak/react — standalone React SDK.
 *
 * Self-contained: no @allstak/js or @allstak-io/* dependencies. Ships its own
 * AllStak client (init/capture/breadcrumbs/transport) plus React-specific
 * helpers (ErrorBoundary, useAllStak hook, withAllStakProfiler HOC).
 *
 * Usage:
 *   AllStak.init({ apiKey, environment, release });
 *   <AllStakErrorBoundary>...</AllStakErrorBoundary>
 *   const { captureException } = useAllStak();
 */

import * as React from 'react';
import { AllStak } from './client';

export { AllStak } from './client';
export type { AllStakConfig, Breadcrumb } from './client';
export { AllStakClient, INGEST_HOST, SDK_NAME, SDK_VERSION } from './client';

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
 * Convenience hook — exposes the most common capture/context APIs with a
 * stable identity so components don't have to import the namespace.
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
      addBreadcrumb: (
        type: string,
        message: string,
        level?: string,
        data?: Record<string, unknown>,
      ) => AllStak.addBreadcrumb(type, message, level, data),
    }),
    [],
  );
}

/**
 * HOC: drops a navigation breadcrumb when a component mounts. Useful for
 * marking screen boundaries without a router.
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
