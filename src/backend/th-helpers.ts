import type { ChatMessageDTO, SpindleAPI } from 'lumiverse-spindle-types';
import { api } from './common';
import { computeVariablesSnapshot, emptyMvuData, type MvuData } from './mvu-parser';

const LOG_PREFIX = '[vishrun:th-helpers]';
const log = {
  warn: (...args: unknown[]) => console.warn(LOG_PREFIX, ...args),
  debug: (...args: unknown[]) => console.debug(LOG_PREFIX, ...args),
};

interface ThHelpersRequest {
  type: 'th_helpers_request';
  requestId: string;
  op: 'th-get-messages-snapshot' | 'th-set-chat-message' | 'th-create-chat-messages' | 'th-get-variables-snapshot' | 'th-set-variable' | 'th-replace-chat-variables';
  chatId: string;
  currentMessageId: string;
  currentMessageIndex: number;
  body: Record<string, unknown>;
}

interface ThHelpersResponse {
  type: 'th_helpers_response';
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

function isThHelpersRequest(p: unknown): p is ThHelpersRequest {
  if (!p || typeof p !== 'object') return false;
  const r = p as Record<string, unknown>;
  return (
    r.type === 'th_helpers_request' &&
    typeof r.requestId === 'string' &&
    typeof r.op === 'string' &&
    typeof r.chatId === 'string' &&
    typeof r.currentMessageId === 'string' &&
    typeof r.currentMessageIndex === 'number' &&
    !!r.body &&
    typeof r.body === 'object'
  );
}

function resolveRangeToIndex(
  range: unknown,
  total: number,
  currentMessageIndex: number,
): number | null {
  if (total === 0) return null;
  if (typeof range === 'number') {
    return range >= 0 ? range : total + range;
  }
  if (typeof range === 'string') {
    const trimmed = range.trim();
    if (trimmed === '' || trimmed === 'latest') return total - 1;
    if (trimmed === 'this') return currentMessageIndex;
    if (/^-?\d+$/.test(trimmed)) {
      const n = parseInt(trimmed, 10);
      return n >= 0 ? n : total + n;
    }
  }
  return null;
}

// Rich snapshot row: bakes both .message (active swipe content) and .swipes
// so the iframe-side shim can shape the JSR ChatMessage vs ChatMessageSwiped
// variants synchronously without round-tripping back to the backend.
export interface SnapshotMessage {
  /** Host UUID for the message row. Used by the widget-iframe build to
   * resolve the current iframe's hosting message to a snapshot array
   * position via id match — avoids the DOM-vs-DB index drift caused by
   * phantom DOM elements / hidden system rows / virtual-scroll
   * placeholders. The shim's `getCurrentMessageId()` does NOT expose
   * this UUID to cards; it returns the resolved numeric array index. */
  id: string;
  message_id: number;
  name: string;
  role: 'system' | 'user' | 'assistant';
  is_hidden: boolean;
  message: string;
  swipe_id: number;
  swipes: string[];
  data: Record<string, unknown>;
  extra: Record<string, unknown>;
}

const JSLR_DATA_EXTRA_KEY = '__vishrun_jslr_message_data_v1';

function shapeSnapshotMessage(
  msg: ChatMessageDTO & { role?: 'system' | 'user' | 'assistant'; extra?: Record<string, unknown> },
): SnapshotMessage {
  const role =
    msg.role === 'system' || msg.role === 'user' || msg.role === 'assistant'
      ? msg.role
      : msg.is_user
        ? 'user'
        : 'assistant';
  const swipes =
    Array.isArray(msg.swipes) && msg.swipes.length > 0 ? msg.swipes : [msg.content];
  const rawExtra = msg.extra ?? {};
  const storedData = rawExtra[JSLR_DATA_EXTRA_KEY];
  const data =
    storedData && typeof storedData === 'object' && !Array.isArray(storedData)
      ? { ...(storedData as Record<string, unknown>) }
      : {};
  const extra = { ...rawExtra };
  delete extra[JSLR_DATA_EXTRA_KEY];
  return {
    id: msg.id,
    message_id: msg.index_in_chat,
    name: msg.name,
    role,
    is_hidden: rawExtra.hidden === true,
    message: msg.content,
    swipe_id: msg.swipe_id ?? 0,
    swipes,
    data,
    extra,
  };
}

type ChatApi = SpindleAPI['chat'];
type ChatsApi = SpindleAPI['chats'];
type CharactersApi = SpindleAPI['characters'];

// Resolve a chat's greeting set (first_mes + alternate_greetings, in order)
// from the character metadata. Group greetings carry character_id on
// msg.extra; single-character chats fall back to the chat row. Empty array
// when unresolved. Shared by the initial-message swipes population and the
// variables-snapshot recovery below.
async function fetchCharacterGreetings(
  messages: ChatMessageDTO[],
  chatId: string,
  userId: string,
  chats: ChatsApi,
  characters: CharactersApi,
): Promise<string[]> {
  const msg0 = messages[0] as (ChatMessageDTO & { extra?: Record<string, unknown> }) | undefined;
  let charId: string | null = null;
  const fromExtra = msg0?.extra?.character_id;
  if (typeof fromExtra === 'string' && fromExtra.length > 0) {
    charId = fromExtra;
  } else {
    // userId is required: chats/characters are operator-scoped (host injects
    // userId as onFrontendMessage's 2nd arg).
    const chatDto = await chats.get(chatId, userId);
    if (chatDto && typeof chatDto.character_id === 'string') charId = chatDto.character_id;
  }
  if (!charId) return [];
  const card = await characters.get(charId, userId);
  if (!card) return [];
  const first = typeof card.first_mes === 'string' ? card.first_mes : '';
  const alt = Array.isArray(card.alternate_greetings) ? card.alternate_greetings : [];
  return [first, ...alt];
}

export async function handleGetMessagesSnapshot(
  chatId: string,
  userId: string,
  chat: ChatApi = api.chat,
  chats: ChatsApi = api.chats,
  characters: CharactersApi = api.characters,
): Promise<SnapshotMessage[]> {
  const messages = await chat.getMessages(chatId);
  const snapshot = messages.map((m) => shapeSnapshotMessage(m as ChatMessageDTO));
  // Initial greeting message: when the chat has not stored real swipe
  // alternatives yet (fresh chat), expose the full greeting set as swipes so
  // greeting-selection widgets can index into it, AND persist that array to
  // the DB so a later setChatMessage(swipe_id) validates against the same
  // length. A chat that already holds multiple swipes keeps them (no clobber).
  if (snapshot.length > 0 && snapshot[0].role !== 'user' && snapshot[0].swipes.length <= 1) {
    try {
      const greetings = await fetchCharacterGreetings(messages as ChatMessageDTO[], chatId, userId, chats, characters);
      if (greetings.length > 1) {
        // Keep the active slot equal to the currently displayed content so the
        // persist does not rewrite the visible greeting (macros, prior edits).
        const activeIdx = snapshot[0].swipe_id >= 0 && snapshot[0].swipe_id < greetings.length ? snapshot[0].swipe_id : 0;
        const aligned = greetings.slice();
        aligned[activeIdx] = snapshot[0].message;
        snapshot[0].swipes = aligned;
        try {
          // chat.updateMessage is not operator-scoped (owner derived from chatId,
          // like getMessages); auto-pads swipe_dates. Idempotent: the next read
          // sees length > 1 and skips. On failure the read still serves derived.
          await chat.updateMessage(chatId, (messages[0] as ChatMessageDTO).id, { swipes: aligned, swipe_id: activeIdx });
        } catch (persistErr) {
          log.warn('initial-message swipes persist failed (read serves derived):', persistErr instanceof Error ? persistErr.message : String(persistErr));
        }
      }
    } catch (err) {
      log.warn('initial-message swipes derive failed:', err instanceof Error ? err.message : String(err));
    }
  }
  return snapshot;
}

// Variables snapshot is computed by replaying all chat messages through
// the recognizer pipeline. Pure function of chat content — no persistence
// layer, swipe and edit fall out for free.
//
// We pass the raw DTOs (which include `swipes`, `swipe_id`) straight in;
// computeVariablesSnapshot resolves each message's active swipe via
// resolveActiveContent so swiping greeting 0 → greeting N is followed.
//
// Recovery: if message 0's active content has no <UpdateVariable> block
// (existing chat stripped under buggy code, imported chat, edited
// content), the lazy fetcher reads the card's greetings and lets the
// replay match by stripped-content hash.
export async function handleGetVariablesSnapshot(
  chatId: string,
  userId: string,
  chat: ChatApi = api.chat,
  chats: ChatsApi = api.chats,
  characters: CharactersApi = api.characters,
): Promise<MvuData> {
  try {
    const messages = await chat.getMessages(chatId);
    return await computeVariablesSnapshot(messages, () =>
      fetchCharacterGreetings(messages as ChatMessageDTO[], chatId, userId, chats, characters),
    );
  } catch (err) {
    log.warn('getVariablesSnapshot failed:', err instanceof Error ? err.message : String(err));
    return emptyMvuData();
  }
}

interface ChatMessageCreatingCompat {
  name?: string;
  role: 'system' | 'assistant' | 'user';
  is_hidden?: boolean;
  message: string;
  data?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

interface CreateChatMessagesCompatOptions {
  insert_at?: number | 'end';
  insert_before?: number | 'end';
  refresh?: 'none' | 'affected' | 'all';
}

export async function handleCreateChatMessages(
  body: Record<string, unknown>,
  chatId: string,
  chat: ChatApi = api.chat,
): Promise<{ created: Array<{ id: string; message_id: number }> }> {
  const rawMessages = body.chatMessages;
  if (!Array.isArray(rawMessages)) throw new TypeError('chat_messages must be an array');

  const messages: ChatMessageCreatingCompat[] = rawMessages.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new TypeError(`chat_messages[${index}] must be an object`);
    }
    const item = raw as Record<string, unknown>;
    if (item.role !== 'system' && item.role !== 'assistant' && item.role !== 'user') {
      throw new TypeError(`chat_messages[${index}].role must be system, assistant, or user`);
    }
    if (typeof item.message !== 'string') {
      throw new TypeError(`chat_messages[${index}].message must be a string`);
    }
    if (item.name !== undefined && typeof item.name !== 'string') {
      throw new TypeError(`chat_messages[${index}].name must be a string`);
    }
    if (item.is_hidden !== undefined && typeof item.is_hidden !== 'boolean') {
      throw new TypeError(`chat_messages[${index}].is_hidden must be a boolean`);
    }
    if (item.data !== undefined && (!item.data || typeof item.data !== 'object' || Array.isArray(item.data))) {
      throw new TypeError(`chat_messages[${index}].data must be an object`);
    }
    if (item.extra !== undefined && (!item.extra || typeof item.extra !== 'object' || Array.isArray(item.extra))) {
      throw new TypeError(`chat_messages[${index}].extra must be an object`);
    }
    return item as unknown as ChatMessageCreatingCompat;
  });

  const rawOptions = body.options;
  const options: CreateChatMessagesCompatOptions =
    rawOptions && typeof rawOptions === 'object' && !Array.isArray(rawOptions)
      ? (rawOptions as CreateChatMessagesCompatOptions)
      : {};
  if (options.refresh !== undefined && options.refresh !== 'none' && options.refresh !== 'affected' && options.refresh !== 'all') {
    throw new TypeError('refresh must be none, affected, or all');
  }

  // JSLR can splice into SillyTavern's in-memory chat array. Lumiverse's
  // public Spindle mutation API deliberately exposes append-only creation;
  // there is no safe indexed-insert primitive to mirror without rewriting
  // existing persisted rows. Accept every request that resolves to the end
  // and reject true mid-history insertion rather than silently doing the wrong thing.
  const before = options.insert_at ?? options.insert_before ?? 'end';
  if (before !== 'end') {
    if (typeof before !== 'number' || !Number.isFinite(before)) {
      throw new TypeError('insert_before must be a number or end');
    }
    const existing = await chat.getMessages(chatId);
    const clamped = Math.max(-existing.length, Math.min(existing.length, Math.trunc(before)));
    if (clamped !== existing.length) {
      throw new Error('Lumiverse does not expose safe indexed message insertion; createChatMessages currently supports insert_before/insert_at only when it resolves to the end');
    }
  }

  const ids: string[] = [];
  for (const message of messages) {
    const created = await chat.appendMessage(chatId, { role: message.role, content: message.message });
    ids.push(created.id);
  }

  if (ids.length === 0) return { created: [] };
  const current = await chat.getMessages(chatId);
  const indexById = new Map<string, number>();
  for (const message of current) indexById.set(message.id, message.index_in_chat);
  return {
    created: ids.map((id, index) => ({
      id,
      message_id: indexById.get(id) ?? (current.length - ids.length + index),
    })),
  };
}

export async function handleSetChatMessage(
  body: Record<string, unknown>,
  chatId: string,
  currentMessageIndex: number,
  chat: ChatApi = api.chat,
): Promise<void> {
  const fieldValues = (body.fieldValues as Record<string, unknown> | undefined) ?? {};
  const messageRange = body.messageId;

  const messages = await chat.getMessages(chatId);
  if (messages.length === 0) {
    log.warn('setChatMessage: empty chat, ignoring');
    return;
  }

  const idx = resolveRangeToIndex(messageRange, messages.length, currentMessageIndex);
  if (idx === null || idx < 0 || idx >= messages.length) {
    log.warn('setChatMessage: unresolved message index', messageRange);
    return;
  }

  const target = messages[idx] as ChatMessageDTO;
  const content = typeof fieldValues.message === 'string' ? fieldValues.message : undefined;
  if (typeof content !== 'string') {
    log.warn('setChatMessage: no message string in fieldValues, ignoring');
    return;
  }

  // Send { content } only and ignore opts.swipe_id. The native greeting
  // selector also writes { content } without swipe_id, so the host
  // overwrites swipes[existing.swipe_id]. Keeping swipe_id at 0 lets
  // both writers cooperate on slot 0 without corrupting other slots.
  await chat.updateMessage(chatId, target.id, { content });
}

export async function handleSetVariable(
  body: Record<string, unknown>,
  chatId: string,
  chat: ChatApi = api.chat,
): Promise<void> {
  const key = body.key as string | undefined;
  const value = body.value;
  if (!key) {
    log.warn('setVariable: no key provided, ignoring');
    return;
  }

  const messages = await chat.getMessages(chatId);
  if (messages.length === 0) {
    log.warn('setVariable: empty chat, ignoring');
    return;
  }

  // Write the variable into the latest non-system message's content
  // by appending an UpdateVariable block, following MVU convention.
  const latest = messages[messages.length - 1] as ChatMessageDTO;
  const existing = (latest as Record<string, unknown>).content as string ?? '';
  const varBlock = `\n<UpdateVariable>\n${key}: ${JSON.stringify(value)}\n</UpdateVariable>`;
  await chat.updateMessage(chatId, latest.id, { content: existing + varBlock });
  log.debug('setVariable: set', key, '=', value);
}

// Serialize Vishrun's replacements per user/chat so unrelated metadata is read
// immediately before each save, not captured when an iframe was constructed.
const variableWrites = new Map<string, Promise<unknown>>();
export function handleReplaceChatVariables(
  body: Record<string, unknown>, chatId: string, userId: string,
  chats: ChatsApi = api.chats,
): Promise<{ chatId: string; variables: Record<string, unknown>; allVariables: Record<string, unknown> }> {
  const key = JSON.stringify([userId, chatId]);
  const work = (variableWrites.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
    if (!chatId || body.chatId !== chatId) throw new Error('Chat variable target does not match the requesting frame');
    const variables = body.variables;
    if (!variables || typeof variables !== 'object' || Array.isArray(variables)) {
      throw new TypeError('Variables must be an object');
    }
    const current = await chats.get(chatId, userId);
    if (!current) throw new Error('Chat not found');
    const updated = await chats.update(chatId, {
      metadata: { ...current.metadata, chat_variables: variables },
    }, userId);
    if (!updated) throw new Error('Chat variable save failed');
    const meta = updated.metadata ?? {};
    const macro = (meta.macro_variables ?? {}) as Record<string, Record<string, unknown>>;
    const saved = (meta.chat_variables ?? {}) as Record<string, unknown>;
    return { chatId, variables: saved, allVariables: { ...macro.global, ...macro.local, ...saved } };
  });
  variableWrites.set(key, work);
  void work.finally(() => {
    if (variableWrites.get(key) === work) variableWrites.delete(key);
  }).catch(() => {});
  return work;
}

export function installThHelpersHandler(): void {
  api.onFrontendMessage((payload, userId) => {
    if (!isThHelpersRequest(payload)) return;
    const { requestId, op, chatId, currentMessageIndex, body } = payload;
    void (async () => {
      let response: ThHelpersResponse;
      try {
        if (op === 'th-get-messages-snapshot') {
          const result = await handleGetMessagesSnapshot(chatId, userId);
          response = { type: 'th_helpers_response', requestId, ok: true, result };
        } else if (op === 'th-get-variables-snapshot') {
          const result = await handleGetVariablesSnapshot(chatId, userId);
          response = { type: 'th_helpers_response', requestId, ok: true, result };
        } else if (op === 'th-set-chat-message') {
          await handleSetChatMessage(body, chatId, currentMessageIndex);
          response = { type: 'th_helpers_response', requestId, ok: true, result: undefined };
        } else if (op === 'th-create-chat-messages') {
          const result = await handleCreateChatMessages(body, chatId);
          response = { type: 'th_helpers_response', requestId, ok: true, result };
        } else if (op === 'th-replace-chat-variables') {
          const result = await handleReplaceChatVariables(body, chatId, userId);
          response = { type: 'th_helpers_response', requestId, ok: true, result };
        } else if (op === 'th-set-variable') {
          await handleSetVariable(body, chatId);
          response = { type: 'th_helpers_response', requestId, ok: true, result: undefined };
        } else {
          response = {
            type: 'th_helpers_response',
            requestId,
            ok: false,
            error: 'unknown op: ' + String(op),
          };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn('handler threw for op', op, msg);
        response = { type: 'th_helpers_response', requestId, ok: false, error: msg };
      }
      api.sendToFrontend(response, userId);
    })();
  });
}
