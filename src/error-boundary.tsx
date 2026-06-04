/**
 * Sentry-compatible `ErrorBoundary` + `withErrorBoundary`.
 *
 * Drop-in for `@sentry/react`'s ErrorBoundary: same prop names, same fallback
 * render-prop signature (`{ error, componentStack, eventId, resetError }`),
 * and the same `beforeCapture(scope, error, componentStack)` hook. Captured
 * errors flow through the AllStak client exactly like an unhandled boundary
 * error (release-health "crashed").
 */

import * as React from 'react';
import { AllStak } from './client';

export interface ErrorBoundaryFallbackProps {
  error: Error;
  componentStack: string;
  eventId: string;
  resetError: () => void;
}

export type FallbackRender = (props: ErrorBoundaryFallbackProps) => React.ReactNode;

/**
 * Lightweight scope handed to `beforeCapture`. Mirrors the subset of the
 * Sentry Scope API people use inside a boundary: tags/contexts/extras/level/
 * fingerprint. Everything set here is forwarded onto the captured event.
 */
export interface ErrorBoundaryScope {
  setTag(key: string, value: string): void;
  setTags(tags: Record<string, string>): void;
  setContext(name: string, ctx: Record<string, unknown> | null): void;
  setExtra(key: string, value: unknown): void;
  setExtras(extras: Record<string, unknown>): void;
  setLevel(level: 'fatal' | 'error' | 'warning' | 'info' | 'debug'): void;
  setFingerprint(fingerprint: string[]): void;
}

export interface ErrorBoundaryProps {
  children?: React.ReactNode;
  /** UI rendered when an error is caught — a node, or a render prop. */
  fallback?: React.ReactNode | FallbackRender;
  /** Called after the error is captured. */
  onError?: (error: Error, componentStack: string, eventId: string) => void;
  /** Called on mount. */
  onMount?: () => void;
  /** Called when the boundary resets (e.g. via `resetError`). */
  onReset?: (error: Error | null, componentStack: string | null, eventId: string | null) => void;
  /** Called on unmount. */
  onUnmount?: (error: Error | null, componentStack: string | null, eventId: string | null) => void;
  /** Mutate the scope (tags/contexts/...) before the event is captured. */
  beforeCapture?: (scope: ErrorBoundaryScope, error: Error, componentStack: string) => void;
  /** Accepted for API parity. AllStak has no feedback widget yet — no-op. */
  showDialog?: boolean;
  dialogOptions?: Record<string, unknown>;
}

interface ErrorBoundaryState {
  error: Error | null;
  componentStack: string | null;
  eventId: string | null;
}

const INITIAL_STATE: ErrorBoundaryState = { error: null, componentStack: null, eventId: null };

function makeEventId(): string {
  const hex = (n: number) => Math.floor(Math.random() * n).toString(16).padStart(1, '0');
  return Array.from({ length: 32 }, () => hex(16)).join('');
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = INITIAL_STATE;

  componentDidMount(): void {
    try {
      this.props.onMount?.();
    } catch {
      /* ignore */
    }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    const componentStack = info.componentStack ?? '';
    const collected: Record<string, unknown> = {
      componentStack,
      source: 'react-error-boundary',
    };

    try {
      if (this.props.beforeCapture) {
        const scope: ErrorBoundaryScope = {
          setTag: (k, v) => { collected[`tag.${k}`] = v; },
          setTags: (tags) => { for (const [k, v] of Object.entries(tags)) collected[`tag.${k}`] = v; },
          setContext: (name, ctx) => { collected[`context.${name}`] = ctx; },
          setExtra: (k, v) => { collected[k] = v; },
          setExtras: (extras) => { Object.assign(collected, extras); },
          setLevel: (level) => { collected.level = level; },
          setFingerprint: (fingerprint) => { collected.fingerprint = fingerprint; },
        };
        this.props.beforeCapture(scope, error, componentStack);
      }
    } catch {
      /* a broken beforeCapture must never swallow the error */
    }

    // Capture and use the REAL ingested eventId (so a "reference this ID" /
    // feedback flow links to the row that actually lands in the dashboard).
    let eventId = '';
    try {
      AllStak.addBreadcrumb('ui', 'React error boundary caught error', 'error', { componentStack });
      eventId = AllStak.captureException(error, collected) || '';
    } catch {
      /* never break the host app */
    }
    if (!eventId) eventId = makeEventId();

    this.setState({ error, componentStack, eventId });

    try {
      this.props.onError?.(error, componentStack, eventId);
    } catch {
      /* ignore */
    }
  }

  componentWillUnmount(): void {
    try {
      this.props.onUnmount?.(this.state.error, this.state.componentStack, this.state.eventId);
    } catch {
      /* ignore */
    }
  }

  resetErrorBoundary = (): void => {
    try {
      this.props.onReset?.(this.state.error, this.state.componentStack, this.state.eventId);
    } catch {
      /* ignore */
    }
    this.setState(INITIAL_STATE);
  };

  render(): React.ReactNode {
    const { error, componentStack, eventId } = this.state;
    if (error) {
      const { fallback } = this.props;
      if (typeof fallback === 'function') {
        return (fallback as FallbackRender)({
          error,
          componentStack: componentStack ?? '',
          eventId: eventId ?? '',
          resetError: this.resetErrorBoundary,
        });
      }
      if (fallback !== undefined) return fallback;
      return null;
    }
    return this.props.children;
  }
}

/**
 * HOC form: `withErrorBoundary(Component, { fallback, beforeCapture, ... })`.
 */
export function withErrorBoundary<P extends object>(
  WrappedComponent: React.ComponentType<P>,
  errorBoundaryOptions: ErrorBoundaryProps = {},
): React.FC<P> {
  const componentName =
    WrappedComponent.displayName || WrappedComponent.name || 'Component';
  const Wrapped: React.FC<P> = (props) =>
    React.createElement(
      ErrorBoundary,
      errorBoundaryOptions,
      React.createElement(WrappedComponent, props),
    );
  Wrapped.displayName = `errorBoundary(${componentName})`;
  return Wrapped;
}
