import type { SpindleFrontendContext, SpindleSandboxFrameHandle } from 'lumiverse-spindle-types';
import { getActiveCard } from '../state/active-card';

/**
 * Per-iframe destroy function. WeakMap so removing the iframe from the
 * DOM lets the entry GC away once no other code holds the element. Used
 * by destroyWidgetIframe(iframe) to release the host-side sandbox frame
 * record (sandbox-frame.ts keeps a string-keyed Map that doesn't clear
 * on element removal alone).
 */
const widgetFrameDestroyers = new WeakMap<HTMLIFrameElement, () => void>();

/**
 * Build a sandboxed iframe widget from a fence-stripped, substituted HTML
 * string, using ctx.dom.createSandboxFrame (the only sanctioned path for
 * scriptable iframes since Lumiverse staging d157784).
 *
 * autoResize is disabled because the host's built-in size reporter
 * under-measures dense widgets — Vavesta Court Ledger and Pacifica Pulse
 * both clipped at the bottom under it. We keep the lastChild
 * getBoundingClientRect strategy plus the 48px buffer iterated through
 * three Step-6 pivots (12 → 32 → 48) and post heights via the
 * window.spindleSandbox.requestResize hook the host exposes inside the
 * child.
 *
 * Carries:
 *  - data-vishrun-widget — processNode idempotency check + paired-tag
 *    selector matching.
 *  - data-vishrun-script-id — paired-widget cleanup keying.
 *  - data-spindle-ext (added automatically by createSandboxFrame) —
 *    ctx.dom.cleanup() removes it on extension teardown.
 *
 * Per-frame frame.onMessage handler is registered before the caller
 * appends the iframe so messages emitted during initial child load
 * (DOMContentLoaded → first postSize) don't slip past. The frame.onMessage
 * channel is naturally scoped to this iframe's contentWindow by the host
 * bridge (sandbox-frame.ts:38), so no nonce / per-iframe id is needed.
 */
export function buildWidgetIframe(
  html: string,
  scriptName: string,
  scriptId: string,
  ctx: SpindleFrontendContext,
): HTMLIFrameElement {
  const srcdoc = injectShimsAndSizeReporter(html);
  const frame = ctx.dom.createSandboxFrame({
    html: srcdoc,
    autoResize: false,
    minHeight: 1,
    maxHeight: 4000,
    initialHeight: 1,
  });

  // Register before any caller appendChild — the child's first postSize
  // fires from DOMContentLoaded, which lands once the iframe is connected.
  // Subscribing first guarantees we receive it.
  frame.onMessage((payload) => {
    routeChildMessage(frame, payload, ctx);
  });

  const iframe = frame.element;
  iframe.setAttribute('data-vishrun-widget', scriptName);
  iframe.setAttribute('data-vishrun-script-id', scriptId);
  // 12px vertical margin matches the no-isolation div path in
  // inject-into-message.ts:209. Keeps spacing consistent across both
  // paths regardless of which one each card lands on.
  iframe.style.margin = '12px 0';
  // Override Lumiverse's `.prose iframe { max-height: 400px; max-width: 100% }`
  // (MessageContent.module.css:423-429). Without this, the host bridge
  // sets height to the real content height (e.g. 1170px), but the
  // browser clamps it via min(height, max-height) → 400px, with an
  // internal scrollbar. Inline beats class-selector specificity so no
  // !important needed.
  iframe.style.maxHeight = 'none';
  iframe.style.maxWidth = 'none';

  widgetFrameDestroyers.set(iframe, () => frame.destroy());
  return iframe;
}

/**
 * Tear down a vishrun widget iframe: calls the host's destroy() to
 * release the sandbox frame record, then removes the element. Use this
 * instead of plain element.remove() anywhere vishrun explicitly evicts
 * one of its widgets — paired-tag stale cleanup in inject-into-message
 * is the call site today.
 *
 * No-op for elements not tracked here (e.g. placeholder widgets that
 * React unmounts via diffing — those leak the host record until
 * extension teardown clears via ctx.dom.cleanup, which is acceptable).
 */
export function destroyWidgetIframe(iframe: HTMLIFrameElement): void {
  const destroy = widgetFrameDestroyers.get(iframe);
  if (destroy) {
    widgetFrameDestroyers.delete(iframe);
    try {
      destroy();
    } catch (e) {
      console.debug('[vishrun] sandbox frame destroy threw:', e);
    }
    return;
  }
  iframe.remove();
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
 * shim is reachable.
 */
export function containsInlineEventHandler(html: string): boolean {
  return /\bon(?:click|load|mouseover|mouseout|mousedown|mouseup|mousemove|change|input|submit|focus|blur|keydown|keyup|keypress|error|abort|cancel|toggle|wheel|contextmenu)\s*=/i.test(html);
}

/**
 * A widget needs iframe isolation if it has either a `<script>` tag (true
 * JS execution context) or an inline event handler (which would otherwise
 * execute in the host window where shims aren't defined).
 */
export function widgetNeedsIsolation(html: string): boolean {
  return containsScriptTag(html) || containsInlineEventHandler(html);
}

/**
 * Combine head injection (setChatMessages shim) + size-reporter shell
 * into the srcdoc HTML. The host's createSandboxFrame already injects
 * its own meta charset/viewport/CSP, color-scheme, html/body reset, and
 * defines window.spindleSandbox — we only add the JSR shim translation
 * and our own measurement reporter on top.
 *
 * Head injection goes as early as possible so the shims are defined
 * BEFORE any widget script runs.
 */
function injectShimsAndSizeReporter(html: string): string {
  const head = buildHeadInjection();
  const withHead = injectIntoHead(html, head);

  const shell = sizeReporterShell();
  const closeBody = withHead.lastIndexOf('</body>');
  if (closeBody >= 0) {
    return withHead.slice(0, closeBody) + shell + withHead.slice(closeBody);
  }
  return withHead + shell;
}

/**
 * setChatMessages JSR shim translated to window.spindleSandbox.postMessage.
 * The host bridge validates each message by event.source ===
 * record.iframe.contentWindow (sandbox-frame.ts:38), which makes the
 * pre-d157784 nonce keying redundant — drop it.
 *
 * The shim's second argument (refresh mode) is silently ignored; vishrun
 * relies on Lumiverse's React re-render of MessageContent after the
 * content rewrite, so manual refresh isn't needed.
 */
function buildHeadInjection(): string {
  return setChatMessagesShim();
}

function setChatMessagesShim(): string {
  return `<script>(function(){` +
    `window.setChatMessages = function(chat_messages){` +
    `try{` +
    `if(window.spindleSandbox && typeof window.spindleSandbox.postMessage==='function'){` +
    `window.spindleSandbox.postMessage({kind:'set-chat-messages',payload:chat_messages});` +
    `}` +
    `}catch(e){}` +
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

function sizeReporterShell(): string {
  return `
<script>
(function() {
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
      // Pacifica Pulse) still clipped at the bottom.
      h += 48;
      if (window.spindleSandbox && typeof window.spindleSandbox.requestResize === 'function') {
        window.spindleSandbox.requestResize(h);
      }
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

/**
 * Route a payload from a single widget child to the appropriate handler.
 * The host bridge already filters by iframe contentWindow, so payloads
 * arriving here are guaranteed to come from THIS frame — no nonce
 * validation needed.
 *
 * Today the only kind we handle is 'set-chat-messages' (greeting nav
 * shim). Unknown kinds are ignored silently to leave room for future
 * card-introduced shims without forcing a vishrun release.
 */
function routeChildMessage(
  frame: SpindleSandboxFrameHandle,
  payload: unknown,
  ctx: SpindleFrontendContext,
): void {
  if (!payload || typeof payload !== 'object') return;
  const p = payload as { kind?: unknown; payload?: unknown };
  if (p.kind === 'set-chat-messages') {
    void handleSetChatMessages(frame.element, p.payload, ctx);
  }
}

/**
 * Translate a JSR `setChatMessages([{message_id, swipe_id}])` call from a
 * widget into the Lumiverse equivalent: rewrite message 0's content to
 * the greeting at the requested index.
 *
 * Why this is necessary: Lumiverse stores message 0 with a single swipe
 * (the chosen greeting only), unlike SillyTavern which pre-populates the
 * swipes[] array with first_mes + all alternate_greetings. JSR's
 * setChatMessages contract therefore can't be honored swipe-for-swipe — it
 * has to be translated to a content rewrite via PUT
 * /chats/:id/messages/:id, which is the same path Lumiverse's native
 * GreetingNav uses (GreetingNav.tsx:57).
 *
 * Why the direct fetch instead of ctx.chats.updateMessage: the frontend
 * module runs in the host document, has BetterAuth cookies, and the
 * MutationObserver in hooks/message-rendered.ts catches the React
 * re-render after the content rewrite. ctx.chats.updateMessage would
 * also work and would additionally sync the local store, but that
 * change is structural (Path B) and out of scope for the d157784
 * mechanical refactor.
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

    // Vavesta only navigates greetings (message 0). Other message_ids
    // would mean editing chat history, which is feature-creep and risky
    // — skip silently with a debug log so a future card author isn't
    // surprised at the no-op without a hint in DevTools.
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
