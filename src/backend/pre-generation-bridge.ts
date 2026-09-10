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

interface PreGenerationWorldInfoRequestMessage {
  type: 'vsh_pre_generation_world_info_request';
  requestId: string;
}

interface ActivatedWorldInfoSummary {
  id: string;
  comment?: string;
  keys?: string[];
  source?: string;
  score?: number;
  bookId?: string;
  bookSource?: string;
}

interface PendingRequest {
  userId: string;
  resolve: () => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abortHandler?: () => void;
  activatedWorldInfo: ActivatedWorldInfoSummary[];
}

export interface PreGenerationContext {
  chatId?: string;
  userId?: string;
  generationType?: string;
  activatedWorldInfo?: unknown;
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

function isWorldInfoRequestMessage(payload: unknown): payload is PreGenerationWorldInfoRequestMessage {
  return !!payload
    && typeof payload === 'object'
    && (payload as { type?: unknown }).type === 'vsh_pre_generation_world_info_request'
    && typeof (payload as { requestId?: unknown }).requestId === 'string';
}

function normalizeActivatedWorldInfo(value: unknown): ActivatedWorldInfoSummary[] {
  if (!Array.isArray(value)) return [];
  const out: ActivatedWorldInfoSummary[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const id = typeof raw.id === 'string' ? raw.id : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const entry: ActivatedWorldInfoSummary = { id };
    if (typeof raw.comment === 'string') entry.comment = raw.comment;
    if (Array.isArray(raw.keys)) entry.keys = raw.keys.filter((key): key is string => typeof key === 'string');
    if (typeof raw.source === 'string') entry.source = raw.source;
    if (typeof raw.score === 'number') entry.score = raw.score;
    if (typeof raw.bookId === 'string') entry.bookId = raw.bookId;
    if (typeof raw.bookSource === 'string') entry.bookSource = raw.bookSource;
    out.push(entry);
  }
  return out;
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

async function sendWorldInfoBodies(requestId: string, userId: string, pending: PendingRequest): Promise<void> {
  try {
    const results = await Promise.allSettled(
      pending.activatedWorldInfo.map(async activation => {
        const entry = await api.world_books.entries.get(activation.id, userId);
        if (!entry) throw new Error(`Active World Info entry ${activation.id} is unavailable`);
        if (typeof entry.content !== 'string' || !entry.content.trim()) {
          throw new Error(`Active World Info entry ${activation.id} has no readable content`);
        }
        return { ...entry, ...activation, content: entry.content };
      }),
    );

    if (!pendingRequests.has(requestId)) return;

    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length > 0) {
      api.sendToFrontend({
        type: 'vsh_pre_generation_world_info_result',
        requestId,
        entries: [],
        error: failures
          .map(result => result.reason instanceof Error ? result.reason.message : String(result.reason))
          .join('; '),
      }, userId);
      return;
    }

    api.sendToFrontend({
      type: 'vsh_pre_generation_world_info_result',
      requestId,
      entries: results
        .filter((result): result is PromiseFulfilledResult<Record<string, unknown>> => result.status === 'fulfilled')
        .map(result => result.value),
    }, userId);
  } catch (error) {
    if (!pendingRequests.has(requestId)) return;
    api.sendToFrontend({
      type: 'vsh_pre_generation_world_info_result',
      requestId,
      entries: [],
      error: error instanceof Error ? error.message : String(error),
    }, userId);
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

    if (isWorldInfoRequestMessage(payload)) {
      const pending = pendingRequests.get(payload.requestId);
      if (!pending || pending.userId !== userId) return;
      void sendWorldInfoBodies(payload.requestId, userId, pending);
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
  const activatedWorldInfo = normalizeActivatedWorldInfo(context.activatedWorldInfo);
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
      activatedWorldInfo,
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
      activatedWorldInfo,
    }, userId);
  });
}
