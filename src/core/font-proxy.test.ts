import { test, expect, mock, beforeEach } from 'bun:test';
import type { SpindleFrontendContext } from 'lumiverse-spindle-types';
import {
  parseFontFaceRules,
  extractGoogleFontsLinks,
  extractGoogleFontsImports,
  transformHtmlForGoogleFonts,
  __resetFontCacheForTests,
} from './font-proxy';

interface FakeBackend {
  ctx: SpindleFrontendContext;
  responses: Map<string, string>;
  errors: Map<string, string>;
  fetchCount: Map<string, number>;
}

function makeFakeBackend(): FakeBackend {
  const responses = new Map<string, string>();
  const errors = new Map<string, string>();
  const fetchCount = new Map<string, number>();
  const listeners = new Set<(p: unknown) => void>();

  const ctx = {
    getActiveChat: () => ({ chatId: 'chatX', characterId: null }),
    sendToBackend: (payload: unknown) => {
      const p = payload as { type?: string; requestId?: string; url?: string };
      if (p.type !== 'fetch_external' || !p.requestId || !p.url) return;
      const url = p.url;
      const requestId = p.requestId;
      fetchCount.set(url, (fetchCount.get(url) ?? 0) + 1);
      queueMicrotask(() => {
        if (errors.has(url)) {
          for (const l of listeners) {
            l({ type: 'fetch_external_response', requestId, ok: false, error: errors.get(url) });
          }
          return;
        }
        for (const l of listeners) {
          l({ type: 'fetch_external_response', requestId, ok: true, body: responses.get(url) ?? '' });
        }
      });
    },
    onBackendMessage: (cb: (p: unknown) => void) => {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
  } as unknown as SpindleFrontendContext;

  return { ctx, responses, errors, fetchCount };
}

const CINZEL_CSS = `
/* latin */
@font-face {
  font-family: 'Cinzel';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/cinzel/v23/cinzel-400.woff2) format('woff2');
  unicode-range: U+0000-00FF;
}
@font-face {
  font-family: 'Cinzel';
  font-style: normal;
  font-weight: 600;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/cinzel/v23/cinzel-600.woff2) format('woff2');
}
@font-face {
  font-family: 'Cinzel Decorative';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/cinzeldec/v15/cd-400.woff2) format('woff2');
}
@font-face {
  font-family: 'Cinzel Decorative';
  font-style: normal;
  font-weight: 700;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/cinzeldec/v15/cd-700.woff2) format('woff2');
}
@font-face {
  font-family: 'Share Tech Mono';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/sharetechmono/v15/stm.woff2) format('woff2');
}
`;

beforeEach(() => {
  __resetFontCacheForTests();
});

// parseFontFaceRules ─────────────────────────────────────────────────────────

test('parseFontFaceRules returns [] for CSS without @font-face', () => {
  expect(parseFontFaceRules('body{color:red}')).toEqual([]);
});

test('parseFontFaceRules extracts a single @font-face with all descriptors', () => {
  const out = parseFontFaceRules(CINZEL_CSS);
  expect(out.length).toBe(5);
  expect(out[0]).toEqual({
    family: 'Cinzel',
    weight: '400',
    style: 'normal',
    display: 'swap',
    url: 'https://fonts.gstatic.com/s/cinzel/v23/cinzel-400.woff2',
  });
});

test('parseFontFaceRules preserves order and captures all 5 entries from the Jujutsu fixture', () => {
  const out = parseFontFaceRules(CINZEL_CSS);
  expect(out.map((e) => `${e.family} ${e.weight}`)).toEqual([
    'Cinzel 400',
    'Cinzel 600',
    'Cinzel Decorative 400',
    'Cinzel Decorative 700',
    'Share Tech Mono 400',
  ]);
});

test('parseFontFaceRules skips @font-face blocks without a valid http url', () => {
  const css = `
    @font-face { font-family: Local; src: local('SomeFont'); }
    @font-face { font-family: Real; src: url(https://x.com/f.woff2) format('woff2'); }
  `;
  const out = parseFontFaceRules(css);
  expect(out).toHaveLength(1);
  expect(out[0]!.family).toBe('Real');
});

test('parseFontFaceRules defaults to undefined for missing descriptors', () => {
  const css = `@font-face { font-family: X; src: url(https://x.com/f.woff2); }`;
  const [entry] = parseFontFaceRules(css);
  expect(entry).toBeDefined();
  expect(entry!.family).toBe('X');
  expect(entry!.weight).toBeUndefined();
  expect(entry!.style).toBeUndefined();
  expect(entry!.display).toBeUndefined();
});

// extractGoogleFontsLinks ────────────────────────────────────────────────────

test('extractGoogleFontsLinks returns [] when no googleapis link present', () => {
  expect(extractGoogleFontsLinks('<div>hi</div>')).toEqual([]);
});

test('extractGoogleFontsLinks picks up a single googleapis link', () => {
  const html = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">';
  const out = extractGoogleFontsLinks(html);
  expect(out).toHaveLength(1);
  expect(out[0]!.url).toBe('https://fonts.googleapis.com/css2?family=Inter');
});

test('extractGoogleFontsLinks decodes &amp; in href', () => {
  const html = '<link href="https://fonts.googleapis.com/css2?family=Cinzel&amp;family=Cinzel+Decorative">';
  const out = extractGoogleFontsLinks(html);
  expect(out[0]!.url).toBe('https://fonts.googleapis.com/css2?family=Cinzel&family=Cinzel+Decorative');
});

// transformHtmlForGoogleFonts ────────────────────────────────────────────────

test('transformHtmlForGoogleFonts is a no-op when there are no googleapis links', async () => {
  const { ctx, fetchCount } = makeFakeBackend();
  const html = '<div>no fonts</div>';
  expect(await transformHtmlForGoogleFonts(html, ctx)).toBe(html);
  expect(fetchCount.size).toBe(0);
});

test('transformHtmlForGoogleFonts replaces a single-family link with a script[data-vishrun-fonts] containing one entry', async () => {
  const { ctx, responses } = makeFakeBackend();
  const url = 'https://fonts.googleapis.com/css2?family=Share+Tech+Mono';
  responses.set(url, `@font-face{font-family:'Share Tech Mono';font-style:normal;font-weight:400;font-display:swap;src:url(https://fonts.gstatic.com/s/sharetechmono/v15/stm.woff2) format('woff2');}`);
  const html = `<head><link rel="stylesheet" href="${url}"></head>`;
  const out = await transformHtmlForGoogleFonts(html, ctx);
  expect(out).not.toContain('<link');
  expect(out).toContain('script type="application/vishrun-font-config"');
  expect(out).toContain('data-vishrun-fonts');
  const match = out.match(/data-vishrun-fonts[^>]*>(.*?)<\/script>/);
  expect(match).not.toBeNull();
  const entries = JSON.parse(match![1]);
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    family: 'Share Tech Mono',
    weight: '400',
    style: 'normal',
    display: 'swap',
    url: 'https://fonts.gstatic.com/s/sharetechmono/v15/stm.woff2',
  });
});

test('transformHtmlForGoogleFonts handles multi-family link (Cinzel + Cinzel Decorative + Share Tech Mono, 5 weights total)', async () => {
  const { ctx, responses } = makeFakeBackend();
  const url = 'https://fonts.googleapis.com/css2?family=Cinzel&family=Cinzel+Decorative&family=Share+Tech+Mono';
  responses.set(url, CINZEL_CSS);
  const html = `<link href="${url.replace(/&/g, '&amp;')}">`;
  const out = await transformHtmlForGoogleFonts(html, ctx);
  const match = out.match(/data-vishrun-fonts[^>]*>(.*?)<\/script>/);
  expect(match).not.toBeNull();
  const entries = JSON.parse(match![1]);
  expect(entries).toHaveLength(5);
  expect(entries.map((e: { family: string; weight: string }) => `${e.family} ${e.weight}`)).toEqual([
    'Cinzel 400',
    'Cinzel 600',
    'Cinzel Decorative 400',
    'Cinzel Decorative 700',
    'Share Tech Mono 400',
  ]);
});

test('transformHtmlForGoogleFonts emits separate scripts per distinct googleapis link', async () => {
  const { ctx, responses } = makeFakeBackend();
  const u1 = 'https://fonts.googleapis.com/css2?family=Inter';
  const u2 = 'https://fonts.googleapis.com/css2?family=Roboto';
  responses.set(u1, `@font-face{font-family:Inter;font-weight:400;src:url(https://fonts.gstatic.com/i.woff2) format('woff2');}`);
  responses.set(u2, `@font-face{font-family:Roboto;font-weight:400;src:url(https://fonts.gstatic.com/r.woff2) format('woff2');}`);
  const html = `<link href="${u1}"><link href="${u2}">`;
  const out = await transformHtmlForGoogleFonts(html, ctx);
  const scripts = out.match(/data-vishrun-fonts/g) ?? [];
  expect(scripts.length).toBe(2);
  expect(out).toContain('Inter');
  expect(out).toContain('Roboto');
});

test('transformHtmlForGoogleFonts caches the parsed entries: same URL twice = 1 backend fetch', async () => {
  const { ctx, responses, fetchCount } = makeFakeBackend();
  const url = 'https://fonts.googleapis.com/css2?family=Inter';
  responses.set(url, `@font-face{font-family:Inter;font-weight:400;src:url(https://fonts.gstatic.com/i.woff2);}`);
  const html = `<link href="${url}">`;
  await transformHtmlForGoogleFonts(html, ctx);
  await transformHtmlForGoogleFonts(html, ctx);
  expect(fetchCount.get(url)).toBe(1);
});

test('transformHtmlForGoogleFonts preserves <link> on backend failure and warns', async () => {
  const restoreWarn = console.warn;
  console.warn = mock(() => {});
  try {
    const { ctx, errors } = makeFakeBackend();
    const url = 'https://fonts.googleapis.com/css2?family=Inter';
    errors.set(url, 'network down');
    const tag = `<link href="${url}">`;
    const out = await transformHtmlForGoogleFonts(tag, ctx);
    expect(out).toBe(tag);
    expect(out).not.toContain('data-vishrun-fonts');
    expect((console.warn as ReturnType<typeof mock>).mock.calls.length).toBeGreaterThan(0);
  } finally {
    console.warn = restoreWarn;
  }
});

test('transformHtmlForGoogleFonts drops failed cache entry so a later render can retry', async () => {
  const restoreWarn = console.warn;
  console.warn = mock(() => {});
  try {
    const { ctx, responses, errors, fetchCount } = makeFakeBackend();
    const url = 'https://fonts.googleapis.com/css2?family=Inter';
    errors.set(url, 'boom');
    await transformHtmlForGoogleFonts(`<link href="${url}">`, ctx);
    expect(fetchCount.get(url)).toBe(1);
    errors.delete(url);
    responses.set(url, `@font-face{font-family:Inter;src:url(https://fonts.gstatic.com/i.woff2);}`);
    const out = await transformHtmlForGoogleFonts(`<link href="${url}">`, ctx);
    expect(fetchCount.get(url)).toBe(2);
    expect(out).toContain('data-vishrun-fonts');
  } finally {
    console.warn = restoreWarn;
  }
});

// E2E browser-like ───────────────────────────────────────────────────────────

test('emitted HTML does NOT contain @font-face rules or external gstatic URLs inside <style>', async () => {
  const { ctx, responses } = makeFakeBackend();
  const url = 'https://fonts.googleapis.com/css2?family=Cinzel';
  responses.set(url, `@font-face{font-family:Cinzel;font-weight:400;src:url(https://fonts.gstatic.com/c.woff2) format('woff2');}`);
  const out = await transformHtmlForGoogleFonts(`<link href="${url}">`, ctx);
  expect(out).not.toMatch(/@font-face/);
  expect(out).not.toMatch(/<style[^>]*>[^<]*gstatic/);
  expect(out).toContain('script type="application/vishrun-font-config"');
  expect(out).toContain('data-vishrun-fonts');
});

test('emitted JSON payload escapes </ to prevent breaking out of the script tag', async () => {
  const { ctx, responses } = makeFakeBackend();
  const url = 'https://fonts.googleapis.com/css2?family=X';
  // Force a payload containing </script (a malicious or odd family name).
  responses.set(url, `@font-face{font-family:'</script>evil';font-weight:400;src:url(https://x.com/f.woff2);}`);
  const out = await transformHtmlForGoogleFonts(`<link href="${url}">`, ctx);
  // The literal "</script>" must not appear unescaped inside the payload.
  // Count: exactly one </script> (the closing tag of the wrapper script).
  const matches = out.match(/<\/script>/g) ?? [];
  expect(matches.length).toBe(1);
  expect(out).toContain('\\u003c');
});

// extractGoogleFontsImports ──────────────────────────────────────────────────

test('extractGoogleFontsImports returns [] when no @import is present', () => {
  expect(extractGoogleFontsImports('<style>body{color:red}</style>')).toEqual([]);
});

test('extractGoogleFontsImports returns [] when @import points to a non-googleapis host', () => {
  const html = `<style>@import url("https://fontsapi.zeoseven.com/954/main/result.css");</style>`;
  expect(extractGoogleFontsImports(html)).toEqual([]);
});

test('extractGoogleFontsImports detects single-quote @import googleapis', () => {
  const html = `<style>@import url('https://fonts.googleapis.com/css2?family=Cinzel');</style>`;
  const out = extractGoogleFontsImports(html);
  expect(out).toHaveLength(1);
  expect(out[0]!.imports).toHaveLength(1);
  expect(out[0]!.imports[0]!.url).toBe('https://fonts.googleapis.com/css2?family=Cinzel');
});

test('extractGoogleFontsImports detects double-quote @import googleapis', () => {
  const html = `<style>@import url("https://fonts.googleapis.com/css2?family=Inter");</style>`;
  const out = extractGoogleFontsImports(html);
  expect(out[0]!.imports[0]!.url).toBe('https://fonts.googleapis.com/css2?family=Inter');
});

test('extractGoogleFontsImports detects no-quote @import googleapis', () => {
  const html = `<style>@import url(https://fonts.googleapis.com/css2?family=Roboto);</style>`;
  const out = extractGoogleFontsImports(html);
  expect(out[0]!.imports[0]!.url).toBe('https://fonts.googleapis.com/css2?family=Roboto');
});

test('extractGoogleFontsImports captures multiple @imports in one <style>', () => {
  const html = `<style>
    @import url('https://fonts.googleapis.com/css2?family=Cinzel');
    @import url("https://fonts.googleapis.com/css2?family=Lato");
    body{color:red}
  </style>`;
  const out = extractGoogleFontsImports(html);
  expect(out).toHaveLength(1);
  expect(out[0]!.imports.map((i) => i.url)).toEqual([
    'https://fonts.googleapis.com/css2?family=Cinzel',
    'https://fonts.googleapis.com/css2?family=Lato',
  ]);
});

test('extractGoogleFontsImports captures @imports across multiple <style> blocks', () => {
  const html = `
    <style>@import url('https://fonts.googleapis.com/css2?family=A');</style>
    <style>@import url('https://fonts.googleapis.com/css2?family=B');h1{color:#fff}</style>
  `;
  const out = extractGoogleFontsImports(html);
  expect(out).toHaveLength(2);
  expect(out[0]!.imports[0]!.url).toBe('https://fonts.googleapis.com/css2?family=A');
  expect(out[1]!.imports[0]!.url).toBe('https://fonts.googleapis.com/css2?family=B');
});

// transformHtmlForGoogleFonts (@import path) ─────────────────────────────────

test('transformHtmlForGoogleFonts strips the @import and emits a script when <style> contains only @import', async () => {
  const { ctx, responses } = makeFakeBackend();
  const url = 'https://fonts.googleapis.com/css2?family=Cinzel';
  responses.set(url, `@font-face{font-family:Cinzel;font-weight:400;src:url(https://fonts.gstatic.com/c.woff2) format('woff2');}`);
  const html = `<head><style>@import url('${url}');</style></head>`;
  const out = await transformHtmlForGoogleFonts(html, ctx);
  expect(out).not.toContain('@import');
  expect(out).toContain('data-vishrun-fonts');
  expect(out).toContain('Cinzel');
  expect(out).toContain('<style></style>');
});

test('transformHtmlForGoogleFonts removes @import while preserving other CSS rules in the same <style>', async () => {
  const { ctx, responses } = makeFakeBackend();
  const url = 'https://fonts.googleapis.com/css2?family=Lato';
  responses.set(url, `@font-face{font-family:Lato;font-weight:400;src:url(https://fonts.gstatic.com/l.woff2) format('woff2');}`);
  const html = `<style>
    @import url('${url}');
    body { color: red; }
    h1 { font-family: Lato; }
  </style>`;
  const out = await transformHtmlForGoogleFonts(html, ctx);
  expect(out).not.toContain('@import');
  expect(out).toContain('body { color: red; }');
  expect(out).toContain('h1 { font-family: Lato; }');
  expect(out).toContain('data-vishrun-fonts');
});

test('transformHtmlForGoogleFonts processes multiple <style> blocks each with an @import', async () => {
  const { ctx, responses } = makeFakeBackend();
  const u1 = 'https://fonts.googleapis.com/css2?family=A';
  const u2 = 'https://fonts.googleapis.com/css2?family=B';
  responses.set(u1, `@font-face{font-family:A;font-weight:400;src:url(https://fonts.gstatic.com/a.woff2);}`);
  responses.set(u2, `@font-face{font-family:B;font-weight:400;src:url(https://fonts.gstatic.com/b.woff2);}`);
  const html = `
    <style>@import url('${u1}');</style>
    <style>@import url("${u2}");p{color:#fff}</style>
  `;
  const out = await transformHtmlForGoogleFonts(html, ctx);
  expect(out).not.toContain('@import');
  expect(out).toContain('"family":"A"');
  expect(out).toContain('"family":"B"');
  const scripts = out.match(/data-vishrun-fonts/g) ?? [];
  expect(scripts.length).toBe(2);
});

test('transformHtmlForGoogleFonts processes multiple @imports within a single <style>', async () => {
  const { ctx, responses } = makeFakeBackend();
  const u1 = 'https://fonts.googleapis.com/css2?family=Cinzel';
  const u2 = 'https://fonts.googleapis.com/css2?family=Lato';
  responses.set(u1, `@font-face{font-family:Cinzel;font-weight:400;src:url(https://fonts.gstatic.com/c.woff2);}`);
  responses.set(u2, `@font-face{font-family:Lato;font-weight:400;src:url(https://fonts.gstatic.com/l.woff2);}`);
  const html = `<style>
    @import url('${u1}');
    @import url("${u2}");
    body{color:red}
  </style>`;
  const out = await transformHtmlForGoogleFonts(html, ctx);
  expect(out).not.toContain('@import');
  expect(out).toContain('body{color:red}');
  expect(out).toContain('"family":"Cinzel"');
  expect(out).toContain('"family":"Lato"');
  const scripts = out.match(/data-vishrun-fonts/g) ?? [];
  expect(scripts.length).toBe(2);
});

test('transformHtmlForGoogleFonts shares cache between <link> and @import for the same URL: 1 backend fetch', async () => {
  const { ctx, responses, fetchCount } = makeFakeBackend();
  const url = 'https://fonts.googleapis.com/css2?family=Inter';
  responses.set(url, `@font-face{font-family:Inter;font-weight:400;src:url(https://fonts.gstatic.com/i.woff2);}`);
  const html = `
    <link href="${url}">
    <style>@import url('${url}');</style>
  `;
  const out = await transformHtmlForGoogleFonts(html, ctx);
  expect(fetchCount.get(url)).toBe(1);
  expect(out).not.toContain('<link');
  expect(out).not.toContain('@import');
  const scripts = out.match(/data-vishrun-fonts/g) ?? [];
  expect(scripts.length).toBe(2);
});

test('transformHtmlForGoogleFonts leaves non-googleapis @imports untouched', async () => {
  const { ctx } = makeFakeBackend();
  const html = `<style>@import url("https://fontsapi.zeoseven.com/954/main/result.css");body{color:red}</style>`;
  const out = await transformHtmlForGoogleFonts(html, ctx);
  expect(out).toBe(html);
});

test('emitted HTML for @import path contains no @import googleapis nor @font-face external URL', async () => {
  const { ctx, responses } = makeFakeBackend();
  const url = 'https://fonts.googleapis.com/css2?family=Cinzel';
  responses.set(url, `@font-face{font-family:Cinzel;font-weight:400;src:url(https://fonts.gstatic.com/c.woff2) format('woff2');}`);
  const out = await transformHtmlForGoogleFonts(`<style>@import url('${url}');</style>`, ctx);
  // The cssproxy scans for `url(...)` inside CSS. After transform, there must
  // be no CSS-level reference to googleapis / gstatic — they live only inside
  // the inert <script type="application/vishrun-font-config"> JSON payload.
  expect(out).not.toMatch(/@import\s+url\([^)]*googleapis/);
  expect(out).not.toMatch(/@font-face/);
  expect(out).not.toMatch(/<style[^>]*>[\s\S]*gstatic[\s\S]*<\/style>/);
  expect(out).not.toMatch(/<link[^>]*googleapis/);
  expect(out).toContain('data-vishrun-fonts');
});

test('transformHtmlForGoogleFonts preserves the @import literal on backend failure (style block kept intact)', async () => {
  const restoreWarn = console.warn;
  console.warn = mock(() => {});
  try {
    const { ctx, errors } = makeFakeBackend();
    const url = 'https://fonts.googleapis.com/css2?family=Inter';
    errors.set(url, 'network down');
    const html = `<style>@import url('${url}');body{color:red}</style>`;
    const out = await transformHtmlForGoogleFonts(html, ctx);
    expect(out).toContain(`@import url('${url}');`);
    expect(out).toContain('body{color:red}');
    expect(out).not.toContain('data-vishrun-fonts');
  } finally {
    console.warn = restoreWarn;
  }
});

test('transformHtmlForGoogleFonts handles Vavesta-style multi-family @import (Cinzel + Cinzel Decorative + Crimson Text)', async () => {
  const { ctx, responses } = makeFakeBackend();
  const url = 'https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;700;900&family=Cinzel+Decorative:wght@400;700;900&family=Crimson+Text:ital,wght@0,400;0,600;0,700;1,400;1,600;1,700&display=swap';
  responses.set(url, CINZEL_CSS);
  const html = `<style>@import url('${url}');\nbody{font-family:'Crimson Text',serif}\n</style>`;
  const out = await transformHtmlForGoogleFonts(html, ctx);
  const match = out.match(/data-vishrun-fonts[^>]*>(.*?)<\/script>/);
  expect(match).not.toBeNull();
  const entries = JSON.parse(match![1]);
  expect(entries).toHaveLength(5);
  expect(out).toContain(`body{font-family:'Crimson Text',serif}`);
  expect(out).not.toContain('@import');
});
