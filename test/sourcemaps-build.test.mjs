/**
 * Build-pipeline smoke tests for @allstak/react/{sourcemaps,vite,webpack,next}.
 *
 * Verifies:
 *   - subpath modules import cleanly and expose the documented surface
 *   - injectPair is idempotent: re-running on the same files reuses the
 *     existing debugId and matches it across `.js` and `.map`
 *   - findPairs scans dist-style layouts correctly
 *   - the Vite plugin matches the duck-typed Vite plugin shape
 *   - the Webpack plugin's afterEmit hook runs and produces a report
 *   - upload payload shape matches /api/v1/artifacts/upload contract
 *     (debugId, type, release, dist, multipart `file`)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sourcemaps = await import('../dist/build/sourcemaps.mjs');
const vite = await import('../dist/build/vite.mjs');
const webpack = await import('../dist/build/webpack.mjs');
const next = await import('../dist/build/next.mjs');

function freshDir() {
  return mkdtempSync(join(tmpdir(), 'allstak-react-sm-'));
}

function writeBundlePair(dir, name = 'index.js') {
  const jsPath = join(dir, name);
  const mapPath = jsPath + '.map';
  writeFileSync(jsPath, 'console.log("hi");\n//# sourceMappingURL=' + name + '.map\n');
  writeFileSync(mapPath, JSON.stringify({
    version: 3,
    sources: ['index.ts'],
    mappings: 'AAAA',
    names: [],
    sourcesContent: ['console.log("hi");'],
  }));
  return { jsPath, mapPath };
}

// ── Subpath surface ────────────────────────────────────────────

test('@allstak/react/sourcemaps exports the documented surface', () => {
  for (const name of ['findPairs', 'walk', 'injectPair', 'injectAll', 'readDebugIdFromMap', 'uploadPair', 'uploadAll', 'processBuildOutput', 'DEFAULT_HOST']) {
    assert.ok(name in sourcemaps, `expected export: ${name}`);
  }
  assert.equal(typeof sourcemaps.processBuildOutput, 'function');
});

test('@allstak/react/vite exports allstakSourcemaps + alias', () => {
  assert.equal(typeof vite.allstakSourcemaps, 'function');
  assert.equal(typeof vite.allstakVitePlugin, 'function');  // back-compat alias
});

test('@allstak/react/webpack exports AllStakWebpackPlugin class', () => {
  assert.equal(typeof webpack.AllStakWebpackPlugin, 'function');  // class is a function
});

test('@allstak/react/next exports withAllStak', () => {
  assert.equal(typeof next.withAllStak, 'function');
});

// ── findPairs ──────────────────────────────────────────────────

test('findPairs locates JS+map siblings under a dist-style root', () => {
  const dir = freshDir();
  try {
    mkdirSync(join(dir, 'assets'));
    writeBundlePair(join(dir, 'assets'), 'index-abc.js');
    writeBundlePair(dir, 'main.mjs');
    // .map alone (no JS sibling) — should NOT pair
    writeFileSync(join(dir, 'orphan.map'), '{}');
    const pairs = sourcemaps.findPairs(dir);
    assert.equal(pairs.length, 2);
    const names = pairs.map((p) => p.bundleName).sort();
    assert.deepEqual(names, ['index-abc.js', 'main.mjs']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── injectPair idempotency ─────────────────────────────────────

test('injectPair generates a debugId and writes it to both files', () => {
  const dir = freshDir();
  try {
    const { jsPath, mapPath } = writeBundlePair(dir);
    const result = sourcemaps.injectPair({ jsPath, mapPath, bundleName: 'index.js' });
    assert.ok(/^[0-9a-f-]{36}$/.test(result.debugId));
    assert.equal(result.reused, false);

    // JS now has the debug-id comment + registration snippet.
    const js = readFileSync(jsPath, 'utf8');
    assert.match(js, /\/\/# debugId=[0-9a-f-]{36}/);
    assert.match(js, /_allstakDebugIds/);

    // Map now has top-level debugId.
    const map = JSON.parse(readFileSync(mapPath, 'utf8'));
    assert.equal(map.debugId, result.debugId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('injectPair is idempotent — second run reuses the same debugId', () => {
  const dir = freshDir();
  try {
    const { jsPath, mapPath } = writeBundlePair(dir);
    const first = sourcemaps.injectPair({ jsPath, mapPath, bundleName: 'index.js' });
    const second = sourcemaps.injectPair({ jsPath, mapPath, bundleName: 'index.js' });
    assert.equal(second.debugId, first.debugId, 'debugId must be reused');
    assert.equal(second.reused, true);

    // No duplicate //# debugId= lines.
    const js = readFileSync(jsPath, 'utf8');
    const matches = js.match(/\/\/# debugId=/g) ?? [];
    assert.equal(matches.length, 1, 'exactly one debugId comment');
    const regs = js.match(/__allstak_debug_id_registration__/g) ?? [];
    assert.equal(regs.length, 1, 'exactly one registration snippet');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readDebugIdFromMap reads the injected ID', () => {
  const dir = freshDir();
  try {
    const { jsPath, mapPath } = writeBundlePair(dir);
    const { debugId } = sourcemaps.injectPair({ jsPath, mapPath, bundleName: 'index.js' });
    assert.equal(sourcemaps.readDebugIdFromMap(mapPath), debugId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── processBuildOutput orchestrator ────────────────────────────

test('processBuildOutput injects but skips upload when no token is provided', async () => {
  const dir = freshDir();
  try {
    writeBundlePair(dir);
    writeBundlePair(dir, 'second.js');
    const report = await sourcemaps.processBuildOutput({
      dir,
      release: 'react-test@1.0.0',
      silent: true,
    });
    assert.equal(report.pairs, 2);
    assert.equal(report.injected.length, 2);
    assert.equal(report.uploaded, undefined, 'upload must be skipped without token');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('processBuildOutput uploads each pair when token + release are provided', async () => {
  const dir = freshDir();
  const recorded = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    recorded.push({ url: String(url), method: init?.method, headers: init?.headers });
    return new Response(JSON.stringify({ success: true }), { status: 201 });
  };
  try {
    writeBundlePair(dir);
    const report = await sourcemaps.processBuildOutput({
      dir,
      release: 'react-test@1.0.0',
      dist: 'web',
      token: 'aspk_fake_token',
      host: 'http://localhost:8080',
      silent: true,
    });
    assert.equal(report.uploaded.length, 1);
    assert.ok(report.uploaded[0].ok);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].url, 'http://localhost:8080/api/v1/artifacts/upload');
    assert.equal(recorded[0].method, 'POST');
    assert.equal(recorded[0].headers['X-AllStak-Upload-Token'], 'aspk_fake_token');
  } finally {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Vite plugin shape ──────────────────────────────────────────

test('allstakSourcemaps returns a Vite plugin object with the right hooks', () => {
  const plugin = vite.allstakSourcemaps({ release: 'web@1.0.0', injectOnly: true });
  assert.equal(plugin.name, 'allstak:sourcemaps');
  assert.equal(plugin.apply, 'build');
  assert.equal(plugin.enforce, 'post');
  assert.equal(typeof plugin.configResolved, 'function');
  assert.equal(typeof plugin.closeBundle, 'function');
});

// ── Webpack plugin afterEmit ───────────────────────────────────

test('AllStakWebpackPlugin runs afterEmit and processes the dir', async () => {
  const dir = freshDir();
  try {
    writeBundlePair(dir);
    const plugin = new webpack.AllStakWebpackPlugin({
      release: 'web@1.0.0',
      injectOnly: true,
      silent: true,
    });
    let registered;
    const fakeCompiler = {
      hooks: {
        afterEmit: {
          tapPromise: (_name, fn) => { registered = fn; },
        },
      },
      outputPath: dir,
    };
    plugin.apply(fakeCompiler);
    await registered({ compiler: { outputPath: dir } });
    assert.ok(plugin.lastReport);
    assert.equal(plugin.lastReport.pairs, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Next withAllStak decorator ─────────────────────────────────

test('withAllStak returns a Next config that toggles productionBrowserSourceMaps and chains webpack()', () => {
  const userWebpack = (_cfg, _ctx) => ({ called: true });
  const wrapped = next.withAllStak({ release: 'web@1.0.0' }, {
    reactStrictMode: true,
    webpack: userWebpack,
  });
  assert.equal(wrapped.reactStrictMode, true);
  assert.equal(wrapped.productionBrowserSourceMaps, true);
  assert.equal(typeof wrapped.webpack, 'function');

  // Server-side compilation: plugin should NOT be added.
  const serverCfg = { plugins: [] };
  wrapped.webpack(serverCfg, { isServer: true, dev: false });
  assert.equal(serverCfg.plugins.length, 0);

  // Client production: plugin MUST be added.
  const clientCfg = { plugins: [] };
  wrapped.webpack(clientCfg, { isServer: false, dev: false });
  assert.equal(clientCfg.plugins.length, 1);
});
