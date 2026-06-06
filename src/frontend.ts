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
import { ScriptRunner } from './settings/script-runner';
import { loadEnabledScripts } from './settings/script-storage';

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
  const unsubMvuDisplayStrip = registerMvuDisplayStrip(ctx);
  const unsubStatusBarInject = installStatusBarInjectHook(ctx);

  // ── Script runner — executes enabled scripts as hidden sandbox iframes
  const runner = new ScriptRunner(ctx);

  // Called by the panel after any save — reloads runner with updated script list.
  async function reloadRunner(): Promise<void> {
    const active = ctx.getActiveChat();
    if (!active.characterId || !active.chatId) return;
    const enabledScripts = await loadEnabledScripts(active.characterId);
    await runner.run(enabledScripts, active.chatId);
  }

  // ── Script settings panel (Settings → Extensions) ──────────────────
  const settingsMount = ctx.ui.mount('settings_extensions');
  let scriptsPanel: ScriptsPanel | null = createScriptsPanel(settingsMount, ctx, () => {
    void reloadRunner();
  });

  let inflightCharacterId: string | null = null;
  let lastLoadedCharacterId: string | null = null;

  async function loadFor(characterId: string | null) {
    if (!characterId) {
      clearActiveCard();
      lastLoadedCharacterId = null;
      scriptsPanel?.onCharacterChanged(null);
      await runner.run([], null);
      hooks.rescanAll();
      return;
    }
    if (inflightCharacterId === characterId) return;
    if (lastLoadedCharacterId === characterId && getActiveCard()?.characterId === characterId) {
      hooks.rescanAll();
      return;
    }
    inflightCharacterId = characterId;
    try {
      const [char, enabledScripts] = await Promise.all([
        fetchCharacter(characterId),
        loadEnabledScripts(characterId),
      ]);
      const scripts = extractRegexScripts(char);
      const name = (char.name as string | undefined) ?? null;
      const chatId = ctx.getActiveChat().chatId ?? null;

      if (scripts.length > 0) {
        const firstMes = typeof char.first_mes === 'string' ? char.first_mes : null;
        const alternateGreetings = Array.isArray(char.alternate_greetings)
          ? char.alternate_greetings.filter((g): g is string => typeof g === 'string')
          : [];
        setActiveCard({ characterId, characterName: name, scripts, firstMes, alternateGreetings });
      } else {
        clearActiveCard();
      }

      lastLoadedCharacterId = characterId;
      scriptsPanel?.onCharacterChanged(characterId);
      scriptsPanel?.setHasTavernHelperScripts(hasTavernHelperScripts(char));

      // Launch enabled scripts in hidden sandbox iframes.
      await runner.run(enabledScripts, chatId);

      hooks.rescanAll();
    } catch (err) {
      console.debug('[vishrun] loadFor failed:', err);
    } finally {
      if (inflightCharacterId === characterId) inflightCharacterId = null;
    }
  }

  const unsubChatChanged = ctx.events.on('CHAT_CHANGED', (payload: unknown) => {
    const p = (payload || {}) as ChatChangedPayload;
    if (!shouldRescanForChangedFields(p.changedFields)) return;
    void loadFor(p.characterId ?? ctx.getActiveChat().characterId ?? null);
  });

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
    runner.destroy();
  };
}
