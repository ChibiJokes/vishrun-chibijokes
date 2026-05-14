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

// src/backend/setvar-ops.ts
async function applySetvarOp(op, chatId, userId, vars = api.variables) {
  if (op.kind === "setvar") {
    await vars.local.set(chatId, op.name, op.value);
    return true;
  }
  if (op.kind === "setchatvar") {
    await vars.chat.set(chatId, op.name, op.value);
    return true;
  }
  varsLog.debug(`skipping ${op.kind} (upstream get/set path split):`, { name: op.name, userId });
  return false;
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
var SETVAR_RE = /\{\{(setvar|setchatvar|setgvar|setglobalvar)::([^:}]+)::([^}]*?)\}\}/g;
var NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
var chatSetvarMutex = new Map;
async function applyAndStripSetvars(template, chatId, userId, vars = api.variables) {
  const matches = [];
  for (const m of template.matchAll(SETVAR_RE)) {
    const [match, kind, name, value] = m;
    matches.push({ start: m.index, end: m.index + match.length, kind, name, value });
  }
  if (matches.length === 0)
    return template;
  const prev = chatSetvarMutex.get(chatId) ?? Promise.resolve();
  const work = prev.then(() => runApplyAndStripSetvars(template, chatId, userId, vars, matches));
  chatSetvarMutex.set(chatId, work.catch(() => {
    return;
  }));
  return work;
}
async function runApplyAndStripSetvars(template, chatId, userId, vars, matches) {
  let localBag = null;
  let chatBag = null;
  const needLocal = matches.some((m) => m.kind === "setvar" && NAME_RE.test(m.name));
  const needChat = matches.some((m) => m.kind === "setchatvar" && NAME_RE.test(m.name));
  if (needLocal) {
    try {
      localBag = await vars.local.list(chatId);
    } catch {
      localBag = null;
    }
  }
  if (needChat) {
    try {
      chatBag = await vars.chat.list(chatId);
    } catch {
      chatBag = null;
    }
  }
  const stripFlags = new Array(matches.length).fill(false);
  for (let i = 0;i < matches.length; i++) {
    const { kind, name, value } = matches[i];
    if (!NAME_RE.test(name))
      continue;
    const currentBag = kind === "setvar" ? localBag : kind === "setchatvar" ? chatBag : null;
    if (currentBag && currentBag[name] === value) {
      stripFlags[i] = true;
      continue;
    }
    try {
      stripFlags[i] = await applySetvarOp({ kind, name, value }, chatId, userId, vars);
      if (stripFlags[i] && currentBag)
        currentBag[name] = value;
    } catch (err) {
      varsLog.warn("setvar persist failed:", { kind, name, err: err instanceof Error ? err.message : String(err) });
    }
  }
  let out = "";
  let cursor = 0;
  for (let i = 0;i < matches.length; i++) {
    const { start, end } = matches[i];
    out += template.slice(cursor, start);
    if (!stripFlags[i])
      out += template.slice(start, end);
    cursor = end;
  }
  out += template.slice(cursor);
  return out;
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
        try {
          const stripped = await applyAndStripSetvars(original, chatId, userId);
          const { masked, masks } = maskInvalidMacros(stripped);
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
var SETVAR_HEAD = /^\/(setvar|setchatvar|setgvar|setglobalvar)\s+key\s*=\s*([^\s"'=|]+)\s+(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\S+))\s*/i;
var SETVAR_HINT = /\/(setvar|setchatvar|setgvar|setglobalvar)\b/i;
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
  const kind = m[1].toLowerCase();
  const key = m[2];
  let value;
  if (m[3] !== undefined)
    value = unescapeQuoted(m[3], '"');
  else if (m[4] !== undefined)
    value = unescapeQuoted(m[4], "'");
  else
    value = m[5];
  return { pair: { kind, key, value }, rest: trimmed.slice(m[0].length).trim() };
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
    if (!/\/(setvar|setchatvar|setgvar|setglobalvar)\b/i.test(ctx.content))
      return;
    const parsed = parseSetvarChain(ctx.content);
    if (!parsed)
      return;
    for (const { kind, key, value } of parsed.pairs) {
      try {
        await applySetvarOp({ kind, name: key, value }, ctx.chatId, ctx.userId);
      } catch (err) {
        varsLog.warn(`setvar failed for "${kind}::${key}":`, err instanceof Error ? err.message : String(err));
      }
    }
    const stripped = parsed.strippedContent.trim();
    return { content: stripped.length > 0 ? stripped : EMPTY_REPLACEMENT };
  }, 50);
}

// src/backend/dispatch-slash.ts
function isDispatchSlashRequest(p) {
  if (!p || typeof p !== "object")
    return false;
  const r = p;
  return r.type === "dispatch_slash_text" && typeof r.requestId === "string" && typeof r.text === "string" && typeof r.chatId === "string";
}
var SETVAR_PREFIX_RE = /^\s*\/(setvar|setchatvar|setgvar|setglobalvar)\b/i;
var SYS_PREFIX_RE = /^\s*\/sys\b/i;
async function dispatchSlashText(text, chatId, userId, deps = {}) {
  if (SETVAR_PREFIX_RE.test(text)) {
    const parsed = parseSetvarChain(text);
    if (!parsed || parsed.pairs.length === 0) {
      varsLog.warn("dispatch_slash_text: setvar prefix matched but parse failed; treating as handled");
      return { handled: true, kind: "setvar_chain" };
    }
    for (const { kind, key, value } of parsed.pairs) {
      try {
        await applySetvarOp({ kind, name: key, value }, chatId, userId, deps.vars);
      } catch (err) {
        varsLog.warn(`dispatch_slash_text: applySetvarOp failed for ${kind}::${key}:`, err instanceof Error ? err.message : String(err));
      }
    }
    return { handled: true, kind: "setvar_chain" };
  }
  if (SYS_PREFIX_RE.test(text)) {
    const content = text.replace(/^\s*\/sys\s*/i, "");
    const append = deps.appendMessage ?? api.chat.appendMessage.bind(api.chat);
    await append(chatId, { role: "system", content });
    return { handled: true, kind: "sys_message" };
  }
  return { handled: false, kind: "none" };
}
function installDispatchSlashHandler() {
  api.onFrontendMessage((payload, userId) => {
    if (!isDispatchSlashRequest(payload))
      return;
    const { requestId, text, chatId } = payload;
    (async () => {
      let response;
      try {
        const result = await dispatchSlashText(text, chatId, userId);
        response = { type: "dispatch_slash_text_response", requestId, handled: result.handled, kind: result.kind };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        varsLog.warn("dispatch_slash_text handler threw:", msg);
        response = { type: "dispatch_slash_text_response", requestId, handled: false, kind: "none", error: msg };
      }
      api.sendToFrontend(response, userId);
    })();
  });
}

// src/backend/th-helpers.ts
var LOG_PREFIX = "[vishrun:th-helpers]";
var log = {
  warn: (...args) => console.warn(LOG_PREFIX, ...args),
  debug: (...args) => console.debug(LOG_PREFIX, ...args)
};
function isThHelpersRequest(p) {
  if (!p || typeof p !== "object")
    return false;
  const r = p;
  return r.type === "th_helpers_request" && typeof r.requestId === "string" && typeof r.op === "string" && typeof r.chatId === "string" && typeof r.currentMessageId === "string" && typeof r.currentMessageIndex === "number" && !!r.body && typeof r.body === "object";
}
function resolveRangeToIndex(range, total, currentMessageIndex) {
  if (total === 0)
    return null;
  if (typeof range === "number") {
    return range >= 0 ? range : total + range;
  }
  if (typeof range === "string") {
    const trimmed = range.trim();
    if (trimmed === "" || trimmed === "latest")
      return total - 1;
    if (trimmed === "this")
      return currentMessageIndex;
    if (/^-?\d+$/.test(trimmed)) {
      const n = parseInt(trimmed, 10);
      return n >= 0 ? n : total + n;
    }
  }
  return null;
}
function shapeMessage(msg, includeSwipes) {
  const role = typeof msg.role === "string" ? msg.role : msg.is_user ? "user" : "assistant";
  const base = {
    message_id: msg.index_in_chat,
    name: msg.name,
    role,
    is_hidden: false
  };
  if (includeSwipes) {
    base.swipe_id = msg.swipe_id ?? 0;
    base.swipes = Array.isArray(msg.swipes) && msg.swipes.length > 0 ? msg.swipes : [msg.content];
    base.swipes_data = base.swipes.map(() => ({}));
    base.swipes_info = base.swipes.map(() => ({}));
  } else {
    base.message = msg.content;
    base.data = {};
    base.extra = msg.extra ?? {};
  }
  return base;
}
async function handleGetChatMessages(body, chatId, currentMessageIndex, chat = api.chat) {
  const range = body.range;
  const opts = body.opts ?? {};
  const includeSwipes = opts.include_swipe === true || opts.include_swipes === true;
  const messages = await chat.getMessages(chatId);
  const total = messages.length;
  if (total === 0)
    return [];
  const idx = resolveRangeToIndex(range, total, currentMessageIndex);
  if (idx === null) {
    log.debug("getChatMessages: unsupported range", range);
    return [];
  }
  if (idx < 0 || idx >= total)
    return [];
  return [shapeMessage(messages[idx], includeSwipes)];
}
async function handleSetChatMessage(body, chatId, currentMessageIndex, chat = api.chat) {
  const fieldValues = body.fieldValues ?? {};
  const opts = body.opts ?? {};
  const messageRange = body.messageId;
  const messages = await chat.getMessages(chatId);
  if (messages.length === 0) {
    log.warn("setChatMessage: empty chat, ignoring");
    return;
  }
  const idx = resolveRangeToIndex(messageRange, messages.length, currentMessageIndex);
  if (idx === null || idx < 0 || idx >= messages.length) {
    log.warn("setChatMessage: unresolved message index", messageRange);
    return;
  }
  const target = messages[idx];
  const content = typeof fieldValues.message === "string" ? fieldValues.message : undefined;
  if (typeof content !== "string") {
    log.warn("setChatMessage: no message string in fieldValues, ignoring");
    return;
  }
  const patch = { content };
  const optsSwipeId = opts.swipe_id;
  if (typeof optsSwipeId === "number") {
    patch.swipe_id = optsSwipeId;
  }
  await chat.updateMessage(chatId, target.id, patch);
}
function installThHelpersHandler() {
  api.onFrontendMessage((payload, userId) => {
    if (!isThHelpersRequest(payload))
      return;
    const { requestId, op, chatId, currentMessageIndex, body } = payload;
    (async () => {
      let response;
      try {
        if (op === "th-get-chat-messages") {
          const result = await handleGetChatMessages(body, chatId, currentMessageIndex);
          response = { type: "th_helpers_response", requestId, ok: true, result };
        } else if (op === "th-set-chat-message") {
          await handleSetChatMessage(body, chatId, currentMessageIndex);
          response = { type: "th_helpers_response", requestId, ok: true, result: undefined };
        } else {
          response = {
            type: "th_helpers_response",
            requestId,
            ok: false,
            error: "unknown op: " + String(op)
          };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn("handler threw for op", op, msg);
        response = { type: "th_helpers_response", requestId, ok: false, error: msg };
      }
      api.sendToFrontend(response, userId);
    })();
  });
}

// src/backend/index.ts
installFetchExternalHandler();
installMacroResolveHandler();
installMessageContentProcessor();
installDispatchSlashHandler();
installThHelpersHandler();
function setup() {}
export {
  setup
};
