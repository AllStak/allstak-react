/**
 * Programmatic source-map pipeline. Build-time only.
 *
 * The high-level "do everything" entry point Vite/Webpack/Next plugins
 * call. Walk the build output → inject debug IDs → upload artifacts.
 *
 *   import { processBuildOutput } from '@allstak/react/sourcemaps';
 *
 *   await processBuildOutput({
 *     dir: 'dist',
 *     release: 'web@1.4.2',
 *     token: process.env.ALLSTAK_UPLOAD_TOKEN!,
 *   });
 */

export type { BundlePair } from './walk';
export { findPairs, walk } from './walk';
export type { InjectResult } from './inject';
export { injectPair, injectAll, readDebugIdFromMap } from './inject';
export type { UploadOptions, UploadResult } from './upload';
export { uploadPair, uploadAll, DEFAULT_HOST } from './upload';

import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { findPairs } from './walk';
import { injectAll } from './inject';
import { uploadAll, type UploadOptions, type UploadResult } from './upload';

/** Options for {@link processBuildOutput}. */
export interface ProcessOptions extends Partial<UploadOptions> {
  /** Build output directory to scan (e.g. `dist`, `.next/static`). */
  dir: string;
  /**
   * If true, only inject debug IDs and skip upload. Useful for sample
   * apps and CI dry-runs.
   */
  injectOnly?: boolean;
  /** Suppress per-pair console output. Default false (you want to see this). */
  silent?: boolean;
}

/** What `processBuildOutput` reports back. */
export interface ProcessReport {
  /** Absolute output dir scanned. */
  dir: string;
  /** Pairs found. */
  pairs: number;
  /** Per-pair injection results (debugId + reused?). */
  injected: Array<{ bundleName: string; debugId: string; reused: boolean }>;
  /** Per-pair upload results, omitted when no token / `injectOnly: true`. */
  uploaded?: UploadResult[];
}

export async function processBuildOutput(opts: ProcessOptions): Promise<ProcessReport> {
  const dir = resolve(opts.dir);
  const pairs = findPairs(dir);
  const log = opts.silent ? () => undefined : (m: string) => console.log(`[allstak/sourcemaps] ${m}`);

  log(`scanning ${dir} — ${pairs.length} bundle/map pair(s)`);
  if (pairs.length === 0) {
    return { dir, pairs: 0, injected: [] };
  }

  const injectedRaw = injectAll(pairs);
  const injected = injectedRaw.map(({ pair, result }) => ({
    bundleName: pair.bundleName,
    debugId: result.debugId,
    reused: result.reused,
  }));
  for (const i of injected) {
    log(`  ${i.bundleName}  ${i.debugId}  ${i.reused ? '(reused)' : '(new)'}`);
  }

  const env = loadAllStakEnv();
  const token = opts.token ?? env.ALLSTAK_UPLOAD_TOKEN;
  const release = opts.release ?? env.ALLSTAK_RELEASE;
  const host = opts.host ?? env.ALLSTAK_HOST;
  const dist = opts.dist ?? env.ALLSTAK_DIST;

  if (opts.injectOnly || !token) {
    if (!opts.injectOnly && !token) {
      log('skipping upload — no token (set ALLSTAK_UPLOAD_TOKEN or pass `token`)');
    }
    return { dir, pairs: pairs.length, injected };
  }
  if (!release) {
    log('skipping upload — no release (set ALLSTAK_RELEASE or pass `release`)');
    return { dir, pairs: pairs.length, injected };
  }

  const uploaded = await uploadAll(pairs, {
    ...opts,
    release,
    token,
    host,
    dist,
  });
  for (const u of uploaded) {
    if (u.ok) {
      log(`  ${u.bundleName}  uploaded debugId=${u.debugId}`);
    } else {
      const last = u.steps[u.steps.length - 1];
      log(`  ${u.bundleName}  FAIL status=${last?.status ?? '?'} body=${last?.body ?? ''}`);
    }
  }
  return { dir, pairs: pairs.length, injected, uploaded };
}

function loadAllStakEnv(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...process.env };
  for (const file of ['.env.local', '.env']) {
    const full = resolve(process.cwd(), file);
    if (!existsSync(full)) continue;
    const text = readFileSync(full, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(trimmed);
      if (!match) continue;
      const key = match[1]!;
      if (out[key] !== undefined) continue;
      out[key] = match[2]!.replace(/^['"]|['"]$/g, '');
    }
  }
  return out;
}
