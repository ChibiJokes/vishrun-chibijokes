import { api } from './common';

const LOG_PREFIX = '[vishrun:user-message]';
const FRONTEND_TIMEOUT_MS = 110_000;
const HOST_TIMEOUT_MS = 120_000;

interface UserMessageSubscriptionMessage {
  type: 'vsh_user_message_subscription';
  active: boolean;
}

interface UserMessageCompleteMessage {
  type: 'vsh_user_message_complete';
  requestId: string;
  content?: string;
  cancelGeneration?: boolean;
  removeMessage?: boolean;
  error?: string;
}

interface PendingRequest {
  userId: string;
  chatId: string;
  messageId: string;
  originalContent: string;
  resolve: (result: UserMessageCompleteMessage | null) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abortHandler?: () => void;
}

interface GenerationContext {
  chatId?: string;
  userId?: string;
  generationType?: string;
  dryRun?: boolean;
  cancelGeneration?: boolean;
  signal?: AbortSignal;
  [key: string]: unknown;
}

const subscribedUsers = new Set<string>();
const pendingRequests = new Map<string, PendingRequest>();

function isSubscriptionMessage(payload: unknown): payload is UserMessageSubscriptionMessage {
  return !!payload
    && typeof payload === 'object'
    && (payload as { type?: unknown }).type === 'vsh_user_message_subscription'
    && typeof (payload as { active?: unknown }).active === 'boolean';
}

function isCompleteMessage(payload: unknown): payload is UserMessageCompleteMessage {
  if (!payload || typeof payload !== 'object') return false;
  const value = payload as Record<string, unknown>;
  return value.type === 'vsh_user_message_complete'
    && typeof value.requestId === 'string'
    && (value.content === undefined || typeof value.content === 'string')
    && (value.cancelGeneration === undefined || typeof value.cancelGeneration === 'boolean')
    && (value.removeMessage === undefined || typeof value.removeMessage === 'boolean')
    && (value.error === undefined || typeof value.error === 'string');
}

function clearPending(requestId: string): PendingRequest | null {
  const pending = pendingRequests.get(requestId);
  if (!pending) return null;
  pendingRequests.delete(requestId);
  clearTimeout(pending.timer);
  if (pending.signal && pending.abortHandler) {
    pending.signal.removeEventListener('abort', pending.abortHandler);
  }
  return pending;
}

function releasePendingForUser(userId: string): void {
  for (const [requestId, pending] of pendingRequests) {
    if (pending.userId !== userId) continue;
    clearPending(requestId)?.resolve(null);
  }
}

async function findLatestUserMessage(chatId: string): Promise<{ id: string; content: string } | null> {
  const messages = await api.chat.getMessages(chatId);
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as { id?: unknown; role?: unknown; content?: unknown };
    if (message.role !== 'user' || typeof message.id !== 'string' || typeof message.content !== 'string') continue;
    return { id: message.id, content: message.content };
  }
  return null;
}

async function requestFrontendProcessing(
  context: GenerationContext,
  message: { id: string; content: string },
): Promise<UserMessageCompleteMessage | null> {
  const { chatId, userId, generationType, signal } = context;
  if (!chatId || !userId) return null;
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');

  const requestId = crypto.randomUUID();

  return new Promise<UserMessageCompleteMessage | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      const pending = clearPending(requestId);
      if (!pending) return;
      api.sendToFrontend({ type: 'vsh_user_message_cancel', requestId }, userId);
      console.warn(LOG_PREFIX, `frontend handler timed out after ${FRONTEND_TIMEOUT_MS}ms; using original message`);
      pending.resolve(null);
    }, FRONTEND_TIMEOUT_MS);

    const pending: PendingRequest = {
      userId,
      chatId,
      messageId: message.id,
      originalContent: message.content,
      resolve,
      timer,
      signal,
    };

    if (signal) {
      pending.abortHandler = () => {
        const active = clearPending(requestId);
        if (!active) return;
        api.sendToFrontend({ type: 'vsh_user_message_cancel', requestId }, userId);
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      };
      signal.addEventListener('abort', pending.abortHandler, { once: true });
    }

    pendingRequests.set(requestId, pending);
    api.sendToFrontend({
      type: 'vsh_user_message_request',
      requestId,
      chatId,
      message: { id: message.id, content: message.content },
      ...(generationType ? { generationType } : {}),
    }, userId);
  });
}

async function processGenerationContext(context: GenerationContext): Promise<GenerationContext> {
  const { chatId, userId, generationType, dryRun } = context;
  if (!chatId || !userId || dryRun || generationType !== 'normal' || !subscribedUsers.has(userId)) {
    return context;
  }

  const message = await findLatestUserMessage(chatId);
  if (!message) return context;

  const result = await requestFrontendProcessing(context, message);
  if (!result) return context;

  if (result.error) {
    console.warn(LOG_PREFIX, 'frontend handler reported an error:', result.error);
  }

  if (result.cancelGeneration) {
    if (result.removeMessage) {
      try {
        await api.chat.deleteMessage(chatId, message.id);
      } catch (error) {
        console.warn(LOG_PREFIX, 'failed to remove cancelled user message:', error instanceof Error ? error.message : String(error));
      }
    }
    return { ...context, cancelGeneration: true };
  }

  if (typeof result.content === 'string' && result.content !== message.content) {
    await api.chat.updateMessage(chatId, message.id, { content: result.content });
  }

  return context;
}

export function installUserMessageBridgeHandler(): void {
  api.onFrontendMessage((payload, userId) => {
    if (isSubscriptionMessage(payload)) {
      if (payload.active) {
        subscribedUsers.add(userId);
      } else {
        subscribedUsers.delete(userId);
        releasePendingForUser(userId);
      }
      return;
    }

    if (!isCompleteMessage(payload)) return;
    const pending = pendingRequests.get(payload.requestId);
    if (!pending || pending.userId !== userId) return;
    clearPending(payload.requestId)?.resolve(payload);
  });

  api.registerContextHandler(
    async (rawContext: unknown) => processGenerationContext(rawContext as GenerationContext),
    40,
    { timeoutMs: HOST_TIMEOUT_MS },
  );
}
