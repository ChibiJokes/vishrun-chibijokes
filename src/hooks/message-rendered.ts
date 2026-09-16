import type { SpindleFrontendContext } from 'lumiverse-spindle-types';
import { compileScripts, type CompiledScript } from '../core/parse-regex-script';
import { processNode, clearEditingMessageIds } from '../render/inject-into-message';
import { getActiveCard } from '../state/active-card';
import { syncTagInterceptors, teardownTagInterceptors } from './tag-interceptor';
import { fetchMessageContentById } from '../lumiverse/fetch-message';
import { shouldRescanForChangedFields } from '../core/chat-changed-filter';
import { isSelfMutation } from '../render/self-mutation';

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
  /**
   * Run processNode against the message DOM with the given id, retrying
   * across rAFs if the message hasn't mounted yet. Used by the
   * MESSAGE_SWIPED / MESSAGE_EDITED handlers in frontend.ts to force a
   * targeted re-render after rebuilding captures from the event payload.
   */
  processMessageById: (messageId: string, retriesLeft?: number) => void;
  /**
   * Compile + return the active card's scripts, or null if there's no
   * active card or it has no scripts. Exposed so the
   * MESSAGE_SWIPED/MESSAGE_EDITED handlers can rebuild captures from
   * the event payload's raw content without re-implementing the gating.
   */
  compiledForActiveCard: () => CompiledScript[] | null;
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
 *    targeted reprocessing of only the affected message ids. Whole-chat
 *    scans are reserved for explicit initial/card/chat rescans. processNode
 *    idempotency (skip-text-inside-[data-vishrun-widget]) makes re-runs safe.
 *  - Secondary mechanism: GENERATION_ENDED for the just-finished bot
 *    message id. Predictable, doesn't depend on observer state, no extra
 *    cost when both fire.
 */
export function installMessageHooks(ctx: SpindleFrontendContext): MessageHooks {
  let observer: MutationObserver | null = null;
  let observedTarget: Element | null = null;
  let pendingFrame = 0;
  let pendingRecords: MutationRecord[] = [];
  // Watcher used when MessageList isn't yet in the DOM at attach time —
  // e.g. user navigated directly into a chat from the characters page,
  // and the SPA is still mounting the chat view. Auto-disconnects as
  // soon as MessageList appears.
  let bodyWatcher: MutationObserver | null = null;
  // Tracks the most recently completed generation's message ID.
  // Used to anchor depth-0 scripts to a stable identity rather than
  // a DOM position that shifts as Lumi loads/unloads messages on scroll.
  let latestMessageId: string | null = null;
  // Only messages that actually need a settled-DOM retry are tracked here.
  // Historical messages discovered by the explicit initial scan are allowed
  // to render immediately for fast chat hydration; if Lumiverse later
  // rebuilds one of those messages while it is still pending, the targeted
  // mutation path adds just that message here and rebuilds it once on READY.
  const waitingForReadyIds = new Set<string>();
  // Lumiverse exposes data-display-pending while its async display-regex /
  // preprocessing pass is still settling. Observe that attribute so Vishrun
  // can wait for the host's own readiness signal instead of guessing with a
  // timer. IMPORTANT: do not observe characterData here. During streaming,
  // Lumiverse mutates text repeatedly; treating those token-level mutations as
  // render signals caused whole-chat rescans and severe slowdown on large
  // chats. MESSAGE_EDITED / MESSAGE_SWIPED already have targeted event paths.
  const OBSERVE_OPTS: MutationObserverInit = {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-display-pending'],
  };

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

function processMessageById(messageId: string, retriesLeft: number = MAX_RAF_RETRIES): void {
  const compiled = compiledForActiveCard();
  if (!compiled) return;

  const sel = buildMessageSelector(messageId);
  const node = document.querySelector(sel) as HTMLElement | null;

  if (node) {
    // Targeted event-driven re-renders (generation end / edit / swipe) should
    // use settled host DOM. Unlike the explicit initial scan below, there is
    // no benefit to racing Lumiverse here, so remember this one message and
    // let the data-display-pending transition wake it exactly once.
    const messageContent = node.querySelector('[data-component="MessageContent"]') as HTMLElement | null;
    if (!messageContent || messageContent.getAttribute('data-display-pending') === 'true') {
      waitingForReadyIds.add(messageId);
      if (retriesLeft > 0) {
        requestAnimationFrame(() => processMessageById(messageId, retriesLeft - 1));
      }
      return;
    }
    waitingForReadyIds.delete(messageId);

    const allNodes = Array.from(document.querySelectorAll('[data-message-id]'));
    const nodeIndex = allNodes.indexOf(node);
    if (nodeIndex === -1) return;

    const depthFromLatest = allNodes.length - 1 - nodeIndex;
    const scriptsForMessage = compiled.filter((s) => {
      if (s.maxDepth === 0 && s.minDepth === 0) {
        return messageId === latestMessageId;
      }
      if (s.maxDepth !== null && depthFromLatest > s.maxDepth) return false;
      if (s.minDepth !== null && depthFromLatest < s.minDepth) return false;
      return true;
    });

    if (scriptsForMessage.length === 0) return;
    void processNode(node, scriptsForMessage, ctx);
    return;
  }

  if (retriesLeft > 0) {
    requestAnimationFrame(() => processMessageById(messageId, retriesLeft - 1));
  }
}

  async function scanAllNow(compiled: CompiledScript[]): Promise<void> {
    const wasObserving = observer !== null && observedTarget !== null;
    if (wasObserving) observer!.disconnect();

    let observerReattached = false;
    let latestPendingId: string | null = null;

    try {
      const nodes = Array.from(document.querySelectorAll('[data-message-id]'));
      const total = nodes.length;
      const tasks: Promise<unknown>[] = [];

      nodes.forEach((n, i) => {
        const nodeMessageId = n.getAttribute('data-message-id');
        if (!nodeMessageId) return;

        const messageContent = n.querySelector('[data-component="MessageContent"]') as HTMLElement | null;
        const isDomLatest = i === total - 1;
        const isPending = !messageContent || messageContent.getAttribute('data-display-pending') === 'true';

        // PERFORMANCE-CRITICAL LUMIVERSE RULE:
        // Historical messages hydrate immediately, exactly like Vishrun did
        // before the readiness gate was introduced. The render pipeline now
        // normalizes temporary wrapper spans before/after insertion, and if
        // React really rebuilds one later, the targeted observer path repairs
        // only that message. Do NOT serialize a 500-message chat behind 500
        // independent data-display-pending transitions.
        //
        // The newest rendered message is different: it may still be actively
        // streaming / preprocessing, so keep the readiness gate for that one.
        if (isDomLatest && isPending) {
          waitingForReadyIds.add(nodeMessageId);
          latestPendingId = nodeMessageId;
          return;
        }

        const depthFromLatest = total - 1 - i;
        const scriptsForMessage = compiled.filter((s) => {
          if (s.maxDepth === 0 && s.minDepth === 0) {
            return nodeMessageId === latestMessageId;
          }
          if (s.maxDepth !== null && depthFromLatest > s.maxDepth) return false;
          if (s.minDepth !== null && depthFromLatest < s.minDepth) return false;
          return true;
        });
        if (scriptsForMessage.length === 0) return;
        tasks.push(processNode(n as HTMLElement, scriptsForMessage, ctx).catch(() => {}));
      });

      // Reattach before async widget builds settle. Host changes that truly
      // replace one historical message are then repaired by the targeted path,
      // while ordinary pending-clear noise from untouched history is ignored.
      if (wasObserving && observedTarget && document.contains(observedTarget)) {
        observer!.observe(observedTarget, OBSERVE_OPTS);
        observerReattached = true;
      }

      // Close the tiny disconnect/enumeration race for the ONE message we
      // intentionally deferred. If it already became ready, process it now;
      // otherwise its pending-clear attribute mutation will wake it later.
      if (latestPendingId) {
        const latest = document.querySelector(buildMessageSelector(latestPendingId)) as HTMLElement | null;
        const content = latest?.querySelector('[data-component="MessageContent"]') as HTMLElement | null;
        if (content && content.getAttribute('data-display-pending') !== 'true') {
          waitingForReadyIds.delete(latestPendingId);
          void processMessageIdsNow(new Set([latestPendingId]), compiled);
        }
      }

      await Promise.all(tasks);
    } finally {
      if (
        wasObserving &&
        !observerReattached &&
        observedTarget &&
        document.contains(observedTarget)
      ) {
        observer!.observe(observedTarget, OBSERVE_OPTS);
      }
    }
  }

  function messageElementForNode(node: Node | null): HTMLElement | null {
    if (!node) return null;
    const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
    if (!el) return null;
    if (el.matches?.('[data-message-id]')) return el as HTMLElement;
    return el.closest?.('[data-message-id]') as HTMLElement | null;
  }

  function addMessageIdsFromNode(node: Node | null, ids: Set<string>): void {
    if (!node || node.nodeType !== 1) return;
    const el = node as Element;

    const own = el.matches?.('[data-message-id]') ? el.getAttribute('data-message-id') : null;
    if (own) ids.add(own);

    el.querySelectorAll?.('[data-message-id]').forEach((message) => {
      const id = message.getAttribute('data-message-id');
      if (id) ids.add(id);
    });
  }

  function collectTargetMessageIds(records: MutationRecord[]): Set<string> {
    const ids = new Set<string>();

    for (const record of records) {
      // Ignore Vishrun's own widget insertions/removals instead of letting a
      // mixed observer batch make us revisit unrelated host messages.
      if (isSelfMutation(record)) continue;

      if (record.type === 'attributes') {
        if (record.attributeName !== 'data-display-pending') continue;
        const target = record.target as Element;

        // Most historical pending-clear events are now intentionally ignored.
        // Only a message that a targeted path explicitly deferred is allowed
        // to wake on READY. This is the key difference from the old watcher,
        // which made large chat hydration follow every historical transition.
        if (target.getAttribute('data-display-pending') === 'true') continue;

        const message = messageElementForNode(target);
        const id = message?.getAttribute('data-message-id');
        if (id && waitingForReadyIds.has(id)) {
          waitingForReadyIds.delete(id);
          ids.add(id);
        }
        continue;
      }

      if (record.type === 'childList') {
        // If React rebuilt content inside one existing message, target that
        // message only. This covers greeting switches and reconciliation that
        // removes a Vishrun widget before replacing the host subtree.
        const targetMessage = messageElementForNode(record.target);
        const targetId = targetMessage?.getAttribute('data-message-id');
        if (targetId) ids.add(targetId);

        // New rows can arrive nested inside wrappers. Collect only message rows
        // inside the newly-added subtree instead of rescanning MessageList.
        record.addedNodes.forEach((node) => addMessageIdsFromNode(node, ids));
      }
    }

    return ids;
  }

  async function processMessageIdsNow(
    messageIds: Set<string>,
    compiled: CompiledScript[],
  ): Promise<void> {
    if (messageIds.size === 0) return;

    // Query the rendered list ONCE for the whole observer batch. The old path
    // called scanAllNow() for every readiness mutation, which turned a large
    // chat into repeated O(totalMessages) work.
    const nodes = Array.from(document.querySelectorAll('[data-message-id]')) as HTMLElement[];
    const total = nodes.length;
    const indexById = new Map<string, number>();
    nodes.forEach((node, index) => {
      const id = node.getAttribute('data-message-id');
      if (id) indexById.set(id, index);
    });

    const tasks: Promise<unknown>[] = [];

    for (const messageId of messageIds) {
      const index = indexById.get(messageId);
      if (index === undefined) continue;

      const node = nodes[index];
      const messageContent = node.querySelector('[data-component="MessageContent"]') as HTMLElement | null;

      // Observer/event-driven work should never churn against temporary DOM.
      // Defer only the messages that were actually touched after the initial
      // fast hydration pass, then rebuild each once when Lumiverse marks it
      // ready. Historical messages that merely clear their pending flag do not
      // enter this path at all.
      if (!messageContent || messageContent.getAttribute('data-display-pending') === 'true') {
        waitingForReadyIds.add(messageId);
        continue;
      }
      waitingForReadyIds.delete(messageId);

      const depthFromLatest = total - 1 - index;
      const scriptsForMessage = compiled.filter((s) => {
        if (s.maxDepth === 0 && s.minDepth === 0) {
          return messageId === latestMessageId;
        }
        if (s.maxDepth !== null && depthFromLatest > s.maxDepth) return false;
        if (s.minDepth !== null && depthFromLatest < s.minDepth) return false;
        return true;
      });

      if (scriptsForMessage.length === 0) continue;
      tasks.push(processNode(node, scriptsForMessage, ctx).catch(() => {}));
    }

    await Promise.all(tasks);
  }

  function handleMutations(records: MutationRecord[]): void {
    if (records.length > 0) pendingRecords.push(...records);
    if (pendingFrame) return;

    pendingFrame = requestAnimationFrame(() => {
      pendingFrame = 0;
      const batch = pendingRecords;
      pendingRecords = [];

      const compiled = compiledForActiveCard();
      if (!compiled) {
        // Card cleared between mutation and frame — observer should be off.
        detachObserver();
        return;
      }

      const messageIds = collectTargetMessageIds(batch);
      if (messageIds.size === 0) return;

      void processMessageIdsNow(messageIds, compiled);
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
    // childList + subtree catch greeting/swipe rebuilds and new-message
    // inserts. data-display-pending catches Lumiverse's explicit transition
    // from temporary display DOM to settled content. We intentionally do NOT
    // observe characterData: token streaming must never trigger chat-wide work.
    observer.observe(target, OBSERVE_OPTS);
    observedTarget = target;
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
      void scanAllNow(compiled);
    });
    bodyWatcher.observe(document.body, { childList: true, subtree: true });
  }

  function detachObserver(): void {
    waitingForReadyIds.clear();
    if (pendingFrame) {
      cancelAnimationFrame(pendingFrame);
      pendingFrame = 0;
    }
    pendingRecords = [];
    if (bodyWatcher) {
      bodyWatcher.disconnect();
      bodyWatcher = null;
    }
    if (observer) {
      observer.disconnect();
      observer = null;
      observedTarget = null;
    }
  }

  function rescanAll(): void {
    // Tag-interceptor sync runs synchronously: registerTagInterceptor
    // mutates a frontend module's state and needs to be in place BEFORE
    // MessageContent's next render so the interceptor handler fires for
    // existing tags. Doing it inside the rAF would race the next render.
    const compiledNow = compiledForActiveCard();
    if (compiledNow) {
      syncTagInterceptors(ctx, compiledNow, {
        compiled: compiledNow,
        fetchContent: fetchMessageContentById,
        reprocess: (id) => processMessageById(id),
      });
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
      const allNodes = document.querySelectorAll('[data-message-id]');
      if (allNodes.length > 0) {
        latestMessageId = allNodes[allNodes.length - 1].getAttribute('data-message-id');
      }
      attachObserver();
      void scanAllNow(compiled);
    }));
  }

  const unsubGenEnded = ctx.events.on('GENERATION_ENDED', (payload: unknown) => {
    const p = (payload || {}) as GenerationEndedPayload;
    if (p.error) return;
    if (!isActiveChat(p.chatId)) return;
    if (!p.messageId) return;
    latestMessageId = p.messageId;
    processMessageById(p.messageId, MAX_RAF_RETRIES);
  });

  const unsubChatChanged = ctx.events.on('CHAT_CHANGED', (payload: unknown) => {
    const p = (payload || {}) as { changedFields?: string[] };
    if (!shouldRescanForChangedFields(p.changedFields)) return;
    // Active-card load is async (REST fetch). The frontend bootstrap calls
    // rescanAll() explicitly after setActiveCard(). This handler is a
    // safety net for the case where a chat loads with the SAME character
    // (debounced — no fetch) but new messages need scanning.
    rescanAll();
  });

  return {
    rescanAll,
    processMessageById,
    compiledForActiveCard,
    dispose: () => {
      detachObserver();
      teardownTagInterceptors();
      clearEditingMessageIds();
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
