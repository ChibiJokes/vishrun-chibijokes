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

/**
 * Recompute capturesByMessage[messageId] from a raw message content
 * string, without going through Lumiverse's tag interceptor pipeline.
 *
 * Workaround for upstream issue: the host's `delivered` Set in
 * `Lumiverse/frontend/src/lib/spindle/message-interceptors.ts:21` dedupes
 * tag intercept dispatches by `(extensionId, messageId, isStreaming,
 * tagName, fullMatch)` and never clears. Swiping back to a previously-
 * seen swipe (or undoing an edit) doesn't re-fire the interceptor, so
 * onCapture never updates capturesByMessage and the widget keeps showing
 * stale content from the last swipe whose handler did fire.
 *
 * Frontend's MESSAGE_SWIPED / MESSAGE_EDITED handlers call this with the
 * fresh content from the WS event payload, bypassing the host pipeline
 * entirely. For each registered paired-tag script: run findRe against
 * the raw content (last match wins, mirroring onCapture's "latest
 * fullMatch is canonical" rule). Scripts that don't match drop their
 * capture for this messageId — that's how widgets disappear when a
 * swipe doesn't carry the tag.
 *
 * Returns true if capturesByMessage[messageId] changed, signalling the
 * caller to trigger processMessageById so phase 1 / phase 2 run with
 * the fresh captures.
 */
export function rebuildCapturesFromContent(
  messageId: string,
  content: string,
  compiled: CompiledScript[],
): boolean {
  const newList: CapturedTag[] = [];

  for (const script of compiled) {
    if (script.kind !== 'pairedTag') continue;
    script.findRe.lastIndex = 0;
    let lastMatch: RegExpExecArray | null = null;
    let m: RegExpExecArray | null;
    while ((m = script.findRe.exec(content)) !== null) {
      lastMatch = m;
      if (m[0].length === 0) script.findRe.lastIndex++;
    }
    if (!lastMatch) continue;
    newList.push({
      scriptId: script.id,
      scriptName: script.scriptName,
      replaceString: script.replaceString,
      findRe: script.findRe,
      fullMatch: lastMatch[0],
      // attrs aren't needed downstream (renderPairedTagCaptures re-runs
      // findRe on fullMatch to recover capture groups), but the field
      // exists on CapturedTag — populate empty rather than parse the
      // tag's attrs from raw HTML.
      attrs: {},
    });
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
