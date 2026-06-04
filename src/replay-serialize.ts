/**
 * From-scratch DOM serializer for visual session replay (no third-party deps).
 *
 * Assigns a stable numeric id to every DOM node so incremental mutations can
 * reference nodes precisely, and the player can rebuild the exact tree. This is
 * the recorder half of an rrweb-grade engine — the player (dashboard) rebuilds
 * from these structures and applies the mutation stream.
 *
 * Fidelity captured:
 *   - full element/text/comment/doctype tree with attributes
 *   - inline <style> text AND same-origin <link rel=stylesheet> rules (inlined
 *     as `_cssText` so the sandboxed player renders styles without network)
 *   - input/textarea/select VALUES (masked) + checked state
 *   - SVG namespace, scroll positions captured separately
 *   - <script> stripped; <canvas>/<iframe> kept as elements (content omitted)
 *
 * Privacy: inputs masked by default; [data-allstak-mask] subtrees → "***";
 * [type=password] always masked.
 */

export const NodeKind = { DOCUMENT: 0, DOCTYPE: 1, ELEMENT: 2, TEXT: 3, COMMENT: 4 } as const;

export interface SerializedNode {
  id: number;
  k: number; // NodeKind
  // element
  tag?: string;
  ns?: string; // namespaceURI for SVG/MathML
  attrs?: Record<string, string>;
  children?: SerializedNode[];
  // open shadow root subtree (GAP 1) — the player re-attaches a shadow root and
  // rebuilds these into it. Nested shadow roots nest naturally (recursion).
  shadowId?: number;
  shadow?: SerializedNode[];
  // text / comment
  text?: string;
  // doctype
  name?: string;
  publicId?: string;
  systemId?: string;
}

export interface SerializeOptions {
  maskAllInputs: boolean;
  maskAttribute: string;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Owns the node→id map for one recording. Stable across mutations. */
export class NodeIdMap {
  private map = new WeakMap<Node, number>();
  private counter = 1;

  getId(node: Node | null): number {
    if (!node) return -1;
    const existing = this.map.get(node);
    return existing === undefined ? -1 : existing;
  }
  hasId(node: Node): boolean {
    return this.map.has(node);
  }
  assign(node: Node): number {
    let id = this.map.get(node);
    if (id === undefined) {
      id = this.counter++;
      this.map.set(node, id);
    }
    return id;
  }
  remove(node: Node): void {
    this.map.delete(node);
  }
}

function maskValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, opts: SerializeOptions): string {
  if ((el as HTMLInputElement).type === 'password') return '••••••';
  if (opts.maskAllInputs) return el.value ? '•'.repeat(Math.min(el.value.length, 12)) : '';
  return String(el.value ?? '');
}

// GAP 2 — cross-origin stylesheets can't be read via `cssRules` (SecurityError),
// so Monaco/CodeMirror (CDN-hosted CSS) lose their styling. We pre-fetch their
// text once (CDNs like jsdelivr send permissive CORS) and inline from this cache,
// absolutising any relative url() so fonts/icons still resolve from the player.
const crossOriginCssCache = new Map<string, string>();

function absolutizeCssUrls(css: string, baseHref: string): string {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, url) => {
    if (/^(data:|blob:|https?:|#)/i.test(url)) return m;
    try { return `url(${q}${new URL(url, baseHref).href}${q})`; } catch { return m; }
  });
}

/**
 * Make every cross-origin stylesheet's text available for inlining. We CANNOT
 * read a normal cross-origin `<link>` via `cssRules` (SecurityError), and a
 * plain `fetch()` is CORS-blocked by most CDNs. The reliable trick: re-load the
 * same href through a throwaway `<link crossorigin="anonymous">` — if the CDN
 * sends CORS (jsDelivr/unpkg/cdnjs do), `cssRules` on THAT sheet becomes
 * readable, so we can inline the full stylesheet (e.g. all 329 KB of Monaco's
 * editor.main.css). CDNs that don't send CORS simply fall back to the original
 * `<link href>` (the player loads it at replay time, as before).
 *
 * Idempotent + cached. Call before snapshotting and whenever a new cross-origin
 * stylesheet appears.
 */
export async function prefetchCrossOriginStyles(): Promise<void> {
  if (typeof document === 'undefined') return;
  const links = Array.from(document.querySelectorAll('link[rel~="stylesheet"]')) as HTMLLinkElement[];
  await Promise.all(links.map((link) => readCrossOriginStylesheet(link.href)));
}

/** Cache a single cross-origin stylesheet's text via a CORS-mode probe link. */
export function readCrossOriginStylesheet(href: string): Promise<void> {
  if (typeof document === 'undefined' || !href || crossOriginCssCache.has(href)) return Promise.resolve();
  // Already readable (same-origin)? It is inlined directly from cssRules; skip.
  try {
    for (const s of Array.from(document.styleSheets)) {
      if (s.href === href) { try { void s.cssRules; return Promise.resolve(); } catch { /* cross-origin */ break; } }
    }
  } catch { /* ignore */ }
  return new Promise((resolve) => {
    const probe = document.createElement('link');
    probe.rel = 'stylesheet';
    probe.crossOrigin = 'anonymous';
    probe.href = href;
    probe.media = 'print'; // don't let the probe affect the live page's rendering
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      try {
        const sheet = probe.sheet;
        if (sheet && sheet.cssRules) {
          let css = '';
          for (let i = 0; i < sheet.cssRules.length; i++) css += sheet.cssRules[i]!.cssText + '\n';
          if (css) crossOriginCssCache.set(href, absolutizeCssUrls(css, href));
        }
      } catch { /* CDN sent no CORS — leave the original <link href> for replay-time load */ }
      probe.remove();
      resolve();
    };
    probe.addEventListener('load', () => setTimeout(finish, 30));
    probe.addEventListener('error', finish);
    setTimeout(finish, 3000);
    document.head.appendChild(probe);
  });
}

function inlineStylesheet(link: HTMLLinkElement): string | null {
  try {
    const sheet = link.sheet;
    if (sheet) {
      const rules = sheet.cssRules; // throws for cross-origin
      let css = '';
      for (let i = 0; i < rules.length; i++) css += rules[i]!.cssText + '\n';
      if (css) return css;
    }
  } catch { /* cross-origin — fall through to the prefetched cache */ }
  return crossOriginCssCache.get(link.href) ?? null;
}

function serializeAttrs(el: Element, opts: SerializeOptions): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const a of Array.from(el.attributes)) {
    // Never record inline event handlers or nonces.
    if (a.name.startsWith('on') || a.name === 'nonce') continue;
    attrs[a.name] = a.value;
  }
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    const input = el as HTMLInputElement;
    attrs.value = maskValue(input, opts);
    if (input.type === 'checkbox' || input.type === 'radio') {
      if (input.checked) attrs.checked = ''; else delete attrs.checked;
    }
  }
  if (tag === 'link' && (el.getAttribute('rel') || '').includes('stylesheet')) {
    const css = inlineStylesheet(el as HTMLLinkElement);
    if (css != null) attrs._cssText = css; // player turns this into a <style>
  }
  // Absolute-ize src/href so the player (different origin) can still load images.
  for (const k of ['src', 'href']) {
    const v = el.getAttribute(k);
    if (v && !v.startsWith('data:') && !v.startsWith('blob:')) {
      try { attrs[k] = new URL(v, location.href).href; } catch { /* keep */ }
    }
  }
  return attrs;
}

/**
 * Recursively serialize a node, assigning ids. Returns null for nodes we skip
 * (<script>, empty whitespace-only comments are kept; scripts dropped).
 */
export function serializeNode(node: Node, ids: NodeIdMap, opts: SerializeOptions, mask = false): SerializedNode | null {
  switch (node.nodeType) {
    case Node.DOCUMENT_NODE: {
      const id = ids.assign(node);
      const children: SerializedNode[] = [];
      for (const child of Array.from((node as Document).childNodes)) {
        const s = serializeNode(child, ids, opts, mask);
        if (s) children.push(s);
      }
      return { id, k: NodeKind.DOCUMENT, children };
    }
    case Node.DOCUMENT_TYPE_NODE: {
      const dt = node as DocumentType;
      return { id: ids.assign(node), k: NodeKind.DOCTYPE, name: dt.name, publicId: dt.publicId, systemId: dt.systemId };
    }
    case Node.ELEMENT_NODE: {
      const el = node as Element;
      const tag = el.tagName.toLowerCase();
      if (tag === 'script' || tag === 'noscript') return null;
      const id = ids.assign(node);
      // Masking propagates to the WHOLE subtree (privacy): once inside a
      // [data-allstak-mask] element, every descendant text/value is redacted.
      const subtreeMask = mask || el.hasAttribute(opts.maskAttribute);
      const out: SerializedNode = { id, k: NodeKind.ELEMENT, tag, attrs: serializeAttrs(el, opts) };
      if (el.namespaceURI === SVG_NS) out.ns = SVG_NS;
      if (subtreeMask && out.attrs && typeof out.attrs.value === 'string' && out.attrs.value) out.attrs.value = '••••••';
      // GAP 3 — <canvas> pixels aren't DOM. Snapshot the current bitmap as a data
      // URL so the player can paint it (tainted/cross-origin canvases throw → skip).
      if (tag === 'canvas') {
        try {
          const data = (el as HTMLCanvasElement).toDataURL();
          if (data && data.length < 2_000_000) (out.attrs ||= {})._canvasData = data;
        } catch { /* tainted canvas — cannot snapshot */ }
      }
      // <style> text is content; everything else recurses into children.
      if (tag === 'style') {
        out.children = [{ id: ids.assign(el.firstChild ?? document.createTextNode('')), k: NodeKind.TEXT, text: cssTextOf(el as HTMLStyleElement) }];
        return out;
      }
      const children: SerializedNode[] = [];
      for (const child of Array.from(el.childNodes)) {
        const s = serializeNode(child, ids, opts, subtreeMask);
        if (s) children.push(s);
      }
      out.children = children;
      // GAP 1 — open shadow root: serialize its subtree separately so the player
      // re-attaches a shadow root and rebuilds into it. Nested shadow roots nest
      // via this same recursion. (Closed shadow roots are inaccessible by design.)
      const sr = (el as Element).shadowRoot;
      if (sr) {
        out.shadowId = ids.assign(sr); // so the player can target the shadow root for dynamic mutations
        const shadowChildren: SerializedNode[] = [];
        for (const child of Array.from(sr.childNodes)) {
          const s = serializeNode(child, ids, opts, subtreeMask);
          if (s) shadowChildren.push(s);
        }
        out.shadow = shadowChildren;
      }
      return out;
    }
    case Node.TEXT_NODE: {
      const raw = node.nodeValue || '';
      return { id: ids.assign(node), k: NodeKind.TEXT, text: mask && raw.trim() ? '••••••' : raw };
    }
    case Node.COMMENT_NODE: {
      return { id: ids.assign(node), k: NodeKind.COMMENT, text: node.nodeValue || '' };
    }
    default:
      return null;
  }
}

function cssTextOf(style: HTMLStyleElement): string {
  // Prefer the live sheet (covers CSS-in-JS that mutates rules) then textContent.
  try {
    const sheet = style.sheet;
    if (sheet && sheet.cssRules && sheet.cssRules.length) {
      let css = '';
      for (let i = 0; i < sheet.cssRules.length; i++) css += sheet.cssRules[i]!.cssText + '\n';
      if (css) return css;
    }
  } catch { /* fall through */ }
  return style.textContent || '';
}

/** A single attribute value, with the same masking the snapshot uses. */
export function serializeAttributeValue(el: Element, name: string, opts: SerializeOptions): string | null {
  const tag = el.tagName.toLowerCase();
  if (name === 'value' && (tag === 'input' || tag === 'textarea' || tag === 'select')) {
    return maskValue(el as HTMLInputElement, opts);
  }
  if (name.startsWith('on') || name === 'nonce') return null;
  const v = el.getAttribute(name);
  if (v == null) return null;
  if ((name === 'src' || name === 'href') && !v.startsWith('data:') && !v.startsWith('blob:')) {
    try { return new URL(v, location.href).href; } catch { return v; }
  }
  return v;
}
