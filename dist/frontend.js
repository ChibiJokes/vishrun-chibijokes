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
function isPlaceholderLikeKind(kind) {
  return kind === "placeholder" || kind === "delimitedCapture" || kind === "delimitedCaptureMultiLine";
}
function isMultiLineRegex(re) {
  const src = re.source;
  if (src.includes("[\\s\\S]"))
    return true;
  if (src.includes("\\n"))
    return true;
  if (re.flags.includes("m") && (src.includes("^") || src.includes("$")))
    return true;
  return false;
}
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
  const stripped = src.replace(/\\s\*/g, "").replace(/\\\//g, "/");
  const open = stripped.match(/^\s*<\s*([a-zA-Z_][a-zA-Z0-9_-]*)/);
  if (!open)
    return false;
  const tagName = open[1];
  const closeRe = new RegExp(`</\\s*${escapeRegex(tagName)}\\s*>`);
  return closeRe.test(stripped);
}
var DELIM_PAIRS = [
  ["【", "】"],
  ["「", "」"],
  ["《", "》"],
  ["『", "』"],
  ["↦", "↤"]
];
function hasRealCapture(src) {
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
        i += src[i] === "\\" ? 2 : 1;
      }
      i++;
      continue;
    }
    if (ch === "(") {
      const a = src.slice(i + 1, i + 3);
      const grouping = a === "?:" || a === "?=" || a === "?!" || a[0] === "?" && a[1] === "<";
      if (!grouping)
        return true;
    }
    i++;
  }
  return false;
}
function textualMarkerName(src, kw) {
  const i = src.indexOf(kw);
  if (i < 0)
    return null;
  const rest = src.slice(i + kw.length);
  const end = rest.search(/\\?\]/);
  if (end < 0)
    return null;
  const name = rest.slice(0, end).replace(/\\s[*+]?/g, "").replace(/\\/g, "").replace(/\s+/g, " ").trim();
  return name || null;
}
function isDelimitedCapture(re) {
  const src = re.source;
  if (!hasRealCapture(src))
    return false;
  const head = src.replace(/^(?:\\s[*+]?|\s)+/, "");
  if (/^<[a-zA-Z_]/.test(head))
    return false;
  for (const [open, close] of DELIM_PAIRS) {
    const oi = src.indexOf(open);
    if (oi >= 0 && src.indexOf(close, oi + open.length) >= 0)
      return true;
  }
  const n1 = textualMarkerName(src, "START OF");
  const n2 = textualMarkerName(src, "END OF");
  return !!n1 && n1 === n2;
}
function classifyTrigger(re) {
  if (isPairedTag(re))
    return "pairedTag";
  if (isPlaceholder(re))
    return "placeholder";
  if (isDelimitedCapture(re))
    return isMultiLineRegex(re) ? "delimitedCaptureMultiLine" : "delimitedCapture";
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
      console.debug(`[vishrun] script "${s.scriptName ?? "(unnamed)"}" has unrecognized trigger shape ` + `(not placeholder, paired-tag, nor delimited-capture) — will not render. findRegex: ${src}`);
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

// src/core/substitute.ts
function substitute(template, fullMatch, groups) {
  let out = "";
  let i = 0;
  while (i < template.length) {
    const ch = template[i];
    if (ch === "{" && template.slice(i, i + 9).toLowerCase() === "{{match}}") {
      out += fullMatch;
      i += 9;
      continue;
    }
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

// src/core/nested-pipeline.ts
var MAX_RECURSION = 5;
function applyNestedPipeline(html, allScripts, processing = new Set, depth = 0) {
  if (depth >= MAX_RECURSION) {
    console.warn(`[vishrun] nested pipeline hit MAX_RECURSION (${MAX_RECURSION}); deeper tags left unsubstituted`);
    return html;
  }
  let out = html;
  for (const script of allScripts) {
    if (script.kind === "unknown")
      continue;
    if (processing.has(script.id))
      continue;
    out = expand(out, script, allScripts, processing, depth);
  }
  return out;
}
function expand(html, script, allScripts, processing, depth) {
  script.findRe.lastIndex = 0;
  let m = script.findRe.exec(html);
  if (m === null)
    return html;
  const nextProcessing = new Set(processing).add(script.id);
  let out = "";
  let cursor = 0;
  while (m !== null) {
    out += html.slice(cursor, m.index);
    const groups = m.slice(1).map((g) => g ?? "");
    const substituted = substitute(script.replaceString, m[0], groups);
    out += applyNestedPipeline(substituted, allScripts, nextProcessing, depth + 1);
    cursor = m.index + m[0].length;
    if (m[0].length === 0)
      script.findRe.lastIndex++;
    m = script.findRe.exec(html);
  }
  out += html.slice(cursor);
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

// src/core/font-proxy.ts
var FONT_LINK_RE = /<link\b[^>]*\bhref\s*=\s*["'](https?:\/\/fonts\.googleapis\.com\/[^"']+)["'][^>]*>/gi;
var FONT_STYLE_BLOCK_RE = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
var FONT_IMPORT_RE = /@import\s+url\(\s*(['"]?)(https?:\/\/fonts\.googleapis\.com\/[^'")\s]+)\1\s*\)\s*;?/gi;
var FONT_FACE_BLOCK_RE = /@font-face\s*\{([^}]+)\}/gi;
var FONT_FACE_URL_RE = /src\s*:[^;]*url\(\s*['"]?(https?:\/\/[^'")\s]+)['"]?\s*\)/i;
var FONT_FACE_FAMILY_RE = /font-family\s*:\s*['"]?([^;'"]+?)['"]?\s*;/i;
var FONT_FACE_WEIGHT_RE = /font-weight\s*:\s*([^;]+?)\s*;/i;
var FONT_FACE_STYLE_RE = /font-style\s*:\s*([^;]+?)\s*;/i;
var FONT_FACE_DISPLAY_RE = /font-display\s*:\s*([^;]+?)\s*;/i;
var fontEntriesCache = new Map;
function parseFontFaceRules(css) {
  if (css.indexOf("@font-face") === -1)
    return [];
  const out = [];
  FONT_FACE_BLOCK_RE.lastIndex = 0;
  let m;
  while ((m = FONT_FACE_BLOCK_RE.exec(css)) !== null) {
    const body = m[1];
    const urlMatch = body.match(FONT_FACE_URL_RE);
    const familyMatch = body.match(FONT_FACE_FAMILY_RE);
    if (!urlMatch || !familyMatch)
      continue;
    const entry = {
      family: familyMatch[1].trim(),
      url: urlMatch[1]
    };
    const w = body.match(FONT_FACE_WEIGHT_RE);
    const s = body.match(FONT_FACE_STYLE_RE);
    const d = body.match(FONT_FACE_DISPLAY_RE);
    if (w)
      entry.weight = w[1].trim();
    if (s)
      entry.style = s[1].trim();
    if (d)
      entry.display = d[1].trim();
    out.push(entry);
  }
  return out;
}
function extractGoogleFontsLinks(html) {
  if (html.indexOf("fonts.googleapis.com") === -1)
    return [];
  const out = [];
  const seen = new Set;
  FONT_LINK_RE.lastIndex = 0;
  let m;
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
function extractGoogleFontsImports(html) {
  if (html.indexOf("fonts.googleapis.com") === -1)
    return [];
  if (html.indexOf("@import") === -1)
    return [];
  const out = [];
  const seenBlocks = new Set;
  FONT_STYLE_BLOCK_RE.lastIndex = 0;
  let m;
  while ((m = FONT_STYLE_BLOCK_RE.exec(html)) !== null) {
    const fullStyleBlock = m[0];
    const cssContent = m[1];
    if (cssContent.indexOf("@import") === -1)
      continue;
    if (cssContent.indexOf("fonts.googleapis.com") === -1)
      continue;
    if (seenBlocks.has(fullStyleBlock))
      continue;
    seenBlocks.add(fullStyleBlock);
    const imports = [];
    FONT_IMPORT_RE.lastIndex = 0;
    let im;
    while ((im = FONT_IMPORT_RE.exec(cssContent)) !== null) {
      imports.push({ raw: im[0], url: im[2] });
    }
    if (imports.length > 0)
      out.push({ fullStyleBlock, imports });
  }
  return out;
}
function decodeHtmlEntities(s) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
function getFontEntries(url, ctx) {
  const cached = fontEntriesCache.get(url);
  if (cached)
    return cached;
  const pending = (async () => {
    const raw = await fetchViaBackend(url, ctx);
    return parseFontFaceRules(raw);
  })();
  fontEntriesCache.set(url, pending);
  pending.catch(() => {
    if (fontEntriesCache.get(url) === pending)
      fontEntriesCache.delete(url);
  });
  return pending;
}
function htmlSafeJsonStringify(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
function buildFontConfigScript(entries) {
  return `<script type="application/vishrun-font-config" data-vishrun-fonts>${htmlSafeJsonStringify(entries)}</script>`;
}
async function transformHtmlForGoogleFonts(html, ctx) {
  const links = extractGoogleFontsLinks(html);
  const importBlocks = extractGoogleFontsImports(html);
  if (links.length === 0 && importBlocks.length === 0)
    return html;
  const allUrls = new Set;
  for (const l of links)
    allUrls.add(l.url);
  for (const ib of importBlocks)
    for (const im of ib.imports)
      allUrls.add(im.url);
  const entriesByUrl = new Map;
  const failed = new Set;
  await Promise.all(Array.from(allUrls).map(async (u) => {
    try {
      entriesByUrl.set(u, await getFontEntries(u, ctx));
    } catch (err) {
      failed.add(u);
      console.warn("[vishrun] Google Fonts fetch failed:", u, err instanceof Error ? err.message : String(err));
    }
  }));
  let out = html;
  for (const l of links) {
    if (failed.has(l.url))
      continue;
    const entries = entriesByUrl.get(l.url) ?? [];
    const replacement = entries.length === 0 ? "" : buildFontConfigScript(entries);
    out = out.split(l.fullTag).join(replacement);
  }
  for (const ib of importBlocks) {
    let stripped = ib.fullStyleBlock;
    const scripts = [];
    for (const imp of ib.imports) {
      if (failed.has(imp.url))
        continue;
      stripped = stripped.split(imp.raw).join("");
      const entries = entriesByUrl.get(imp.url) ?? [];
      if (entries.length > 0)
        scripts.push(buildFontConfigScript(entries));
    }
    if (stripped === ib.fullStyleBlock && scripts.length === 0)
      continue;
    out = out.split(ib.fullStyleBlock).join(scripts.join("") + stripped);
  }
  return out;
}

// src/core/dispatch-slash.ts
function isDispatchSlashResponse(p, requestId) {
  if (!p || typeof p !== "object")
    return false;
  const r = p;
  return r.type === "dispatch_slash_text_response" && r.requestId === requestId && typeof r.handled === "boolean" && typeof r.kind === "string";
}
var requestCounter2 = 0;
function nextRequestId2() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `vishrun-ds-${Date.now()}-${++requestCounter2}`;
}
var DISPATCH_TIMEOUT_MS = 5000;
function dispatchSlashViaBackend(ctx, chatId, text, timeoutMs = DISPATCH_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const requestId = nextRequestId2();
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
      if (!isDispatchSlashResponse(payload, requestId))
        return;
      finish(() => resolve({ handled: payload.handled, kind: payload.kind, error: payload.error }));
    });
    timer = setTimeout(() => {
      finish(() => reject(new Error("dispatch_slash_text timeout")));
    }, timeoutMs);
    try {
      ctx.sendToBackend({ type: "dispatch_slash_text", requestId, text, chatId });
    } catch (err) {
      finish(() => reject(err instanceof Error ? err : new Error(String(err))));
    }
  });
}

// src/render/clipboard-shim.ts
var DISPATCH_PREFIX_RE = /^\s*\/(setvar|setchatvar|setgvar|setglobalvar|sys)\b/i;
var DISPATCH_CORRELATION_WINDOW_MS = 1000;
var DISPATCH_CLEANUP_INTERVAL_MS = 2000;
var recentlyDispatched = new Map;
var cleanupTimer = null;
function ensureCleanupTimer() {
  if (cleanupTimer !== null)
    return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [text, ts] of recentlyDispatched) {
      if (now - ts > DISPATCH_CLEANUP_INTERVAL_MS)
        recentlyDispatched.delete(text);
    }
  }, DISPATCH_CLEANUP_INTERVAL_MS);
}
async function handleClipboardWriteText(payload, ctx, deps = {}) {
  const text = payload && typeof payload === "object" ? payload.text : undefined;
  if (typeof text !== "string")
    return;
  const dispatched = deps.recentlyDispatched ?? recentlyDispatched;
  const now = deps.now ?? Date.now;
  if (DISPATCH_PREFIX_RE.test(text)) {
    const chatId = ctx.getActiveChat().chatId;
    if (!chatId) {
      console.warn("[vishrun] dispatch_slash_text: no active chatId, falling back to clipboard");
    } else {
      if (!deps.recentlyDispatched)
        ensureCleanupTimer();
      dispatched.set(text, now());
      try {
        const dispatch = deps.dispatch ?? dispatchSlashViaBackend;
        const result = await dispatch(ctx, chatId, text);
        if (result.handled) {
          dispatched.set(text, now());
          return;
        }
        dispatched.delete(text);
      } catch (e) {
        console.warn("[vishrun] dispatch_slash_text failed, falling back to clipboard:", e instanceof Error ? e.message : String(e));
        dispatched.delete(text);
      }
    }
  }
  const writeText = deps.clipboardWriteText ?? (typeof navigator !== "undefined" && navigator.clipboard ? navigator.clipboard.writeText.bind(navigator.clipboard) : null);
  if (!writeText)
    return;
  try {
    await writeText(text);
  } catch (e) {
    console.warn("[vishrun] clipboard writeText failed:", e);
  }
}
function handleHostAlert(payload, deps = {}) {
  const message = payload && typeof payload === "object" ? payload.message : undefined;
  if (typeof message !== "string")
    return;
  const dispatched = deps.recentlyDispatched ?? recentlyDispatched;
  const now = deps.now ?? Date.now;
  const tNow = now();
  for (const ts of dispatched.values()) {
    if (tNow - ts < DISPATCH_CORRELATION_WINDOW_MS)
      return;
  }
  const alertFn = deps.alert ?? (typeof window !== "undefined" && typeof window.alert === "function" ? window.alert.bind(window) : null);
  if (!alertFn)
    return;
  try {
    alertFn(message);
  } catch (e) {
    console.warn("[vishrun] alert failed:", e);
  }
}

// src/core/widget-environment.ts
var SCRIPT_BODY_RE = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
var MVU_TOKENS = [
  /\bMvu\b/,
  /\bstat_data\b/,
  /\ball_variables\b/,
  /\bwaitGlobalInitialized\s*\(/,
  /\bgetAllVariables\s*\(/,
  /\berrorCatched\s*\(/,
  /\beventOn(?:ce)?\s*\(/,
  /\beventEmit\s*\(/
];
var LODASH_TOKEN = /(?:^|[^a-zA-Z_$.\w])_\s*\.[a-zA-Z]/;
var JQUERY_TOKEN = /(?:^|[^a-zA-Z_$.\w])\$\s*\(/;
var JQUERY_NAMED_TOKEN = /\bjQuery\s*[(.]/;
var HELPERS_LIGHT_TOKENS = [
  /\bgetChatMessages\s*\(/,
  /\bsetChatMessage\s*\(/,
  /\bgetCurrentMessageId\s*\(/,
  /\bgetChatId\s*\(/
];
var SLASH_TOKEN = /\btriggerSlash\s*\(/;
function extractScriptBodies(html) {
  if (!html)
    return "";
  let combined = "";
  SCRIPT_BODY_RE.lastIndex = 0;
  let m;
  while ((m = SCRIPT_BODY_RE.exec(html)) !== null) {
    combined += m[1] + `
`;
  }
  return combined;
}
var cache = new WeakMap;
var stringCache = new Map;
var STRING_CACHE_MAX = 256;
function classifyWidgetEnvironment(html) {
  if (!html)
    return "static";
  const cached = stringCache.get(html);
  if (cached !== undefined)
    return cached;
  const result = classifyImpl(html);
  if (stringCache.size >= STRING_CACHE_MAX)
    stringCache.clear();
  stringCache.set(html, result);
  return result;
}
function classifyImpl(html) {
  const body = extractScriptBodies(html);
  if (!body)
    return "static";
  const hasMvu = MVU_TOKENS.some((re) => re.test(body));
  const hasLodash = LODASH_TOKEN.test(body);
  if (hasMvu || hasLodash)
    return "tavern-mvu";
  const hasJq = JQUERY_TOKEN.test(body) || JQUERY_NAMED_TOKEN.test(body);
  if (hasJq)
    return "tavern-jq";
  const hasSlash = SLASH_TOKEN.test(body);
  if (hasSlash)
    return "tavern-slash";
  const hasHelpers = HELPERS_LIGHT_TOKENS.some((re) => re.test(body));
  if (hasHelpers)
    return "tavern-helpers-light";
  return "static";
}
function shouldInjectThHelpersShim(env) {
  return env === "tavern-helpers-light" || env === "tavern-jq" || env === "tavern-mvu";
}

// src/render/th-helpers-shim.ts
function thHelpersShim(consts) {
  const constsJson = JSON.stringify({
    currentMessageIndex: consts.currentMessageIndex,
    currentMessageId: consts.currentMessageId,
    chatId: consts.chatId
  });
  return `<script>(function(){
var THC = ${constsJson};
var pending = {};
var nextId = 0;
function makeRequestId(){ nextId = (nextId + 1) | 0; return 'th-' + Date.now().toString(36) + '-' + nextId.toString(36); }
function setup(){
  if (!window.spindleSandbox || typeof window.spindleSandbox.onMessage !== 'function') return;
  window.spindleSandbox.onMessage(function(payload){
    if (!payload || typeof payload !== 'object') return;
    if (payload.kind !== 'th-response') return;
    var rid = payload.requestId;
    var slot = pending[rid];
    if (!slot) return;
    delete pending[rid];
    if (payload.ok) slot.resolve(payload.result);
    else slot.reject(new Error(String(payload.error || 'th-helpers backend error')));
  });
}
setup();
function postRequest(kind, body){
  return new Promise(function(resolve, reject){
    if (!window.spindleSandbox || typeof window.spindleSandbox.postMessage !== 'function') {
      reject(new Error('spindleSandbox.postMessage unavailable'));
      return;
    }
    var rid = makeRequestId();
    pending[rid] = { resolve: resolve, reject: reject };
    try {
      window.spindleSandbox.postMessage({ kind: 'th-request', requestId: rid, op: kind, body: body });
    } catch (e) {
      delete pending[rid];
      reject(e);
    }
  });
}
window.getCurrentMessageId = function(){ return THC.currentMessageIndex; };
window.getChatId = function(){ return THC.chatId; };
window.getChatMessages = function(range, opts){
  return postRequest('th-get-chat-messages', { range: range, opts: opts || {} });
};
window.setChatMessage = function(fieldValues, messageId, opts){
  var normalized = (typeof fieldValues === 'string') ? { message: fieldValues } : fieldValues;
  return postRequest('th-set-chat-message', { fieldValues: normalized, messageId: messageId, opts: opts || {} });
};
})();</script>`;
}

// src/render/th-helpers-bridge.ts
var TH_TIMEOUT_MS = 5000;
function isThHelpersResponse(p, requestId) {
  if (!p || typeof p !== "object")
    return false;
  const r = p;
  return r.type === "th_helpers_response" && r.requestId === requestId && typeof r.ok === "boolean";
}
function isThRequest(p) {
  if (!p || typeof p !== "object")
    return false;
  const r = p;
  return r.kind === "th-request" && typeof r.requestId === "string" && typeof r.op === "string" && !!r.body && typeof r.body === "object";
}
function dispatchThRequest(frame, request, context, ctx) {
  const { requestId, op, body } = request;
  let settled = false;
  let unsub = null;
  let timer = null;
  const respond = (resp) => {
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
    try {
      frame.postMessage({ kind: "th-response", requestId, ok: resp.ok, result: resp.result, error: resp.error });
    } catch {}
  };
  unsub = ctx.onBackendMessage((payload) => {
    if (!isThHelpersResponse(payload, requestId))
      return;
    respond({ ok: payload.ok, result: payload.result, error: payload.error });
  });
  timer = setTimeout(() => {
    respond({ ok: false, error: "th-helpers backend timeout" });
  }, TH_TIMEOUT_MS);
  try {
    ctx.sendToBackend({
      type: "th_helpers_request",
      requestId,
      op,
      chatId: context.chatId,
      currentMessageId: context.currentMessageId,
      currentMessageIndex: context.currentMessageIndex,
      body
    });
  } catch (err) {
    respond({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
function computeMessageIndexInChat(messageId, doc = document) {
  const all = doc.querySelectorAll("[data-message-id]");
  for (let i = 0;i < all.length; i++) {
    if (all[i].getAttribute("data-message-id") === messageId)
      return i;
  }
  return -1;
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
  const env = classifyWidgetEnvironment(html);
  const active = ctx.getActiveChat();
  const chatId = active.chatId ?? "";
  const currentMessageIndex = computeMessageIndexInChat(messageId);
  const srcdoc = await injectShimsAndSizeReporter(html, ctx, {
    env,
    chatId,
    messageId,
    currentMessageIndex
  });
  const frame = ctx.dom.createSandboxFrame({
    html: srcdoc,
    autoResize: false,
    minHeight: 1,
    maxHeight: 4000,
    initialHeight: 1
  });
  frame.onMessage((payload) => {
    routeChildMessage(frame, payload, ctx, { chatId, messageId, currentMessageIndex });
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
async function injectShimsAndSizeReporter(html, ctx, iframeCtx) {
  const withExternalScripts = await transformHtmlForExternalScripts(html, ctx);
  const withFonts = await transformHtmlForGoogleFonts(withExternalScripts, ctx);
  const stripped = rewriteCssExternalUrls(stripExternalImageSrc(withFonts));
  const head = buildHeadInjection(iframeCtx);
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
function buildHeadInjection(iframeCtx) {
  const thHelpers = shouldInjectThHelpersShim(iframeCtx.env) ? thHelpersShim({
    currentMessageIndex: iframeCtx.currentMessageIndex,
    currentMessageId: iframeCtx.messageId,
    chatId: iframeCtx.chatId
  }) : "";
  return viewportHeightShim() + setChatMessagesShim() + clipboardAlertShim() + externalImageProxyHelper() + fontFaceHelper() + thHelpers;
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
function fontFaceHelper() {
  return `<script>
(function(){
  var loadedFontUrls = {};

  function loadOneVishrunFont(entry) {
    if (!window.spindleSandbox || typeof window.spindleSandbox.fetchFont !== 'function') return;
    if (!entry || !entry.url || !entry.family) return;
    if (typeof FontFace === 'undefined' || !document.fonts || typeof document.fonts.add !== 'function') return;
    var key = entry.url;
    if (loadedFontUrls[key]) return;
    loadedFontUrls[key] = true;
    window.spindleSandbox.fetchFont(entry.url).then(function(resource) {
      if (!resource || !resource.url) {
        loadedFontUrls[key] = false;
        return;
      }
      try {
        var face = new FontFace(entry.family, 'url(' + resource.url + ')', {
          weight: entry.weight || '400',
          style: entry.style || 'normal',
          display: entry.display || 'swap'
        });
        return face.load().then(function() { document.fonts.add(face); });
      } catch (e) {
        loadedFontUrls[key] = false;
        console.warn('[vishrun] FontFace construct failed for', entry.url, e);
      }
    }).catch(function(err) {
      loadedFontUrls[key] = false;
      console.warn('[vishrun] fetchFont failed for', entry.url, err);
    });
  }

  function processVishrunFonts() {
    var scripts = document.querySelectorAll('script[data-vishrun-fonts]');
    for (var s = 0; s < scripts.length; s++) {
      var entries;
      try { entries = JSON.parse(scripts[s].textContent || '[]'); }
      catch (e) { continue; }
      if (!entries || typeof entries.length !== 'number') continue;
      for (var i = 0; i < entries.length; i++) loadOneVishrunFont(entries[i]);
    }
  }

  function init() {
    processVishrunFonts();
    try {
      var mo = new MutationObserver(function() { processVishrunFonts(); });
      mo.observe(document.documentElement || document, { childList: true, subtree: true });
    } catch (e) {}
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
function routeChildMessage(frame, payload, ctx, iframeCtx) {
  if (!payload || typeof payload !== "object")
    return;
  const p = payload;
  if (p.kind === "set-chat-messages") {
    handleSetChatMessages(frame.element, p.payload, ctx);
  } else if (p.kind === "clipboard-write-text") {
    handleClipboardWriteText(p.payload, ctx);
  } else if (p.kind === "alert") {
    handleHostAlert(p.payload);
  } else if (isThRequest(payload)) {
    dispatchThRequest(frame, payload, {
      chatId: iframeCtx.chatId,
      currentMessageId: iframeCtx.messageId,
      currentMessageIndex: iframeCtx.currentMessageIndex
    }, ctx);
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
  let working = content;
  for (const script of compiled) {
    if (script.kind !== "pairedTag")
      continue;
    script.findRe.lastIndex = 0;
    let lastMatch = null;
    let m;
    while ((m = script.findRe.exec(working)) !== null) {
      lastMatch = m;
      if (m[0].length === 0)
        script.findRe.lastIndex++;
    }
    if (lastMatch) {
      newList.push({
        scriptId: script.id,
        scriptName: script.scriptName,
        replaceString: script.replaceString,
        findRe: script.findRe,
        fullMatch: lastMatch[0],
        attrs: {}
      });
    }
    script.findRe.lastIndex = 0;
    working = working.replace(script.findRe, "");
    script.findRe.lastIndex = 0;
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

// src/core/macro-detection.ts
var MACRO_RE = /\{\{\s*[A-Za-z_@$][\w@$]*\s*(?:::|\}\})/;
function hasMacros(html) {
  return MACRO_RE.test(html);
}

// src/core/macro-resolver.ts
function isResolveMacrosResponse(p, requestId) {
  return !!p && typeof p === "object" && p.type === "resolve_macros_response" && p.requestId === requestId && Array.isArray(p.results);
}
var requestCounter3 = 0;
function nextRequestId3() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `vishrun-rm-${Date.now()}-${++requestCounter3}`;
}
var RESOLVE_TIMEOUT_MS = 5000;
function resolveMacrosBatch(ctx, chatId, characterId, templates, timeoutMs = RESOLVE_TIMEOUT_MS) {
  if (templates.length === 0)
    return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const requestId = nextRequestId3();
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
      if (!isResolveMacrosResponse(payload, requestId))
        return;
      if (payload.results.length === templates.length && payload.results.every((r) => typeof r === "string")) {
        const results = payload.results;
        finish(() => resolve(results));
      } else {
        finish(() => reject(new Error("resolve_macros malformed response")));
      }
    });
    timer = setTimeout(() => {
      finish(() => reject(new Error("resolve_macros timeout")));
    }, timeoutMs);
    try {
      ctx.sendToBackend({
        type: "resolve_macros",
        requestId,
        chatId,
        characterId: characterId ?? undefined,
        templates
      });
    } catch (err) {
      finish(() => reject(err instanceof Error ? err : new Error(String(err))));
    }
  });
}

// src/render/linearize-bubble.ts
var BLOCK_TAGS = new Set([
  "P",
  "DIV",
  "BLOCKQUOTE",
  "PRE",
  "UL",
  "OL",
  "LI",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HR"
]);
function linearizeBubble(root) {
  let text = "";
  const offsetMap = [];
  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node;
      const value = t.nodeValue ?? "";
      if (value.length === 0)
        return;
      const sourceStart = text.length;
      text += value;
      offsetMap.push({
        node: t,
        nodeStart: 0,
        nodeEnd: value.length,
        sourceStart,
        sourceEnd: text.length
      });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE)
      return;
    const el = node;
    if (el.hasAttribute && el.hasAttribute("data-vishrun-widget"))
      return;
    if (el.tagName === "BR") {
      text += `
`;
      return;
    }
    const isBlock = BLOCK_TAGS.has(el.tagName);
    let prevText = "";
    if (isBlock && text.length > 0 && !text.endsWith(`

`)) {
      prevText = text.endsWith(`
`) ? `
` : `

`;
      text += prevText;
    }
    for (const child of Array.from(el.childNodes))
      walk(child);
    if (isBlock && text.length > 0 && !text.endsWith(`

`)) {
      text += text.endsWith(`
`) ? `
` : `

`;
    }
  }
  for (const child of Array.from(root.childNodes))
    walk(child);
  while (text.endsWith(`
`))
    text = text.slice(0, -1);
  return { text, offsetMap };
}
var cache2 = new WeakMap;
function getLinearizedBubble(root) {
  const tc = root.textContent ?? "";
  const hash = quickHash(tc);
  const cached = cache2.get(root);
  if (cached && cached.hash === hash)
    return cached.result;
  const result = linearizeBubble(root);
  cache2.set(root, { hash, result });
  return result;
}
function invalidateLinearizedBubble(root) {
  cache2.delete(root);
}
function quickHash(s) {
  let h = 2166136261;
  for (let i = 0;i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

// src/render/inject-into-message.ts
var resolutionCache = new Map;
async function processNode(root, scripts, ctx) {
  const messageId = root.getAttribute("data-message-id") || undefined;
  if (!messageId) {
    return 0;
  }
  const target = findContentRoot(root);
  cleanupOrphansForMessage(messageId, target);
  const resolvedMap = await resolveMacrosForMessage(root, scripts, messageId, ctx);
  let total = 0;
  try {
    for (const script of scripts) {
      if (!isPlaceholderLikeKind(script.kind))
        continue;
      if (script.kind === "delimitedCaptureMultiLine") {
        total += await replaceMultiLineMatches(root, script, scripts, messageId, ctx, resolvedMap);
      } else {
        total += await replacePlaceholderMatches(root, script, scripts, messageId, ctx, resolvedMap);
      }
    }
    total += await renderPairedTagCaptures(root, scripts, messageId, ctx, resolvedMap);
  } catch (err) {
    console.debug("[vishrun] processNode render error:", err);
  }
  return total;
}
async function resolveMacrosForMessage(root, scripts, messageId, ctx) {
  const map = new Map;
  if (!scripts.some((s) => s.replaceString.includes("{{")))
    return map;
  const templates = collectExpandedTemplates(root, scripts, messageId).filter(hasMacros);
  if (templates.length === 0)
    return map;
  const { chatId, characterId } = ctx.getActiveChat();
  if (!chatId) {
    console.warn("[vishrun:variables] no active chatId; widget macros left unresolved");
    return map;
  }
  try {
    const resolved = await resolveMacrosBatch(ctx, chatId, characterId, templates);
    templates.forEach((t, i) => {
      map.set(t, resolved[i]);
      resolutionCache.set(t, resolved[i]);
    });
  } catch (err) {
    console.warn("[vishrun:variables] macro resolve failed; widgets render unresolved:", err instanceof Error ? err.message : String(err));
  }
  return map;
}
function collectExpandedTemplates(root, scripts, messageId) {
  const out = new Set;
  const textNodes = collectTextNodes(root);
  for (const script of scripts) {
    if (!isPlaceholderLikeKind(script.kind))
      continue;
    if (script.kind === "delimitedCaptureMultiLine") {
      const bubble = findContentRoot(root);
      const linear = getLinearizedBubble(bubble);
      script.findRe.lastIndex = 0;
      let m;
      while ((m = script.findRe.exec(linear.text)) !== null) {
        const groups = m.slice(1).map((g) => g ?? "");
        const html = substitute(script.replaceString, m[0], groups);
        out.add(applyNestedPipeline(html, scripts, new Set([script.id]), 0));
        if (m[0].length === 0)
          script.findRe.lastIndex++;
      }
      continue;
    }
    for (const tn of textNodes) {
      const text = tn.nodeValue ?? "";
      if (!text)
        continue;
      script.findRe.lastIndex = 0;
      let m;
      while ((m = script.findRe.exec(text)) !== null) {
        const groups = m.slice(1).map((g) => g ?? "");
        const html = substitute(script.replaceString, m[0], groups);
        out.add(applyNestedPipeline(html, scripts, new Set([script.id]), 0));
        if (m[0].length === 0)
          script.findRe.lastIndex++;
      }
    }
  }
  const target = findContentRoot(root);
  for (const cap of getCapturesForMessage(messageId)) {
    const sel = `[data-vishrun-widget][data-vishrun-script-id="${cssEscape(cap.scriptId)}"][data-vishrun-paired-fullmatch="${cssEscape(hashKey(cap.fullMatch))}"]`;
    if (target.querySelector(sel))
      continue;
    cap.findRe.lastIndex = 0;
    const m = cap.findRe.exec(cap.fullMatch);
    if (!m)
      continue;
    const groups = m.slice(1).map((g) => g ?? "");
    const html = substitute(cap.replaceString, m[0], groups);
    out.add(applyNestedPipeline(html, scripts, new Set([cap.scriptId]), 0));
  }
  return [...out];
}
async function replaceMultiLineMatches(root, script, allScripts, messageId, ctx, resolvedMap) {
  const bubble = findContentRoot(root);
  if (!bubble.isConnected)
    return 0;
  const linear = getLinearizedBubble(bubble);
  if (linear.text.length === 0)
    return 0;
  script.findRe.lastIndex = 0;
  const matches = [];
  let m;
  while ((m = script.findRe.exec(linear.text)) !== null) {
    matches.push({ start: m.index, end: m.index + m[0].length, match: m });
    if (m[0].length === 0)
      script.findRe.lastIndex++;
  }
  if (matches.length === 0)
    return 0;
  if (hasRegisteredWidgetsFor(messageId, script.id)) {
    destroyRegisteredWidgetsFor(messageId, script.id);
  }
  let count = 0;
  for (let i = matches.length - 1;i >= 0; i--) {
    const { start, end, match } = matches[i];
    const groups = match.slice(1).map((g) => g ?? "");
    const html = substitute(script.replaceString, match[0], groups);
    const expanded = applyNestedPipeline(html, allScripts, new Set([script.id]), 0);
    const fromMap = resolvedMap.get(expanded);
    const fromCache = fromMap ?? resolutionCache.get(expanded);
    const finalHtml = fromCache ?? expanded;
    const widget = await buildWidget(finalHtml, script.scriptName, script.id, messageId, ctx);
    const placed = replaceLinearRange(bubble, linear.offsetMap, start, end, widget);
    if (placed) {
      count++;
    } else if (widget.tagName === "IFRAME") {
      destroyWidgetIframe(widget);
    }
  }
  invalidateLinearizedBubble(bubble);
  return count;
}
function replaceLinearRange(bubble, offsetMap, start, end, widget) {
  let startEntry = null;
  let endEntry = null;
  for (const e of offsetMap) {
    if (!startEntry && e.sourceStart <= start && start < e.sourceEnd)
      startEntry = e;
    if (e.sourceStart < end && end <= e.sourceEnd)
      endEntry = e;
  }
  if (!startEntry || !endEntry)
    return false;
  if (!bubble.contains(startEntry.node) || !bubble.contains(endEntry.node))
    return false;
  const startNodeOffset = start - startEntry.sourceStart + startEntry.nodeStart;
  const endNodeOffset = end - endEntry.sourceStart + endEntry.nodeStart;
  let range;
  try {
    range = document.createRange();
    range.setStart(startEntry.node, startNodeOffset);
    range.setEnd(endEntry.node, endNodeOffset);
  } catch {
    return false;
  }
  range.deleteContents();
  range.insertNode(widget);
  cleanupEmptyAroundWidget(widget, bubble);
  return true;
}
var MULTILINE_BLOCK_TAGS = new Set([
  "P",
  "DIV",
  "BLOCKQUOTE",
  "PRE",
  "UL",
  "OL",
  "LI",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6"
]);
function cleanupEmptyAroundWidget(widget, stopAt) {
  let current2 = widget;
  for (;; ) {
    const parent = current2.parentElement;
    if (!parent)
      break;
    let prev = current2.previousSibling;
    while (prev) {
      const next = prev.previousSibling;
      if (isEmptyResidue(prev))
        prev.parentNode?.removeChild(prev);
      else
        break;
      prev = next;
    }
    let nxt = current2.nextSibling;
    while (nxt) {
      const next = nxt.nextSibling;
      if (isEmptyResidue(nxt))
        nxt.parentNode?.removeChild(nxt);
      else
        break;
      nxt = next;
    }
    if (parent === stopAt)
      break;
    const onlyChild = parent.childNodes.length === 1 && parent.childNodes[0] === current2;
    if (onlyChild && MULTILINE_BLOCK_TAGS.has(parent.tagName)) {
      const gparent = parent.parentNode;
      if (!gparent)
        break;
      gparent.replaceChild(current2, parent);
      continue;
    }
    break;
  }
}
function isEmptyResidue(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.nodeValue ?? "").length === 0;
  }
  if (node.nodeType === Node.ELEMENT_NODE) {
    const el = node;
    if (el.tagName === "BR")
      return true;
    if (!MULTILINE_BLOCK_TAGS.has(el.tagName))
      return false;
    return (el.textContent ?? "").length === 0;
  }
  return false;
}
async function replacePlaceholderMatches(root, script, allScripts, messageId, ctx, resolvedMap) {
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
      const expanded = applyNestedPipeline(html, allScripts, new Set([script.id]), 0);
      const fromMap = resolvedMap.get(expanded);
      const fromCache = fromMap ?? resolutionCache.get(expanded);
      const finalHtml = fromCache ?? expanded;
      const widget = await buildWidget(finalHtml, script.scriptName, script.id, messageId, ctx);
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
async function renderPairedTagCaptures(root, allScripts, messageId, ctx, resolvedMap) {
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
    const expanded = applyNestedPipeline(html, allScripts, new Set([cap.scriptId]), 0);
    const fromMap = resolvedMap.get(expanded);
    const fromCache = fromMap ?? resolutionCache.get(expanded);
    const finalHtml = fromCache ?? expanded;
    const iframe = await buildWidgetIframe(finalHtml, cap.scriptName, cap.scriptId, messageId, ctx);
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

// src/core/chat-changed-filter.ts
var VAR_PATH_RE = /^metadata\.(macro_variables|chat_variables)(\.|$)/;
function shouldRescanForChangedFields(changedFields) {
  if (changedFields === undefined)
    return true;
  if (changedFields.length === 0)
    return false;
  return changedFields.some((f) => !VAR_PATH_RE.test(f));
}

// src/render/self-mutation.ts
var WIDGET_ATTR = "data-vishrun-widget";
var WIDGET_SEL = "[data-vishrun-widget]";
function isOrContainsWidget(node) {
  if (node.nodeType !== 1)
    return false;
  const el = node;
  if (el.hasAttribute(WIDGET_ATTR))
    return true;
  return !!el.querySelector?.(WIDGET_SEL);
}
function isInsideWidget(node) {
  let cur = node.parentNode;
  while (cur) {
    if (cur.nodeType === 1 && cur.hasAttribute?.(WIDGET_ATTR))
      return true;
    cur = cur.parentNode;
  }
  return false;
}
function isSelfMutation(record) {
  if (record.type === "characterData")
    return isInsideWidget(record.target);
  if (record.addedNodes.length === 0)
    return false;
  for (let i = 0;i < record.addedNodes.length; i++) {
    if (isOrContainsWidget(record.addedNodes[i]))
      return true;
  }
  return false;
}
function allSelf(records) {
  for (let i = 0;i < records.length; i++) {
    if (!isSelfMutation(records[i]))
      return false;
  }
  return true;
}

// src/hooks/message-rendered.ts
var MAX_RAF_RETRIES = 3;
var MESSAGE_LIST_SELECTOR = '[data-component="MessageList"]';
function installMessageHooks(ctx) {
  let observer = null;
  let observedTarget = null;
  let pendingFrame = 0;
  let pendingRecords = [];
  let bodyWatcher = null;
  const OBSERVE_OPTS = { childList: true, subtree: true, characterData: true };
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
  async function scanAllNow(compiled) {
    const wasObserving = observer !== null && observedTarget !== null;
    if (wasObserving)
      observer.disconnect();
    try {
      const nodes = document.querySelectorAll("[data-message-id]");
      const tasks = [];
      nodes.forEach((n) => {
        tasks.push(processNode(n, compiled, ctx).catch(() => {}));
      });
      await Promise.all(tasks);
    } finally {
      if (wasObserving && observedTarget && document.contains(observedTarget)) {
        observer.observe(observedTarget, OBSERVE_OPTS);
      }
    }
  }
  function handleMutations(records) {
    if (records.length > 0)
      pendingRecords.push(...records);
    if (pendingFrame)
      return;
    pendingFrame = requestAnimationFrame(() => {
      pendingFrame = 0;
      const batch = pendingRecords;
      pendingRecords = [];
      const compiled = compiledForActiveCard();
      if (!compiled) {
        detachObserver();
        return;
      }
      if (allSelf(batch))
        return;
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
    observer.observe(target, OBSERVE_OPTS);
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
    pendingRecords = [];
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
  const unsubChatChanged = ctx.events.on("CHAT_CHANGED", (payload) => {
    const p = payload || {};
    if (!shouldRescanForChangedFields(p.changedFields))
      return;
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
    if (!shouldRescanForChangedFields(p.changedFields))
      return;
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
