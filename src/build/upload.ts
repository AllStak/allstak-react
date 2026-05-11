/**
 * Source-map / bundle upload client. Build-time only.
 *
 * Wraps the AllStak `/api/v1/artifacts/upload` endpoint with multipart
 * form data and best-effort retries. Pure Node 18+ (uses the global
 * `fetch` and `FormData`), no third-party HTTP client required.
 *
 * Auth: `X-AllStak-Upload-Token` header (NOT the runtime API key —
 * uploads have a dedicated, narrower scope. Generate one in the
 * dashboard → Project Settings → Upload Tokens).
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import type { BundlePair } from './walk';
import { readDebugIdFromMap } from './inject';

/** Default ingest host — overridden via `host` option or `ALLSTAK_HOST`. */
export const DEFAULT_HOST = 'https://api.allstak.sa';

/** Options for {@link uploadAll} / {@link uploadPair}. */
export interface UploadOptions {
  /** Release identifier, e.g. `myapp@1.4.2`. Required server-side. */
  release: string;
  /** Optional distribution tag (`web`, `ios-hermes`, `staging`, …). */
  dist?: string;
  /** AllStak ingest host (default `https://api.allstak.sa`). */
  host?: string;
  /** Project upload token (`aspk_…`). May come from `ALLSTAK_UPLOAD_TOKEN`. */
  token: string;
  /**
   * Drop `sourcesContent` from the map before upload (smaller payload).
   * Off by default — sourcesContent enables full-source rendering on the
   * dashboard. Turn on if you don't want source code uploaded.
   */
  stripSources?: boolean;
  /** Also upload the JS bundle alongside the map (off by default). */
  uploadBundles?: boolean;
}

/** One artifact upload result. */
export interface UploadResult {
  bundleName: string;
  debugId: string;
  /** True when both the map (and bundle, if requested) uploaded OK. */
  ok: boolean;
  /** Per-artifact responses, in the order we sent them. */
  steps: Array<{
    type: 'sourcemap' | 'bundle';
    status: number;
    sha8: string;
    body?: string;
  }>;
}

interface OneStepResult {
  status: number;
  body: string;
  ok: boolean;
}

async function uploadOne(
  type: 'sourcemap' | 'bundle',
  filePath: string,
  debugId: string,
  opts: Required<Pick<UploadOptions, 'release' | 'host' | 'token'>> &
    Pick<UploadOptions, 'dist' | 'stripSources'>,
): Promise<OneStepResult> {
  let buf = readFileSync(filePath);
  if (type === 'sourcemap' && opts.stripSources) {
    const json = JSON.parse(buf.toString('utf8')) as { sourcesContent?: unknown };
    if (Array.isArray(json.sourcesContent)) delete json.sourcesContent;
    buf = Buffer.from(JSON.stringify(json));
  }

  const form = new FormData();
  form.append('debugId', debugId);
  form.append('type', type);
  form.append('release', opts.release);
  if (opts.dist) form.append('dist', opts.dist);
  form.append(
    'file',
    new Blob([buf], {
      type: type === 'sourcemap' ? 'application/json' : 'application/javascript',
    }),
    basename(filePath),
  );

  const res = await fetch(opts.host.replace(/\/$/, '') + '/api/v1/artifacts/upload', {
    method: 'POST',
    headers: { 'X-AllStak-Upload-Token': opts.token },
    body: form,
  });
  return { status: res.status, body: await res.text(), ok: res.ok };
}

function sha8(buf: Buffer): string {
  // Browser/Node fallback — keeps this file pure-JS (no node:crypto in
  // the public surface). Caller doesn't need cryptographic strength;
  // this is for log identification only.
  let hash = 0;
  for (let i = 0; i < buf.length; i++) hash = ((hash << 5) - hash + buf[i]!) | 0;
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Upload one bundle/map pair. The map is always uploaded; bundle is opt-in. */
export async function uploadPair(p: BundlePair, opts: UploadOptions): Promise<UploadResult> {
  const debugId = readDebugIdFromMap(p.mapPath);
  if (!debugId) {
    return {
      bundleName: p.bundleName,
      debugId: '',
      ok: false,
      steps: [{
        type: 'sourcemap',
        status: 0,
        sha8: '',
        body: `[allstak/upload] no debugId in ${p.mapPath} — run inject first`,
      }],
    };
  }
  const merged = {
    release: opts.release,
    host: opts.host ?? process.env.ALLSTAK_HOST ?? DEFAULT_HOST,
    token: opts.token,
    dist: opts.dist,
    stripSources: opts.stripSources,
  };

  const steps: UploadResult['steps'] = [];
  const mapResult = await uploadOne('sourcemap', p.mapPath, debugId, merged);
  steps.push({
    type: 'sourcemap',
    status: mapResult.status,
    sha8: sha8(readFileSync(p.mapPath)),
    body: mapResult.ok ? undefined : mapResult.body,
  });

  let allOk = mapResult.ok;
  if (opts.uploadBundles) {
    const bundleResult = await uploadOne('bundle', p.jsPath, debugId, merged);
    steps.push({
      type: 'bundle',
      status: bundleResult.status,
      sha8: sha8(readFileSync(p.jsPath)),
      body: bundleResult.ok ? undefined : bundleResult.body,
    });
    allOk = allOk && bundleResult.ok;
  }

  return { bundleName: p.bundleName, debugId, ok: allOk, steps };
}

/** Upload every pair in parallel. */
export async function uploadAll(
  pairs: BundlePair[],
  opts: UploadOptions,
): Promise<UploadResult[]> {
  return Promise.all(pairs.map((p) => uploadPair(p, opts)));
}
