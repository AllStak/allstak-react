/**
 * Sentry-compatible React component profiling: `Profiler`, `withProfiler`,
 * `useProfiler`.
 *
 * Unlike the legacy `withAllStakProfiler` (which only dropped a mount
 * breadcrumb), these emit REAL performance spans through the core
 * TracingModule:
 *   - `ui.react.mount`  — first render → commit (initial mount cost)
 *   - `ui.react.update` — each subsequent render → commit (re-render cost)
 *
 * Spans carry `react.component=<name>` so they group by component in the
 * performance dashboard, matching Sentry's component-tracking model.
 */

import * as React from 'react';
import { AllStak } from './client';

const MOUNT_OP = 'ui.react.mount';
const UPDATE_OP = 'ui.react.update';

interface FinishableSpan {
  finish?: (status?: 'ok' | 'error' | 'timeout', endTimeMillis?: number) => void;
}

function spanFor(op: string, name: string, startTimeMillis: number): void {
  if (!AllStak._getInstance()) return;
  try {
    const span = AllStak.startSpan(op, {
      op,
      platform: 'web',
      description: `<${name}>`,
      startTimeMillis,
      tags: { 'react.component': name },
    }) as unknown as FinishableSpan;
    span.finish?.('ok');
  } catch {
    /* never break render */
  }
}

export interface UseProfilerOptions {
  /** Disable profiling for this component. */
  disabled?: boolean;
  /** Emit `ui.react.update` spans on re-render. Default: true. */
  includeUpdates?: boolean;
}

/**
 * Hook form. Records a mount span on first commit and (optionally) an update
 * span on each subsequent commit.
 */
export function useProfiler(name: string, options: UseProfilerOptions = {}): void {
  const { disabled = false, includeUpdates = true } = options;
  // Captured fresh on every render: the moment this render started.
  const renderStart = Date.now();
  const firstRenderStart = React.useRef(renderStart);
  const mounted = React.useRef(false);

  // No dependency array — runs after every commit, so we can time both the
  // initial mount and each update.
  React.useEffect(() => {
    if (disabled) return;
    if (!mounted.current) {
      mounted.current = true;
      spanFor(MOUNT_OP, name, firstRenderStart.current);
    } else if (includeUpdates) {
      spanFor(UPDATE_OP, name, renderStart);
    }
  });
}

export interface ProfilerProps {
  name: string;
  disabled?: boolean;
  /** Emit update spans on re-render. Default: true. */
  includeUpdates?: boolean;
  /** Accepted for API parity (the mount span already covers initial render). */
  includeRender?: boolean;
  /** Accepted for API parity. */
  updateProps?: Record<string, unknown>;
  children?: React.ReactNode;
}

export function Profiler(props: ProfilerProps): React.ReactElement {
  useProfiler(props.name, { disabled: props.disabled, includeUpdates: props.includeUpdates });
  return React.createElement(React.Fragment, null, props.children);
}

export interface WithProfilerOptions {
  name?: string;
  disabled?: boolean;
  includeUpdates?: boolean;
  includeRender?: boolean;
}

export function withProfiler<P extends object>(
  WrappedComponent: React.ComponentType<P>,
  options: WithProfilerOptions = {},
): React.FC<P> {
  const name =
    options.name || WrappedComponent.displayName || WrappedComponent.name || 'Unknown';
  const Wrapped: React.FC<P> = (props) =>
    React.createElement(
      Profiler,
      { name, disabled: options.disabled, includeUpdates: options.includeUpdates },
      React.createElement(WrappedComponent, props),
    );
  Wrapped.displayName = `profiler(${name})`;
  return Wrapped;
}
