import { api, varsLog } from './common';

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

export function installMacroResolveHandler(): void {
  api.onFrontendMessage((payload, userId) => {
    if (!isResolveMacrosRequest(payload)) return;
    const { requestId, chatId, characterId, templates } = payload;
    void (async () => {
      const results: string[] = new Array(templates.length);
      for (let i = 0; i < templates.length; i++) {
        const original = templates[i];
        const { masked, masks } = maskInvalidMacros(original);
        try {
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
