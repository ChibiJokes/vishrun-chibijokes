import type { SpindleFrontendContext } from 'lumiverse-spindle-types';
import { fetchViaBackend } from './asset-injector';

// Cards declare Google Fonts two ways: `<link href="...googleapis...">` and
// `@import url('...googleapis...')` inside a <style>. Sandbox CSP blocks both
// (style-src 'unsafe-inline' only). We pre-fetch the googleapis CSS via the
// backend cors_proxy, parse each @font-face into a JSON entry, and emit an
// inert <script type="application/vishrun-font-config" data-vishrun-fonts>.
// The sandbox-side resolver reads the JSON, calls spindleSandbox.fetchFont(url)
// per entry, and registers a FontFace against document.fonts. Browser never
// sees a remote @font-face. The @import path also strips the import from the
// <style> so the cssproxy doesn't try to fetch it as an image.

export interface VishrunFontEntry {
  family: string;
  weight?: string;
  style?: string;
  display?: string;
  url: string;
}

const FONT_LINK_RE =
  /<link\b[^>]*\bhref\s*=\s*["'](https?:\/\/fonts\.googleapis\.com\/[^"']+)["'][^>]*>/gi;

const FONT_STYLE_BLOCK_RE = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
const FONT_IMPORT_RE =
  /@import\s+url\(\s*(['"]?)(https?:\/\/fonts\.googleapis\.com\/[^'")\s]+)\1\s*\)\s*;?/gi;

const FONT_FACE_BLOCK_RE = /@font-face\s*\{([^}]+)\}/gi;
const FONT_FACE_URL_RE = /src\s*:[^;]*url\(\s*['"]?(https?:\/\/[^'")\s]+)['"]?\s*\)/i;
const FONT_FACE_FAMILY_RE = /font-family\s*:\s*['"]?([^;'"]+?)['"]?\s*;/i;
const FONT_FACE_WEIGHT_RE = /font-weight\s*:\s*([^;]+?)\s*;/i;
const FONT_FACE_STYLE_RE = /font-style\s*:\s*([^;]+?)\s*;/i;
const FONT_FACE_DISPLAY_RE = /font-display\s*:\s*([^;]+?)\s*;/i;

const fontEntriesCache = new Map<string, Promise<VishrunFontEntry[]>>();

export function parseFontFaceRules(css: string): VishrunFontEntry[] {
  if (css.indexOf('@font-face') === -1) return [];
  const out: VishrunFontEntry[] = [];
  FONT_FACE_BLOCK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FONT_FACE_BLOCK_RE.exec(css)) !== null) {
    const body = m[1];
    const urlMatch = body.match(FONT_FACE_URL_RE);
    const familyMatch = body.match(FONT_FACE_FAMILY_RE);
    if (!urlMatch || !familyMatch) continue;
    const entry: VishrunFontEntry = {
      family: familyMatch[1].trim(),
      url: urlMatch[1],
    };
    const w = body.match(FONT_FACE_WEIGHT_RE);
    const s = body.match(FONT_FACE_STYLE_RE);
    const d = body.match(FONT_FACE_DISPLAY_RE);
    if (w) entry.weight = w[1].trim();
    if (s) entry.style = s[1].trim();
    if (d) entry.display = d[1].trim();
    out.push(entry);
  }
  return out;
}

export function extractGoogleFontsLinks(html: string): Array<{ fullTag: string; url: string }> {
  if (html.indexOf('fonts.googleapis.com') === -1) return [];
  const out: Array<{ fullTag: string; url: string }> = [];
  const seen = new Set<string>();
  FONT_LINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FONT_LINK_RE.exec(html)) !== null) {
    const fullTag = m[0];
    const url = decodeHtmlEntities(m[1]);
    if (!seen.has(fullTag)) {
      seen.add(fullTag);
      out.push({ fullTag, url });
    }
  }
  return out;
}

export interface FontImportMatch {
  fullStyleBlock: string;
  imports: Array<{ raw: string; url: string }>;
}

export function extractGoogleFontsImports(html: string): FontImportMatch[] {
  if (html.indexOf('fonts.googleapis.com') === -1) return [];
  if (html.indexOf('@import') === -1) return [];
  const out: FontImportMatch[] = [];
  const seenBlocks = new Set<string>();
  FONT_STYLE_BLOCK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FONT_STYLE_BLOCK_RE.exec(html)) !== null) {
    const fullStyleBlock = m[0];
    const cssContent = m[1];
    if (cssContent.indexOf('@import') === -1) continue;
    if (cssContent.indexOf('fonts.googleapis.com') === -1) continue;
    if (seenBlocks.has(fullStyleBlock)) continue;
    seenBlocks.add(fullStyleBlock);
    const imports: Array<{ raw: string; url: string }> = [];
    FONT_IMPORT_RE.lastIndex = 0;
    let im: RegExpExecArray | null;
    while ((im = FONT_IMPORT_RE.exec(cssContent)) !== null) {
      imports.push({ raw: im[0], url: im[2] });
    }
    if (imports.length > 0) out.push({ fullStyleBlock, imports });
  }
  return out;
}

// Cards serialize URLs in HTML attributes with `&amp;`. CSS inside <style> is
// not HTML-decoded, so @import URLs come through with raw `&` already.
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function getFontEntries(url: string, ctx: SpindleFrontendContext): Promise<VishrunFontEntry[]> {
  const cached = fontEntriesCache.get(url);
  if (cached) return cached;
  const pending = (async () => {
    const raw = await fetchViaBackend(url, ctx);
    return parseFontFaceRules(raw);
  })();
  fontEntriesCache.set(url, pending);
  pending.catch(() => {
    if (fontEntriesCache.get(url) === pending) fontEntriesCache.delete(url);
  });
  return pending;
}

// `</` inside the JSON payload could close the wrapper <script> early.
function htmlSafeJsonStringify(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function buildFontConfigScript(entries: VishrunFontEntry[]): string {
  return `<script type="application/vishrun-font-config" data-vishrun-fonts>${htmlSafeJsonStringify(entries)}</script>`;
}

export async function transformHtmlForGoogleFonts(
  html: string,
  ctx: SpindleFrontendContext,
): Promise<string> {
  const links = extractGoogleFontsLinks(html);
  const importBlocks = extractGoogleFontsImports(html);
  if (links.length === 0 && importBlocks.length === 0) return html;

  const allUrls = new Set<string>();
  for (const l of links) allUrls.add(l.url);
  for (const ib of importBlocks) for (const im of ib.imports) allUrls.add(im.url);

  const entriesByUrl = new Map<string, VishrunFontEntry[]>();
  const failed = new Set<string>();
  await Promise.all(
    Array.from(allUrls).map(async (u) => {
      try {
        entriesByUrl.set(u, await getFontEntries(u, ctx));
      } catch (err) {
        failed.add(u);
        console.warn(
          '[vishrun] Google Fonts fetch failed:',
          u,
          err instanceof Error ? err.message : String(err),
        );
      }
    }),
  );

  let out = html;

  for (const l of links) {
    if (failed.has(l.url)) continue;
    const entries = entriesByUrl.get(l.url) ?? [];
    const replacement = entries.length === 0 ? '' : buildFontConfigScript(entries);
    out = out.split(l.fullTag).join(replacement);
  }

  for (const ib of importBlocks) {
    let stripped = ib.fullStyleBlock;
    const scripts: string[] = [];
    for (const imp of ib.imports) {
      if (failed.has(imp.url)) continue;
      stripped = stripped.split(imp.raw).join('');
      const entries = entriesByUrl.get(imp.url) ?? [];
      if (entries.length > 0) scripts.push(buildFontConfigScript(entries));
    }
    if (stripped === ib.fullStyleBlock && scripts.length === 0) continue;
    out = out.split(ib.fullStyleBlock).join(scripts.join('') + stripped);
  }

  return out;
}

// Test-only.
export function __resetFontCacheForTests(): void {
  fontEntriesCache.clear();
}
