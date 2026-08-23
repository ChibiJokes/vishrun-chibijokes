import type { SpindleFrontendContext } from 'lumiverse-spindle-types';
import { fetchCharacter, extractRegexScripts, hasTavernHelperScripts } from './lumiverse/fetch-character';
import { setActiveCard, clearActiveCard, getActiveCard } from './state/active-card';
import { installMessageHooks } from './hooks/message-rendered';
import { rebuildCapturesFromContent } from './hooks/tag-interceptor';
import { registerMvuDisplayStrip } from './hooks/mvu-display-strip';
import { installStatusBarInjectHook } from './hooks/status-bar-inject';
import { destroyAllRegisteredWidgetsForMessage } from './render/widget-iframe';
import { shouldRescanForChangedFields } from './core/chat-changed-filter';
import { createScriptsPanel, type ScriptsPanel, type OnReloadScript } from './settings/scripts-panel';
import { ScriptRunner } from './settings/script-runner';
import { loadEnabledScripts, initScriptStorage, getActiveLoomPresetId } from './settings/script-storage';

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

  // ── Generation relay bridge ──────────────────────────────────────────
  // Exposes window.__vishrunGenerate for injected scripts (e.g. Quill)
  // that need LLM access on hosted Lumiverse (where /generate/raw is
  // localhost-only). Requests go: window → ctx.sendToBackend() → worker
  // → api.generate.raw() over IPC → result back here → resolve promise.
  const pendingGenerates = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  const unsubBackendMsg = ctx.onBackendMessage((msg: unknown) => {
    if (!msg || typeof msg !== 'object') return;
    const m = msg as { type?: string; requestId?: string; result?: unknown; error?: string };
    if (m.type === 'vsh_generate_result' && m.requestId) {
      pendingGenerates.get(m.requestId)?.resolve(m.result);
      pendingGenerates.delete(m.requestId);
    } else if (m.type === 'vsh_generate_error' && m.requestId) {
      pendingGenerates.get(m.requestId)?.reject(new Error(m.error || 'Generation failed'));
      pendingGenerates.delete(m.requestId);
    }
  });

  (window as any).__vishrunGenerate = (opts: unknown) => {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      pendingGenerates.set(requestId, { resolve, reject });
      ctx.sendToBackend({ type: 'vsh_generate', requestId, ...(opts as object) });
      setTimeout(() => {
        if (pendingGenerates.has(requestId)) {
          pendingGenerates.delete(requestId);
          reject(new Error('Generation timed out'));
        }
      }, 120000);
    });
  };

  // ── Script runner — executes enabled scripts as hidden sandbox iframes
  const runner = new ScriptRunner(ctx);

  // Called by the panel after any save. runner.run() will reconcile by content
  // hash — only scripts whose content changed will restart.
  async function reloadRunner(): Promise<void> {
    const active = ctx.getActiveChat();
    const presetId = await getActiveLoomPresetId();
    const enabledScripts = await loadEnabledScripts(active.characterId ?? null, presetId);
    await runner.run(enabledScripts, active.chatId ?? null);
  }

  // ── Script settings panel (Settings → Extensions) ──────────────────
  const settingsMount = ctx.ui.mount('settings_extensions');
  const onReloadScript: OnReloadScript = (scriptId) => {
    runner.reload(scriptId);
    void reloadRunner();
  };

  let scriptsPanel: ScriptsPanel | null = createScriptsPanel(settingsMount, ctx, () => {
    void reloadRunner();
  }, onReloadScript);

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
      const presetId = await getActiveLoomPresetId();
      scriptsPanel?.onPresetChanged(presetId);
      // Pass an empty list — runner.run() will tear down character frames
      // (no longer in the incoming list) while leaving globals/presets untouched
      // since they aren't in the frame map under any characterId key.
      const enabledScripts = await loadEnabledScripts(null, presetId);
      await runner.run(enabledScripts, null);
      hooks.rescanAll();
      return;
    }
    if (inflightCharacterId === characterId) {
      console.warn('[vishrun:diag] loadFor early-exit: already inflight for', characterId);
      return;
    }
    if (lastLoadedCharacterId === characterId && getActiveCard()?.characterId === characterId) {
      // Same character, card already cached — skip the REST fetch.
      // runner.run() will reconcile by content hash; if nothing changed,
      // no frames are touched at all (same as JSLR on a chat switch).
      console.warn('[vishrun:diag] loadFor: same character, re-using cached card');
      hooks.rescanAll();
      const chatId = ctx.getActiveChat().chatId ?? null;
      const enabledScripts = await loadEnabledScripts(characterId);
      console.log('[vishrun:diag] loadFor(cache-hit) reconciling', enabledScripts.length, 'scripts, chatId:', chatId);
      await runner.run(enabledScripts, chatId);
      return;
    }
    inflightCharacterId = characterId;
    try {
      const presetId = await getActiveLoomPresetId();
      const [char, enabledScripts] = await Promise.all([
        fetchCharacter(characterId),
        loadEnabledScripts(characterId, presetId),
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
      scriptsPanel?.onPresetChanged(presetId);
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
    void loadFor(
      p.characterId ??
      ctx.getActiveChat().characterId ??
      getActiveCard()?.characterId ??
      null
    );
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

  let lastPresetId: string = '__default__';

  // Tracks cleanup for a deferred loadFor when activeChatId changes but
  // characterId isn't populated yet (Lumiverse calls setActiveCharacter()
  // after the chat API fetch completes, emitting no WS event). Cancelled on
  // teardown and on any subsequent navigation that supersedes the deferred one.
  let cancelPendingNavLoad: (() => void) | null = null;

  function scheduleDeferredLoadFor(expectedChatId: string): void {
    if (cancelPendingNavLoad) {
      cancelPendingNavLoad();
      cancelPendingNavLoad = null;
    }

    let cancelled = false;
    cancelPendingNavLoad = () => { cancelled = true; cancelPendingNavLoad = null; };

    // Poll ctx.getActiveChat().characterId every 50ms. Lumiverse sets it via
    // setActiveCharacter() shortly after the chat API fetch completes, but
    // emits no WS event, so polling is the only reliable way to observe it.
    void (async () => {
      const POLL_MS = 50;
      const TIMEOUT_MS = 3000;
      const start = Date.now();

      while (!cancelled && Date.now() - start < TIMEOUT_MS) {
        await new Promise<void>(resolve => setTimeout(resolve, POLL_MS));
        if (cancelled) return;
        const active = ctx.getActiveChat();
        if (active.chatId !== expectedChatId) return; // navigated away
        if (active.characterId) {
          cancelPendingNavLoad = null;
          console.log('[vishrun:diag] deferred loadFor resolved, characterId:', active.characterId);
          void loadFor(active.characterId);
          return;
        }
      }

      // Timeout — load with whatever we have (may be null).
      if (!cancelled) {
        cancelPendingNavLoad = null;
        void loadFor(ctx.getActiveChat().characterId ?? null);
      }
    })();
  }

  const unsubSettingsUpdated = ctx.events.on('SETTINGS_UPDATED', (payload: unknown) => {
    const p = (payload || {}) as { key?: string };
    if (p.key === 'activeChatId' || p.key === 'activeCharacterId') {
      // Cancel any in-flight deferred load from a previous navigation.
      if (cancelPendingNavLoad) cancelPendingNavLoad();

      const { characterId, chatId } = ctx.getActiveChat();

      if (!chatId) {
        // Navigating away from all chats — clear immediately.
        void loadFor(null);
        return;
      }

      if (characterId) {
        // Character already known (navigation snapshot was staged, or the
        // activeCharacterId setting changed directly). Load immediately.
        void loadFor(characterId);
        return;
      }

      // chatId is set but characterId is null. This is the post-update path:
      // Lumiverse calls setActiveChat(chatId, null) then asynchronously fetches
      // the chat and calls setActiveCharacter(id) — with no WS event in between.
      // Poll until characterId is available.
      console.log('[vishrun:diag] SETTINGS_UPDATED activeChatId with null characterId — polling for characterId');
      scheduleDeferredLoadFor(chatId);
      return;
    }
    // Bare WS event (no key) = batch settings flush. Fires when user switches
    // looms. Re-read the loom ID and update the panel + runner if it changed.
    if (p.key === undefined) {
      void (async () => {
        const newPresetId = await getActiveLoomPresetId();
        if (newPresetId !== lastPresetId) {
          lastPresetId = newPresetId;
          scriptsPanel?.onPresetChanged(newPresetId);
          const active = ctx.getActiveChat();
          const enabledScripts = await loadEnabledScripts(active.characterId ?? null, newPresetId);
          await runner.run(enabledScripts, active.chatId ?? null);
        }
      })();
    }
  });

  const active = ctx.getActiveChat();
  console.log('[vishrun:diag] setup() initial state — characterId:', active.characterId, 'chatId:', active.chatId);
  if (active.characterId) {
    void loadFor(active.characterId);
  } else {
    void (async () => {
      const presetId = await getActiveLoomPresetId();
      lastPresetId = presetId;
      scriptsPanel?.onPresetChanged(presetId);
      void reloadRunner();
    })();
  }

  return () => {
    if (cancelPendingNavLoad) {
      cancelPendingNavLoad();
    }
    unsubChatChanged();
    unsubSettingsUpdated();
    unsubMessageSwiped();
    unsubMessageEdited();
    unsubMvuDisplayStrip();
    unsubStatusBarInject();
    unsubBackendMsg();
    delete (window as any).__vishrunGenerate;
    hooks.dispose();
    ctx.dom.cleanup();
    clearActiveCard();
    scriptsPanel?.destroy();
    scriptsPanel = null;
    runner.destroy();
  };
}
