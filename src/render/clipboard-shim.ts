import type { SpindleFrontendContext } from 'lumiverse-spindle-types';
import { dispatchSlashViaBackend } from '../core/dispatch-slash';

// Host-side handlers for the iframe sandbox's clipboard / alert shim.
//
// Background: cards define their own `pushToSillyTavern` that falls back to
// `navigator.clipboard.writeText(payload) + alert(payload)` when SillyTavern
// isn't reachable (always, given the cross-origin sandbox in Lumiverse).
// Multiple consecutive calls lose payloads — the alert from #1 takes focus
// away, writeText #2 throws NotAllowedError, and overwrites would lose the
// first payload anyway.
//
// Fix: intercept 'clipboard-write-text'. If the text starts with one of the
// whitelisted prefixes (/setvar/setchatvar/setgvar/setglobalvar/sys), route
// to the backend's dispatch_slash_text handler which applies the side effect
// directly. Anything else falls through to the real clipboard for backward
// compatibility with cards that legitimately export text.
//
// Correlated alert suppression: the card emits an alert right after writeText
// ("Security Sandbox Active...", "Sandbox active — copied to clipboard.",
// "Copy manually:", whatever — different cards use different wording). When
// our dispatch path handled the payload, that alert is misleading regardless
// of its text. Strategy: register the dispatch in `recentlyDispatched` BEFORE
// the await (so a synchronous alert that lands while we wait is still
// suppressed) and let any alert within DISPATCH_CORRELATION_WINDOW_MS of a
// pending or recently-completed dispatch be suppressed. No text whitelist —
// pure temporal correlation. On dispatch failure we remove the entry so the
// user still sees alerts unrelated to a successful intercept.

const DISPATCH_PREFIX_RE = /^\s*\/(setvar|setchatvar|setgvar|setglobalvar|sys|inject|flushinject)\b/i;
const DISPATCH_CORRELATION_WINDOW_MS = 1000;
const DISPATCH_CLEANUP_INTERVAL_MS = 2000;

const recentlyDispatched = new Map<string, number>();
let cleanupTimer: ReturnType<typeof setInterval> | null = null;
function ensureCleanupTimer(): void {
  if (cleanupTimer !== null) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [text, ts] of recentlyDispatched) {
      if (now - ts > DISPATCH_CLEANUP_INTERVAL_MS) recentlyDispatched.delete(text);
    }
  }, DISPATCH_CLEANUP_INTERVAL_MS);
}

export interface ClipboardShimDeps {
  /** Override `navigator.clipboard.writeText` for tests. */
  clipboardWriteText?: (text: string) => Promise<void>;
  /** Override `window.alert` for tests. */
  alert?: (message: string) => void;
  /** Override the dispatch wrapper for tests. */
  dispatch?: typeof dispatchSlashViaBackend;
  /** Override the recentlyDispatched map for tests (isolation). */
  recentlyDispatched?: Map<string, number>;
  /** Override Date.now() for deterministic correlation-window tests. */
  now?: () => number;
}

export async function handleClipboardWriteText(
  payload: unknown,
  ctx: SpindleFrontendContext,
  deps: ClipboardShimDeps = {},
): Promise<void> {
  const text = payload && typeof payload === 'object'
    ? (payload as { text?: unknown }).text
    : undefined;
  if (typeof text !== 'string') return;

  const dispatched = deps.recentlyDispatched ?? recentlyDispatched;
  const now = deps.now ?? Date.now;

  if (DISPATCH_PREFIX_RE.test(text)) {
    const chatId = ctx.getActiveChat().chatId;
    if (!chatId) {
      console.warn('[vishrun] dispatch_slash_text: no active chatId, falling back to clipboard');
    } else {
      // Register BEFORE the await so a card alert that arrives while the
      // backend is still working still gets suppressed by handleHostAlert.
      // Without this, the alert (synchronous postMessage from the iframe)
      // races the dispatch and slips through.
      if (!deps.recentlyDispatched) ensureCleanupTimer();
      dispatched.set(text, now());
      try {
        const dispatch = deps.dispatch ?? dispatchSlashViaBackend;
        const result = await dispatch(ctx, chatId, text);
        if (result.handled) {
          // Refresh timestamp so the correlation window starts at completion,
          // catching any alert the card schedules after the dispatch resolves.
          dispatched.set(text, now());
          return;
        }
        // backend returned handled:false — fall through to clipboard.
        // Remove the entry so subsequent unrelated alerts aren't suppressed.
        dispatched.delete(text);
      } catch (e) {
        console.warn('[vishrun] dispatch_slash_text failed, falling back to clipboard:', e instanceof Error ? e.message : String(e));
        dispatched.delete(text);
      }
    }
  }

  const writeText = deps.clipboardWriteText
    ?? (typeof navigator !== 'undefined' && navigator.clipboard
      ? navigator.clipboard.writeText.bind(navigator.clipboard)
      : null);
  if (!writeText) return;
  try {
    await writeText(text);
  } catch (e) {
    console.warn('[vishrun] clipboard writeText failed:', e);
  }
}

export function handleHostAlert(payload: unknown, deps: ClipboardShimDeps = {}): void {
  const message = payload && typeof payload === 'object'
    ? (payload as { message?: unknown }).message
    : undefined;
  if (typeof message !== 'string') return;

  const dispatched = deps.recentlyDispatched ?? recentlyDispatched;
  const now = deps.now ?? Date.now;
  const tNow = now();
  for (const ts of dispatched.values()) {
    if (tNow - ts < DISPATCH_CORRELATION_WINDOW_MS) return;
  }

  const alertFn = deps.alert
    ?? (typeof window !== 'undefined' && typeof window.alert === 'function'
      ? window.alert.bind(window)
      : null);
  if (!alertFn) return;
  try {
    alertFn(message);
  } catch (e) {
    console.warn('[vishrun] alert failed:', e);
  }
}
