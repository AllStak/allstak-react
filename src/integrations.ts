/**
 * Sentry-compatible integration model + the non-router integration factories.
 *
 * Mirrors `@sentry/react`'s `integrations: [...]` array so a Sentry React
 * setup can be copied verbatim (apart from the AllStak `apiKey`):
 *
 *   AllStak.init({
 *     apiKey: 'ask_live_...',
 *     integrations: [
 *       browserTracingIntegration(),
 *       replayIntegration(),
 *     ],
 *     tracesSampleRate: 1.0,
 *     replaysSessionSampleRate: 0.1,
 *     replaysOnErrorSampleRate: 1.0,
 *   });
 *
 * An integration can (1) fold its options into the resolved config before the
 * client wires features (`processConfig`), and (2) run side-effects after the
 * client is fully constructed (`setup`). The client processes the
 * `integrations` array in its constructor — see `client.ts`.
 */

import type { AllStakIntegration, AllStakConfig } from './client';
import type { ReplayOptions } from './replay';
import {
  emitRouteSpan,
  installHistoryNavigationSpans,
  isRouterInstrumentationActive,
} from './route-tracing';

export type { AllStakIntegration } from './client';

export interface BrowserTracingOptions {
  /** URLs that should receive distributed-tracing (`traceparent`) headers. */
  tracePropagationTargets?: (string | RegExp)[];
  /** Emit generic history-based navigation spans when no framework router
   *  integration is present. Default: true. */
  instrumentNavigation?: boolean;
  /** Emit a route-named pageload span on initial load. Default: true. */
  instrumentPageLoad?: boolean;
}

/**
 * Performance/tracing integration. The core already emits per-request
 * `http.client` spans + a navigation-timing pageload span by default; this
 * integration guarantees distributed tracing is on, applies
 * `tracePropagationTargets`, and — for non-router apps — emits real
 * `navigation` spans on History changes.
 */
export function browserTracingIntegration(options: BrowserTracingOptions = {}): AllStakIntegration {
  return {
    name: 'BrowserTracing',
    processConfig(config: AllStakConfig) {
      if (config.enableDistributedTracing === undefined) config.enableDistributedTracing = true;
      if (options.tracePropagationTargets && !config.tracePropagationTargets) {
        config.tracePropagationTargets = options.tracePropagationTargets;
      }
      // This integration owns the pageload transaction; suppress the core's
      // default navigation-timing pageload span so there is exactly one.
      if (options.instrumentPageLoad !== false && config.disableCorePageloadSpan === undefined) {
        config.disableCorePageloadSpan = true;
      }
    },
    setup() {
      if (options.instrumentPageLoad !== false && !isRouterInstrumentationActive()) {
        emitRouteSpan('pageload');
      }
      if (options.instrumentNavigation !== false && !isRouterInstrumentationActive()) {
        installHistoryNavigationSpans();
      }
    },
  };
}

export interface ReplayIntegrationOptions {
  /** Probability [0,1] of recording a full session replay. Falls back to the
   *  top-level `replaysSessionSampleRate`. */
  sessionSampleRate?: number;
  /** Probability [0,1] of recording a replay when an error occurs. Falls back
   *  to the top-level `replaysOnErrorSampleRate`. */
  onErrorSampleRate?: number;
  /** Mask all text inputs in the replay. Default: true. */
  maskAllInputs?: boolean;
  maxBufferedEvents?: number;
}

/**
 * Session-replay integration. Maps Sentry's `replayIntegration()` +
 * `replaysSessionSampleRate` / `replaysOnErrorSampleRate` onto the AllStak
 * `replay` recorder config.
 */
export function replayIntegration(options: ReplayIntegrationOptions = {}): AllStakIntegration {
  return {
    name: 'Replay',
    processConfig(config: AllStakConfig) {
      if (config.replay?.enabled) return; // explicit replay config wins
      const sessionRate = options.sessionSampleRate ?? config.replaysSessionSampleRate;
      const errorRate = options.onErrorSampleRate ?? config.replaysOnErrorSampleRate;
      const sampleRate =
        typeof sessionRate === 'number'
          ? sessionRate
          : typeof errorRate === 'number'
            ? errorRate
            : 0.1;
      const replay: ReplayOptions = {
        enabled: true,
        sampleRate,
        maskAllInputs: options.maskAllInputs ?? true,
      };
      if (typeof options.maxBufferedEvents === 'number') {
        replay.maxBufferedEvents = options.maxBufferedEvents;
      }
      config.replay = replay;
    },
  };
}

export interface FeedbackIntegrationOptions {
  colorScheme?: 'system' | 'light' | 'dark';
  [key: string]: unknown;
}

/**
 * User-feedback integration placeholder. AllStak does not ship a feedback
 * widget yet, so this is a no-op that exists purely so a Sentry init array
 * containing `feedbackIntegration()` runs unmodified.
 */
export function feedbackIntegration(_options: FeedbackIntegrationOptions = {}): AllStakIntegration {
  return { name: 'Feedback' };
}
