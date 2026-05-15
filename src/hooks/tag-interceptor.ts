import type { SpindleFrontendContext } from 'lumiverse-spindle-types';
import type { CompiledScript } from '../core/parse-regex-script';

/**
 * Paired-tag pipeline. ctx.messages.registerTagInterceptor fires during
 * MessageContent's render; the handler stores captures keyed by messageId
 * in `capturesByMessage`. The MutationObserver-driven processNode reads
 * this map and renders captures that don't yet have a widget in the DOM.
 *
 * The handler fires at most once per unique fullMatch per page load
 * (Lumiverse dedupes via a session-lifetime Set), so subsequent
 * re-renders of the same content rely on the map, not the handler.
 */

export interface CapturedTag {
  scriptId: string;
  scriptName: string;
  /** Fence-stripped, NOT yet substituted. processNode runs substitute(). */
  replaceString: string;
  /**
   * Card's findRe — re-applied against fullMatch at render time to recover
   * the real capture groups. The tag interceptor only delivers a single
   * pre-extracted inner string, which collapses multi-group cards (e.g.
   * Xiao Gu's 12 pipe-separated groups) into one $1 chorizo and leaves
   * $2..$N literal in the rendered HTML.
   */
  findRe: RegExp;
  fullMatch: string;
  attrs: Record<string, string>;
}

const capturesByMessage = new Map<string, CapturedTag[]>();

export function getCapturesForMessage(messageId: string): CapturedTag[] {
  return capturesByMessage.get(messageId) || [];
}

interface InterceptorPayload {
  tagName: string;
  attrs: Record<string, string>;
  content: string;
  fullMatch: string;
  messageId?: string;
  chatId?: string;
  isUser?: boolean;
  isStreaming?: boolean;
}

let activeUnsubs: (() => void)[] = [];
let activeTagNames = new Set<string>();

/**
 * Register tag interceptors for the paired-tag scripts in `compiled`.
 * Idempotent w.r.t. the set of tagNames currently registered: if the new
 * set matches the existing set, the call is a no-op (no tear-down/reset
 * of Lumiverse's `delivered` Set). If the set differs, we tear down all
 * old registrations and register fresh.
 *
 * `capturesByMessage` is NEVER cleared — the captured data is keyed by
 * messageId (UUID), so accumulation across chat switches is bounded by
 * total tags ever rendered in the session and harmless.
 */
export function syncTagInterceptors(
  ctx: SpindleFrontendContext,
  compiled: CompiledScript[],
): void {
  const desired = new Map<string, CompiledScript>();
  for (const s of compiled) {
    if (s.kind !== 'pairedTag') continue;
    const tagName = extractTagName(s.findRe.source);
    if (!tagName) {
      // Should be unreachable if classify-trigger and extractTagName stay
      // in sync — both share the same "tolerant of \s* decoration" rule.
      // Logging anyway in case they drift.
      console.debug(
        `[vishrun] paired-tag script "${s.scriptName}" classified as pairedTag but ` +
        `extractTagName failed — skipping. findRegex source: ${s.findRe.source}`,
      );
      continue;
    }
    desired.set(tagName.toLowerCase(), s);
  }

  // Same set as currently active? No-op.
  if (
    desired.size === activeTagNames.size &&
    [...desired.keys()].every((t) => activeTagNames.has(t))
  ) {
    return;
  }

  // Tear down existing.
  activeUnsubs.forEach((u) => {
    try { u(); } catch { /* swallow */ }
  });
  activeUnsubs = [];
  activeTagNames = new Set(desired.keys());

  // Register fresh.
  for (const [tagName, script] of desired) {
    const unsub = ctx.messages.registerTagInterceptor(
      { tagName, removeFromMessage: true },
      (payload: InterceptorPayload) => onCapture(payload, script),
    );
    activeUnsubs.push(unsub);
  }
}

export function teardownTagInterceptors(): void {
  activeUnsubs.forEach((u) => {
    try { u(); } catch { /* swallow */ }
  });
  activeUnsubs = [];
  activeTagNames = new Set();
}

/**
 * Recompute capturesByMessage[messageId] from a raw message content string,
 * bypassing the host tag interceptor.
 *
 * Workaround: Lumiverse's `delivered` Set in
 * frontend/src/lib/spindle/message-interceptors.ts dedupes interceptor fires
 * by (extensionId, messageId, isStreaming, tagName, fullMatch) and never
 * clears. Swiping back to a previously-seen swipe doesn't re-fire the
 * interceptor, so capturesByMessage would hold stale content from the last
 * fired swipe. MESSAGE_SWIPED / MESSAGE_EDITED handlers call this with the
 * fresh content from the WS payload instead.
 *
 * Scripts run in compiled order against an accumulatively-stripped working
 * copy (mirrors the host's stripMessageTags), so a nested script doesn't
 * double-capture. Per script: last match wins. Scripts that don't match
 * drop their capture — that's how widgets disappear when a swipe omits the tag.
 *
 * Returns true if capturesByMessage[messageId] changed, signalling the
 * caller to trigger processMessageById.
 */
export function rebuildCapturesFromContent(
  messageId: string,
  content: string,
  compiled: CompiledScript[],
  _eventName?: string,
): boolean {
  const newList: CapturedTag[] = [];

  // compileScripts merges `g` into paired-tag regexes, so `replace(findRe, '')`
  // strips every occurrence.
  let working = content;
  for (const script of compiled) {
    if (script.kind !== 'pairedTag') continue;
    script.findRe.lastIndex = 0;
    let lastMatch: RegExpExecArray | null = null;
    let m: RegExpExecArray | null;
    while ((m = script.findRe.exec(working)) !== null) {
      lastMatch = m;
      if (m[0].length === 0) script.findRe.lastIndex++;
    }
    if (lastMatch) {
      newList.push({
        scriptId: script.id,
        scriptName: script.scriptName,
        replaceString: script.replaceString,
        findRe: script.findRe,
        fullMatch: lastMatch[0],
        attrs: {},
      });
    }
    // Strip this tag's matches before the next script scans — accumulative,
    // like the host's stripMessageTags.
    script.findRe.lastIndex = 0;
    working = working.replace(script.findRe, '');
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

function onCapture(payload: InterceptorPayload, script: CompiledScript): void {
  // No streaming guard: the paired-tag regex doesn't match until the close
  // tag arrives, by which point the captured inner is final.
  if (!payload.messageId) return;

  // Drop any prior capture for this scriptId — only the latest fullMatch
  // is canonical. Trade-off: the same paired tag emitted multiple times
  // in one message renders only the last instance (no card in scope hits this).
  const existing = capturesByMessage.get(payload.messageId) || [];
  const list = existing.filter((c) => c.scriptId !== script.id);

  list.push({
    scriptId: script.id,
    scriptName: script.scriptName,
    replaceString: script.replaceString,
    findRe: script.findRe,
    fullMatch: payload.fullMatch,
    attrs: payload.attrs,
  });
  capturesByMessage.set(payload.messageId, list);
}

/**
 * Pull the tag name out of a paired-tag findRegex source.
 *
 * Tolerates whitespace-allowance decorations between `<` and the tag name —
 * card authors sometimes pad with `\s*` for paranoia (Pacifica:
 * `<\s*PACIFICA_UI\s*>...`). The optional `(?:\\s\*|\s)*` group accepts
 * either the literal 3-char sequence `\s*` or actual whitespace. Returns
 * null only when there's no recognizable tag name at the start.
 *
 * Stays in sync with `isPairedTag` in `classify-trigger.ts` — both must
 * accept the same shapes, otherwise classification routes to pairedTag but
 * registration silently fails.
 */
function extractTagName(reSource: string): string | null {
  const m = reSource.match(/^<(?:\\s\*|\s)*([a-zA-Z_][a-zA-Z0-9_-]*)/);
  return m ? m[1] : null;
}
