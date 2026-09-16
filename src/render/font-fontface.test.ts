import { test, expect, mock } from 'bun:test';
import {
  processVishrunFonts,
  type FontFetch,
  type FontFaceCtor,
  type FontFaceLike,
  type FontSetLike,
} from './font-fontface';

interface MockFontFace extends FontFaceLike {
  family: string;
  source: string;
  descriptors: Record<string, string>;
}

function makeMocks(): {
  fontFaceCtor: FontFaceCtor;
  fontSet: FontSetLike;
  built: MockFontFace[];
  added: FontFaceLike[];
} {
  const built: MockFontFace[] = [];
  const added: FontFaceLike[] = [];
  const fontFaceCtor = function (
    family: string,
    source: string,
    descriptors: Record<string, string>,
  ): MockFontFace {
    const face: MockFontFace = {
      family,
      source,
      descriptors,
      load: () => Promise.resolve(face),
    };
    built.push(face);
    return face;
  } as unknown as FontFaceCtor;
  const fontSet: FontSetLike = { add: (f) => { added.push(f); } };
  return { fontFaceCtor, fontSet, built, added };
}

function root(html: string): HTMLElement {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div;
}

function configScript(entries: unknown): string {
  return `<script type="application/vishrun-font-config" data-vishrun-fonts>${JSON.stringify(entries)}</script>`;
}

test('processVishrunFonts is a no-op when there are no config scripts', async () => {
  const { fontFaceCtor, fontSet, built, added } = makeMocks();
  const fetchFont: FontFetch = mock(async () => ({ url: 'blob:never' }));
  await processVishrunFonts(root('<div>no fonts</div>'), { fetchFont, fontFaceCtor, fontSet });
  expect((fetchFont as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  expect(built).toHaveLength(0);
  expect(added).toHaveLength(0);
});

test('processVishrunFonts loads a single entry: fetchFont, FontFace ctor, document.fonts.add', async () => {
  const { fontFaceCtor, fontSet, built, added } = makeMocks();
  const entry = {
    family: 'Cinzel',
    weight: '400',
    style: 'normal',
    display: 'swap',
    url: 'https://fonts.gstatic.com/c.woff2',
  };
  const fetchFont: FontFetch = mock(async (u: string) => {
    expect(u).toBe(entry.url);
    return { url: 'blob:cinzel-400' };
  });
  await processVishrunFonts(root(configScript([entry])), { fetchFont, fontFaceCtor, fontSet });
  expect((fetchFont as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  expect(built).toHaveLength(1);
  expect(built[0]!.family).toBe('Cinzel');
  expect(built[0]!.source).toBe('url(blob:cinzel-400)');
  expect(built[0]!.descriptors).toEqual({ weight: '400', style: 'normal', display: 'swap' });
  expect(added).toHaveLength(1);
});

test('processVishrunFonts loads multiple entries from one script', async () => {
  const { fontFaceCtor, fontSet, built, added } = makeMocks();
  const entries = [
    { family: 'A', weight: '400', url: 'https://fonts.gstatic.com/a.woff2' },
    { family: 'B', weight: '700', url: 'https://fonts.gstatic.com/b.woff2' },
    { family: 'C', weight: '400', url: 'https://fonts.gstatic.com/c.woff2' },
  ];
  const seen: string[] = [];
  const fetchFont: FontFetch = async (u) => { seen.push(u); return { url: `blob:${u}` }; };
  await processVishrunFonts(root(configScript(entries)), { fetchFont, fontFaceCtor, fontSet });
  expect(seen.sort()).toEqual(entries.map((e) => e.url).sort());
  expect(built).toHaveLength(3);
  expect(added).toHaveLength(3);
});

test('processVishrunFonts dedupes duplicate URLs within one batch: same url twice = 1 fetchFont', async () => {
  const { fontFaceCtor, fontSet, built } = makeMocks();
  const entries = [
    { family: 'A', weight: '400', url: 'https://fonts.gstatic.com/x.woff2' },
    { family: 'A', weight: '400', url: 'https://fonts.gstatic.com/x.woff2' },
  ];
  const fetchFont = mock(async () => ({ url: 'blob:x' }));
  await processVishrunFonts(root(configScript(entries)), { fetchFont, fontFaceCtor, fontSet });
  expect(fetchFont.mock.calls.length).toBe(1);
  expect(built).toHaveLength(1);
});

test('processVishrunFonts shares cache across calls: same url across 2 invocations = 1 fetchFont', async () => {
  const { fontFaceCtor, fontSet } = makeMocks();
  const cache = new Map<string, boolean>();
  const entry = { family: 'A', weight: '400', url: 'https://fonts.gstatic.com/y.woff2' };
  const fetchFont = mock(async () => ({ url: 'blob:y' }));
  await processVishrunFonts(root(configScript([entry])), { fetchFont, fontFaceCtor, fontSet, cache });
  await processVishrunFonts(root(configScript([entry])), { fetchFont, fontFaceCtor, fontSet, cache });
  expect(fetchFont.mock.calls.length).toBe(1);
});

test('processVishrunFonts warns + releases cache on fetchFont rejection (retry allowed later)', async () => {
  const { fontFaceCtor, fontSet, built, added } = makeMocks();
  const cache = new Map<string, boolean>();
  const warn = mock(() => {});
  const entry = { family: 'Z', weight: '400', url: 'https://fonts.gstatic.com/z.woff2' };
  const fetchFont: FontFetch = async () => { throw new Error('boom'); };
  await processVishrunFonts(root(configScript([entry])), { fetchFont, fontFaceCtor, fontSet, cache, warn });
  expect(warn.mock.calls.length).toBeGreaterThan(0);
  expect(built).toHaveLength(0);
  expect(added).toHaveLength(0);
  expect(cache.get(entry.url)).toBe(false);
});

test('processVishrunFonts skips entries when fetchFont resolves with empty url', async () => {
  const { fontFaceCtor, fontSet, built, added } = makeMocks();
  const cache = new Map<string, boolean>();
  const entry = { family: 'W', weight: '400', url: 'https://fonts.gstatic.com/w.woff2' };
  const fetchFont: FontFetch = async () => ({ url: '' });
  await processVishrunFonts(root(configScript([entry])), { fetchFont, fontFaceCtor, fontSet, cache });
  expect(built).toHaveLength(0);
  expect(added).toHaveLength(0);
  expect(cache.get(entry.url)).toBe(false);
});

test('processVishrunFonts skips malformed entries (no url or no family) without error', async () => {
  const { fontFaceCtor, fontSet, built, added } = makeMocks();
  const entries = [
    { family: '', url: 'https://x.com/a.woff2' },
    { family: 'X', url: '' },
    { family: 'X' },
    { url: 'https://x.com/b.woff2' },
    null,
    'not-an-entry',
    42,
  ];
  const fetchFont = mock(async () => ({ url: 'blob:n' }));
  await processVishrunFonts(root(configScript(entries)), { fetchFont, fontFaceCtor, fontSet });
  expect(fetchFont.mock.calls.length).toBe(0);
  expect(built).toHaveLength(0);
  expect(added).toHaveLength(0);
});

test('processVishrunFonts skips a script whose JSON does not parse', async () => {
  const { fontFaceCtor, fontSet, built } = makeMocks();
  const bad = '<script type="application/vishrun-font-config" data-vishrun-fonts>{not-json</script>';
  const fetchFont = mock(async () => ({ url: 'blob:nope' }));
  await processVishrunFonts(root(bad), { fetchFont, fontFaceCtor, fontSet });
  expect(fetchFont.mock.calls.length).toBe(0);
  expect(built).toHaveLength(0);
});

test('processVishrunFonts applies default descriptors when entry omits weight/style/display', async () => {
  const { fontFaceCtor, fontSet, built } = makeMocks();
  const entry = { family: 'D', url: 'https://fonts.gstatic.com/d.woff2' };
  const fetchFont: FontFetch = async () => ({ url: 'blob:d' });
  await processVishrunFonts(root(configScript([entry])), { fetchFont, fontFaceCtor, fontSet });
  expect(built[0]!.descriptors).toEqual({ weight: '400', style: 'normal', display: 'swap' });
});
