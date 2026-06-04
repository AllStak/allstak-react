/**
 * Sentry-compatible React Router v6 / v7 tracing.
 *
 * Produces REAL `pageload` / `navigation` spans — not breadcrumbs — named by
 * the PARAMETERIZED route (`/products/:id`, not `/products/42`) so dynamic
 * routes group into one transaction, matching `@sentry/react`.
 *
 * Usage (v6, component routes):
 *
 *   import { useEffect } from 'react';
 *   import {
 *     useLocation, useNavigationType,
 *     createRoutesFromChildren, matchRoutes, Routes,
 *   } from 'react-router-dom';
 *
 *   AllStak.init({
 *     apiKey: 'ask_live_...',
 *     integrations: [
 *       reactRouterV6BrowserTracingIntegration({
 *         useEffect, useLocation, useNavigationType,
 *         createRoutesFromChildren, matchRoutes,
 *       }),
 *     ],
 *     tracesSampleRate: 1.0,
 *   });
 *
 *   const SentryRoutes = withSentryReactRouterV6Routing(Routes);
 *
 * Usage (data router):
 *
 *   const sentryCreateBrowserRouter = wrapCreateBrowserRouter(createBrowserRouter);
 *   const router = sentryCreateBrowserRouter([...routes]);
 */

import * as React from 'react';
import type { AllStakIntegration, AllStakConfig } from './client';
import { emitRouteSpan, markRouterInstrumentationActive } from './route-tracing';

interface RouterLocation {
  pathname: string;
  search?: string;
}

interface RouteMatchLike {
  route?: { path?: string };
}

export interface ReactRouterIntegrationOptions {
  // Loosely typed so react-router-dom's exports (whose generic signatures vary
  // by version) can be passed straight in without casts.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  useEffect?: (...args: any[]) => any;
  useLocation?: () => RouterLocation;
  useNavigationType?: () => any;
  createRoutesFromChildren?: (children: any) => any;
  matchRoutes?: (...args: any[]) => any;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  stripBasename?: boolean;
}

// The router hooks passed into the integration; read at render time by the
// routing wrappers so they take no hard dependency on react-router-dom.
let routerHooks: ReactRouterIntegrationOptions = {};

function fallbackUseLocation(): RouterLocation {
  return {
    pathname: typeof location !== 'undefined' ? location.pathname || '/' : '/',
    search: typeof location !== 'undefined' ? location.search : '',
  };
}

/**
 * Resolve the PARAMETERIZED route name (`/products/:id`) for a location using
 * the route tree, so dynamic routes group into one transaction. Falls back to
 * the concrete pathname when `matchRoutes` / the route tree is unavailable.
 */
function parameterizedName(routes: unknown, loc: RouterLocation): string {
  try {
    if (routes && routerHooks.matchRoutes) {
      const branches = routerHooks.matchRoutes(routes, loc);
      if (branches && branches.length) {
        let path = '';
        for (const branch of branches) {
          const segment = branch.route?.path;
          if (!segment) continue;
          if (segment.startsWith('/')) path = segment;
          else path = `${path.replace(/\/$/, '')}/${segment}`;
        }
        if (path) return path.startsWith('/') ? path : `/${path}`;
      }
    }
  } catch {
    /* ignore — fall back to the concrete path */
  }
  return loc.pathname;
}

function makeRouterIntegration(name: string) {
  return (options: ReactRouterIntegrationOptions = {}): AllStakIntegration => {
    routerHooks = options;
    return {
      name,
      processConfig(config: AllStakConfig) {
        if (config.enableDistributedTracing === undefined) config.enableDistributedTracing = true;
        // This integration owns the pageload transaction (route-named); stop
        // the core's default navigation-timing pageload span to avoid a
        // duplicate. Marked here (processConfig runs before every setup) so the
        // generic browserTracing integration also stands down.
        if (config.disableCorePageloadSpan === undefined) config.disableCorePageloadSpan = true;
        markRouterInstrumentationActive();
      },
    };
  };
}

export const reactRouterV6BrowserTracingIntegration = makeRouterIntegration(
  'ReactRouterV6BrowserTracing',
);
export const reactRouterV7BrowserTracingIntegration = makeRouterIntegration(
  'ReactRouterV7BrowserTracing',
);

/**
 * Wrap your app's `<Routes>` so the initial render emits a route-named
 * `pageload` span and each route change emits a `navigation` span.
 */
export function withSentryReactRouterV6Routing<P extends { children?: React.ReactNode }>(
  Routes: React.ComponentType<P>,
): React.FC<P> {
  const Wrapped: React.FC<P> = (props) => {
    const useLoc = routerHooks.useLocation ?? fallbackUseLocation;
    const useEffectHook = routerHooks.useEffect ?? React.useEffect;
    const location = useLoc();

    // Build the route tree once from the <Route> children so navigation spans
    // can be named by the parameterized path.
    const routes = React.useMemo(() => {
      try {
        return routerHooks.createRoutesFromChildren
          ? routerHooks.createRoutesFromChildren(props.children)
          : null;
      } catch {
        return null;
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [props.children]);

    const isFirst = React.useRef(true);
    const lastPath = React.useRef('');

    useEffectHook(() => {
      const concrete = `${location.pathname}${location.search ?? ''}`;
      const name = parameterizedName(routes, location);
      if (isFirst.current) {
        isFirst.current = false;
        lastPath.current = concrete;
        emitRouteSpan('pageload', name);
        return;
      }
      if (concrete === lastPath.current) return;
      lastPath.current = concrete;
      emitRouteSpan('navigation', name);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [location.pathname, location.search]);

    return React.createElement(Routes, props);
  };
  Wrapped.displayName = 'withSentryReactRouterV6Routing(Routes)';
  return Wrapped;
}

/** v7 shares v6's hook shape. */
export const withSentryReactRouterV7Routing = withSentryReactRouterV6Routing;

interface DataRouterState {
  location?: { pathname?: string };
  matches?: Array<{ route?: { path?: string } }>;
}
interface DataRouterLike {
  state?: DataRouterState;
  subscribe?: (cb: (state: DataRouterState) => void) => unknown;
}

/**
 * Build the PARAMETERIZED route name (`/products/:id`) from a data router's
 * matched-route branch (`state.matches`), so dynamic routes group into one
 * transaction. Zero hooks needed — the route tree is on the router. Falls back
 * to the concrete pathname.
 */
function dataRouterRouteName(state?: DataRouterState): string | undefined {
  const matches = state?.matches;
  if (Array.isArray(matches) && matches.length) {
    let path = '';
    for (const m of matches) {
      const seg = m.route?.path;
      if (!seg) continue;
      if (seg.startsWith('/')) path = seg;
      else path = `${path.replace(/\/$/, '')}/${seg}`;
    }
    if (path) return path.startsWith('/') ? path : `/${path}`;
  }
  return state?.location?.pathname;
}

/**
 * Wrap `createBrowserRouter` (data-router API) so the router's location
 * subscription emits a `pageload` span on creation and `navigation` spans on
 * route change — named by the PARAMETERIZED route. One-line, no hooks.
 */
export function wrapCreateBrowserRouter<T extends (...args: never[]) => unknown>(
  createBrowserRouter: T,
): T {
  return ((...args: Parameters<T>) => {
    const router = createBrowserRouter(...args) as DataRouterLike;
    try {
      markRouterInstrumentationActive();
      emitRouteSpan('pageload', dataRouterRouteName(router?.state));
      let last = router?.state?.location?.pathname ?? '';
      router?.subscribe?.((state) => {
        const path = state?.location?.pathname ?? '';
        if (path && path !== last) {
          last = path;
          emitRouteSpan('navigation', dataRouterRouteName(state));
        }
      });
    } catch {
      /* never break the router */
    }
    return router as ReturnType<T>;
  }) as T;
}

/** v6/v7 aliases for the data-router wrapper. */
export const wrapCreateBrowserRouterV6 = wrapCreateBrowserRouter;
export const wrapCreateBrowserRouterV7 = wrapCreateBrowserRouter;

/**
 * Wrap `useRoutes` so route changes emit `navigation` spans. Requires the
 * integration to have been configured with `useLocation`.
 */
export function wrapUseRoutes<T extends (...args: never[]) => unknown>(origUseRoutes: T): T {
  return ((...args: Parameters<T>) => {
    const useLoc = routerHooks.useLocation ?? fallbackUseLocation;
    const useEffectHook = routerHooks.useEffect ?? React.useEffect;
    const location = useLoc();
    const isFirst = React.useRef(true);
    const lastPath = React.useRef('');

    useEffectHook(() => {
      const path = location.pathname;
      if (isFirst.current) {
        isFirst.current = false;
        lastPath.current = path;
        return;
      }
      if (path === lastPath.current) return;
      lastPath.current = path;
      emitRouteSpan('navigation', path);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [location.pathname]);

    return origUseRoutes(...args);
  }) as T;
}
