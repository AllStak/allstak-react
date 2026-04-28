/**
 * Browser-side debug-id resolver.
 *
 * The build-time inject step (run via `@allstak/js/sourcemaps` against
 * Vite/Webpack/Next output) emits `//# debugId=<uuid>` into every JS
 * chunk and writes a self-registration snippet that populates
 * `globalThis._allstakDebugIds` as a `{ [scriptUrl]: uuid }` map.
 *
 * At capture time we resolve each stack frame's filename against that
 * map and attach the matched UUID to the frame so the dashboard
 * symbolicator can pick the right `.map` even after long-tail caching.
 */

interface DebugIdRegistry { [filename: string]: string | undefined }

function getRegistry(): DebugIdRegistry {
  return ((globalThis as any)._allstakDebugIds ?? {}) as DebugIdRegistry;
}

const cache = new Map<string, string | undefined>();

export function resolveDebugId(filename: string | undefined): string | undefined {
  if (!filename) return undefined;
  if (cache.has(filename)) return cache.get(filename);
  const registry = getRegistry();
  let id = registry[filename];
  if (!id) {
    // Tolerate registry keys that omit the scheme/host (relative URLs in
    // the browser source-map upload path).
    for (const key of Object.keys(registry)) {
      if (filename.endsWith(key)) { id = registry[key]; break; }
    }
  }
  cache.set(filename, id);
  return id;
}

/** @internal — for tests. */
export function __clearDebugIdCache(): void { cache.clear(); }
