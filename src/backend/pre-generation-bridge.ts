import { api } from './common';

const LOG_PREFIX = '[vishrun:pre-generation]';
const PRE_GENERATION_TIMEOUT_MS = 90_000;

interface PreGenerationSubscriptionMessage {
  type: 'vsh_pre_generation_subscription';
  active: boolean;
}

interface PreGenerationCompleteMessage {
  type: 'vsh_pre_generation_complete';
  requestId: string;
  error?: string;
}

interface PendingRequest {
  userId: string;
  resolve: () => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abortHandler?: () => void;
}

export interface PreGenerationContext {
  chatId?: string;
  userId?: string;
  generationType?: string;
  signal?: AbortSignal;
}

const subscribedUsers = new Set<string>();
const pendingRequests = new Map<string, PendingRequest>();

function isSubscriptionMessage(payload: unknown): payload is PreGenerationSubscriptionMessage {
  return !!payload
    && typeof payload === 'object'
    && (payload as { type?: unknown }).type === 'vsh_pre_generation_subscription'
    && typeof (payload as { active?: unknown }).active === 'boolean';
}

function isCompleteMessage(payload: unknown): payload is PreGenerationCompleteMessage {
  return !!payload
    && typeof payload === 'object'
    && (payload as { type?: unknown }).type === 'vsh_pre_generation_complete'
    && typeof (payload as { requestId?: unknown }).requestId === 'string';
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
    clearPending(requestId)?.resolve();
  }
}

export function installPreGenerationBridgeHandler(): void {
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

    clearPending(payload.requestId)?.resolve();

    if (payload.error) {
      console.warn(LOG_PREFIX, 'frontend handler reported an error:', payload.error);
    }
  });
}

export async function waitForPreGeneration(context: PreGenerationContext): Promise<void> {
  const { chatId, userId, generationType, signal } = context;
  if (!chatId || !userId || !subscribedUsers.has(userId)) return;

  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  }

  const requestId = crypto.randomUUID();

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      const pending = clearPending(requestId);
      if (!pending) return;
      api.sendToFrontend({ type: 'vsh_pre_generation_cancel', requestId }, userId);
      console.warn(LOG_PREFIX, `frontend handler timed out after ${PRE_GENERATION_TIMEOUT_MS}ms`);
      pending.resolve();
    }, PRE_GENERATION_TIMEOUT_MS);

    const pending: PendingRequest = {
      userId,
      resolve,
      reject,
      timer,
      signal,
    };

    if (signal) {
      pending.abortHandler = () => {
        const active = clearPending(requestId);
        if (!active) return;
        api.sendToFrontend({ type: 'vsh_pre_generation_cancel', requestId }, userId);
        active.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      };
      signal.addEventListener('abort', pending.abortHandler, { once: true });
    }

    pendingRequests.set(requestId, pending);

    api.sendToFrontend({
      type: 'vsh_pre_generation_request',
      requestId,
      chatId,
      ...(generationType ? { generationType } : {}),
    }, userId);
  });
}
