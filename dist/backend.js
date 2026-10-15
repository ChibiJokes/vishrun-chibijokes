// ChibiJokes + upstream Vishrun, transpiled TypeScript module bundle.
// Built without changing the original module API or adding runtime dependencies.
const __vishrunModules = {
"src/backend/index.ts": function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setup = setup;
const fetch_external_1 = require("./fetch-external");
const macro_resolve_1 = require("./macro-resolve");
const message_content_processor_1 = require("./message-content-processor");
const dispatch_slash_1 = require("./dispatch-slash");
const th_helpers_1 = require("./th-helpers");
const generate_relay_1 = require("./generate-relay");
const pre_generation_bridge_1 = require("./pre-generation-bridge");
const user_message_bridge_1 = require("./user-message-bridge");
const message_render_bridge_1 = require("./message-render-bridge");
const common_1 = require("./common");
function isNativeResourceRequest(payload) {
    if (!payload || typeof payload !== 'object')
        return false;
    const value = payload;
    return (value.type === 'vsh_native_resource' &&
        typeof value.requestId === 'string' &&
        (value.resource === 'personas' || value.resource === 'world_books' || value.resource === 'chat' || value.resource === 'message_render' || value.resource === 'tokens') &&
        typeof value.operation === 'string' &&
        (value.args === undefined || Array.isArray(value.args)));
}
async function dispatchNativeResource(request, userId) {
    const args = Array.isArray(request.args) ? request.args : [];
    if (request.resource === 'personas') {
        switch (request.operation) {
            case 'list':
                return common_1.api.personas.list({ ...(args[0] ?? {}), userId });
            case 'get':
                return common_1.api.personas.get(String(args[0] ?? ''), userId);
            case 'getDefault':
                return common_1.api.personas.getDefault(userId);
            case 'getActive':
                return common_1.api.personas.getActive(userId);
            case 'create':
                return common_1.api.personas.create((args[0] ?? {}), userId);
            case 'update':
                return common_1.api.personas.update(String(args[0] ?? ''), (args[1] ?? {}), userId);
            case 'delete':
                return common_1.api.personas.delete(String(args[0] ?? ''), userId);
            case 'switchActive':
                return common_1.api.personas.switchActive(args[0] == null ? null : String(args[0]), userId);
            case 'getWorldBook':
                return common_1.api.personas.getWorldBook(String(args[0] ?? ''), userId);
            default:
                throw new Error(`Unsupported personas operation: ${request.operation}`);
        }
    }
    if (request.resource === 'chat') {
        switch (request.operation) {
            case 'getMessages':
                return common_1.api.chat.getMessages(String(args[0] ?? ''));
            case 'updateMessage':
                return common_1.api.chat.updateMessage(String(args[0] ?? ''), String(args[1] ?? ''), (args[2] ?? {}));
            default:
                throw new Error(`Unsupported chat operation: ${request.operation}`);
        }
    }
    if (request.resource === 'message_render') {
        switch (request.operation) {
            case 'hold':
                return (0, message_render_bridge_1.holdMessageRender)((args[0] ?? {}));
            case 'bind':
                return (0, message_render_bridge_1.bindMessageRender)(String(args[0] ?? ''), String(args[1] ?? ''));
            case 'allow':
                return (0, message_render_bridge_1.allowMessageRender)(String(args[0] ?? ''), String(args[1] ?? ''));
            case 'release':
                return (0, message_render_bridge_1.releaseMessageRender)(String(args[0] ?? ''), (args[1] ?? {}));
            case 'status':
                return (0, message_render_bridge_1.messageRenderStatus)(args[0] == null ? undefined : String(args[0]));
            case 'ensureOwner':
                return (0, message_render_bridge_1.ensureMessageRenderDisplayOwner)(String(args[0] ?? ''), userId);
            default:
                throw new Error(`Unsupported message_render operation: ${request.operation}`);
        }
    }
    if (request.resource === 'tokens') {
        switch (request.operation) {
            case 'countText':
                return common_1.api.tokens.countText(String(args[0] ?? ''), (args[1] ?? {}));
            default:
                throw new Error(`Unsupported tokens operation: ${request.operation}`);
        }
    }
    switch (request.operation) {
        case 'list':
            return common_1.api.world_books.list({ ...(args[0] ?? {}), userId });
        case 'get':
            return common_1.api.world_books.get(String(args[0] ?? ''), userId);
        case 'create':
            return common_1.api.world_books.create((args[0] ?? {}), userId);
        case 'update':
            return common_1.api.world_books.update(String(args[0] ?? ''), (args[1] ?? {}), userId);
        case 'delete':
            return common_1.api.world_books.delete(String(args[0] ?? ''), userId);
        case 'getActivated':
            return common_1.api.world_books.getActivated(String(args[0] ?? ''), userId);
        case 'getGlobal':
            return common_1.api.world_books.getGlobal(userId);
        case 'setGlobal':
            return common_1.api.world_books.setGlobal(Array.isArray(args[0]) ? args[0].map(String) : [], userId);
        case 'activateGlobal':
            return common_1.api.world_books.activateGlobal(String(args[0] ?? ''), userId);
        case 'deactivateGlobal':
            return common_1.api.world_books.deactivateGlobal(String(args[0] ?? ''), userId);
        case 'entries.list':
            return common_1.api.world_books.entries.list(String(args[0] ?? ''), { ...(args[1] ?? {}), userId });
        case 'entries.get':
            return common_1.api.world_books.entries.get(String(args[0] ?? ''), userId);
        case 'entries.create':
            return common_1.api.world_books.entries.create(String(args[0] ?? ''), (args[1] ?? {}), userId);
        case 'entries.update':
            return common_1.api.world_books.entries.update(String(args[0] ?? ''), (args[1] ?? {}), userId);
        case 'entries.delete':
            return common_1.api.world_books.entries.delete(String(args[0] ?? ''), userId);
        default:
            throw new Error(`Unsupported world_books operation: ${request.operation}`);
    }
}
function installNativeResourceBridge() {
    common_1.api.onFrontendMessage((payload, userId) => {
        if (!isNativeResourceRequest(payload))
            return;
        void dispatchNativeResource(payload, userId).then((result) => {
            common_1.api.sendToFrontend({ type: 'vsh_native_resource_result', requestId: payload.requestId, result }, userId);
        }, (error) => {
            common_1.api.sendToFrontend({
                type: 'vsh_native_resource_error',
                requestId: payload.requestId,
                error: error instanceof Error ? error.message : String(error),
            }, userId);
        });
    });
}
const regex_takeover_1 = require("./regex-takeover");
/**
 * Backend worker module. Vishrun is logically frontend-only, but the worker
 * must exist: its mere existence keeps the host's sandbox `corsProxy` bridge
 * alive, and it serves the frontend's backend-only needs — `fetch_external`
 * (CDN asset downloads via `spindle.cors`), `resolve_macros` (widget HTML
 * through `spindle.macros.resolve`), and the `/setvar` message content
 * processor. The host loads this with a bare `import()` and exposes the API as
 * `globalThis.spindle` first — no `setup(api)` callback — so registration runs
 * at module top level here; `setup()` stays as a no-op for the prior convention.
 */
(0, fetch_external_1.installFetchExternalHandler)();
(0, macro_resolve_1.installMacroResolveHandler)();
(0, message_content_processor_1.installMessageContentProcessor)();
(0, dispatch_slash_1.installDispatchSlashHandler)();
(0, th_helpers_1.installThHelpersHandler)();
(0, generate_relay_1.installGenerateRelayHandler)();
(0, pre_generation_bridge_1.installPreGenerationBridgeHandler)();
(0, user_message_bridge_1.installUserMessageBridgeHandler)();
(0, message_render_bridge_1.installMessageRenderBridge)();
installNativeResourceBridge();
(0, regex_takeover_1.installRegexTakeoverHandler)();
function setup() {
    // intentionally empty — registration happens at module top level (above).
}

},
"src/backend/fetch-external.ts": function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.installFetchExternalHandler = installFetchExternalHandler;
const common_1 = require("./common");
function isFetchExternalRequest(p) {
    return (!!p &&
        typeof p === 'object' &&
        p.type === 'fetch_external' &&
        typeof p.requestId === 'string' &&
        typeof p.url === 'string');
}
function extractBody(result) {
    // spindle.cors(url, { responseType: 'text' }) resolves with
    // { status, statusText, headers, body } where body is the response text.
    if (result && typeof result === 'object' && typeof result.body === 'string') {
        return result.body;
    }
    return '';
}
function installFetchExternalHandler() {
    common_1.api.onFrontendMessage((payload, userId) => {
        if (!isFetchExternalRequest(payload))
            return;
        const { requestId, url } = payload;
        const options = { responseType: 'text' };
        common_1.api.cors(url, options).then((result) => {
            common_1.api.sendToFrontend({ type: 'fetch_external_response', requestId, ok: true, body: extractBody(result) }, userId);
        }, (err) => {
            common_1.api.sendToFrontend({
                type: 'fetch_external_response',
                requestId,
                ok: false,
                error: err instanceof Error ? err.message : String(err),
            }, userId);
        });
    });
}

},
"src/backend/common.ts": function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.varsLog = exports.api = void 0;
exports.api = spindle;
// Shared prefix for variable/macro logging (setvar interceptor, resolve_macros).
const VARS_PREFIX = '[vishrun:variables]';
exports.varsLog = {
    warn: (...args) => console.warn(VARS_PREFIX, ...args),
    debug: (...args) => console.debug(VARS_PREFIX, ...args),
};

},
"src/backend/macro-resolve.ts": function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LOCAL_DYNAMIC_MACRO_NAMES = exports.DYNAMIC_VAR_MACRO_NAMES = void 0;
exports.applyAndStripSetvars = applyAndStripSetvars;
exports.resolveMacroText = resolveMacroText;
exports.resolveDynamicVarMacros = resolveDynamicVarMacros;
exports.resolveLocalDynamicMacros = resolveLocalDynamicMacros;
exports.installMacroResolveHandler = installMacroResolveHandler;
const common_1 = require("./common");
const setvar_ops_1 = require("./setvar-ops");
function isResolveMacrosRequest(p) {
    if (!p || typeof p !== 'object')
        return false;
    const r = p;
    return (r.type === 'resolve_macros' &&
        typeof r.requestId === 'string' &&
        typeof r.chatId === 'string' &&
        Array.isArray(r.templates) &&
        r.templates.every((t) => typeof t === 'string'));
}
// ─── Mask non-macro `{{...}}` before handing the template to the engine ──────
//
// Lumiverse's macro engine touches *every* `{{...}}` it sees, including ones
// that aren't SillyTavern macros — JSX inline styles (`style={{position:...}}`),
// JS template literals, etc. — and mangles them (a stray char → broken JSX →
// the widget iframe fails to compile). So before `spindle.macros.resolve`, we
// replace each `{{...}}` not on the allowlist with a unique NUL-delimited
// sentinel (`<NUL>VSHMSK<n><NUL>`), then restore the originals after the resolve.
// NUL never appears in legitimate HTML or macro-engine output, so the sentinel
// can't collide on unmask; we still strip any stray NUL from the input first
// (illegal in HTML anyway) to keep that guarantee.
const VALID_MACRO_NAMES = [
    'getvar', 'setvar', 'addvar', 'incvar', 'decvar',
    'getchatvar', 'setchatvar',
    'getgvar', 'setgvar', 'getglobalvar', 'setglobalvar',
    'user', 'char', 'group',
    'newline', 'input', 'random',
    'roll',
    'pick',
];
// `i` flag: SillyTavern macros are case-insensitive ({{GetVar}}, {{getVar}},
// {{GETVAR}} all resolve in vanilla ST). Without it, any non-lowercase
// spelling fails this allowlist check, gets masked as "not a real macro",
// and is restored verbatim — i.e. it silently renders as the raw
// `{{GetVar::...}}` string instead of resolving. That's indistinguishable
// from a genuinely broken macro from the user's perspective, so case
// must not gate this check.
const VALID_MACRO_RE = new RegExp(`^\\{\\{(?:${VALID_MACRO_NAMES.join('|')})(?:::|\\}\\})`, 'i');
const NUL = String.fromCharCode(0);
const SENTINEL_RE = new RegExp(`${NUL}VSHMSK(\\d+)${NUL}`, 'g');
// Macro names whose `{{macro}}` form gets resolved directly against
// api.variables.* instead of the full api.macros.resolve engine — see
// resolveDynamicVarMacros below. Both of these read APIs accept only
// (chatId, key), no userId, so they're callable from the interceptor
// (which has no userId) and can re-resolve on every single generation
// instead of being frozen at /inject time.
exports.DYNAMIC_VAR_MACRO_NAMES = new Set(['getvar', 'getchatvar']);
// Macro names that resolve with zero host lookup at all — no chatId,
// characterId, or userId needed, just local computation (Math.random()) or
// data the interceptor already has in hand (the message array). Unlike
// DYNAMIC_VAR_MACRO_NAMES these never touch api.* — see resolveLocalDynamicMacros.
//
// {{user}}/{{char}}/{{group}} are NOT here: those need personas.get /
// characters.get, and the host (worker-host.ts handlePersonasGet et al.)
// hard-requires a resolved userId — "userId is required for operator-scoped
// extensions" — which the interceptor's context never carries (confirmed
// against interceptor-pipeline.ts: handler(messages, context) never receives
// the userId argument that run() takes; generate.service.ts's spindleContext
// is only {chatId, connectionId, personaId, generationType}). That's a hard
// host-API ceiling for an operator-scoped extension, not something fixable
// from this side.
exports.LOCAL_DYNAMIC_MACRO_NAMES = new Set([
    'random', 'roll', 'pick', 'newline', 'input',
]);
function maskInvalidMacros(template, deferNames = new Set()) {
    const masks = [];
    const masked = template.split(NUL).join('').replace(/\{\{[^{}]+\}\}/g, (match) => {
        const nameMatch = match.match(/^\{\{\s*([A-Za-z_@$][\w@$]*)/);
        const name = nameMatch ? nameMatch[1].toLowerCase() : '';
        if (deferNames.has(name)) {
            // Intentionally held back — caller wants this name left literal
            // (e.g. /inject-time resolve deferring getvar/getchatvar so they
            // survive into storage and get resolved fresh at generation time).
            const idx = masks.length;
            masks.push(match);
            return `${NUL}VSHMSK${idx}${NUL}`;
        }
        if (VALID_MACRO_RE.test(match))
            return match; // real macro — let the engine handle it
        const idx = masks.length;
        masks.push(match);
        return `${NUL}VSHMSK${idx}${NUL}`;
    });
    return { masked, masks };
}
function unmaskInvalidMacros(text, masks) {
    if (masks.length === 0)
        return text;
    return text.replace(SENTINEL_RE, (_m, idx) => masks[Number(idx)] ?? '');
}
// ─── Apply + strip `{{setvar/setchatvar/setgvar/setglobalvar}}` ──────────────
//
// `api.macros.resolve` does NOT persist setvars: the env Map built per call is
// discarded after evaluate(), regardless of `commit`. So {{setvar::yen::5000}}
// inside a widget template evaluates but vanishes — the next widget's
// {{getvar::yen}} sees nothing. To fix: detect setvars BEFORE the resolve,
// apply them via api.variables.*.set (which writes to chat.metadata), strip
// them from the template, and let the rest of the macros resolve as usual.
// addvar/incvar/decvar (arithmetic ops on existing vars) and nested {{...}}
// values are NOT handled here — they pass through to the engine with
// commit:false and no-op. Re-enable if a card in scope needs them.
// `i` flag for the same reason as VALID_MACRO_RE above (ST macros are
// case-insensitive); `kind` is lowercased at capture time below since
// applySetvarOp does an exact-string `op.kind === 'setvar'` comparison.
const SETVAR_RE = /\{\{(setvar|setchatvar|setgvar|setglobalvar)::([^:}]+)::([^}]*?)\}\}/gi;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Per-chat promise queue. Serializes applyAndStripSetvars across concurrent
// resolve_macros requests so each invocation's bag.list() reflects all
// prior writes to the same chat.
const chatSetvarMutex = new Map();
async function applyAndStripSetvars(template, chatId, userId, vars = common_1.api.variables) {
    const matches = [];
    for (const m of template.matchAll(SETVAR_RE)) {
        const [match, kind, name, value] = m;
        matches.push({ start: m.index, end: m.index + match.length, kind: kind.toLowerCase(), name, value });
    }
    if (matches.length === 0)
        return template;
    const prev = chatSetvarMutex.get(chatId) ?? Promise.resolve();
    const work = prev.then(() => runApplyAndStripSetvars(template, chatId, userId, vars, matches));
    chatSetvarMutex.set(chatId, work.catch(() => undefined));
    return work;
}
async function runApplyAndStripSetvars(template, chatId, userId, vars, matches) {
    // Read current bags once per scope so we can skip idempotent writes.
    // Failure → null map → all writes proceed (safe fallback).
    let localBag = null;
    let chatBag = null;
    const needLocal = matches.some((m) => m.kind === 'setvar' && NAME_RE.test(m.name));
    const needChat = matches.some((m) => m.kind === 'setchatvar' && NAME_RE.test(m.name));
    if (needLocal) {
        try {
            localBag = await vars.local.list(chatId);
        }
        catch {
            localBag = null;
        }
    }
    if (needChat) {
        try {
            chatBag = await vars.chat.list(chatId);
        }
        catch {
            chatBag = null;
        }
    }
    const stripFlags = new Array(matches.length).fill(false);
    for (let i = 0; i < matches.length; i++) {
        const { kind, name, value } = matches[i];
        if (!NAME_RE.test(name))
            continue;
        const currentBag = kind === 'setvar' ? localBag : kind === 'setchatvar' ? chatBag : null;
        if (currentBag && currentBag[name] === value) {
            stripFlags[i] = true;
            continue;
        }
        try {
            stripFlags[i] = await (0, setvar_ops_1.applySetvarOp)({ kind: kind, name, value }, chatId, userId, vars);
            if (stripFlags[i] && currentBag)
                currentBag[name] = value;
        }
        catch (err) {
            common_1.varsLog.warn('setvar persist failed:', { kind, name, err: err instanceof Error ? err.message : String(err) });
        }
    }
    let out = '';
    let cursor = 0;
    for (let i = 0; i < matches.length; i++) {
        const { start, end } = matches[i];
        out += template.slice(cursor, start);
        if (!stripFlags[i])
            out += template.slice(start, end);
        cursor = end;
    }
    out += template.slice(cursor);
    return out;
}
// Resolve `{{macro}}` syntax in a single piece of text via the Lumiverse
// macro engine, with setvar persistence + invalid-macro masking applied
// first. Shared by installMacroResolveHandler (frontend widget templates)
// and the /inject prompt interceptor in message-content-processor.ts (the
// stored spec.content for a /inject is plain user-typed text and was never
// being run through this at all — it went straight from storage onto the
// LLM message, so `{{getchatvar::x}}` etc. inside an /inject body rendered
// as the literal string in the prompt). Never throws: falls back to the
// raw original text on any failure, same fallback contract as the widget
// path (resolve_macros_response on error).
async function resolveMacroText(original, chatId, characterId, userId, deferNames = new Set()) {
    try {
        const stripped = await applyAndStripSetvars(original, chatId, userId);
        const { masked, masks } = maskInvalidMacros(stripped, deferNames);
        const { text, diagnostics } = await common_1.api.macros.resolve(masked, {
            chatId,
            characterId,
            userId,
            commit: false,
        });
        if (diagnostics.length > 0) {
            common_1.varsLog.debug(`resolve produced ${diagnostics.length} diagnostic(s):`, diagnostics[0]?.message);
        }
        return unmaskInvalidMacros(text, masks);
    }
    catch (err) {
        common_1.varsLog.warn('resolve failed:', err instanceof Error ? err.message : String(err));
        return original;
    }
}
// Resolve ONLY {{getvar::x}} / {{getchatvar::x}} via the direct variable-read
// APIs (api.variables.local.get / .chat.get), which need just (chatId, key) —
// no userId. This is what makes /inject content dynamic: called fresh from
// the interceptor on every single generation (the interceptor never has a
// userId, so the full api.macros.resolve engine is unreachable there — see
// the comment in message-content-processor.ts installInjectInterceptor).
// Per-call cache so a key referenced twice in one inject body only does one
// round-trip. Leaves a macro literal on lookup failure (no worse than today).
const DYNAMIC_VAR_RE = /\{\{\s*(getvar|getchatvar)\s*::\s*([^:}]*?)\s*\}\}/gi;
async function resolveDynamicVarMacros(text, chatId) {
    if (!text.includes('{{'))
        return text;
    DYNAMIC_VAR_RE.lastIndex = 0;
    if (!DYNAMIC_VAR_RE.test(text))
        return text;
    const cache = new Map();
    DYNAMIC_VAR_RE.lastIndex = 0;
    let m;
    const lookups = [];
    while ((m = DYNAMIC_VAR_RE.exec(text)) !== null) {
        const kind = m[1].toLowerCase();
        const key = m[2];
        const cacheKey = `${kind}::${key}`;
        if (cache.has(cacheKey))
            continue;
        cache.set(cacheKey, ''); // reserve, filled below — dedupes concurrent identical lookups
        lookups.push((kind === 'getvar' ? common_1.api.variables.local.get(chatId, key) : common_1.api.variables.chat.get(chatId, key))
            .then((value) => { cache.set(cacheKey, value ?? ''); })
            .catch((err) => {
            common_1.varsLog.warn('dynamic var resolve failed:', { kind, key, err: err instanceof Error ? err.message : String(err) });
            cache.set(cacheKey, `{{${kind}::${key}}}`); // leave literal on failure
        }));
    }
    await Promise.all(lookups);
    return text.replace(DYNAMIC_VAR_RE, (full, kind, key) => {
        const v = cache.get(`${kind.toLowerCase()}::${key}`);
        return v !== undefined ? v : full;
    });
}
// Resolve {{random}}, {{roll}}, {{pick}}, {{newline}}, {{input}} purely
// locally — no api.* call, no userId, no async. Mirrors Lumiverse's own
// handlers exactly (src/macros/definitions/entropy.ts and primitives.ts):
// `random` does numeric-range-or-list-pick, `roll` is NdS dice notation
// capped at 100 dice, `pick` is uniform-random over its arg list, `newline`
// is a literal "\n", and `input` is the last user message — which the
// interceptor already has as the first element of its `messages` argument,
// so no lookup is needed for it either. Synchronous and side-effect-free,
// so (unlike resolveDynamicVarMacros) it can run directly in the hot path.
const LOCAL_DYNAMIC_RE = /\{\{\s*(random|roll|pick|newline|input)\s*(?:::([^}]*))?\}\}/gi;
function rollDice(notation) {
    const match = notation.match(/^(\d+)d(\d+)$/i);
    if (!match)
        return '0';
    const count = Math.min(parseInt(match[1], 10), 100);
    const sides = parseInt(match[2], 10);
    if (sides < 1 || count < 1)
        return '0';
    let total = 0;
    for (let i = 0; i < count; i++)
        total += Math.floor(Math.random() * sides) + 1;
    return String(total);
}
function splitArgs(argStr) {
    if (argStr === undefined || argStr === '')
        return [];
    return argStr.split('::');
}
function randomMacro(argStr) {
    const args = splitArgs(argStr);
    if (args.length === 0)
        return String(Math.round(Math.random()));
    const allNumeric = args.length <= 2 && args.every((a) => a.trim() !== '' && !isNaN(Number(a)));
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
        return '';
    return args[Math.floor(Math.random() * args.length)];
}
function resolveLocalDynamicMacros(text, lastUserMessage) {
    if (!text.includes('{{'))
        return text;
    return text.replace(LOCAL_DYNAMIC_RE, (full, name, argStr) => {
        switch (name.toLowerCase()) {
            case 'newline': return '\n';
            case 'input': return lastUserMessage;
            case 'roll': return rollDice((argStr ?? '1d6').trim());
            case 'random': return randomMacro(argStr);
            case 'pick': return pickMacro(argStr);
            default: return full;
        }
    });
}
function installMacroResolveHandler() {
    common_1.api.onFrontendMessage((payload, userId) => {
        if (!isResolveMacrosRequest(payload))
            return;
        const { requestId, chatId, characterId, templates } = payload;
        void (async () => {
            const results = new Array(templates.length);
            for (let i = 0; i < templates.length; i++) {
                // Persist + strip setvars first so subsequent {{getvar}} on the same
                // chat (and within this same template) reads the freshly set value
                // when the engine resolves. addvar/etc. and disabled gvars pass
                // through to the engine no-op via commit:false.
                // userId — required for operator-scoped extensions (which is how Vishrun
                // installs); the host injects it as onFrontendMessage's 2nd arg.
                // commit:false — `{{setvar}}` that happens to appear in widget HTML
                // must not persist during a render pass; only the slash interceptor writes.
                results[i] = await resolveMacroText(templates[i], chatId, characterId, userId);
            }
            common_1.api.sendToFrontend({ type: 'resolve_macros_response', requestId, results }, userId);
        })();
    });
}

},
"src/backend/setvar-ops.ts": function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.applySetvarOp = applySetvarOp;
const common_1 = require("./common");
// Returns true if the op was applied (caller should strip the match from the
// template / mark as handled), false if it was intentionally skipped (gvar
// disabled — caller should leave the match in place).
async function applySetvarOp(op, chatId, userId, vars = common_1.api.variables) {
    if (op.kind === 'setvar') {
        await vars.local.set(chatId, op.name, op.value);
        return true;
    }
    if (op.kind === 'setchatvar') {
        await vars.chat.set(chatId, op.name, op.value);
        return true;
    }
    // setgvar / setglobalvar — disabled, see header comment.
    common_1.varsLog.debug(`skipping ${op.kind} (upstream get/set path split):`, { name: op.name, userId });
    return false;
}

},
"src/backend/message-content-processor.ts": function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.expandSelfClosingTags = expandSelfClosingTags;
exports.processMessageContent = processMessageContent;
exports.installMessageContentProcessor = installMessageContentProcessor;
const common_1 = require("./common");
const setvar_1 = require("./parsers/setvar");
const setvar_ops_1 = require("./setvar-ops");
const macro_resolve_1 = require("./macro-resolve");
const pre_generation_bridge_1 = require("./pre-generation-bridge");
const EMPTY_REPLACEMENT = '_(variables updated)_';
function injectPath(chatId) {
    return `injects/${chatId}.json`;
}
async function readInjects(chatId) {
    try {
        return await common_1.api.storage.getJson(injectPath(chatId), { fallback: [] });
    }
    catch (e) {
        return [];
    }
}
async function writeInjects(chatId, injects) {
    try {
        if (injects.length === 0) {
            await common_1.api.storage.delete(injectPath(chatId));
        }
        else {
            await common_1.api.storage.setJson(injectPath(chatId), injects);
        }
    }
    catch (e) {
        // best-effort; don't crash the processor
    }
}
/** Parse leading key=value pairs from a string, return remainder as content. */
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
// ─────────────────────────────────────────────────────────────────────────────
const SETVAR_RE = /\/(setvar|setchatvar|setgvar|setglobalvar)\b/i;
const INJECT_RE = /\/inject\b/i;
const FLUSHINJECT_RE = /\/flushinject\b/i;
// Macros deferred at /inject command time so they're re-resolved fresh on
// every generation by the interceptor instead of being frozen forever.
// getvar/getchatvar need a live value lookup; random/roll/pick need a fresh
// roll each time; newline/input are included too for consistency even
// though their resolved value wouldn't actually differ by timing.
const DEFERRED_MACRO_NAMES = new Set([
    ...macro_resolve_1.DYNAMIC_VAR_MACRO_NAMES,
    ...macro_resolve_1.LOCAL_DYNAMIC_MACRO_NAMES,
]);
const SELF_CLOSING_CUSTOM_RE = /<([A-Z][a-zA-Z0-9_-]*)(\s[^>]*)?\s*\/>/g;
function expandSelfClosingTags(content) {
    return content.replace(SELF_CLOSING_CUSTOM_RE, (_m, tag, attrs) => {
        const a = attrs ? attrs.trimEnd() : '';
        return `<${tag}${a}></${tag}>`;
    });
}
async function processMessageContent(ctx, deps = {}) {
    const applySetvar = deps.applySetvarOp ?? setvar_ops_1.applySetvarOp;
    const workingContent = expandSelfClosingTags(ctx.content);
    const selfCloseChanged = workingContent !== ctx.content;
    if (ctx.origin === 'render') {
        return selfCloseChanged ? { content: workingContent } : undefined;
    }
    if (!SETVAR_RE.test(workingContent) && !INJECT_RE.test(workingContent) && !FLUSHINJECT_RE.test(workingContent)) {
        return selfCloseChanged ? { content: workingContent } : undefined;
    }
    let content = workingContent;
    const parsed = (0, setvar_1.parseSetvarChain)(content);
    if (parsed) {
        for (const { kind, key, value } of parsed.pairs) {
            setTimeout(async () => {
                try {
                    await applySetvar({ kind, name: key, value }, ctx.chatId, ctx.userId);
                }
                catch (err) {
                    common_1.varsLog.warn(`setvar failed for "${kind}::${key}":`, err instanceof Error ? err.message : String(err));
                }
            }, 0);
        }
        content = parsed.strippedContent;
    }
    // Handle /inject — store a spec in extension storage for the interceptor.
    // Syntax: /inject [id=<id>] [depth=<n>] [role=system|user|assistant] [position=chat|before|after] [turns=<n>] <content>
    if (INJECT_RE.test(content)) {
        const INJECT_CMD_RE = /^\/inject(?:\s+(.*?))?\s*$/gim;
        const injects = await readInjects(ctx.chatId);
        let im;
        while ((im = INJECT_CMD_RE.exec(content)) !== null) {
            const { args, content: body } = parseInjectArgs(im[1] ?? '');
            if (!body.trim())
                continue;
            // Resolve {{macros}} in the inject body NOW, at /inject command time —
            // EXCEPT the names in DEFERRED_MACRO_NAMES, which are deliberately left
            // as literal text here and resolved fresh on every generation by the
            // interceptor below: getvar/getchatvar via resolveDynamicVarMacros,
            // random/roll/pick/newline/input via resolveLocalDynamicMacros. Both of
            // those need only (chatId, key) or nothing at all — no userId — so they
            // can actually run inside the interceptor, unlike the full macro engine.
            // Everything else (user/char/group/setvar/...) genuinely can't be:
            // api.macros.resolve requires userId, which only this function
            // (MessageContentProcessorCtx) has — the interceptor's context, per
            // Lumiverse host source (interceptor-pipeline.ts, generate.service.ts),
            // is {chatId, connectionId, personaId, generationType} with no userId
            // at all for an operator-scoped extension. So those stay frozen at
            // /inject time; this is a hard host-API limit, not a choice. Falls
            // back to the raw body on failure.
            const resolvedBody = await (0, macro_resolve_1.resolveMacroText)(body, ctx.chatId, undefined, ctx.userId, DEFERRED_MACRO_NAMES);
            const id = args.id ?? Math.random().toString(36).slice(2, 10);
            const spec = {
                id,
                content: resolvedBody,
                role: (args.role === 'user' || args.role === 'assistant') ? args.role : 'system',
                depth: Math.max(0, parseInt(args.depth ?? '0', 10) || 0),
                position: (args.position === 'before' || args.position === 'after') ? args.position : 'chat',
                turns: Math.max(0, parseInt(args.turns ?? '0', 10) || 0),
            };
            const existing = injects.findIndex((e) => e.id === id);
            if (existing >= 0) {
                injects[existing] = spec;
            }
            else {
                injects.push(spec);
            }
        }
        await writeInjects(ctx.chatId, injects);
        content = content.replace(/^\/inject(?:\s+.*?)?\s*$/gim, '').replace(/\n{3,}/g, '\n\n');
    }
    // Handle /flushinject — remove one or all injections.
    // Syntax: /flushinject [id=<id>]   (omit id to flush all)
    if (FLUSHINJECT_RE.test(content)) {
        const FLUSH_CMD_RE = /^\/flushinject(?:\s+id=(\S+))?\s*$/gim;
        let injects = await readInjects(ctx.chatId);
        let fm;
        while ((fm = FLUSH_CMD_RE.exec(content)) !== null) {
            const id = fm[1];
            injects = id ? injects.filter((e) => e.id !== id) : [];
        }
        await writeInjects(ctx.chatId, injects);
        content = content.replace(/^\/flushinject(?:\s+\S+)?\s*$/gim, '').replace(/\n{3,}/g, '\n\n');
    }
    if (content === ctx.content)
        return;
    const stripped = content.trim();
    return { content: stripped.length > 0 ? stripped : EMPTY_REPLACEMENT };
}
// ─── Prompt interceptor ───────────────────────────────────────────────────────
function applyPreGenerationMessagePatches(messages, patches) {
    if (patches.length === 0)
        return { messages, breakdown: [] };
    const result = [...messages];
    const breakdown = [];
    for (const patch of patches) {
        const index = result.findIndex((message) => {
            const source = message;
            return source.__isChatHistory === true && source.sourceMessageId === patch.sourceMessageId;
        });
        if (index < 0)
            continue;
        const current = result[index].content;
        let nextContent;
        if (patch.mode === 'replace') {
            // Replace intentionally replaces the whole message payload, including any
            // multipart media parts. Append/prepend below preserve multipart content.
            nextContent = patch.content;
        }
        else if (Array.isArray(current)) {
            // Lumiverse represents turns with attachments as multipart content. A
            // message-level append/prepend should mutate the message's textual payload,
            // not create a second text part after its media. This keeps the original
            // part ordering intact and matches how a normal text message is patched.
            const parts = current.map((part) => part && typeof part === 'object' ? { ...part } : part);
            const textIndex = parts.findIndex((part) => !!part
                && typeof part === 'object'
                && part.type === 'text'
                && typeof part.text === 'string');
            if (textIndex >= 0) {
                const textPart = parts[textIndex];
                parts[textIndex] = {
                    ...textPart,
                    text: patch.mode === 'prepend'
                        ? patch.content + textPart.text
                        : textPart.text + patch.content,
                };
                nextContent = parts;
            }
            else {
                // A media-only turn still needs a textual anchor. Put it before the
                // existing media so the provider sees one coherent message beginning
                // with the patched text rather than a trailing caption after the image.
                const patchPart = { type: 'text', text: patch.content };
                nextContent = [patchPart, ...parts];
            }
        }
        else {
            const text = typeof current === 'string' ? current : '';
            nextContent = patch.mode === 'prepend'
                ? patch.content + text
                : text + patch.content;
        }
        result[index] = { ...result[index], content: nextContent };
        breakdown.push({ messageIndex: index, name: 'Message patch' });
    }
    return { messages: result, breakdown };
}
// Reads inject specs from extension storage on every generation and splices
// each active entry into the assembled message array at the right depth.
// Turn-counted entries are decremented and removed when they expire.
function installInjectInterceptor() {
    common_1.api.registerInterceptor(async (messages, context) => {
        const ctx = context;
        if (!ctx.chatId)
            return { messages };
        const messagePatches = await (0, pre_generation_bridge_1.waitForPreGeneration)(ctx);
        const injects = await readInjects(ctx.chatId);
        if (injects.length === 0) {
            const patched = applyPreGenerationMessagePatches(messages, messagePatches);
            return patched.breakdown.length > 0
                ? { messages: patched.messages, breakdown: patched.breakdown }
                : { messages: patched.messages };
        }
        const result = [...messages];
        const surviving = [];
        const breakdown = [];
        // {{input}} resolves to the last user message — already sitting right
        // here in `messages` (the interceptor's first argument), no host
        // lookup needed. Computed once: `messages` doesn't change across the
        // loop below (only the `result` splice copy does).
        let lastUserMessage = '';
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'user') {
                lastUserMessage = messages[i].content ?? '';
                break;
            }
        }
        for (const spec of injects) {
            // Dynamic path — re-resolves {{getvar::x}}/{{getchatvar::x}} fresh on
            // every generation. Uses api.variables.local.get/chat.get directly,
            // which take only (chatId, key) — no userId — so this actually works
            // inside the interceptor, unlike the full macro engine. This is what
            // makes /inject content non-static for the variable-getter macros.
            let resolvedContent = await (0, macro_resolve_1.resolveDynamicVarMacros)(spec.content, ctx.chatId);
            // Same idea for {{random}}/{{roll}}/{{pick}}/{{newline}}/{{input}} —
            // these need no host lookup at all (pure Math.random(), or data
            // already in `messages`), so they resolve synchronously and locally
            // right here, fresh every generation, with no userId dependency.
            resolvedContent = (0, macro_resolve_1.resolveLocalDynamicMacros)(resolvedContent, lastUserMessage);
            // Forward-compat fallback: any OTHER macro type left in spec.content
            // (shouldn't normally happen — those are resolved once at /inject
            // time in processMessageContent, see above) only resolves here if a
            // future host version starts threading userId into the interceptor's
            // context. Today ctx.userId is always undefined here, so this is a
            // guaranteed no-op pass-through.
            if (ctx.userId) {
                resolvedContent = await (0, macro_resolve_1.resolveMacroText)(resolvedContent, ctx.chatId, ctx.characterId, ctx.userId);
            }
            const msg = { role: spec.role, content: resolvedContent };
            let insertAt;
            if (spec.position === 'before') {
                const first = result.findIndex((m) => m.__isChatHistory === true);
                insertAt = first >= 0 ? first : 0;
            }
            else if (spec.position === 'after') {
                insertAt = result.length;
            }
            else {
                // 'chat': depth-based within chat history (depth 0 = append)
                if (spec.depth === 0) {
                    insertAt = result.length;
                }
                else {
                    let count = 0;
                    insertAt = result.length;
                    for (let i = result.length - 1; i >= 0; i--) {
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
            breakdown.push({ messageIndex: insertAt, name: 'Inject: ' + spec.id });
            if (spec.turns === 0) {
                surviving.push(spec);
            }
            else if (spec.turns > 1) {
                surviving.push({ ...spec, turns: spec.turns - 1 });
            }
            // turns === 1: last use this generation, don't carry forward
        }
        if (surviving.length !== injects.length) {
            await writeInjects(ctx.chatId, surviving);
        }
        const patched = applyPreGenerationMessagePatches(result, messagePatches);
        return { messages: patched.messages, breakdown: [...breakdown, ...patched.breakdown] };
    });
}
function installMessageContentProcessor() {
    common_1.api.registerMessageContentProcessor((ctx) => processMessageContent(ctx), 50);
    installInjectInterceptor();
}

},
"src/backend/parsers/setvar.ts": function (module, exports, require) {
"use strict";
// Parser for SillyTavern setvar-family slash-command chains pasted into the
// chat input or pushed by widgets via `pushToSillyTavern`. Supports
// `/setvar`, `/setchatvar`, `/setgvar`, `/setglobalvar` with `key=NAME VALUE`
// + `|` chaining, quoted or bare values. No other slash commands, no nested.
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseSetvarChain = parseSetvarChain;
// Leading `/<kind> key=NAME VALUE` at the start of a (trimmed) chain segment.
// NAME: up to whitespace / quote / `=` / `|`. VALUE: "..."(\-escapes) | '...'(\-escapes) | bare token.
const SETVAR_HEAD = /^\/(setvar|setchatvar|setgvar|setglobalvar)\s+key\s*=\s*([^\s"'=|]+)\s+(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\S+))\s*/i;
// Cheap pre-check: does the content reference any setvar-family command?
const SETVAR_HINT = /\/(setvar|setchatvar|setgvar|setglobalvar)\b/i;
function unescapeQuoted(s, quote) {
    // Only `\<quote>` and `\\` are real escapes; leave other backslash pairs intact.
    return s.replace(/\\(.)/g, (_m, c) => (c === quote || c === '\\' ? c : '\\' + c));
}
// Split a chain on top-level `|` and newlines, ignoring separators inside
// "..." / '...' (with `\` escapes). A newline inside quotes survives.
function splitChain(s) {
    const out = [];
    let buf = '';
    let quote = null;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (quote) {
            buf += ch;
            if (ch === '\\' && i + 1 < s.length) {
                buf += s[++i];
            }
            else if (ch === quote) {
                quote = null;
            }
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            buf += ch;
        }
        else if (ch === '|' || ch === '\n') {
            out.push(buf);
            buf = '';
        }
        else {
            buf += ch;
        }
    }
    out.push(buf);
    return out;
}
// Parse one chain segment. If it leads with `/setvar key=...`, return the pair
// plus any trailing non-command text from the same segment. Otherwise the whole
// (trimmed) segment is preserved text.
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
        value = m[5]; // bare token
    return { pair: { kind, key, value }, rest: trimmed.slice(m[0].length).trim() };
}
// Extract setvar-family pairs from a message and return the content with
// those commands removed (preserved text re-joined with ` | `). `null` when
// there's no parseable setvar — caller leaves the message untouched.
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
    return { pairs, strippedContent: kept.join(' | ').trim() };
}

},
"src/backend/pre-generation-bridge.ts": function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.installPreGenerationBridgeHandler = installPreGenerationBridgeHandler;
exports.waitForPreGeneration = waitForPreGeneration;
const common_1 = require("./common");
const LOG_PREFIX = '[vishrun:pre-generation]';
const PRE_GENERATION_TIMEOUT_MS = 300_000;
const subscribedUsers = new Set();
const pendingRequests = new Map();
function isSubscriptionMessage(payload) {
    return !!payload
        && typeof payload === 'object'
        && payload.type === 'vsh_pre_generation_subscription'
        && typeof payload.active === 'boolean';
}
function isCompleteMessage(payload) {
    return !!payload
        && typeof payload === 'object'
        && payload.type === 'vsh_pre_generation_complete'
        && typeof payload.requestId === 'string';
}
function isWorldInfoRequestMessage(payload) {
    return !!payload
        && typeof payload === 'object'
        && payload.type === 'vsh_pre_generation_world_info_request'
        && typeof payload.requestId === 'string';
}
function normalizeActivatedWorldInfo(value) {
    if (!Array.isArray(value))
        return [];
    const out = [];
    const seen = new Set();
    for (const item of value) {
        if (!item || typeof item !== 'object')
            continue;
        const raw = item;
        const id = typeof raw.id === 'string' ? raw.id : '';
        if (!id || seen.has(id))
            continue;
        seen.add(id);
        const entry = { id };
        if (typeof raw.comment === 'string')
            entry.comment = raw.comment;
        if (Array.isArray(raw.keys))
            entry.keys = raw.keys.filter((key) => typeof key === 'string');
        if (typeof raw.source === 'string')
            entry.source = raw.source;
        if (typeof raw.score === 'number')
            entry.score = raw.score;
        if (typeof raw.bookId === 'string')
            entry.bookId = raw.bookId;
        if (typeof raw.bookSource === 'string')
            entry.bookSource = raw.bookSource;
        out.push(entry);
    }
    return out;
}
function normalizeMessagePatches(value) {
    if (!Array.isArray(value))
        return [];
    const out = [];
    for (const item of value) {
        if (!item || typeof item !== 'object')
            continue;
        const raw = item;
        const sourceMessageId = typeof raw.sourceMessageId === 'string' ? raw.sourceMessageId.trim() : '';
        const content = typeof raw.content === 'string' ? raw.content : null;
        if (!sourceMessageId || content === null)
            continue;
        const mode = raw.mode === 'prepend' || raw.mode === 'replace' ? raw.mode : 'append';
        out.push({ sourceMessageId, content, mode });
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
        pending.signal.removeEventListener('abort', pending.abortHandler);
    }
    return pending;
}
function releasePendingForUser(userId) {
    for (const [requestId, pending] of pendingRequests) {
        if (pending.userId !== userId)
            continue;
        clearPending(requestId)?.resolve([]);
    }
}
async function sendWorldInfoBodies(requestId, userId, pending) {
    try {
        const results = await Promise.allSettled(pending.activatedWorldInfo.map(async (activation) => {
            const entry = await common_1.api.world_books.entries.get(activation.id, userId);
            if (!entry)
                throw new Error(`Active World Info entry ${activation.id} is unavailable`);
            if (typeof entry.content !== 'string' || !entry.content.trim()) {
                throw new Error(`Active World Info entry ${activation.id} has no readable content`);
            }
            return { ...entry, ...activation, content: entry.content };
        }));
        if (!pendingRequests.has(requestId))
            return;
        const failures = results.filter((result) => result.status === 'rejected');
        if (failures.length > 0) {
            common_1.api.sendToFrontend({
                type: 'vsh_pre_generation_world_info_result',
                requestId,
                entries: [],
                error: failures
                    .map(result => result.reason instanceof Error ? result.reason.message : String(result.reason))
                    .join('; '),
            }, userId);
            return;
        }
        common_1.api.sendToFrontend({
            type: 'vsh_pre_generation_world_info_result',
            requestId,
            entries: results
                .filter((result) => result.status === 'fulfilled')
                .map(result => result.value),
        }, userId);
    }
    catch (error) {
        if (!pendingRequests.has(requestId))
            return;
        common_1.api.sendToFrontend({
            type: 'vsh_pre_generation_world_info_result',
            requestId,
            entries: [],
            error: error instanceof Error ? error.message : String(error),
        }, userId);
    }
}
function installPreGenerationBridgeHandler() {
    common_1.api.onFrontendMessage((payload, userId) => {
        if (isSubscriptionMessage(payload)) {
            if (payload.active) {
                subscribedUsers.add(userId);
            }
            else {
                subscribedUsers.delete(userId);
                releasePendingForUser(userId);
            }
            return;
        }
        if (isWorldInfoRequestMessage(payload)) {
            const pending = pendingRequests.get(payload.requestId);
            if (!pending || pending.userId !== userId)
                return;
            void sendWorldInfoBodies(payload.requestId, userId, pending);
            return;
        }
        if (!isCompleteMessage(payload))
            return;
        const pending = pendingRequests.get(payload.requestId);
        if (!pending || pending.userId !== userId)
            return;
        const messagePatches = normalizeMessagePatches(payload.messagePatches);
        clearPending(payload.requestId)?.resolve(messagePatches);
        if (payload.error) {
            console.warn(LOG_PREFIX, 'frontend handler reported an error:', payload.error);
        }
    });
}
async function waitForPreGeneration(context) {
    const { chatId, userId, generationType, signal } = context;
    const activatedWorldInfo = normalizeActivatedWorldInfo(context.activatedWorldInfo);
    if (!chatId || !userId || !subscribedUsers.has(userId))
        return [];
    if (signal?.aborted) {
        throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    }
    const requestId = crypto.randomUUID();
    return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            const pending = clearPending(requestId);
            if (!pending)
                return;
            common_1.api.sendToFrontend({ type: 'vsh_pre_generation_cancel', requestId }, userId);
            console.warn(LOG_PREFIX, `frontend handler timed out after ${PRE_GENERATION_TIMEOUT_MS}ms`);
            pending.resolve([]);
        }, PRE_GENERATION_TIMEOUT_MS);
        const pending = {
            userId,
            resolve,
            reject,
            timer,
            signal,
            activatedWorldInfo,
        };
        if (signal) {
            pending.abortHandler = () => {
                const active = clearPending(requestId);
                if (!active)
                    return;
                common_1.api.sendToFrontend({ type: 'vsh_pre_generation_cancel', requestId }, userId);
                active.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
            };
            signal.addEventListener('abort', pending.abortHandler, { once: true });
        }
        pendingRequests.set(requestId, pending);
        common_1.api.sendToFrontend({
            type: 'vsh_pre_generation_request',
            requestId,
            chatId,
            ...(generationType ? { generationType } : {}),
            activatedWorldInfo,
        }, userId);
    });
}

},
"src/backend/dispatch-slash.ts": function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.dispatchSlashText = dispatchSlashText;
exports.installDispatchSlashHandler = installDispatchSlashHandler;
const common_1 = require("./common");
const setvar_1 = require("./parsers/setvar");
const setvar_ops_1 = require("./setvar-ops");
const macro_resolve_1 = require("./macro-resolve");
// Same deferral set as message-content-processor.ts's /inject path — keep
// getvar/getchatvar/random/roll/pick/newline/input literal here so the
// interceptor re-resolves them fresh every generation instead of freezing
// them at dispatch time.
const DEFERRED_MACRO_NAMES = new Set([
    ...macro_resolve_1.DYNAMIC_VAR_MACRO_NAMES,
    ...macro_resolve_1.LOCAL_DYNAMIC_MACRO_NAMES,
]);
function isDispatchSlashRequest(p) {
    if (!p || typeof p !== 'object')
        return false;
    const r = p;
    return (r.type === 'dispatch_slash_text' &&
        typeof r.requestId === 'string' &&
        typeof r.text === 'string' &&
        typeof r.chatId === 'string');
}
const SETVAR_PREFIX_RE = /^\s*\/(setvar|setchatvar|setgvar|setglobalvar)\b/i;
const SYS_PREFIX_RE = /^\s*\/sys\b/i;
const INJECT_PREFIX_RE = /^\s*\/inject\b/i;
const FLUSHINJECT_PREFIX_RE = /^\s*\/flushinject\b/i;
const LISTINJECTS_PREFIX_RE = /^\s*\/listinjects\b/i;
const VISHRUN_INJECTS_VAR = '_vishrun_injects';
// ─── /inject storage helpers (shared with message-content-processor) ─────────
const INJECT_STORAGE_KEY = 'lumi_injects';
function injectPath(chatId) {
    return `injects/${chatId}.json`;
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
async function readInjectsFromStorage(chatId) {
    try {
        return await common_1.api.storage.getJson(injectPath(chatId), { fallback: [] });
    }
    catch (e) {
        return [];
    }
}
async function writeInjectsToStorage(chatId, injects) {
    try {
        if (injects.length === 0) {
            await common_1.api.storage.delete(injectPath(chatId));
        }
        else {
            await common_1.api.storage.setJson(injectPath(chatId), injects);
        }
    }
    catch (e) {
        // best-effort
    }
}
async function dispatchSlashText(text, chatId, userId, deps = {}) {
    if (SETVAR_PREFIX_RE.test(text)) {
        const parsed = (0, setvar_1.parseSetvarChain)(text);
        if (!parsed || parsed.pairs.length === 0) {
            common_1.varsLog.warn('dispatch_slash_text: setvar prefix matched but parse failed; treating as handled');
            return { handled: true, kind: 'setvar_chain' };
        }
        for (const { kind, key, value } of parsed.pairs) {
            try {
                await (0, setvar_ops_1.applySetvarOp)({ kind: kind, name: key, value }, chatId, userId, deps.vars);
            }
            catch (err) {
                common_1.varsLog.warn(`dispatch_slash_text: applySetvarOp failed for ${kind}::${key}:`, err instanceof Error ? err.message : String(err));
            }
        }
        return { handled: true, kind: 'setvar_chain' };
    }
    if (SYS_PREFIX_RE.test(text)) {
        const content = text.replace(/^\s*\/sys\s*/i, '');
        const append = deps.appendMessage ?? common_1.api.chat.appendMessage.bind(common_1.api.chat);
        await append(chatId, { role: 'system', content });
        return { handled: true, kind: 'sys_message' };
    }
    if (INJECT_PREFIX_RE.test(text)) {
        const body = text.replace(/^\s*\/inject\s*/i, '');
        const { args, content } = parseInjectArgs(body);
        if (content.trim()) {
            // Resolve {{user}}/{{char}}/{{group}}/{{setvar}}/etc. now, same as the
            // typed-in-chat /inject path — this is the one call site here that has
            // userId, so it's the only place these can ever resolve. Without this
            // they were saved as raw literal text forever (the interceptor that
            // re-resolves on every generation has no userId, so it can't pick up
            // the slack the way it does for getvar/random/etc.).
            const resolvedContent = await (0, macro_resolve_1.resolveMacroText)(content.trim(), chatId, undefined, userId, DEFERRED_MACRO_NAMES);
            const id = args.id ?? Math.random().toString(36).slice(2, 10);
            const spec = {
                id,
                content: resolvedContent,
                role: (args.role === 'user' || args.role === 'assistant') ? args.role : 'system',
                depth: Math.max(0, parseInt(args.depth ?? '0', 10) || 0),
                position: (args.position === 'before' || args.position === 'after') ? args.position : 'chat',
                turns: Math.max(0, parseInt(args.turns ?? '0', 10) || 0),
            };
            const injects = await readInjectsFromStorage(chatId);
            const existing = injects.findIndex((e) => e.id === id);
            if (existing >= 0) {
                injects[existing] = spec;
            }
            else {
                injects.push(spec);
            }
            await writeInjectsToStorage(chatId, injects);
        }
        return { handled: true, kind: 'inject' };
    }
    if (FLUSHINJECT_PREFIX_RE.test(text)) {
        const body = text.replace(/^\s*\/flushinject\s*/i, '').trim();
        const idMatch = /^id=(\S+)/.exec(body);
        const id = idMatch ? idMatch[1] : null;
        let injects = await readInjectsFromStorage(chatId);
        injects = id ? injects.filter((e) => e.id !== id) : [];
        await writeInjectsToStorage(chatId, injects);
        return { handled: true, kind: 'flushinject' };
    }
    if (LISTINJECTS_PREFIX_RE.test(text)) {
        const injects = await readInjectsFromStorage(chatId);
        try {
            await common_1.api.variables.chat.set(chatId, VISHRUN_INJECTS_VAR, JSON.stringify(injects));
        }
        catch (e) {
            // best-effort
        }
        return { handled: true, kind: 'listinjects' };
    }
    return { handled: false, kind: 'none' };
}
function installDispatchSlashHandler() {
    common_1.api.onFrontendMessage((payload, userId) => {
        if (!isDispatchSlashRequest(payload))
            return;
        const { requestId, text, chatId } = payload;
        void (async () => {
            let response;
            try {
                const result = await dispatchSlashText(text, chatId, userId);
                response = { type: 'dispatch_slash_text_response', requestId, handled: result.handled, kind: result.kind };
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                common_1.varsLog.warn('dispatch_slash_text handler threw:', msg);
                response = { type: 'dispatch_slash_text_response', requestId, handled: false, kind: 'none', error: msg };
            }
            common_1.api.sendToFrontend(response, userId);
        })();
    });
}

},
"src/backend/th-helpers.ts": function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleGetMessagesSnapshot = handleGetMessagesSnapshot;
exports.handleGetVariablesSnapshot = handleGetVariablesSnapshot;
exports.handleCreateChatMessages = handleCreateChatMessages;
exports.handleTriggerSlash = handleTriggerSlash;
exports.handleSetChatMessage = handleSetChatMessage;
exports.handleSetVariable = handleSetVariable;
exports.handleReplaceChatVariables = handleReplaceChatVariables;
exports.installThHelpersHandler = installThHelpersHandler;
const common_1 = require("./common");
const mvu_parser_1 = require("./mvu-parser");
const dispatch_slash_1 = require("./dispatch-slash");
const LOG_PREFIX = '[vishrun:th-helpers]';
const log = {
    warn: (...args) => console.warn(LOG_PREFIX, ...args),
    debug: (...args) => console.debug(LOG_PREFIX, ...args),
};
function isThHelpersRequest(p) {
    if (!p || typeof p !== 'object')
        return false;
    const r = p;
    return (r.type === 'th_helpers_request' &&
        typeof r.requestId === 'string' &&
        typeof r.op === 'string' &&
        typeof r.chatId === 'string' &&
        typeof r.currentMessageId === 'string' &&
        typeof r.currentMessageIndex === 'number' &&
        !!r.body &&
        typeof r.body === 'object');
}
function resolveRangeToIndex(range, total, currentMessageIndex) {
    if (total === 0)
        return null;
    if (typeof range === 'number') {
        return range >= 0 ? range : total + range;
    }
    if (typeof range === 'string') {
        const trimmed = range.trim();
        if (trimmed === '' || trimmed === 'latest')
            return total - 1;
        if (trimmed === 'this')
            return currentMessageIndex;
        if (/^-?\d+$/.test(trimmed)) {
            const n = parseInt(trimmed, 10);
            return n >= 0 ? n : total + n;
        }
    }
    return null;
}
const JSLR_DATA_EXTRA_KEY = '__vishrun_jslr_message_data_v1';
function shapeSnapshotMessage(msg) {
    const role = msg.role === 'system' || msg.role === 'user' || msg.role === 'assistant'
        ? msg.role
        : msg.is_user
            ? 'user'
            : 'assistant';
    const swipes = Array.isArray(msg.swipes) && msg.swipes.length > 0 ? msg.swipes : [msg.content];
    const rawExtra = msg.extra ?? {};
    const storedData = rawExtra[JSLR_DATA_EXTRA_KEY];
    const data = storedData && typeof storedData === 'object' && !Array.isArray(storedData)
        ? { ...storedData }
        : {};
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
        extra,
    };
}
// Resolve a chat's greeting set (first_mes + alternate_greetings, in order)
// from the character metadata. Group greetings carry character_id on
// msg.extra; single-character chats fall back to the chat row. Empty array
// when unresolved. Shared by the initial-message swipes population and the
// variables-snapshot recovery below.
async function fetchCharacterGreetings(messages, chatId, userId, chats, characters) {
    const msg0 = messages[0];
    let charId = null;
    const fromExtra = msg0?.extra?.character_id;
    if (typeof fromExtra === 'string' && fromExtra.length > 0) {
        charId = fromExtra;
    }
    else {
        // userId is required: chats/characters are operator-scoped (host injects
        // userId as onFrontendMessage's 2nd arg).
        const chatDto = await chats.get(chatId, userId);
        if (chatDto && typeof chatDto.character_id === 'string')
            charId = chatDto.character_id;
    }
    if (!charId)
        return [];
    const card = await characters.get(charId, userId);
    if (!card)
        return [];
    const first = typeof card.first_mes === 'string' ? card.first_mes : '';
    const alt = Array.isArray(card.alternate_greetings) ? card.alternate_greetings : [];
    return [first, ...alt];
}
async function handleGetMessagesSnapshot(chatId, userId, chat = common_1.api.chat, chats = common_1.api.chats, characters = common_1.api.characters) {
    const messages = await chat.getMessages(chatId);
    const snapshot = messages.map((m) => shapeSnapshotMessage(m));
    // Initial greeting message: when the chat has not stored real swipe
    // alternatives yet (fresh chat), expose the full greeting set as swipes so
    // greeting-selection widgets can index into it, AND persist that array to
    // the DB so a later setChatMessage(swipe_id) validates against the same
    // length. A chat that already holds multiple swipes keeps them (no clobber).
    if (snapshot.length > 0 && snapshot[0].role !== 'user' && snapshot[0].swipes.length <= 1) {
        try {
            const greetings = await fetchCharacterGreetings(messages, chatId, userId, chats, characters);
            if (greetings.length > 1) {
                // Keep the active slot equal to the currently displayed content so the
                // persist does not rewrite the visible greeting (macros, prior edits).
                const activeIdx = snapshot[0].swipe_id >= 0 && snapshot[0].swipe_id < greetings.length ? snapshot[0].swipe_id : 0;
                const aligned = greetings.slice();
                aligned[activeIdx] = snapshot[0].message;
                snapshot[0].swipes = aligned;
                try {
                    // chat.updateMessage is not operator-scoped (owner derived from chatId,
                    // like getMessages); auto-pads swipe_dates. Idempotent: the next read
                    // sees length > 1 and skips. On failure the read still serves derived.
                    await chat.updateMessage(chatId, messages[0].id, { swipes: aligned, swipe_id: activeIdx });
                }
                catch (persistErr) {
                    log.warn('initial-message swipes persist failed (read serves derived):', persistErr instanceof Error ? persistErr.message : String(persistErr));
                }
            }
        }
        catch (err) {
            log.warn('initial-message swipes derive failed:', err instanceof Error ? err.message : String(err));
        }
    }
    return snapshot;
}
// Variables snapshot is computed by replaying all chat messages through
// the recognizer pipeline. Pure function of chat content — no persistence
// layer, swipe and edit fall out for free.
//
// We pass the raw DTOs (which include `swipes`, `swipe_id`) straight in;
// computeVariablesSnapshot resolves each message's active swipe via
// resolveActiveContent so swiping greeting 0 → greeting N is followed.
//
// Recovery: if message 0's active content has no <UpdateVariable> block
// (existing chat stripped under buggy code, imported chat, edited
// content), the lazy fetcher reads the card's greetings and lets the
// replay match by stripped-content hash.
async function handleGetVariablesSnapshot(chatId, userId, chat = common_1.api.chat, chats = common_1.api.chats, characters = common_1.api.characters) {
    try {
        const messages = await chat.getMessages(chatId);
        return await (0, mvu_parser_1.computeVariablesSnapshot)(messages, () => fetchCharacterGreetings(messages, chatId, userId, chats, characters));
    }
    catch (err) {
        log.warn('getVariablesSnapshot failed:', err instanceof Error ? err.message : String(err));
        return (0, mvu_parser_1.emptyMvuData)();
    }
}
async function handleCreateChatMessages(body, chatId, chat = common_1.api.chat) {
    const rawMessages = body.chatMessages;
    if (!Array.isArray(rawMessages))
        throw new TypeError('chat_messages must be an array');
    const messages = rawMessages.map((raw, index) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            throw new TypeError(`chat_messages[${index}] must be an object`);
        }
        const item = raw;
        if (item.role !== 'system' && item.role !== 'assistant' && item.role !== 'user') {
            throw new TypeError(`chat_messages[${index}].role must be system, assistant, or user`);
        }
        if (typeof item.message !== 'string') {
            throw new TypeError(`chat_messages[${index}].message must be a string`);
        }
        if (item.name !== undefined && typeof item.name !== 'string') {
            throw new TypeError(`chat_messages[${index}].name must be a string`);
        }
        if (item.is_hidden !== undefined && typeof item.is_hidden !== 'boolean') {
            throw new TypeError(`chat_messages[${index}].is_hidden must be a boolean`);
        }
        if (item.data !== undefined && (!item.data || typeof item.data !== 'object' || Array.isArray(item.data))) {
            throw new TypeError(`chat_messages[${index}].data must be an object`);
        }
        if (item.extra !== undefined && (!item.extra || typeof item.extra !== 'object' || Array.isArray(item.extra))) {
            throw new TypeError(`chat_messages[${index}].extra must be an object`);
        }
        return item;
    });
    const rawOptions = body.options;
    const options = rawOptions && typeof rawOptions === 'object' && !Array.isArray(rawOptions)
        ? rawOptions
        : {};
    if (options.refresh !== undefined && options.refresh !== 'none' && options.refresh !== 'affected' && options.refresh !== 'all') {
        throw new TypeError('refresh must be none, affected, or all');
    }
    // JSLR can splice into SillyTavern's in-memory chat array. Lumiverse's
    // public Spindle mutation API deliberately exposes append-only creation;
    // there is no safe indexed-insert primitive to mirror without rewriting
    // existing persisted rows. Accept every request that resolves to the end
    // and reject true mid-history insertion rather than silently doing the wrong thing.
    const before = options.insert_at ?? options.insert_before ?? 'end';
    if (before !== 'end') {
        if (typeof before !== 'number' || !Number.isFinite(before)) {
            throw new TypeError('insert_before must be a number or end');
        }
        const existing = await chat.getMessages(chatId);
        const clamped = Math.max(-existing.length, Math.min(existing.length, Math.trunc(before)));
        if (clamped !== existing.length) {
            throw new Error('Lumiverse does not expose safe indexed message insertion; createChatMessages currently supports insert_before/insert_at only when it resolves to the end');
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
    const indexById = new Map();
    for (const message of current)
        indexById.set(message.id, message.index_in_chat);
    return {
        created: ids.map((id, index) => ({
            id,
            message_id: indexById.get(id) ?? (current.length - ids.length + index),
        })),
    };
}
async function handleTriggerSlash(body, chatId, userId) {
    const command = body.command;
    if (typeof command !== 'string')
        throw new TypeError('triggerSlash command must be a string');
    const result = await (0, dispatch_slash_1.dispatchSlashText)(command, chatId, userId);
    if (!result.handled) {
        throw new Error(`Unsupported slash command in Vishrun triggerSlash: ${command}`);
    }
    // JSLR resolves to the slash executor pipe string. Vishrun's existing
    // internal slash handlers do not expose a pipe value, so handled commands
    // resolve to the equivalent empty string instead of touching the clipboard.
    return '';
}
async function handleSetChatMessage(body, chatId, currentMessageIndex, chat = common_1.api.chat) {
    const fieldValues = body.fieldValues ?? {};
    const messageRange = body.messageId;
    const messages = await chat.getMessages(chatId);
    if (messages.length === 0) {
        log.warn('setChatMessage: empty chat, ignoring');
        return;
    }
    const idx = resolveRangeToIndex(messageRange, messages.length, currentMessageIndex);
    if (idx === null || idx < 0 || idx >= messages.length) {
        log.warn('setChatMessage: unresolved message index', messageRange);
        return;
    }
    const target = messages[idx];
    const content = typeof fieldValues.message === 'string' ? fieldValues.message : undefined;
    if (typeof content !== 'string') {
        log.warn('setChatMessage: no message string in fieldValues, ignoring');
        return;
    }
    // Send { content } only and ignore opts.swipe_id. The native greeting
    // selector also writes { content } without swipe_id, so the host
    // overwrites swipes[existing.swipe_id]. Keeping swipe_id at 0 lets
    // both writers cooperate on slot 0 without corrupting other slots.
    await chat.updateMessage(chatId, target.id, { content });
}
async function handleSetVariable(body, chatId, chat = common_1.api.chat) {
    const key = body.key;
    const value = body.value;
    if (!key) {
        log.warn('setVariable: no key provided, ignoring');
        return;
    }
    const messages = await chat.getMessages(chatId);
    if (messages.length === 0) {
        log.warn('setVariable: empty chat, ignoring');
        return;
    }
    // Write the variable into the latest non-system message's content
    // by appending an UpdateVariable block, following MVU convention.
    const latest = messages[messages.length - 1];
    const existing = latest.content ?? '';
    const varBlock = `\n<UpdateVariable>\n${key}: ${JSON.stringify(value)}\n</UpdateVariable>`;
    await chat.updateMessage(chatId, latest.id, { content: existing + varBlock });
    log.debug('setVariable: set', key, '=', value);
}
// Serialize Vishrun's replacements per user/chat so unrelated metadata is read
// immediately before each save, not captured when an iframe was constructed.
const variableWrites = new Map();
function handleReplaceChatVariables(body, chatId, userId, chats = common_1.api.chats) {
    const key = JSON.stringify([userId, chatId]);
    const work = (variableWrites.get(key) ?? Promise.resolve()).catch(() => { }).then(async () => {
        if (!chatId || body.chatId !== chatId)
            throw new Error('Chat variable target does not match the requesting frame');
        const variables = body.variables;
        if (!variables || typeof variables !== 'object' || Array.isArray(variables)) {
            throw new TypeError('Variables must be an object');
        }
        const current = await chats.get(chatId, userId);
        if (!current)
            throw new Error('Chat not found');
        const updated = await chats.update(chatId, {
            metadata: { ...current.metadata, chat_variables: variables },
        }, userId);
        if (!updated)
            throw new Error('Chat variable save failed');
        const meta = updated.metadata ?? {};
        const macro = (meta.macro_variables ?? {});
        const saved = (meta.chat_variables ?? {});
        return { chatId, variables: saved, allVariables: { ...macro.global, ...macro.local, ...saved } };
    });
    variableWrites.set(key, work);
    void work.finally(() => {
        if (variableWrites.get(key) === work)
            variableWrites.delete(key);
    }).catch(() => { });
    return work;
}
function installThHelpersHandler() {
    common_1.api.onFrontendMessage((payload, userId) => {
        if (!isThHelpersRequest(payload))
            return;
        const { requestId, op, chatId, currentMessageIndex, body } = payload;
        void (async () => {
            let response;
            try {
                if (op === 'th-get-messages-snapshot') {
                    const result = await handleGetMessagesSnapshot(chatId, userId);
                    response = { type: 'th_helpers_response', requestId, ok: true, result };
                }
                else if (op === 'th-get-variables-snapshot') {
                    const result = await handleGetVariablesSnapshot(chatId, userId);
                    response = { type: 'th_helpers_response', requestId, ok: true, result };
                }
                else if (op === 'th-set-chat-message') {
                    await handleSetChatMessage(body, chatId, currentMessageIndex);
                    response = { type: 'th_helpers_response', requestId, ok: true, result: undefined };
                }
                else if (op === 'th-create-chat-messages') {
                    const result = await handleCreateChatMessages(body, chatId);
                    response = { type: 'th_helpers_response', requestId, ok: true, result };
                }
                else if (op === 'th-trigger-slash') {
                    const result = await handleTriggerSlash(body, chatId, userId);
                    response = { type: 'th_helpers_response', requestId, ok: true, result };
                }
                else if (op === 'th-replace-chat-variables') {
                    const result = await handleReplaceChatVariables(body, chatId, userId);
                    response = { type: 'th_helpers_response', requestId, ok: true, result };
                }
                else if (op === 'th-set-variable') {
                    await handleSetVariable(body, chatId);
                    response = { type: 'th_helpers_response', requestId, ok: true, result: undefined };
                }
                else {
                    response = {
                        type: 'th_helpers_response',
                        requestId,
                        ok: false,
                        error: 'unknown op: ' + String(op),
                    };
                }
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                log.warn('handler threw for op', op, msg);
                response = { type: 'th_helpers_response', requestId, ok: false, error: msg };
            }
            common_1.api.sendToFrontend(response, userId);
        })();
    });
}

},
"src/backend/mvu-parser.ts": function (module, exports, require) {
"use strict";
// Recognizer pipeline for <UpdateVariable> blocks emitted by MVU-aware
// cards. V1 ships InitvarYamlRecognizer only; Phase 2+ appends
// LodashCommandRecognizer, JsonPatchRecognizer, DeltaTokenRecognizer.
//
// The state is a pure function of message content: handleGetVariablesSnapshot
// fetches all chat messages and pipes them through computeVariablesSnapshot
// on every read. No persistence layer.
Object.defineProperty(exports, "__esModule", { value: true });
exports.recognizers = exports.LodashSetRecognizer = exports.InitvarYamlRecognizer = void 0;
exports.emptyMvuData = emptyMvuData;
exports.resolveActiveContent = resolveActiveContent;
exports.extractUpdateVariableBlocks = extractUpdateVariableBlocks;
exports.applyOperation = applyOperation;
exports.computeVariablesSnapshot = computeVariablesSnapshot;
exports.lodashSet = lodashSet;
exports.parseMvuBlocks = parseMvuBlocks;
exports.applyMvuCommands = applyMvuCommands;
const mvu_yaml_1 = require("./mvu-yaml");
const mvu_lodash_1 = require("./mvu-lodash");
const diagnostics_1 = require("../core/diagnostics");
function emptyMvuData() {
    return { stat_data: {} };
}
// Returns the content the replay should scan. ChatMessageDTO.content is
// documented as a mirror of swipes[swipe_id], but reading swipes directly
// removes the dependency on that mirror staying coherent under all swipe
// flows (alt-greeting swipes in particular).
function resolveActiveContent(msg) {
    const swipes = msg.swipes;
    const swipeId = typeof msg.swipe_id === 'number' ? msg.swipe_id : 0;
    if (Array.isArray(swipes) && swipes.length > 0) {
        const c = swipes[swipeId];
        if (typeof c === 'string' && c.length > 0)
            return c;
    }
    if (typeof msg.content === 'string')
        return msg.content;
    return '';
}
// ---- Block extraction ----
const BLOCK_RE = /<UpdateVariable>([\s\S]*?)<\/UpdateVariable>/gim;
const INITVAR_RE = /<initvar>(?:\s*```.*)?([\s\S]*?)(?:```\s*)?<\/initvar>/gim;
function extractUpdateVariableBlocks(content) {
    if (typeof content !== 'string' || !/<updatevariable>/i.test(content))
        return [];
    const out = [];
    for (const m of content.matchAll(BLOCK_RE))
        out.push(m[1]);
    return out;
}
// ---- V1 recognizer: <initvar>YAML</initvar> ----
exports.InitvarYamlRecognizer = {
    name: 'initvar-yaml',
    extract(block) {
        const ops = [];
        for (const m of block.matchAll(INITVAR_RE)) {
            try {
                const payload = (0, mvu_yaml_1.parseYaml)(m[1]);
                ops.push({ kind: 'replace_stat_data', index: m.index ?? 0, payload });
            }
            catch (err) {
                console.warn('[vishrun:mvu-parser] initvar yaml parse failed:', err instanceof Error ? err.message : String(err));
            }
        }
        return ops;
    },
};
// ---- Phase 2a recognizer: _.set(...) lodash calls ----
//
// Cumulative LLM-emitted variable updates. Block-additive: a block
// containing both <initvar> and _.set calls runs both recognizers; ops
// are sorted by source position before apply, so the initvar seed lands
// first and _.sets land after. The InitvarYamlRecognizer is unchanged.
exports.LodashSetRecognizer = {
    name: 'lodash-set',
    extract(block, ctx) {
        const calls = (0, mvu_lodash_1.parseLodashSetCalls)(block, (snippet, reason) => {
            ctx?.onDiagnostic?.('unknown-command', { snippet, reason });
        });
        return calls.map((c) => ({
            kind: 'set_path',
            index: c.index,
            path: c.path,
            value: c.newValue,
        }));
    },
};
// Phase 2a appends LodashSetRecognizer. Phase 2b+ adds JsonPatchRecognizer,
// DeltaTokenRecognizer.
exports.recognizers = [exports.InitvarYamlRecognizer, exports.LodashSetRecognizer];
// ---- Apply ----
// Immutable set-at-path. Clones along the modified branch only; other
// branches of the tree share references with the input. Cheaper than
// structuredClone for narrow updates, and preserves the applyOperation
// contract (the caller's state object is not mutated).
//
// `parseDottedPath` returns null for paths we don't support this
// iteration (bracket notation, backslash escapes). The caller logs and
// skips on null — the input state is returned unchanged.
function parseDottedPath(path) {
    if (path.length === 0)
        return null;
    if (path.indexOf('[') !== -1 || path.indexOf(']') !== -1)
        return null;
    if (path.indexOf('\\') !== -1)
        return null;
    return path.split('.');
}
function setDeepImmutable(root, segments, value) {
    if (segments.length === 0)
        return root;
    const [head, ...rest] = segments;
    if (rest.length === 0) {
        return { ...root, [head]: value };
    }
    const child = root[head];
    const childObj = child !== null && typeof child === 'object' && !Array.isArray(child)
        ? child
        : {};
    return { ...root, [head]: setDeepImmutable(childObj, rest, value) };
}
/**
 * Apply a single Operation to the state.
 *
 * MVU convention: `_.set` paths are RELATIVE to `state.stat_data`,
 * NOT absolute from the state root. The LLM emits bare paths like
 * `'世界.当前地点'`; the widget reads with the full
 * `'stat_data.世界.当前地点'` prefix via `getAllVariables()`.
 * Cards in scope (Queen Bee, Dreams) follow this convention. A card
 * that emits paths with an explicit `'stat_data.'` prefix is non-
 * canonical and currently NOT supported (the prefix would be treated
 * as a literal segment, landing at `state.stat_data.stat_data.X` —
 * surfaced via the `set-path-applied` diagnostic log).
 */
function applyOperation(state, op) {
    if (op.kind === 'replace_stat_data') {
        const payload = op.payload;
        return { ...state, stat_data: { ...payload } };
    }
    if (op.kind === 'set_path') {
        const sop = op;
        const segments = parseDottedPath(sop.path);
        if (segments === null) {
            // Path shape unsupported (bracket notation, escapes). Caller's
            // recognizer already logged via onDiagnostic; here we just no-op.
            return state;
        }
        // Bare path applied inside state.stat_data. Defensive: if
        // stat_data isn't present (no preceding initvar, orphan chat),
        // create it so the LLM's update lands somewhere readable rather
        // than silently dropping.
        const currentStatData = state.stat_data && typeof state.stat_data === 'object' && !Array.isArray(state.stat_data)
            ? state.stat_data
            : {};
        const nextStatData = setDeepImmutable(currentStatData, segments, sop.value);
        return { ...state, stat_data: nextStatData };
    }
    return state;
}
// ---- Replay ----
// FNV-1a hash. Matches the host's precedent (see Lumiverse message-content
// processor docs §"render origin fires twice per visible message") so any
// future cross-subsystem cache keying can share the same scheme.
function fnv1a(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = (h * 0x01000193) >>> 0;
    }
    return h >>> 0;
}
function stripUpdateVariableBlocks(s) {
    return s.replace(/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/gi, '');
}
function hashStripped(s) {
    return fnv1a(stripUpdateVariableBlocks(s));
}
// Replay snapshot. Async because the recovery path may fetch the card.
//
// recoveryFetcher: optional. When the active content of message 0 has no
// <UpdateVariable> block (existing chat written under buggy code, imported
// chat, etc.), the fetcher is invoked at most once to retrieve the card's
// greetings; the matching candidate's block seeds the snapshot.
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
        // Recovery: only for message 0 (greeting) with no <UpdateVariable>
        // in the active content. Match against card greetings by hashing the
        // stripped form of each candidate against the stripped active content.
        if (blocks.length === 0 &&
            msg.index_in_chat === 0 &&
            recoveryFetcher !== undefined) {
            if (!candidatesTried) {
                candidatesTried = true;
                try {
                    cachedCandidates = await recoveryFetcher();
                }
                catch (err) {
                    console.warn('[vishrun:mvu-parser] recovery fetcher threw:', err instanceof Error ? err.message : String(err));
                    cachedCandidates = [];
                }
            }
            const candidates = cachedCandidates ?? [];
            const targetHash = hashStripped(activeContent);
            let matchIdx = -1;
            for (let i = 0; i < candidates.length; i++) {
                const c = candidates[i];
                if (typeof c !== 'string')
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
        const messageIdForCtx = typeof msg.id === 'string' ? msg.id : null;
        const recognizerCtx = {
            messageId: messageIdForCtx,
            onDiagnostic: (event, payload) => {
                if (!diagnostics_1.VSH_VISHRUN_DIAG)
                    return;
                console.log(`[vishrun:mvu-parser] ${event}`, JSON.stringify({
                    messageId: messageIdForCtx,
                    ...payload,
                }));
            },
        };
        for (const block of blocks) {
            const ops = [];
            for (const r of exports.recognizers)
                ops.push(...r.extract(block, recognizerCtx));
            ops.sort((a, b) => a.index - b.index);
            for (const op of ops) {
                state = applyOperation(state, op);
            }
        }
    }
    return state;
}
// ---- Legacy `_.set` parser kept for Phase 2a ----
// Not wired into the V1 recognizer pipeline. Phase 2a wraps these into a
// LodashCommandRecognizer.
const SET_CALL_RE = /_\.set\s*\(\s*(['"])([^'"]+)\1\s*,\s*(?:(['"])([\s\S]*?)\3|(-?\d+(?:\.\d+)?)|(true|false|null))\s*\)/g;
function lodashSet(obj, path, value) {
    const parts = path.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        const key = parts[i];
        const next = cur[key];
        if (next === null || typeof next !== 'object' || Array.isArray(next)) {
            cur[key] = {};
        }
        cur = cur[key];
    }
    cur[parts[parts.length - 1]] = value;
}
function parseMvuBlocks(content) {
    if (!content.includes('<UpdateVariable>')) {
        return { commands: [], strippedContent: content };
    }
    const commands = [];
    for (const blockMatch of content.matchAll(BLOCK_RE)) {
        const body = blockMatch[1];
        SET_CALL_RE.lastIndex = 0;
        let setMatch;
        while ((setMatch = SET_CALL_RE.exec(body)) !== null) {
            const path = setMatch[2];
            let value;
            if (setMatch[4] !== undefined) {
                value = setMatch[4];
            }
            else if (setMatch[5] !== undefined) {
                value = Number(setMatch[5]);
            }
            else if (setMatch[6] !== undefined) {
                const lit = setMatch[6];
                value = lit === 'null' ? null : lit === 'true';
            }
            commands.push({ path, value });
        }
    }
    const strippedContent = content.replace(BLOCK_RE, '');
    return { commands, strippedContent };
}
function applyMvuCommands(blob, commands) {
    for (const cmd of commands) {
        lodashSet(blob, cmd.path, cmd.value);
    }
    return blob;
}

},
"src/backend/mvu-yaml.ts": function (module, exports, require) {
"use strict";
// Minimal YAML parser for the MVU <initvar> subset documented in
// docs/mvu-design.md. Block-style mappings only, space indentation,
// scalar values (string / int / float). CJK keys supported. Quoted
// strings, flow style, arrays, block scalars, anchors, tags are not
// supported — malformed lines are skipped with a warning.
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseYaml = parseYaml;
const INT_RE = /^-?\d+$/;
const FLOAT_RE = /^-?\d+\.\d+$/;
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
    const lines = source.split(/\r?\n/).map((l) => l.replace(/\r+$/, ''));
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith('#'))
            continue;
        const m = /^( *)(.*)$/.exec(line);
        if (!m)
            continue;
        const indent = m[1].length;
        const rest = m[2];
        if (rest === '')
            continue;
        // Split on the FIRST `: ` (colon followed by space). A bare trailing
        // `:` (key followed by `:` with nothing after) introduces a nested map.
        const sepIdx = rest.indexOf(': ');
        let key;
        let value;
        if (sepIdx >= 0) {
            key = rest.slice(0, sepIdx).trim();
            value = rest.slice(sepIdx + 2);
        }
        else if (rest.endsWith(':')) {
            key = rest.slice(0, -1).trim();
            value = null;
        }
        else {
            console.warn('[vishrun:mvu-yaml] skipped malformed line', { lineNo: i + 1, line });
            continue;
        }
        if (key === '') {
            console.warn('[vishrun:mvu-yaml] skipped empty-key line', { lineNo: i + 1, line });
            continue;
        }
        out.push({ lineNo: i + 1, indent, key, value });
    }
    return out;
}
function parseYaml(source) {
    const tokens = tokenizeLines(source);
    const root = {};
    // Stack of frames. The root sentinel has indent -1.
    const stack = [
        { indent: -1, container: root },
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
        }
        else {
            parent[t.key] = parseScalar(t.value);
        }
    }
    return root;
}

},
"src/backend/mvu-lodash.ts": function (module, exports, require) {
"use strict";
// Pure parser for `_.set(...)` calls emitted by MVU-aware cards in
// LLM responses (Queen Bee's mid-chat variable updates). Strictly
// scoped to the two- and three-arg forms with literal newValue types
// (number / string / boolean / null). Anything else — `_.assign`,
// `_.add`, deltas like `'+50'`, JSON literals like `[1,2,3]`, math
// expressions — is reported via the optional onUnsupported callback
// and skipped. The recognizer in mvu-parser.ts wraps this.
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseLodashSetCalls = parseLodashSetCalls;
const CMD_RE = /_\.([a-zA-Z][a-zA-Z0-9_]*)\s*\(/g;
const SNIPPET_LEN = 80;
/**
 * Parse every `_.<cmd>(...)` call in `blockContent`. For each one:
 *   - If cmd !== 'set': onUnsupported(reason='not-dot-set') and skip.
 *   - If the call is malformed (unbalanced parens): onUnsupported(reason='malformed-call') and skip.
 *   - If arg count is not 2 or 3: onUnsupported(reason='malformed-call') and skip.
 *   - If path arg isn't a plain quoted string of our supported shape:
 *       onUnsupported(reason='path-not-string-literal') and skip.
 *   - If newValue arg isn't a supported literal:
 *       onUnsupported(reason='value-not-literal') and skip.
 *   - Else: append { path, newValue, index } to the result list.
 *
 * Defensive: never throws on malformed input.
 */
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
            onUnsupported?.(snippet(blockContent, callStart), 'malformed-call');
            continue;
        }
        const { args, endIndex } = argsParse;
        if (cmd !== 'set') {
            onUnsupported?.(snippet(blockContent, callStart), 'not-dot-set');
            CMD_RE.lastIndex = endIndex;
            continue;
        }
        if (args.length !== 2 && args.length !== 3) {
            onUnsupported?.(snippet(blockContent, callStart), 'malformed-call');
            CMD_RE.lastIndex = endIndex;
            continue;
        }
        const pathArg = args[0].trim();
        const valueArg = args[args.length - 1].trim();
        const path = parseStringLiteral(pathArg);
        if (path === null || path.length === 0) {
            onUnsupported?.(snippet(blockContent, callStart), 'path-not-string-literal');
            CMD_RE.lastIndex = endIndex;
            continue;
        }
        const newValue = parseLiteralValue(valueArg);
        if (newValue === undefined) {
            onUnsupported?.(snippet(blockContent, callStart), 'value-not-literal');
            CMD_RE.lastIndex = endIndex;
            continue;
        }
        out.push({ path, newValue, index: callStart });
        CMD_RE.lastIndex = endIndex;
    }
    return out;
}
// ---- Internal helpers ----
function snippet(src, start) {
    return src.slice(start, start + SNIPPET_LEN);
}
// Walk the source from `start` (the char right after `_.set(`), tracking
// paren / bracket / brace depth and quote state, until we find the
// matching close paren. Splits top-level commas (depth-zero across all
// three bracket families) into argument substrings. Returns null on
// unbalanced input.
//
// Bracket / brace tracking matters because JSON-literal newValues like
// `[1, 2, 3]` or `{ x: 1, y: 2 }` contain internal commas that would
// otherwise split into spurious extra "args" and confuse the call shape.
// We keep these as a single arg so parseLiteralValue can reject them
// uniformly as `'value-not-literal'`.
function scanArgList(src, start) {
    const args = [];
    let cur = '';
    let parenDepth = 0;
    let bracketDepth = 0;
    let braceDepth = 0;
    let inString = null;
    let i = start;
    while (i < src.length) {
        const c = src[i];
        if (inString !== null) {
            cur += c;
            if (c === '\\' && i + 1 < src.length) {
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
        if (c === '(') {
            parenDepth++;
            cur += c;
            i++;
            continue;
        }
        if (c === '[') {
            bracketDepth++;
            cur += c;
            i++;
            continue;
        }
        if (c === '{') {
            braceDepth++;
            cur += c;
            i++;
            continue;
        }
        if (c === ')') {
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
        if (c === ']') {
            if (bracketDepth > 0)
                bracketDepth--;
            cur += c;
            i++;
            continue;
        }
        if (c === '}') {
            if (braceDepth > 0)
                braceDepth--;
            cur += c;
            i++;
            continue;
        }
        if (c === ',' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
            args.push(cur);
            cur = '';
            i++;
            continue;
        }
        cur += c;
        i++;
    }
    return null;
}
// Plain string literal: surrounded by matching `'` or `"`, no backslash
// escapes, no embedded same-quote char, no brackets, no dots-with-escape.
// Returns the inner content, or null on any non-conforming shape.
function parseStringLiteral(raw) {
    if (raw.length < 2)
        return null;
    const open = raw[0];
    if (open !== '"' && open !== "'")
        return null;
    if (raw[raw.length - 1] !== open)
        return null;
    const inner = raw.slice(1, -1);
    // Out of scope: backslash escapes within quotes.
    if (inner.indexOf('\\') !== -1)
        return null;
    // Out of scope: bracket notation (`stat_data["x"]`).
    if (inner.indexOf('[') !== -1 || inner.indexOf(']') !== -1)
        return null;
    // Embedded same-quote that wasn't terminated — argsplit should have
    // tolerated this only if escaped; defensive check.
    if (inner.indexOf(open) !== -1)
        return null;
    return inner;
}
// Recognise newValue forms supported in this iteration:
//   - true / false / null (case-sensitive bare keyword)
//   - quoted string (single or double), with the same restrictions as
//     parseStringLiteral, plus a delta-shape guard that rejects strings
//     starting with `+digit` or `-digit` — those are intended math
//     expressions (out of scope) and we'd silently misinterpret them
//     as literal strings.
//   - number (integer or decimal, optionally negative).
// Returns undefined for anything else (caller logs value-not-literal).
function parseLiteralValue(raw) {
    const t = raw.trim();
    if (t === 'true')
        return true;
    if (t === 'false')
        return false;
    if (t === 'null')
        return null;
    if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0]) {
        const inner = parseStringLiteral(t);
        if (inner === null)
            return undefined;
        // Delta-shape guard: `'+50'` or `'-7'` inside quotes is the MVU
        // convention for "add 50" / "subtract 7" — a delta operation, not
        // a literal string assignment. Out of scope this iteration; the
        // recognizer reports it via onUnsupported instead of writing the
        // string at the path (which would silently misinterpret intent).
        if (/^[+-]\d/.test(inner))
            return undefined;
        return inner;
    }
    // Number: optional minus, digits, optional fractional part. No
    // exponent / hex / bigint forms — none of the cards in scope use them.
    if (/^-?\d+(?:\.\d+)?$/.test(t))
        return parseFloat(t);
    return undefined;
}

},
"src/core/diagnostics.ts": function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VSH_VISHRUN_DIAG = void 0;
// Single switch for anomaly-only diagnostic logs (placeholder-skipped,
// inject-error, unknown-command). Real errors (console.warn) are not
// gated and stay on regardless.
exports.VSH_VISHRUN_DIAG = false;

},
"src/backend/generate-relay.ts": function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.installGenerateRelayHandler = installGenerateRelayHandler;
const common_1 = require("./common");
const pendingGenerateRelays = new Map();
function isGenerateRelayCancelRequest(p) {
    return (!!p &&
        typeof p === 'object' &&
        p.type === 'vsh_generate_cancel' &&
        typeof p.requestId === 'string');
}
function isGenerateRelayRequest(p) {
    return (!!p &&
        typeof p === 'object' &&
        p.type === 'vsh_generate' &&
        typeof p.requestId === 'string' &&
        Array.isArray(p.messages));
}
function installGenerateRelayHandler() {
    common_1.api.onFrontendMessage((payload, userId) => {
        if (isGenerateRelayCancelRequest(payload)) {
            const pending = pendingGenerateRelays.get(payload.requestId);
            if (pending && pending.userId === userId)
                pending.controller.abort();
            return;
        }
        if (!isGenerateRelayRequest(payload))
            return;
        const { requestId, messages, provider, model, connection_id, parameters, tools, tool_choice } = payload;
        const controller = new AbortController();
        pendingGenerateRelays.set(requestId, { userId, controller });
        const input = {
            provider: provider || '',
            model: model || '',
            messages,
            userId,
            signal: controller.signal,
        };
        if (connection_id)
            input.connection_id = connection_id;
        if (parameters)
            input.parameters = parameters;
        // Map OpenAI format -> Lumiverse ToolDefinition format
        if (tools && Array.isArray(tools)) {
            input.tools = tools.map((t) => {
                if (t?.type === 'function' && t?.function) {
                    return {
                        name: t.function.name,
                        description: t.function.description,
                        parameters: t.function.parameters,
                        ...(t.function.strict !== undefined ? { strict: t.function.strict } : {}),
                    };
                }
                return t; // Fallback
            });
        }
        // Lumiverse expects tool_choice inside parameters
        if (tool_choice) {
            if (!input.parameters)
                input.parameters = {};
            input.parameters.tool_choice = tool_choice;
        }
        common_1.api.generate.raw(input).then((result) => {
            common_1.api.sendToFrontend({ type: 'vsh_generate_result', requestId, result }, userId);
        }, (err) => {
            const name = err instanceof Error ? err.name : '';
            const message = err instanceof Error ? err.message : String(err);
            common_1.api.sendToFrontend({
                type: 'vsh_generate_error',
                requestId,
                error: name === 'AbortError' ? `AbortError: ${message || 'Generation aborted'}` : message,
            }, userId);
        }).finally(() => {
            const pending = pendingGenerateRelays.get(requestId);
            if (pending?.controller === controller)
                pendingGenerateRelays.delete(requestId);
        });
    });
}

},
"src/backend/user-message-bridge.ts": function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.installUserMessageBridgeHandler = installUserMessageBridgeHandler;
const common_1 = require("./common");
const LOG_PREFIX = '[vishrun:user-message]';
const FRONTEND_TIMEOUT_MS = 110_000;
const HOST_TIMEOUT_MS = 120_000;
const subscribedUsers = new Set();
const pendingRequests = new Map();
function isSubscriptionMessage(payload) {
    return !!payload
        && typeof payload === 'object'
        && payload.type === 'vsh_user_message_subscription'
        && typeof payload.active === 'boolean';
}
function isCompleteMessage(payload) {
    if (!payload || typeof payload !== 'object')
        return false;
    const value = payload;
    return value.type === 'vsh_user_message_complete'
        && typeof value.requestId === 'string'
        && (value.content === undefined || typeof value.content === 'string')
        && (value.cancelGeneration === undefined || typeof value.cancelGeneration === 'boolean')
        && (value.removeMessage === undefined || typeof value.removeMessage === 'boolean')
        && (value.error === undefined || typeof value.error === 'string');
}
function clearPending(requestId) {
    const pending = pendingRequests.get(requestId);
    if (!pending)
        return null;
    pendingRequests.delete(requestId);
    clearTimeout(pending.timer);
    if (pending.signal && pending.abortHandler) {
        pending.signal.removeEventListener('abort', pending.abortHandler);
    }
    return pending;
}
function releasePendingForUser(userId) {
    for (const [requestId, pending] of pendingRequests) {
        if (pending.userId !== userId)
            continue;
        clearPending(requestId)?.resolve(null);
    }
}
async function findLatestUserMessage(chatId) {
    const messages = await common_1.api.chat.getMessages(chatId);
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (message.role !== 'user' || typeof message.id !== 'string' || typeof message.content !== 'string')
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
        throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            const pending = clearPending(requestId);
            if (!pending)
                return;
            common_1.api.sendToFrontend({ type: 'vsh_user_message_cancel', requestId }, userId);
            console.warn(LOG_PREFIX, `frontend handler timed out after ${FRONTEND_TIMEOUT_MS}ms; using original message`);
            pending.resolve(null);
        }, FRONTEND_TIMEOUT_MS);
        const pending = {
            userId,
            chatId,
            messageId: message.id,
            originalContent: message.content,
            resolve,
            timer,
            signal,
        };
        if (signal) {
            pending.abortHandler = () => {
                const active = clearPending(requestId);
                if (!active)
                    return;
                common_1.api.sendToFrontend({ type: 'vsh_user_message_cancel', requestId }, userId);
                reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
            };
            signal.addEventListener('abort', pending.abortHandler, { once: true });
        }
        pendingRequests.set(requestId, pending);
        common_1.api.sendToFrontend({
            type: 'vsh_user_message_request',
            requestId,
            chatId,
            message: { id: message.id, content: message.content },
            ...(generationType ? { generationType } : {}),
        }, userId);
    });
}
async function processGenerationContext(context) {
    const { chatId, userId, generationType, dryRun } = context;
    if (!chatId || !userId || dryRun || generationType !== 'normal' || !subscribedUsers.has(userId)) {
        return context;
    }
    const message = await findLatestUserMessage(chatId);
    if (!message)
        return context;
    const result = await requestFrontendProcessing(context, message);
    if (!result)
        return context;
    if (result.error) {
        console.warn(LOG_PREFIX, 'frontend handler reported an error:', result.error);
    }
    if (result.cancelGeneration) {
        if (result.removeMessage) {
            try {
                await common_1.api.chat.deleteMessage(chatId, message.id);
            }
            catch (error) {
                console.warn(LOG_PREFIX, 'failed to remove cancelled user message:', error instanceof Error ? error.message : String(error));
            }
        }
        return { ...context, cancelGeneration: true };
    }
    if (typeof result.content === 'string' && result.content !== message.content) {
        await common_1.api.chat.updateMessage(chatId, message.id, { content: result.content });
    }
    return context;
}
function installUserMessageBridgeHandler() {
    common_1.api.onFrontendMessage((payload, userId) => {
        if (isSubscriptionMessage(payload)) {
            if (payload.active) {
                subscribedUsers.add(userId);
            }
            else {
                subscribedUsers.delete(userId);
                releasePendingForUser(userId);
            }
            return;
        }
        if (!isCompleteMessage(payload))
            return;
        const pending = pendingRequests.get(payload.requestId);
        if (!pending || pending.userId !== userId)
            return;
        clearPending(payload.requestId)?.resolve(payload);
    });
    common_1.api.registerContextHandler(async (rawContext) => processGenerationContext(rawContext), 40, { timeoutMs: HOST_TIMEOUT_MS });
}

},
"src/backend/message-render-bridge.ts": function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.holdMessageRender = holdMessageRender;
exports.bindMessageRender = bindMessageRender;
exports.allowMessageRender = allowMessageRender;
exports.releaseMessageRender = releaseMessageRender;
exports.messageRenderStatus = messageRenderStatus;
exports.ensureMessageRenderDisplayOwner = ensureMessageRenderDisplayOwner;
exports.installMessageRenderBridge = installMessageRenderBridge;
const common_1 = require("./common");
const HOLD_TTL_MS = 5 * 60 * 1000;
const DISPLAY_OWNER_NAMESPACE = 'vishrun_chibijokes';
const holds = new Map();
const targetOwners = new Map();
const pendingOwners = new Map();
function targetKey(chatId, messageId) {
    return `${chatId}\u0000${messageId}`;
}
function normalizeHold(spec) {
    const id = String(spec?.id || '').trim();
    const chatId = String(spec?.chatId || '').trim();
    const messageId = spec?.messageId == null ? '' : String(spec.messageId).trim();
    if (!id)
        throw new Error('Message render hold id is required.');
    if (!chatId)
        throw new Error('Message render chatId is required.');
    return { id, chatId, ...(messageId ? { messageId } : {}), content: String(spec?.content ?? '') };
}
function removeHold(id) {
    const hold = holds.get(id) ?? null;
    if (!hold)
        return null;
    holds.delete(id);
    if (hold.messageId) {
        const key = targetKey(hold.chatId, hold.messageId);
        if (targetOwners.get(key) === id)
            targetOwners.delete(key);
    }
    if (pendingOwners.get(hold.chatId) === id)
        pendingOwners.delete(hold.chatId);
    return hold;
}
function pruneExpired() {
    const now = Date.now();
    for (const [id, hold] of holds) {
        if (hold.expiresAt <= now)
            removeHold(id);
    }
}
async function getMessage(chatId, messageId) {
    const rows = await common_1.api.chat.getMessages(chatId);
    return Array.isArray(rows)
        ? rows.find((row) => String(row?.id) === messageId) ?? null
        : null;
}
async function holdMessageRender(spec) {
    pruneExpired();
    const safe = normalizeHold(spec);
    removeHold(safe.id);
    const hold = {
        id: safe.id,
        chatId: safe.chatId,
        messageId: safe.messageId || null,
        overrideContent: safe.content,
        expiresAt: Date.now() + HOLD_TTL_MS,
    };
    holds.set(hold.id, hold);
    if (hold.messageId) {
        const key = targetKey(hold.chatId, hold.messageId);
        const previous = targetOwners.get(key);
        if (previous && previous !== hold.id)
            removeHold(previous);
        targetOwners.set(key, hold.id);
    }
    else {
        const previous = pendingOwners.get(hold.chatId);
        if (previous && previous !== hold.id)
            removeHold(previous);
        pendingOwners.set(hold.chatId, hold.id);
    }
    return { held: true, pending: !hold.messageId, id: hold.id, chatId: hold.chatId, messageId: hold.messageId };
}
async function bindMessageRender(idValue, messageIdValue) {
    pruneExpired();
    const id = String(idValue || '').trim();
    const messageId = String(messageIdValue || '').trim();
    if (!id)
        throw new Error('Message render hold id is required.');
    if (!messageId)
        throw new Error('Message render messageId is required.');
    const hold = holds.get(id);
    if (!hold)
        throw new Error('Message render hold is not active.');
    if (hold.messageId) {
        const previousKey = targetKey(hold.chatId, hold.messageId);
        if (targetOwners.get(previousKey) === id)
            targetOwners.delete(previousKey);
    }
    if (pendingOwners.get(hold.chatId) === id)
        pendingOwners.delete(hold.chatId);
    const key = targetKey(hold.chatId, messageId);
    const previous = targetOwners.get(key);
    if (previous && previous !== id)
        removeHold(previous);
    hold.messageId = messageId;
    hold.expiresAt = Date.now() + HOLD_TTL_MS;
    targetOwners.set(key, id);
    return { bound: true, id, chatId: hold.chatId, messageId };
}
async function allowMessageRender(idValue, content) {
    pruneExpired();
    const id = String(idValue || '').trim();
    const hold = holds.get(id);
    if (!hold)
        throw new Error('Message render hold is not active.');
    hold.allowedContent = String(content ?? '');
    hold.expiresAt = Date.now() + HOLD_TTL_MS;
    return { allowed: true, id };
}
async function releaseMessageRender(idValue, options = {}) {
    pruneExpired();
    const id = String(idValue || '').trim();
    if (!id)
        return { released: false };
    const hold = removeHold(id);
    if (!hold)
        return { released: false };
    if (options.refresh && hold.messageId) {
        const message = await getMessage(hold.chatId, hold.messageId);
        if (message) {
            await common_1.api.chat.updateMessage(hold.chatId, hold.messageId, {
                content: String(message.content ?? ''),
            });
        }
    }
    return { released: true, id, chatId: hold.chatId, messageId: hold.messageId };
}
function messageRenderStatus(idValue) {
    pruneExpired();
    if (idValue)
        return holds.get(String(idValue)) ?? null;
    return Array.from(holds.values()).map((hold) => ({ ...hold }));
}
async function ensureMessageRenderDisplayOwner(characterIdValue, userId) {
    const characterId = String(characterIdValue || '').trim();
    if (!characterId)
        throw new Error('Character id is required.');
    const character = await common_1.api.characters.get(characterId, userId);
    if (!character)
        throw new Error('Character not found.');
    const extensions = character.extensions && typeof character.extensions === 'object'
        ? character.extensions
        : {};
    const own = extensions[DISPLAY_OWNER_NAMESPACE] && typeof extensions[DISPLAY_OWNER_NAMESPACE] === 'object'
        ? { ...extensions[DISPLAY_OWNER_NAMESPACE] }
        : {};
    if (own.display_owner === true) {
        return { changed: false, characterId, owner: DISPLAY_OWNER_NAMESPACE };
    }
    await common_1.api.characters.update(characterId, {
        extensions: {
            [DISPLAY_OWNER_NAMESPACE]: {
                ...own,
                display_owner: true,
            },
        },
    }, userId);
    return { changed: true, characterId, owner: DISPLAY_OWNER_NAMESPACE };
}
async function processMessageRender(ctx) {
    if (ctx.origin !== 'render' || ctx.isUser || !ctx.messageId)
        return;
    pruneExpired();
    const chatId = String(ctx.chatId);
    const messageId = String(ctx.messageId);
    const id = targetOwners.get(targetKey(chatId, messageId));
    if (!id)
        return;
    const hold = holds.get(id);
    if (!hold)
        return;
    const content = String(ctx.content ?? '');
    if (hold.allowedContent !== undefined && content === hold.allowedContent)
        return;
    return { content: hold.overrideContent };
}
function installMessageRenderBridge() {
    common_1.api.registerMessageContentProcessor((ctx) => processMessageRender(ctx), 5);
}

},
"src/backend/regex-takeover.ts": function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.takeoverCharacterRows = takeoverCharacterRows;
exports.installRegexTakeoverHandler = installRegexTakeoverHandler;
const common_1 = require("./common");
const takeover_policy_1 = require("../core/takeover-policy");
const REQUIRED = ['regex_scripts', 'regex_scripts_unrestricted'];
function isTakeoverRequest(p) {
    if (!p || typeof p !== 'object')
        return false;
    const r = p;
    return r.type === 'regex_takeover' && typeof r.requestId === 'string'
        && typeof r.characterId === 'string' && Array.isArray(r.scripts);
}
function targetsOf(t) {
    return Array.isArray(t) ? t : [t];
}
async function takeoverCharacterRows(regex, characterId, scripts, userId, now = Date.now) {
    const wanted = new Set(scripts.map((s) => (0, takeover_policy_1.hostPatternOf)(s.findRegex) + '\u0000' + s.replaceString));
    if (wanted.size === 0)
        return 0;
    const rows = [];
    for (let offset = 0;; offset += 200) {
        const page = await regex.list({ scope: 'character', scopeId: characterId, limit: 200, offset, userId });
        rows.push(...page.data);
        if (page.data.length < 200 || rows.length >= page.total)
            break;
    }
    let disabled = 0;
    for (const row of rows) {
        if (row.disabled || row.can_mutate === false)
            continue;
        if (!wanted.has(row.find_regex + '\u0000' + row.replace_string))
            continue;
        if (targetsOf(row.target).includes('prompt'))
            continue;
        const meta = row.metadata ?? {};
        if (meta.vishrun && typeof meta.vishrun === 'object')
            continue;
        await regex.update(row.id, {
            disabled: true,
            metadata: { ...meta, vishrun: { takeover: true, at: now() } },
        }, userId);
        disabled++;
    }
    return disabled;
}
let warnedMissing = false;
function installRegexTakeoverHandler() {
    common_1.api.onFrontendMessage((payload, userId) => {
        if (!isTakeoverRequest(payload))
            return;
        const { requestId, characterId, scripts } = payload;
        void (async () => {
            const response = { type: 'regex_takeover_response', requestId, disabled: 0 };
            try {
                const granted = await common_1.api.permissions.getGranted();
                const missing = REQUIRED.filter((p) => !granted.includes(p));
                if (missing.length > 0) {
                    response.missingPermissions = missing;
                    if (!warnedMissing) {
                        warnedMissing = true;
                        console.warn(`[vishrun] grant ${missing.join(' + ')} so imported card scripts do not override Vishrun widgets`);
                    }
                }
                else {
                    const regex = common_1.api.regex_scripts;
                    response.disabled = await takeoverCharacterRows(regex, characterId, scripts, userId);
                }
            }
            catch (err) {
                response.error = err instanceof Error ? err.message : String(err);
                console.warn('[vishrun] regex takeover failed:', response.error);
            }
            common_1.api.sendToFrontend(response, userId);
        })();
    });
}

},
"src/core/takeover-policy.ts": function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.takeoverReasons = takeoverReasons;
exports.selectTakeoverCandidates = selectTakeoverCandidates;
exports.hostPatternOf = hostPatternOf;
const parse_regex_script_1 = require("./parse-regex-script");
const macro_detection_1 = require("./macro-detection");
const SCRIPT_RE = /<script\b/i;
const EVENT_HANDLER_RE = /\son[a-z]+\s*=/i;
const JS_URL_RE = /javascript\s*:/i;
// Tags the host sanitizer forbids in message HTML.
const BLOCKED_TAG_RE = /<(?:iframe|frame|object|embed|meta|base|link|form|math)\b|\ssrcdoc\s*=/i;
// Native replacement only knows $1..$99, $& and named groups.
const DOLLAR_ZERO_RE = /\$0(?!\d)/;
function takeoverReasons(replaceString) {
    const r = [];
    if (SCRIPT_RE.test(replaceString))
        r.push('script');
    if (EVENT_HANDLER_RE.test(replaceString))
        r.push('event-handler');
    if (JS_URL_RE.test(replaceString))
        r.push('js-url');
    if (BLOCKED_TAG_RE.test(replaceString))
        r.push('blocked-tag');
    // Imported rows get no replacement-macro substitution, unlike SillyTavern.
    if ((0, macro_detection_1.hasMacros)(replaceString))
        r.push('macro');
    if (DOLLAR_ZERO_RE.test(replaceString))
        r.push('dollar-zero');
    return r;
}
// Card scripts Vishrun renders itself and the native renderer would break.
function selectTakeoverCandidates(scripts) {
    const renderable = new Set((0, parse_regex_script_1.compileScripts)(scripts).filter((c) => c.kind !== 'unknown').map((c) => c.sourceIndex));
    const out = [];
    scripts.forEach((s, i) => {
        if (!renderable.has(i))
            return;
        if (typeof s.findRegex !== 'string' || typeof s.replaceString !== 'string')
            return;
        const reasons = takeoverReasons(s.replaceString);
        if (reasons.length === 0)
            return;
        out.push({ name: s.scriptName ?? '', findRegex: s.findRegex, replaceString: s.replaceString, reasons });
    });
    return out;
}
// Mirrors the host importer's `/pattern/flags` parsing so stored rows compare equal.
function hostPatternOf(findRegex) {
    const m = findRegex.match(/^\/(.+)\/([dgimsuvy]*)$/s);
    return m ? m[1] : findRegex;
}

},
"src/core/parse-regex-script.ts": function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.stripCodeFence = stripCodeFence;
exports.parseRegexLiteral = parseRegexLiteral;
exports.mergeFlags = mergeFlags;
exports.rewriteSelfClosingToPaired = rewriteSelfClosingToPaired;
exports.compileScripts = compileScripts;
const classify_trigger_1 = require("./classify-trigger");
/**
 * Strip a markdown code fence wrapping the entire string.
 *
 * Tolerates:
 *  - optional language hint (case-insensitive: ```html, ```HTML, ```)
 *  - leading/trailing whitespace around the whole block
 *  - trailing whitespace on the opening line (after the language hint)
 *  - CRLF or LF line endings
 *
 * Pass-through (returns input unchanged) when:
 *  - no fence at all
 *  - opening fence with no matching close
 *  - any other shape we can't unambiguously unwrap
 */
const FENCE_RE = /^\s*```[A-Za-z]*[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```\s*$/;
function stripCodeFence(s) {
    if (!s)
        return s;
    const m = s.match(FENCE_RE);
    return m ? m[1] : s;
}
/**
 * Parse a JS-style regex literal `/pattern/flags` out of a card's findRegex
 * source. Some cards (e.g. ↦/↤-delimited capture scripts) author their
 * findRegex with the literal delimiters intact; passing such a string raw
 * to `new RegExp` makes the slashes part of the pattern and the regex
 * never matches anything.
 *
 * The inner pattern is parsed tolerantly: escape sequences (`\.`, `\/`,
 * `\\`) are preserved as-is; the closing `/` is the first unescaped slash.
 * Flags are validated against the JS-supported set; anything else falls
 * through to "not a literal" so we don't silently misinterpret a pattern
 * that happens to start with `/`.
 *
 * Returns `{ pattern, flags }` — `flags` is `''` when the input wasn't a
 * literal (caller treats the whole input as the pattern).
 */
function parseRegexLiteral(s) {
    const m = s.match(/^\s*\/((?:\\.|[^/\\])*)\/([gimsuy]*)\s*$/);
    if (!m || !m[1])
        return { pattern: s, flags: '' };
    return { pattern: m[1], flags: m[2] };
}
/**
 * Merge user flags from a regex literal with the default `gs` Vishrun
 * relies on. `g` is required for `matchAll`-style scanning in the render
 * pipeline; `s` (dotAll) is needed so paired-tag scripts whose inner
 * content spans lines still match. Duplicates are deduped.
 */
function mergeFlags(userFlags) {
    const set = new Set(['g', 's']);
    for (const f of userFlags)
        set.add(f);
    return Array.from(set).join('');
}
// Self-closing tag detection on raw findRegex source string.
// Matches `<TAG/>`, `<TAG />`, `<TAG attr="val"/>` where TAG starts uppercase.
const SELF_CLOSING_RE = /^<([A-Z][a-zA-Z0-9_-]*)(\s[^>]*)?\s*\/>$/;
// Rewrite self-closing findRegex to paired form so the compiled regex
// matches content after backend expansion (see expandSelfClosingTags).
function rewriteSelfClosingToPaired(src) {
    const m = src.match(SELF_CLOSING_RE);
    if (!m)
        return null;
    const attrs = m[2] ? m[2].trimEnd() : '';
    return `<${m[1]}${attrs}></${m[1]}>`;
}
/**
 * Compile raw regex_scripts into a usable form.
 *  - Drops disabled scripts.
 *  - Drops `promptOnly` scripts. Those belong to SillyTavern's prompt
 *    pipeline (what reaches the LLM), not the display pipeline that
 *    Vishrun owns.
 *  - Drops scripts whose `placement` is set and excludes 2 (render-side).
 *  - Rewrites self-closing tag findRegex (`<TAG/>`) to paired form
 *    (`<TAG></TAG>`) so the tag interceptor pipeline can handle it.
 *  - Builds findRe with `new RegExp(pattern, flags)`.
 *  - Strips markdown code fence around replaceString.
 *  - Drops scripts whose findRegex fails to compile (with debug log).
 */
function compileScripts(rawScripts) {
    const out = [];
    for (let i = 0; i < rawScripts.length; i++) {
        const s = rawScripts[i];
        if (s.disabled)
            continue;
        if (s.promptOnly)
            continue;
        if (Array.isArray(s.placement) && !s.placement.includes(2))
            continue;
        const src = s.findRegex;
        if (!src || typeof src !== 'string')
            continue;
        const replace = stripCodeFence(s.replaceString ?? '');
        const effectiveSrc = rewriteSelfClosingToPaired(src) ?? src;
        const { pattern, flags } = parseRegexLiteral(effectiveSrc);
        let re;
        try {
            re = new RegExp(pattern, mergeFlags(flags));
        }
        catch (err) {
            console.debug(`[vishrun] script "${s.scriptName ?? '(unnamed)'}" findRegex failed to compile:`, err);
            continue;
        }
        const kind = (0, classify_trigger_1.classifyTrigger)(re);
        if (kind === 'unknown') {
            console.debug(`[vishrun] script "${s.scriptName ?? '(unnamed)'}" has unrecognized trigger shape ` +
                `(not placeholder, paired-tag, nor delimited-capture) — will not render. findRegex: ${src}`);
        }
        out.push({
            id: s.id ?? `idx-${i}`,
            scriptName: s.scriptName ?? '(unnamed)',
            findRe: re,
            replaceString: replace,
            kind,
            sourceIndex: i,
            minDepth: s.minDepth ?? null,
            maxDepth: s.maxDepth ?? null,
        });
    }
    return out;
}

},
"src/core/classify-trigger.ts": function (module, exports, require) {
"use strict";
/**
 * Trigger classification — four buckets:
 *
 *   - `placeholder` → trigger is a literal-ish marker that isn't shaped like
 *     an HTML tag and has no capture groups (e.g. `【VAVESTA_HOME】`).
 *     Renders via the post-DOMPurify text-node scan in
 *     `replacePlaceholderMatches`.
 *
 *   - `pairedTag` → trigger has `<TAGNAME>...</TAGNAME>` shape regardless of
 *     whether it carries capture groups. Pacifica University is the canonical
 *     no-capture-group example (its findRegex wraps `PACIFICA_UI` with `\s*`
 *     decoration on both ends, matched by the tolerant detector below).
 *     These MUST go through `ctx.messages.registerTagInterceptor` because
 *     Lumiverse's DOMPurify (`richHtmlSanitizer.ts`) strips unknown elements
 *     before render — by the time the placeholder pipeline scans text nodes,
 *     `<TAGNAME>` is gone (only the inner text content survives via
 *     KEEP_CONTENT). The interceptor fires PRE-sanitizer in
 *     `stripAndDispatchMessageTags` (`MessageContent.tsx:561`).
 *
 *   - `delimitedCapture` → trigger has capture group(s) wrapped in a
 *     recognized non-tag delimiter: a Unicode bracket pair (`【】` `「」` `《》`
 *     `『』`, the asymmetric `↦↤`) or a symmetric `[ START OF X ]…[ END OF X ]`
 *     textual block marker. Behaves like `placeholder` for DOM purposes (the
 *     delimiters survive DOMPurify, so it goes through the text-node scan +
 *     `$N` substitution). Jujutsu Kaisen World's HUD/Profile/Inventory lines,
 *     Domain Clash, Inner Monologue, Present Characters, the Check scripts.
 *
 *   - `unknown` → has captures or other regex structure but matches none of
 *     the above. We log once at compile time so the card author has a hint.
 *
 * Why we no longer use the "has capture group" heuristic alone: it conflates
 * "needs paired-tag pipeline" with "needs $N substitution". Pacifica needs
 * paired-tag (because of DOMPurify) but uses only `$0` (full match) — zero
 * captures. Vavesta Home is the inverse: placeholder shape, no captures.
 * The two axes are independent. Step 6 split them; Fix B added the fourth bucket.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isPlaceholderLikeKind = isPlaceholderLikeKind;
exports.isPlaceholder = isPlaceholder;
exports.isPairedTag = isPairedTag;
exports.isDelimitedCapture = isDelimitedCapture;
exports.isAnglePipeCapture = isAnglePipeCapture;
exports.classifyTrigger = classifyTrigger;
/** Kinds that render through the placeholder pipeline (text-node scan + $N).
 * Multi-line variant uses the linearize-bubble path inside the same pipeline. */
function isPlaceholderLikeKind(kind) {
    return kind === 'placeholder' || kind === 'delimitedCapture' || kind === 'delimitedCaptureMultiLine';
}
// Heuristic: regex pattern needs to span multiple text nodes / paragraphs.
// `[\s\S]` and `\n` in the source explicitly cross newlines; the `m` flag with
// `^`/`$` anchors implies the author wrote line-aware matching. Anything else
// stays single-line.
function isMultiLineRegex(re) {
    const src = re.source;
    if (src.includes('[\\s\\S]'))
        return true;
    if (src.includes('\\n'))
        return true;
    if (re.flags.includes('m') && (src.includes('^') || src.includes('$')))
        return true;
    return false;
}
/**
 * Heuristic: regex source has no unescaped, non-grouping `(`.
 *
 * Used as a building block of `classifyTrigger`. Not a sufficient signal on
 * its own (Pacifica satisfies this — no captures — but is paired-tag, not
 * placeholder), so callers should use `classifyTrigger` instead.
 */
function isPlaceholder(re) {
    const src = re.source;
    let i = 0;
    while (i < src.length) {
        const ch = src[i];
        if (ch === '\\') {
            i += 2;
            continue;
        } // escape — skip next char
        if (ch === '[') {
            // skip char class — `[(...)]` is literal `(`, not a group.
            // Char classes can contain `\]` escapes.
            i++;
            while (i < src.length && src[i] !== ']') {
                if (src[i] === '\\')
                    i += 2;
                else
                    i++;
            }
            i++; // past `]`
            continue;
        }
        if (ch === '(') {
            // `(?:` non-capturing, `(?=` lookahead, `(?!` negative — none of
            // these inline captured data, so a script using only those would
            // also be a placeholder. But none of the cards in scope use them,
            // so we treat any `(` other than `(?:` as a capture-bearing group.
            if (src.slice(i, i + 3) === '(?:') {
                i += 3;
                continue;
            }
            return false;
        }
        i++;
    }
    return true;
}
/**
 * Heuristic: regex source matches `<TAGNAME>...</TAGNAME>` paired shape,
 * tolerant of whitespace decorations (`\s*` literal sequence, plain
 * whitespace) and the regex-escape `\/` style (e.g. `<\/TAGNAME>`).
 *
 * Stays in sync with `extractTagName` in `tag-interceptor.ts` — if a regex's
 * tag name isn't extractable by the same tolerant pattern there, no
 * interceptor can be registered, so it shouldn't be classified as
 * `pairedTag` here either. The shared assumption: card authors decorate
 * with `\s*` for paranoia, but the underlying tag name is a plain ASCII
 * identifier.
 *
 * Limitation: assumes the close tag follows the open in the same source.
 * A regex that wraps in lookaheads or has the close inside an alternation
 * could slip through. None of the cards in scope hit this.
 */
function isPairedTag(re) {
    const src = re.source;
    // Normalize for structural matching:
    //  1. Drop `\s*` literal decorations (3-char sequence `\`, `s`, `*`) so
    //     paranoia-decorated tags like `<\s*TAG\s*>` reduce to `<TAG>`.
    //  2. Replace `\/` with `/` (regex-escape style from /.../-delimited
    //     copy-paste sources) so `<\/TAG>` reduces to `</TAG>`.
    // Do NOT globally collapse whitespace — that destroys the space between
    // tag name and attributes (e.g. `<phone app="X">` → `<phoneapp="X">`),
    // which made attr-bearing paired tags misclassify as `unknown`.
    const stripped = src
        .replace(/\\s\*/g, '')
        .replace(/\\\//g, '/');
    // Tag name is the first identifier after `<` (whitespace tolerated on
    // either side of `<`); it ends at whitespace, `>`, `/`, or attribute.
    const open = stripped.match(/^\s*<\s*([a-zA-Z_][a-zA-Z0-9_-]*)/);
    if (!open)
        return false;
    const tagName = open[1];
    // Close form: `</TAG>` with optional whitespace inside the closing tag.
    const closeRe = new RegExp(`</\\s*${escapeRegex(tagName)}\\s*>`);
    return closeRe.test(stripped);
}
// Unicode delimiter pairs Vishrun recognizes for `delimitedCapture` — symmetric
// CJK brackets plus the asymmetric ↦…↤. Strict allowlist on purpose: a future
// card with another delimiter gets added here, no generic wildcard.
const DELIM_PAIRS = [
    ['【', '】'],
    ['「', '」'],
    ['《', '》'],
    ['『', '』'],
    ['↦', '↤'],
];
// Single-char literal-letter delimiters wrapping a `\{...\}` brace JSON
// capture, with optional `\s*` decorations. Open/close letters may differ.
// Tightest accepted form: rejects single-char delimiters around non-JSON
// bodies and multi-char literal runs.
const LITERAL_JSON_DELIM_RE = /^([A-Za-z])(?:\\s[*+]?)*\(\\\{[\s\S]*\\\}\)(?:\\s[*+]?)*([A-Za-z])$/;
/**
 * Heuristic: regex source contains a `(` that opens a real capturing group —
 * i.e. not `(?:`, `(?=`, `(?!`, or `(?<...` (lookbehind / named group). Skips
 * escapes and char classes the same way `isPlaceholder` does.
 */
function hasRealCapture(src) {
    let i = 0;
    while (i < src.length) {
        const ch = src[i];
        if (ch === '\\') {
            i += 2;
            continue;
        }
        if (ch === '[') {
            i++;
            while (i < src.length && src[i] !== ']') {
                i += src[i] === '\\' ? 2 : 1;
            }
            i++;
            continue;
        }
        if (ch === '(') {
            const a = src.slice(i + 1, i + 3);
            const grouping = a === '?:' || a === '?=' || a === '?!' || (a[0] === '?' && a[1] === '<');
            if (!grouping)
                return true;
        }
        i++;
    }
    return false;
}
/**
 * For `[ START OF X ]…[ END OF X ]` textual block markers: the decoration-
 * stripped name following `kw` in the regex source, up to the first `]` /
 * `\]`. `null` if `kw` (or its closing bracket) isn't present. Used only to
 * confirm the START and END names match (symmetric markers).
 */
function textualMarkerName(src, kw) {
    const i = src.indexOf(kw);
    if (i < 0)
        return null;
    const rest = src.slice(i + kw.length);
    const end = rest.search(/\\?\]/);
    if (end < 0)
        return null;
    const name = rest
        .slice(0, end)
        .replace(/\\s[*+]?/g, '') // drop `\s` / `\s*` / `\s+` decorations
        .replace(/\\/g, '') // drop stray backslashes
        .replace(/\s+/g, ' ')
        .trim();
    return name || null;
}
// Literal square-bracket block markers on both ends, e.g. `\[ST_START\]…\[ST_END\]`.
const BRACKET_MARKERS_RE = /^\\\[[\w ]+\\\][\s\S]*\\\[[\w ]+\\\]$/;
/**
 * Heuristic: regex carries real capture group(s) AND wraps them in a
 * recognized non-tag delimiter — a Unicode pair from `DELIM_PAIRS` (opener
 * before a matching closer), symmetric `START OF X` / `END OF X` textual
 * markers, or single-char literal-letter delimiters around a `\{...\}` brace
 * JSON capture. Tag-shaped sources are explicitly rejected (that's
 * `pairedTag`'s job, checked first). Conservative: anything else stays
 * `unknown`.
 */
function isDelimitedCapture(re) {
    const src = re.source;
    if (!hasRealCapture(src))
        return false;
    const head = src.replace(/^(?:\\s[*+]?|\s)+/, '');
    if (/^<[a-zA-Z_]/.test(head))
        return false; // tag-like opener — not ours
    for (const [open, close] of DELIM_PAIRS) {
        const oi = src.indexOf(open);
        if (oi >= 0 && src.indexOf(close, oi + open.length) >= 0)
            return true;
    }
    if (BRACKET_MARKERS_RE.test(src))
        return true;
    const n1 = textualMarkerName(src, 'START OF');
    const n2 = textualMarkerName(src, 'END OF');
    if (n1 && n1 === n2)
        return true;
    return LITERAL_JSON_DELIM_RE.test(src);
}
// `<Name|cap|cap>` pipe-delimited angle markers (e.g. `<Music Play|(.*?)|(.*?)>`).
// The pipe after the name keeps them out of HTML tag syntax, so the sanitizer
// escapes them as text instead of stripping them.
const ANGLE_PIPE_RE = /^\\?<[A-Za-z][\w ]*\\?\|[\s\S]*\\?>$/;
function isAnglePipeCapture(re) {
    const src = re.source.replace(/^(?:\\s[*+]?|\s)+/, '').replace(/(?:\\s[*+]?|\s)+$/, '');
    if (!hasRealCapture(src))
        return false;
    if (/<\\?\//.test(src))
        return false;
    return ANGLE_PIPE_RE.test(src);
}
/**
 * Four-bucket classification. Order matters: `pairedTag` wins over `placeholder`
 * (Pacifica satisfies `isPlaceholder` — no captures — but is structurally a
 * paired tag); both win over `delimitedCapture` (a `<TAGNAME (foo)>…</TAGNAME>`
 * with captures is a paired tag, not a delimited-capture marker).
 */
function classifyTrigger(re) {
    if (isPairedTag(re))
        return 'pairedTag';
    if (isPlaceholder(re))
        return 'placeholder';
    if (isDelimitedCapture(re))
        return isMultiLineRegex(re) ? 'delimitedCaptureMultiLine' : 'delimitedCapture';
    // Linearized path: markdown autolinks URL captures, splitting the match across nodes.
    if (isAnglePipeCapture(re))
        return 'delimitedCaptureMultiLine';
    return 'unknown';
}
function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

},
"src/core/macro-detection.ts": function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hasMacros = hasMacros;
// Cheap pre-filter so widget HTML with no macros skips the backend round-trip.
// Matches `{{name}}` and `{{name::...}}`, incl. `@`/`$`-prefixed forms. Leans
// permissive: a false positive costs a no-op resolve, a false negative just
// leaves a macro literal (no worse than before MVU-lite).
const MACRO_RE = /\{\{\s*[A-Za-z_@$][\w@$]*\s*(?:::|\}\})/;
function hasMacros(html) {
    return MACRO_RE.test(html);
}

}
};
const __vishrunCache = Object.create(null);
function __vishrunLoad(id) {
  if (__vishrunCache[id]) return __vishrunCache[id].exports;
  const factory = __vishrunModules[id];
  if (!factory) throw new Error('Vishrun bundle missing module: '+id);
  const module={exports:{}};
  __vishrunCache[id]=module;
  const basedir = id.slice(0, id.lastIndexOf('/') + 1);
  const localRequire = (name) => {
    const parts=(basedir + name).split('/'); const normalized=[];
    for (const p of parts) { if (p==='.'||p==='') continue; if (p==='..') normalized.pop(); else normalized.push(p); }
    return __vishrunLoad(normalized.join('/')+(name.endsWith('.js')?'':'.ts'));
  };
  factory(module,module.exports,localRequire);
  return module.exports;
}
const __vishrunEntry = __vishrunLoad("src/backend/index.ts");
export const setup = __vishrunEntry.setup;
