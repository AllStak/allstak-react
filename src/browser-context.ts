/**
 * Zero-config browser / OS / device context.
 *
 * Collected once at init (no config) and attached to every event as the
 * `browser`, `os`, and `device` contexts — the same shape Sentry ships — so
 * the dashboard can show "Chrome 124 on macOS, desktop, 1440×900" without the
 * host wiring anything. Fully SSR-safe: every probe is guarded and the whole
 * thing is fail-open (returns `{}` if `navigator`/`window` are absent).
 */

export interface BrowserContext {
  browser?: { name?: string; version?: string };
  os?: { name?: string; version?: string };
  device?: {
    type?: 'desktop' | 'mobile' | 'tablet';
    screenWidth?: number;
    screenHeight?: number;
    viewportWidth?: number;
    viewportHeight?: number;
    pixelRatio?: number;
  };
  culture?: { locale?: string; timezone?: string };
}

function detectBrowser(ua: string): { name?: string; version?: string } {
  // Order matters — Edge/Opera/Brave masquerade as Chrome, so test them first.
  const checks: Array<[string, RegExp]> = [
    ['Edge', /Edg(?:e|A|iOS)?\/([\d.]+)/],
    ['Opera', /OPR\/([\d.]+)/],
    ['Samsung Internet', /SamsungBrowser\/([\d.]+)/],
    ['Firefox', /Firefox\/([\d.]+)/],
    ['Chrome', /Chrome\/([\d.]+)/],
    ['Safari', /Version\/([\d.]+).*Safari/],
  ];
  for (const [name, re] of checks) {
    const m = ua.match(re);
    if (m) return { name, version: m[1] };
  }
  return {};
}

function detectOS(ua: string): { name?: string; version?: string } {
  if (/Windows NT 10/.test(ua)) return { name: 'Windows', version: '10' };
  if (/Windows NT 11/.test(ua)) return { name: 'Windows', version: '11' };
  if (/Windows NT ([\d.]+)/.test(ua)) return { name: 'Windows', version: RegExp.$1 };
  const mac = ua.match(/Mac OS X ([\d_]+)/);
  if (mac) return { name: 'macOS', version: mac[1].replace(/_/g, '.') };
  const ios = ua.match(/OS ([\d_]+) like Mac OS X/);
  if (ios) return { name: 'iOS', version: ios[1].replace(/_/g, '.') };
  const android = ua.match(/Android ([\d.]+)/);
  if (android) return { name: 'Android', version: android[1] };
  if (/Linux/.test(ua)) return { name: 'Linux' };
  return {};
}

function detectDeviceType(ua: string): 'desktop' | 'mobile' | 'tablet' {
  if (/iPad|Tablet|PlayBook|Silk/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua))) return 'tablet';
  if (/Mobi|iPhone|iPod|Android.*Mobile|Windows Phone/.test(ua)) return 'mobile';
  return 'desktop';
}

/** Collect the browser/os/device/culture context. Fail-open → `{}`. */
export function collectBrowserContext(): BrowserContext {
  try {
    if (typeof navigator === 'undefined') return {};
    const ua = navigator.userAgent || '';
    const ctx: BrowserContext = {
      browser: detectBrowser(ua),
      os: detectOS(ua),
      device: { type: detectDeviceType(ua) },
    };
    if (typeof screen !== 'undefined' && ctx.device) {
      if (Number.isFinite(screen.width)) ctx.device.screenWidth = screen.width;
      if (Number.isFinite(screen.height)) ctx.device.screenHeight = screen.height;
    }
    if (typeof window !== 'undefined' && ctx.device) {
      if (Number.isFinite(window.innerWidth)) ctx.device.viewportWidth = window.innerWidth;
      if (Number.isFinite(window.innerHeight)) ctx.device.viewportHeight = window.innerHeight;
      if (Number.isFinite(window.devicePixelRatio)) ctx.device.pixelRatio = window.devicePixelRatio;
    }
    const culture: { locale?: string; timezone?: string } = {};
    if (navigator.language) culture.locale = navigator.language;
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz) culture.timezone = tz;
    } catch {
      /* ignore */
    }
    if (culture.locale || culture.timezone) ctx.culture = culture;
    return ctx;
  } catch {
    return {};
  }
}
