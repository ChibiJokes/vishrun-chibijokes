// @bun
// src/backend/common.ts
var api = spindle;
var VARS_PREFIX = "[vishrun:variables]";
var varsLog = {
  warn: (...args) => console.warn(VARS_PREFIX, ...args),
  debug: (...args) => console.debug(VARS_PREFIX, ...args)
};

// src/backend/fetch-external.ts
function isFetchExternalRequest(p) {
  return !!p && typeof p === "object" && p.type === "fetch_external" && typeof p.requestId === "string" && typeof p.url === "string";
}
function extractBody(result) {
  if (result && typeof result === "object" && typeof result.body === "string") {
    return result.body;
  }
  return "";
}
function installFetchExternalHandler() {
  api.onFrontendMessage((payload, userId) => {
    if (!isFetchExternalRequest(payload))
      return;
    const { requestId, url } = payload;
    const options = { responseType: "text" };
    api.cors(url, options).then((result) => {
      api.sendToFrontend({ type: "fetch_external_response", requestId, ok: true, body: extractBody(result) }, userId);
    }, (err) => {
      api.sendToFrontend({
        type: "fetch_external_response",
        requestId,
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      }, userId);
    });
  });
}

// src/backend/macro-resolve.ts
function isResolveMacrosRequest(p) {
  if (!p || typeof p !== "object")
    return false;
  const r = p;
  return r.type === "resolve_macros" && typeof r.requestId === "string" && typeof r.chatId === "string" && Array.isArray(r.templates) && r.templates.every((t) => typeof t === "string");
}
var VALID_MACRO_NAMES = [
  "getvar",
  "setvar",
  "addvar",
  "incvar",
  "decvar",
  "getchatvar",
  "setchatvar",
  "getgvar",
  "setgvar",
  "getglobalvar",
  "setglobalvar",
  "user",
  "char",
  "group",
  "newline",
  "input",
  "random",
  "roll",
  "pick"
];
var VALID_MACRO_RE = new RegExp(`^\\{\\{(?:${VALID_MACRO_NAMES.join("|")})(?:::|\\}\\})`);
var NUL = String.fromCharCode(0);
var SENTINEL_RE = new RegExp(`${NUL}VSHMSK(\\d+)${NUL}`, "g");
function maskInvalidMacros(template) {
  const masks = [];
  const masked = template.split(NUL).join("").replace(/\{\{[^{}]+\}\}/g, (match) => {
    if (VALID_MACRO_RE.test(match))
      return match;
    const idx = masks.length;
    masks.push(match);
    return `${NUL}VSHMSK${idx}${NUL}`;
  });
  return { masked, masks };
}
function unmaskInvalidMacros(text, masks) {
  if (masks.length === 0)
    return text;
  return text.replace(SENTINEL_RE, (_m, idx) => masks[Number(idx)] ?? "");
}
function installMacroResolveHandler() {
  api.onFrontendMessage((payload, userId) => {
    if (!isResolveMacrosRequest(payload))
      return;
    const { requestId, chatId, characterId, templates } = payload;
    (async () => {
      const results = new Array(templates.length);
      for (let i = 0;i < templates.length; i++) {
        const original = templates[i];
        const { masked, masks } = maskInvalidMacros(original);
        try {
          const { text, diagnostics } = await api.macros.resolve(masked, {
            chatId,
            characterId,
            userId,
            commit: false
          });
          if (diagnostics.length > 0) {
            varsLog.debug(`resolve produced ${diagnostics.length} diagnostic(s):`, diagnostics[0]?.message);
          }
          results[i] = unmaskInvalidMacros(text, masks);
        } catch (err) {
          varsLog.warn("resolve failed:", err instanceof Error ? err.message : String(err));
          results[i] = original;
        }
      }
      api.sendToFrontend({ type: "resolve_macros_response", requestId, results }, userId);
    })();
  });
}

// src/backend/parsers/setvar.ts
var SETVAR_HEAD = /^\/setvar\s+key\s*=\s*([^\s"'=|]+)\s+(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\S+))\s*/i;
var SETVAR_HINT = /\/setvar\b/i;
function unescapeQuoted(s, quote) {
  return s.replace(/\\(.)/g, (_m, c) => c === quote || c === "\\" ? c : "\\" + c);
}
function splitChain(s) {
  const out = [];
  let buf = "";
  let quote = null;
  for (let i = 0;i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      buf += ch;
      if (ch === "\\" && i + 1 < s.length) {
        buf += s[++i];
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
    } else if (ch === "|" || ch === `
`) {
      out.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  out.push(buf);
  return out;
}
function parseSegment(seg) {
  const trimmed = seg.trim();
  const m = SETVAR_HEAD.exec(trimmed);
  if (!m)
    return { pair: null, rest: trimmed };
  const key = m[1];
  let value;
  if (m[2] !== undefined)
    value = unescapeQuoted(m[2], '"');
  else if (m[3] !== undefined)
    value = unescapeQuoted(m[3], "'");
  else
    value = m[4];
  return { pair: { key, value }, rest: trimmed.slice(m[0].length).trim() };
}
function parseSetvarChain(content) {
  if (!SETVAR_HINT.test(content))
    return null;
  const pairs = [];
  const kept = [];
  for (const seg of splitChain(content)) {
    const { pair, rest } = parseSegment(seg);
    if (pair)
      pairs.push(pair);
    if (rest)
      kept.push(rest);
  }
  if (pairs.length === 0)
    return null;
  return { pairs, strippedContent: kept.join(" | ").trim() };
}

// src/backend/message-content-processor.ts
var EMPTY_REPLACEMENT = "_(variables updated)_";
function installMessageContentProcessor() {
  api.registerMessageContentProcessor(async (ctx) => {
    if (ctx.extra?.greeting === true)
      return;
    if (ctx.origin === "render")
      return;
    if (!ctx.content.includes("/setvar"))
      return;
    const parsed = parseSetvarChain(ctx.content);
    if (!parsed)
      return;
    for (const { key, value } of parsed.pairs) {
      try {
        await api.variables.local.set(ctx.chatId, key, value);
      } catch (err) {
        varsLog.warn(`setvar failed for "${key}":`, err instanceof Error ? err.message : String(err));
      }
    }
    const stripped = parsed.strippedContent.trim();
    return { content: stripped.length > 0 ? stripped : EMPTY_REPLACEMENT };
  }, 50);
}

// src/backend/index.ts
installFetchExternalHandler();
installMacroResolveHandler();
installMessageContentProcessor();
function setup() {}
export {
  setup
};
