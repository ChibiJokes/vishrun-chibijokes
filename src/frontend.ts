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
import { loadEnabledScripts, initScriptStorage } from './settings/script-storage';

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
    console.log('[vishrun:diag] reloadRunner called, characterId:', active.characterId, 'chatId:', active.chatId);
    // Global/preset scripts should run even without an active character.
    // Only bail if there's truly nothing to load (no scripts at all).
    const enabledScripts = await loadEnabledScripts(active.characterId ?? null);
    console.log('[vishrun:diag] reloadRunner enabledScripts count:', enabledScripts.length);
    if (enabledScripts.length === 0) {
      console.warn('[vishrun:diag] reloadRunner early-exit: no enabled scripts');
      return;
    }
    await runner.run(enabledScripts, active.chatId ?? null);
  }

  // ── Script settings panel (Settings → Extensions) ──────────────────
  const settingsMount = ctx.ui.mount('settings_extensions');
  let scriptsPanel: ScriptsPanel | null = createScriptsPanel(settingsMount, ctx, () => {
    void reloadRunner();
  });

  // Pre-create settings keys so subsequent GETs return 200 instead of 404.
  void initScriptStorage();

  let inflightCharacterId: string | null = null;
  let lastLoadedCharacterId: string | null = null;

  async function loadFor(characterId: string | null) {
    console.log('[vishrun:diag] loadFor called:', characterId,
      '| inflight:', inflightCharacterId,
      '| lastLoaded:', lastLoadedCharacterId);

    if (!characterId) {
      clearActiveCard();
      lastLoadedCharacterId = null;
      scriptsPanel?.onCharacterChanged(null);
      await runner.run([], null);
      hooks.rescanAll();
      return;
    }
    if (inflightCharacterId === characterId) {
      console.warn('[vishrun:diag] loadFor early-exit: already inflight for', characterId);
      return;
    }
    if (lastLoadedCharacterId === characterId && getActiveCard()?.characterId === characterId) {
      // Same character, card already cached — skip the REST fetch but still
      // relaunch script iframes. teardownAll() runs inside runner.run() so
      // iframes from the previous chat session are always dead by the time we
      // get here; skipping runner.run() would leave the scripts permanently
      // gone until a full page reload.
      console.warn('[vishrun:diag] loadFor: same character, re-using cached card, relaunching runner');
      hooks.rescanAll();
      const chatId = ctx.getActiveChat().chatId ?? null;
      const enabledScripts = await loadEnabledScripts(characterId);
      console.log('[vishrun:diag] loadFor(cache-hit) relaunching', enabledScripts.length, 'scripts, chatId:', chatId);
      await runner.run(enabledScripts, chatId);
      return;
    }
    inflightCharacterId = characterId;
    try {
      const [char, enabledScripts] = await Promise.all([
        fetchCharacter(characterId),
        loadEnabledScripts(characterId),
      ]);
      console.log('[vishrun:diag] loadEnabledScripts returned', enabledScripts.length, 'scripts:', enabledScripts.map(s => s.name));
      const scripts = extractRegexScripts(char);
      const name = (char.name as string | undefined) ?? null;
      const chatId = ctx.getActiveChat().chatId ?? null;
      console.log('[vishrun:diag] chatId:', chatId, '| regex scripts:', scripts.length);

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

      console.log('[vishrun:diag] calling runner.run with', enabledScripts.length, 'scripts, chatId:', chatId);
      await runner.run(enabledScripts, chatId);

      hooks.rescanAll();
    } catch (err) {
      console.error('[vishrun:diag] loadFor FAILED:', err);
    } finally {
      if (inflightCharacterId === characterId) inflightCharacterId = null;
    }
  }

  const unsubChatChanged = ctx.events.on('CHAT_CHANGED', (payload: unknown) => {
    const p = (payload || {}) as ChatChangedPayload;
    const pass = shouldRescanForChangedFields(p.changedFields);
    console.log('[vishrun:diag] CHAT_CHANGED fired, changedFields:', p.changedFields, '| passes filter:', pass, '| characterId:', p.characterId);
    if (!pass) return;
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
    console.log('[vishrun:diag] SETTINGS_UPDATED key:', p.key);
    if (p.key !== 'activeChatId' && p.key !== 'activeCharacterId') return;
    void loadFor(ctx.getActiveChat().characterId ?? null);
  });

  const active = ctx.getActiveChat();
  console.log('[vishrun:diag] setup() initial state — characterId:', active.characterId, 'chatId:', active.chatId);
  if (active.characterId) {
    void loadFor(active.characterId);
  } else {
    // No active character yet, but global/preset scripts should still run at startup.
    console.warn('[vishrun:diag] setup(): no active characterId at startup, running global scripts');
    void reloadRunner();
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
