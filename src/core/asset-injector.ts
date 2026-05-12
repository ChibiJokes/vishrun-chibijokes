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
 * `fetch_external_response`) is generic and will be reused for Approach B
 * (React + Babel UMDs). See `src/backend.ts` for the worker side.
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

// ─── Tailwind bundle cache ─────────────────────────────────────────────────

const tailwindCache = new Map<string, Promise<string>>();

function getTailwindBundle(url: string, ctx: SpindleFrontendContext): Promise<string> {
  const cached = tailwindCache.get(url);
  if (cached) return cached;
  const pending = fetchViaBackend(url, ctx);
  // Cache the promise BEFORE awaiting so concurrent renders share one fetch.
  tailwindCache.set(url, pending);
  // Detached catch: drop failed entries so a later render can retry, without
  // turning the rejection into an unhandled one (callers still see it via the
  // cached promise) and without changing what `getTailwindBundle` returns.
  pending.catch(() => {
    if (tailwindCache.get(url) === pending) tailwindCache.delete(url);
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
 * If `html` references the Tailwind Play CDN via `<script src>`, fetch the
 * bundle(s) through the backend, strip the `<script src>` tag(s), and prepend
 * the bundle(s) inline as `<script>…</script>` at the very start of `html`
 * (which becomes the start of the effective `<head>` once the sandbox host
 * wraps the document — see widget-iframe.ts:injectShimsAndSizeReporter).
 *
 * Silent fallback: a bundle that fails to fetch is logged via `console.warn`
 * and treated as empty (the others still inject); if *every* bundle fails,
 * `html` is returned unchanged. Idempotent — HTML with no Tailwind `<script
 * src>` (e.g. already transformed) is returned untouched.
 */
export async function transformHtmlForTailwind(
  html: string,
  ctx: SpindleFrontendContext,
): Promise<string> {
  const urls = extractTailwindUrls(html);
  if (urls.length === 0) return html;

  const bundles = await Promise.all(
    urls.map((url) =>
      getTailwindBundle(url, ctx).catch((err: unknown) => {
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
  return inline + stripped;
}
