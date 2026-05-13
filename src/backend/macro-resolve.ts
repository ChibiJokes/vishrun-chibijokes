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
const VALID_MACRO_RE = new RegExp(`^\\{\\{(?:${VALID_MACRO_NAMES.join('|')})(?:::|\\}\\})`);

const NUL = String.fromCharCode(0);
const SENTINEL_RE = new RegExp(`${NUL}VSHMSK(\\d+)${NUL}`, 'g');

function maskInvalidMacros(template: string): { masked: string; masks: string[] } {
  const masks: string[] = [];
  const masked = template.split(NUL).join('').replace(/\{\{[^{}]+\}\}/g, (match) => {
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
const SETVAR_RE = /\{\{(setvar|setchatvar|setgvar|setglobalvar)::([^:}]+)::([^}]*?)\}\}/g;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export async function applyAndStripSetvars(
  template: string,
  chatId: string,
  userId: string,
  vars: VarsApi = api.variables,
): Promise<string> {
  interface SetvarMatch { start: number; end: number; kind: string; name: string; value: string }
  const matches: SetvarMatch[] = [];
  for (const m of template.matchAll(SETVAR_RE)) {
    const [match, kind, name, value] = m;
    matches.push({ start: m.index!, end: m.index! + match.length, kind, name, value });
  }
  if (matches.length === 0) return template;

  const stripFlags = new Array(matches.length).fill(false);
  for (let i = 0; i < matches.length; i++) {
    const { kind, name, value } = matches[i];
    if (!NAME_RE.test(name)) continue;
    try {
      stripFlags[i] = await applySetvarOp({ kind: kind as SetvarKind, name, value }, chatId, userId, vars);
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

export function installMacroResolveHandler(): void {
  api.onFrontendMessage((payload, userId) => {
    if (!isResolveMacrosRequest(payload)) return;
    const { requestId, chatId, characterId, templates } = payload;
    void (async () => {
      const results: string[] = new Array(templates.length);
      for (let i = 0; i < templates.length; i++) {
        const original = templates[i];
        try {
          // Persist + strip setvars first so subsequent {{getvar}} on the same
          // chat (and within this same template) reads the freshly set value
          // when the engine resolves. addvar/etc. and disabled gvars pass
          // through to the engine no-op via commit:false.
          const stripped = await applyAndStripSetvars(original, chatId, userId);
          const { masked, masks } = maskInvalidMacros(stripped);
          // userId — required for operator-scoped extensions (which is how Vishrun
          // installs); the host injects it as onFrontendMessage's 2nd arg.
          // commit:false — `{{setvar}}` that happens to appear in widget HTML
          // must not persist during a render pass; only the slash interceptor writes.
          const { text, diagnostics } = await api.macros.resolve(masked, {
            chatId,
            characterId,
            userId,
            commit: false,
          });
          if (diagnostics.length > 0) {
            varsLog.debug(`resolve produced ${diagnostics.length} diagnostic(s):`, diagnostics[0]?.message);
          }
          results[i] = unmaskInvalidMacros(text, masks);
        } catch (err) {
          // Fall back to the raw ORIGINAL (not the masked one — never hand the
          // frontend sentinels). Widget renders unresolved, same as pre-MVU-lite.
          varsLog.warn('resolve failed:', err instanceof Error ? err.message : String(err));
          results[i] = original;
        }
      }
      api.sendToFrontend({ type: 'resolve_macros_response', requestId, results }, userId);
    })();
  });
}

// ─── In-module sanity tests for applyAndStripSetvars ────────────────────────
// Runs once at import time, like classify-trigger.ts. Cheap; uses a fake
// `vars` injected via the optional 4th param. Wrapped so any assertion failure
// logs but never crashes the extension.
(function selfTest() {
  try {
    interface Call { scope: 'local' | 'chat' | 'global'; args: unknown[] }
    function makeFakeVars(opts?: { throwOn?: { scope: 'local' | 'chat' | 'global'; key: string } }): { vars: VarsApi; calls: Call[] } {
      const calls: Call[] = [];
      const mk = (scope: 'local' | 'chat' | 'global') => async (...args: unknown[]) => {
        const keyArg = scope === 'global' ? args[0] : args[1];
        if (opts?.throwOn && opts.throwOn.scope === scope && opts.throwOn.key === keyArg) {
          throw new Error(`fake set throws for ${scope}/${keyArg}`);
        }
        calls.push({ scope, args });
      };
      const vars = {
        local: { set: mk('local') },
        chat: { set: mk('chat') },
        global: { set: mk('global') },
      } as unknown as VarsApi;
      return { vars, calls };
    }

    const CHAT = 'chatX';
    const USER = 'userX';
    const ck = async (label: string, input: string, expectOut: string, expectCalls: Call[], throwOn?: { scope: 'local' | 'chat' | 'global'; key: string }) => {
      const { vars, calls } = makeFakeVars({ throwOn });
      const out = await applyAndStripSetvars(input, CHAT, USER, vars);
      console.assert(out === expectOut, `[vishrun] applyAndStripSetvars: ${label} → expected out ${JSON.stringify(expectOut)}, got ${JSON.stringify(out)}`);
      const callsOk = JSON.stringify(calls) === JSON.stringify(expectCalls);
      console.assert(callsOk, `[vishrun] applyAndStripSetvars: ${label} → expected calls ${JSON.stringify(expectCalls)}, got ${JSON.stringify(calls)}`);
    };

    // Run async; collect failures via console.assert. Caught by outer try.
    void (async () => {
      await ck('single setvar local', '{{setvar::yen::5000}}foo', 'foo', [{ scope: 'local', args: [CHAT, 'yen', '5000'] }]);
      await ck('multiple setvars in order', '{{setvar::yen::5000}}{{setvar::grade::Grade 2}}foo', 'foo', [
        { scope: 'local', args: [CHAT, 'yen', '5000'] },
        { scope: 'local', args: [CHAT, 'grade', 'Grade 2'] },
      ]);
      await ck('duplicate name applied in document order', '{{setvar::yen::5000}}foo{{setvar::yen::6000}}bar', 'foobar', [
        { scope: 'local', args: [CHAT, 'yen', '5000'] },
        { scope: 'local', args: [CHAT, 'yen', '6000'] },
      ]);
      await ck('invalid NAME left in template, not applied', '{{setvar::1bad::x}}foo', '{{setvar::1bad::x}}foo', []);
      // setgvar/setglobalvar — DISABLED this iteration; match preserved, no calls.
      await ck('setgvar disabled — not stripped, no call', '{{setgvar::level::99}}foo', '{{setgvar::level::99}}foo', []);
      await ck('setglobalvar disabled — not stripped, no call', '{{setglobalvar::level::99}}foo', '{{setglobalvar::level::99}}foo', []);
      await ck('setchatvar routes to chat namespace', '{{setchatvar::loc::Tokyo}}foo', 'foo', [{ scope: 'chat', args: [CHAT, 'loc', 'Tokyo'] }]);
      await ck('JSX inline style untouched, setvar stripped', `<div style={{position:'absolute'}}>{{setvar::yen::5000}}</div>`, `<div style={{position:'absolute'}}></div>`, [
        { scope: 'local', args: [CHAT, 'yen', '5000'] },
      ]);
      await ck('empty value', '{{setvar::yen::}}foo', 'foo', [{ scope: 'local', args: [CHAT, 'yen', ''] }]);
      await ck('set throws → match not stripped', '{{setvar::yen::5000}}foo', '{{setvar::yen::5000}}foo', [], { scope: 'local', key: 'yen' });
      await ck('mix setvar + getvar — setvar stripped, getvar untouched', '{{setvar::yen::5000}}precio={{getvar::yen}}', 'precio={{getvar::yen}}', [
        { scope: 'local', args: [CHAT, 'yen', '5000'] },
      ]);
    })();
  } catch (err) {
    console.error('[vishrun] applyAndStripSetvars self-test threw:', err);
  }
})();
