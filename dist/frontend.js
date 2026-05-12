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
function parseRegexLiteral(s) {
  const m = s.match(/^\s*\/((?:\\.|[^/\\])*)\/([gimsuy]*)\s*$/);
  if (!m || !m[1])
    return { pattern: s, flags: "" };
  return { pattern: m[1], flags: m[2] };
}
function mergeFlags(userFlags) {
  const set = new Set(["g", "s"]);
  for (const f of userFlags)
    set.add(f);
  return Array.from(set).join("");
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
    const { pattern, flags } = parseRegexLiteral(src);
    let re;
    try {
      re = new RegExp(pattern, mergeFlags(flags));
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
    const r1 = parseRegexLiteral("/↦(\\S+)\\s([^:]+):([\\s\\S]*?)↤/g");
    console.assert(r1.pattern === "↦(\\S+)\\s([^:]+):([\\s\\S]*?)↤" && r1.flags === "g", "[vishrun] parseRegexLiteral: ↦/↤-delimited literal with g flag");
    const r2 = parseRegexLiteral("【VAVESTA_HOME】");
    console.assert(r2.pattern === "【VAVESTA_HOME】" && r2.flags === "", "[vishrun] parseRegexLiteral: non-literal placeholder passes through");
    const r3 = parseRegexLiteral("<\\s*PACIFICA_UI\\s*>([\\s\\S]*?)<\\s*\\/PACIFICA_UI\\s*>");
    console.assert(r3.pattern === "<\\s*PACIFICA_UI\\s*>([\\s\\S]*?)<\\s*\\/PACIFICA_UI\\s*>" && r3.flags === "", "[vishrun] parseRegexLiteral: paired-tag source without delimiters passes through");
    const r4 = parseRegexLiteral("/foo\\/bar/i");
    console.assert(r4.pattern === "foo\\/bar" && r4.flags === "i", "[vishrun] parseRegexLiteral: escaped slash inside pattern is not a closer");
    const r5 = parseRegexLiteral("/no closer");
    console.assert(r5.pattern === "/no closer" && r5.flags === "", "[vishrun] parseRegexLiteral: unmatched leading / passes through");
    console.assert(mergeFlags("") === "gs", "[vishrun] mergeFlags: empty user flags → default gs");
    console.assert([...mergeFlags("gi")].sort().join("") === "gis", "[vishrun] mergeFlags: dedupes g and adds i");
  } catch (err) {
    console.error("[vishrun] parse-regex-script self-test threw:", err);
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

// src/core/asset-injector.ts
function isFetchExternalResponse(p, requestId) {
  return !!p && typeof p === "object" && p.type === "fetch_external_response" && p.requestId === requestId;
}
var requestCounter = 0;
function nextRequestId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `vishrun-fx-${Date.now()}-${++requestCounter}`;
}
function fetchViaBackend(url, ctx, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const requestId = nextRequestId();
    let settled = false;
    let unsub = null;
    let timer = null;
    const finish = (run) => {
      if (settled)
        return;
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (unsub) {
        try {
          unsub();
        } catch {}
        unsub = null;
      }
      run();
    };
    unsub = ctx.onBackendMessage((payload) => {
      if (!isFetchExternalResponse(payload, requestId))
        return;
      if (payload.ok && typeof payload.body === "string") {
        const body = payload.body;
        finish(() => resolve(body));
      } else {
        finish(() => reject(new Error(payload.error || "fetch_external failed")));
      }
    });
    timer = setTimeout(() => {
      finish(() => reject(new Error("Backend fetch timeout")));
    }, timeoutMs);
    try {
      ctx.sendToBackend({ type: "fetch_external", requestId, url });
    } catch (err) {
      finish(() => reject(err instanceof Error ? err : new Error(String(err))));
    }
  });
}
var bundleCache = new Map;
function getCachedBundle(url, ctx) {
  const cached = bundleCache.get(url);
  if (cached)
    return cached;
  const pending = fetchViaBackend(url, ctx);
  bundleCache.set(url, pending);
  pending.catch(() => {
    if (bundleCache.get(url) === pending)
      bundleCache.delete(url);
  });
  return pending;
}
var TAILWIND_SCRIPT_RE = /<script\b[^>]*\bsrc\s*=\s*["'](https?:\/\/cdn\.tailwindcss\.com(?=[/?#"']|\s)[^"']*)["'][^>]*>\s*<\/script>/gi;
function extractTailwindUrls(html) {
  if (html.indexOf("cdn.tailwindcss.com") === -1)
    return [];
  const out = [];
  const seen = new Set;
  TAILWIND_SCRIPT_RE.lastIndex = 0;
  let m;
  while ((m = TAILWIND_SCRIPT_RE.exec(html)) !== null) {
    const url = m[1];
    if (!seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}
function detectCardColorScheme(html) {
  const meta = html.match(/<meta\s+name=["']color-scheme["']\s+content=["']([^"']+)["']/i);
  if (meta)
    return meta[1].trim();
  const css = html.match(/:root\s*\{[^}]*color-scheme\s*:\s*([^;}]+)/i);
  if (css)
    return css[1].trim();
  return null;
}
async function transformHtmlForTailwind(html, ctx) {
  const urls = extractTailwindUrls(html);
  if (urls.length === 0)
    return html;
  const bundles = await Promise.all(urls.map((url) => getCachedBundle(url, ctx).catch((err) => {
    console.warn("[vishrun] Tailwind fetch failed:", url, err instanceof Error ? err.message : String(err));
    return "";
  })));
  if (bundles.every((b) => b === ""))
    return html;
  const stripped = html.replace(TAILWIND_SCRIPT_RE, "");
  const inline = bundles.filter((b) => b !== "").map((b) => `<script>${b}</script>`).join("");
  const textColorOverride = detectCardColorScheme(html) === null ? "<style>:root{color:#000 !important}</style>" : "";
  return textColorOverride + inline + stripped;
}
var UNPKG_SCRIPT_RE = /<script\b[^>]*\bsrc\s*=\s*["'](https?:\/\/unpkg\.com(?=[/?#"']|\s)[^"']*)["'][^>]*>\s*<\/script>/gi;
function classifyUnpkgUrl(url) {
  const m = url.match(/^https?:\/\/unpkg\.com(\/[^"'?#]*)/i);
  if (!m)
    return null;
  const path = m[1];
  if (/^\/(?:@babel\/standalone|babel-standalone)(?:@[^/]*)?(?:\/|$)/i.test(path))
    return "babel";
  if (/^\/react-dom(?:@[^/]*)?(?:\/|$)/i.test(path))
    return "reactDom";
  if (/^\/react(?:@[^/]*)?(?:\/|$)/i.test(path))
    return "react";
  return null;
}
var REACT_BABEL_ORDER = ["react", "reactDom", "babel"];
function extractReactBabelUrls(html) {
  if (html.indexOf("unpkg.com") === -1)
    return {};
  const out = {};
  UNPKG_SCRIPT_RE.lastIndex = 0;
  let m;
  while ((m = UNPKG_SCRIPT_RE.exec(html)) !== null) {
    const url = m[1];
    const slot = classifyUnpkgUrl(url);
    if (slot && out[slot] === undefined)
      out[slot] = url;
  }
  return out;
}
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function stripScriptTagBySrc(html, url) {
  return html.replace(new RegExp(`<script\\b[^>]*\\bsrc\\s*=\\s*["']${escapeRegExp(url)}["'][^>]*>\\s*</script>`, "gi"), "");
}
async function transformHtmlForReactBabel(html, ctx) {
  const urls = extractReactBabelUrls(html);
  const slots = REACT_BABEL_ORDER.filter((slot) => urls[slot] !== undefined);
  if (slots.length === 0)
    return html;
  const fetched = await Promise.all(slots.map(async (slot) => {
    const url = urls[slot];
    try {
      return { url, body: await getCachedBundle(url, ctx) };
    } catch (err) {
      console.warn("[vishrun] React/Babel fetch failed:", url, err instanceof Error ? err.message : String(err));
      return { url, body: "" };
    }
  }));
  const ok = fetched.filter((f) => f.body !== "");
  if (ok.length === 0)
    return html;
  let stripped = html;
  for (const f of ok)
    stripped = stripScriptTagBySrc(stripped, f.url);
  const inline = ok.map((f) => `<script>${f.body}</script>`).join("");
  return inline + stripped;
}
async function transformHtmlForExternalScripts(html, ctx) {
  const withTailwind = await transformHtmlForTailwind(html, ctx);
  return transformHtmlForReactBabel(withTailwind, ctx);
}

// src/render/widget-iframe.ts
var widgetFrameDestroyers = new WeakMap;
var iframeRegistry = new Map;
var REGISTRY_SEP = "\x00";
function registryKey(messageId, scriptId) {
  return messageId + REGISTRY_SEP + scriptId;
}
function registerWidget(messageId, scriptId, iframe) {
  const k = registryKey(messageId, scriptId);
  let set = iframeRegistry.get(k);
  if (!set) {
    set = new Set;
    iframeRegistry.set(k, set);
  }
  set.add(iframe);
}
function unregisterWidget(iframe) {
  const messageId = iframe.getAttribute("data-vishrun-message-id");
  const scriptId = iframe.getAttribute("data-vishrun-script-id");
  if (!messageId || !scriptId)
    return;
  const k = registryKey(messageId, scriptId);
  const set = iframeRegistry.get(k);
  if (!set)
    return;
  set.delete(iframe);
  if (set.size === 0)
    iframeRegistry.delete(k);
}
function cleanupOrphansForMessage(messageId, target) {
  const prefix = messageId + REGISTRY_SEP;
  const matchingKeys = [];
  for (const k of iframeRegistry.keys()) {
    if (k.startsWith(prefix))
      matchingKeys.push(k);
  }
  for (const k of matchingKeys) {
    const set = iframeRegistry.get(k);
    if (!set)
      continue;
    for (const iframe of [...set]) {
      if (target && target.contains(iframe))
        continue;
      destroyWidgetIframe(iframe);
    }
  }
}
function hasRegisteredWidgetsFor(messageId, scriptId) {
  const set = iframeRegistry.get(registryKey(messageId, scriptId));
  return !!set && set.size > 0;
}
function destroyRegisteredWidgetsFor(messageId, scriptId) {
  const set = iframeRegistry.get(registryKey(messageId, scriptId));
  if (!set)
    return;
  for (const iframe of [...set]) {
    destroyWidgetIframe(iframe);
  }
}
async function buildWidgetIframe(html, scriptName, scriptId, messageId, ctx) {
  const srcdoc = await injectShimsAndSizeReporter(html, ctx);
  const frame = ctx.dom.createSandboxFrame({
    html: srcdoc,
    autoResize: false,
    minHeight: 1,
    maxHeight: 4000,
    initialHeight: 1
  });
  frame.onMessage((payload) => {
    routeChildMessage(frame, payload, ctx);
  });
  const iframe = frame.element;
  iframe.setAttribute("data-vishrun-widget", scriptName);
  iframe.setAttribute("data-vishrun-script-id", scriptId);
  iframe.setAttribute("data-vishrun-message-id", messageId);
  iframe.style.margin = "12px 0";
  iframe.style.maxHeight = "none";
  iframe.style.maxWidth = "none";
  widgetFrameDestroyers.set(iframe, () => frame.destroy());
  registerWidget(messageId, scriptId, iframe);
  return iframe;
}
function destroyWidgetIframe(iframe) {
  unregisterWidget(iframe);
  const destroy = widgetFrameDestroyers.get(iframe);
  if (destroy) {
    widgetFrameDestroyers.delete(iframe);
    try {
      destroy();
    } catch (e) {
      console.debug("[vishrun] sandbox frame destroy threw:", e);
    }
    return;
  }
  iframe.remove();
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
async function injectShimsAndSizeReporter(html, ctx) {
  const withExternalScripts = await transformHtmlForExternalScripts(html, ctx);
  const stripped = rewriteCssExternalUrls(stripExternalImageSrc(withExternalScripts));
  const head = buildHeadInjection();
  const withHead = injectIntoHead(stripped, head);
  const shell = sizeReporterShell();
  const closeBody = withHead.lastIndexOf("</body>");
  if (closeBody >= 0) {
    return withHead.slice(0, closeBody) + shell + withHead.slice(closeBody);
  }
  return withHead + shell;
}
function stripExternalImageSrc(html) {
  return html.replace(/<img\b[^>]*>/gi, (tag) => tag.replace(/(\s)src\s*=\s*(['"])(https?:\/\/[^'"]+)\2/i, "$1data-vishrun-extimg=$2$3$2"));
}
var VISHRUN_CSS_SENTINEL_PREFIX = "data:application/x-vishrun-cssproxy;base64,";
function rewriteCssExternalUrls(html) {
  if (html.indexOf("url(") === -1)
    return html;
  return html.replace(/url\(\s*(['"]?)(https?:\/\/[^'")\s]+)\1\s*\)/gi, (_match, _quote, url) => {
    const encoded = btoa(url);
    return `url("${VISHRUN_CSS_SENTINEL_PREFIX}${encoded}")`;
  });
}
function buildHeadInjection() {
  return viewportHeightShim() + setChatMessagesShim() + clipboardAlertShim() + externalImageProxyHelper();
}
function viewportHeightShim() {
  return "<style>" + ".min-h-screen,.min-h-\\[100vh\\],.min-h-\\[100dvh\\]{min-height:0 !important}" + ".h-screen,.h-\\[100vh\\],.h-\\[100dvh\\]{height:auto !important}" + "</style>";
}
function setChatMessagesShim() {
  return `<script>(function(){` + `window.setChatMessages = function(chat_messages){` + `try{` + `if(window.spindleSandbox && typeof window.spindleSandbox.postMessage==='function'){` + `window.spindleSandbox.postMessage({kind:'set-chat-messages',payload:chat_messages});` + `}` + `}catch(e){}` + `};` + `})();</script>`;
}
function clipboardAlertShim() {
  return `<script>(function(){` + `try{` + `if(!navigator.clipboard){Object.defineProperty(navigator,'clipboard',{value:{},configurable:true});}` + `navigator.clipboard.writeText=function(text){` + `try{window.spindleSandbox.postMessage({kind:'clipboard-write-text',payload:{text:String(text)}});return Promise.resolve();}` + `catch(e){return Promise.reject(e);}` + `};` + `}catch(e){}` + `window.alert=function(msg){` + `try{window.spindleSandbox.postMessage({kind:'alert',payload:{message:String(msg)}});}catch(e){}` + `};` + `})();</script>`;
}
function externalImageProxyHelper() {
  return `<script>
(function(){
  var KEY = 'data-vishrun-extimg';

  // Mirror of widget-iframe.ts:stripExternalImageSrc, applied here to
  // any runtime-passed HTML so the parser never sees a raw https src.
  // Short-circuits when the input has no "<img" substring — non-image
  // innerHTML assignments pay only an indexOf, no regex.
  function rewriteImgs(html) {
    if (typeof html !== 'string' || html.indexOf('<img') === -1) return html;
    return html.replace(/<img\\b[^>]*>/gi, function(tag) {
      return tag.replace(
        /(\\s)src\\s*=\\s*(['"])(https?:\\/\\/[^'"]+)\\2/i,
        '$1data-vishrun-extimg=$2$3$2'
      );
    });
  }

  // Patch HTMLImageElement.prototype.src setter — runtime-set https URLs
  // (img.src = "https://…") get diverted into the data attribute BEFORE
  // the browser starts fetching. Static src="https://..." has already
  // been stripped at host injection time; this catches the dynamic case.
  try {
    var desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    if (desc && desc.set && desc.get) {
      Object.defineProperty(HTMLImageElement.prototype, 'src', {
        configurable: true,
        enumerable: desc.enumerable,
        get: desc.get,
        set: function(val) {
          if (typeof val === 'string' && /^https?:\\/\\//i.test(val)) {
            this.setAttribute(KEY, val);
            return;
          }
          return desc.set.call(this, val);
        },
      });
    }
  } catch (e) { /* ignore — fallback path is the post-load scan */ }

  // Patch Element.prototype.innerHTML setter — \`el.innerHTML = html\`
  // routes through the HTML parser which fetches each <img src="…">
  // synchronously. Pre-rewriting before the setter delegates means the
  // parser never sees a raw https src.
  try {
    var innerDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
    if (innerDesc && innerDesc.set && innerDesc.get) {
      Object.defineProperty(Element.prototype, 'innerHTML', {
        configurable: true,
        enumerable: innerDesc.enumerable,
        get: innerDesc.get,
        set: function(val) {
          return innerDesc.set.call(this, rewriteImgs(val));
        },
      });
    }
  } catch (e) {}

  // Patch Element.prototype.outerHTML setter — same reasoning as
  // innerHTML; less common but cards do use it.
  try {
    var outerDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'outerHTML');
    if (outerDesc && outerDesc.set && outerDesc.get) {
      Object.defineProperty(Element.prototype, 'outerHTML', {
        configurable: true,
        enumerable: outerDesc.enumerable,
        get: outerDesc.get,
        set: function(val) {
          return outerDesc.set.call(this, rewriteImgs(val));
        },
      });
    }
  } catch (e) {}

  // Patch Element.prototype.insertAdjacentHTML — same story; the parser
  // is invoked on the second argument.
  try {
    var origIAH = Element.prototype.insertAdjacentHTML;
    if (typeof origIAH === 'function') {
      Element.prototype.insertAdjacentHTML = function(position, html) {
        return origIAH.call(this, position, rewriteImgs(html));
      };
    }
  } catch (e) {}

  // Patch Element.prototype.setAttribute — \`img.setAttribute('src', url)\`
  // doesn't go through HTMLImageElement.prototype.src's IDL setter, so
  // the existing patch above misses it. Catch the IMG/src/https case and
  // redirect to the data attribute. All other setAttribute calls fall
  // through to the original — the wrapper short-circuits in one
  // string-compare for the overwhelming majority of calls.
  try {
    var origSetAttr = Element.prototype.setAttribute;
    if (typeof origSetAttr === 'function') {
      Element.prototype.setAttribute = function(name, value) {
        if (
          this.tagName === 'IMG' &&
          typeof name === 'string' &&
          name.toLowerCase() === 'src' &&
          typeof value === 'string' &&
          /^https?:\\/\\//i.test(value)
        ) {
          return origSetAttr.call(this, KEY, value);
        }
        return origSetAttr.call(this, name, value);
      };
    }
  } catch (e) {}

  function setBlobSrc(img, blobUrl) {
    // Bypass the patched setter via the native descriptor — assigning
    // \`img.src = blobUrl\` would route through our wrapper again. Using
    // setAttribute avoids the IDL setter entirely.
    img.removeAttribute(KEY);
    img.setAttribute('src', blobUrl);
  }

  function processImg(img) {
    var url = img.getAttribute(KEY);
    if (!url) return;
    if (!window.spindleSandbox || typeof window.spindleSandbox.corsProxy !== 'function') {
      console.warn('[vishrun] corsProxy unavailable, leaving image unfetched:', url);
      return;
    }
    // Mark in-flight so a MutationObserver re-fire doesn't double-fetch.
    img.removeAttribute(KEY);
    img.setAttribute('data-vishrun-extimg-loading', '1');
    window.spindleSandbox.corsProxy(url, { responseType: 'arraybuffer' }).then(
      function(res) {
        try {
          // loader.ts:196-202 already converted base64 → Uint8Array on
          // the host side. Treat the body as bytes; constructing a
          // Blob from a Uint8Array preserves binary fidelity.
          if (!res || !res.body) {
            console.warn('[vishrun] corsProxy returned no body for', url);
            return;
          }
          var ct = '';
          if (res.headers) {
            ct = res.headers['content-type'] || res.headers['Content-Type'] || '';
          }
          ct = String(ct).split(';')[0].trim() || 'application/octet-stream';
          var blob = new Blob([res.body], { type: ct });
          var blobUrl = URL.createObjectURL(blob);
          setBlobSrc(img, blobUrl);
        } catch (e) {
          console.warn('[vishrun] corsProxy decode failed for', url, e);
        } finally {
          img.removeAttribute('data-vishrun-extimg-loading');
        }
      },
      function(err) {
        img.removeAttribute('data-vishrun-extimg-loading');
        console.warn('[vishrun] corsProxy fetch failed for', url, err);
      }
    );
  }

  function scan(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return;
    var imgs = root.querySelectorAll('img[' + KEY + ']');
    for (var i = 0; i < imgs.length; i++) processImg(imgs[i]);
  }

  // ─── CSS url() sentinels ──────────────────────────────────────────────
  //
  // Host pre-rewrites \`url(['"]?https?://X['"]?)\` in <style> blocks and
  // inline style="..." attributes to a sentinel data URL of the form
  // \`data:application/x-vishrun-cssproxy;base64,<base64-of-X>\`. This
  // resolver decodes each unique sentinel, fetches the original URL via
  // corsProxy, builds a Blob, and replaces every occurrence of the
  // sentinel in <style> textContent and [style] attributes with the new
  // blob: URL. Cards see only the static replaceString — same as imgs.
  var CSS_SENTINEL_PREFIX = 'data:application/x-vishrun-cssproxy;base64,';
  var CSS_SENTINEL_RE = /data:application\\/x-vishrun-cssproxy;base64,([A-Za-z0-9+/=]+)/g;
  // sentinel string -> blob URL once resolved, '__pending' while in flight,
  // empty string for terminal failures (skip retry).
  var cssBlobCache = {};

  function decodeCssSentinel(sentinel) {
    var idx = sentinel.indexOf(',');
    if (idx === -1) return null;
    try {
      return atob(sentinel.slice(idx + 1));
    } catch (e) {
      return null;
    }
  }

  function findCssSentinels() {
    var found = {};
    var styles = document.querySelectorAll('style');
    for (var i = 0; i < styles.length; i++) {
      var t = styles[i].textContent || '';
      if (t.indexOf(CSS_SENTINEL_PREFIX) === -1) continue;
      var m;
      CSS_SENTINEL_RE.lastIndex = 0;
      while ((m = CSS_SENTINEL_RE.exec(t)) !== null) found[m[0]] = true;
    }
    var styled = document.querySelectorAll('[style]');
    for (var i = 0; i < styled.length; i++) {
      var s = styled[i].getAttribute('style') || '';
      if (s.indexOf(CSS_SENTINEL_PREFIX) === -1) continue;
      var m2;
      CSS_SENTINEL_RE.lastIndex = 0;
      while ((m2 = CSS_SENTINEL_RE.exec(s)) !== null) found[m2[0]] = true;
    }
    return Object.keys(found);
  }

  function replaceCssSentinel(sentinel, blobUrl) {
    var styles = document.querySelectorAll('style');
    for (var i = 0; i < styles.length; i++) {
      var t = styles[i].textContent || '';
      if (t.indexOf(sentinel) === -1) continue;
      // textContent reassign re-parses the stylesheet, picking up the
      // blob URL on the next style recompute. Cards in scope don't hold
      // CSSOM rule references, so this is safe.
      styles[i].textContent = t.split(sentinel).join(blobUrl);
    }
    var styled = document.querySelectorAll('[style]');
    for (var i = 0; i < styled.length; i++) {
      var s = styled[i].getAttribute('style') || '';
      if (s.indexOf(sentinel) === -1) continue;
      styled[i].setAttribute('style', s.split(sentinel).join(blobUrl));
    }
  }

  function processCssSentinels() {
    if (!window.spindleSandbox || typeof window.spindleSandbox.corsProxy !== 'function') return;
    var sentinels = findCssSentinels();
    for (var i = 0; i < sentinels.length; i++) {
      var sentinel = sentinels[i];
      var cached = cssBlobCache[sentinel];
      if (cached === '__pending' || (typeof cached === 'string' && cached.length > 0)) continue;
      if (cached === '') continue; // prior failure, don't retry
      var url = decodeCssSentinel(sentinel);
      if (!url) {
        cssBlobCache[sentinel] = '';
        continue;
      }
      cssBlobCache[sentinel] = '__pending';
      (function(snt, u) {
        window.spindleSandbox.corsProxy(u, { responseType: 'arraybuffer' }).then(
          function(res) {
            try {
              if (!res || !res.body) {
                console.warn('[vishrun] css corsProxy returned no body for', u);
                cssBlobCache[snt] = '';
                return;
              }
              var ct = '';
              if (res.headers) {
                ct = res.headers['content-type'] || res.headers['Content-Type'] || '';
              }
              ct = String(ct).split(';')[0].trim() || 'application/octet-stream';
              var blob = new Blob([res.body], { type: ct });
              var blobUrl = URL.createObjectURL(blob);
              cssBlobCache[snt] = blobUrl;
              replaceCssSentinel(snt, blobUrl);
            } catch (e) {
              console.warn('[vishrun] css decode failed for', u, e);
              cssBlobCache[snt] = '';
            }
          },
          function(err) {
            console.warn('[vishrun] css corsProxy fetch failed for', u, err);
            cssBlobCache[snt] = '';
          }
        );
      })(sentinel, url);
    }
  }

  function init() {
    scan(document);
    processCssSentinels();
    try {
      var mo = new MutationObserver(function(mutations) {
        for (var i = 0; i < mutations.length; i++) {
          var mut = mutations[i];
          if (mut.type === 'attributes' && mut.attributeName === KEY) {
            if (mut.target && mut.target.nodeType === 1 && mut.target.tagName === 'IMG') {
              processImg(mut.target);
            }
            continue;
          }
          var added = mut.addedNodes;
          if (!added) continue;
          for (var j = 0; j < added.length; j++) {
            var n = added[j];
            if (n.nodeType !== 1) continue;
            if (n.tagName === 'IMG' && n.hasAttribute(KEY)) processImg(n);
            else scan(n);
          }
        }
      });
      mo.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [KEY],
      });
    } catch (e) { /* ignore */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
</script>`;
}
function injectIntoHead(html, blob) {
  const openHead = html.match(/<head\b[^>]*>/i);
  if (openHead && openHead.index !== undefined) {
    const idx = openHead.index + openHead[0].length;
    return html.slice(0, idx) + blob + html.slice(idx);
  }
  return blob + html;
}
function sizeReporterShell() {
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
function routeChildMessage(frame, payload, ctx) {
  if (!payload || typeof payload !== "object")
    return;
  const p = payload;
  if (p.kind === "set-chat-messages") {
    handleSetChatMessages(frame.element, p.payload, ctx);
  } else if (p.kind === "clipboard-write-text") {
    handleClipboardWriteText(p.payload);
  } else if (p.kind === "alert") {
    handleHostAlert(p.payload);
  }
}
async function handleClipboardWriteText(payload) {
  const text = payload && typeof payload === "object" ? payload.text : undefined;
  if (typeof text !== "string")
    return;
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    console.warn("[vishrun] clipboard writeText failed:", e);
  }
}
function handleHostAlert(payload) {
  const message = payload && typeof payload === "object" ? payload.message : undefined;
  try {
    window.alert(typeof message === "string" ? message : String(message));
  } catch (e) {
    console.warn("[vishrun] alert failed:", e);
  }
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
function rebuildCapturesFromContent(messageId, content, compiled) {
  const newList = [];
  for (const script of compiled) {
    if (script.kind !== "pairedTag")
      continue;
    script.findRe.lastIndex = 0;
    let lastMatch = null;
    let m;
    while ((m = script.findRe.exec(content)) !== null) {
      lastMatch = m;
      if (m[0].length === 0)
        script.findRe.lastIndex++;
    }
    if (!lastMatch)
      continue;
    newList.push({
      scriptId: script.id,
      scriptName: script.scriptName,
      replaceString: script.replaceString,
      findRe: script.findRe,
      fullMatch: lastMatch[0],
      attrs: {}
    });
  }
  const existing = capturesByMessage.get(messageId) || [];
  let changed = existing.length !== newList.length;
  if (!changed) {
    for (const next of newList) {
      const prev = existing.find((c) => c.scriptId === next.scriptId);
      if (!prev || prev.fullMatch !== next.fullMatch) {
        changed = true;
        break;
      }
    }
  }
  if (changed) {
    if (newList.length === 0) {
      capturesByMessage.delete(messageId);
    } else {
      capturesByMessage.set(messageId, newList);
    }
  }
  return changed;
}
function onCapture(payload, script) {
  if (!payload.messageId)
    return;
  const existing = capturesByMessage.get(payload.messageId) || [];
  const list = existing.filter((c) => c.scriptId !== script.id);
  list.push({
    scriptId: script.id,
    scriptName: script.scriptName,
    replaceString: script.replaceString,
    findRe: script.findRe,
    fullMatch: payload.fullMatch,
    attrs: payload.attrs
  });
  capturesByMessage.set(payload.messageId, list);
}
function extractTagName(reSource) {
  const m = reSource.match(/^<(?:\\s\*|\s)*([a-zA-Z_][a-zA-Z0-9_-]*)/);
  return m ? m[1] : null;
}

// src/render/inject-into-message.ts
async function processNode(root, scripts, ctx) {
  const messageId = root.getAttribute("data-message-id") || undefined;
  if (!messageId) {
    return 0;
  }
  const target = findContentRoot(root);
  cleanupOrphansForMessage(messageId, target);
  let total = 0;
  try {
    for (const script of scripts) {
      if (script.kind !== "placeholder")
        continue;
      total += await replacePlaceholderMatches(root, script, messageId, ctx);
    }
    total += await renderPairedTagCaptures(root, messageId, ctx);
  } catch (err) {
    console.debug("[vishrun] processNode render error:", err);
  }
  return total;
}
async function replacePlaceholderMatches(root, script, messageId, ctx) {
  const textNodes = collectTextNodes(root);
  let count = 0;
  let hasFreshMatch = false;
  for (const tn of textNodes) {
    const text = tn.nodeValue ?? "";
    if (!text)
      continue;
    script.findRe.lastIndex = 0;
    if (script.findRe.test(text)) {
      hasFreshMatch = true;
      break;
    }
  }
  if (hasFreshMatch && hasRegisteredWidgetsFor(messageId, script.id)) {
    destroyRegisteredWidgetsFor(messageId, script.id);
  }
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
    if (!parent || !parent.isConnected)
      continue;
    const frag = document.createDocumentFragment();
    let cursor = 0;
    for (const { start, end, match } of ranges) {
      if (start > cursor) {
        frag.appendChild(document.createTextNode(text.slice(cursor, start)));
      }
      const groups = match.slice(1).map((g) => g ?? "");
      const html = substitute(script.replaceString, match[0], groups);
      const widget = await buildWidget(html, script.scriptName, script.id, messageId, ctx);
      frag.appendChild(widget);
      cursor = end;
      count++;
    }
    if (cursor < text.length) {
      frag.appendChild(document.createTextNode(text.slice(cursor)));
    }
    if (tn.parentNode === parent && parent.isConnected) {
      parent.replaceChild(frag, tn);
    } else {
      frag.querySelectorAll("iframe[data-vishrun-widget]").forEach((el) => destroyWidgetIframe(el));
      count -= ranges.length;
    }
  }
  return count;
}
async function renderPairedTagCaptures(root, messageId, ctx) {
  const captures = getCapturesForMessage(messageId);
  const target = findContentRoot(root);
  let added = 0;
  let removed = 0;
  const existingPaired = target.querySelectorAll("[data-vishrun-widget][data-vishrun-paired-fullmatch]");
  existingPaired.forEach((el) => {
    const sid = el.getAttribute("data-vishrun-script-id");
    const fmHash = el.getAttribute("data-vishrun-paired-fullmatch");
    const stillValid = captures.some((c) => c.scriptId === sid && hashKey(c.fullMatch) === fmHash);
    if (!stillValid) {
      if (el.tagName === "IFRAME") {
        destroyWidgetIframe(el);
      } else {
        el.remove();
      }
      removed++;
    }
  });
  for (const cap of captures) {
    const sel = `[data-vishrun-widget][data-vishrun-script-id="${cssEscape(cap.scriptId)}"][data-vishrun-paired-fullmatch="${cssEscape(hashKey(cap.fullMatch))}"]`;
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
      if (target.isConnected) {
        target.appendChild(failed);
        added++;
      }
      continue;
    }
    const groups = m.slice(1).map((g) => g ?? "");
    const html = substitute(cap.replaceString, m[0], groups);
    const iframe = await buildWidgetIframe(html, cap.scriptName, cap.scriptId, messageId, ctx);
    iframe.setAttribute("data-vishrun-paired-fullmatch", hashKey(cap.fullMatch));
    if (!target.isConnected || target.querySelector(sel)) {
      destroyWidgetIframe(iframe);
      continue;
    }
    target.appendChild(iframe);
    added++;
  }
  return added;
}
function findContentRoot(messageNode) {
  const inner = messageNode.querySelector('[data-component="MessageContent"]');
  return inner ?? messageNode;
}
async function buildWidget(html, scriptName, scriptId, messageId, ctx) {
  if (widgetNeedsIsolation(html)) {
    return buildWidgetIframe(html, scriptName, scriptId, messageId, ctx);
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
function cssEscape(s) {
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
  function processMessageById(messageId, retriesLeft = MAX_RAF_RETRIES) {
    const compiled = compiledForActiveCard();
    if (!compiled)
      return;
    const sel = buildMessageSelector(messageId);
    const node = document.querySelector(sel);
    if (node) {
      processNode(node, compiled, ctx);
      return;
    }
    if (retriesLeft > 0) {
      requestAnimationFrame(() => processMessageById(messageId, retriesLeft - 1));
    }
  }
  function scanAllNow(compiled) {
    const nodes = document.querySelectorAll("[data-message-id]");
    nodes.forEach((n) => {
      processNode(n, compiled, ctx);
    });
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
    processMessageById,
    compiledForActiveCard,
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
function setup(ctx) {
  const hooks = installMessageHooks(ctx);
  let inflightCharacterId = null;
  let lastLoadedCharacterId = null;
  async function loadFor(characterId) {
    if (!characterId) {
      clearActiveCard();
      lastLoadedCharacterId = null;
      hooks.rescanAll();
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
        hooks.rescanAll();
        return;
      }
      const firstMes = typeof char.first_mes === "string" ? char.first_mes : null;
      const alternateGreetings = Array.isArray(char.alternate_greetings) ? char.alternate_greetings.filter((g) => typeof g === "string") : [];
      setActiveCard({ characterId, characterName: name, scripts, firstMes, alternateGreetings });
      lastLoadedCharacterId = characterId;
      hooks.rescanAll();
    } catch (err) {
      console.debug("[vishrun] fetchCharacter failed:", err);
    } finally {
      if (inflightCharacterId === characterId)
        inflightCharacterId = null;
    }
  }
  const unsubChatChanged = ctx.events.on("CHAT_CHANGED", (payload) => {
    const p = payload || {};
    loadFor(p.characterId ?? ctx.getActiveChat().characterId ?? null);
  });
  function handleMessageMutation(payload) {
    const p = payload || {};
    const msg = p.message;
    if (!msg || typeof msg.id !== "string" || typeof msg.content !== "string")
      return;
    const active2 = ctx.getActiveChat();
    if (active2.chatId && p.chatId && active2.chatId !== p.chatId)
      return;
    const compiled = hooks.compiledForActiveCard();
    if (!compiled)
      return;
    const changed = rebuildCapturesFromContent(msg.id, msg.content, compiled);
    if (changed) {
      hooks.processMessageById(msg.id);
    }
  }
  const unsubMessageSwiped = ctx.events.on("MESSAGE_SWIPED", handleMessageMutation);
  const unsubMessageEdited = ctx.events.on("MESSAGE_EDITED", handleMessageMutation);
  const unsubSettingsUpdated = ctx.events.on("SETTINGS_UPDATED", (payload) => {
    const p = payload || {};
    if (p.key !== "activeChatId" && p.key !== "activeCharacterId")
      return;
    loadFor(ctx.getActiveChat().characterId ?? null);
  });
  const active = ctx.getActiveChat();
  if (active.characterId) {
    loadFor(active.characterId);
  }
  return () => {
    unsubChatChanged();
    unsubSettingsUpdated();
    unsubMessageSwiped();
    unsubMessageEdited();
    hooks.dispose();
    ctx.dom.cleanup();
    clearActiveCard();
  };
}
export {
  setup
};
