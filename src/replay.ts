/**
 * From-scratch rrweb-grade visual session replay (no third-party deps).
 *
 * Records a full DOM snapshot with STABLE NODE IDS, then an incremental stream
 * of mutations (add / remove / attribute / text), scroll, input, pointer, and
 * viewport events that reference those ids — so the dashboard player rebuilds
 * the exact tree and applies changes in time order, reproducing what the user
 * saw (mutations, style changes, scrolling, modals, forms, route transitions,
 * dynamic UI). Around that visual stream sit the debugging markers — network,
 * console, error, navigation, idle — that power the unified timeline.
 *
 * Capture strategy (resolved once per session): `session` (continuous, 5s
 * flush), `buffer` (rolling 60s in memory, flushed 60s-before + 30s-after on an
 * error), or `off`. Critical routes upgrade a session to continuous capture.
 *
 * Privacy-first: inputs masked by default, ALL TEXT masked by default
 * (same-length `*`, opt out per element via the `unmask` selectors),
 * [type=password] always, [data-allstak-mask] subtrees redacted, request URLs
 * query-stripped, no scripts recorded. Everything that leaves via the replay
 * stream (DOM text, click target text, console args, input values, attribute
 * values) is additionally routed through the same PII value-scrubber used for
 * error payloads.
 */

import type { HttpTransport } from './transport';
import { NodeIdMap, serializeNode, serializeAttributeValue, NodeKind, prefetchCrossOriginStyles, readCrossOriginStylesheet, maskOrScrubText, type SerializeOptions } from './replay-serialize';
import { scrubString, type ValueScrubOptions } from './pii-scrub';

type AddBreadcrumbFn = (type: string, msg: string, level?: string, data?: Record<string, unknown>) => void;

const REPLAY_INGEST_PATH = '/ingest/v1/replay';
const DEFAULT_MASK_ATTR = 'data-allstak-mask';
const DEFAULT_UNMASK_ATTR_SELECTOR = '[data-allstak-unmask]';
const DEFAULT_CRITICAL = ['/checkout', '/payment', '/signup', '/onboarding', '/billing'];

export type ReplayMode = 'off' | 'session' | 'buffer';

export interface ReplayOptions {
  enabled?: boolean;
  sampleRate?: number;
  replaySessionSampleRate?: number;
  replayOnErrorSampleRate?: number;
  replayCriticalFlowSampleRate?: number;
  criticalFlows?: string[];
  maskAllInputs?: boolean;
  /**
   * Mask ALL text nodes (and click target text) with same-length `*`
   * characters. Default **true** — page text (names, emails, balances, IDs)
   * never ships unless an element is explicitly allowlisted via `unmask`.
   */
  maskAllText?: boolean;
  /**
   * CSS selectors whose subtree text is exempt from `maskAllText`. The
   * `[data-allstak-unmask]` attribute is always honored in addition to these.
   * `[data-allstak-mask]` (redaction) always wins over unmask.
   */
  unmask?: string[];
  maskAttribute?: string;
  /**
   * Options for the PII value-scrubber applied to everything that leaves via
   * the replay stream. Wired by the client from `sendDefaultPii`. @internal
   */
  valueScrubOptions?: ValueScrubOptions;
  maxBufferedEvents?: number;
  bufferWindowMs?: number;
  postErrorMs?: number;
  idleMs?: number;
  flushIntervalMs?: number;
  /** Force a fresh full DOM snapshot at this cadence so the rolling buffer
   *  always has a recent base to rebuild from. Default 25s. */
  checkoutMs?: number;
  /** GAP 3 — opt-in canvas replay. 'off' (default), 'snapshot' (captured in each
   *  full snapshot only), or 'frame' (also sampled periodically for animation). */
  recordCanvas?: 'off' | 'snapshot' | 'frame';
  /** Canvas frame-sampling interval when recordCanvas==='frame'. Default 1000ms. */
  canvasSampleMs?: number;
  replayId?: string;
  release?: string;
  environment?: string;
}

type Kind = 'fsnap' | 'mut' | 'scroll' | 'input' | 'mouse' | 'vp' | 'click' | 'nav' | 'net' | 'console' | 'err' | 'idle' | 'cvs';

interface ReplayEvent {
  ts: number;
  k: Kind;
  data: Record<string, unknown>;
}

const FLAG = '__allstak_replay_started__';

export class ReplayRecorder {
  private buffer: ReplayEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private checkoutTimer: ReturnType<typeof setInterval> | null = null;
  private observer: MutationObserver | null = null;
  private observedShadowRoots = new WeakSet<ShadowRoot>(); // GAP 1
  private cssLinksSeen = new Set<string>(); // GAP 2 — cross-origin sheets handled
  private canvasTimer: ReturnType<typeof setInterval> | null = null; // GAP 3 (frame mode)
  private listeners: Array<{ t: string; fn: EventListener; cap: boolean; target: 'doc' | 'win' }> = [];
  private ids = new NodeIdMap();
  private opts: Required<Omit<ReplayOptions, 'replayId' | 'release' | 'environment' | 'criticalFlows' | 'valueScrubOptions'>> & {
    replayId: string; release?: string; environment?: string; criticalFlows: string[];
    valueScrubOptions: ValueScrubOptions;
  };
  private sessionId: string;
  private mode: ReplayMode = 'off';
  private destroyed = false;
  private snapshotTaken = false;
  private lastActivity = 0;
  private idleSince = 0;
  private origConsole: Partial<Record<'log' | 'warn' | 'error', (...a: unknown[]) => void>> = {};

  constructor(
    private transport: HttpTransport,
    sessionId: string,
    private addBreadcrumb: AddBreadcrumbFn,
    options: ReplayOptions = {},
  ) {
    this.sessionId = sessionId;
    const legacy = options.sampleRate ?? 0;
    this.opts = {
      enabled: options.enabled ?? true,
      sampleRate: legacy,
      replaySessionSampleRate: options.replaySessionSampleRate ?? legacy,
      replayOnErrorSampleRate: options.replayOnErrorSampleRate ?? 0,
      replayCriticalFlowSampleRate: options.replayCriticalFlowSampleRate ?? 1,
      criticalFlows: options.criticalFlows ?? DEFAULT_CRITICAL,
      maskAllInputs: options.maskAllInputs ?? true,
      maskAllText: options.maskAllText ?? true,
      unmask: [...(options.unmask ?? []), DEFAULT_UNMASK_ATTR_SELECTOR],
      maskAttribute: options.maskAttribute ?? DEFAULT_MASK_ATTR,
      valueScrubOptions: options.valueScrubOptions ?? {},
      maxBufferedEvents: options.maxBufferedEvents ?? 10_000,
      bufferWindowMs: options.bufferWindowMs ?? 60_000,
      postErrorMs: options.postErrorMs ?? 30_000,
      idleMs: options.idleMs ?? 8_000,
      flushIntervalMs: options.flushIntervalMs ?? 5_000,
      checkoutMs: options.checkoutMs ?? 25_000,
      recordCanvas: options.recordCanvas ?? 'off',
      canvasSampleMs: options.canvasSampleMs ?? 1_000,
      replayId: options.replayId ?? sessionId,
      release: options.release,
      environment: options.environment,
    };
  }

  getMode(): ReplayMode { return this.mode; }

  // ── lifecycle ─────────────────────────────────────────────────────

  start(): void {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;
    if (!this.opts.enabled) return;
    if ((document as any)[FLAG]) return;
    this.mode = this.resolveMode(location.pathname);
    if (this.mode === 'off') return;
    (document as any)[FLAG] = true;
    this.lastActivity = Date.now();

    // Snapshot after the framework's first commit (init runs pre-render), or a
    // 1s fallback — whichever comes first. Then install the incremental stream.
    this.installDomObserver();
    void prefetchCrossOriginStyles(); // GAP 2 — warm the cross-origin CSS cache
    setTimeout(() => this.snapshotWithStyles('init'), 1000);
    this.installUserActions();
    this.installPointer();
    this.installViewport();
    this.installConsole();

    this.idleTimer = this.unref(setInterval(() => this.checkIdle(), 2_000));
    this.checkoutTimer = this.unref(setInterval(() => { if (this.snapshotTaken) this.snapshotWithStyles('checkout'); }, this.opts.checkoutMs));
    if (this.mode === 'session') this.flushTimer = this.unref(setInterval(() => this.flush(), this.opts.flushIntervalMs));
    // GAP 3 — periodic canvas sampling (frame mode) for animated canvases.
    if (this.opts.recordCanvas === 'frame') {
      this.canvasTimer = this.unref(setInterval(() => this.sampleCanvases(), this.opts.canvasSampleMs));
    }

    try {
      this.addBreadcrumb('default', `Replay recording started (${this.mode})`, 'info',
        { sessionId: this.sessionId, replayId: this.opts.replayId, mode: this.mode });
    } catch { /* ignore */ }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.observer) { this.observer.disconnect(); this.observer = null; }
    for (const l of this.listeners) {
      try { (l.target === 'doc' ? document : window).removeEventListener(l.t, l.fn, l.cap); } catch { /* ignore */ }
    }
    this.listeners = [];
    this.restoreConsole();
    for (const t of [this.flushTimer, this.idleTimer, this.checkoutTimer, this.canvasTimer]) if (t) clearInterval(t);
    this.flushTimer = this.idleTimer = this.checkoutTimer = this.canvasTimer = null;
    if (this.mode === 'session') this.flush();
    if (typeof document !== 'undefined') (document as any)[FLAG] = false;
  }

  /** @internal — tests. */
  getBuffer(): ReadonlyArray<ReplayEvent> { return this.buffer; }

  // ── full snapshot ─────────────────────────────────────────────────

  /** The shared serialize/masking options for snapshot + mutation paths. */
  private serializeOpts(): SerializeOptions {
    return {
      maskAllInputs: this.opts.maskAllInputs,
      maskAttribute: this.opts.maskAttribute,
      maskAllText: this.opts.maskAllText,
      unmaskSelectors: this.opts.unmask,
      scrubText: (value) => this.scrubText(value),
    };
  }

  /** Same PII value-scrubber as the error path. Fail-open. */
  private scrubText(value: string): string {
    try { return scrubString(value, this.opts.valueScrubOptions); } catch { return value; }
  }

  private takeFullSnapshot(reason: string): void {
    if (this.destroyed || this.mode === 'off') return;
    try {
      const root = document.documentElement ? document : document;
      const node = serializeNode(document, this.ids, this.serializeOpts());
      if (!node) return;
      void root;
      this.snapshotTaken = true;
      this.push({
        ts: Date.now(), k: 'fsnap',
        data: {
          node,
          href: location.href,
          width: window.innerWidth,
          height: window.innerHeight,
          scrollX: Math.round(window.scrollX),
          scrollY: Math.round(window.scrollY),
          reason,
        },
      });
      this.observeShadowRoots(document); // GAP 1 — watch any shadow roots present
    } catch { /* never break replay */ }
  }

  /** Prefetch cross-origin CSS, then snapshot — so CDN-styled widgets paint. */
  private snapshotWithStyles(reason: string): void {
    prefetchCrossOriginStyles().then(() => this.takeFullSnapshot(reason)).catch(() => this.takeFullSnapshot(reason));
  }

  // ── GAP 1: shadow DOM observation ─────────────────────────────────
  /** Attach the MutationObserver to every (nested) open shadow root so changes
   *  inside encapsulated trees are recorded as incremental mutations. */
  private observeShadowRoots(root: Document | ShadowRoot | Element): void {
    if (!this.observer) return;
    const els = (root as ParentNode).querySelectorAll ? (root as ParentNode).querySelectorAll('*') : [];
    for (const el of Array.from(els)) {
      const sr = (el as Element).shadowRoot;
      if (sr && !this.observedShadowRoots.has(sr)) {
        this.observedShadowRoots.add(sr);
        try { this.observer.observe(sr, { childList: true, attributes: true, characterData: true, subtree: true }); } catch { /* ignore */ }
        this.observeShadowRoots(sr); // nested shadow roots
      }
    }
  }

  // ── GAP 2: capture a cross-origin stylesheet the moment it loads ──
  /** When a widget (e.g. Monaco) mounts and adds a CDN `<link>`, read its CSS
   *  via a CORS probe, then take a fresh snapshot so the inlined styles land in
   *  a base frame the player can rebuild from. */
  private handleStylesheetAdded(el: Element): void {
    const links: HTMLLinkElement[] = [];
    if (el.tagName === 'LINK' && (el.getAttribute('rel') || '').includes('stylesheet')) links.push(el as HTMLLinkElement);
    if (el.querySelectorAll) el.querySelectorAll('link[rel~="stylesheet"]').forEach((l) => links.push(l as HTMLLinkElement));
    for (const link of links) {
      const href = link.href;
      if (!href || this.cssLinksSeen.has(href)) continue;
      let crossOrigin = false;
      try { crossOrigin = new URL(href).origin !== location.origin; } catch { /* keep false */ }
      if (!crossOrigin) continue;
      this.cssLinksSeen.add(href);
      readCrossOriginStylesheet(href).then(() => { if (!this.destroyed && this.snapshotTaken) this.takeFullSnapshot('stylesheet-loaded'); });
    }
  }

  // ── GAP 3: canvas frame sampling ──────────────────────────────────
  private sampleCanvases(): void {
    if (this.destroyed || this.idleSince) return;
    const canvases = document.querySelectorAll('canvas');
    for (const c of Array.from(canvases)) {
      const id = this.ids.getId(c);
      if (id < 0) continue;
      try {
        const data = (c as HTMLCanvasElement).toDataURL();
        if (data && data.length < 2_000_000) this.push({ ts: Date.now(), k: 'cvs', data: { id, data } });
      } catch { /* tainted */ }
    }
  }

  // ── incremental DOM mutations ─────────────────────────────────────

  private installDomObserver(): void {
    this.observer = new MutationObserver((records) => {
      if (!this.snapshotTaken) { this.takeFullSnapshot('first-mutation'); return; }
      if (this.idleSince) return; // paused while idle
      const opt = this.serializeOpts();
      const adds: Array<{ parentId: number; nextId: number; node: unknown }> = [];
      const removes: number[] = [];
      const attrs: Array<{ id: number; key: string; value: string | null }> = [];
      const texts: Array<{ id: number; value: string }> = [];
      for (const r of records) {
        if (r.type === 'attributes') {
          const id = this.ids.getId(r.target);
          if (id < 0) continue;
          attrs.push({ id, key: r.attributeName!, value: serializeAttributeValue(r.target as Element, r.attributeName!, opt) });
        } else if (r.type === 'characterData') {
          const id = this.ids.getId(r.target);
          if (id < 0) continue;
          // Live text mutations follow the exact same masking policy as the
          // snapshot: [data-allstak-mask] redacts, maskAllText masks with
          // same-length `*` unless unmasked, and whatever remains is scrubbed.
          const parent = (r.target as CharacterData).parentElement ?? null;
          const masked = !!parent?.closest?.(`[${this.opts.maskAttribute}]`);
          texts.push({ id, value: maskOrScrubText(r.target.nodeValue || '', parent, masked, opt) });
        } else if (r.type === 'childList') {
          for (const removed of Array.from(r.removedNodes)) {
            const id = this.ids.getId(removed);
            if (id >= 0) removes.push(id);
          }
          for (const added of Array.from(r.addedNodes)) {
            if (added.nodeType !== Node.ELEMENT_NODE && added.nodeType !== Node.TEXT_NODE && added.nodeType !== Node.COMMENT_NODE) continue;
            const parentId = this.ids.getId(added.parentNode);
            if (parentId < 0) continue; // parent not in tree — captured when parent is added
            const nextId = this.ids.getId((added as ChildNode).nextSibling);
            const node = serializeNode(added, this.ids, opt);
            if (node) adds.push({ parentId, nextId, node });
            if (added.nodeType === Node.ELEMENT_NODE) {
              this.observeShadowRoots(added as Element); // GAP 1
              this.handleStylesheetAdded(added as Element); // GAP 2
            }
          }
        }
      }
      if (adds.length || removes.length || attrs.length || texts.length) {
        this.push({ ts: Date.now(), k: 'mut', data: { adds, removes, attrs, texts } });
      }
    });
    this.observer.observe(document, { childList: true, attributes: true, characterData: true, subtree: true });
    this.observeShadowRoots(document); // GAP 1 — watch shadow roots present at install
  }

  // ── user actions + scroll + input ─────────────────────────────────

  // Events from inside a shadow root are retargeted to the host at the document
  // level — composedPath()[0] is the true (possibly shadow-encapsulated) target.
  private eventTarget(ev: Event): Element | null {
    const path = ev.composedPath ? (ev.composedPath() as Node[]) : null;
    return ((path && path[0]) as Element) || (ev.target as Element) || null;
  }

  private installUserActions(): void {
    const onClick = (ev: Event) => {
      const t = this.eventTarget(ev);
      if (!t) return;
      this.markActivity();
      const me = ev as MouseEvent;
      // Click target text follows the text-masking policy (mask attribute →
      // redact; maskAllText → same-length `*` unless unmasked; then scrubbed).
      const opt = this.serializeOpts();
      const clickMasked = !!t.closest?.(`[${this.opts.maskAttribute}]`);
      const text = maskOrScrubText((t.textContent || '').trim().slice(0, 40), t, clickMasked, opt);
      this.push({ ts: Date.now(), k: 'click', data: { id: this.ids.getId(t), target: this.describePath(t), text, x: me.clientX ?? 0, y: me.clientY ?? 0 } });
    };
    const onInput = (ev: Event) => {
      const t = this.eventTarget(ev) as HTMLInputElement | null;
      if (!t || !('value' in t)) return;
      this.markActivity();
      this.push({ ts: Date.now(), k: 'input', data: { id: this.ids.getId(t), target: this.describePath(t), value: this.maskInputValue(t), checked: (t as HTMLInputElement).checked === true } });
    };
    let scrollRaf = 0;
    const onScroll = (ev: Event) => {
      this.markActivity();
      if (scrollRaf) return;
      const target = ev.target as Node | Document | null;
      scrollRaf = this.unref(setTimeout(() => {
        scrollRaf = 0;
        const isDoc = !target || target === document || target === document.documentElement || target === document.body;
        const id = isDoc ? 1 : this.ids.getId(target as Node);
        const x = isDoc ? Math.round(window.scrollX) : Math.round((target as Element).scrollLeft);
        const y = isDoc ? Math.round(window.scrollY) : Math.round((target as Element).scrollTop);
        this.push({ ts: Date.now(), k: 'scroll', data: { id, x, y } });
      }, 120)) as unknown as number;
    };
    this.addDoc('click', onClick, true);
    this.addDoc('input', onInput, true);
    this.addDoc('scroll', onScroll, true); // capture-phase catches scrollable element scroll
  }

  private installPointer(): void {
    let last = 0; let raf = 0; let lx = 0; let ly = 0;
    const onMove = (ev: Event) => {
      const me = ev as MouseEvent;
      lx = me.clientX; ly = me.clientY;
      const now = Date.now();
      if (raf || now - last < 60) return;
      raf = this.unref(setTimeout(() => { raf = 0; last = Date.now(); this.push({ ts: Date.now(), k: 'mouse', data: { x: Math.round(lx), y: Math.round(ly) } }); }, 50)) as unknown as number;
    };
    this.addWin('mousemove', onMove, true);
  }

  private installViewport(): void {
    let raf = 0;
    const onResize = () => {
      if (raf) return;
      raf = this.unref(setTimeout(() => { raf = 0; this.markActivity(); this.push({ ts: Date.now(), k: 'vp', data: { width: window.innerWidth, height: window.innerHeight } }); }, 200)) as unknown as number;
    };
    this.addWin('resize', onResize, false);
  }

  private installConsole(): void {
    if (typeof console === 'undefined') return;
    (['warn', 'error', 'log'] as const).forEach((level) => {
      const orig = console[level]?.bind(console);
      if (!orig) return;
      this.origConsole[level] = orig;
      (console as any)[level] = (...args: unknown[]) => {
        // Captured console args pass through the same PII value-scrubber as
        // the error path BEFORE truncation (so a CC/SSN is never half-cut
        // into an unrecognizable-but-leaking fragment).
        try { this.push({ ts: Date.now(), k: 'console', data: { level, message: this.scrubText(args.map((a) => this.stringifyArg(a)).join(' ')).slice(0, 500) } }); } catch { /* ignore */ }
        return orig(...args);
      };
    });
  }
  private restoreConsole(): void {
    (['warn', 'error', 'log'] as const).forEach((level) => { if (this.origConsole[level]) (console as any)[level] = this.origConsole[level]; });
    this.origConsole = {};
  }

  // ── public feeds (called by the client) ──────────────────────────

  recordNetwork(req: { method?: string; url?: string; statusCode?: number; durationMs?: number; requestId?: string; ok?: boolean; timing?: Record<string, number>; reqSize?: number; resSize?: number }): void {
    if (this.mode === 'off') return;
    this.markActivity();
    this.push({
      ts: Date.now(), k: 'net',
      data: {
        method: (req.method || 'GET').toUpperCase(),
        url: this.stripUrl(req.url || ''),
        status: req.statusCode ?? 0,
        durationMs: Math.round(req.durationMs ?? 0),
        ok: req.ok ?? (typeof req.statusCode === 'number' ? req.statusCode < 400 : false),
        requestId: req.requestId || '',
        timing: req.timing || null,
        reqSize: req.reqSize ?? null,
        resSize: req.resSize ?? null,
      },
    });
  }

  recordNavigation(from: string, to: string, route?: string): void {
    if (this.mode === 'off') return;
    this.markActivity();
    this.push({ ts: Date.now(), k: 'nav', data: { from: this.stripUrl(from), to: this.stripUrl(to), route: route || to } });
    // A route transition replaces the DOM — capture a fresh base snapshot shortly
    // after so the player rebuilds the new route cleanly. Prefetch cross-origin CSS
    // first (a new route may mount a CDN-styled widget like Monaco). The slightly
    // longer delay lets such widgets attach their stylesheet before we snapshot.
    setTimeout(() => { if (!this.destroyed && this.snapshotTaken) this.snapshotWithStyles('navigation'); }, 300);
    if (this.mode === 'buffer' && this.isCritical(to) && Math.random() < this.opts.replayCriticalFlowSampleRate) this.upgradeToSession();
  }

  recordError(errorId: string, message: string, exceptionClass: string): void {
    if (this.mode === 'off') return;
    this.push({ ts: Date.now(), k: 'err', data: { errorId, message: this.scrubText(String(message)).slice(0, 500), exceptionClass } });
    if (this.mode === 'buffer') {
      this.flush();
      this.unref(setTimeout(() => { if (!this.destroyed) this.flush(); }, this.opts.postErrorMs));
    }
  }

  // ── idle ──────────────────────────────────────────────────────────

  private markActivity(): void {
    this.lastActivity = Date.now();
    if (this.idleSince) {
      const skipped = Date.now() - this.idleSince;
      this.idleSince = 0;
      this.push({ ts: Date.now(), k: 'idle', data: { skippedMs: skipped } });
    }
  }
  private checkIdle(): void {
    if (this.destroyed || this.idleSince) return;
    if (Date.now() - this.lastActivity > this.opts.idleMs) this.idleSince = this.lastActivity;
  }

  // ── mode / sampling ───────────────────────────────────────────────

  private resolveMode(route: string): ReplayMode {
    if (this.isCritical(route) && Math.random() < this.opts.replayCriticalFlowSampleRate) return 'session';
    if (this.opts.replaySessionSampleRate > 0 && Math.random() < this.opts.replaySessionSampleRate) return 'session';
    if (this.opts.replayOnErrorSampleRate > 0 && Math.random() < this.opts.replayOnErrorSampleRate) return 'buffer';
    return 'off';
  }
  private isCritical(route: string): boolean {
    const r = (route || '').toLowerCase();
    return this.opts.criticalFlows.some((c) => r.includes(c));
  }
  private upgradeToSession(): void {
    this.mode = 'session';
    if (!this.flushTimer) this.flushTimer = this.unref(setInterval(() => this.flush(), this.opts.flushIntervalMs));
    this.flush();
    try { this.addBreadcrumb('default', 'Replay upgraded to session (critical flow)', 'info', { replayId: this.opts.replayId }); } catch { /* ignore */ }
  }

  // ── buffer + flush ────────────────────────────────────────────────

  private push(ev: ReplayEvent): void {
    if (this.destroyed || this.mode === 'off') return;
    this.buffer.push(ev);
    if (this.mode === 'buffer') this.trimWindow();
    else if (this.buffer.length >= this.opts.maxBufferedEvents) this.flush();
  }

  /** Keep only the rolling pre-error window — but always retain the latest full
   *  snapshot at/before the window start so the player has a base to rebuild. */
  private trimWindow(): void {
    const cutoff = Date.now() - this.opts.bufferWindowMs;
    let baseIdx = -1;
    for (let i = 0; i < this.buffer.length; i++) {
      if (this.buffer[i]!.k === 'fsnap' && this.buffer[i]!.ts <= cutoff) baseIdx = i;
    }
    if (baseIdx > 0) this.buffer.splice(0, baseIdx);
    if (this.buffer.length > this.opts.maxBufferedEvents) {
      // Hard cap — drop from the front but never below the most recent fsnap.
      let lastSnap = -1;
      for (let i = 0; i < this.buffer.length; i++) if (this.buffer[i]!.k === 'fsnap') lastSnap = i;
      const drop = Math.min(this.buffer.length - this.opts.maxBufferedEvents, Math.max(0, lastSnap));
      if (drop > 0) this.buffer.splice(0, drop);
    }
  }

  flush(): void {
    if (this.buffer.length === 0) return;
    const events = this.buffer;
    this.buffer = [];
    this.transport.send(REPLAY_INGEST_PATH, {
      sessionId: this.sessionId,
      replayId: this.opts.replayId,
      release: this.opts.release,
      environment: this.opts.environment,
      events,
    });
  }

  // ── helpers ───────────────────────────────────────────────────────

  private unref<T extends { unref?: () => void }>(timer: T): T {
    if (timer && typeof timer === 'object' && typeof timer.unref === 'function') timer.unref();
    return timer;
  }
  private addDoc(t: string, fn: EventListener, cap: boolean): void { document.addEventListener(t, fn, cap); this.listeners.push({ t, fn, cap, target: 'doc' }); }
  private addWin(t: string, fn: EventListener, cap: boolean): void { window.addEventListener(t, fn, cap); this.listeners.push({ t, fn, cap, target: 'win' }); }

  private stripUrl(url: string): string {
    if (!url) return '';
    try { const u = new URL(url, location.href); return u.origin + u.pathname; } catch { return String(url).split('?')[0]!; }
  }
  private stringifyArg(a: unknown): string {
    if (a == null) return String(a);
    if (typeof a === 'string') return a;
    if (a instanceof Error) return `${a.name}: ${a.message}`;
    try { return JSON.stringify(a); } catch { return String(a); }
  }
  private maskInputValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): string {
    if ((el as HTMLInputElement).type === 'password') return '***';
    if (this.opts.maskAllInputs) return '***';
    // Unmasked input values still pass through the PII value-scrubber.
    return this.scrubText(String((el as any).value ?? ''));
  }
  private describePath(el: Element | null): string {
    if (!el || el.nodeType !== 1) return '';
    const parts: string[] = [];
    let cur: Element | null = el; let depth = 0;
    while (cur && depth < 8) {
      let p = cur.tagName.toLowerCase();
      if (cur.id) { p += `#${cur.id}`; parts.unshift(p); break; }
      if (cur.classList?.length) p += '.' + Array.from(cur.classList).slice(0, 2).join('.');
      parts.unshift(p); cur = cur.parentElement; depth += 1;
    }
    return parts.join('>');
  }
}

// Keep the NodeKind import referenced for downstream type-only consumers.
void NodeKind;
