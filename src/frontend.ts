import type { SpindleFrontendContext } from 'lumiverse-spindle-types';
import { fetchCharacter, extractRegexScripts, hasTavernHelperScripts } from './lumiverse/fetch-character';
import { setActiveCard, clearActiveCard, getActiveCard } from './state/active-card';
import { installMessageHooks } from './hooks/message-rendered';
import { rebuildCapturesFromContent } from './hooks/tag-interceptor';
import { registerMvuDisplayStrip } from './hooks/mvu-display-strip';
import { installStatusBarInjectHook } from './hooks/status-bar-inject';
import { destroyAllRegisteredWidgetsForMessage } from './render/widget-iframe';
import { shouldRescanForChangedFields } from './core/chat-changed-filter';
import { createScriptsPanel, type ScriptsPanel } from './settings/scripts-panel';

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
  previousSwipeId?: number;
}

export function setup(ctx: SpindleFrontendContext) {
  const hooks = installMessageHooks(ctx);
  // System-wide: hide <UpdateVariable> blocks from the chat UI without
  // mutating the stored content. The backend MVU replay needs the blocks
  // in the DB row.
  const unsubMvuDisplayStrip = registerMvuDisplayStrip(ctx);
  // System-wide: append <StatusPlaceHolderImpl/> to LLM responses that
  // lack the trigger so the Status Bar widget mounts on assistant
  // messages too (greeting already carries the placeholder in the card).
  const unsubStatusBarInject = installStatusBarInjectHook(ctx);

  // ── Script settings panel ──────────────────────────────────────────
  // ctx.ui.mount('settings_extensions') injects into the Extensions tab
  // of the host Settings modal (Settings → Extensions).
  // The host wraps the returned root in a card with border + padding, so
  // the panel renders as a named section alongside other extensions.
  const settingsRoot = ctx.ui.mount('settings_extensions');
  let scriptsPanel: ScriptsPanel | null = createScriptsPanel(settingsRoot, ctx);

  // Per-character debounce: avoid duplicate fetches when CHAT_CHANGED fires
  // with the same characterId (e.g. swipe edits, transient state).
  let inflightCharacterId: string | null = null;
  let lastLoadedCharacterId: string | null = null;

  async function loadFor(characterId: string | null) {
    if (!characterId) {
      clearActiveCard();
      lastLoadedCharacterId = null;
      scriptsPanel?.onCharacterChanged(null);
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
        // Character has no regex widgets, but may still have tavern_helper
        // scripts. Notify the panel so the Character Scripts section is current.
        scriptsPanel?.onCharacterChanged(characterId);
        hooks.rescanAll();
        return;
      }

      const firstMes = typeof char.first_mes === 'string' ? char.first_mes : null;
      const alternateGreetings = Array.isArray(char.alternate_greetings)
        ? char.alternate_greetings.filter((g): g is string => typeof g === 'string')
        : [];
      setActiveCard({ characterId, characterName: name, scripts, firstMes, alternateGreetings });
      lastLoadedCharacterId = characterId;

      // Notify the panel so it reloads character scripts.
      // hasTavernHelperScripts() is a quick check — ST-exported cards with
      // JSLR scripts carry them in extensions.tavern_helper.scripts, which
      // the panel reads directly with no import step.
      scriptsPanel?.onCharacterChanged(characterId);
      scriptsPanel?.setHasTavernHelperScripts(hasTavernHelperScripts(char));

      hooks.rescanAll();
    } catch (err) {
      console.debug('[vishrun] fetchCharacter failed:', err);
    } finally {
      if (inflightCharacterId === characterId) inflightCharacterId = null;
    }
  }

  const unsubChatChanged = ctx.events.on('CHAT_CHANGED', (payload: unknown) => {
    const p = (payload || {}) as ChatChangedPayload;
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
  function handleMessageMutation(eventName: 'MESSAGE_EDITED' | 'MESSAGE_SWIPED', payload: unknown): void {
    const p = (payload || {}) as MessageEventPayload;
    const msg = p.message;
    if (!msg || typeof msg.id !== 'string' || typeof msg.content !== 'string') return;
    const active = ctx.getActiveChat();
    if (active.chatId && p.chatId && active.chatId !== p.chatId) return;

    const destroyReason = eventName === 'MESSAGE_EDITED' ? 'message-edited' : 'message-swiped';
    destroyAllRegisteredWidgetsForMessage(msg.id, destroyReason);

    const compiled = hooks.compiledForActiveCard();
    if (!compiled) return;
    rebuildCapturesFromContent(msg.id, msg.content, compiled, eventName);
    hooks.processMessageById(msg.id);
  }

  const unsubMessageSwiped = ctx.events.on('MESSAGE_SWIPED', (p) => handleMessageMutation('MESSAGE_SWIPED', p));
  const unsubMessageEdited = ctx.events.on('MESSAGE_EDITED', (p) => handleMessageMutation('MESSAGE_EDITED', p));

  // Cold-load on hydration: CHAT_CHANGED only fires on intra-app navigation,
  // not on the initial SPA hydration. SETTINGS_UPDATED with key
  // 'activeChatId' or 'activeCharacterId' is the wakeup signal.
  const unsubSettingsUpdated = ctx.events.on('SETTINGS_UPDATED', (payload: unknown) => {
    const p = (payload || {}) as { key?: string };
    if (p.key !== 'activeChatId' && p.key !== 'activeCharacterId') return;
    void loadFor(ctx.getActiveChat().characterId ?? null);
  });

  const active = ctx.getActiveChat();
  if (active.characterId) {
    void loadFor(active.characterId);
  }

  return () => {
    unsubChatChanged();
    unsubSettingsUpdated();
    unsubMessageSwiped();
    unsubMessageEdited();
    unsubMvuDisplayStrip();
    unsubStatusBarInject();
    hooks.dispose();
    ctx.dom.cleanup();
    clearActiveCard();
    scriptsPanel?.destroy();
    scriptsPanel = null;
  };
}
