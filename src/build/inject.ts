/**
 * Debug-ID injection. Build-time only.
 *
 * For each `(bundle.js, bundle.js.map)` pair we:
 *   - Generate a stable per-bundle UUID (one already on the bundle is
 *     reused so re-running is idempotent).
 *   - Append `//# debugId=<uuid>` to the JS so the runtime resolver in
 *     `src/debug-id.ts` can read it back.
 *   - Write a top-level `debugId` field into the `.map` JSON so the
 *     symbolicator on the backend can join `bundle.js` ↔ `bundle.js.map`
 *     by ID rather than guessing from filenames.
 *
 * Bundlers re-write hashed filenames on every build, so joining by ID
 * (instead of by URL or path) is what makes resolved stack frames
 * survive across releases.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import type { BundlePair } from './walk';

const DEBUG_ID_LINE_RE = /^\/\/# debugId=([0-9a-f-]{36})\s*$/m;
const REGISTRATION_MARKER = '/*!__allstak_debug_id_registration__*/';

function buildRegistrationSnippet(jsBody: string, debugId: string): string {
  // Only modules that literally reference `import.meta` get the clean
  // import.meta.url path. Minified Vite/Rollup output is loaded as
  // `<script type="module">` but frequently contains NO top-level
  // import/export/import.meta tokens, so a content sniff can't tell it apart
  // from a classic script. The fallback below therefore must resolve THIS
  // script's own URL correctly in BOTH contexts — it cannot rely on
  // `document.currentScript` (always null inside an ES module) and must never
  // fall back to `location.href` (that registers the debug id under the PAGE
  // url, so stack-frame lookups by script url never match → no symbolication).
  if (/\bimport\.meta\b/.test(jsBody)) {
    return `${REGISTRATION_MARKER}try{(globalThis._allstakDebugIds=globalThis._allstakDebugIds||{})[import.meta.url]="${debugId}"}catch(_){}`;
  }
  // Universal: classic scripts expose document.currentScript.src; ES modules
  // (where it's null) recover their own URL from a fresh Error's stack — the
  // innermost frame is this very snippet, i.e. this bundle's URL.
  return `${REGISTRATION_MARKER}(function(){try{var u=(typeof document!=="undefined"&&document.currentScript&&document.currentScript.src)||"";if(!u){try{throw new Error()}catch(e){var m=(e&&e.stack||"").match(/(?:https?|file|blob):\\/\\/[^\\s)'"]+/g);if(m&&m.length)u=m[0].replace(/:\\d+:\\d+$/,"")}}if(u)(globalThis._allstakDebugIds=globalThis._allstakDebugIds||{})[u]="${debugId}"}catch(_){}})();`;
}

function stripRegistration(js: string): string {
  const lineRe = new RegExp(
    '^' + REGISTRATION_MARKER.replace(/[/*!]/g, (c) => '\\' + c) + '.*$',
    'm',
  );
  return js.replace(lineRe, '');
}

/** Outcome of injecting one pair. */
export interface InjectResult {
  /** UUID injected (or reused) for this bundle. */
  debugId: string;
  /** True if the bundle already had a debugId — we reused it. */
  reused: boolean;
}

/**
 * Inject (or reuse) the debug ID for a single bundle/sourcemap pair.
 * Mutates both files on disk. Pure synchronous Node — safe to call from
 * a Vite `closeBundle` or Webpack `afterEmit` hook.
 */
export function injectPair(p: BundlePair): InjectResult {
  const jsRaw = readFileSync(p.jsPath, 'utf8');
  const mapRaw = readFileSync(p.mapPath, 'utf8');
  const map = JSON.parse(mapRaw) as { debugId?: unknown; [k: string]: unknown };

  let debugId = typeof map.debugId === 'string' ? map.debugId : '';
  const existing = DEBUG_ID_LINE_RE.exec(jsRaw);
  if (existing && existing[1]) debugId = debugId || existing[1];
  const reused = !!debugId;
  if (!debugId) debugId = randomUUID();

  map.debugId = debugId;
  writeFileSync(p.mapPath, JSON.stringify(map));

  let jsOut = stripRegistration(jsRaw.replace(DEBUG_ID_LINE_RE, ''));
  jsOut = jsOut.replace(/\s+$/, '');
  jsOut += `\n${buildRegistrationSnippet(jsOut, debugId)}\n//# debugId=${debugId}\n`;
  writeFileSync(p.jsPath, jsOut);

  return { debugId, reused };
}

/** Inject every pair under `root`. Returns one record per pair. */
export function injectAll(pairs: BundlePair[]): Array<{ pair: BundlePair; result: InjectResult }> {
  return pairs.map((pair) => ({ pair, result: injectPair(pair) }));
}

/** Read a debug ID back from a `.map` file. */
export function readDebugIdFromMap(mapPath: string): string | null {
  const json = JSON.parse(readFileSync(mapPath, 'utf8')) as { debugId?: unknown };
  return typeof json.debugId === 'string' ? json.debugId : null;
}
