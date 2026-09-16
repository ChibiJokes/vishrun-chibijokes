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
var VALID_MACRO_RE = new RegExp(`^\\{\\{(?:${VALID_MACRO_NAMES.join("|")})(?:::|\\}\\})`, "i");
var NUL = String.fromCharCode(0);
var SENTINEL_RE = new RegExp(`${NUL}VSHMSK(\\d+)${NUL}`, "g");
var DYNAMIC_VAR_MACRO_NAMES = new Set(["getvar", "getchatvar"]);
var LOCAL_DYNAMIC_MACRO_NAMES = new Set([
  "random",
  "roll",
  "pick",
  "newline",
  "input"
]);
function maskInvalidMacros(template, deferNames = new Set) {
  const masks = [];
  const masked = template.split(NUL).join("").replace(/\{\{[^{}]+\}\}/g, (match) => {
    const nameMatch = match.match(/^\{\{\s*([A-Za-z_@$][\w@$]*)/);
    const name = nameMatch ? nameMatch[1].toLowerCase() : "";
    if (deferNames.has(name)) {
      const idx = masks.length;
      masks.push(match);
      return `${NUL}VSHMSK${idx}${NUL}`;
    }
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
var SETVAR_RE = /\{\{(setvar|setchatvar|setgvar|setglobalvar)::([^:}]+)::([^}]*?)\}\}/gi;
var NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
var chatSetvarMutex = new Map;
async function applyAndStripSetvars(template, chatId, userId, vars = api.variables) {
  const matches = [];
  for (const m of template.matchAll(SETVAR_RE)) {
    const [match, kind, name, value] = m;
    matches.push({ start: m.index, end: m.index + match.length, kind: kind.toLowerCase(), name, value });
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
async function resolveMacroText(original, chatId, characterId, userId, deferNames = new Set) {
  try {
    const stripped = await applyAndStripSetvars(original, chatId, userId);
    const { masked, masks } = maskInvalidMacros(stripped, deferNames);
    const { text, diagnostics } = await api.macros.resolve(masked, {
      chatId,
      characterId,
      userId,
      commit: false
    });
    if (diagnostics.length > 0) {
      varsLog.debug(`resolve produced ${diagnostics.length} diagnostic(s):`, diagnostics[0]?.message);
    }
    return unmaskInvalidMacros(text, masks);
  } catch (err) {
    varsLog.warn("resolve failed:", err instanceof Error ? err.message : String(err));
    return original;
  }
}
var DYNAMIC_VAR_RE = /\{\{\s*(getvar|getchatvar)\s*::\s*([^:}]*?)\s*\}\}/gi;
async function resolveDynamicVarMacros(text, chatId) {
  if (!text.includes("{{"))
    return text;
  DYNAMIC_VAR_RE.lastIndex = 0;
  if (!DYNAMIC_VAR_RE.test(text))
    return text;
  const cache = new Map;
  DYNAMIC_VAR_RE.lastIndex = 0;
  let m;
  const lookups = [];
  while ((m = DYNAMIC_VAR_RE.exec(text)) !== null) {
    const kind = m[1].toLowerCase();
    const key = m[2];
    const cacheKey = `${kind}::${key}`;
    if (cache.has(cacheKey))
      continue;
    cache.set(cacheKey, "");
    lookups.push((kind === "getvar" ? api.variables.local.get(chatId, key) : api.variables.chat.get(chatId, key)).then((value) => {
      cache.set(cacheKey, value ?? "");
    }).catch((err) => {
      varsLog.warn("dynamic var resolve failed:", { kind, key, err: err instanceof Error ? err.message : String(err) });
      cache.set(cacheKey, `{{${kind}::${key}}}`);
    }));
  }
  await Promise.all(lookups);
  return text.replace(DYNAMIC_VAR_RE, (full, kind, key) => {
    const v = cache.get(`${kind.toLowerCase()}::${key}`);
    return v !== undefined ? v : full;
  });
}
var LOCAL_DYNAMIC_RE = /\{\{\s*(random|roll|pick|newline|input)\s*(?:::([^}]*))?\}\}/gi;
function rollDice(notation) {
  const match = notation.match(/^(\d+)d(\d+)$/i);
  if (!match)
    return "0";
  const count = Math.min(parseInt(match[1], 10), 100);
  const sides = parseInt(match[2], 10);
  if (sides < 1 || count < 1)
    return "0";
  let total = 0;
  for (let i = 0;i < count; i++)
    total += Math.floor(Math.random() * sides) + 1;
  return String(total);
}
function splitArgs(argStr) {
  if (argStr === undefined || argStr === "")
    return [];
  return argStr.split("::");
}
function randomMacro(argStr) {
  const args = splitArgs(argStr);
  if (args.length === 0)
    return String(Math.round(Math.random()));
  const allNumeric = args.length <= 2 && args.every((a) => a.trim() !== "" && !isNaN(Number(a)));
  if (allNumeric) {
    const min = parseInt(args[0], 10) || 0;
    const max = parseInt(args[1], 10) || 1;
    if (max < min)
      return String(min);
    return String(Math.floor(Math.random() * (max - min + 1)) + min);
  }
  return args[Math.floor(Math.random() * args.length)];
}
function pickMacro(argStr) {
  const args = splitArgs(argStr);
  if (args.length === 0)
    return "";
  return args[Math.floor(Math.random() * args.length)];
}
function resolveLocalDynamicMacros(text, lastUserMessage) {
  if (!text.includes("{{"))
    return text;
  return text.replace(LOCAL_DYNAMIC_RE, (full, name, argStr) => {
    switch (name.toLowerCase()) {
      case "newline":
        return `
`;
      case "input":
        return lastUserMessage;
      case "roll":
        return rollDice((argStr ?? "1d6").trim());
      case "random":
        return randomMacro(argStr);
      case "pick":
        return pickMacro(argStr);
      default:
        return full;
    }
  });
}
function installMacroResolveHandler() {
  api.onFrontendMessage((payload, userId) => {
    if (!isResolveMacrosRequest(payload))
      return;
    const { requestId, chatId, characterId, templates } = payload;
    (async () => {
      const results = new Array(templates.length);
      for (let i = 0;i < templates.length; i++) {
        results[i] = await resolveMacroText(templates[i], chatId, characterId, userId);
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

// src/backend/pre-generation-bridge.ts
var LOG_PREFIX = "[vishrun:pre-generation]";
var PRE_GENERATION_TIMEOUT_MS = 300000;
var subscribedUsers = new Set;
var pendingRequests = new Map;
function isSubscriptionMessage(payload) {
  return !!payload && typeof payload === "object" && payload.type === "vsh_pre_generation_subscription" && typeof payload.active === "boolean";
}
function isCompleteMessage(payload) {
  return !!payload && typeof payload === "object" && payload.type === "vsh_pre_generation_complete" && typeof payload.requestId === "string";
}
function isWorldInfoRequestMessage(payload) {
  return !!payload && typeof payload === "object" && payload.type === "vsh_pre_generation_world_info_request" && typeof payload.requestId === "string";
}
function normalizeActivatedWorldInfo(value) {
  if (!Array.isArray(value))
    return [];
  const out = [];
  const seen = new Set;
  for (const item of value) {
    if (!item || typeof item !== "object")
      continue;
    const raw = item;
    const id = typeof raw.id === "string" ? raw.id : "";
    if (!id || seen.has(id))
      continue;
    seen.add(id);
    const entry = { id };
    if (typeof raw.comment === "string")
      entry.comment = raw.comment;
    if (Array.isArray(raw.keys))
      entry.keys = raw.keys.filter((key) => typeof key === "string");
    if (typeof raw.source === "string")
      entry.source = raw.source;
    if (typeof raw.score === "number")
      entry.score = raw.score;
    if (typeof raw.bookId === "string")
      entry.bookId = raw.bookId;
    if (typeof raw.bookSource === "string")
      entry.bookSource = raw.bookSource;
    out.push(entry);
  }
  return out;
}
function clearPending(requestId) {
  const pending = pendingRequests.get(requestId);
  if (!pending)
    return null;
  pendingRequests.delete(requestId);
  clearTimeout(pending.timer);
  if (pending.signal && pending.abortHandler) {
    pending.signal.removeEventListener("abort", pending.abortHandler);
  }
  return pending;
}
function releasePendingForUser(userId) {
  for (const [requestId, pending] of pendingRequests) {
    if (pending.userId !== userId)
      continue;
    clearPending(requestId)?.resolve();
  }
}
async function sendWorldInfoBodies(requestId, userId, pending) {
  try {
    const results = await Promise.allSettled(pending.activatedWorldInfo.map(async (activation) => {
      const entry = await api.world_books.entries.get(activation.id, userId);
      if (!entry)
        throw new Error(`Active World Info entry ${activation.id} is unavailable`);
      if (typeof entry.content !== "string" || !entry.content.trim()) {
        throw new Error(`Active World Info entry ${activation.id} has no readable content`);
      }
      return { ...entry, ...activation, content: entry.content };
    }));
    if (!pendingRequests.has(requestId))
      return;
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length > 0) {
      api.sendToFrontend({
        type: "vsh_pre_generation_world_info_result",
        requestId,
        entries: [],
        error: failures.map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason)).join("; ")
      }, userId);
      return;
    }
    api.sendToFrontend({
      type: "vsh_pre_generation_world_info_result",
      requestId,
      entries: results.filter((result) => result.status === "fulfilled").map((result) => result.value)
    }, userId);
  } catch (error) {
    if (!pendingRequests.has(requestId))
      return;
    api.sendToFrontend({
      type: "vsh_pre_generation_world_info_result",
      requestId,
      entries: [],
      error: error instanceof Error ? error.message : String(error)
    }, userId);
  }
}
function installPreGenerationBridgeHandler() {
  api.onFrontendMessage((payload, userId) => {
    if (isSubscriptionMessage(payload)) {
      if (payload.active) {
        subscribedUsers.add(userId);
      } else {
        subscribedUsers.delete(userId);
        releasePendingForUser(userId);
      }
      return;
    }
    if (isWorldInfoRequestMessage(payload)) {
      const pending = pendingRequests.get(payload.requestId);
      if (!pending || pending.userId !== userId)
        return;
      sendWorldInfoBodies(payload.requestId, userId, pending);
      return;
    }
    if (!isCompleteMessage(payload))
      return;
    const pending = pendingRequests.get(payload.requestId);
    if (!pending || pending.userId !== userId)
      return;
    clearPending(payload.requestId)?.resolve();
    if (payload.error) {
      console.warn(LOG_PREFIX, "frontend handler reported an error:", payload.error);
    }
  });
}
async function waitForPreGeneration(context) {
  const { chatId, userId, generationType, signal } = context;
  const activatedWorldInfo = normalizeActivatedWorldInfo(context.activatedWorldInfo);
  if (!chatId || !userId || !subscribedUsers.has(userId))
    return;
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }
  const requestId = crypto.randomUUID();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const pending = clearPending(requestId);
      if (!pending)
        return;
      api.sendToFrontend({ type: "vsh_pre_generation_cancel", requestId }, userId);
      console.warn(LOG_PREFIX, `frontend handler timed out after ${PRE_GENERATION_TIMEOUT_MS}ms`);
      pending.resolve();
    }, PRE_GENERATION_TIMEOUT_MS);
    const pending = {
      userId,
      resolve,
      reject,
      timer,
      signal,
      activatedWorldInfo
    };
    if (signal) {
      pending.abortHandler = () => {
        const active = clearPending(requestId);
        if (!active)
          return;
        api.sendToFrontend({ type: "vsh_pre_generation_cancel", requestId }, userId);
        active.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      };
      signal.addEventListener("abort", pending.abortHandler, { once: true });
    }
    pendingRequests.set(requestId, pending);
    api.sendToFrontend({
      type: "vsh_pre_generation_request",
      requestId,
      chatId,
      ...generationType ? { generationType } : {},
      activatedWorldInfo
    }, userId);
  });
}

// src/backend/message-content-processor.ts
var EMPTY_REPLACEMENT = "_(variables updated)_";
function injectPath(chatId) {
  return `injects/${chatId}.json`;
}
async function readInjects(chatId) {
  try {
    return await api.storage.getJson(injectPath(chatId), { fallback: [] });
  } catch (e) {
    return [];
  }
}
async function writeInjects(chatId, injects) {
  try {
    if (injects.length === 0) {
      await api.storage.delete(injectPath(chatId));
    } else {
      await api.storage.setJson(injectPath(chatId), injects);
    }
  } catch (e) {}
}
function parseInjectArgs(raw) {
  const args = {};
  let remaining = raw.trim();
  const ARG_RE = /^([a-zA-Z_]\w*)=(\S+)\s*/;
  let m;
  while ((m = ARG_RE.exec(remaining)) !== null) {
    args[m[1].toLowerCase()] = m[2];
    remaining = remaining.slice(m[0].length);
  }
  return { args, content: remaining };
}
var SETVAR_RE2 = /\/(setvar|setchatvar|setgvar|setglobalvar)\b/i;
var INJECT_RE = /\/inject\b/i;
var FLUSHINJECT_RE = /\/flushinject\b/i;
var DEFERRED_MACRO_NAMES = new Set([
  ...DYNAMIC_VAR_MACRO_NAMES,
  ...LOCAL_DYNAMIC_MACRO_NAMES
]);
var SELF_CLOSING_CUSTOM_RE = /<([A-Z][a-zA-Z0-9_-]*)(\s[^>]*)?\s*\/>/g;
function expandSelfClosingTags(content) {
  return content.replace(SELF_CLOSING_CUSTOM_RE, (_m, tag, attrs) => {
    const a = attrs ? attrs.trimEnd() : "";
    return `<${tag}${a}></${tag}>`;
  });
}
async function processMessageContent(ctx, deps = {}) {
  const applySetvar = deps.applySetvarOp ?? applySetvarOp;
  const workingContent = expandSelfClosingTags(ctx.content);
  const selfCloseChanged = workingContent !== ctx.content;
  if (ctx.origin === "render") {
    return selfCloseChanged ? { content: workingContent } : undefined;
  }
  if (!SETVAR_RE2.test(workingContent) && !INJECT_RE.test(workingContent) && !FLUSHINJECT_RE.test(workingContent)) {
    return selfCloseChanged ? { content: workingContent } : undefined;
  }
  let content = workingContent;
  const parsed = parseSetvarChain(content);
  if (parsed) {
    for (const { kind, key, value } of parsed.pairs) {
      setTimeout(async () => {
        try {
          await applySetvar({ kind, name: key, value }, ctx.chatId, ctx.userId);
        } catch (err) {
          varsLog.warn(`setvar failed for "${kind}::${key}":`, err instanceof Error ? err.message : String(err));
        }
      }, 0);
    }
    content = parsed.strippedContent;
  }
  if (INJECT_RE.test(content)) {
    const INJECT_CMD_RE = /^\/inject(?:\s+(.*?))?\s*$/gim;
    const injects = await readInjects(ctx.chatId);
    let im;
    while ((im = INJECT_CMD_RE.exec(content)) !== null) {
      const { args, content: body } = parseInjectArgs(im[1] ?? "");
      if (!body.trim())
        continue;
      const resolvedBody = await resolveMacroText(body, ctx.chatId, undefined, ctx.userId, DEFERRED_MACRO_NAMES);
      const id = args.id ?? Math.random().toString(36).slice(2, 10);
      const spec = {
        id,
        content: resolvedBody,
        role: args.role === "user" || args.role === "assistant" ? args.role : "system",
        depth: Math.max(0, parseInt(args.depth ?? "0", 10) || 0),
        position: args.position === "before" || args.position === "after" ? args.position : "chat",
        turns: Math.max(0, parseInt(args.turns ?? "0", 10) || 0)
      };
      const existing = injects.findIndex((e) => e.id === id);
      if (existing >= 0) {
        injects[existing] = spec;
      } else {
        injects.push(spec);
      }
    }
    await writeInjects(ctx.chatId, injects);
    content = content.replace(/^\/inject(?:\s+.*?)?\s*$/gim, "").replace(/\n{3,}/g, `

`);
  }
  if (FLUSHINJECT_RE.test(content)) {
    const FLUSH_CMD_RE = /^\/flushinject(?:\s+id=(\S+))?\s*$/gim;
    let injects = await readInjects(ctx.chatId);
    let fm;
    while ((fm = FLUSH_CMD_RE.exec(content)) !== null) {
      const id = fm[1];
      injects = id ? injects.filter((e) => e.id !== id) : [];
    }
    await writeInjects(ctx.chatId, injects);
    content = content.replace(/^\/flushinject(?:\s+\S+)?\s*$/gim, "").replace(/\n{3,}/g, `

`);
  }
  if (content === ctx.content)
    return;
  const stripped = content.trim();
  return { content: stripped.length > 0 ? stripped : EMPTY_REPLACEMENT };
}
function installInjectInterceptor() {
  api.registerInterceptor(async (messages, context) => {
    const ctx = context;
    if (!ctx.chatId)
      return { messages };
    await waitForPreGeneration(ctx);
    const injects = await readInjects(ctx.chatId);
    if (injects.length === 0)
      return { messages };
    const result = [...messages];
    const surviving = [];
    const breakdown = [];
    let lastUserMessage = "";
    for (let i = messages.length - 1;i >= 0; i--) {
      if (messages[i].role === "user") {
        lastUserMessage = messages[i].content ?? "";
        break;
      }
    }
    for (const spec of injects) {
      let resolvedContent = await resolveDynamicVarMacros(spec.content, ctx.chatId);
      resolvedContent = resolveLocalDynamicMacros(resolvedContent, lastUserMessage);
      if (ctx.userId) {
        resolvedContent = await resolveMacroText(resolvedContent, ctx.chatId, ctx.characterId, ctx.userId);
      }
      const msg = { role: spec.role, content: resolvedContent };
      let insertAt;
      if (spec.position === "before") {
        const first = result.findIndex((m) => m.__isChatHistory === true);
        insertAt = first >= 0 ? first : 0;
      } else if (spec.position === "after") {
        insertAt = result.length;
      } else {
        if (spec.depth === 0) {
          insertAt = result.length;
        } else {
          let count = 0;
          insertAt = result.length;
          for (let i = result.length - 1;i >= 0; i--) {
            if (result[i].__isChatHistory === true) {
              count++;
              if (count === spec.depth) {
                insertAt = i;
                break;
              }
            }
          }
        }
      }
      result.splice(insertAt, 0, msg);
      breakdown.push({ messageIndex: insertAt, name: "Inject: " + spec.id });
      if (spec.turns === 0) {
        surviving.push(spec);
      } else if (spec.turns > 1) {
        surviving.push({ ...spec, turns: spec.turns - 1 });
      }
    }
    if (surviving.length !== injects.length) {
      await writeInjects(ctx.chatId, surviving);
    }
    return { messages: result, breakdown };
  });
}
function installMessageContentProcessor() {
  api.registerMessageContentProcessor((ctx) => processMessageContent(ctx), 50);
  installInjectInterceptor();
}

// src/backend/dispatch-slash.ts
var DEFERRED_MACRO_NAMES2 = new Set([
  ...DYNAMIC_VAR_MACRO_NAMES,
  ...LOCAL_DYNAMIC_MACRO_NAMES
]);
function isDispatchSlashRequest(p) {
  if (!p || typeof p !== "object")
    return false;
  const r = p;
  return r.type === "dispatch_slash_text" && typeof r.requestId === "string" && typeof r.text === "string" && typeof r.chatId === "string";
}
var SETVAR_PREFIX_RE = /^\s*\/(setvar|setchatvar|setgvar|setglobalvar)\b/i;
var SYS_PREFIX_RE = /^\s*\/sys\b/i;
var INJECT_PREFIX_RE = /^\s*\/inject\b/i;
var FLUSHINJECT_PREFIX_RE = /^\s*\/flushinject\b/i;
var LISTINJECTS_PREFIX_RE = /^\s*\/listinjects\b/i;
var VISHRUN_INJECTS_VAR = "_vishrun_injects";
function injectPath2(chatId) {
  return `injects/${chatId}.json`;
}
function parseInjectArgs2(raw) {
  const args = {};
  let remaining = raw.trim();
  const ARG_RE = /^([a-zA-Z_]\w*)=(\S+)\s*/;
  let m;
  while ((m = ARG_RE.exec(remaining)) !== null) {
    args[m[1].toLowerCase()] = m[2];
    remaining = remaining.slice(m[0].length);
  }
  return { args, content: remaining };
}
async function readInjectsFromStorage(chatId) {
  try {
    return await api.storage.getJson(injectPath2(chatId), { fallback: [] });
  } catch (e) {
    return [];
  }
}
async function writeInjectsToStorage(chatId, injects) {
  try {
    if (injects.length === 0) {
      await api.storage.delete(injectPath2(chatId));
    } else {
      await api.storage.setJson(injectPath2(chatId), injects);
    }
  } catch (e) {}
}
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
  if (INJECT_PREFIX_RE.test(text)) {
    const body = text.replace(/^\s*\/inject\s*/i, "");
    const { args, content } = parseInjectArgs2(body);
    if (content.trim()) {
      const resolvedContent = await resolveMacroText(content.trim(), chatId, undefined, userId, DEFERRED_MACRO_NAMES2);
      const id = args.id ?? Math.random().toString(36).slice(2, 10);
      const spec = {
        id,
        content: resolvedContent,
        role: args.role === "user" || args.role === "assistant" ? args.role : "system",
        depth: Math.max(0, parseInt(args.depth ?? "0", 10) || 0),
        position: args.position === "before" || args.position === "after" ? args.position : "chat",
        turns: Math.max(0, parseInt(args.turns ?? "0", 10) || 0)
      };
      const injects = await readInjectsFromStorage(chatId);
      const existing = injects.findIndex((e) => e.id === id);
      if (existing >= 0) {
        injects[existing] = spec;
      } else {
        injects.push(spec);
      }
      await writeInjectsToStorage(chatId, injects);
    }
    return { handled: true, kind: "inject" };
  }
  if (FLUSHINJECT_PREFIX_RE.test(text)) {
    const body = text.replace(/^\s*\/flushinject\s*/i, "").trim();
    const idMatch = /^id=(\S+)/.exec(body);
    const id = idMatch ? idMatch[1] : null;
    let injects = await readInjectsFromStorage(chatId);
    injects = id ? injects.filter((e) => e.id !== id) : [];
    await writeInjectsToStorage(chatId, injects);
    return { handled: true, kind: "flushinject" };
  }
  if (LISTINJECTS_PREFIX_RE.test(text)) {
    const injects = await readInjectsFromStorage(chatId);
    try {
      await api.variables.chat.set(chatId, VISHRUN_INJECTS_VAR, JSON.stringify(injects));
    } catch (e) {}
    return { handled: true, kind: "listinjects" };
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

// src/backend/mvu-yaml.ts
var INT_RE = /^-?\d+$/;
var FLOAT_RE = /^-?\d+\.\d+$/;
function parseScalar(raw) {
  const v = raw.trim();
  if (INT_RE.test(v))
    return parseInt(v, 10);
  if (FLOAT_RE.test(v))
    return parseFloat(v);
  return v;
}
function tokenizeLines(source) {
  const out = [];
  const lines = source.split(/\r?\n/).map((l) => l.replace(/\r+$/, ""));
  for (let i = 0;i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#"))
      continue;
    const m = /^( *)(.*)$/.exec(line);
    if (!m)
      continue;
    const indent = m[1].length;
    const rest = m[2];
    if (rest === "")
      continue;
    const sepIdx = rest.indexOf(": ");
    let key;
    let value;
    if (sepIdx >= 0) {
      key = rest.slice(0, sepIdx).trim();
      value = rest.slice(sepIdx + 2);
    } else if (rest.endsWith(":")) {
      key = rest.slice(0, -1).trim();
      value = null;
    } else {
      console.warn("[vishrun:mvu-yaml] skipped malformed line", { lineNo: i + 1, line });
      continue;
    }
    if (key === "") {
      console.warn("[vishrun:mvu-yaml] skipped empty-key line", { lineNo: i + 1, line });
      continue;
    }
    out.push({ lineNo: i + 1, indent, key, value });
  }
  return out;
}
function parseYaml(source) {
  const tokens = tokenizeLines(source);
  const root = {};
  const stack = [
    { indent: -1, container: root }
  ];
  for (const t of tokens) {
    while (stack.length > 1 && stack[stack.length - 1].indent >= t.indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1].container;
    if (t.value === null) {
      const child = {};
      parent[t.key] = child;
      stack.push({ indent: t.indent, container: child });
    } else {
      parent[t.key] = parseScalar(t.value);
    }
  }
  return root;
}

// src/backend/mvu-lodash.ts
var CMD_RE = /_\.([a-zA-Z][a-zA-Z0-9_]*)\s*\(/g;
var SNIPPET_LEN = 80;
function parseLodashSetCalls(blockContent, onUnsupported) {
  const out = [];
  CMD_RE.lastIndex = 0;
  let m;
  while ((m = CMD_RE.exec(blockContent)) !== null) {
    const cmd = m[1];
    const callStart = m.index;
    const argsStart = m.index + m[0].length;
    const argsParse = scanArgList(blockContent, argsStart);
    if (argsParse === null) {
      onUnsupported?.(snippet(blockContent, callStart), "malformed-call");
      continue;
    }
    const { args, endIndex } = argsParse;
    if (cmd !== "set") {
      onUnsupported?.(snippet(blockContent, callStart), "not-dot-set");
      CMD_RE.lastIndex = endIndex;
      continue;
    }
    if (args.length !== 2 && args.length !== 3) {
      onUnsupported?.(snippet(blockContent, callStart), "malformed-call");
      CMD_RE.lastIndex = endIndex;
      continue;
    }
    const pathArg = args[0].trim();
    const valueArg = args[args.length - 1].trim();
    const path = parseStringLiteral(pathArg);
    if (path === null || path.length === 0) {
      onUnsupported?.(snippet(blockContent, callStart), "path-not-string-literal");
      CMD_RE.lastIndex = endIndex;
      continue;
    }
    const newValue = parseLiteralValue(valueArg);
    if (newValue === undefined) {
      onUnsupported?.(snippet(blockContent, callStart), "value-not-literal");
      CMD_RE.lastIndex = endIndex;
      continue;
    }
    out.push({ path, newValue, index: callStart });
    CMD_RE.lastIndex = endIndex;
  }
  return out;
}
function snippet(src, start) {
  return src.slice(start, start + SNIPPET_LEN);
}
function scanArgList(src, start) {
  const args = [];
  let cur = "";
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let inString = null;
  let i = start;
  while (i < src.length) {
    const c = src[i];
    if (inString !== null) {
      cur += c;
      if (c === "\\" && i + 1 < src.length) {
        cur += src[i + 1];
        i += 2;
        continue;
      }
      if (c === inString)
        inString = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = c;
      cur += c;
      i++;
      continue;
    }
    if (c === "(") {
      parenDepth++;
      cur += c;
      i++;
      continue;
    }
    if (c === "[") {
      bracketDepth++;
      cur += c;
      i++;
      continue;
    }
    if (c === "{") {
      braceDepth++;
      cur += c;
      i++;
      continue;
    }
    if (c === ")") {
      if (parenDepth === 0) {
        if (cur.length > 0 || args.length > 0)
          args.push(cur);
        return { args, endIndex: i + 1 };
      }
      parenDepth--;
      cur += c;
      i++;
      continue;
    }
    if (c === "]") {
      if (bracketDepth > 0)
        bracketDepth--;
      cur += c;
      i++;
      continue;
    }
    if (c === "}") {
      if (braceDepth > 0)
        braceDepth--;
      cur += c;
      i++;
      continue;
    }
    if (c === "," && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      args.push(cur);
      cur = "";
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  return null;
}
function parseStringLiteral(raw) {
  if (raw.length < 2)
    return null;
  const open = raw[0];
  if (open !== '"' && open !== "'")
    return null;
  if (raw[raw.length - 1] !== open)
    return null;
  const inner = raw.slice(1, -1);
  if (inner.indexOf("\\") !== -1)
    return null;
  if (inner.indexOf("[") !== -1 || inner.indexOf("]") !== -1)
    return null;
  if (inner.indexOf(open) !== -1)
    return null;
  return inner;
}
function parseLiteralValue(raw) {
  const t = raw.trim();
  if (t === "true")
    return true;
  if (t === "false")
    return false;
  if (t === "null")
    return null;
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0]) {
    const inner = parseStringLiteral(t);
    if (inner === null)
      return;
    if (/^[+-]\d/.test(inner))
      return;
    return inner;
  }
  if (/^-?\d+(?:\.\d+)?$/.test(t))
    return parseFloat(t);
  return;
}

// src/core/diagnostics.ts
var VSH_VISHRUN_DIAG = false;

// src/backend/mvu-parser.ts
function emptyMvuData() {
  return { stat_data: {} };
}
function resolveActiveContent(msg) {
  const swipes = msg.swipes;
  const swipeId = typeof msg.swipe_id === "number" ? msg.swipe_id : 0;
  if (Array.isArray(swipes) && swipes.length > 0) {
    const c = swipes[swipeId];
    if (typeof c === "string" && c.length > 0)
      return c;
  }
  if (typeof msg.content === "string")
    return msg.content;
  return "";
}
var BLOCK_RE = /<UpdateVariable>([\s\S]*?)<\/UpdateVariable>/gim;
var INITVAR_RE = /<initvar>(?:\s*```.*)?([\s\S]*?)(?:```\s*)?<\/initvar>/gim;
function extractUpdateVariableBlocks(content) {
  if (typeof content !== "string" || !/<updatevariable>/i.test(content))
    return [];
  const out = [];
  for (const m of content.matchAll(BLOCK_RE))
    out.push(m[1]);
  return out;
}
var InitvarYamlRecognizer = {
  name: "initvar-yaml",
  extract(block) {
    const ops = [];
    for (const m of block.matchAll(INITVAR_RE)) {
      try {
        const payload = parseYaml(m[1]);
        ops.push({ kind: "replace_stat_data", index: m.index ?? 0, payload });
      } catch (err) {
        console.warn("[vishrun:mvu-parser] initvar yaml parse failed:", err instanceof Error ? err.message : String(err));
      }
    }
    return ops;
  }
};
var LodashSetRecognizer = {
  name: "lodash-set",
  extract(block, ctx) {
    const calls = parseLodashSetCalls(block, (snippet, reason) => {
      ctx?.onDiagnostic?.("unknown-command", { snippet, reason });
    });
    return calls.map((c) => ({
      kind: "set_path",
      index: c.index,
      path: c.path,
      value: c.newValue
    }));
  }
};
var recognizers = [InitvarYamlRecognizer, LodashSetRecognizer];
function parseDottedPath(path) {
  if (path.length === 0)
    return null;
  if (path.indexOf("[") !== -1 || path.indexOf("]") !== -1)
    return null;
  if (path.indexOf("\\") !== -1)
    return null;
  return path.split(".");
}
function setDeepImmutable(root, segments, value) {
  if (segments.length === 0)
    return root;
  const [head, ...rest] = segments;
  if (rest.length === 0) {
    return { ...root, [head]: value };
  }
  const child = root[head];
  const childObj = child !== null && typeof child === "object" && !Array.isArray(child) ? child : {};
  return { ...root, [head]: setDeepImmutable(childObj, rest, value) };
}
function applyOperation(state, op) {
  if (op.kind === "replace_stat_data") {
    const payload = op.payload;
    return { ...state, stat_data: { ...payload } };
  }
  if (op.kind === "set_path") {
    const sop = op;
    const segments = parseDottedPath(sop.path);
    if (segments === null) {
      return state;
    }
    const currentStatData = state.stat_data && typeof state.stat_data === "object" && !Array.isArray(state.stat_data) ? state.stat_data : {};
    const nextStatData = setDeepImmutable(currentStatData, segments, sop.value);
    return { ...state, stat_data: nextStatData };
  }
  return state;
}
function fnv1a(s) {
  let h = 2166136261;
  for (let i = 0;i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = h * 16777619 >>> 0;
  }
  return h >>> 0;
}
function stripUpdateVariableBlocks(s) {
  return s.replace(/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/gi, "");
}
function hashStripped(s) {
  return fnv1a(stripUpdateVariableBlocks(s));
}
async function computeVariablesSnapshot(messages, recoveryFetcher) {
  let state = emptyMvuData();
  let cachedCandidates = null;
  let candidatesTried = false;
  for (const msg of messages) {
    if (!msg)
      continue;
    const activeContent = resolveActiveContent(msg);
    if (activeContent.length === 0)
      continue;
    let blocks = extractUpdateVariableBlocks(activeContent);
    if (blocks.length === 0 && msg.index_in_chat === 0 && recoveryFetcher !== undefined) {
      if (!candidatesTried) {
        candidatesTried = true;
        try {
          cachedCandidates = await recoveryFetcher();
        } catch (err) {
          console.warn("[vishrun:mvu-parser] recovery fetcher threw:", err instanceof Error ? err.message : String(err));
          cachedCandidates = [];
        }
      }
      const candidates = cachedCandidates ?? [];
      const targetHash = hashStripped(activeContent);
      let matchIdx = -1;
      for (let i = 0;i < candidates.length; i++) {
        const c = candidates[i];
        if (typeof c !== "string")
          continue;
        if (hashStripped(c) === targetHash) {
          matchIdx = i;
          break;
        }
      }
      if (matchIdx >= 0) {
        blocks = extractUpdateVariableBlocks(candidates[matchIdx]);
      }
    }
    const messageIdForCtx = typeof msg.id === "string" ? msg.id : null;
    const recognizerCtx = {
      messageId: messageIdForCtx,
      onDiagnostic: (event, payload) => {
        if (!VSH_VISHRUN_DIAG)
          return;
        console.log(`[vishrun:mvu-parser] ${event}`, JSON.stringify({
          messageId: messageIdForCtx,
          ...payload
        }));
      }
    };
    for (const block of blocks) {
      const ops = [];
      for (const r of recognizers)
        ops.push(...r.extract(block, recognizerCtx));
      ops.sort((a, b) => a.index - b.index);
      for (const op of ops) {
        state = applyOperation(state, op);
      }
    }
  }
  return state;
}

// src/backend/th-helpers.ts
var LOG_PREFIX2 = "[vishrun:th-helpers]";
var log = {
  warn: (...args) => console.warn(LOG_PREFIX2, ...args),
  debug: (...args) => console.debug(LOG_PREFIX2, ...args)
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
var JSLR_DATA_EXTRA_KEY = "__vishrun_jslr_message_data_v1";
function shapeSnapshotMessage(msg) {
  const role = msg.role === "system" || msg.role === "user" || msg.role === "assistant" ? msg.role : msg.is_user ? "user" : "assistant";
  const swipes = Array.isArray(msg.swipes) && msg.swipes.length > 0 ? msg.swipes : [msg.content];
  const rawExtra = msg.extra ?? {};
  const storedData = rawExtra[JSLR_DATA_EXTRA_KEY];
  const data = storedData && typeof storedData === "object" && !Array.isArray(storedData) ? { ...storedData } : {};
  const extra = { ...rawExtra };
  delete extra[JSLR_DATA_EXTRA_KEY];
  return {
    id: msg.id,
    message_id: msg.index_in_chat,
    name: msg.name,
    role,
    is_hidden: rawExtra.hidden === true,
    message: msg.content,
    swipe_id: msg.swipe_id ?? 0,
    swipes,
    data,
    extra
  };
}
async function fetchCharacterGreetings(messages, chatId, userId, chats, characters) {
  const msg0 = messages[0];
  let charId = null;
  const fromExtra = msg0?.extra?.character_id;
  if (typeof fromExtra === "string" && fromExtra.length > 0) {
    charId = fromExtra;
  } else {
    const chatDto = await chats.get(chatId, userId);
    if (chatDto && typeof chatDto.character_id === "string")
      charId = chatDto.character_id;
  }
  if (!charId)
    return [];
  const card = await characters.get(charId, userId);
  if (!card)
    return [];
  const first = typeof card.first_mes === "string" ? card.first_mes : "";
  const alt = Array.isArray(card.alternate_greetings) ? card.alternate_greetings : [];
  return [first, ...alt];
}
async function handleGetMessagesSnapshot(chatId, userId, chat = api.chat, chats = api.chats, characters = api.characters) {
  const messages = await chat.getMessages(chatId);
  const snapshot = messages.map((m) => shapeSnapshotMessage(m));
  if (snapshot.length > 0 && snapshot[0].role !== "user" && snapshot[0].swipes.length <= 1) {
    try {
      const greetings = await fetchCharacterGreetings(messages, chatId, userId, chats, characters);
      if (greetings.length > 1) {
        const activeIdx = snapshot[0].swipe_id >= 0 && snapshot[0].swipe_id < greetings.length ? snapshot[0].swipe_id : 0;
        const aligned = greetings.slice();
        aligned[activeIdx] = snapshot[0].message;
        snapshot[0].swipes = aligned;
        try {
          await chat.updateMessage(chatId, messages[0].id, { swipes: aligned, swipe_id: activeIdx });
        } catch (persistErr) {
          log.warn("initial-message swipes persist failed (read serves derived):", persistErr instanceof Error ? persistErr.message : String(persistErr));
        }
      }
    } catch (err) {
      log.warn("initial-message swipes derive failed:", err instanceof Error ? err.message : String(err));
    }
  }
  return snapshot;
}
async function handleGetVariablesSnapshot(chatId, userId, chat = api.chat, chats = api.chats, characters = api.characters) {
  try {
    const messages = await chat.getMessages(chatId);
    return await computeVariablesSnapshot(messages, () => fetchCharacterGreetings(messages, chatId, userId, chats, characters));
  } catch (err) {
    log.warn("getVariablesSnapshot failed:", err instanceof Error ? err.message : String(err));
    return emptyMvuData();
  }
}
async function handleCreateChatMessages(body, chatId, chat = api.chat) {
  const rawMessages = body.chatMessages;
  if (!Array.isArray(rawMessages))
    throw new TypeError("chat_messages must be an array");
  const messages = rawMessages.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new TypeError(`chat_messages[${index}] must be an object`);
    }
    const item = raw;
    if (item.role !== "system" && item.role !== "assistant" && item.role !== "user") {
      throw new TypeError(`chat_messages[${index}].role must be system, assistant, or user`);
    }
    if (typeof item.message !== "string") {
      throw new TypeError(`chat_messages[${index}].message must be a string`);
    }
    if (item.name !== undefined && typeof item.name !== "string") {
      throw new TypeError(`chat_messages[${index}].name must be a string`);
    }
    if (item.is_hidden !== undefined && typeof item.is_hidden !== "boolean") {
      throw new TypeError(`chat_messages[${index}].is_hidden must be a boolean`);
    }
    if (item.data !== undefined && (!item.data || typeof item.data !== "object" || Array.isArray(item.data))) {
      throw new TypeError(`chat_messages[${index}].data must be an object`);
    }
    if (item.extra !== undefined && (!item.extra || typeof item.extra !== "object" || Array.isArray(item.extra))) {
      throw new TypeError(`chat_messages[${index}].extra must be an object`);
    }
    return item;
  });
  const rawOptions = body.options;
  const options = rawOptions && typeof rawOptions === "object" && !Array.isArray(rawOptions) ? rawOptions : {};
  if (options.refresh !== undefined && options.refresh !== "none" && options.refresh !== "affected" && options.refresh !== "all") {
    throw new TypeError("refresh must be none, affected, or all");
  }
  const before = options.insert_at ?? options.insert_before ?? "end";
  if (before !== "end") {
    if (typeof before !== "number" || !Number.isFinite(before)) {
      throw new TypeError("insert_before must be a number or end");
    }
    const existing = await chat.getMessages(chatId);
    const clamped = Math.max(-existing.length, Math.min(existing.length, Math.trunc(before)));
    if (clamped !== existing.length) {
      throw new Error("Lumiverse does not expose safe indexed message insertion; createChatMessages currently supports insert_before/insert_at only when it resolves to the end");
    }
  }
  const ids = [];
  for (const message of messages) {
    const created = await chat.appendMessage(chatId, { role: message.role, content: message.message });
    ids.push(created.id);
  }
  if (ids.length === 0)
    return { created: [] };
  const current = await chat.getMessages(chatId);
  const indexById = new Map;
  for (const message of current)
    indexById.set(message.id, message.index_in_chat);
  return {
    created: ids.map((id, index) => ({
      id,
      message_id: indexById.get(id) ?? current.length - ids.length + index
    }))
  };
}
async function handleTriggerSlash(body, chatId, userId) {
  const command = body.command;
  if (typeof command !== "string")
    throw new TypeError("triggerSlash command must be a string");
  const result = await dispatchSlashText(command, chatId, userId);
  if (!result.handled) {
    throw new Error(`Unsupported slash command in Vishrun triggerSlash: ${command}`);
  }
  return "";
}
async function handleSetChatMessage(body, chatId, currentMessageIndex, chat = api.chat) {
  const fieldValues = body.fieldValues ?? {};
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
  await chat.updateMessage(chatId, target.id, { content });
}
async function handleSetVariable(body, chatId, chat = api.chat) {
  const key = body.key;
  const value = body.value;
  if (!key) {
    log.warn("setVariable: no key provided, ignoring");
    return;
  }
  const messages = await chat.getMessages(chatId);
  if (messages.length === 0) {
    log.warn("setVariable: empty chat, ignoring");
    return;
  }
  const latest = messages[messages.length - 1];
  const existing = latest.content ?? "";
  const varBlock = `
<UpdateVariable>
${key}: ${JSON.stringify(value)}
</UpdateVariable>`;
  await chat.updateMessage(chatId, latest.id, { content: existing + varBlock });
  log.debug("setVariable: set", key, "=", value);
}
var variableWrites = new Map;
function handleReplaceChatVariables(body, chatId, userId, chats = api.chats) {
  const key = JSON.stringify([userId, chatId]);
  const work = (variableWrites.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
    if (!chatId || body.chatId !== chatId)
      throw new Error("Chat variable target does not match the requesting frame");
    const variables = body.variables;
    if (!variables || typeof variables !== "object" || Array.isArray(variables)) {
      throw new TypeError("Variables must be an object");
    }
    const current = await chats.get(chatId, userId);
    if (!current)
      throw new Error("Chat not found");
    const updated = await chats.update(chatId, {
      metadata: { ...current.metadata, chat_variables: variables }
    }, userId);
    if (!updated)
      throw new Error("Chat variable save failed");
    const meta = updated.metadata ?? {};
    const macro = meta.macro_variables ?? {};
    const saved = meta.chat_variables ?? {};
    return { chatId, variables: saved, allVariables: { ...macro.global, ...macro.local, ...saved } };
  });
  variableWrites.set(key, work);
  work.finally(() => {
    if (variableWrites.get(key) === work)
      variableWrites.delete(key);
  }).catch(() => {});
  return work;
}
function installThHelpersHandler() {
  api.onFrontendMessage((payload, userId) => {
    if (!isThHelpersRequest(payload))
      return;
    const { requestId, op, chatId, currentMessageIndex, body } = payload;
    (async () => {
      let response;
      try {
        if (op === "th-get-messages-snapshot") {
          const result = await handleGetMessagesSnapshot(chatId, userId);
          response = { type: "th_helpers_response", requestId, ok: true, result };
        } else if (op === "th-get-variables-snapshot") {
          const result = await handleGetVariablesSnapshot(chatId, userId);
          response = { type: "th_helpers_response", requestId, ok: true, result };
        } else if (op === "th-set-chat-message") {
          await handleSetChatMessage(body, chatId, currentMessageIndex);
          response = { type: "th_helpers_response", requestId, ok: true, result: undefined };
        } else if (op === "th-create-chat-messages") {
          const result = await handleCreateChatMessages(body, chatId);
          response = { type: "th_helpers_response", requestId, ok: true, result };
        } else if (op === "th-trigger-slash") {
          const result = await handleTriggerSlash(body, chatId, userId);
          response = { type: "th_helpers_response", requestId, ok: true, result };
        } else if (op === "th-replace-chat-variables") {
          const result = await handleReplaceChatVariables(body, chatId, userId);
          response = { type: "th_helpers_response", requestId, ok: true, result };
        } else if (op === "th-set-variable") {
          await handleSetVariable(body, chatId);
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

// src/backend/generate-relay.ts
var pendingGenerateRelays = new Map;
function isGenerateRelayCancelRequest(p) {
  return !!p && typeof p === "object" && p.type === "vsh_generate_cancel" && typeof p.requestId === "string";
}
function isGenerateRelayRequest(p) {
  return !!p && typeof p === "object" && p.type === "vsh_generate" && typeof p.requestId === "string" && Array.isArray(p.messages);
}
function installGenerateRelayHandler() {
  api.onFrontendMessage((payload, userId) => {
    if (isGenerateRelayCancelRequest(payload)) {
      const pending = pendingGenerateRelays.get(payload.requestId);
      if (pending && pending.userId === userId)
        pending.controller.abort();
      return;
    }
    if (!isGenerateRelayRequest(payload))
      return;
    const { requestId, messages, provider, model, connection_id, parameters, tools, tool_choice } = payload;
    const controller = new AbortController;
    pendingGenerateRelays.set(requestId, { userId, controller });
    const input = {
      provider: provider || "",
      model: model || "",
      messages,
      userId,
      signal: controller.signal
    };
    if (connection_id)
      input.connection_id = connection_id;
    if (parameters)
      input.parameters = parameters;
    if (tools && Array.isArray(tools)) {
      input.tools = tools.map((t) => {
        if (t?.type === "function" && t?.function) {
          return {
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters,
            ...t.function.strict !== undefined ? { strict: t.function.strict } : {}
          };
        }
        return t;
      });
    }
    if (tool_choice) {
      if (!input.parameters)
        input.parameters = {};
      input.parameters.tool_choice = tool_choice;
    }
    api.generate.raw(input).then((result) => {
      api.sendToFrontend({ type: "vsh_generate_result", requestId, result }, userId);
    }, (err) => {
      const name = err instanceof Error ? err.name : "";
      const message = err instanceof Error ? err.message : String(err);
      api.sendToFrontend({
        type: "vsh_generate_error",
        requestId,
        error: name === "AbortError" ? `AbortError: ${message || "Generation aborted"}` : message
      }, userId);
    }).finally(() => {
      const pending = pendingGenerateRelays.get(requestId);
      if (pending?.controller === controller)
        pendingGenerateRelays.delete(requestId);
    });
  });
}

// src/backend/user-message-bridge.ts
var LOG_PREFIX3 = "[vishrun:user-message]";
var FRONTEND_TIMEOUT_MS = 110000;
var HOST_TIMEOUT_MS = 120000;
var subscribedUsers2 = new Set;
var pendingRequests2 = new Map;
function isSubscriptionMessage2(payload) {
  return !!payload && typeof payload === "object" && payload.type === "vsh_user_message_subscription" && typeof payload.active === "boolean";
}
function isCompleteMessage2(payload) {
  if (!payload || typeof payload !== "object")
    return false;
  const value = payload;
  return value.type === "vsh_user_message_complete" && typeof value.requestId === "string" && (value.content === undefined || typeof value.content === "string") && (value.cancelGeneration === undefined || typeof value.cancelGeneration === "boolean") && (value.removeMessage === undefined || typeof value.removeMessage === "boolean") && (value.error === undefined || typeof value.error === "string");
}
function clearPending2(requestId) {
  const pending = pendingRequests2.get(requestId);
  if (!pending)
    return null;
  pendingRequests2.delete(requestId);
  clearTimeout(pending.timer);
  if (pending.signal && pending.abortHandler) {
    pending.signal.removeEventListener("abort", pending.abortHandler);
  }
  return pending;
}
function releasePendingForUser2(userId) {
  for (const [requestId, pending] of pendingRequests2) {
    if (pending.userId !== userId)
      continue;
    clearPending2(requestId)?.resolve(null);
  }
}
async function findLatestUserMessage(chatId) {
  const messages = await api.chat.getMessages(chatId);
  for (let index = messages.length - 1;index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "user" || typeof message.id !== "string" || typeof message.content !== "string")
      continue;
    return { id: message.id, content: message.content };
  }
  return null;
}
async function requestFrontendProcessing(context, message) {
  const { chatId, userId, generationType, signal } = context;
  if (!chatId || !userId)
    return null;
  if (signal?.aborted)
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const pending = clearPending2(requestId);
      if (!pending)
        return;
      api.sendToFrontend({ type: "vsh_user_message_cancel", requestId }, userId);
      console.warn(LOG_PREFIX3, `frontend handler timed out after ${FRONTEND_TIMEOUT_MS}ms; using original message`);
      pending.resolve(null);
    }, FRONTEND_TIMEOUT_MS);
    const pending = {
      userId,
      chatId,
      messageId: message.id,
      originalContent: message.content,
      resolve,
      timer,
      signal
    };
    if (signal) {
      pending.abortHandler = () => {
        const active = clearPending2(requestId);
        if (!active)
          return;
        api.sendToFrontend({ type: "vsh_user_message_cancel", requestId }, userId);
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      };
      signal.addEventListener("abort", pending.abortHandler, { once: true });
    }
    pendingRequests2.set(requestId, pending);
    api.sendToFrontend({
      type: "vsh_user_message_request",
      requestId,
      chatId,
      message: { id: message.id, content: message.content },
      ...generationType ? { generationType } : {}
    }, userId);
  });
}
async function processGenerationContext(context) {
  const { chatId, userId, generationType, dryRun } = context;
  if (!chatId || !userId || dryRun || generationType !== "normal" || !subscribedUsers2.has(userId)) {
    return context;
  }
  const message = await findLatestUserMessage(chatId);
  if (!message)
    return context;
  const result = await requestFrontendProcessing(context, message);
  if (!result)
    return context;
  if (result.error) {
    console.warn(LOG_PREFIX3, "frontend handler reported an error:", result.error);
  }
  if (result.cancelGeneration) {
    if (result.removeMessage) {
      try {
        await api.chat.deleteMessage(chatId, message.id);
      } catch (error) {
        console.warn(LOG_PREFIX3, "failed to remove cancelled user message:", error instanceof Error ? error.message : String(error));
      }
    }
    return { ...context, cancelGeneration: true };
  }
  if (typeof result.content === "string" && result.content !== message.content) {
    await api.chat.updateMessage(chatId, message.id, { content: result.content });
  }
  return context;
}
function installUserMessageBridgeHandler() {
  api.onFrontendMessage((payload, userId) => {
    if (isSubscriptionMessage2(payload)) {
      if (payload.active) {
        subscribedUsers2.add(userId);
      } else {
        subscribedUsers2.delete(userId);
        releasePendingForUser2(userId);
      }
      return;
    }
    if (!isCompleteMessage2(payload))
      return;
    const pending = pendingRequests2.get(payload.requestId);
    if (!pending || pending.userId !== userId)
      return;
    clearPending2(payload.requestId)?.resolve(payload);
  });
  api.registerContextHandler(async (rawContext) => processGenerationContext(rawContext), 40, { timeoutMs: HOST_TIMEOUT_MS });
}

// src/backend/index.ts
installFetchExternalHandler();
installMacroResolveHandler();
installMessageContentProcessor();
installDispatchSlashHandler();
installThHelpersHandler();
installGenerateRelayHandler();
installPreGenerationBridgeHandler();
installUserMessageBridgeHandler();
function setup() {}
export {
  setup
};
