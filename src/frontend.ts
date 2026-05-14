import type { SpindleFrontendContext } from 'lumiverse-spindle-types';
import { fetchCharacter, extractRegexScripts } from './lumiverse/fetch-character';
import { setActiveCard, clearActiveCard, getActiveCard } from './state/active-card';
import { installMessageHooks } from './hooks/message-rendered';
import { rebuildCapturesFromContent } from './hooks/tag-interceptor';
import { shouldRescanForChangedFields } from './core/chat-changed-filter';

interface ChatChangedPayload {
  chatId?: string | null;
  characterId?: string | null;
  changedFields?: string[];
}

interface MessageEventPayload {
  chatId?: string;
  message?: { id?: string; content?: string };
  action?: string;
  swipeId?: number;
}

export function setup(ctx: SpindleFrontendContext) {
  const hooks = installMessageHooks(ctx);
  // Iframe → host postMessage routing is per-frame now: each call to
  // buildWidgetIframe registers a frame.onMessage handler scoped to its
  // own contentWindow. The single-listener installIframeBridge that
  // pre-d157784 vishrun used is gone — host bridge keying on contentWindow
  // makes it unnecessary.

  // Per-character debounce: avoid duplicate fetches when CHAT_CHANGED fires
  // with the same characterId (e.g. swipe edits, transient state).
  let inflightCharacterId: string | null = null;
  let lastLoadedCharacterId: string | null = null;

  async function loadFor(characterId: string | null) {
    if (!characterId) {
      clearActiveCard();
      lastLoadedCharacterId = null;
      hooks.rescanAll(); // detaches the observer when there's no active card
      return;
    }
    if (inflightCharacterId === characterId) return;
    if (lastLoadedCharacterId === characterId && getActiveCard()?.characterId === characterId) {
      // Same character as before — cache is valid. Still rescan because the
      // chat itself may have changed (different chat, same character).
      hooks.rescanAll();
      return;
    }
    inflightCharacterId = characterId;
    try {
      const char = await fetchCharacter(characterId);
      const scripts = extractRegexScripts(char);
      const name = (char.name as string | undefined) ?? null;

      if (scripts.length === 0) {
        clearActiveCard();
        lastLoadedCharacterId = characterId;
        hooks.rescanAll(); // detaches the observer for cards without scripts
        return;
      }

      const firstMes = typeof char.first_mes === 'string' ? char.first_mes : null;
      const alternateGreetings = Array.isArray(char.alternate_greetings)
        ? char.alternate_greetings.filter((g): g is string => typeof g === 'string')
        : [];
      setActiveCard({ characterId, characterName: name, scripts, firstMes, alternateGreetings });
      lastLoadedCharacterId = characterId;
      hooks.rescanAll();
    } catch (err) {
      console.debug('[vishrun] fetchCharacter failed:', err);
    } finally {
      if (inflightCharacterId === characterId) inflightCharacterId = null;
    }
  }

  const unsubChatChanged = ctx.events.on('CHAT_CHANGED', (payload: unknown) => {
    const p = (payload || {}) as ChatChangedPayload;
    console.log('[VISHRUN_LISTENER_A]', JSON.stringify({ characterId: p.characterId, changedFields: p.changedFields })); // VISHRUN_DEBUG_INSTRUMENTATION
    if (!shouldRescanForChangedFields(p.changedFields)) return;
    void loadFor(p.characterId ?? ctx.getActiveChat().characterId ?? null);
  });

  // Workaround for upstream issue: the host's `delivered` Set in
  // Lumiverse/frontend/src/lib/spindle/message-interceptors.ts:21 dedupes
  // tag intercept dispatches by (extensionId, messageId, isStreaming,
  // tagName, fullMatch) and never clears. Swiping back to a previously-
  // seen swipe doesn't re-fire the interceptor, so capturesByMessage
  // holds stale captures and the widget shows content from another swipe
  // (the last unique fullMatch the handler did fire for).
  //
  // We compute captures locally from the event payload to bypass the
  // host pipeline entirely. MESSAGE_SWIPED + MESSAGE_EDITED both ship
  // the new message body in `message.content` (chats.service.ts:982-989
  // for swipe, similar for edit), so re-running each paired-tag script's
  // findRe against that string lets us reconstruct what the captures
  // *should* be without depending on the interceptor firing.
  function handleMessageMutation(payload: unknown): void {
    const p = (payload || {}) as MessageEventPayload;
    const msg = p.message;
    if (!msg || typeof msg.id !== 'string' || typeof msg.content !== 'string') return;
    const active = ctx.getActiveChat();
    if (active.chatId && p.chatId && active.chatId !== p.chatId) return;
    const compiled = hooks.compiledForActiveCard();
    if (!compiled) return;
    const changed = rebuildCapturesFromContent(msg.id, msg.content, compiled);
    if (changed) {
      hooks.processMessageById(msg.id);
    }
  }

  const unsubMessageSwiped = ctx.events.on('MESSAGE_SWIPED', handleMessageMutation);
  const unsubMessageEdited = ctx.events.on('MESSAGE_EDITED', handleMessageMutation);

  // Cold-load from /characters: Lumiverse's SPA hydrates activeChatId /
  // activeCharacterId AFTER spindle setup() runs. CHAT_CHANGED only fires
  // on subsequent intra-app navigation, not on this initial hydration.
  // SETTINGS_UPDATED with key 'activeChatId' or 'activeCharacterId' is the
  // wakeup. Watch-item: depends on those literal key strings; if Lumiverse
  // renames either, the cold-load path silently breaks until something
  // else (CHAT_CHANGED) wakes the extension.
  const unsubSettingsUpdated = ctx.events.on('SETTINGS_UPDATED', (payload: unknown) => {
    const p = (payload || {}) as { key?: string };
    if (p.key !== 'activeChatId' && p.key !== 'activeCharacterId') return;
    void loadFor(ctx.getActiveChat().characterId ?? null);
  });

  // If Lumiverse already hydrated by the time setup() runs, kick the load
  // synchronously. Otherwise wait for SETTINGS_UPDATED. We deliberately do
  // NOT call loadFor(null) here: that would render the "no character"
  // branch (observer detached) which is correct as a runtime cleanup but
  // wrong as a setup-time default.
  const active = ctx.getActiveChat();
  if (active.characterId) {
    void loadFor(active.characterId);
  }

  return () => {
    unsubChatChanged();
    unsubSettingsUpdated();
    unsubMessageSwiped();
    unsubMessageEdited();
    hooks.dispose();
    ctx.dom.cleanup();
    clearActiveCard();
  };
}
