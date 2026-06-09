/**
 * Sentry-compatible Redux integration: `createReduxEnhancer`.
 *
 * Returns a Redux store enhancer (pass it to `createStore`, or via the
 * `enhancers` callback of Redux Toolkit's `configureStore` — NEVER to
 * `applyMiddleware`). On every dispatched action it:
 *   - records a breadcrumb (`redux.action: <type>`),
 *   - attaches the latest (optionally transformed) state as the `redux.state`
 *     context on subsequent events,
 *   - lets you reconfigure the scope from state via `configureScopeWithState`.
 */

import { AllStak } from './client';
import type { AllStakUser } from './client';

interface ReduxAction {
  type?: unknown;
  [key: string]: unknown;
}

export interface ReduxEnhancerOptions {
  /** Strip/transform an action before it is recorded. Return null to skip. */
  actionTransformer?: (action: ReduxAction) => ReduxAction | null;
  /** Strip/transform state before it is attached. Return null to skip. */
  stateTransformer?: (state: unknown) => unknown | null;
  /** Reconfigure the AllStak scope on each state update. */
  configureScopeWithState?: (scope: ReturnType<typeof scopeProxy>, state: unknown) => void;
  /** Attach the (transformed) Redux state as the `redux.state` context. Default: true. */
  attachReduxState?: boolean;
}

type Reducer = (state: unknown, action: ReduxAction) => unknown;
type StoreCreator = (reducer: Reducer, preloadedState?: unknown) => unknown;
type Enhancer = (next: StoreCreator) => StoreCreator;

function scopeProxy() {
  return {
    setTag: (key: string, value: string) => AllStak.setTag(key, value),
    setTags: (tags: Record<string, string>) => AllStak.setTags(tags),
    setContext: (name: string, ctx: Record<string, unknown> | null) =>
      AllStak.setContext(name, ctx),
    setExtra: (key: string, value: unknown) => AllStak.setExtra(key, value),
    setExtras: (extras: Record<string, unknown>) => AllStak.setExtras(extras),
    setUser: (user: AllStakUser) => AllStak.setUser(user),
    setLevel: (level: 'fatal' | 'error' | 'warning' | 'info' | 'debug') =>
      AllStak.setLevel(level),
    setFingerprint: (fingerprint: string[]) => AllStak.setFingerprint(fingerprint),
  };
}

const ACTION_BREADCRUMB_MAX = 1000;

function safeForBreadcrumb(action: ReduxAction): Record<string, unknown> {
  try {
    const json = JSON.stringify(action);
    if (json && json.length <= ACTION_BREADCRUMB_MAX) return JSON.parse(json);
    return { type: action?.type };
  } catch {
    return { type: action?.type };
  }
}

export function createReduxEnhancer(options: ReduxEnhancerOptions = {}): Enhancer {
  const {
    actionTransformer = (action) => action,
    stateTransformer = (state) => state,
    configureScopeWithState,
    attachReduxState = true,
  } = options;

  return (next: StoreCreator): StoreCreator =>
    (reducer: Reducer, preloadedState?: unknown) => {
      const enhancedReducer: Reducer = (state, action) => {
        const newState = reducer(state, action);

        try {
          const transformedAction = actionTransformer(action);
          if (transformedAction) {
            const type =
              typeof action?.type === 'string' ? action.type : String(action?.type ?? 'unknown');
            AllStak.addBreadcrumb('default', `redux.action: ${type}`, 'info', {
              action: safeForBreadcrumb(transformedAction),
            });
          }
        } catch {
          /* never break the store */
        }

        try {
          if (attachReduxState) {
            const transformedState = stateTransformer(newState);
            if (transformedState != null) {
              AllStak.setContext(
                'redux.state',
                typeof transformedState === 'object'
                  ? (transformedState as Record<string, unknown>)
                  : { value: transformedState },
              );
            }
          }
        } catch {
          /* ignore */
        }

        try {
          configureScopeWithState?.(scopeProxy(), newState);
        } catch {
          /* ignore */
        }

        return newState;
      };

      return next(enhancedReducer, preloadedState);
    };
}
