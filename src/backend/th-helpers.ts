import type { ChatMessageDTO, SpindleAPI } from 'lumiverse-spindle-types';
import { api } from './common';

const LOG_PREFIX = '[vishrun:th-helpers]';
const log = {
  warn: (...args: unknown[]) => console.warn(LOG_PREFIX, ...args),
  debug: (...args: unknown[]) => console.debug(LOG_PREFIX, ...args),
};

interface ThHelpersRequest {
  type: 'th_helpers_request';
  requestId: string;
  op: 'th-get-messages-snapshot' | 'th-set-chat-message';
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
  return {
    message_id: msg.index_in_chat,
    name: msg.name,
    role,
    is_hidden: false,
    message: msg.content,
    swipe_id: msg.swipe_id ?? 0,
    swipes,
    data: {},
    extra: msg.extra ?? {},
  };
}

type ChatApi = SpindleAPI['chat'];

export async function handleGetMessagesSnapshot(
  chatId: string,
  chat: ChatApi = api.chat,
): Promise<SnapshotMessage[]> {
  const messages = await chat.getMessages(chatId);
  return messages.map((m) => shapeSnapshotMessage(m as ChatMessageDTO));
}

export async function handleSetChatMessage(
  body: Record<string, unknown>,
  chatId: string,
  currentMessageIndex: number,
  chat: ChatApi = api.chat,
): Promise<void> {
  const fieldValues = (body.fieldValues as Record<string, unknown> | undefined) ?? {};
  const opts = (body.opts as Record<string, unknown> | undefined) ?? {};
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

  const patch: { content: string; swipe_id?: number } = { content };
  const optsSwipeId = opts.swipe_id;
  if (typeof optsSwipeId === 'number') {
    patch.swipe_id = optsSwipeId;
  }

  await chat.updateMessage(chatId, target.id, patch);
}

export function installThHelpersHandler(): void {
  api.onFrontendMessage((payload, userId) => {
    if (!isThHelpersRequest(payload)) return;
    const { requestId, op, chatId, currentMessageIndex, body } = payload;
    void (async () => {
      let response: ThHelpersResponse;
      try {
        if (op === 'th-get-messages-snapshot') {
          const result = await handleGetMessagesSnapshot(chatId);
          response = { type: 'th_helpers_response', requestId, ok: true, result };
        } else if (op === 'th-set-chat-message') {
          await handleSetChatMessage(body, chatId, currentMessageIndex);
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
