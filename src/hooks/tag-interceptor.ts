import type { SpindleFrontendContext } from 'lumiverse-spindle-types';
import type { CompiledScript } from '../core/parse-regex-script';

/**
 * Paired-tag pipeline (kept deliberately separate from the placeholder
 * pipeline — they have different triggering mechanisms and the user
 * required not to unify them).
 *
 * Trigger:  ctx.messages.registerTagInterceptor fires synchronously
 *           inside MessageContent's useMemo on every render.
 * Coordination: handler stores the captured data into capturesByMessage,
 *           keyed by messageId. The MutationObserver-driven processNode
 *           reads this map and renders any captures that don't yet have
 *           a corresponding [data-vishrun-widget] in the message DOM.
 *
 * Why a coordinator map and not direct DOM injection from the handler:
 *  - The handler runs during render — DOM commit hasn't happened yet.
 *  - More importantly, Lumiverse's stripAndDispatchMessageTags dedupes
 *    by extensionId::messageId::tagName::fullMatch in a session-lifetime
 *    Set (`delivered`), so the handler fires AT MOST ONCE per unique
 *    fullMatch per page load. If React rebuilds the message subtree
 *    later (e.g. greeting switch back to a previously-seen content),
 *    the handler does NOT re-fire — but the observer scan does, and
 *    finding the capture in this map lets us re-inject.
 *
 * Handles both placeholder-with-script (routed elsewhere — this module
 * only deals with paired tags) and paired-tag widgets uniformly through
 * the same captures map → processNode coordinator.
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

function onCapture(payload: InterceptorPayload, script: CompiledScript): void {
  // No streaming guard: Lumiverse's `delivered` Set dedupes by fullMatch,
  // and a paired tag's regex doesn't match until the close tag streams in
  // — by which point the captured inner is final. Rendering a widget
  // mid-stream the moment the close tag arrives is the desired UX.
  // (CONTEXT.md previously suggested guarding on isStreaming, but that
  // would race against `delivered` and silently drop the only fire.)

  if (!payload.messageId) return;

  // Drop any prior capture for this scriptId in this message — only the
  // latest fullMatch is canonical. This is what makes greeting switch /
  // message edit / regen converge correctly: a new fullMatch for the
  // same (messageId, scriptId) ejects the stale capture, and
  // renderPairedTagCaptures' phase-1 cleanup removes the corresponding
  // stale widget. Trade-off: the same paired tag emitted multiple times
  // in a single message renders only the last instance — no card in
  // scope hits this; documented in CONTEXT.md "Known issues" with the
  // migration path (REST-fetch-and-rematch on content-hash change).
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
