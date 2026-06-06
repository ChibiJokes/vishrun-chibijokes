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
  const scriptTab = ctx.ui.registerDrawerTab({
    id: 'scripts',
    title: 'Scripts',
    description: 'Global, character, and preset JavaScript scripts',
  });
  let scriptsPanel: ScriptsPanel | null = createScriptsPanel(scriptTab.root, ctx);

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
        // Character has no regex widgets, but may still have tavern_helper scripts.
        // Notify the panel so the Character Scripts section stays up to date.
        scriptsPanel?.onCharacterChanged(characterId);
        hooks.rescanAll(); // detaches the observer for cards without scripts
        return;
      }

      const firstMes = typeof char.first_mes === 'string' ? char.first_mes : null;
      const alternateGreetings = Array.isArray(char.alternate_greetings)
        ? char.alternate_greetings.filter((g): g is string => typeof g === 'string')
        : [];
      setActiveCard({ characterId, characterName: name, scripts, firstMes, alternateGreetings });
      lastLoadedCharacterId = characterId;

      // Notify the scripts panel so it can reload character scripts and update
      // the tab badge. hasTavernHelperScripts() is a fast check — if the card
      // carries JSLR scripts, the panel will surface them automatically since
      // both vishrun and JSLR write to extensions.tavern_helper.scripts.
      scriptsPanel?.onCharacterChanged(characterId);
      if (hasTavernHelperScripts(char)) {
        scriptTab.setBadge('ST');
      } else {
        scriptTab.setBadge(null);
      }

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
  //
  // We compute captures locally from the event payload to bypass the
  // host pipeline entirely. MESSAGE_SWIPED + MESSAGE_EDITED both ship
  // the new message body in `message.content` (chats.service.ts:982-989
  // for swipe, similar for edit), so re-running each paired-tag script's
  // findRe against that string lets us reconstruct what the captures
  // *should* be without depending on the interceptor firing.
  function handleMessageMutation(eventName: 'MESSAGE_EDITED' | 'MESSAGE_SWIPED', payload: unknown): void {
    const p = (payload || {}) as MessageEventPayload;
    const msg = p.message;
    if (!msg || typeof msg.id !== 'string' || typeof msg.content !== 'string') return;
    const active = ctx.getActiveChat();
    if (active.chatId && p.chatId && active.chatId !== p.chatId) return;

    // Force-rebuild every widget iframe in the affected message. The
    // iframe registry keys on (messageId, scriptId, fullMatchHash); for
    // static paired tags like <StatusPlaceHolderImpl> the fullMatch is
    // identical across alternate greetings, so the idempotency check in
    // renderPairedTagCaptures would reuse the existing iframe with its
    // STALE baked-in variables snapshot. Wiping the registry here forces
    // the next processNode pass to rebuild with a fresh snapshot.
    const destroyReason = eventName === 'MESSAGE_EDITED' ? 'message-edited' : 'message-swiped';
    destroyAllRegisteredWidgetsForMessage(msg.id, destroyReason);

    const compiled = hooks.compiledForActiveCard();
    if (!compiled) return;
    // rebuildCapturesFromContent updates capturesByMessage so phase-1
    // cleanup in renderPairedTagCaptures has a fresh capture list to
    // compare against. processMessageById then forces processNode to run
    // even if rebuildCapturesFromContent reported no semantic change
    // (which happens when the paired-tag content didn't change across
    // greetings — the case that motivated the destroyAll above).
    rebuildCapturesFromContent(msg.id, msg.content, compiled, eventName);
    hooks.processMessageById(msg.id);
  }

  const unsubMessageSwiped = ctx.events.on('MESSAGE_SWIPED', (p) => handleMessageMutation('MESSAGE_SWIPED', p));
  const unsubMessageEdited = ctx.events.on('MESSAGE_EDITED', (p) => handleMessageMutation('MESSAGE_EDITED', p));

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
    unsubMvuDisplayStrip();
    unsubStatusBarInject();
    hooks.dispose();
    ctx.dom.cleanup();
    clearActiveCard();
    scriptsPanel?.destroy();
    scriptsPanel = null;
    scriptTab.destroy();
  };
}
