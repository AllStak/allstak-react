export type ScreenshotRedactionMode = 'strict' | 'balanced' | 'custom';

export interface ScreenshotCapture {
  blob: Blob;
  contentType: string;
  width: number;
  height: number;
  redactionMode: ScreenshotRedactionMode;
  captureMethod: string;
  sizeBytes: number;
  metadata: Record<string, unknown>;
}

export interface ScreenshotCaptureOptions {
  redactionMode?: ScreenshotRedactionMode;
  maskStyle?: 'solid' | 'blur';
  maskSelectors?: string[];
  ignoreSelectors?: string[];
  allowSelectors?: string[];
  maxBytes?: number;
  quality?: number;
}

const DEFAULT_MAX_BYTES = 500_000;
const MASK = '••••••';
const SENSITIVE_RE = /(password|passwd|pwd|otp|one[-_ ]?time|token|secret|auth|card|cc-|credit|cvv|cvc|iban|bank|ssn|national|nid|phone|mobile|email|e-mail|id(?:entifier)?)/i;

export async function capturePrivacySafeScreenshot(
  options: ScreenshotCaptureOptions = {},
): Promise<ScreenshotCapture | null> {
  if (typeof document === 'undefined' || typeof window === 'undefined') return null;
  const mode = options.redactionMode ?? 'strict';
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const restore = applyRedactions(mode, options);
  try {
    const html2canvas = await loadHtml2Canvas();
    if (!html2canvas) return null;
    const canvas = await html2canvas(document.body, {
      allowTaint: false,
      useCORS: false,
      logging: false,
      backgroundColor: null,
      ignoreElements: (el: Element) => shouldIgnoreElement(el, options.ignoreSelectors),
      windowWidth: document.documentElement.scrollWidth,
      windowHeight: document.documentElement.scrollHeight,
    });
    const blob = await canvasToLimitedBlob(canvas, options.quality ?? 0.72, maxBytes);
    if (!blob) return null;
    return {
      blob,
      contentType: blob.type || 'image/webp',
      width: canvas.width,
      height: canvas.height,
      redactionMode: mode,
      captureMethod: 'html2canvas',
      sizeBytes: blob.size,
      metadata: {
        maskedInputs: restore.maskedInputs,
        maskedElements: restore.maskedElements,
        maskStyle: options.maskStyle ?? 'solid',
        ignoredElements: countSelectorMatches(['[data-allstak-ignore]', ...(options.ignoreSelectors ?? [])]),
      },
    };
  } catch {
    return null;
  } finally {
    restore.restore();
  }
}

async function loadHtml2Canvas(): Promise<((element: HTMLElement, options: Record<string, unknown>) => Promise<HTMLCanvasElement>) | null> {
  try {
    const mod = await import('html2canvas');
    return (mod.default ?? mod) as (element: HTMLElement, options: Record<string, unknown>) => Promise<HTMLCanvasElement>;
  } catch {
    return null;
  }
}

function applyRedactions(mode: ScreenshotRedactionMode, options: ScreenshotCaptureOptions): {
  maskedInputs: number;
  maskedElements: number;
  restore: () => void;
} {
  const restores: Array<() => void> = [];
  let maskedInputs = 0;
  let maskedElements = 0;

  const inputSelector = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';
  document.querySelectorAll<HTMLElement>(inputSelector).forEach((el) => {
    if (hasExplicitAllow(el, mode, options.allowSelectors) && !isAlwaysSensitive(el)) return;
    restores.push(maskFormLikeElement(el, options.maskStyle ?? 'solid'));
    maskedInputs += 1;
  });

  const maskSelectors = [
    '[data-allstak-mask]',
    '[data-sensitive]',
    '[aria-label]',
    '[name]',
    '[id]',
    '[autocomplete]',
    ...(options.maskSelectors ?? []),
  ];
  document.querySelectorAll<HTMLElement>(safeSelectorList(maskSelectors)).forEach((el) => {
    if (el.matches(inputSelector)) return;
    if (hasExplicitAllow(el, mode, options.allowSelectors) && !isAlwaysSensitive(el)) return;
    if (!shouldMaskElement(el) && !matchesAny(el, options.maskSelectors)) return;
    const originalText = el.textContent;
    const originalTitle = el.getAttribute('title');
    const originalFilter = el.style.filter;
    const originalBackground = el.style.backgroundColor;
    if ((options.maskStyle ?? 'solid') === 'blur') {
      el.style.filter = 'blur(8px)';
    } else {
      el.style.backgroundColor = '#d8dde7';
      el.textContent = MASK;
    }
    el.setAttribute('title', MASK);
    restores.push(() => {
      el.textContent = originalText;
      if (originalTitle === null) el.removeAttribute('title');
      else el.setAttribute('title', originalTitle);
      el.style.filter = originalFilter;
      el.style.backgroundColor = originalBackground;
    });
    maskedElements += 1;
  });

  return {
    maskedInputs,
    maskedElements,
    restore: () => {
      for (let i = restores.length - 1; i >= 0; i -= 1) {
        try { restores[i](); } catch { /* ignore */ }
      }
    },
  };
}

function maskFormLikeElement(el: HTMLElement, maskStyle: 'solid' | 'blur'): () => void {
  const originalBackground = el.style.backgroundColor;
  const originalColor = el.style.color;
  const originalTextShadow = el.style.textShadow;
  const originalFilter = el.style.filter;
  if (maskStyle === 'blur') {
    el.style.filter = 'blur(8px)';
  } else {
    el.style.backgroundColor = '#d8dde7';
    el.style.color = 'transparent';
    el.style.textShadow = '0 0 0 #3f4652';
  }

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const originalValue = el.value;
    const originalPlaceholder = el.placeholder;
    el.value = MASK;
    el.placeholder = MASK;
    return () => {
      el.value = originalValue;
      el.placeholder = originalPlaceholder;
      el.style.backgroundColor = originalBackground;
      el.style.color = originalColor;
      el.style.textShadow = originalTextShadow;
      el.style.filter = originalFilter;
    };
  }

  if (el instanceof HTMLSelectElement) {
    const originalDisabled = el.disabled;
    el.disabled = true;
    return () => {
      el.disabled = originalDisabled;
      el.style.backgroundColor = originalBackground;
      el.style.color = originalColor;
      el.style.textShadow = originalTextShadow;
      el.style.filter = originalFilter;
    };
  }

  const originalText = el.textContent;
  el.textContent = MASK;
  return () => {
    el.textContent = originalText;
    el.style.backgroundColor = originalBackground;
    el.style.color = originalColor;
    el.style.textShadow = originalTextShadow;
    el.style.filter = originalFilter;
  };
}

function shouldMaskElement(el: HTMLElement): boolean {
  if (el.hasAttribute('data-allstak-mask') || el.hasAttribute('data-sensitive')) return true;
  return isAlwaysSensitive(el);
}

function isAlwaysSensitive(el: HTMLElement): boolean {
  const haystack = [
    el.getAttribute('type'),
    el.getAttribute('name'),
    el.getAttribute('id'),
    el.getAttribute('autocomplete'),
    el.getAttribute('aria-label'),
    el.getAttribute('data-field'),
  ].filter(Boolean).join(' ');
  return SENSITIVE_RE.test(haystack);
}

function hasExplicitAllow(el: HTMLElement, mode: ScreenshotRedactionMode, allowSelectors?: string[]): boolean {
  return mode === 'custom' && (el.hasAttribute('data-allstak-allow') || matchesAny(el, allowSelectors));
}

function shouldIgnoreElement(el: Element, ignoreSelectors?: string[]): boolean {
  return el.hasAttribute('data-allstak-ignore') || matchesAny(el, ignoreSelectors);
}

function matchesAny(el: Element, selectors?: string[]): boolean {
  if (!selectors || selectors.length === 0) return false;
  for (const selector of selectors) {
    try {
      if (selector && el.matches(selector)) return true;
    } catch {
      // Invalid app-provided selector must not break capture.
    }
  }
  return false;
}

function safeSelectorList(selectors: string[]): string {
  const valid: string[] = [];
  const probe = document.createElement('div');
  for (const selector of selectors) {
    try {
      probe.matches(selector);
      valid.push(selector);
    } catch {
      // ignore invalid app-provided selectors
    }
  }
  return valid.join(', ');
}

function countSelectorMatches(selectors: string[]): number {
  let count = 0;
  for (const selector of selectors) {
    try { count += document.querySelectorAll(selector).length; } catch { /* ignore */ }
  }
  return count;
}

async function canvasToLimitedBlob(canvas: HTMLCanvasElement, quality: number, maxBytes: number): Promise<Blob | null> {
  const qualities = [quality, 0.6, 0.45, 0.32];
  for (const q of qualities) {
    const webp = await toBlob(canvas, 'image/webp', q);
    if (webp && webp.size <= maxBytes) return webp;
  }
  for (const scale of [0.75, 0.5, 0.35, 0.25]) {
    const scaled = scaleCanvas(canvas, scale);
    for (const q of qualities) {
      const webp = await toBlob(scaled, 'image/webp', q);
      if (webp && webp.size <= maxBytes) return webp;
    }
  }
  const png = await toBlob(canvas, 'image/png');
  if (png && png.size <= maxBytes) return png;
  return null;
}

function scaleCanvas(canvas: HTMLCanvasElement, scale: number): HTMLCanvasElement {
  const scaled = document.createElement('canvas');
  scaled.width = Math.max(1, Math.floor(canvas.width * scale));
  scaled.height = Math.max(1, Math.floor(canvas.height * scale));
  const ctx = scaled.getContext('2d');
  if (ctx) ctx.drawImage(canvas, 0, 0, scaled.width, scaled.height);
  return scaled;
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    try { canvas.toBlob((blob) => resolve(blob), type, quality); }
    catch { resolve(null); }
  });
}

export async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const value = String(reader.result ?? '');
      resolve(value.includes(',') ? value.slice(value.indexOf(',') + 1) : value);
    };
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read screenshot blob'));
    reader.readAsDataURL(blob);
  });
}
