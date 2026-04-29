import type { SpindleFrontendContext } from 'lumiverse-spindle-types';
import { getActiveCard } from '../state/active-card';

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
  const srcdoc = injectShimsAndSizeReporter(html, nonce);
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
  // 12px vertical margin gives the widget breathing room above/below within
  // the message bubble. Step 6 bumped from 8px after the size-reporter buffer
  // increase still felt visually tight on dense widgets (Vavesta Court Ledger,
  // Xiao Gu).
  iframe.style.margin = '12px 0';
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
 * Detect a `<script>` tag (open tag, with or without attributes).
 * Case-insensitive; tolerates whitespace and attributes; rejects
 * `<scripts>` or `<scripted>` false positives via the `\b` word boundary.
 */
export function containsScriptTag(html: string): boolean {
  return /<script\b[^>]*>/i.test(html);
}

/**
 * Detect an inline event-handler attribute (`onclick=`, `onload=`, etc.).
 *
 * When a widget is rendered via `wrapper.innerHTML = html` (the no-iframe
 * path), inline event handlers execute in the HOST window context. That
 * means `window.setChatMessages` and any other JSR shim — which we only
 * define inside iframe srcdoc — would NOT be reachable from a click on
 * such a widget. Vavesta's Return Home (`【VAVESTA_HOME】`) is exactly this
 * shape: no `<script>` tag, but an `onclick=` calling setChatMessages.
 *
 * `widgetNeedsIsolation` (below) treats this as equivalent to having a
 * `<script>` tag and forces the widget through the iframe path so the
 * shim is reachable. The cost is a heavier element (iframe vs. div), but
 * (a) it's a small static widget so DOM weight is irrelevant in practice,
 * and (b) consistency wins — every interactive widget runs in a uniform
 * isolated context with shim availability guaranteed.
 *
 * The attribute list is the common subset of HTML event handlers that
 * widgets in scope use. If a future card uses an unlisted handler (e.g.
 * `oninvalid`, `ontoggle`), extend here.
 */
export function containsInlineEventHandler(html: string): boolean {
  return /\bon(?:click|load|mouseover|mouseout|mousedown|mouseup|mousemove|change|input|submit|focus|blur|keydown|keyup|keypress|error|abort|cancel|toggle|wheel|contextmenu)\s*=/i.test(html);
}

/**
 * A widget needs iframe isolation if it has either a `<script>` tag (true
 * JS execution context) or an inline event handler (which would otherwise
 * execute in the host window where shims aren't defined). Used by
 * inject-into-message to decide between the iframe path and the inline
 * `<div>+innerHTML` path.
 */
export function widgetNeedsIsolation(html: string): boolean {
  return containsScriptTag(html) || containsInlineEventHandler(html);
}

/**
 * Combine head injection (color-scheme meta + JSR shims) + size-reporter
 * shell into the srcdoc HTML.
 *
 * Head injection goes as early as possible so the shims are defined BEFORE
 * any widget script runs. Vavesta's current widgets only call setChatMessages
 * from event handlers (onclick → vavGoSwipe), which means deferred-execution
 * timing makes the order moot in practice — but a future widget that calls
 * the shim at script-execute time would need it ready, so we don't take the
 * shortcut.
 *
 * Size-reporter goes at the end (before </body> if present) — it's a passive
 * observer that doesn't depend on order.
 */
function injectShimsAndSizeReporter(html: string, nonce: string): string {
  const head = buildHeadInjection(nonce);
  const withHead = injectIntoHead(html, head);

  const shell = sizeReporterShell(nonce);
  const closeBody = withHead.lastIndexOf('</body>');
  if (closeBody >= 0) {
    return withHead.slice(0, closeBody) + shell + withHead.slice(closeBody);
  }
  return withHead + shell;
}

/**
 * Build the head-injection blob: color-scheme meta + JSR shims.
 *
 * The color-scheme meta keeps a sandboxed null-origin iframe's canvas in
 * the right palette so the host theme shows through (Step 4 finding).
 *
 * The shim defines `window.setChatMessages` as a postMessage thin wrapper.
 * The second `options` argument of JSR's setChatMessages (refresh mode) is
 * ignored silently — Vishrun depends on the MutationObserver on
 * [data-component="MessageList"] to catch the React re-render after the
 * content rewrite, so manual refresh isn't needed.
 */
function buildHeadInjection(nonce: string): string {
  const nonceLit = JSON.stringify(nonce);
  return `<meta name="color-scheme" content="dark light">` +
    `<script>(function(){` +
    `window.setChatMessages = function(chat_messages){` +
    `try{window.parent.postMessage({__vishrun:'set-chat-messages',nonce:${nonceLit},payload:chat_messages},'*');}` +
    `catch(e){}` +
    `};` +
    `})();</script>`;
}

/**
 * Inject `blob` as early into the document as possible: right after the
 * `<head>` opening tag if present, else prepended to the html (browsers
 * hoist leading <meta>/<script> into the implicit head).
 *
 * Vavesta Intro Page has no <head> tag (only <html><div>...). Vavesta
 * Return Home has a proper <head>. Both cases must work.
 */
function injectIntoHead(html: string, blob: string): string {
  const openHead = html.match(/<head\b[^>]*>/i);
  if (openHead && openHead.index !== undefined) {
    const idx = openHead.index + openHead[0].length;
    return html.slice(0, idx) + blob + html.slice(idx);
  }
  return blob + html;
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
      // 48px pragmatic buffer: after three measurement-strategy iterations
      // (scrollHeight, padding-top margin-collapse trick, getBoundingClientRect)
      // a sub-pixel residual still slips past for some widgets. JS-Slash-Runner
      // uses the same trick for the same reason — measuring CSS-occupied
      // space exhaustively isn't tractable. Successive bumps (12 → 32 → 48)
      // after user reports that dense widgets (Vavesta Court Ledger expanded,
      // Pacifica Pulse) still clipped at the bottom. Visually imperceptible
      // padding, kills the residual scroll across the cards in scope.
      h += 48;
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
 * Install a single document-wide listener for postMessage traffic from
 * widget iframes. Routes by `__vishrun` message type:
 *
 *   - 'resize'              → adjust iframe height to reported content size
 *   - 'set-chat-messages'   → greeting navigation shim (translates JSR's
 *                             setChatMessages call into a Lumiverse content
 *                             rewrite, see handleSetChatMessages below)
 *
 * Always validates by per-iframe nonce: looks up the iframe by attribute
 * selector, then verifies the WeakMap entry matches before acting.
 */
export function installIframeBridge(ctx: SpindleFrontendContext): () => void {
  const handler = (e: MessageEvent) => {
    const data = e.data;
    if (!data || typeof data !== 'object') return;
    const d = data as {
      __vishrun?: string;
      nonce?: unknown;
      height?: unknown;
      payload?: unknown;
    };
    if (typeof d.nonce !== 'string' || !d.nonce) return;
    const iframe = findIframeByNonce(d.nonce);
    if (!iframe) return;

    if (d.__vishrun === 'resize') {
      const raw = Number(d.height);
      if (!Number.isFinite(raw)) return;
      // Bounded to [40, 4000] px to defend against widget bugs reporting
      // absurd heights (e.g. content with `height: 100vh` would otherwise
      // expand indefinitely).
      const h = Math.max(40, Math.min(4000, Math.round(raw)));
      iframe.style.height = `${h}px`;
      return;
    }

    if (d.__vishrun === 'set-chat-messages') {
      void handleSetChatMessages(iframe, d.payload, ctx);
      return;
    }
  };
  window.addEventListener('message', handler);
  return () => window.removeEventListener('message', handler);
}

/**
 * Translate a JSR `setChatMessages([{message_id, swipe_id}])` call from a
 * widget into the Lumiverse equivalent: rewrite message 0's content to the
 * greeting at the requested index.
 *
 * Why this is necessary: Lumiverse stores message 0 with a single swipe
 * (the chosen greeting only), unlike SillyTavern which pre-populates the
 * swipes[] array with first_mes + all alternate_greetings. JSR's
 * setChatMessages contract therefore can't be honored swipe-for-swipe — it
 * has to be translated to a content rewrite via PUT /chats/:id/messages/:id,
 * which is the same path Lumiverse's native GreetingNav uses
 * (GreetingNav.tsx:57).
 *
 * Why we don't pre-check `extra.greeting === true`: an earlier draft did a
 * GET before the PUT to verify the message was still a greeting. That GET
 * targeted `/api/v1/chats/:chatId/messages/:msgId`, which doesn't exist as
 * a single-message route in Lumiverse — only the list endpoint does (see
 * STEP_LOG §"Step 1.5"). The 404 response was the SPA fallback HTML, which
 * threw a JSON parse error.
 *
 * The greeting check turned out to be unnecessary anyway. The widgets that
 * call setChatMessages (Vavesta intro / Return Home) live in the card's
 * regex_scripts replaceStrings, which only run against placeholders the AI
 * emits — and those placeholders are part of the greeting content itself.
 * So an iframe carrying this shim only exists rendered inside a greeting,
 * by construction of the placeholder pipeline. The "message is a greeting"
 * invariant holds without an explicit check.
 *
 * The MutationObserver on [data-component="MessageList"] (Step 2) catches
 * React's re-render of the message subtree once the content updates and
 * re-injects the appropriate widgets idempotently. No manual refresh needed.
 * Note: MESSAGE_EDITED WS event empirically does NOT fire on this path
 * (Step 2 pivot 2), but the observer is event-agnostic so this doesn't
 * matter for us.
 */
async function handleSetChatMessages(
  iframe: HTMLIFrameElement,
  payload: unknown,
  ctx: SpindleFrontendContext,
): Promise<void> {
  if (!Array.isArray(payload)) {
    console.warn('[vishrun] setChatMessages: payload is not an array, ignoring');
    return;
  }
  const messageEl = iframe.closest('[data-message-id]') as HTMLElement | null;
  const messageId = messageEl?.getAttribute('data-message-id');
  if (!messageId) {
    console.warn('[vishrun] setChatMessages: cannot resolve messageId from iframe ancestry, ignoring');
    return;
  }
  const active = ctx.getActiveChat();
  const chatId = active.chatId;
  if (!chatId) {
    console.warn('[vishrun] setChatMessages: no active chat, ignoring');
    return;
  }
  const card = getActiveCard();
  if (!card) {
    console.warn('[vishrun] setChatMessages: no active card cached, ignoring');
    return;
  }

  for (const entry of payload) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as { message_id?: unknown; swipe_id?: unknown };

    // Vavesta only navigates greetings (message 0). Other message_ids would
    // mean editing chat history, which is feature-creep and risky — skip
    // silently with a debug log so a future card author isn't surprised at
    // the no-op without a hint in DevTools.
    if (typeof e.message_id !== 'number' || e.message_id !== 0) {
      console.debug('[vishrun] setChatMessages: skipping entry with message_id !== 0', e);
      continue;
    }

    const swipeId = typeof e.swipe_id === 'number' ? e.swipe_id : 0;
    let targetContent: string | undefined;
    if (swipeId === 0) {
      targetContent = card.firstMes ?? undefined;
    } else if (swipeId >= 1) {
      targetContent = card.alternateGreetings[swipeId - 1];
    }
    if (typeof targetContent !== 'string' || !targetContent) {
      console.warn(
        `[vishrun] setChatMessages: out-of-range swipe_id=${swipeId} ` +
        `(have first_mes=${card.firstMes ? 'yes' : 'no'}, ` +
        `alternate_greetings.length=${card.alternateGreetings.length}), aborting entry`
      );
      continue;
    }

    try {
      const r = await fetch(
        `/api/v1/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`,
        {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: targetContent }),
        },
      );
      if (!r.ok) {
        console.warn(
          `[vishrun] setChatMessages: PUT failed (HTTP ${r.status}) for swipe_id=${swipeId}`
        );
        continue;
      }
    } catch (err) {
      console.warn('[vishrun] setChatMessages: PUT threw', err);
      continue;
    }
  }
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
