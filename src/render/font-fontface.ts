// TS twin of the fontFaceHelper iframe shim. Same algorithm, lifted out so
// font-fontface.test.ts can exercise it with happy-dom + injected mocks.
// The JS string in widget-iframe.ts:fontFaceHelper is a hand-written ES5
// mirror; any logic change here MUST be mirrored there.

import type { VishrunFontEntry } from '../core/font-proxy';

export interface FontResource { url: string }
export type FontFetch = (url: string) => Promise<FontResource>;

export interface FontFaceLike {
  load(): Promise<unknown>;
}

export type FontFaceCtor = new (
  family: string,
  source: string,
  descriptors: Record<string, string>,
) => FontFaceLike;

export interface FontSetLike {
  add(face: FontFaceLike): void;
}

export interface VishrunFontsDeps {
  fetchFont: FontFetch;
  fontFaceCtor: FontFaceCtor;
  fontSet: FontSetLike;
  cache?: Map<string, boolean>;
  warn?: (msg: string, ...args: unknown[]) => void;
}

function isFontEntry(v: unknown): v is VishrunFontEntry {
  return !!v
    && typeof v === 'object'
    && typeof (v as VishrunFontEntry).url === 'string'
    && typeof (v as VishrunFontEntry).family === 'string'
    && (v as VishrunFontEntry).url.length > 0
    && (v as VishrunFontEntry).family.length > 0;
}

export async function processVishrunFonts(
  root: Document | HTMLElement,
  deps: VishrunFontsDeps,
): Promise<void> {
  const cache = deps.cache ?? new Map<string, boolean>();
  const warn = deps.warn ?? ((msg: string, ...args: unknown[]) => console.warn(msg, ...args));
  const scripts = root.querySelectorAll('script[data-vishrun-fonts]');
  const tasks: Array<Promise<void>> = [];

  for (const s of Array.from(scripts)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(s.textContent || '[]');
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    for (const raw of parsed) {
      if (!isFontEntry(raw)) continue;
      const entry = raw;
      if (cache.get(entry.url)) continue;
      cache.set(entry.url, true);
      const task = (async () => {
        try {
          const resource = await deps.fetchFont(entry.url);
          if (!resource || !resource.url) {
            cache.set(entry.url, false);
            return;
          }
          const face = new deps.fontFaceCtor(entry.family, `url(${resource.url})`, {
            weight: entry.weight ?? '400',
            style: entry.style ?? 'normal',
            display: entry.display ?? 'swap',
          });
          await face.load();
          deps.fontSet.add(face);
        } catch (err) {
          cache.set(entry.url, false);
          warn('[vishrun] fetchFont failed for', entry.url, err);
        }
      })();
      tasks.push(task);
    }
  }

  await Promise.all(tasks);
}
