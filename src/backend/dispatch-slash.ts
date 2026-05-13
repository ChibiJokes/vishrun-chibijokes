import { api, varsLog } from './common';
import { parseSetvarChain, type SetvarKind } from './parsers/setvar';
import { applySetvarOp, type VarsApi } from './setvar-ops';

// Frontend → backend: dispatch a slash-command payload that the iframe shim
// caught from a card's `pushToSillyTavern` fallback (which would otherwise hit
// navigator.clipboard.writeText + alert and lose the second consecutive
// payload). Whitelist:
//
//   /setvar/setchatvar/setgvar/setglobalvar  → apply via api.variables.*.set
//                                              (gvars skipped per upstream bug)
//   /sys                                     → api.chat.appendMessage as system
//
// Anything else returns `handled:false` so the frontend falls back to the
// existing clipboard.writeText behavior — backward-compat with cards that
// legitimately copy text to the OS clipboard.

interface DispatchSlashRequest {
  type: 'dispatch_slash_text';
  requestId: string;
  text: string;
  chatId: string;
}

interface DispatchSlashResponse {
  type: 'dispatch_slash_text_response';
  requestId: string;
  handled: boolean;
  kind: 'setvar_chain' | 'sys_message' | 'none';
  error?: string;
}

function isDispatchSlashRequest(p: unknown): p is DispatchSlashRequest {
  if (!p || typeof p !== 'object') return false;
  const r = p as Record<string, unknown>;
  return (
    r.type === 'dispatch_slash_text' &&
    typeof r.requestId === 'string' &&
    typeof r.text === 'string' &&
    typeof r.chatId === 'string'
  );
}

const SETVAR_PREFIX_RE = /^\s*\/(setvar|setchatvar|setgvar|setglobalvar)\b/i;
const SYS_PREFIX_RE = /^\s*\/sys\b/i;

export async function dispatchSlashText(
  text: string,
  chatId: string,
  userId: string,
  deps: { vars?: VarsApi; appendMessage?: typeof api.chat.appendMessage } = {},
): Promise<{ handled: boolean; kind: 'setvar_chain' | 'sys_message' | 'none' }> {
  if (SETVAR_PREFIX_RE.test(text)) {
    const parsed = parseSetvarChain(text);
    if (!parsed || parsed.pairs.length === 0) {
      // Looks like setvar-family by prefix but unparseable. Suppress alert
      // (handled:true) because the card already considers this a "push"; let
      // the user see nothing rather than the misleading sandbox fallback alert.
      varsLog.warn('dispatch_slash_text: setvar prefix matched but parse failed; treating as handled');
      return { handled: true, kind: 'setvar_chain' };
    }
    for (const { kind, key, value } of parsed.pairs) {
      try {
        await applySetvarOp({ kind: kind as SetvarKind, name: key, value }, chatId, userId, deps.vars);
      } catch (err) {
        varsLog.warn(`dispatch_slash_text: applySetvarOp failed for ${kind}::${key}:`, err instanceof Error ? err.message : String(err));
      }
    }
    // handled:true even if only gvars (skipped) — the card shouldn't fall back
    // to clipboard for what is conceptually a recognized command.
    return { handled: true, kind: 'setvar_chain' };
  }

  if (SYS_PREFIX_RE.test(text)) {
    // Strip `/sys` (with optional whitespace, no body left = empty system msg).
    const content = text.replace(/^\s*\/sys\s*/i, '');
    const append = deps.appendMessage ?? api.chat.appendMessage.bind(api.chat);
    await append(chatId, { role: 'system', content });
    return { handled: true, kind: 'sys_message' };
  }

  return { handled: false, kind: 'none' };
}

export function installDispatchSlashHandler(): void {
  api.onFrontendMessage((payload, userId) => {
    if (!isDispatchSlashRequest(payload)) return;
    const { requestId, text, chatId } = payload;
    void (async () => {
      let response: DispatchSlashResponse;
      try {
        const result = await dispatchSlashText(text, chatId, userId);
        response = { type: 'dispatch_slash_text_response', requestId, handled: result.handled, kind: result.kind };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        varsLog.warn('dispatch_slash_text handler threw:', msg);
        response = { type: 'dispatch_slash_text_response', requestId, handled: false, kind: 'none', error: msg };
      }
      api.sendToFrontend(response, userId);
    })();
  });
}

