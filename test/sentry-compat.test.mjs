/**
 * Sentry-compatibility surface tests — proves the @sentry/react drop-in APIs
 * actually produce telemetry (not just exist):
 *   - ErrorBoundary: render-prop fallback args + beforeCapture + capture
 *   - withProfiler: real `ui.react.mount` span
 *   - createReduxEnhancer: action breadcrumb on dispatch
 *   - integrations: [browserTracingIntegration(), replayIntegration()]
 *   - reactRouterV6BrowserTracingIntegration + withSentryReactRouterV6Routing:
 *     real `navigation` span on route change
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/start',
});
const set = (k, v) => Object.defineProperty(globalThis, k, { value: v, writable: true, configurable: true });
set('window', dom.window);
set('document', dom.window.document);
set('navigator', dom.window.navigator);
set('HTMLElement', dom.window.HTMLElement);
set('Node', dom.window.Node);
set('Element', dom.window.Element);
set('Event', dom.window.Event);
set('MutationObserver', dom.window.MutationObserver);
set('location', dom.window.location);
set('history', dom.window.history);
set('requestAnimationFrame', (cb) => setTimeout(cb, 0));
set('cancelAnimationFrame', (id) => clearTimeout(id));

const sent = [];
Object.defineProperty(globalThis, 'fetch', {
  value: async (url, init) => {
    if (/api\.allstak\.sa/.test(String(url))) sent.push({ url: String(url), init });
    return new Response('{}', { status: 200 });
  },
  writable: true,
  configurable: true,
});

const React = (await import('react')).default;
const { render, cleanup } = await import('@testing-library/react');
const SDK = await import('../dist/index.mjs');
const {
  AllStak,
  ErrorBoundary,
  withErrorBoundary,
  Profiler,
  withProfiler,
  createReduxEnhancer,
  browserTracingIntegration,
  replayIntegration,
  reactRouterV6BrowserTracingIntegration,
  withSentryReactRouterV6Routing,
} = SDK;

const quietInit = (extra = {}) =>
  AllStak.init({
    apiKey: 'ask_test',
    environment: 'test',
    autoCaptureBrowserErrors: false,
    autoBreadcrumbsFetch: false,
    autoBreadcrumbsConsole: false,
    autoBreadcrumbsClick: false,
    autoBreadcrumbsNavigation: false,
    autoWebVitals: false,
    enablePerformance: false,
    ...extra,
  });

const errors = () => sent.filter((s) => /\/ingest\/v1\/errors/.test(s.url)).map((s) => JSON.parse(s.init.body));
const spans = () =>
  sent
    .filter((s) => /\/ingest\/v1\/spans/.test(s.url))
    .flatMap((s) => JSON.parse(s.init.body).spans ?? []);

test('Sentry-style exports are all present', () => {
  for (const name of [
    'ErrorBoundary', 'withErrorBoundary', 'Profiler', 'withProfiler', 'useProfiler',
    'createReduxEnhancer', 'browserTracingIntegration', 'replayIntegration',
    'feedbackIntegration', 'reactRouterV6BrowserTracingIntegration',
    'reactRouterV7BrowserTracingIntegration', 'withSentryReactRouterV6Routing',
    'wrapCreateBrowserRouter', 'wrapUseRoutes',
  ]) {
    assert.equal(typeof SDK[name], 'function', `${name} must be exported`);
  }
});

test('ErrorBoundary: render-prop fallback receives Sentry args + beforeCapture tag is captured', async () => {
  sent.length = 0;
  quietInit();

  function Boom() { throw new Error('eb-boom'); }
  let fallbackArgs = null;

  const origError = console.error;
  console.error = () => {};
  const { getByText } = render(
    React.createElement(
      ErrorBoundary,
      {
        beforeCapture: (scope) => scope.setTag('section', 'dashboard'),
        fallback: (props) => {
          fallbackArgs = props;
          return React.createElement('p', null, 'broke');
        },
      },
      React.createElement(Boom),
    ),
  );
  console.error = origError;

  assert.ok(getByText('broke'), 'fallback renders');
  assert.ok(fallbackArgs, 'fallback render-prop called');
  assert.ok(fallbackArgs.error instanceof Error);
  assert.match(fallbackArgs.componentStack, /Boom/);
  assert.equal(typeof fallbackArgs.eventId, 'string');
  assert.equal(typeof fallbackArgs.resetError, 'function');

  await new Promise((r) => setTimeout(r, 50));
  cleanup();

  const ev = errors().find((e) => e.message === 'eb-boom');
  assert.ok(ev, 'error captured');
  assert.equal(ev.metadata.source, 'react-error-boundary');
  assert.equal(ev.metadata['tag.section'], 'dashboard', 'beforeCapture tag forwarded');
});

test('withErrorBoundary HOC wraps and captures', async () => {
  sent.length = 0;
  quietInit();
  function Boom() { throw new Error('hoc-boom'); }
  const Guarded = withErrorBoundary(Boom, { fallback: React.createElement('span', null, 'x') });
  const origError = console.error; console.error = () => {};
  render(React.createElement(Guarded));
  console.error = origError;
  await new Promise((r) => setTimeout(r, 50));
  cleanup();
  assert.ok(errors().some((e) => e.message === 'hoc-boom'), 'HOC boundary captured');
});

test('withProfiler emits a real ui.react.mount span', async () => {
  sent.length = 0;
  quietInit();
  function Page() { return React.createElement('div', null, 'p'); }
  const Wrapped = withProfiler(Page, { name: 'CartPage' });
  render(React.createElement(Wrapped));
  await new Promise((r) => setTimeout(r, 30));
  await AllStak.flush(500);
  cleanup();

  const mount = spans().find((s) => (s.op === 'ui.react.mount' || s.operation === 'ui.react.mount'));
  assert.ok(mount, 'a ui.react.mount span must be emitted');
  assert.equal(mount.tags['react.component'], 'CartPage');
});

test('Profiler component also profiles its subtree', async () => {
  sent.length = 0;
  quietInit();
  render(
    React.createElement(Profiler, { name: 'Shell' }, React.createElement('div', null, 'hi')),
  );
  await new Promise((r) => setTimeout(r, 30));
  await AllStak.flush(500);
  cleanup();
  assert.ok(
    spans().some((s) => s.tags['react.component'] === 'Shell'),
    'Profiler emits a component span',
  );
});

test('createReduxEnhancer records an action breadcrumb', async () => {
  sent.length = 0;
  quietInit();

  // Minimal Redux-like createStore.
  const createStore = (reducer, preloaded) => {
    let state = preloaded ?? reducer(undefined, { type: '@@INIT' });
    return {
      dispatch: (action) => { state = reducer(state, action); return action; },
      getState: () => state,
    };
  };
  const reducer = (state = { n: 0 }, action) =>
    action.type === 'INC' ? { n: state.n + 1 } : state;

  const enhancer = createReduxEnhancer({ attachReduxState: true });
  const store = enhancer(createStore)(reducer);
  store.dispatch({ type: 'INC' });
  assert.equal(store.getState().n, 1, 'reducer still works through the enhancer');

  AllStak.captureException(new Error('after-dispatch'));
  await new Promise((r) => setTimeout(r, 50));

  const ev = errors().find((e) => e.message === 'after-dispatch');
  assert.ok(ev, 'error captured');
  const crumbs = ev.breadcrumbs ?? [];
  assert.ok(
    crumbs.some((c) => /redux\.action: INC/.test(c.message)),
    'redux action breadcrumb present',
  );
  assert.ok(ev.metadata['context.redux.state'], 'redux state attached as context');
});

test('integrations array: browserTracing + replay are honored by init', () => {
  quietInit({
    integrations: [browserTracingIntegration(), replayIntegration({ sessionSampleRate: 1 })],
    tracesSampleRate: 1,
  });
  const cfg = AllStak.getConfig();
  assert.equal(cfg.enableDistributedTracing, true, 'browserTracingIntegration enabled tracing');
  assert.ok(cfg.replay?.enabled, 'replayIntegration enabled replay');
  assert.equal(cfg.replay.sampleRate, 1, 'replay sample rate mapped');
});

test('replaysSessionSampleRate top-level alias enables replay', () => {
  quietInit({ replaysSessionSampleRate: 0.25 });
  const cfg = AllStak.getConfig();
  assert.ok(cfg.replay?.enabled, 'top-level replay alias enabled replay');
  assert.equal(cfg.replay.sampleRate, 0.25);
});

test('reactRouterV6 + withSentryReactRouterV6Routing emits a navigation span on route change', async () => {
  sent.length = 0;
  const loc = { pathname: '/start', search: '' };
  quietInit({
    integrations: [
      reactRouterV6BrowserTracingIntegration({
        useEffect: React.useEffect,
        useLocation: () => loc,
        useNavigationType: () => 'PUSH',
      }),
    ],
    tracesSampleRate: 1,
  });

  const SentryRoutes = withSentryReactRouterV6Routing(() => React.createElement('div', null, 'r'));
  const { rerender } = render(React.createElement(SentryRoutes));
  await new Promise((r) => setTimeout(r, 20));

  // Navigate.
  loc.pathname = '/orders/42';
  rerender(React.createElement(SentryRoutes));
  await new Promise((r) => setTimeout(r, 30));
  await AllStak.flush(500);
  cleanup();

  const nav = spans().find(
    (s) => (s.op === 'navigation' || s.operation === 'navigation') && s.description === '/orders/42',
  );
  assert.ok(nav, 'a navigation span for /orders/42 must be emitted');
});

test('reactRouterV6 groups dynamic routes by parameterized path (/products/:id)', async () => {
  sent.length = 0;
  const loc = { pathname: '/products/1', search: '' };
  quietInit({
    integrations: [
      reactRouterV6BrowserTracingIntegration({
        useEffect: React.useEffect,
        useLocation: () => loc,
        useNavigationType: () => 'PUSH',
        createRoutesFromChildren: () => [{ path: '/products/:id' }, { path: '/' }],
        matchRoutes: (_routes, l) => {
          const p = typeof l === 'string' ? l : l.pathname;
          return /^\/products\/[^/]+$/.test(p)
            ? [{ route: { path: '/products/:id' } }]
            : [{ route: { path: p } }];
        },
      }),
    ],
    tracesSampleRate: 1,
  });
  const SentryRoutes = withSentryReactRouterV6Routing(() => React.createElement('div', null, 'r'));
  const { rerender } = render(React.createElement(SentryRoutes, null, React.createElement('div')));
  await new Promise((r) => setTimeout(r, 20));
  loc.pathname = '/products/2';
  rerender(React.createElement(SentryRoutes, null, React.createElement('div')));
  await new Promise((r) => setTimeout(r, 30));
  await AllStak.flush(500);
  cleanup();

  const navs = spans().filter((s) => s.op === 'navigation' || s.operation === 'navigation');
  assert.ok(navs.some((s) => s.description === '/products/:id'), 'navigation grouped as /products/:id');
  assert.ok(!navs.some((s) => s.description === '/products/2'), 'must NOT emit a per-id navigation span');
});

test('captureException returns the ingested eventId (matches getLastEventId + payload)', async () => {
  sent.length = 0;
  quietInit();
  const id = AllStak.captureException(new Error('eventid-test'));
  assert.equal(typeof id, 'string');
  assert.ok(id.length > 0, 'an eventId is returned');
  assert.equal(AllStak.getLastEventId(), id, 'getLastEventId matches');
  await new Promise((r) => setTimeout(r, 50));
  const ev = errors().find((e) => e.message === 'eventid-test');
  assert.ok(ev, 'error ingested');
  assert.equal(ev.eventId, id, 'returned id equals the ingested payload eventId');
});

test('ErrorBoundary fallback eventId equals the ingested event id', async () => {
  sent.length = 0;
  quietInit();
  let fbEventId = null;
  function Boom() { throw new Error('eb-eventid'); }
  const origError = console.error; console.error = () => {};
  render(
    React.createElement(
      ErrorBoundary,
      { fallback: (p) => { fbEventId = p.eventId; return React.createElement('p', null, 'x'); } },
      React.createElement(Boom),
    ),
  );
  console.error = origError;
  await new Promise((r) => setTimeout(r, 50));
  cleanup();
  const ev = errors().find((e) => e.message === 'eb-eventid');
  assert.ok(ev, 'error ingested');
  assert.ok(fbEventId, 'fallback received an eventId');
  assert.equal(fbEventId, ev.eventId, 'fallback eventId equals the ingested eventId (not fabricated)');
});

test('ErrorBoundary beforeCapture setLevel/setFingerprint drive payload wire fields, not metadata', async () => {
  sent.length = 0;
  quietInit();
  function Boom() { throw new Error('eb-level'); }
  const origError = console.error; console.error = () => {};
  render(
    React.createElement(
      ErrorBoundary,
      {
        beforeCapture: (s) => { s.setLevel('fatal'); s.setFingerprint(['custom-fp']); },
        fallback: React.createElement('p', null, 'x'),
      },
      React.createElement(Boom),
    ),
  );
  console.error = origError;
  await new Promise((r) => setTimeout(r, 50));
  cleanup();
  const ev = errors().find((e) => e.message === 'eb-level');
  assert.ok(ev, 'error ingested');
  assert.equal(ev.level, 'fatal', 'setLevel drives payload.level');
  assert.deepEqual(ev.fingerprint, ['custom-fp'], 'setFingerprint drives payload.fingerprint');
  assert.ok(!('level' in (ev.metadata || {})), 'level must NOT leak into metadata');
  assert.ok(!('fingerprint' in (ev.metadata || {})), 'fingerprint must NOT leak into metadata');
});

test('beforeBreadcrumb is applied centrally to every crumb source', async () => {
  sent.length = 0;
  AllStak.init({
    apiKey: 'k',
    autoReplay: false,
    autoCaptureBrowserErrors: false,
    autoBreadcrumbsFetch: false,
    autoBreadcrumbsConsole: false,
    autoBreadcrumbsClick: false,
    autoBreadcrumbsNavigation: false,
    beforeBreadcrumb: (c) => (c.message === 'drop-me' ? null : { ...c, message: `${c.message}-mod` }),
  });
  AllStak.addBreadcrumb('ui', 'keep-me', 'info');
  AllStak.addBreadcrumb('ui', 'drop-me', 'info');
  AllStak.captureException(new Error('crumbtest'));
  await new Promise((r) => setTimeout(r, 50));
  const ev = errors().find((e) => e.message === 'crumbtest');
  assert.ok(ev, 'error ingested');
  const msgs = (ev.breadcrumbs || []).map((b) => b.message);
  assert.ok(msgs.includes('keep-me-mod'), 'beforeBreadcrumb modified the manual crumb');
  assert.ok(!msgs.some((m) => /drop-me/.test(m)), 'beforeBreadcrumb dropped the crumb (null)');
});

test('wrapCreateBrowserRouter names spans by parameterized route (data router, no hooks)', async () => {
  sent.length = 0;
  SDK.__resetRouteTracingForTest();
  quietInit({ tracesSampleRate: 1, autoReplay: false, autoCaptureBrowserErrors: false, autoBreadcrumbsConsole: false });
  let subscriber = null;
  const mockCreate = () => ({
    state: { location: { pathname: '/products/42' }, matches: [{ route: { path: '/products/:id' } }] },
    subscribe: (cb) => { subscriber = cb; return () => {}; },
  });
  SDK.wrapCreateBrowserRouter(mockCreate)([]);
  await new Promise((r) => setTimeout(r, 30));
  await AllStak.flush(500);
  assert.ok(
    spans().some((s) => (s.op === 'pageload' || s.operation === 'pageload') && s.description === '/products/:id'),
    'pageload named by parameterized route /products/:id (not /products/42)',
  );

  sent.length = 0;
  subscriber({ location: { pathname: '/cart' }, matches: [{ route: { path: '/cart' } }] });
  await new Promise((r) => setTimeout(r, 30));
  await AllStak.flush(500);
  assert.ok(
    spans().some((s) => (s.op === 'navigation' || s.operation === 'navigation') && s.description === '/cart'),
    'navigation span emitted from the data-router subscription',
  );
});

test('tracing integrations suppress the core duplicate pageload span', () => {
  quietInit({ integrations: [browserTracingIntegration()], tracesSampleRate: 1 });
  assert.equal(AllStak.getConfig().disableCorePageloadSpan, true, 'browserTracing suppresses core pageload');
});

test('zero-config init({apiKey}) auto-attaches browser/os/device context', () => {
  const realNav = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      language: 'en-US',
    },
    configurable: true,
  });
  try {
    AllStak.init({ apiKey: 'ask_test', autoReplay: false, autoCaptureBrowserErrors: false, autoBreadcrumbsNavigation: false });
    const ctx = AllStak.getConfig().contexts ?? {};
    assert.equal(ctx.browser?.name, 'Chrome', 'browser auto-detected');
    assert.equal(ctx.browser?.version, '124.0.0.0', 'browser version auto-detected');
    assert.equal(ctx.os?.name, 'macOS', 'os auto-detected');
    assert.ok(ctx.device, 'device context auto-attached');
    // User-supplied context wins over the auto one.
    AllStak.init({ apiKey: 'ask_test', autoReplay: false, contexts: { browser: { name: 'Custom' } } });
    assert.equal(AllStak.getConfig().contexts.browser.name, 'Custom', 'user context overrides auto');
  } finally {
    Object.defineProperty(globalThis, 'navigator', { value: realNav, configurable: true });
  }
});

test('zero-config navigation: history.pushState emits a navigation span (no router integration)', async () => {
  sent.length = 0;
  SDK.__resetRouteTracingForTest(); // clear router-active/pageload flags from earlier tests
  AllStak.init({
    apiKey: 'ask_test',
    tracesSampleRate: 1,
    autoReplay: false,
    autoCaptureBrowserErrors: false,
    autoBreadcrumbsConsole: false,
    autoBreadcrumbsClick: false,
  });
  window.history.pushState({}, '', '/zero-config-nav-' + Date.now());
  await new Promise((r) => setTimeout(r, 40));
  await AllStak.flush(500);
  cleanup();
  const nav = spans().find(
    (s) => (s.op === 'navigation' || s.operation === 'navigation') && /\/zero-config-nav/.test(s.description),
  );
  assert.ok(nav, 'a navigation span must be emitted from history.pushState with zero config');
});

test('replayIntegration actually starts the recorder and flushes replay events', async () => {
  sent.length = 0;
  quietInit({ integrations: [replayIntegration({ sessionSampleRate: 1 })] });
  // The recorder snapshots on the first DOM mutation (the framework commit);
  // trigger one, let the observer fire, then flush drains the buffer.
  document.body.appendChild(document.createElement('span'));
  await new Promise((r) => setTimeout(r, 25));
  await AllStak.flush(500);
  const replayReq = sent.find((s) => /\/ingest\/v1\/replay/.test(s.url));
  assert.ok(replayReq, 'a /ingest/v1/replay request must be sent when replayIntegration is enabled');
  const body = JSON.parse(replayReq.init.body);
  assert.ok(Array.isArray(body.events) && body.events.length > 0, 'replay payload carries events');
});
