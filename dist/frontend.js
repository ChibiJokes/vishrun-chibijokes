// src/lumiverse/fetch-character.ts
async function fetchCharacter(characterId) {
  const url = `/api/v1/characters/${encodeURIComponent(characterId)}`;
  const r = await fetch(url, { credentials: "same-origin" });
  if (!r.ok) {
    throw new Error(`fetchCharacter ${characterId}: HTTP ${r.status} ${r.statusText}`);
  }
  return await r.json();
}
function extractRegexScripts(char) {
  const scripts = char?.extensions?.regex_scripts;
  return Array.isArray(scripts) ? scripts : [];
}

// src/state/active-card.ts
var current = null;
function getActiveCard() {
  return current;
}
function setActiveCard(card) {
  current = card;
}
function clearActiveCard() {
  current = null;
}

// src/core/classify-trigger.ts
function isPlaceholder(re) {
  const src = re.source;
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "[") {
      i++;
      while (i < src.length && src[i] !== "]") {
        if (src[i] === "\\")
          i += 2;
        else
          i++;
      }
      i++;
      continue;
    }
    if (ch === "(") {
      if (src.slice(i, i + 3) === "(?:") {
        i += 3;
        continue;
      }
      return false;
    }
    i++;
  }
  return true;
}
function isPairedTag(re) {
  const src = re.source;
  const stripped = src.replace(/\\s\*/g, "").replace(/\s+/g, "").replace(/\\\//g, "/");
  const open = stripped.match(/^<([a-zA-Z_][a-zA-Z0-9_-]*)/);
  if (!open)
    return false;
  const tagName = open[1];
  const closeRe = new RegExp(`</${escapeRegex(tagName)}\\b`);
  return closeRe.test(stripped);
}
function classifyTrigger(re) {
  if (isPairedTag(re))
    return "pairedTag";
  if (isPlaceholder(re))
    return "placeholder";
  return "unknown";
}
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// src/core/parse-regex-script.ts
var FENCE_RE = /^\s*```[A-Za-z]*[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```\s*$/;
function stripCodeFence(s) {
  if (!s)
    return s;
  const m = s.match(FENCE_RE);
  return m ? m[1] : s;
}
function compileScripts(rawScripts) {
  const out = [];
  for (let i = 0;i < rawScripts.length; i++) {
    const s = rawScripts[i];
    if (s.disabled)
      continue;
    if (Array.isArray(s.placement) && !s.placement.includes(2))
      continue;
    const src = s.findRegex;
    if (!src || typeof src !== "string")
      continue;
    const replace = stripCodeFence(s.replaceString ?? "");
    let re;
    try {
      re = new RegExp(src, "gs");
    } catch (err) {
      console.debug(`[vishrun] script "${s.scriptName ?? "(unnamed)"}" findRegex failed to compile:`, err);
      continue;
    }
    const kind = classifyTrigger(re);
    if (kind === "unknown") {
      console.debug(`[vishrun] script "${s.scriptName ?? "(unnamed)"}" has unrecognized trigger shape ` + `(neither placeholder nor paired-tag) — will not render. findRegex: ${src}`);
    }
    out.push({
      id: s.id ?? `idx-${i}`,
      scriptName: s.scriptName ?? "(unnamed)",
      findRe: re,
      replaceString: replace,
      kind,
      sourceIndex: i
    });
  }
  return out;
}
(function selfTest() {
  try {
    const t1 = "```html\n<!DOCTYPE html>\n<body>x</body>\n```";
    console.assert(stripCodeFence(t1) === `<!DOCTYPE html>
<body>x</body>`, "[vishrun] stripCodeFence: lowercase html lang hint");
    const t2 = "```HTML\n  hi  \n```";
    console.assert(stripCodeFence(t2) === "  hi  ", "[vishrun] stripCodeFence: uppercase HTML lang hint preserves inner whitespace");
    const t3 = "```\nfoo\n```";
    console.assert(stripCodeFence(t3) === "foo", "[vishrun] stripCodeFence: no lang hint");
    const t4 = "   ```html  \r\nfoo\r\n```   ";
    console.assert(stripCodeFence(t4) === "foo", "[vishrun] stripCodeFence: surrounding whitespace + CRLF + trailing space on opening line");
    const t5 = `<!DOCTYPE html>
no fence here`;
    console.assert(stripCodeFence(t5) === t5, "[vishrun] stripCodeFence: pass-through when no fence");
    const t6 = "```html\nopener but no close";
    console.assert(stripCodeFence(t6) === t6, "[vishrun] stripCodeFence: pass-through when opening fence has no close");
    const t7 = '```html\n<!DOCTYPE html>\n<html lang="en">\n<body><div class="vav-home-wrap"></div></body>\n</html>\n```';
    const stripped = stripCodeFence(t7);
    console.assert(stripped.startsWith("<!DOCTYPE html>") && stripped.endsWith("</html>"), "[vishrun] stripCodeFence: Vavesta-shaped block unwraps cleanly");
  } catch (err) {
    console.error("[vishrun] stripCodeFence self-test threw:", err);
  }
})();

// src/core/substitute.ts
function substitute(template, fullMatch, groups) {
  let out = "";
  let i = 0;
  while (i < template.length) {
    const ch = template[i];
    if (ch !== "$") {
      out += ch;
      i++;
      continue;
    }
    const next = template[i + 1];
    if (next === "$") {
      out += "$";
      i += 2;
      continue;
    }
    if (next >= "0" && next <= "9") {
      let endNum = i + 2;
      while (endNum < template.length && template[endNum] >= "0" && template[endNum] <= "9")
        endNum++;
      const numStr = template.slice(i + 1, endNum);
      const idx = parseInt(numStr, 10);
      if (idx === 0) {
        out += fullMatch;
        i = endNum;
        continue;
      }
      if (idx <= groups.length) {
        out += groups[idx - 1] ?? "";
        i = endNum;
        continue;
      }
      let consumed = numStr.length;
      while (consumed > 1) {
        consumed--;
        const tryIdx = parseInt(numStr.slice(0, consumed), 10);
        if (tryIdx >= 1 && tryIdx <= groups.length) {
          out += groups[tryIdx - 1] ?? "";
          out += numStr.slice(consumed);
          i = endNum;
          break;
        }
      }
      if (consumed === 1) {
        out += "$" + numStr;
        i = endNum;
      }
      continue;
    }
    out += "$";
    i++;
  }
  return out;
}

// src/render/widget-iframe.ts
var iframeNonces = new WeakMap;
function buildWidgetIframe(html, scriptName, scriptId, ctx) {
  const nonce = makeNonce();
  const srcdoc = injectShimsAndSizeReporter(html, nonce);
  const iframe = ctx.dom.createElement("iframe", {
    sandbox: "allow-scripts",
    srcdoc,
    "data-vishrun-widget": scriptName,
    "data-vishrun-script-id": scriptId,
    "data-vishrun-iframe-nonce": nonce
  });
  iframeNonces.set(iframe, nonce);
  iframe.style.width = "100%";
  iframe.style.height = "1px";
  iframe.style.border = "none";
  iframe.style.display = "block";
  iframe.style.margin = "12px 0";
  iframe.style.maxHeight = "none";
  iframe.style.maxWidth = "none";
  return iframe;
}
function containsScriptTag(html) {
  return /<script\b[^>]*>/i.test(html);
}
function containsInlineEventHandler(html) {
  return /\bon(?:click|load|mouseover|mouseout|mousedown|mouseup|mousemove|change|input|submit|focus|blur|keydown|keyup|keypress|error|abort|cancel|toggle|wheel|contextmenu)\s*=/i.test(html);
}
function widgetNeedsIsolation(html) {
  return containsScriptTag(html) || containsInlineEventHandler(html);
}
function injectShimsAndSizeReporter(html, nonce) {
  const head = buildHeadInjection(nonce);
  const withHead = injectIntoHead(html, head);
  const shell = sizeReporterShell(nonce);
  const closeBody = withHead.lastIndexOf("</body>");
  if (closeBody >= 0) {
    return withHead.slice(0, closeBody) + shell + withHead.slice(closeBody);
  }
  return withHead + shell;
}
function buildHeadInjection(nonce) {
  const nonceLit = JSON.stringify(nonce);
  return `<meta name="color-scheme" content="dark light">` + `<script>(function(){` + `window.setChatMessages = function(chat_messages){` + `try{window.parent.postMessage({__vishrun:'set-chat-messages',nonce:${nonceLit},payload:chat_messages},'*');}` + `catch(e){}` + `};` + `})();</script>`;
}
function injectIntoHead(html, blob) {
  const openHead = html.match(/<head\b[^>]*>/i);
  if (openHead && openHead.index !== undefined) {
    const idx = openHead.index + openHead[0].length;
    return html.slice(0, idx) + blob + html.slice(idx);
  }
  return blob + html;
}
function sizeReporterShell(nonce) {
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
function makeNonce() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}
function installIframeBridge(ctx) {
  const handler = (e) => {
    const data = e.data;
    if (!data || typeof data !== "object")
      return;
    const d = data;
    if (typeof d.nonce !== "string" || !d.nonce)
      return;
    const iframe = findIframeByNonce(d.nonce);
    if (!iframe)
      return;
    if (d.__vishrun === "resize") {
      const raw = Number(d.height);
      if (!Number.isFinite(raw))
        return;
      const h = Math.max(40, Math.min(4000, Math.round(raw)));
      iframe.style.height = `${h}px`;
      return;
    }
    if (d.__vishrun === "set-chat-messages") {
      handleSetChatMessages(iframe, d.payload, ctx);
      return;
    }
  };
  window.addEventListener("message", handler);
  return () => window.removeEventListener("message", handler);
}
async function handleSetChatMessages(iframe, payload, ctx) {
  if (!Array.isArray(payload)) {
    console.warn("[vishrun] setChatMessages: payload is not an array, ignoring");
    return;
  }
  const messageEl = iframe.closest("[data-message-id]");
  const messageId = messageEl?.getAttribute("data-message-id");
  if (!messageId) {
    console.warn("[vishrun] setChatMessages: cannot resolve messageId from iframe ancestry, ignoring");
    return;
  }
  const active = ctx.getActiveChat();
  const chatId = active.chatId;
  if (!chatId) {
    console.warn("[vishrun] setChatMessages: no active chat, ignoring");
    return;
  }
  const card = getActiveCard();
  if (!card) {
    console.warn("[vishrun] setChatMessages: no active card cached, ignoring");
    return;
  }
  for (const entry of payload) {
    if (!entry || typeof entry !== "object")
      continue;
    const e = entry;
    if (typeof e.message_id !== "number" || e.message_id !== 0) {
      console.debug("[vishrun] setChatMessages: skipping entry with message_id !== 0", e);
      continue;
    }
    const swipeId = typeof e.swipe_id === "number" ? e.swipe_id : 0;
    let targetContent;
    if (swipeId === 0) {
      targetContent = card.firstMes ?? undefined;
    } else if (swipeId >= 1) {
      targetContent = card.alternateGreetings[swipeId - 1];
    }
    if (typeof targetContent !== "string" || !targetContent) {
      console.warn(`[vishrun] setChatMessages: out-of-range swipe_id=${swipeId} ` + `(have first_mes=${card.firstMes ? "yes" : "no"}, ` + `alternate_greetings.length=${card.alternateGreetings.length}), aborting entry`);
      continue;
    }
    try {
      const r = await fetch(`/api/v1/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: targetContent })
      });
      if (!r.ok) {
        console.warn(`[vishrun] setChatMessages: PUT failed (HTTP ${r.status}) for swipe_id=${swipeId}`);
        continue;
      }
    } catch (err) {
      console.warn("[vishrun] setChatMessages: PUT threw", err);
      continue;
    }
  }
}
function findIframeByNonce(nonce) {
  const escaped = cssEscape(nonce);
  const iframe = document.querySelector(`iframe[data-vishrun-iframe-nonce="${escaped}"]`);
  if (!iframe)
    return null;
  if (iframeNonces.get(iframe) !== nonce)
    return null;
  return iframe;
}
function cssEscape(s) {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(s) : s.replace(/["\\]/g, "\\$&");
}

// src/hooks/tag-interceptor.ts
var capturesByMessage = new Map;
function getCapturesForMessage(messageId) {
  return capturesByMessage.get(messageId) || [];
}
var activeUnsubs = [];
var activeTagNames = new Set;
function syncTagInterceptors(ctx, compiled) {
  const desired = new Map;
  for (const s of compiled) {
    if (s.kind !== "pairedTag")
      continue;
    const tagName = extractTagName(s.findRe.source);
    if (!tagName) {
      console.debug(`[vishrun] paired-tag script "${s.scriptName}" classified as pairedTag but ` + `extractTagName failed — skipping. findRegex source: ${s.findRe.source}`);
      continue;
    }
    desired.set(tagName.toLowerCase(), s);
  }
  if (desired.size === activeTagNames.size && [...desired.keys()].every((t) => activeTagNames.has(t))) {
    return;
  }
  activeUnsubs.forEach((u) => {
    try {
      u();
    } catch {}
  });
  activeUnsubs = [];
  activeTagNames = new Set(desired.keys());
  for (const [tagName, script] of desired) {
    const unsub = ctx.messages.registerTagInterceptor({ tagName, removeFromMessage: true }, (payload) => onCapture(payload, script));
    activeUnsubs.push(unsub);
    console.debug(`[vishrun][step3] registered tag interceptor for <${tagName}> (script: "${script.scriptName}")`);
  }
}
function teardownTagInterceptors() {
  activeUnsubs.forEach((u) => {
    try {
      u();
    } catch {}
  });
  activeUnsubs = [];
  activeTagNames = new Set;
}
function onCapture(payload, script) {
  if (!payload.messageId)
    return;
  const list = capturesByMessage.get(payload.messageId) || [];
  if (list.some((c) => c.scriptId === script.id && c.fullMatch === payload.fullMatch)) {
    return;
  }
  list.push({
    scriptId: script.id,
    scriptName: script.scriptName,
    replaceString: script.replaceString,
    findRe: script.findRe,
    fullMatch: payload.fullMatch,
    attrs: payload.attrs
  });
  capturesByMessage.set(payload.messageId, list);
  console.debug(`[vishrun][step3] captured <${payload.tagName}> for message ${payload.messageId} (inner=${payload.content.length} chars)`);
}
function extractTagName(reSource) {
  const m = reSource.match(/^<(?:\\s\*|\s)*([a-zA-Z_][a-zA-Z0-9_-]*)/);
  return m ? m[1] : null;
}

// src/render/inject-into-message.ts
function processNode(root, scripts, ctx) {
  let total = 0;
  for (const script of scripts) {
    if (script.kind !== "placeholder")
      continue;
    total += replacePlaceholderMatches(root, script, ctx);
  }
  const messageId = root.getAttribute("data-message-id") || undefined;
  if (messageId) {
    total += renderPairedTagCaptures(root, messageId, ctx);
  }
  return total;
}
function replacePlaceholderMatches(root, script, ctx) {
  const textNodes = collectTextNodes(root);
  let count = 0;
  for (const tn of textNodes) {
    const text = tn.nodeValue ?? "";
    if (!text)
      continue;
    script.findRe.lastIndex = 0;
    const ranges = [];
    let m;
    while ((m = script.findRe.exec(text)) !== null) {
      ranges.push({ start: m.index, end: m.index + m[0].length, match: m });
      if (m[0].length === 0)
        script.findRe.lastIndex++;
    }
    if (ranges.length === 0)
      continue;
    const parent = tn.parentNode;
    if (!parent)
      continue;
    const frag = document.createDocumentFragment();
    let cursor = 0;
    for (const { start, end, match } of ranges) {
      if (start > cursor) {
        frag.appendChild(document.createTextNode(text.slice(cursor, start)));
      }
      const groups = match.slice(1).map((g) => g ?? "");
      const html = substitute(script.replaceString, match[0], groups);
      const widget = buildWidget(html, script.scriptName, script.id, ctx);
      frag.appendChild(widget);
      cursor = end;
      count++;
    }
    if (cursor < text.length) {
      frag.appendChild(document.createTextNode(text.slice(cursor)));
    }
    parent.replaceChild(frag, tn);
  }
  return count;
}
function renderPairedTagCaptures(root, messageId, ctx) {
  const captures = getCapturesForMessage(messageId);
  if (captures.length === 0)
    return 0;
  const target = findContentRoot(root);
  let count = 0;
  for (const cap of captures) {
    const sel = `[data-vishrun-widget][data-vishrun-script-id="${cssEscape2(cap.scriptId)}"][data-vishrun-paired-fullmatch="${cssEscape2(hashKey(cap.fullMatch))}"]`;
    if (target.querySelector(sel))
      continue;
    cap.findRe.lastIndex = 0;
    const m = cap.findRe.exec(cap.fullMatch);
    if (!m) {
      console.debug(`[vishrun] paired-tag findRegex failed to re-match fullMatch for "${cap.scriptName}" — rendering raw text`);
      const failed = ctx.dom.createElement("span", {
        "data-vishrun-widget": cap.scriptName,
        "data-vishrun-widget-failed": cap.scriptName,
        "data-vishrun-script-id": cap.scriptId
      });
      failed.setAttribute("data-vishrun-paired-fullmatch", hashKey(cap.fullMatch));
      failed.textContent = cap.fullMatch;
      target.appendChild(failed);
      count++;
      continue;
    }
    const groups = m.slice(1).map((g) => g ?? "");
    const html = substitute(cap.replaceString, m[0], groups);
    const iframe = buildWidgetIframe(html, cap.scriptName, cap.scriptId, ctx);
    iframe.setAttribute("data-vishrun-paired-fullmatch", hashKey(cap.fullMatch));
    target.appendChild(iframe);
    count++;
  }
  return count;
}
function findContentRoot(messageNode) {
  const inner = messageNode.querySelector('[data-component="MessageContent"]');
  return inner ?? messageNode;
}
function buildWidget(html, scriptName, scriptId, ctx) {
  if (widgetNeedsIsolation(html)) {
    return buildWidgetIframe(html, scriptName, scriptId, ctx);
  }
  const wrapper = ctx.dom.createElement("div", {
    "data-vishrun-widget": scriptName,
    "data-vishrun-script-id": scriptId
  });
  wrapper.style.margin = "12px 0";
  wrapper.innerHTML = html;
  return wrapper;
}
function collectTextNodes(root) {
  const out = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      let p = node.parentElement;
      while (p && p !== root) {
        if (p.hasAttribute("data-vishrun-widget"))
          return NodeFilter.FILTER_REJECT;
        p = p.parentElement;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  let n;
  while ((n = walker.nextNode()) !== null) {
    out.push(n);
  }
  return out;
}
function cssEscape2(s) {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(s) : s.replace(/["\\]/g, "\\$&");
}
function hashKey(s) {
  let h = 5381;
  for (let i = 0;i < s.length; i++) {
    h = (h << 5) + h + s.charCodeAt(i) | 0;
  }
  return (h >>> 0).toString(36);
}

// src/hooks/message-rendered.ts
var MAX_RAF_RETRIES = 3;
var MESSAGE_LIST_SELECTOR = '[data-component="MessageList"]';
function installMessageHooks(ctx) {
  let observer = null;
  let observedTarget = null;
  let pendingFrame = 0;
  let bodyWatcher = null;
  function compiledForActiveCard() {
    const card = getActiveCard();
    if (!card)
      return null;
    const compiled = compileScripts(card.scripts);
    return compiled.length === 0 ? null : compiled;
  }
  function isActiveChat(chatId) {
    if (!chatId)
      return true;
    const active = ctx.getActiveChat().chatId;
    if (!active)
      return true;
    return active === chatId;
  }
  function processMessageById(messageId, retriesLeft) {
    const compiled = compiledForActiveCard();
    if (!compiled)
      return;
    const sel = buildMessageSelector(messageId);
    const node = document.querySelector(sel);
    if (node) {
      const n = processNode(node, compiled, ctx);
      if (n > 0) {
        console.debug(`[vishrun][step3] rendered ${n} widget(s) into message ${messageId}`);
      }
      return;
    }
    if (retriesLeft > 0) {
      requestAnimationFrame(() => processMessageById(messageId, retriesLeft - 1));
    } else {
      console.debug(`[vishrun][step3] message ${messageId} not found in DOM after ${MAX_RAF_RETRIES} frames`);
    }
  }
  function scanAllNow(compiled) {
    const nodes = document.querySelectorAll("[data-message-id]");
    let total = 0;
    nodes.forEach((n) => {
      total += processNode(n, compiled, ctx);
    });
    if (total > 0) {
      console.debug(`[vishrun][step3] scan rendered ${total} widget(s) across ${nodes.length} message(s)`);
    }
  }
  function handleMutations() {
    if (pendingFrame)
      return;
    pendingFrame = requestAnimationFrame(() => {
      pendingFrame = 0;
      const compiled = compiledForActiveCard();
      if (!compiled) {
        detachObserver();
        return;
      }
      scanAllNow(compiled);
    });
  }
  function attachObserver() {
    const target = document.querySelector(MESSAGE_LIST_SELECTOR);
    if (!target) {
      if (observer && observedTarget && !document.contains(observedTarget)) {
        detachObserver();
      }
      ensureBodyWatcher();
      return;
    }
    if (bodyWatcher) {
      bodyWatcher.disconnect();
      bodyWatcher = null;
    }
    if (observer && observedTarget === target)
      return;
    if (observer)
      observer.disconnect();
    observer = new MutationObserver(handleMutations);
    observer.observe(target, { childList: true, subtree: true, characterData: true });
    observedTarget = target;
    console.debug("[vishrun][step3] MutationObserver attached to", MESSAGE_LIST_SELECTOR);
  }
  function ensureBodyWatcher() {
    if (bodyWatcher)
      return;
    if (!document.body)
      return;
    bodyWatcher = new MutationObserver((records) => {
      let foundTarget = null;
      outer:
        for (const r of records) {
          for (const node of r.addedNodes) {
            if (!(node instanceof Element))
              continue;
            if (node.matches?.(MESSAGE_LIST_SELECTOR)) {
              foundTarget = node;
              break outer;
            }
            const nested = node.querySelector?.(MESSAGE_LIST_SELECTOR);
            if (nested) {
              foundTarget = nested;
              break outer;
            }
          }
        }
      if (!foundTarget)
        return;
      bodyWatcher.disconnect();
      bodyWatcher = null;
      const compiled = compiledForActiveCard();
      if (!compiled)
        return;
      attachObserver();
      scanAllNow(compiled);
    });
    bodyWatcher.observe(document.body, { childList: true, subtree: true });
    console.debug("[vishrun][step3] MessageList not yet mounted — body watcher armed");
  }
  function detachObserver() {
    if (pendingFrame) {
      cancelAnimationFrame(pendingFrame);
      pendingFrame = 0;
    }
    if (bodyWatcher) {
      bodyWatcher.disconnect();
      bodyWatcher = null;
    }
    if (observer) {
      observer.disconnect();
      observer = null;
      observedTarget = null;
      console.debug("[vishrun][step3] MutationObserver detached");
    }
  }
  function rescanAll() {
    const compiledNow = compiledForActiveCard();
    if (compiledNow) {
      syncTagInterceptors(ctx, compiledNow);
    } else {
      teardownTagInterceptors();
    }
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const compiled = compiledForActiveCard();
      if (!compiled) {
        detachObserver();
        return;
      }
      attachObserver();
      scanAllNow(compiled);
    }));
  }
  const unsubGenEnded = ctx.events.on("GENERATION_ENDED", (payload) => {
    const p = payload || {};
    if (p.error)
      return;
    if (!isActiveChat(p.chatId))
      return;
    if (!p.messageId)
      return;
    processMessageById(p.messageId, MAX_RAF_RETRIES);
  });
  const unsubChatChanged = ctx.events.on("CHAT_CHANGED", () => {
    rescanAll();
  });
  return {
    rescanAll,
    dispose: () => {
      detachObserver();
      teardownTagInterceptors();
      unsubGenEnded();
      unsubChatChanged();
    }
  };
}
function buildMessageSelector(messageId) {
  const escaped = typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(messageId) : messageId.replace(/["\\]/g, "\\$&");
  return `[data-message-id="${escaped}"]`;
}

// src/frontend.ts
var STEP_LABEL = "Vishrun · Step 3";
function setup(ctx) {
  console.log("[vishrun][step3] setup() invoked");
  const removeStyle = ctx.dom.addStyle(`
    .vishrun-banner {
      position: fixed;
      top: 12px;
      right: 12px;
      max-width: 460px;
      padding: 10px 14px;
      background: var(--lumiverse-fill-subtle, #1f1f1f);
      border: 1px solid var(--lumiverse-border, #444);
      border-radius: 6px;
      color: var(--lumiverse-text, #eee);
      font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
      z-index: 99999;
      box-shadow: 0 4px 16px rgba(0,0,0,0.35);
      display: none;
    }
    .vishrun-banner.show { display: block; }
    .vishrun-banner b { color: var(--lumiverse-text, #fff); }
    .vishrun-banner .ok { color: #5fd97e; }
    .vishrun-banner .fail { color: #ff7a7a; }
    .vishrun-banner .muted { color: var(--lumiverse-text-muted, #999); }
    .vishrun-banner ul { margin: 4px 0 0 0; padding-left: 18px; }
    .vishrun-banner li { line-height: 1.35; }
  `);
  ctx.dom.inject("body", '<div class="vishrun-banner"></div>');
  const banner = ctx.dom.query(".vishrun-banner");
  const escape = (s) => s.replace(/[<>&"]/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[ch]);
  const renderHidden = () => {
    if (banner) {
      banner.classList.remove("show");
      banner.innerHTML = "";
    }
  };
  const renderLoaded = (count, characterName, scriptNames) => {
    if (!banner)
      return;
    const items = scriptNames.map((n) => `<li>${escape(n || "(unnamed)")}</li>`).join("");
    banner.innerHTML = `<b>${STEP_LABEL}</b><br>` + `<span class="ok">✓ loaded ${count} regex_scripts</span><br>` + `<span class="muted">card: ${escape(characterName ?? "(unnamed)")}</span>` + (items ? `<ul>${items}</ul>` : "");
    banner.classList.add("show");
  };
  const renderError = (msg) => {
    if (!banner)
      return;
    banner.innerHTML = `<b>${STEP_LABEL}</b><br><span class="fail">✗ ${escape(msg)}</span>`;
    banner.classList.add("show");
  };
  const hooks = installMessageHooks(ctx);
  const teardownIframeBridge = installIframeBridge(ctx);
  let inflightCharacterId = null;
  let lastLoadedCharacterId = null;
  async function loadFor(characterId) {
    if (!characterId) {
      clearActiveCard();
      lastLoadedCharacterId = null;
      renderHidden();
      hooks.rescanAll();
      console.debug("[vishrun][step3] no active character — silent no-op");
      return;
    }
    if (inflightCharacterId === characterId)
      return;
    if (lastLoadedCharacterId === characterId && getActiveCard()?.characterId === characterId) {
      hooks.rescanAll();
      return;
    }
    inflightCharacterId = characterId;
    try {
      const char = await fetchCharacter(characterId);
      const scripts = extractRegexScripts(char);
      const name = char.name ?? null;
      if (scripts.length === 0) {
        clearActiveCard();
        lastLoadedCharacterId = characterId;
        renderHidden();
        hooks.rescanAll();
        console.debug(`[vishrun][step3] character ${characterId} has no regex_scripts — silent no-op`);
        return;
      }
      const firstMes = typeof char.first_mes === "string" ? char.first_mes : null;
      const alternateGreetings = Array.isArray(char.alternate_greetings) ? char.alternate_greetings.filter((g) => typeof g === "string") : [];
      setActiveCard({ characterId, characterName: name, scripts, firstMes, alternateGreetings });
      lastLoadedCharacterId = characterId;
      const enabled = scripts.filter((s) => !s.disabled).length;
      console.log(`[vishrun][step3] loaded ${scripts.length} regex_scripts (${enabled} enabled) for character "${name}" (${characterId})`, scripts.map((s) => ({
        scriptName: s.scriptName,
        findRegex: s.findRegex,
        disabled: s.disabled,
        placement: s.placement,
        replaceLen: s.replaceString?.length
      })));
      renderLoaded(scripts.length, name, scripts.map((s) => s.scriptName ?? ""));
      hooks.rescanAll();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[vishrun][step3] fetchCharacter failed:", err);
      renderError(`fetchCharacter failed: ${msg}`);
    } finally {
      if (inflightCharacterId === characterId)
        inflightCharacterId = null;
    }
  }
  const unsubChatChanged = ctx.events.on("CHAT_CHANGED", (payload) => {
    const p = payload || {};
    console.log("[vishrun][step3] CHAT_CHANGED:", p);
    loadFor(p.characterId ?? ctx.getActiveChat().characterId ?? null);
  });
  const unsubSettingsUpdated = ctx.events.on("SETTINGS_UPDATED", (payload) => {
    const p = payload || {};
    if (p.key !== "activeChatId" && p.key !== "activeCharacterId")
      return;
    loadFor(ctx.getActiveChat().characterId ?? null);
  });
  const active = ctx.getActiveChat();
  console.log("[vishrun][step3] initial getActiveChat():", active);
  if (active.characterId) {
    loadFor(active.characterId);
  } else {
    console.debug("[vishrun][step3] setup ran before chat hydration — waiting for SETTINGS_UPDATED");
  }
  return () => {
    unsubChatChanged();
    unsubSettingsUpdated();
    hooks.dispose();
    teardownIframeBridge();
    removeStyle();
    ctx.dom.cleanup();
    clearActiveCard();
  };
}
export {
  setup
};
