/**
 * Lightweight session-replay surrogate for the browser.
 *
 * **Status:** experimental. Captures DOM mutation events as a chronological
 * log so a server-side replay viewer can reconstruct the visible page over
 * time. Privacy-first defaults:
 *
 *   - all `<input>`, `<textarea>`, `<select>` values are masked by default
 *   - elements with `data-allstak-mask` are entirely replaced with `***`
 *   - `[type="password"]` is always masked, even with masking off
 *   - `sampleRate` defaults to 0 — replay is OPT-IN per init
 *
 * NOT a drop-in replacement for full DOM-snapshot replay libraries — it
 * does not record initial paint, window resizes, scroll positions, or
 * canvas content. It records:
 *
 *   1. an initial sanitized DOM snapshot at start
 *   2. mutations: childList add/remove + attributes (filtered)
 *   3. user input events with values masked
 *   4. a periodic flush of the buffered log to /ingest/v1/replay
 *
 * Because the wire format is a JSON event log (not a binary blob), payloads
 * are larger than dedicated replay tools — appropriate for low-volume
 * debugging, not for sampling 100% of production traffic.
 */

import type { HttpTransport } from './transport';

type AddBreadcrumbFn = (
  type: string,
  msg: string,
  level?: string,
  data?: Record<string, unknown>,
) => void;

const REPLAY_INGEST_PATH = '/ingest/v1/replay';
const FLUSH_INTERVAL_MS = 10_000;
const DEFAULT_MASK_ATTR = 'data-allstak-mask';

export interface ReplayOptions {
  enabled?: boolean;
  /** Probability per session that replay records. Default 0 (opt-in). */
  sampleRate?: number;
  /** Mask all text inputs / textareas / selects by default. Default true. */
  maskAllInputs?: boolean;
  /** Custom attribute name that flags an element to be masked. Default `data-allstak-mask`. */
  maskAttribute?: string;
  /** Max number of events buffered before forced flush. Default 200. */
  maxBufferedEvents?: number;
}

interface ReplayEvent {
  /** UNIX millis when the event was observed. */
  ts: number;
  /** event kind */
  k: 'snap' | 'mut' | 'input' | 'nav';
  /** Free-form JSON-friendly payload. */
  data: Record<string, unknown>;
}

const FLAG = '__allstak_replay_started__';

export class ReplayRecorder {
  private buffer: ReplayEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private observer: MutationObserver | null = null;
  private inputListener: ((ev: Event) => void) | null = null;
  private opts: Required<ReplayOptions>;
  private sessionId: string;
  private destroyed = false;

  constructor(
    private transport: HttpTransport,
    sessionId: string,
    private addBreadcrumb: AddBreadcrumbFn,
    options: ReplayOptions = {},
  ) {
    this.sessionId = sessionId;
    this.opts = {
      enabled: options.enabled ?? true,
      sampleRate: options.sampleRate ?? 0,
      maskAllInputs: options.maskAllInputs ?? true,
      maskAttribute: options.maskAttribute ?? DEFAULT_MASK_ATTR,
      maxBufferedEvents: options.maxBufferedEvents ?? 200,
    };
  }

  start(): void {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;
    if (!this.opts.enabled) return;
    if (Math.random() >= this.opts.sampleRate) return;
    if ((document as any)[FLAG]) return;
    (document as any)[FLAG] = true;

    // Initial sanitized snapshot.
    this.push({
      ts: Date.now(),
      k: 'snap',
      data: { html: this.snapshotBody(), url: location.href },
    });

    // DOM mutations.
    this.observer = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'childList') {
          this.push({
            ts: Date.now(),
            k: 'mut',
            data: {
              kind: 'childList',
              target: this.describePath(r.target as Element),
              added: Array.from(r.addedNodes).map((n) => this.describeNode(n)),
              removed: r.removedNodes.length,
            },
          });
        } else if (r.type === 'attributes') {
          this.push({
            ts: Date.now(),
            k: 'mut',
            data: {
              kind: 'attr',
              target: this.describePath(r.target as Element),
              name: r.attributeName,
              value: this.safeAttribute(r.target as Element, r.attributeName ?? ''),
            },
          });
        }
      }
    });
    this.observer.observe(document.body ?? document.documentElement, {
      childList: true, attributes: true, subtree: true,
    });

    // User input — values always masked.
    this.inputListener = (ev: Event) => {
      const target = ev.target as HTMLInputElement | null;
      if (!target || !('value' in target)) return;
      const masked = this.maskInputValue(target);
      this.push({
        ts: Date.now(),
        k: 'input',
        data: { target: this.describePath(target), value: masked, type: target.type },
      });
    };
    document.addEventListener('input', this.inputListener, true);

    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);

    try { this.addBreadcrumb('default', 'Replay recording started', 'info', { sessionId: this.sessionId }); }
    catch { /* ignore */ }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.observer) { this.observer.disconnect(); this.observer = null; }
    if (this.inputListener) {
      document.removeEventListener('input', this.inputListener, true);
      this.inputListener = null;
    }
    if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null; }
    this.flush();
    if (typeof document !== 'undefined') (document as any)[FLAG] = false;
  }

  /** @internal — exposed for tests. */
  getBuffer(): ReadonlyArray<ReplayEvent> { return this.buffer; }

  private push(ev: ReplayEvent): void {
    if (this.destroyed) return;
    this.buffer.push(ev);
    if (this.buffer.length >= this.opts.maxBufferedEvents) this.flush();
  }

  private flush(): void {
    if (this.buffer.length === 0) return;
    const events = this.buffer;
    this.buffer = [];
    this.transport.send(REPLAY_INGEST_PATH, {
      sessionId: this.sessionId,
      events,
    });
  }

  // ── Sanitization helpers ──────────────────────────────────────────

  private snapshotBody(): string {
    if (!document.body) return '';
    const clone = document.body.cloneNode(true) as HTMLElement;
    this.maskTree(clone);
    return clone.outerHTML;
  }

  private maskTree(root: Element): void {
    if (this.opts.maskAttribute && root.hasAttribute?.(this.opts.maskAttribute)) {
      root.textContent = '***';
      return;
    }
    const tag = root.tagName?.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      (root as HTMLInputElement).value = this.maskInputValue(root as HTMLInputElement);
      root.setAttribute('value', (root as HTMLInputElement).value);
    }
    for (const child of Array.from(root.children)) this.maskTree(child);
  }

  private maskInputValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): string {
    // Password fields are ALWAYS masked, regardless of `maskAllInputs`.
    if ((el as HTMLInputElement).type === 'password') return '***';
    if (this.opts.maskAllInputs) return '***';
    return String((el as any).value ?? '');
  }

  private describeNode(node: Node): Record<string, unknown> {
    if (node.nodeType === 1) {
      return { type: 'element', tag: (node as Element).tagName?.toLowerCase() };
    }
    if (node.nodeType === 3) {
      return { type: 'text', length: (node.nodeValue ?? '').length };
    }
    return { type: 'other' };
  }

  private describePath(el: Element | null): string {
    if (!el || el.nodeType !== 1) return '';
    const parts: string[] = [];
    let cur: Element | null = el;
    let depth = 0;
    while (cur && depth < 8) {
      let p = cur.tagName.toLowerCase();
      if (cur.id) { p += `#${cur.id}`; parts.unshift(p); break; }
      if (cur.classList?.length) p += '.' + Array.from(cur.classList).slice(0, 2).join('.');
      parts.unshift(p);
      cur = cur.parentElement;
      depth += 1;
    }
    return parts.join('>');
  }

  private safeAttribute(el: Element, name: string): string {
    if (name === 'value' || name === 'defaultValue') return '***';
    return el.getAttribute(name) ?? '';
  }
}
