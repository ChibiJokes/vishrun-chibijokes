import type { SpindleFrontendContext } from 'lumiverse-spindle-types';
import { compileScripts, type CompiledScript } from '../core/parse-regex-script';
import { processNode } from '../render/inject-into-message';
import { getActiveCard } from '../state/active-card';
import { syncTagInterceptors, teardownTagInterceptors } from './tag-interceptor';

const MAX_RAF_RETRIES = 3;
const MESSAGE_LIST_SELECTOR = '[data-component="MessageList"]';

interface GenerationEndedPayload {
  generationId?: string;
  chatId?: string;
  messageId?: string;
  content?: string;
  error?: string;
}

export interface MessageHooks {
  /**
   * Scan all rendered messages and (re)attach the MutationObserver if the
   * card has scripts. Detaches the observer if there's no active card or
   * the card has no scripts. Frontend bootstrap calls this after every
   * card-load outcome (load with scripts, load without scripts, clear).
   */
  rescanAll: () => void;
  dispose: () => void;
}

/**
 * Hook strategy (Step 1.5 / greeting-switch findings):
 *  - Lumiverse does NOT emit a "message rendered" event we can use:
 *    CHARACTER_MESSAGE_RENDERED is vestigial, and the greeting-switch path
 *    (PUT /api/v1/chats/:id/messages/:id) was observed to emit no WS frame
 *    despite chats.service.ts:updateMessage being wired to fire
 *    MESSAGE_EDITED. Some upstream condition is bypassing the emit. So we
 *    can't depend on event-only signals for re-render coverage.
 *  - Primary mechanism: MutationObserver on the message-list container
 *    (`[data-component="MessageList"]` — `MessageList.tsx:345`). React
 *    rebuilds the message subtree on content changes (greeting, edit,
 *    swipe nav), wiping our injected widget. Observer + rAF debounce →
 *    single coalesced rescan per frame. processNode idempotency
 *    (skip-text-inside-[data-vishrun-widget]) makes re-runs safe.
 *  - Secondary mechanism: GENERATION_ENDED for the just-finished bot
 *    message id. Predictable, doesn't depend on observer state, no extra
 *    cost when both fire.
 */
export function installMessageHooks(ctx: SpindleFrontendContext): MessageHooks {
  let observer: MutationObserver | null = null;
  let observedTarget: Element | null = null;
  let pendingFrame = 0;
  // Watcher used when MessageList isn't yet in the DOM at attach time —
  // e.g. user navigated directly into a chat from the characters page,
  // and the SPA is still mounting the chat view. Auto-disconnects as
  // soon as MessageList appears.
  let bodyWatcher: MutationObserver | null = null;

  function compiledForActiveCard(): CompiledScript[] | null {
    const card = getActiveCard();
    if (!card) return null;
    const compiled = compileScripts(card.scripts);
    return compiled.length === 0 ? null : compiled;
  }

  function isActiveChat(chatId: string | undefined): boolean {
    if (!chatId) return true;
    const active = ctx.getActiveChat().chatId;
    if (!active) return true;
    return active === chatId;
  }

  function processMessageById(messageId: string, retriesLeft: number): void {
    const compiled = compiledForActiveCard();
    if (!compiled) return;
    const sel = buildMessageSelector(messageId);
    const node = document.querySelector(sel) as HTMLElement | null;
    if (node) {
      const n = processNode(node, compiled, ctx);
      if (n > 0) {
        console.debug(`[vishrun][step3] rendered ${n} widget(s) into message ${messageId}`);
      }
      return;
    }
    if (retriesLeft > 0) {
      requestAnimationFrame(() => processMessageById(messageId, retriesLeft - 1));
    } else {
      console.debug(`[vishrun][step3] message ${messageId} not found in DOM after ${MAX_RAF_RETRIES} frames`);
    }
  }

  function scanAllNow(compiled: CompiledScript[]): void {
    const nodes = document.querySelectorAll('[data-message-id]');
    let total = 0;
    nodes.forEach((n) => { total += processNode(n as HTMLElement, compiled, ctx); });
    if (total > 0) {
      console.debug(`[vishrun][step3] scan rendered ${total} widget(s) across ${nodes.length} message(s)`);
    }
  }

  function handleMutations(): void {
    if (pendingFrame) return;
    pendingFrame = requestAnimationFrame(() => {
      pendingFrame = 0;
      const compiled = compiledForActiveCard();
      if (!compiled) {
        // Card cleared between mutation and frame — observer should be off.
        detachObserver();
        return;
      }
      scanAllNow(compiled);
    });
  }

  function attachObserver(): void {
    const target = document.querySelector(MESSAGE_LIST_SELECTOR);
    if (!target) {
      // Message-list not in DOM yet (e.g. user navigated directly into a
      // chat from the characters page). Drop any stale observer pointing
      // at an unmounted node, then install a body-level watcher that
      // fires as soon as MessageList appears.
      if (observer && observedTarget && !document.contains(observedTarget)) {
        detachObserver();
      }
      ensureBodyWatcher();
      return;
    }
    // Found it — body watcher (if any) is no longer needed.
    if (bodyWatcher) {
      bodyWatcher.disconnect();
      bodyWatcher = null;
    }
    if (observer && observedTarget === target) return; // already attached
    if (observer) observer.disconnect();
    observer = new MutationObserver(handleMutations);
    // childList + subtree catch greeting/swipe rebuilds (whole subtree
    // replaced) and new-message inserts. characterData catches in-place
    // text edits when React reuses a text node rather than replacing it.
    // Watch-item: characterData also fires per token during streaming —
    // if testing surfaces flicker or perf issues, drop characterData and
    // rely on the childList/subtree mutations React fires at end-of-stream.
    observer.observe(target, { childList: true, subtree: true, characterData: true });
    observedTarget = target;
    console.debug('[vishrun][step3] MutationObserver attached to', MESSAGE_LIST_SELECTOR);
  }

  function ensureBodyWatcher(): void {
    if (bodyWatcher) return; // already waiting
    if (!document.body) return; // SPA pre-hydration; rescanAll will retry
    bodyWatcher = new MutationObserver((records) => {
      // React may insert MessageList nested inside a wrapper component, so
      // the addedNode is rarely the target itself. Walk both directions:
      // is the inserted node the target, or does it contain the target?
      let foundTarget: Element | null = null;
      outer: for (const r of records) {
        for (const node of r.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (node.matches?.(MESSAGE_LIST_SELECTOR)) {
            foundTarget = node;
            break outer;
          }
          const nested = node.querySelector?.(MESSAGE_LIST_SELECTOR);
          if (nested) {
            foundTarget = nested;
            break outer;
          }
        }
      }
      if (!foundTarget) return;
      // MessageList is in DOM — tear down the watcher and attach for
      // real, then run a scan so widgets render in the freshly-mounted
      // messages.
      bodyWatcher!.disconnect();
      bodyWatcher = null;
      const compiled = compiledForActiveCard();
      if (!compiled) return; // card was cleared between insert and now
      attachObserver();
      scanAllNow(compiled);
    });
    bodyWatcher.observe(document.body, { childList: true, subtree: true });
    console.debug('[vishrun][step3] MessageList not yet mounted — body watcher armed');
  }

  function detachObserver(): void {
    if (pendingFrame) {
      cancelAnimationFrame(pendingFrame);
      pendingFrame = 0;
    }
    if (bodyWatcher) {
      bodyWatcher.disconnect();
      bodyWatcher = null;
    }
    if (observer) {
      observer.disconnect();
      observer = null;
      observedTarget = null;
      console.debug('[vishrun][step3] MutationObserver detached');
    }
  }

  function rescanAll(): void {
    // Tag-interceptor sync runs synchronously: registerTagInterceptor
    // mutates a frontend module's state and needs to be in place BEFORE
    // MessageContent's next render so the interceptor handler fires for
    // existing tags. Doing it inside the rAF would race the next render.
    const compiledNow = compiledForActiveCard();
    if (compiledNow) {
      syncTagInterceptors(ctx, compiledNow);
    } else {
      teardownTagInterceptors();
    }

    // Two rAFs: lets the message list paint after a card change before we
    // scan. The observer takes over reactive coverage from there.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const compiled = compiledForActiveCard();
      if (!compiled) {
        detachObserver();
        return;
      }
      attachObserver();
      scanAllNow(compiled);
    }));
  }

  const unsubGenEnded = ctx.events.on('GENERATION_ENDED', (payload: unknown) => {
    const p = (payload || {}) as GenerationEndedPayload;
    if (p.error) return;
    if (!isActiveChat(p.chatId)) return;
    if (!p.messageId) return;
    processMessageById(p.messageId, MAX_RAF_RETRIES);
  });

  const unsubChatChanged = ctx.events.on('CHAT_CHANGED', () => {
    // Active-card load is async (REST fetch). The frontend bootstrap calls
    // rescanAll() explicitly after setActiveCard(). This handler is a
    // safety net for the case where a chat loads with the SAME character
    // (debounced — no fetch) but new messages need scanning.
    rescanAll();
  });

  return {
    rescanAll,
    dispose: () => {
      detachObserver();
      teardownTagInterceptors();
      unsubGenEnded();
      unsubChatChanged();
    },
  };
}

function buildMessageSelector(messageId: string): string {
  // Lumiverse message ids are UUIDs (hex + dashes), so escaping is a
  // defensive measure rather than a correctness need today.
  const escaped =
    typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(messageId)
      : messageId.replace(/["\\]/g, '\\$&');
  return `[data-message-id="${escaped}"]`;
}
