/**
 * Release auto-detection for allstak-react (browser-only SDK).
 *
 * Verifies the pure parse + resolution layers without spawning git or needing
 * a real repo. The git RUNNER is seamed (injected) — at true browser runtime
 * the git step is a no-op, which we assert via the `null` runner path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Stub fetch so importing the dist bundle is safe in node.
if (!globalThis.fetch) {
  globalThis.fetch = async () =>
    new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
}

const {
  parseGitRelease,
  resolveRelease,
  releaseFromEnv,
  __resetGitReleaseCacheForTest,
  SDK_VERSION,
} = await import('../dist/index.mjs');

import { beforeEach } from 'node:test';
beforeEach(() => __resetGitReleaseCacheForTest());

const DESCRIBE = 'describe --tags --always --dirty';
const REVPARSE = 'rev-parse --short HEAD';
const STATUS = 'status --porcelain';

function fakeRunner(map) {
  return (args) => (args.join(' ') in map ? map[args.join(' ')] : '');
}

/** Clear env that would mask git/version-fallback assertions. */
function withCleanEnv(fn) {
  const stash = {};
  for (const k of ['ALLSTAK_RELEASE', 'npm_package_version', 'VERCEL_GIT_COMMIT_SHA', 'RAILWAY_GIT_COMMIT_SHA', 'RENDER_GIT_COMMIT']) {
    stash[k] = process.env[k];
    delete process.env[k];
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(stash)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('parseGitRelease: prefers describe (tag form)', () => {
  assert.equal(parseGitRelease('v1.2.3', 'abc1234', ''), 'v1.2.3');
});

test('parseGitRelease: describe with distance + dirty kept verbatim', () => {
  assert.equal(parseGitRelease('v1.2.3-4-gabc1234-dirty'), 'v1.2.3-4-gabc1234-dirty');
});

test('parseGitRelease: sha fallback', () => {
  assert.equal(parseGitRelease('', 'abc1234', ''), 'abc1234');
});

test('parseGitRelease: sha + -dirty when porcelain non-empty', () => {
  assert.equal(parseGitRelease(undefined, 'abc1234', ' M a.ts'), 'abc1234-dirty');
});

test('parseGitRelease: undefined when nothing usable', () => {
  assert.equal(parseGitRelease('', '', ''), undefined);
});

test('resolveRelease: 1. explicit always wins', () =>
  withCleanEnv(() => {
    process.env.ALLSTAK_RELEASE = 'env-x';
    assert.equal(
      resolveRelease('explicit', SDK_VERSION, true, fakeRunner({ [DESCRIBE]: 'v9' })),
      'explicit',
    );
  }));

test('resolveRelease: 2. env beats git + version', () =>
  withCleanEnv(() => {
    process.env.ALLSTAK_RELEASE = 'env-release';
    assert.equal(
      resolveRelease(undefined, SDK_VERSION, true, fakeRunner({ [DESCRIBE]: 'v9' })),
      'env-release',
    );
  }));

test('resolveRelease: 3. git beats version (seamed runner)', () =>
  withCleanEnv(() => {
    assert.equal(
      resolveRelease(undefined, SDK_VERSION, true, fakeRunner({ [DESCRIBE]: 'v7.7.7' })),
      'v7.7.7',
    );
  }));

test('resolveRelease: 3. git sha+dirty fallback', () =>
  withCleanEnv(() => {
    assert.equal(
      resolveRelease(undefined, SDK_VERSION, true, fakeRunner({ [DESCRIBE]: '', [REVPARSE]: 'deadbee', [STATUS]: ' M x' })),
      'deadbee-dirty',
    );
  }));

test('resolveRelease: 4. SDK version fallback when git empty', () =>
  withCleanEnv(() => {
    assert.equal(resolveRelease(undefined, SDK_VERSION, true, fakeRunner({})), SDK_VERSION);
  }));

test('resolveRelease: graceful when runner throws', () =>
  withCleanEnv(() => {
    const throwing = () => { throw new Error('no git'); };
    assert.equal(resolveRelease(undefined, SDK_VERSION, true, throwing), SDK_VERSION);
  }));

test('resolveRelease: browser/RN guard — null runner falls through to version', () =>
  withCleanEnv(() => {
    assert.equal(resolveRelease(undefined, SDK_VERSION, true, null), SDK_VERSION);
  }));

test('resolveRelease: opt-out disables git + version fallback', () =>
  withCleanEnv(() => {
    assert.equal(
      resolveRelease(undefined, SDK_VERSION, false, fakeRunner({ [DESCRIBE]: 'v7' })),
      undefined,
    );
  }));

test('resolveRelease: opt-out still honors env', () =>
  withCleanEnv(() => {
    process.env.ALLSTAK_RELEASE = 'env-only';
    assert.equal(
      resolveRelease(undefined, SDK_VERSION, false, fakeRunner({ [DESCRIBE]: 'v7' })),
      'env-only',
    );
  }));

test('releaseFromEnv: reads ALLSTAK_RELEASE', () =>
  withCleanEnv(() => {
    process.env.ALLSTAK_RELEASE = 'r1';
    assert.equal(releaseFromEnv(), 'r1');
  }));
