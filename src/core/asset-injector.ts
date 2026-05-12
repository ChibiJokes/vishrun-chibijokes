import type { SpindleFrontendContext } from 'lumiverse-spindle-types';

/**
 * Host-side asset injection for widget sandboxes.
 *
 * Cards sometimes ship `<script src="https://cdn.tailwindcss.com">` in their
 * `replaceString`. That external script can't load inside the sandbox iframe —
 * the host's CSP is `script-src 'unsafe-inline'`, which permits inline scripts
 * but not remote ones — so the widget renders unstyled. The fix: intercept the
 * `<script src>`, download the Play CDN bundle, and inline it into the srcdoc
 * `<head>` (where `'unsafe-inline'` applies, and where Tailwind JIT — which
 * doesn't use eval — runs fine without `'unsafe-eval'`), *before* the iframe's
 * first parse so there's no flash of unstyled content.
 *
 * `SpindleFrontendContext` (the context the frontend module gets) has no CORS
 * proxy, so the download is routed through the backend worker module, which
 * does have `spindle.cors`. The protocol (`fetch_external` → backend →
 * `fetch_external_response`) is generic and is also used by Approach B
 * (React + Babel UMDs — see `transformHtmlForReactBabel`). See `src/backend.ts`
 * for the worker side.
 *
 * Bundles are cached in memory keyed by URL. A failed fetch is dropped from the
 * cache so a later render can retry; a card that referenced an unreachable URL
 * just renders without Tailwind (silent fallback, `console.warn` only).
 */

// ─── Backend round-trip fetch ──────────────────────────────────────────────

interface FetchExternalResponse {
  type: 'fetch_external_response';
  requestId: string;
  ok: boolean;
  body?: string;
  error?: string;
}

function isFetchExternalResponse(p: unknown, requestId: string): p is FetchExternalResponse {
  return (
    !!p &&
    typeof p === 'object' &&
    (p as { type?: unknown }).type === 'fetch_external_response' &&
    (p as { requestId?: unknown }).requestId === requestId
  );
}

let requestCounter = 0;
function nextRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `vishrun-fx-${Date.now()}-${++requestCounter}`;
}

/**
 * Download `url` through the backend's `fetch_external` handler (which proxies
 * via `spindle.cors(url, { responseType: 'text' })`). Resolves with the
 * response body as a string; rejects on a backend error or after `timeoutMs`.
 * Unsubscribes its `onBackendMessage` handler on every settle path so nothing
 * leaks.
 */
function fetchViaBackend(
  url: string,
  ctx: SpindleFrontendContext,
  timeoutMs = 30000,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const requestId = nextRequestId();
    let settled = false;
    let unsub: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (run: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (unsub) {
        try {
          unsub();
        } catch {
          /* ignore */
        }
        unsub = null;
      }
      run();
    };

    unsub = ctx.onBackendMessage((payload) => {
      if (!isFetchExternalResponse(payload, requestId)) return;
      if (payload.ok && typeof payload.body === 'string') {
        const body = payload.body;
        finish(() => resolve(body));
      } else {
        finish(() => reject(new Error(payload.error || 'fetch_external failed')));
      }
    });

    timer = setTimeout(() => {
      finish(() => reject(new Error('Backend fetch timeout')));
    }, timeoutMs);

    try {
      ctx.sendToBackend({ type: 'fetch_external', requestId, url });
    } catch (err) {
      finish(() => reject(err instanceof Error ? err : new Error(String(err))));
    }
  });
}

// ─── External bundle cache ─────────────────────────────────────────────────

const bundleCache = new Map<string, Promise<string>>();

// Backend fetch memoized by URL; shared by the Tailwind and React/Babel
// transforms. Promise cached before it settles so concurrent renders join one
// fetch; failed entries are dropped so a later render can retry.
function getCachedBundle(url: string, ctx: SpindleFrontendContext): Promise<string> {
  const cached = bundleCache.get(url);
  if (cached) return cached;
  const pending = fetchViaBackend(url, ctx);
  bundleCache.set(url, pending);
  // Detached catch: drop the failed entry without making the rejection unhandled
  // (callers still see it via the returned promise).
  pending.catch(() => {
    if (bundleCache.get(url) === pending) bundleCache.delete(url);
  });
  return pending;
}

// ─── HTML transform ────────────────────────────────────────────────────────

/**
 * Matches `<script src="https://cdn.tailwindcss.com[...]">…</script>`. Only the
 * exact host `cdn.tailwindcss.com` — the lookahead after `.com` requires a
 * path/query/fragment delimiter, the closing quote, or whitespace, so a
 * decoy host like `cdn.tailwindcss.com.example.com` does not match. Tolerates a
 * version segment in the path, `async`/`defer`, and variable whitespace.
 * `g` for repeated `.exec`/`.replace`; `i` for tag-name casing.
 */
const TAILWIND_SCRIPT_RE =
  /<script\b[^>]*\bsrc\s*=\s*["'](https?:\/\/cdn\.tailwindcss\.com(?=[/?#"']|\s)[^"']*)["'][^>]*>\s*<\/script>/gi;

/**
 * Every distinct Tailwind Play CDN URL referenced by a `<script src>` in
 * `html`. Empty when there are none (cheap `indexOf` short-circuit first).
 */
export function extractTailwindUrls(html: string): string[] {
  if (html.indexOf('cdn.tailwindcss.com') === -1) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  TAILWIND_SCRIPT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAILWIND_SCRIPT_RE.exec(html)) !== null) {
    const url = m[1];
    if (!seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}

/**
 * Card's declared `color-scheme` (from a `<meta name="color-scheme">` tag or a
 * `:root{color-scheme:...}` rule), trimmed; `null` if the card declares none.
 */
export function detectCardColorScheme(html: string): string | null {
  const meta = html.match(/<meta\s+name=["']color-scheme["']\s+content=["']([^"']+)["']/i);
  if (meta) return meta[1].trim();

  const css = html.match(/:root\s*\{[^}]*color-scheme\s*:\s*([^;}]+)/i);
  if (css) return css[1].trim();

  return null;
}

/**
 * Inline Tailwind CDN bundles fetched via the backend, removing the original
 * `<script src>`. For cards that don't declare color-scheme, also injects a
 * `color:#000 !important` root rule so default text stays readable when the
 * host forces `dark light` on a dark-mode OS — does NOT touch `color-scheme`,
 * which would mismatch the parent and trigger an opaque iframe bg fallback.
 * Silent fallback: a failed bundle is logged and skipped; if all fail, `html`
 * is returned unchanged. Idempotent — HTML with no Tailwind `<script src>`
 * (e.g. already transformed) is returned untouched.
 */
export async function transformHtmlForTailwind(
  html: string,
  ctx: SpindleFrontendContext,
): Promise<string> {
  const urls = extractTailwindUrls(html);
  if (urls.length === 0) return html;

  const bundles = await Promise.all(
    urls.map((url) =>
      getCachedBundle(url, ctx).catch((err: unknown) => {
        console.warn(
          '[vishrun] Tailwind fetch failed:',
          url,
          err instanceof Error ? err.message : String(err),
        );
        return '';
      }),
    ),
  );

  if (bundles.every((b) => b === '')) return html;

  const stripped = html.replace(TAILWIND_SCRIPT_RE, '');
  const inline = bundles
    .filter((b) => b !== '')
    .map((b) => `<script>${b}</script>`)
    .join('');
  // Force text color (not color-scheme: that mismatches the parent and makes
  // the browser auto-fill an opaque iframe bg, hiding Lumiverse's wallpaper) so
  // legacy JSR-style cards stay readable on dark-mode OS. Only when the card
  // declares no color-scheme; explicit declarations are left to cascade.
  const textColorOverride = detectCardColorScheme(html) === null
    ? '<style>:root{color:#000 !important}</style>'
    : '';
  return textColorOverride + inline + stripped;
}

// ─── React + Babel transform (Approach B) ──────────────────────────────────

// `<script [type=...] src="https://unpkg.com/...">…</script>`. Same defensive
// lookahead as TAILWIND_SCRIPT_RE so a decoy host (`unpkg.com.evil.com`) misses.
// Slot assignment (if any) is `classifyUnpkgUrl`'s job.
const UNPKG_SCRIPT_RE =
  /<script\b[^>]*\bsrc\s*=\s*["'](https?:\/\/unpkg\.com(?=[/?#"']|\s)[^"']*)["'][^>]*>\s*<\/script>/gi;

type ReactBabelSlot = 'react' | 'reactDom' | 'babel';

// Which slot a unpkg.com URL fills, by path: `/react[@v]/…`, `/react-dom[@v]/…`,
// `/@babel/standalone[@v]/…` or `/babel-standalone[@v]/…`. `null` otherwise.
function classifyUnpkgUrl(url: string): ReactBabelSlot | null {
  const m = url.match(/^https?:\/\/unpkg\.com(\/[^"'?#]*)/i);
  if (!m) return null;
  const path = m[1];
  if (/^\/(?:@babel\/standalone|babel-standalone)(?:@[^/]*)?(?:\/|$)/i.test(path)) return 'babel';
  if (/^\/react-dom(?:@[^/]*)?(?:\/|$)/i.test(path)) return 'reactDom';
  if (/^\/react(?:@[^/]*)?(?:\/|$)/i.test(path)) return 'react';
  return null;
}

const REACT_BABEL_ORDER: readonly ReactBabelSlot[] = ['react', 'reactDom', 'babel'];

// First unpkg.com `<script src>` for each slot; absent slots omitted, `{}` when
// the card uses none (cheap `indexOf` short-circuit first).
export function extractReactBabelUrls(html: string): { react?: string; reactDom?: string; babel?: string } {
  if (html.indexOf('unpkg.com') === -1) return {};
  const out: { react?: string; reactDom?: string; babel?: string } = {};
  UNPKG_SCRIPT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = UNPKG_SCRIPT_RE.exec(html)) !== null) {
    const url = m[1];
    const slot = classifyUnpkgUrl(url);
    if (slot && out[slot] === undefined) out[slot] = url;
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Remove every `<script ... src="<url>">…</script>` for an exact `url`.
function stripScriptTagBySrc(html: string, url: string): string {
  return html.replace(
    new RegExp(`<script\\b[^>]*\\bsrc\\s*=\\s*["']${escapeRegExp(url)}["'][^>]*>\\s*</script>`, 'gi'),
    '',
  );
}

// Inline React/ReactDOM/Babel UMD bundles fetched via the backend, dropping the
// original `<script src>` for each one that downloaded. Order react → reactDom →
// babel: ReactDOM needs React; Babel's `text/babel` scanner runs on load and the
// JSX scripts it consumes are further down in the card HTML. Silent fallback per
// bundle; idempotent (no matching `<script src>` ⇒ `html` returned untouched).
export async function transformHtmlForReactBabel(
  html: string,
  ctx: SpindleFrontendContext,
): Promise<string> {
  const urls = extractReactBabelUrls(html);
  const slots = REACT_BABEL_ORDER.filter((slot) => urls[slot] !== undefined);
  if (slots.length === 0) return html;

  // Parallel fetch, kept in REACT_BABEL_ORDER; per-URL silent fallback to ''.
  const fetched = await Promise.all(
    slots.map(async (slot) => {
      const url = urls[slot]!;
      try {
        return { url, body: await getCachedBundle(url, ctx) };
      } catch (err: unknown) {
        console.warn(
          '[vishrun] React/Babel fetch failed:',
          url,
          err instanceof Error ? err.message : String(err),
        );
        return { url, body: '' };
      }
    }),
  );

  const ok = fetched.filter((f) => f.body !== '');
  if (ok.length === 0) return html;

  let stripped = html;
  for (const f of ok) stripped = stripScriptTagBySrc(stripped, f.url);
  const inline = ok.map((f) => `<script>${f.body}</script>`).join('');
  return inline + stripped;
}

// Run every host-side external-`<script>` transform in order: Tailwind, then
// React/Babel. Each is a silent-fallback no-op when its tags aren't present.
export async function transformHtmlForExternalScripts(
  html: string,
  ctx: SpindleFrontendContext,
): Promise<string> {
  const withTailwind = await transformHtmlForTailwind(html, ctx);
  return transformHtmlForReactBabel(withTailwind, ctx);
}
