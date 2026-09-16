import type { SpindleFrontendContext, SpindleSandboxFrameHandle } from 'lumiverse-spindle-types';

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export interface ChatVariableState {
  chatId: string;
  ready?: boolean;
  variables: Record<string, unknown>;
  allVariables: Record<string, unknown>;
}

export function chatVariableState(chatId: string, metadata: unknown): ChatVariableState {
  const meta = record(metadata);
  const macro = record(meta.macro_variables);
  const variables = record(meta.chat_variables);
  return { chatId, variables, allVariables: { ...record(macro.global), ...record(macro.local), ...variables } };
}

type Listener = (state: ChatVariableState) => void;
const listeners = new WeakMap<SpindleFrontendContext, Set<Listener>>();

// Coalesce concurrent reads for the same chat. A full historical render can
// create many iframes at once; they all need the same metadata snapshot.
// This is intentionally in-flight-only, not a persistent cache, so a later
// read after an edit/write still reaches Lumiverse for fresh metadata.
const chatVariableFetchInflight = new Map<string, Promise<ChatVariableState>>();

// The write response publishes before the caller's Promise resolves. Native
// CHAT_CHANGED handles macro writes and changes made outside Vishrun.
export function publishChatVariableState(ctx: SpindleFrontendContext, state: ChatVariableState): void {
  for (const listener of listeners.get(ctx) ?? []) {
    try { listener(state); } catch (err) { console.warn('[vishrun:variables]', err); }
  }
}

export function fetchChatVariableState(chatId: string): Promise<ChatVariableState> {
  if (!chatId) return Promise.resolve(chatVariableState('', {}));

  const existing = chatVariableFetchInflight.get(chatId);
  if (existing) return existing;

  const request = (async (): Promise<ChatVariableState> => {
    try {
      const response = await fetch(`/api/v1/chats/${encodeURIComponent(chatId)}`, {
        cache: 'no-store', credentials: 'same-origin',
      });
      if (!response.ok) throw new Error(`Chat variables could not be loaded (HTTP ${response.status})`);
      const chat = await response.json();
      return chatVariableState(chatId, chat?.metadata);
    } catch (err) {
      // A failed mirror read must not prevent unrelated widget/script code from
      // loading, nor let an updater replace persisted data with an empty bag.
      console.warn('[vishrun:variables]', err);
      return { ...chatVariableState(chatId, {}), ready: false };
    }
  })();

  chatVariableFetchInflight.set(chatId, request);
  void request.finally(() => {
    if (chatVariableFetchInflight.get(chatId) === request) {
      chatVariableFetchInflight.delete(chatId);
    }
  });
  return request;
}

export function bindChatVariableState(
  frame: SpindleSandboxFrameHandle,
  ctx: SpindleFrontendContext,
  initial: ChatVariableState,
  followsActiveChat: boolean,
): () => void {
  let state = initial;
  let epoch = 0;
  let destroyed = false;
  const deliver = () => {
    if (destroyed) return;
    try {
      const win = frame.element.contentWindow as (Window & {
        __vishrunSetChatVariables?: (state: ChatVariableState) => void;
      }) | null;
      if (typeof win?.__vishrunSetChatVariables === 'function') {
        win.__vishrunSetChatVariables(state);
        return;
      }
    } catch { /* sandbox bridge fallback */ }
    frame.postMessage({ type: 'vsh_chat_variables', state });
  };
  const accept = (next: ChatVariableState) => {
    if (next.chatId !== state.chatId) return;
    ++epoch;
    state = next;
    deliver();
  };
  const refresh = async () => {
    const currentEpoch = ++epoch;
    const chatId = state.chatId;
    try {
      const next = await fetchChatVariableState(chatId);
      if (!destroyed && next.ready !== false && currentEpoch === epoch && chatId === state.chatId) accept(next);
    } catch (err) { console.warn('[vishrun:variables]', err); }
  };
  let set = listeners.get(ctx);
  if (!set) listeners.set(ctx, set = new Set());
  set.add(accept);
  const changed = ctx.events.on('CHAT_CHANGED', (data: unknown) => {
    const payload = record(data);
    const chat = record(payload.chat);
    const id = chat.id ?? payload.chatId;
    if (id !== state.chatId) return;
    if (chat.metadata) accept(chatVariableState(state.chatId, chat.metadata));
    else void refresh();
  });
  const switchChat = () => {
    if (!followsActiveChat) return;
    const id = ctx.getActiveChat().chatId ?? '';
    if (id !== state.chatId) {
      ++epoch;
      state = { ...chatVariableState(id, {}), ready: false };
      deliver();
      void refresh();
    }
  };
  const settings = ctx.events.on('SETTINGS_UPDATED', (data: unknown) => {
    if (record(data).key === 'activeChatId') switchChat();
  });
  const switched = ctx.events.on('CHAT_SWITCHED', switchChat);
  // Re-deliver the latest state after srcdoc initializes, including events
  // received between createSandboxFrame and the iframe's load event.
  frame.element.addEventListener('load', deliver);
  // buildWidgetIframe already fetched this state before creating the frame.
  // Do not immediately issue the same GET once per iframe. If that initial
  // fetch failed (ready === false), retry in the background; later
  // CHAT_CHANGED / chat-switch events still refresh normally.
  if (initial.ready === false) void refresh();
  return () => {
    destroyed = true;
    ++epoch;
    set!.delete(accept);
    changed(); settings(); switched();
    frame.element.removeEventListener('load', deliver);
  };
}
