import { defineConfig } from 'tsup';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
const VERSION = JSON.stringify(pkg.version);

/**
 * Two-bundle build:
 *   - main entry (browser): src/index.ts
 *   - build plugins (node): src/build/{sourcemaps,vite,webpack,next}.ts
 *
 * Both inject __ALLSTAK_REACT_VERSION__ from package.json so the SDK
 * always reports the same version it ships under, with no hand-edited
 * constant to drift.
 */
export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    sourcemap: true,
    platform: 'browser',
    external: ['react', 'react-dom'],
    define: {
      __ALLSTAK_REACT_VERSION__: VERSION,
    },
  },
  {
    entry: [
      'src/build/sourcemaps.ts',
      'src/build/vite.ts',
      'src/build/webpack.ts',
      'src/build/next.ts',
    ],
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    platform: 'node',
    outDir: 'dist/build',
    external: ['react', 'react-dom'],
    define: {
      __ALLSTAK_REACT_VERSION__: VERSION,
    },
  },
]);
