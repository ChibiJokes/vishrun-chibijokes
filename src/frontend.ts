import type { SpindleFrontendContext } from 'lumiverse-spindle-types';
import { fetchCharacter, extractRegexScripts } from './lumiverse/fetch-character';
import { setActiveCard, clearActiveCard, getActiveCard } from './state/active-card';
import { installMessageHooks } from './hooks/message-rendered';
import { installIframeBridge } from './render/widget-iframe';

const STEP_LABEL = 'Vishrun · Step 3';

interface ChatChangedPayload {
  chatId?: string | null;
  characterId?: string | null;
}

export function setup(ctx: SpindleFrontendContext) {
  console.log('[vishrun][step3] setup() invoked');

  const removeStyle = ctx.dom.addStyle(`
    .vishrun-banner {
      position: fixed;
      top: 12px;
      right: 12px;
      max-width: 460px;
      padding: 10px 14px;
      background: var(--lumiverse-fill-subtle, #1f1f1f);
      border: 1px solid var(--lumiverse-border, #444);
      border-radius: 6px;
      color: var(--lumiverse-text, #eee);
      font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
      z-index: 99999;
      box-shadow: 0 4px 16px rgba(0,0,0,0.35);
      display: none;
    }
    .vishrun-banner.show { display: block; }
    .vishrun-banner b { color: var(--lumiverse-text, #fff); }
    .vishrun-banner .ok { color: #5fd97e; }
    .vishrun-banner .fail { color: #ff7a7a; }
    .vishrun-banner .muted { color: var(--lumiverse-text-muted, #999); }
    .vishrun-banner ul { margin: 4px 0 0 0; padding-left: 18px; }
    .vishrun-banner li { line-height: 1.35; }
  `);

  ctx.dom.inject(
    'body',
    '<div class="vishrun-banner"></div>'
  );

  const banner = ctx.dom.query('.vishrun-banner') as HTMLElement | null;

  const escape = (s: string) => s.replace(/[<>&"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[ch]!));

  const renderHidden = () => {
    if (banner) {
      banner.classList.remove('show');
      banner.innerHTML = '';
    }
  };
  const renderLoaded = (count: number, characterName: string | null, scriptNames: string[]) => {
    if (!banner) return;
    const items = scriptNames.map((n) => `<li>${escape(n || '(unnamed)')}</li>`).join('');
    banner.innerHTML = `<b>${STEP_LABEL}</b><br>` +
      `<span class="ok">✓ loaded ${count} regex_scripts</span><br>` +
      `<span class="muted">card: ${escape(characterName ?? '(unnamed)')}</span>` +
      (items ? `<ul>${items}</ul>` : '');
    banner.classList.add('show');
  };
  const renderError = (msg: string) => {
    if (!banner) return;
    banner.innerHTML = `<b>${STEP_LABEL}</b><br><span class="fail">✗ ${escape(msg)}</span>`;
    banner.classList.add('show');
  };

  // Install message hooks (placeholder pipeline: observer + GENERATION_ENDED;
  // paired-tag pipeline: registerTagInterceptor coordinator). The hooks
  // module listens to CHAT_CHANGED on its own; the frontend bootstrap below
  // ALSO listens to refresh the active-card cache and call rescanAll() once
  // the cache is populated.
  const hooks = installMessageHooks(ctx);

  // Single document-wide listener that resizes paired-tag and placeholder
  // iframes to their reported content height. Independent of card state.
  const teardownIframeBridge = installIframeBridge();

  // Per-character debounce: avoid duplicate fetches when CHAT_CHANGED fires
  // with the same characterId (e.g. swipe edits, transient state).
  let inflightCharacterId: string | null = null;
  let lastLoadedCharacterId: string | null = null;

  async function loadFor(characterId: string | null) {
    if (!characterId) {
      clearActiveCard();
      lastLoadedCharacterId = null;
      renderHidden();
      hooks.rescanAll(); // detaches the observer when there's no active card
      console.debug('[vishrun][step3] no active character — silent no-op');
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
        renderHidden();
        hooks.rescanAll(); // detaches the observer for cards without scripts
        console.debug(`[vishrun][step3] character ${characterId} has no regex_scripts — silent no-op`);
        return;
      }

      setActiveCard({ characterId, characterName: name, scripts });
      lastLoadedCharacterId = characterId;
      const enabled = scripts.filter((s) => !s.disabled).length;
      console.log(
        `[vishrun][step3] loaded ${scripts.length} regex_scripts (${enabled} enabled) for character "${name}" (${characterId})`,
        scripts.map((s) => ({
          scriptName: s.scriptName,
          findRegex: s.findRegex,
          disabled: s.disabled,
          placement: s.placement,
          replaceLen: s.replaceString?.length,
        }))
      );
      renderLoaded(scripts.length, name, scripts.map((s) => s.scriptName ?? ''));
      hooks.rescanAll();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[vishrun][step3] fetchCharacter failed:', err);
      renderError(`fetchCharacter failed: ${msg}`);
    } finally {
      if (inflightCharacterId === characterId) inflightCharacterId = null;
    }
  }

  // ─── Refresh on CHAT_CHANGED ──────────────────────────────────────────
  const unsubChatChanged = ctx.events.on('CHAT_CHANGED', (payload: unknown) => {
    const p = (payload || {}) as ChatChangedPayload;
    console.log('[vishrun][step3] CHAT_CHANGED:', p);
    void loadFor(p.characterId ?? ctx.getActiveChat().characterId ?? null);
  });

  // ─── Hydration trigger via SETTINGS_UPDATED ──────────────────────────
  // Cold-load from /characters: Lumiverse's SPA hydrates activeChatId /
  // activeCharacterId AFTER spindle setup() runs. CHAT_CHANGED only fires
  // on subsequent intra-app navigation, not on this initial hydration.
  // So we listen to SETTINGS_UPDATED and re-query getActiveChat() when
  // either of the two relevant keys changes.
  //
  // Watch-item: this depends on the literal string keys 'activeChatId'
  // and 'activeCharacterId'. If Lumiverse renames either, the cold-load
  // path silently breaks until something else (CHAT_CHANGED on intra-app
  // navigation) wakes the extension. Keep an eye on this if a Lumiverse
  // upgrade ever surfaces a "widgets don't appear without F5" regression.
  const unsubSettingsUpdated = ctx.events.on('SETTINGS_UPDATED', (payload: unknown) => {
    const p = (payload || {}) as { key?: string };
    if (p.key !== 'activeChatId' && p.key !== 'activeCharacterId') return;
    void loadFor(ctx.getActiveChat().characterId ?? null);
  });

  // ─── Initial load (conditional) ──────────────────────────────────────
  // If Lumiverse already hydrated by the time setup() runs, kick the
  // load synchronously. Otherwise wait — the SETTINGS_UPDATED handler
  // above will fire as soon as activeChatId / activeCharacterId arrive.
  // We deliberately do NOT call loadFor(null) here: that would render
  // the "no character" branch (banner hidden, observer detached) which
  // is correct as a runtime cleanup but wrong as a setup-time default.
  const active = ctx.getActiveChat();
  console.log('[vishrun][step3] initial getActiveChat():', active);
  if (active.characterId) {
    void loadFor(active.characterId);
  } else {
    console.debug('[vishrun][step3] setup ran before chat hydration — waiting for SETTINGS_UPDATED');
  }

  return () => {
    unsubChatChanged();
    unsubSettingsUpdated();
    hooks.dispose();
    teardownIframeBridge();
    removeStyle();
    ctx.dom.cleanup();
    clearActiveCard();
  };
}
