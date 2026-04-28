/**
 * Engine-agnostic Error.stack parser. Handles V8 / Hermes ("at fn (file:l:c)")
 * and Gecko / JSC ("fn@file:l:c"). Output mirrors the backend
 * ErrorIngestRequest.Frame shape so the dashboard can render frames directly.
 */

export interface StackFrame {
  filename?: string;
  absPath?: string;
  function?: string;
  lineno?: number;
  colno?: number;
  inApp?: boolean;
  platform?: string;
}

const V8_FRAME_RE = /^\s*at\s+(?:(.+?)\s+\()?((?:.+?):(\d+):(\d+))\)?\s*$/;
const GECKO_FRAME_RE = /^\s*(?:(.*?)@)?(.+?):(\d+):(\d+)\s*$/;
const NODE_INTERNAL_RE = /^(node:|internal\/|node_modules\/)/;

export function parseStack(stack: string | undefined | null): StackFrame[] {
  if (!stack || typeof stack !== 'string') return [];
  const frames: StackFrame[] = [];

  for (const raw of stack.split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    let m = V8_FRAME_RE.exec(line);
    if (m) {
      const filename = stripQueryHash(m[2].replace(/:\d+:\d+$/, ''));
      frames.push({
        filename,
        absPath: filename,
        function: m[1] ? m[1].trim() : undefined,
        lineno: parseInt(m[3], 10),
        colno: parseInt(m[4], 10),
        inApp: isInApp(filename),
      });
      continue;
    }

    m = GECKO_FRAME_RE.exec(line);
    if (m && m[2]) {
      const filename = stripQueryHash(m[2]);
      frames.push({
        filename,
        absPath: filename,
        function: m[1] ? m[1].trim() : undefined,
        lineno: parseInt(m[3], 10),
        colno: parseInt(m[4], 10),
        inApp: isInApp(filename),
      });
    }
  }

  return frames;
}

function stripQueryHash(url: string): string {
  const q = url.indexOf('?');
  const h = url.indexOf('#');
  let cut = url.length;
  if (q >= 0) cut = Math.min(cut, q);
  if (h >= 0) cut = Math.min(cut, h);
  return url.slice(0, cut);
}

function isInApp(filename: string | undefined): boolean {
  if (!filename) return true;
  if (NODE_INTERNAL_RE.test(filename)) return false;
  if (filename.includes('/node_modules/')) return false;
  return true;
}
