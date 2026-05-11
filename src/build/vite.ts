/**
 * Vite plugin — injects AllStak debug IDs into the build output and
 * (optionally) uploads source maps when the build finishes.
 *
 *   // vite.config.ts
 *   import { defineConfig } from 'vite';
 *   import react from '@vitejs/plugin-react';
 *   import { allstakSourcemaps } from '@allstak/react/vite';
 *
 *   export default defineConfig({
 *     plugins: [
 *       react(),
 *       allstakSourcemaps({
 *         release: process.env.ALLSTAK_RELEASE,
 *         token: process.env.ALLSTAK_UPLOAD_TOKEN,
 *         dist: 'web',
 *       }),
 *     ],
 *     build: { sourcemap: true },
 *   });
 *
 * The plugin runs in `closeBundle` (after Vite finishes writing every
 * file to disk) so it works for both library and application builds
 * and never blocks the dev server.
 */

import { resolve } from 'node:path';

import { processBuildOutput, type ProcessOptions, type ProcessReport } from './sourcemaps';

/** Options for {@link allstakSourcemaps}. */
export interface AllStakVitePluginOptions extends Omit<ProcessOptions, 'dir'> {
  /**
   * Build output directory, relative to the project root or absolute.
   * Defaults to Vite's `build.outDir` (resolved at config time).
   * Override only if you write maps to a non-default location.
   */
  dir?: string;
  /** If true, plugin is skipped entirely. */
  disabled?: boolean;
}

/** Minimal Vite plugin shape — defined locally so we don't peer-depend on `vite` types. */
interface MinimalVitePlugin {
  name: string;
  apply?: 'build' | 'serve';
  enforce?: 'pre' | 'post';
  configResolved?: (config: { build?: { outDir?: string }; root?: string }) => void;
  closeBundle?: () => void | Promise<void>;
}

/**
 * Returns a Vite plugin you spread into `plugins: []`. Doesn't import
 * from `vite` directly — Vite's plugin contract is a duck-typed object,
 * which keeps this package install-time light.
 */
export function allstakSourcemaps(opts: AllStakVitePluginOptions = {} as AllStakVitePluginOptions): MinimalVitePlugin {
  let resolvedDir: string | undefined = opts.dir ? resolve(opts.dir) : undefined;
  let lastReport: ProcessReport | null = null;

  return {
    name: 'allstak:sourcemaps',
    apply: 'build',
    enforce: 'post',

    configResolved(config) {
      if (resolvedDir) return;
      const outDir = config.build?.outDir ?? 'dist';
      const root = config.root ?? process.cwd();
      resolvedDir = resolve(root, outDir);
    },

    async closeBundle() {
      if (opts.disabled) return;
      if (!resolvedDir) {
        console.warn('[allstak/vite] could not resolve build output dir — skipping');
        return;
      }
      try {
        lastReport = await processBuildOutput({
          ...opts,
          dir: resolvedDir,
          silent: opts.silent ?? false,
        });
      } catch (e) {
        console.error(`[allstak/vite] failed: ${(e as Error).message}`);
      }
    },
  };
}

/**
 * Backwards-compatible alias matching the @allstak/js naming. Prefer
 * `allstakSourcemaps` going forward — short, unambiguous.
 */
export const allstakVitePlugin = allstakSourcemaps;
