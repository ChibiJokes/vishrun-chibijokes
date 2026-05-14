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
  op: 'th-get-chat-messages' | 'th-set-chat-message';
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

// Resolve a JSR-style range argument ('0', '-1', 'latest', 0, etc.) to a
// zero-based index into the chat messages array. Returns null when the
// input doesn't make sense for our acotado set of supported call shapes.
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

function shapeMessage(
  msg: ChatMessageDTO & { role?: string; extra?: Record<string, unknown> },
  includeSwipes: boolean,
): Record<string, unknown> {
  const role = typeof msg.role === 'string' ? msg.role : msg.is_user ? 'user' : 'assistant';
  const base: Record<string, unknown> = {
    message_id: msg.index_in_chat,
    name: msg.name,
    role,
    is_hidden: false,
  };
  if (includeSwipes) {
    base.swipe_id = msg.swipe_id ?? 0;
    base.swipes = Array.isArray(msg.swipes) && msg.swipes.length > 0 ? msg.swipes : [msg.content];
    base.swipes_data = (base.swipes as string[]).map(() => ({}));
    base.swipes_info = (base.swipes as string[]).map(() => ({}));
  } else {
    base.message = msg.content;
    base.data = {};
    base.extra = msg.extra ?? {};
  }
  return base;
}

type ChatApi = SpindleAPI['chat'];

export async function handleGetChatMessages(
  body: Record<string, unknown>,
  chatId: string,
  currentMessageIndex: number,
  chat: ChatApi = api.chat,
): Promise<unknown[]> {
  const range = body.range;
  const opts = (body.opts as Record<string, unknown> | undefined) ?? {};
  const includeSwipes = opts.include_swipe === true || opts.include_swipes === true;

  const messages = await chat.getMessages(chatId);
  const total = messages.length;
  if (total === 0) return [];

  const idx = resolveRangeToIndex(range, total, currentMessageIndex);
  if (idx === null) {
    log.debug('getChatMessages: unsupported range', range);
    return [];
  }
  if (idx < 0 || idx >= total) return [];

  return [shapeMessage(messages[idx] as ChatMessageDTO, includeSwipes)];
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
        if (op === 'th-get-chat-messages') {
          const result = await handleGetChatMessages(body, chatId, currentMessageIndex);
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
