/**
 * Release auto-detection for allstak-react.
 *
 * allstak-react is a **browser-only** SDK. There is no `child_process` in a
 * browser, so RUNTIME local-git detection is impossible here — step 3 below is
 * intentionally a documented **no-op** (it exists so the resolution order is
 * identical across the AllStak JS SDKs, and so a future Node-rendered usage
 * could opt in by injecting a runner). The real improvement for this package
 * is making sure the env → SDK-version fallback yields a non-empty `release`.
 *
 * Resolution order for `release` (highest priority first):
 *   1. Explicit `config.release`                  — always wins (client.ts).
 *   2. Env vars (ALLSTAK_RELEASE, VERCEL_GIT_*, …) — `releaseFromEnv` below.
 *      (Only meaningful when the bundler inlines build-time env, e.g. Vite
 *       `import.meta.env` / Next `process.env`. At true browser runtime
 *       `process` is usually absent — handled safely.)
 *   3. Local git at init (BROWSER → NO-OP)        — `detectGitRelease`.
 *   4. SDK version constant                       — never-empty fallback.
 *
 * Steps 3 + 4 are gated by `autoDetectRelease` (default true).
 */

/** A function that runs a git command and returns its trimmed stdout. */
export type GitRunner = (args: string[]) => string;

/**
 * Parse raw git output into a release string. PURE — no I/O, no spawning.
 * Shared shape with the other AllStak SDKs so tests/behavior stay identical.
 */
export function parseGitRelease(
  describeOut: string | undefined,
  revParseOut?: string | undefined,
  porcelainOut?: string | undefined,
): string | undefined {
  const describe = normalizeLine(describeOut);
  if (describe) return describe;

  const sha = normalizeLine(revParseOut);
  if (!sha) return undefined;
  const dirty = typeof porcelainOut === 'string' && porcelainOut.trim().length > 0;
  return dirty ? `${sha}-dirty` : sha;
}

function normalizeLine(out: string | undefined): string | undefined {
  if (!out) return undefined;
  const first = out.split('\n')[0]?.trim();
  return first && first.length > 0 ? first : undefined;
}

/** Read an env var safely; returns undefined in browsers where `process` is absent. */
export function envVar(name: string): string | undefined {
  try {
    if (typeof process !== 'undefined' && process.env) {
      const v = process.env[name];
      if (v && v.length > 0) return v;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

/** Conventional CI/runtime env vars for a release identifier. */
export function releaseFromEnv(): string | undefined {
  return (
    envVar('ALLSTAK_RELEASE') ??
    envVar('npm_package_version') ??
    envVar('VERCEL_GIT_COMMIT_SHA')?.slice(0, 12) ??
    envVar('RAILWAY_GIT_COMMIT_SHA')?.slice(0, 12) ??
    envVar('RENDER_GIT_COMMIT')?.slice(0, 12)
  );
}

/**
 * Is the current runtime a Node-like environment that *could* spawn git?
 * Always effectively false for the browser-only react SDK at true runtime.
 */
export function isNodeRuntime(): boolean {
  try {
    return (
      typeof process !== 'undefined' &&
      !!process.versions &&
      typeof process.versions.node === 'string' &&
      typeof (globalThis as any).window === 'undefined' &&
      !(typeof navigator !== 'undefined' && (navigator as any).product === 'ReactNative')
    );
  } catch {
    return false;
  }
}

let cachedRelease: string | undefined | null = null;

/** @internal — reset memoized git release for tests. */
export function __resetGitReleaseCacheForTest(): void {
  cachedRelease = null;
}

/**
 * Detect a release from local git. In the browser this is a **no-op** and
 * returns `undefined` — there is no `child_process`. A `GitRunner` may be
 * injected (test seam, or a future Node-render host); when omitted, detection
 * is skipped unless we're genuinely in Node. Result is cached.
 */
export function detectGitRelease(runner?: GitRunner | null): string | undefined {
  if (cachedRelease !== null) return cachedRelease ?? undefined;

  // No injected runner and not Node → browser no-op.
  const run = runner === undefined ? (isNodeRuntime() ? createNodeGitRunner() : null) : runner;
  if (!run) {
    cachedRelease = undefined;
    return undefined;
  }

  try {
    const describe = run(['describe', '--tags', '--always', '--dirty']);
    let release = parseGitRelease(describe);
    if (!release) {
      const sha = run(['rev-parse', '--short', 'HEAD']);
      const porcelain = run(['status', '--porcelain']);
      release = parseGitRelease(undefined, sha, porcelain);
    }
    cachedRelease = release;
    return release;
  } catch {
    cachedRelease = undefined;
    return undefined;
  }
}

/**
 * Guarded dynamic require of child_process — never statically imported so the
 * browser bundle is unaffected. Returns null off-Node or when unavailable.
 */
function createNodeGitRunner(timeoutMs = 1500): GitRunner | null {
  if (!isNodeRuntime()) return null;
  let cp: any;
  try {
    const req: ((id: string) => any) | undefined =
      typeof require === 'function'
        ? require
        : (typeof module !== 'undefined' && (module as any).require) || undefined;
    if (!req) return null;
    cp = req('child_process');
  } catch {
    return null;
  }
  if (!cp || typeof cp.execFileSync !== 'function') return null;
  return (args: string[]): string => {
    try {
      const out = cp.execFileSync('git', args, {
        timeout: timeoutMs,
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8',
        windowsHide: true,
      });
      return typeof out === 'string' ? out : '';
    } catch {
      return '';
    }
  };
}

/**
 * Resolve the effective `release` given an explicit value, applying the full
 * order. Returns the resolved string (possibly undefined when opted out).
 *
 * @param explicit   `config.release` if the user set it.
 * @param sdkVersion never-empty fallback (the package's SDK_VERSION).
 * @param autoDetect when false, disables steps 3 + 4 (git + version fallback).
 * @param gitRunner  test seam / future Node host.
 */
export function resolveRelease(
  explicit: string | undefined,
  sdkVersion: string,
  autoDetect: boolean,
  gitRunner?: GitRunner | null,
): string | undefined {
  if (explicit) return explicit; // 1. explicit always wins

  const fromEnv = releaseFromEnv(); // 2. env vars
  if (fromEnv) return fromEnv;

  if (!autoDetect) return undefined;

  const fromGit = detectGitRelease(gitRunner); // 3. local git (browser → no-op)
  if (fromGit) return fromGit;

  return sdkVersion; // 4. never-empty SDK-version fallback
}
