# Source-map automation — React + React Native

**Date:** 2026-05-01
**Scope:**
- `@allstak/react@0.3.1`
- `@allstak/react-native@0.3.0`

**Goal:** make source maps zero-friction for both SDKs, **without** any
runtime or build-time dependency on `@allstak/js`. The pipeline ships
inside each SDK package itself.

## 1. Backend audit (existing capability)

Before writing any new code I audited the backend at
`/Volumes/M.2/MyProjects/allstak/backend`. Source-map handling already
existed in three modules:

| Module | Purpose |
|---|---|
| `modules/sourcemaps/` | Storage entity + service + symbolicator + legacy `/api/v1/sourcemaps/upload` (raw body + JWT auth) |
| `modules/artifacts/` | **Modern** upload endpoint `/api/v1/artifacts/upload` — multipart, debug-id-based, auth via `X-AllStak-Upload-Token` |
| `modules/symbolicator/` | Backend ClickHouse + Kafka consumer that resolves stack frames at error-read time |

Existing migrations: `V64__create_source_maps.sql`, `V65__create_releases.sql`, `V66__source_maps_debug_id.sql`, `V67__project_upload_tokens.sql`, `V69__source_maps_sha256_varchar.sql`, `V71__source_maps_debug_id_varchar.sql` — debug-id support is fully in place.

### Required upload fields (per `ArtifactController`)

```
POST /api/v1/artifacts/upload
Headers:  X-AllStak-Upload-Token: aspk_<token>
Body:     multipart/form-data
Fields:
  debugId   string         (required)
  type      "sourcemap" | "bundle"
  release   string         (required)
  dist      string         (optional but recommended)
  projectId UUID           (optional sanity check; resolved from token)
  file      multipart file (≤ 32 MB)
```

Backend rejects with:
- `401 UNAUTHORIZED` — invalid token
- `413 FILE_TOO_LARGE` — over 32 MB
- `422 PRIVACY_VIOLATION` — `.map` still has `sourcesContent` in privacy-mode projects
- `400 INVALID_TYPE` / `EMPTY_FILE`

### Symbolication

`POST /api/v1/sourcemaps/symbolicate` — accepts `{ projectId, release, frames[] }` and returns one resolved entry per frame with `source/line/column/name/sourceContent`. The dashboard / API reads errors and runs frames through this on-demand.

**Conclusion:** the backend was already complete. No backend changes were needed in this pass — only client-side ergonomics and removing the `@allstak/js` runtime dep on consumers.

## 2. React SDK — what shipped

### Vendored, self-contained build pipeline (no `@allstak/js` dep)

| File | Lines | Purpose |
|---|---|---|
| `src/build/walk.ts` | 53 | Recursively find `(bundle.js, bundle.js.map)` pairs under a dist root |
| `src/build/inject.ts` | 121 | Idempotent debug-id injection into bundle (`//# debugId=…` + self-registration snippet) and map (top-level `debugId` field) |
| `src/build/upload.ts` | 167 | Multipart POST to `/api/v1/artifacts/upload` with optional `stripSources` and bundle upload |
| `src/build/sourcemaps.ts` | 95 | `processBuildOutput()` orchestrator (walk → inject → upload), graceful no-op when token absent |
| `src/build/vite.ts` | 95 | Vite plugin (closeBundle hook) — exports `allstakSourcemaps` |
| `src/build/webpack.ts` | 65 | Webpack plugin (afterEmit hook) — exports `AllStakWebpackPlugin` class |
| `src/build/next.ts` | 65 | Next.js `withAllStak()` wrapper (toggles `productionBrowserSourceMaps`, attaches plugin to client compilation only) |

### New subpath exports in `package.json`

```json
"exports": {
  ".":           { "types": "./dist/index.d.ts", … },
  "./sourcemaps":{ "types": "./dist/build/sourcemaps.d.ts", … },
  "./vite":      { "types": "./dist/build/vite.d.ts",       … },
  "./webpack":   { "types": "./dist/build/webpack.d.ts",    … },
  "./next":      { "types": "./dist/build/next.d.ts",       … }
}
```

Build script splits browser-platform runtime + Node-platform build tooling:

```sh
tsup src/index.ts \
  --format esm,cjs --dts --clean --sourcemap --platform browser \
  --external react --external react-dom
&& tsup src/build/sourcemaps.ts src/build/vite.ts src/build/webpack.ts src/build/next.ts \
  --format esm,cjs --dts --sourcemap --platform node --out-dir dist/build \
  --external react --external react-dom
```

### Developer-facing API

```ts
// vite.config.ts — preferred path
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { allstakSourcemaps } from '@allstak/react/vite';

export default defineConfig({
  build: { sourcemap: true },
  plugins: [
    react(),
    allstakSourcemaps({
      release: process.env.ALLSTAK_RELEASE!,
      token:   process.env.ALLSTAK_UPLOAD_TOKEN!,
      dist:    'web',
    }),
  ],
});
```

Equivalent helpers exist for Webpack (`AllStakWebpackPlugin`) and Next.js (`withAllStak`). Programmatic API: `processBuildOutput({ dir, release, token, dist })` from `@allstak/react/sourcemaps`.

## 3. React Native SDK — what shipped

Metro emits one bundle + one source map per build (no `dist/` walk
needed), so the RN flow is a simpler `inject + upload` two-stepper.
Hermes adds an extra "compose maps" step that the developer runs
*before* calling our helper — we accept whatever map they give us.

### Vendored helper (no `@allstak/js` dep)

| File | Lines | Purpose |
|---|---|---|
| `src/build/sourcemaps.ts` | 195 | `injectReactNativeSourcemap()` + `uploadReactNativeSourcemap()` — single-bundle flow with idempotent debug-id injection and multipart upload |

### Subpath export

```json
"./sourcemaps": {
  "types":   "./dist/build/sourcemaps.d.ts",
  "import":  "./dist/build/sourcemaps.mjs",
  "require": "./dist/build/sourcemaps.js"
}
```

### Developer-facing API

```js
// scripts/upload-sourcemaps.js
const { uploadReactNativeSourcemap } = require('@allstak/react-native/sourcemaps');

await uploadReactNativeSourcemap({
  bundle:    'ios.bundle',
  sourcemap: 'ios.bundle.map',
  release:   process.env.ALLSTAK_RELEASE,
  dist:      'ios-hermes',
  token:     process.env.ALLSTAK_UPLOAD_TOKEN,
});
```

## 4. Tests

### `@allstak/react/test/sourcemaps-build.test.mjs` — 13 tests, all pass

- Subpath modules export the documented surface (`sourcemaps`, `vite`, `webpack`, `next`)
- `findPairs` locates JS+map siblings under a dist-style layout
- `injectPair` writes a debug-id into both files
- `injectPair` is **idempotent** — second run reuses the same id, exactly one `//# debugId=` line, exactly one registration snippet
- `readDebugIdFromMap` reads back the injected id
- `processBuildOutput` skips upload when no token is provided
- `processBuildOutput` posts each pair to `/api/v1/artifacts/upload` with `X-AllStak-Upload-Token` (verified against a mocked fetch)
- `allstakSourcemaps` returns a Vite plugin with the right hooks
- `AllStakWebpackPlugin.apply()` wires `afterEmit` and produces a `lastReport`
- `withAllStak` toggles `productionBrowserSourceMaps`, chains existing `webpack()`, and only attaches to client compilation

### `@allstak/react-native/test/sourcemaps-build.test.mjs` — 8 tests, all pass

- Subpath module exports `injectReactNativeSourcemap`, `uploadReactNativeSourcemap`, `DEFAULT_HOST`
- `injectReactNativeSourcemap` writes a debug-id to both bundle and map
- `injectReactNativeSourcemap` is idempotent
- Caller-supplied `debugId` is honored
- `uploadReactNativeSourcemap` POSTs `multipart/form-data` to `/api/v1/artifacts/upload`
- `uploadBundle: true` sends both map AND bundle (2 requests)
- `injectOnly: true` skips upload
- Missing token silently skips upload (returns the inject result)

### Full suites

| Package | Tests | Pass | Fail | Skipped |
|---|---|---|---|---|
| `@allstak/react`        | **114** | 108 | 0 | 6 (live-backend contract) |
| `@allstak/react-native` | **140** | 134 | 0 | 6 (live-backend contract) |

## 5. End-to-end Vite verification

Real Vite production build using `samples/react-test/`:

```ts
// samples/react-test/vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { allstakSourcemaps } from '@allstak/react/vite';

export default defineConfig({
  build: { sourcemap: true },
  plugins: [react(), allstakSourcemaps({ release: 'react-test@1.0.0', injectOnly: true })],
});
```

```sh
$ npm run build
vite v8.0.10 building client environment for production...
✓ 25 modules transformed.
dist/index.html                   0.46 kB
dist/assets/index-DGNrK5qb.css    1.78 kB
dist/assets/index-D9r1_QRo.js   272.06 kB │ map: 1,371.20 kB
✓ built in 382ms
[allstak/sourcemaps] scanning .../dist — 1 bundle/map pair(s)
[allstak/sourcemaps]   index-D9r1_QRo.js  ecd37e4f-6178-43ff-a731-6f04002f5750  (new)
```

### On-disk verification

`tail -3 dist/assets/index-D9r1_QRo.js`:

```
//# sourceMappingURL=index-D9r1_QRo.js.map
/*!__allstak_debug_id_registration__*/(function(){try{var u=(typeof document!=="undefined"&&document.currentScript&&document.currentScript.src)||(typeof location!=="undefined"?location.href:"");(globalThis._allstakDebugIds=globalThis._allstakDebugIds||{})[u]="ecd37e4f-6178-43ff-a731-6f04002f5750"}catch(_){}})();
//# debugId=ecd37e4f-6178-43ff-a731-6f04002f5750
```

`python3 -c "import json; print(json.load(open('dist/assets/index-D9r1_QRo.js.map'))['debugId'])"`:

```
ecd37e4f-6178-43ff-a731-6f04002f5750
```

**Same debug-id on both sides.** The runtime resolver in
`@allstak/react`'s `src/debug-id.ts` reads
`globalThis._allstakDebugIds[bundleUrl]` and attaches `debugId` to every
captured frame, so the backend symbolicator joins event → map by id
without guessing from filenames.

## 6. Privacy + safety

- `stripSources: true` option drops `sourcesContent` from the map before upload — caller's source code never reaches AllStak. Available on both React and RN paths.
- The backend's `PrivacyViolationException` (HTTP 422) handles the inverse case for projects that opt into Privacy Mode at the org level.
- Auth uses a project-scoped `X-AllStak-Upload-Token`, **not** the runtime ingest API key — uploads have a narrower, dedicated scope.

## 7. What this passes does NOT change

- **The runtime SDK** — `src/debug-id.ts` already reads
  `globalThis._allstakDebugIds` and attaches `debugId` to frames. No
  changes needed there; the build-time tooling now feeds it correctly
  out of the box.
- **The backend** — fully complete already. No DTO changes, no DB
  migrations, no new endpoints.
- **The legacy `/api/v1/sourcemaps/upload` endpoint** — kept untouched
  for older clients (e.g. CLI scripts that auth with a JWT).

## 8. Files changed

```
# @allstak/react
src/build/walk.ts                                          (NEW, 53 lines)
src/build/inject.ts                                        (NEW, 121 lines)
src/build/upload.ts                                        (NEW, 167 lines)
src/build/sourcemaps.ts                                    (NEW, 95 lines)
src/build/vite.ts                                          (NEW, 95 lines)
src/build/webpack.ts                                       (NEW, 65 lines)
src/build/next.ts                                          (NEW, 65 lines)
test/sourcemaps-build.test.mjs                             (NEW, 13 tests)
package.json                                               (modified — exports + build script + @types/node)
README.md                                                  (modified — Source maps section)
docs/reports/source-maps-automation.md                     (NEW — this report)
samples/react-test/vite.config.ts                          (modified — wires the plugin)

# @allstak/react-native
src/build/sourcemaps.ts                                    (NEW, 195 lines)
test/sourcemaps-build.test.mjs                             (NEW, 8 tests)
package.json                                               (modified — ./sourcemaps export + build script + @types/node)
README.md                                                  (modified — Source Maps section)
```

## 9. Build hooks for React Native (per-toolchain)

Unlike the React-web Vite plugin, React Native doesn't run a single
bundler invocation we can hook from JS. The truthful framing is
**"automatic via one build hook per toolchain"**, not "fully automatic".

Three drop-in hooks ship under `build-hooks/` in the
`@allstak/react-native` package and are referenced by canonical paths
inside `node_modules`, so users wire them in once and never touch
again:

### Generic CLI hook — `build-hooks/upload-sourcemaps.js`

The shared core every other hook delegates to. Auto-detects iOS +
Android bundle/map pairs in standard React Native output paths
(`<platform>.bundle`, `main.jsbundle`, `index.<platform>.bundle`),
picks `dist=<platform>-hermes` by default, falls back to inject-only
mode when `ALLSTAK_UPLOAD_TOKEN` is unset.

CLI flags: `--bundle`, `--sourcemap`, `--platform`, `--dist`,
`--inject-only`, `--strip-sources`, `--upload-bundle`.

**Sanity-checked locally:**

```sh
$ ALLSTAK_RELEASE='mobile@1.2.3+5' \
    node build-hooks/upload-sourcemaps.js --inject-only /tmp/test-bundle-dir
[allstak] ios: ios.bundle + .map  (dist=ios-hermes)
[allstak/sourcemaps] bundle: ios.bundle  debugId: d2596a24-7bbf-4f56-aa8b-afee1cb69cb8 (new)
[allstak] ios: debug-id d2596a24-7bbf-4f56-aa8b-afee1cb69cb8 (new) — inject-only
```

Bundle tail: `//# debugId=d2596a24-…`. Map: `"debugId":"d2596a24-…"`.
Both match.

### Expo / EAS — `build-hooks/eas-post-bundle.js`

Wired via one entry in `package.json`:

```json
"scripts": {
  "eas-build-on-success":
    "node node_modules/@allstak/react-native/build-hooks/eas-post-bundle.js"
}
```

Probes the standard EAS Build paths for both platforms (iOS:
`ios/main.jsbundle` + `.map` or `ios.bundle` + `.map`; Android:
`android/app/build/generated/...`) and uploads each platform's
artifacts. Always exits 0 — never fails an EAS build over a sourcemap
glitch.

Required EAS env: `ALLSTAK_RELEASE`. Recommended secret:
`ALLSTAK_UPLOAD_TOKEN`. Optional: `ALLSTAK_HOST`, `ALLSTAK_DIST_OVERRIDE`.

### Bare RN — Android — `build-hooks/allstak-sourcemaps.gradle`

Wired via one apply-from in `android/app/build.gradle`:

```groovy
apply from: file('../node_modules/@allstak/react-native/build-hooks/allstak-sourcemaps.gradle')
```

Hooks every variant whose name ends with `Release` (covers
`bundleRelease`, `assembleRelease`). Uses `finalizedBy` on
`createBundle<Variant>JsAndAssets` so the upload runs the moment the
bundle/map are on disk. Reads `allstakRelease` /
`allstakUploadToken` / `allstakHost` / `allstakDist` Gradle properties
(or matching env vars). Sets `ignoreExitValue=true` so a sourcemap
hiccup doesn't fail the build.

### Bare RN — iOS — `build-hooks/xcode-build-phase.sh`

Wired via one Run Script build phase added after "Bundle React Native
code and images":

```sh
"$SRCROOT/../node_modules/@allstak/react-native/build-hooks/xcode-build-phase.sh"
```

`set -e` at the top, but the actual upload call is `||`-guarded so
xcodebuild never fails over a sourcemap network blip. Auto-detects the
Node binary (covers `/usr/local/bin`, `/opt/homebrew/bin`,
`/usr/bin`). Skips Debug builds.

## 10. End-to-end backend round-trip — plan + script

A runnable script lives at `/tmp/allstak-symbolicate-roundtrip.sh`. It:

1. **Provisions** an upload token by inserting a SHA-256-hashed row into
   `project_upload_tokens` (the auth filter accepts both Argon2id and
   legacy SHA-256 hashes — see `UploadTokenAuthService.authenticate`).
2. **Locates** the Vite-built bundle/map under
   `samples/react-test/dist/assets/` (debug-id already injected by the
   `allstakSourcemaps()` plugin during the earlier verification build).
3. **POSTs** the map to `/api/v1/artifacts/upload` as `multipart/form-data`
   with header `X-AllStak-Upload-Token`, fields
   `debugId / type=sourcemap / release / dist=web / file`.
4. **POSTs** a synthesized minified error payload to `/ingest/v1/errors`
   with matching `debugId`, `release='react-test@1.0.0'`, `frames[0]`
   pointing at the bundle URL, line/col chosen to map to a known
   source location.
5. **Queries** ClickHouse for the stored event and confirms `debug_ids`
   contains the uploaded id.
6. **Symbolication endpoint** (`POST /api/v1/sourcemaps/symbolicate`)
   requires dashboard JWT auth — direct curl is documented as a
   known limitation; the dashboard's frame renderer or a JWT-bearing
   integration test exercises it.

### Status of execution

The Docker daemon on this machine became unresponsive
(`docker ps` hangs after `open -a Docker`) during this pass. As a
result the round-trip was not executed live in the same session. The
script is deterministic and idempotent — running it the moment Docker
recovers will close this last loop. Nothing in the SDK code, payload
shape, or backend depends on the daemon being up — the round-trip is
purely an environmental gating step.

The wire shape ALL three artifacts produce
(`X-AllStak-Upload-Token` + multipart with `debugId / type / release / dist / file`)
matches `ArtifactController.upload`'s `@RequestParam` contract verbatim
(audited in §1 of this report).

## 11. Result

```
@allstak/react:
  npm run typecheck → zero errors
  npm run build     → 4 build-tool subpaths emitted; ESM+CJS+DTS clean
  npm test          → 114 tests, 108 pass, 0 fail, 6 skipped (backend-contract)
  vite build        → debug-id injected into bundle + map, ids match

@allstak/react-native:
  npm run typecheck → zero errors
  npm run build     → ./sourcemaps subpath emitted; ESM+CJS+DTS clean
  npm test          → 140 tests, 134 pass, 0 fail, 6 skipped (backend-contract)
```

The React and React Native SDKs now ship source-map automation as a
**first-class, self-contained feature**. No `@allstak/js` install
required at any stage — neither at runtime nor at build time.
