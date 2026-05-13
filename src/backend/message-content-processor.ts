import { api, varsLog } from './common';
import { parseSetvarChain } from './parsers/setvar';

// Shown when a user message was nothing but `/setvar` commands — an empty
// string is accepted by the route but gives a blank bubble and an empty LLM
// turn (some providers reject that).
const EMPTY_REPLACEMENT = '_(variables updated)_';

// Consumes SillyTavern `/setvar` chains from user messages: writes the values
// to Lumiverse's `local` variable store ({{getvar::key}} reads the same store)
// and strips the commands from the stored message + LLM prompt. MVU proper
// (Queen Bee) would add an `<UpdateVariable>` parser here too.
export function installMessageContentProcessor(): void {
  api.registerMessageContentProcessor(async (ctx) => {
    // Auto-emitted greetings never carry a user-typed `/setvar`.
    if (ctx.extra?.greeting === true) return;
    // `render` is a per-paint, non-persisting pass — fires twice per visible
    // message — and the stored content was already stripped at create time.
    if (ctx.origin === 'render') return;
    if (!ctx.content.includes('/setvar')) return;

    const parsed = parseSetvarChain(ctx.content);
    if (!parsed) return; // unparseable — leave the message untouched, don't break send.

    // Sequential: each `set` does a read-modify-write of the whole local-vars
    // map host-side, so concurrent sets would clobber each other.
    for (const { key, value } of parsed.pairs) {
      try {
        await api.variables.local.set(ctx.chatId, key, value);
      } catch (err) {
        varsLog.warn(`setvar failed for "${key}":`, err instanceof Error ? err.message : String(err));
        // Keep going — a partial set is still better than none, and we still
        // strip so the user doesn't see the raw command in their bubble.
      }
    }

    const stripped = parsed.strippedContent.trim();
    return { content: stripped.length > 0 ? stripped : EMPTY_REPLACEMENT };
  }, 50);
}
