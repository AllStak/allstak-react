/**
 * React Testing Library integration test — actually mounts the
 * AllStakErrorBoundary, renders a child that throws on mount, and asserts
 * the SDK posted the expected payload to /ingest/v1/errors.
 *
 * Sets up a real DOM via jsdom so React can render. Uses
 * `React.createElement` (no JSX transform required) so this file runs
 * under plain `node --test` without a build step.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// jsdom must be installed BEFORE importing react-dom so React picks up
// the right globals.
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/test',
});
// Several globals (`navigator`, `location`) are non-writable getters in
// modern Node — install via defineProperty when needed and skip the rest.
const set = (k, v) => Object.defineProperty(globalThis, k, { value: v, writable: true, configurable: true });
set('window', dom.window);
set('document', dom.window.document);
set('navigator', dom.window.navigator);
set('HTMLElement', dom.window.HTMLElement);
set('Node', dom.window.Node);
set('Element', dom.window.Element);
set('Event', dom.window.Event);
set('MouseEvent', dom.window.MouseEvent);
set('CustomEvent', dom.window.CustomEvent);
set('location', dom.window.location);
set('history', dom.window.history);
set('requestAnimationFrame', (cb) => setTimeout(cb, 0));
set('cancelAnimationFrame', (id) => clearTimeout(id));

const sent = [];
const baseFetch = async (url, init) => {
  if (/api\.allstak\.sa/.test(String(url))) sent.push({ url: String(url), init });
  return new Response('{}', { status: 200 });
};
Object.defineProperty(globalThis, 'fetch', { value: baseFetch, writable: true, configurable: true });

const React = (await import('react')).default;
const { render, cleanup } = await import('@testing-library/react');
const { AllStak, AllStakErrorBoundary, useAllStak, withAllStakProfiler } =
  await import('../dist/index.mjs');

test('AllStakErrorBoundary catches a render-time error and reports it via captureException', async () => {
  sent.length = 0;
  AllStak.init({
    apiKey: 'ask_test',
    environment: 'test',
    autoCaptureBrowserErrors: false,
    autoBreadcrumbsFetch: false,
    autoBreadcrumbsConsole: false,
    autoBreadcrumbsNavigation: false,
  });

  function Boom() {
    throw new Error('boom-from-render');
  }

  // Suppress React's expected console.error noise from the thrown render.
  const origError = console.error;
  console.error = () => {};

  const { getByText } = render(
    React.createElement(
      AllStakErrorBoundary,
      { tags: { feature: 'cart' }, fallback: React.createElement('p', null, 'sorry, broken') },
      React.createElement(Boom),
    ),
  );

  console.error = origError;

  // Boundary swapped to fallback.
  assert.ok(getByText('sorry, broken'), 'fallback must render');

  await new Promise((r) => setTimeout(r, 50));
  cleanup();

  assert.equal(sent.length, 1, 'captureException must have fired exactly once');
  const body = JSON.parse(sent[0].init.body);
  assert.equal(body.message, 'boom-from-render');
  assert.equal(body.metadata.source, 'react-error-boundary');
  assert.match(body.metadata.componentStack ?? '', /Boom/, 'componentStack must include the throwing component');
  assert.equal(body.metadata['tag.feature'], 'cart');
});

test('useAllStak hook returns stable callable identity', async () => {
  AllStak.init({ apiKey: 'k', autoCaptureBrowserErrors: false, autoBreadcrumbsFetch: false, autoBreadcrumbsConsole: false, autoBreadcrumbsNavigation: false });

  let captured;
  function Probe() {
    const api = useAllStak();
    captured = api;
    return null;
  }
  render(React.createElement(Probe));
  assert.equal(typeof captured.captureException, 'function');
  assert.equal(typeof captured.captureMessage, 'function');
  assert.equal(typeof captured.setUser, 'function');
  assert.equal(typeof captured.setTag, 'function');
  assert.equal(typeof captured.addBreadcrumb, 'function');
  cleanup();
});

test('withAllStakProfiler emits a navigation breadcrumb on mount', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k', autoCaptureBrowserErrors: false, autoBreadcrumbsFetch: false, autoBreadcrumbsConsole: false, autoBreadcrumbsNavigation: false });

  function Page() { return React.createElement('div', null, 'page'); }
  const Wrapped = withAllStakProfiler(Page, 'Cart');
  render(React.createElement(Wrapped));
  await new Promise((r) => setTimeout(r, 30));

  AllStak.captureException(new Error('after-mount'));
  await new Promise((r) => setTimeout(r, 50));
  const body = JSON.parse(sent.at(-1).init.body);
  const navCrumbs = body.breadcrumbs?.filter((c) => c.type === 'navigation') ?? [];
  assert.ok(navCrumbs.some((c) => /Mounted <Cart>/.test(c.message)),
    'profiler must emit a "Mounted <Cart>" navigation breadcrumb');
  cleanup();
});
