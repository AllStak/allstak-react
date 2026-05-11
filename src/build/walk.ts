/**
 * Build-time only. File-system walking for the source-map pipeline.
 * Pure Node 18+ (built-in `node:fs` only). Browser runtime never imports
 * this — it's behind a `./build/*` subpath that's marked Node-platform.
 */

import { readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

/** A bundle and its companion source map on disk. */
export interface BundlePair {
  /** Absolute path to the JS bundle (`.js` / `.mjs` / `.cjs`). */
  jsPath: string;
  /** Absolute path to the matching `.map` file. */
  mapPath: string;
  /** Bare filename of the bundle (no directory), for log lines. */
  bundleName: string;
}

/** Recursively list every file under `dir`. Symlinks are followed. */
export function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/**
 * Returns every `(bundle, sourcemap)` pair under `root`.
 *
 * A pair is a `.js` / `.mjs` / `.cjs` file with a sibling file of the
 * same name plus a `.map` suffix — the convention every modern bundler
 * (Vite, Webpack, esbuild, Rollup, tsup) follows.
 */
export function findPairs(root: string): BundlePair[] {
  const all = walk(root);
  const maps = new Set(all.filter((p) => p.endsWith('.map')));
  const pairs: BundlePair[] = [];
  for (const js of all) {
    if (!js.endsWith('.js') && !js.endsWith('.mjs') && !js.endsWith('.cjs')) continue;
    const map = js + '.map';
    if (maps.has(map)) {
      pairs.push({ jsPath: js, mapPath: map, bundleName: basename(js) });
    }
  }
  return pairs;
}
