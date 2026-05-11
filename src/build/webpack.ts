/**
 * Webpack plugin — same job as the Vite plugin: walk the build output
 * after emit, inject debug IDs into every JS+map pair, and (when a
 * token is present) upload to AllStak.
 *
 *   // webpack.config.js
 *   const { AllStakWebpackPlugin } = require('@allstak/react/webpack');
 *
 *   module.exports = {
 *     devtool: 'source-map',
 *     plugins: [
 *       new AllStakWebpackPlugin({
 *         release: process.env.ALLSTAK_RELEASE,
 *         token: process.env.ALLSTAK_UPLOAD_TOKEN,
 *         dist: 'web',
 *       }),
 *     ],
 *   };
 *
 * The plugin hooks `afterEmit`, the moment Webpack guarantees every
 * asset is on disk. Failures log a warning rather than failing the
 * build — a flaky CI step doesn't block shipping.
 */

import { processBuildOutput, type ProcessOptions, type ProcessReport } from './sourcemaps';

export interface AllStakWebpackPluginOptions extends Omit<ProcessOptions, 'dir'> {
  /** Override the output directory. By default uses `compiler.outputPath`. */
  dir?: string;
  /** If true, plugin is a no-op. */
  disabled?: boolean;
}

interface MinimalCompiler {
  hooks: { afterEmit: { tapPromise: (name: string, fn: (compilation: { compiler?: { outputPath?: string } }) => Promise<void>) => void } };
  outputPath?: string;
  options?: { output?: { path?: string } };
}

export class AllStakWebpackPlugin {
  /** Last successful report — exposed for tests / programmatic inspection. */
  public lastReport: ProcessReport | null = null;

  constructor(private readonly opts: AllStakWebpackPluginOptions = {} as AllStakWebpackPluginOptions) {}

  apply(compiler: MinimalCompiler): void {
    if (this.opts.disabled) return;

    compiler.hooks.afterEmit.tapPromise('AllStakWebpackPlugin', async (compilation) => {
      const dir =
        this.opts.dir ??
        compilation.compiler?.outputPath ??
        compiler.outputPath ??
        compiler.options?.output?.path ??
        process.cwd();

      try {
        this.lastReport = await processBuildOutput({
          ...this.opts,
          dir,
          silent: this.opts.silent ?? false,
        });
      } catch (e) {
        console.error(`[allstak/webpack] failed: ${(e as Error).message}`);
      }
    });
  }
}
