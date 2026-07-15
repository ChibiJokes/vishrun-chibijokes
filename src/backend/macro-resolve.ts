import { api, varsLog } from './common';
import { applySetvarOp, type VarsApi } from './setvar-ops';
import type { SetvarKind } from './parsers/setvar';

// Frontend → backend: resolve a batch of `{{macro}}` widget templates via the
// Lumiverse macro engine (the frontend ctx has none). One round-trip carries
// every widget template for a rendered message; resolved one at a time.

interface ResolveMacrosRequest {
  type: 'resolve_macros';
  requestId: string;
  chatId: string;
  characterId?: string;
  templates: string[];
}

function isResolveMacrosRequest(p: unknown): p is ResolveMacrosRequest {
  if (!p || typeof p !== 'object') return false;
  const r = p as Record<string, unknown>;
  return (
    r.type === 'resolve_macros' &&
    typeof r.requestId === 'string' &&
    typeof r.chatId === 'string' &&
    Array.isArray(r.templates) &&
    r.templates.every((t) => typeof t === 'string')
  );
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
export const DYNAMIC_VAR_MACRO_NAMES: ReadonlySet<string> = new Set(['getvar', 'getchatvar']);

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
export const LOCAL_DYNAMIC_MACRO_NAMES: ReadonlySet<string> = new Set([
  'random', 'roll', 'pick', 'newline', 'input',
]);

function maskInvalidMacros(
  template: string,
  deferNames: ReadonlySet<string> = new Set(),
): { masked: string; masks: string[] } {
  const masks: string[] = [];
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
    if (VALID_MACRO_RE.test(match)) return match; // real macro — let the engine handle it
    const idx = masks.length;
    masks.push(match);
    return `${NUL}VSHMSK${idx}${NUL}`;
  });
  return { masked, masks };
}

function unmaskInvalidMacros(text: string, masks: string[]): string {
  if (masks.length === 0) return text;
  return text.replace(SENTINEL_RE, (_m, idx: string) => masks[Number(idx)] ?? '');
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
const chatSetvarMutex = new Map<string, Promise<unknown>>();

interface SetvarMatch { start: number; end: number; kind: string; name: string; value: string }

export async function applyAndStripSetvars(
  template: string,
  chatId: string,
  userId: string,
  vars: VarsApi = api.variables,
): Promise<string> {
  const matches: SetvarMatch[] = [];
  for (const m of template.matchAll(SETVAR_RE)) {
    const [match, kind, name, value] = m;
    matches.push({ start: m.index!, end: m.index! + match.length, kind: kind.toLowerCase(), name, value });
  }
  if (matches.length === 0) return template;

  const prev = chatSetvarMutex.get(chatId) ?? Promise.resolve();
  const work = prev.then(() => runApplyAndStripSetvars(template, chatId, userId, vars, matches));
  chatSetvarMutex.set(chatId, work.catch(() => undefined));
  return work;
}

async function runApplyAndStripSetvars(
  template: string,
  chatId: string,
  userId: string,
  vars: VarsApi,
  matches: SetvarMatch[],
): Promise<string> {
  // Read current bags once per scope so we can skip idempotent writes.
  // Failure → null map → all writes proceed (safe fallback).
  let localBag: Record<string, string> | null = null;
  let chatBag: Record<string, string> | null = null;
  const needLocal = matches.some((m) => m.kind === 'setvar' && NAME_RE.test(m.name));
  const needChat = matches.some((m) => m.kind === 'setchatvar' && NAME_RE.test(m.name));
  if (needLocal) {
    try { localBag = await vars.local.list(chatId); } catch { localBag = null; }
  }
  if (needChat) {
    try { chatBag = await vars.chat.list(chatId); } catch { chatBag = null; }
  }

  const stripFlags = new Array(matches.length).fill(false);
  for (let i = 0; i < matches.length; i++) {
    const { kind, name, value } = matches[i];
    if (!NAME_RE.test(name)) continue;
    const currentBag = kind === 'setvar' ? localBag : kind === 'setchatvar' ? chatBag : null;
    if (currentBag && currentBag[name] === value) {
      stripFlags[i] = true;
      continue;
    }
    try {
      stripFlags[i] = await applySetvarOp({ kind: kind as SetvarKind, name, value }, chatId, userId, vars);
      if (stripFlags[i] && currentBag) currentBag[name] = value;
    } catch (err) {
      varsLog.warn('setvar persist failed:', { kind, name, err: err instanceof Error ? err.message : String(err) });
    }
  }

  let out = '';
  let cursor = 0;
  for (let i = 0; i < matches.length; i++) {
    const { start, end } = matches[i];
    out += template.slice(cursor, start);
    if (!stripFlags[i]) out += template.slice(start, end);
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
export async function resolveMacroText(
  original: string,
  chatId: string,
  characterId: string | undefined,
  userId: string,
  deferNames: ReadonlySet<string> = new Set(),
): Promise<string> {
  try {
    const stripped = await applyAndStripSetvars(original, chatId, userId);
    const { masked, masks } = maskInvalidMacros(stripped, deferNames);
    const { text, diagnostics } = await api.macros.resolve(masked, {
      chatId,
      characterId,
      userId,
      commit: false,
    });
    if (diagnostics.length > 0) {
      varsLog.debug(`resolve produced ${diagnostics.length} diagnostic(s):`, diagnostics[0]?.message);
    }
    return unmaskInvalidMacros(text, masks);
  } catch (err) {
    varsLog.warn('resolve failed:', err instanceof Error ? err.message : String(err));
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

export async function resolveDynamicVarMacros(text: string, chatId: string): Promise<string> {
  if (!text.includes('{{')) return text;
  DYNAMIC_VAR_RE.lastIndex = 0;
  if (!DYNAMIC_VAR_RE.test(text)) return text;

  const cache = new Map<string, string>();
  DYNAMIC_VAR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  const lookups: Array<Promise<void>> = [];
  while ((m = DYNAMIC_VAR_RE.exec(text)) !== null) {
    const kind = m[1].toLowerCase();
    const key = m[2];
    const cacheKey = `${kind}::${key}`;
    if (cache.has(cacheKey)) continue;
    cache.set(cacheKey, ''); // reserve, filled below — dedupes concurrent identical lookups
    lookups.push(
      (kind === 'getvar' ? api.variables.local.get(chatId, key) : api.variables.chat.get(chatId, key))
        .then((value) => { cache.set(cacheKey, value ?? ''); })
        .catch((err) => {
          varsLog.warn('dynamic var resolve failed:', { kind, key, err: err instanceof Error ? err.message : String(err) });
          cache.set(cacheKey, `{{${kind}::${key}}}`); // leave literal on failure
        }),
    );
  }
  await Promise.all(lookups);

  return text.replace(DYNAMIC_VAR_RE, (full, kind: string, key: string) => {
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

function rollDice(notation: string): string {
  const match = notation.match(/^(\d+)d(\d+)$/i);
  if (!match) return '0';
  const count = Math.min(parseInt(match[1], 10), 100);
  const sides = parseInt(match[2], 10);
  if (sides < 1 || count < 1) return '0';
  let total = 0;
  for (let i = 0; i < count; i++) total += Math.floor(Math.random() * sides) + 1;
  return String(total);
}

function splitArgs(argStr: string | undefined): string[] {
  if (argStr === undefined || argStr === '') return [];
  return argStr.split('::');
}

function randomMacro(argStr: string | undefined): string {
  const args = splitArgs(argStr);
  if (args.length === 0) return String(Math.round(Math.random()));
  const allNumeric = args.length <= 2 && args.every((a) => a.trim() !== '' && !isNaN(Number(a)));
  if (allNumeric) {
    const min = parseInt(args[0], 10) || 0;
    const max = parseInt(args[1], 10) || 1;
    if (max < min) return String(min);
    return String(Math.floor(Math.random() * (max - min + 1)) + min);
  }
  return args[Math.floor(Math.random() * args.length)];
}

function pickMacro(argStr: string | undefined): string {
  const args = splitArgs(argStr);
  if (args.length === 0) return '';
  return args[Math.floor(Math.random() * args.length)];
}

export function resolveLocalDynamicMacros(text: string, lastUserMessage: string): string {
  if (!text.includes('{{')) return text;
  return text.replace(LOCAL_DYNAMIC_RE, (full, name: string, argStr: string | undefined) => {
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

export function installMacroResolveHandler(): void {
  api.onFrontendMessage((payload, userId) => {
    if (!isResolveMacrosRequest(payload)) return;
    const { requestId, chatId, characterId, templates } = payload;
    void (async () => {
      const results: string[] = new Array(templates.length);
      for (let i = 0; i < templates.length; i++) {
        results[i] = await resolveMacroText(templates[i], chatId, characterId, userId);
      }
      
      // 1. Send the HTML response back FIRST. This un-locks the frontend UI shield.
      api.sendToFrontend({ type: 'resolve_macros_response', requestId, results }, userId);
      
      // 2. Now that the UI is unlocked, we wait 100ms for it to finish drawing the HTML, 
      // then we send a safe reactivity ping to force the variables to visually update!
      setTimeout(() => {
        void api.variables.local.set(chatId, '__vishrun_sync', Date.now().toString());
      }, 100);
      
    })();
  });
}
