/**
 * Next.js wrapper — `withAllStak(nextConfig)` decorates a project's
 * `next.config.js` so the AllStak Webpack plugin runs on every build.
 *
 *   // next.config.js
 *   const { withAllStak } = require('@allstak/react/next');
 *
 *   module.exports = withAllStak({
 *     release: process.env.ALLSTAK_RELEASE,
 *     token: process.env.ALLSTAK_UPLOAD_TOKEN,
 *     dist: 'web',
 *   }, {
 *     reactStrictMode: true,
 *     // …rest of your Next config…
 *   });
 *
 * The wrapper:
 *   - sets `productionBrowserSourceMaps: true` so Next emits `.map`
 *     files for the client bundles (the only ones we symbolicate).
 *   - chains any user-provided `webpack(config, ctx)` so we don't
 *     stomp existing customizations.
 */

import { AllStakWebpackPlugin, type AllStakWebpackPluginOptions } from './webpack';

type NextConfigLike = Record<string, unknown> & {
  productionBrowserSourceMaps?: boolean;
  webpack?: (config: unknown, ctx: unknown) => unknown;
};

interface WebpackConfigLike {
  plugins?: unknown[];
  devtool?: string | false;
}

interface WebpackContextLike {
  isServer?: boolean;
  dev?: boolean;
}

export function withAllStak(
  allstakOpts: AllStakWebpackPluginOptions,
  nextConfig: NextConfigLike = {},
): NextConfigLike {
  const userWebpack = nextConfig.webpack;

  return {
    ...nextConfig,
    productionBrowserSourceMaps:
      nextConfig.productionBrowserSourceMaps ?? true,

    webpack(config: unknown, ctx: unknown): unknown {
      const webpackConfig = (config as WebpackConfigLike) ?? {};
      const webpackCtx = (ctx as WebpackContextLike) ?? {};
      const plugins = webpackConfig.plugins ?? (webpackConfig.plugins = []);

      // Only attach to the client compilation. Server bundles run in
      // Node where stack traces are already symbolicated.
      if (!webpackCtx.isServer && !webpackCtx.dev) {
        plugins.push(new AllStakWebpackPlugin(allstakOpts));
      }

      return userWebpack ? userWebpack(webpackConfig, ctx) : webpackConfig;
    },
  };
}

export type { AllStakWebpackPluginOptions };
