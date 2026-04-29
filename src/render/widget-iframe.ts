import type { SpindleFrontendContext } from 'lumiverse-spindle-types';

/**
 * Per-iframe nonce → iframe lookup. WeakMap so cleared iframes are
 * GC'd automatically without leaking entries.
 *
 * Used as a defensive double-check in the postMessage bridge: even after
 * matching the iframe by `data-vishrun-iframe-nonce` attribute, we verify
 * the WeakMap entry agrees. Prevents attribute spoofing by other code on
 * the page and lets us distinguish widget iframes from any nested
 * iframes a card might create in the future.
 */
const iframeNonces = new WeakMap<HTMLIFrameElement, string>();

/**
 * Build a sandboxed iframe widget from a fence-stripped, substituted HTML
 * string. The iframe gets `sandbox="allow-scripts"` (no `allow-same-origin`
 * — null-origin iframes can still postMessage to the parent fine; that
 * was Step 0's verdict).
 *
 * Carries `data-vishrun-widget` so:
 *  - processNode's idempotency check can see it (skip text inside).
 *  - ctx.dom.cleanup() removes it on extension teardown via the
 *    `data-spindle-ext` attribute that ctx.dom.createElement adds.
 *
 * Carries `data-vishrun-iframe-nonce` (per-iframe random UUID) so the
 * resize bridge can route messages back to the correct iframe.
 */
export function buildWidgetIframe(
  html: string,
  scriptName: string,
  scriptId: string,
  ctx: SpindleFrontendContext,
): HTMLIFrameElement {
  const nonce = makeNonce();
  const srcdoc = injectSizeReporter(html, nonce);
  const iframe = ctx.dom.createElement('iframe', {
    sandbox: 'allow-scripts',
    srcdoc,
    'data-vishrun-widget': scriptName,
    'data-vishrun-script-id': scriptId,
    'data-vishrun-iframe-nonce': nonce,
  }) as HTMLIFrameElement;
  iframeNonces.set(iframe, nonce);
  // Initial sizing — overwritten by the resize bridge once the iframe
  // reports its content height. 1px keeps the pre-resize flash invisible
  // for small widgets and prevents oversized initial values from making
  // body.scrollHeight overestimate (it returns max(viewport, content)
  // when content fits the viewport).
  iframe.style.width = '100%';
  iframe.style.height = '1px';
  iframe.style.border = 'none';
  iframe.style.display = 'block';
  iframe.style.margin = '8px 0';
  // Override Lumiverse's `.prose iframe { max-height: 400px; max-width: 100% }`
  // (MessageContent.module.css:423-429). Without this, the bridge sets
  // height to the real content height (e.g. 1170px), but the browser
  // clamps it via min(height, max-height) → 400px, with an internal
  // scrollbar. Inline beats class-selector specificity, so no !important
  // needed. Watch-item: if Lumiverse adds !important to that rule in the
  // future, switch to setProperty(..., 'important').
  iframe.style.maxHeight = 'none';
  iframe.style.maxWidth = 'none';
  return iframe;
}

/**
 * Detect a `<script>` tag (open tag, with or without attributes). Used by
 * inject-into-message to decide between the iframe path and the inline
 * `<div>+innerHTML` path. Case-insensitive; tolerates whitespace and
 * attributes; rejects `<scripts>` or `<scripted>` false positives via the
 * `\b` word boundary.
 */
export function containsScriptTag(html: string): boolean {
  return /<script\b[^>]*>/i.test(html);
}

/**
 * Inject the size-reporter shell (normalize style + post-size script)
 * just before `</body>` if present, else append at the end. The reporter
 * embeds a per-iframe nonce so the host can route the resize message to
 * the right iframe.
 *
 * The normalize style zeroes html/body margin and padding so that
 * body.scrollHeight equals the rendered content height exactly. Without
 * it, the user-agent default 8px body margin causes the iframe to clip
 * the bottom 8px of content.
 */
function injectSizeReporter(html: string, nonce: string): string {
  // Inject color-scheme meta into <head> if present. Browsers honor this
  // for the iframe document's canvas color even before our <style> shell
  // is parsed, which sidesteps a brief flash of white during initial load.
  // The CSS :root rule in the shell is the primary mechanism; this is
  // belt-and-suspenders for cards with a proper <head>. Cards without a
  // <head> rely on the CSS rule alone.
  const meta = '<meta name="color-scheme" content="dark light">';
  const closeHead = html.lastIndexOf('</head>');
  const withMeta = closeHead >= 0
    ? html.slice(0, closeHead) + meta + html.slice(closeHead)
    : html;

  const shell = sizeReporterShell(nonce);
  const closeBody = withMeta.lastIndexOf('</body>');
  if (closeBody >= 0) {
    return withMeta.slice(0, closeBody) + shell + withMeta.slice(closeBody);
  }
  return withMeta + shell;
}

function sizeReporterShell(nonce: string): string {
  // JSON.stringify ensures the nonce is properly quoted and escaped if a
  // future fallback ever produces non-ASCII or quote-bearing values.
  const nonceLit = JSON.stringify(nonce);
  return `
<style>
  /* Vishrun: normalize iframe body so the user-agent default 8px margin
     doesn't push content into the iframe edge. The size-reporter uses
     getBoundingClientRect to measure content so it doesn't depend on
     body.scrollHeight excluding margin-collapsed offsets. */
  html, body { margin: 0; padding: 0; }
  body { box-sizing: border-box; }
  /* Vishrun: transparent canvas so the host chat theme shows through for
     widgets that don't paint their own background (e.g. Xiao Gu). Widgets
     that DO want a background paint it on a container element (e.g.
     Vavesta's .vav-home-wrap), not on body — those keep their look
     because the rule below only zeroes html/body. !important defends
     against UA canvas-default and any host-stylesheet leakage into the
     iframe document. */
  html, body { background: transparent !important; }
  /* Vishrun: declare color-scheme so the UA canvas-default (the color the
     browser paints under transparent html/body) matches whichever theme
     the host is in. Sandboxed null-origin iframes (sandbox=allow-scripts
     without allow-same-origin) do NOT inherit color-scheme from the
     parent, so the canvas defaults to light then white even when the host
     is dark. Declaring 'dark light' lets the browser pick whichever the
     iframe element color-scheme prefers, which propagates from the parent
     :root color-scheme during initial paint. Companion to the meta tag
     injected into head below — meta is parsed earlier (pre-CSSOM), this
     CSS rule wins ties and covers cards without a head. */
  :root { color-scheme: dark light; }
</style>
<script>
(function() {
  var NONCE = ${nonceLit};
  function postSize() {
    try {
      if (!document.body) return;
      // Measure the bottom edge of the body's last block-flow child via
      // getBoundingClientRect, then add the iframe's own scrollY to make
      // it document-relative.
      //
      // Why not body.scrollHeight: when the body's first child has a top
      // margin (e.g. Vavesta intro's .vav-intro-wrapper has margin: 18px
      // 0), that margin collapses out of body. body.scrollHeight excludes
      // it, but the iframe still needs to reserve those pixels visually
      // — otherwise the bottom 18-36px of content overflows the iframe
      // and a scrollbar appears. lastChild.getBoundingClientRect().bottom
      // gives the visual bottom edge directly, including the offset from
      // any collapsed-out margins above.
      //
      // Defensive Math.max with scrollHeight: catches absolutely-positioned
      // elements that may extend below the last block-flow child.
      var h;
      var last = document.body.lastElementChild;
      if (last) {
        var rect = last.getBoundingClientRect();
        h = rect.bottom + window.scrollY;
        if (document.body.scrollHeight > h) h = document.body.scrollHeight;
      } else {
        h = document.body.scrollHeight;
      }
      // 12px pragmatic buffer: after three measurement-strategy iterations
      // (scrollHeight, padding-top margin-collapse trick, getBoundingClientRect)
      // a sub-pixel residual still slips past for some widgets. JS-Slash-Runner
      // uses the same trick for the same reason — measuring CSS-occupied
      // space exhaustively isn't tractable. Visually imperceptible, kills
      // the scrollbar.
      h += 12;
      window.parent.postMessage({ __vishrun: 'resize', nonce: NONCE, height: h }, '*');
    } catch (e) {}
  }
  function init() {
    postSize();
    if (typeof ResizeObserver !== 'undefined' && document.body) {
      try {
        var ro = new ResizeObserver(postSize);
        ro.observe(document.body);
      } catch (e) {}
    }
    // load fires after fonts/images have loaded — content height may
    // change between DOMContentLoaded and load. Re-post then.
    window.addEventListener('load', postSize);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
</script>`;
}

function makeNonce(): string {
  // crypto.randomUUID is available in all modern browsers; fall back to a
  // timestamp+random for older targets just in case.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Install a single document-wide listener for `__vishrun: 'resize'`
 * messages. Routes by per-iframe nonce: looks up the iframe by attribute
 * selector, then validates against the WeakMap entry. Returns a teardown.
 *
 * Bounded to [40, 4000] px to defend against widget bugs reporting absurd
 * heights (e.g. content with `height: 100vh` would otherwise expand
 * indefinitely).
 */
export function installIframeBridge(): () => void {
  const handler = (e: MessageEvent) => {
    const data = e.data;
    if (!data || typeof data !== 'object') return;
    const d = data as { __vishrun?: string; nonce?: unknown; height?: unknown };
    if (d.__vishrun !== 'resize') return;
    if (typeof d.nonce !== 'string' || !d.nonce) return;
    const iframe = findIframeByNonce(d.nonce);
    if (!iframe) return;
    const raw = Number(d.height);
    if (!Number.isFinite(raw)) return;
    const h = Math.max(40, Math.min(4000, Math.round(raw)));
    iframe.style.height = `${h}px`;
  };
  window.addEventListener('message', handler);
  return () => window.removeEventListener('message', handler);
}

function findIframeByNonce(nonce: string): HTMLIFrameElement | null {
  const escaped = cssEscape(nonce);
  const iframe = document.querySelector(
    `iframe[data-vishrun-iframe-nonce="${escaped}"]`,
  ) as HTMLIFrameElement | null;
  if (!iframe) return null;
  // Defensive: WeakMap lookup confirms this iframe was created by us
  // and the nonce wasn't spoofed via attribute manipulation.
  if (iframeNonces.get(iframe) !== nonce) return null;
  return iframe;
}

function cssEscape(s: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(s)
    : s.replace(/["\\]/g, '\\$&');
}
