/**
 * Validates that SDK_VERSION in src/client.ts stays in sync with
 * the version field in package.json to prevent version drift.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = resolve(__dirname, '..', 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

// Stub fetch before importing the client (dist expects a browser-like env)
if (!globalThis.fetch) {
  globalThis.fetch = async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
}

const { SDK_VERSION } = await import('../dist/index.mjs');

test('SDK_VERSION matches package.json version', () => {
  assert.equal(
    SDK_VERSION,
    pkg.version,
    `SDK_VERSION (${SDK_VERSION}) does not match package.json version (${pkg.version}). ` +
    'Update SDK_VERSION in src/client.ts to match.',
  );
});
