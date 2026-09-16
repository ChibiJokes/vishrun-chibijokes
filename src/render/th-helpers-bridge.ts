import { publishChatVariableState, type ChatVariableState } from './chat-variable-state';
import type { SpindleFrontendContext, SpindleSandboxFrameHandle } from 'lumiverse-spindle-types';
import type { SnapshotMessage } from '../backend/th-helpers';
import { emptyMvuData, type MvuData } from '../backend/mvu-parser';

const TH_TIMEOUT_MS = 5000;

interface ThRequestFromIframe {
  kind: 'th-request';
  requestId: string;
  op: string;
  body: Record<string, unknown>;
}

interface ThHelpersResponse {
  type: 'th_helpers_response';
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

function isThHelpersResponse(p: unknown, requestId: string): p is ThHelpersResponse {
  if (!p || typeof p !== 'object') return false;
  const r = p as Record<string, unknown>;
  return r.type === 'th_helpers_response' && r.requestId === requestId && typeof r.ok === 'boolean';
}

export function isThRequest(p: unknown): p is ThRequestFromIframe {
  if (!p || typeof p !== 'object') return false;
  const r = p as Record<string, unknown>;
  return (
    r.kind === 'th-request' &&
    typeof r.requestId === 'string' &&
    typeof r.op === 'string' &&
    !!r.body &&
    typeof r.body === 'object'
  );
}

let backendRequestCounter = 0;
function nextBackendRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `vishrun-th-${Date.now()}-${++backendRequestCounter}`;
}

// A large chat can build hundreds of scripted widgets in the same render pass.
// Astra's executable-widget fallback intentionally gives all of them the
// helpers shim, so without coalescing each iframe would request the same full
// chat snapshot independently. Keep only the request that is currently in
// flight. The entry is removed as soon as it settles, so later edits/swipes
// still fetch fresh state instead of reusing a stale cache.
const messagesSnapshotInflight = new Map<string, Promise<SnapshotMessage[]>>();
const variablesSnapshotInflight = new Map<string, Promise<MvuData>>();

function coalesceInflight<T>(
  map: Map<string, Promise<T>>,
  key: string,
  factory: () => Promise<T>,
): Promise<T> {
  const existing = map.get(key);
  if (existing) return existing;

  const request = factory();
  map.set(key, request);
  void request.finally(() => {
    if (map.get(key) === request) map.delete(key);
  });
  return request;
}

export function dispatchThRequest(
  frame: SpindleSandboxFrameHandle,
  request: ThRequestFromIframe,
  context: {
    chatId: string;
    currentMessageId: string;
    currentMessageIndex: number;
  },
  ctx: SpindleFrontendContext,
): void {
  const { requestId, op, body } = request;
  const backendRequestId = op === 'th-replace-chat-variables' ? nextBackendRequestId() : requestId;
  let settled = false;
  let unsub: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const respond = (resp: { ok: boolean; result?: unknown; error?: string }): void => {
    if (settled) return;
    settled = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (unsub) {
      try { unsub(); } catch { /* ignore */ }
      unsub = null;
    }
    try {
      frame.postMessage({ kind: 'th-response', requestId, ok: resp.ok, result: resp.result, error: resp.error });
    } catch {
      /* iframe gone — drop */
    }
  };

  if (op === 'th-replace-chat-variables' && (
    body.chatId !== context.chatId ||
    (typeof ctx.getActiveChat === 'function' && ctx.getActiveChat().chatId !== context.chatId)
  )) {
    respond({ ok: false, error: 'The chat changed before the variable update was dispatched' });
    return;
  }

  unsub = ctx.onBackendMessage((payload) => {
    if (!isThHelpersResponse(payload, backendRequestId)) return;
    if (payload.ok && op === 'th-replace-chat-variables') {
      publishChatVariableState(ctx, payload.result as ChatVariableState);
    }
    respond({ ok: payload.ok, result: payload.result, error: payload.error });
  });

  timer = setTimeout(() => {
    respond({ ok: false, error: 'th-helpers backend timeout' });
  }, TH_TIMEOUT_MS);

  try {
    ctx.sendToBackend({
      type: 'th_helpers_request',
      requestId: backendRequestId,
      op,
      chatId: context.chatId,
      currentMessageId: context.currentMessageId,
      currentMessageIndex: context.currentMessageIndex,
      body,
    });
  } catch (err) {
    respond({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

// Host-initiated pre-fetch: invoked once per iframe build (when env is
// tavern-helpers-light or higher) to bake a synchronous chat snapshot
// into the iframe shim. Cards call getChatMessages() synchronously per
// the JSR contract; the iframe can't await a postMessage round-trip
// inside a sync callback, so we resolve the data up front.
export function fetchMessagesSnapshot(
  context: {
    chatId: string;
    currentMessageId: string;
    currentMessageIndex: number;
  },
  ctx: SpindleFrontendContext,
  timeoutMs: number = TH_TIMEOUT_MS,
): Promise<SnapshotMessage[]> {
  if (!context.chatId) {
    return fetchMessagesSnapshotUncoalesced(context, ctx, timeoutMs);
  }
  return coalesceInflight(
    messagesSnapshotInflight,
    context.chatId,
    () => fetchMessagesSnapshotUncoalesced(context, ctx, timeoutMs),
  );
}

function fetchMessagesSnapshotUncoalesced(
  context: {
    chatId: string;
    currentMessageId: string;
    currentMessageIndex: number;
  },
  ctx: SpindleFrontendContext,
  timeoutMs: number,
): Promise<SnapshotMessage[]> {
  return new Promise((resolve) => {
    const requestId = nextBackendRequestId();
    let settled = false;
    let unsub: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (value: SnapshotMessage[]): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (unsub) {
        try { unsub(); } catch { /* ignore */ }
        unsub = null;
      }
      resolve(value);
    };

    unsub = ctx.onBackendMessage((payload) => {
      if (!isThHelpersResponse(payload, requestId)) return;
      if (payload.ok && Array.isArray(payload.result)) {
        finish(payload.result as SnapshotMessage[]);
      } else {
        // Fallback to empty snapshot so the iframe still loads (cards
        // see getChatMessages() === []), and log so the failure is visible.
        console.warn(
          '[vishrun:th-helpers] messages snapshot fetch failed:',
          payload.ok ? 'malformed result' : payload.error || 'unknown error',
        );
        finish([]);
      }
    });

    timer = setTimeout(() => {
      console.warn('[vishrun:th-helpers] messages snapshot fetch timed out');
      finish([]);
    }, timeoutMs);

    try {
      ctx.sendToBackend({
        type: 'th_helpers_request',
        requestId,
        op: 'th-get-messages-snapshot',
        chatId: context.chatId,
        currentMessageId: context.currentMessageId,
        currentMessageIndex: context.currentMessageIndex,
        body: {},
      });
    } catch (err) {
      console.warn(
        '[vishrun:th-helpers] sendToBackend threw:',
        err instanceof Error ? err.message : String(err),
      );
      finish([]);
    }
  });
}

// Companion to fetchMessagesSnapshot for tavern-mvu iframes: reads the
// chat-scoped MVU blob and resolves with the {stat_data, ...} shape the
// shim bakes as `window.getAllVariables()`. Same fallback contract as
// fetchMessagesSnapshot — empty MvuData if backend fails / times out,
// so iframes still load with `getAllVariables()` returning an empty
// stat_data rather than throwing.
export function fetchVariablesSnapshot(
  context: {
    chatId: string;
    currentMessageId: string;
    currentMessageIndex: number;
  },
  ctx: SpindleFrontendContext,
  timeoutMs: number = TH_TIMEOUT_MS,
): Promise<MvuData> {
  if (!context.chatId) {
    return fetchVariablesSnapshotUncoalesced(context, ctx, timeoutMs);
  }
  return coalesceInflight(
    variablesSnapshotInflight,
    context.chatId,
    () => fetchVariablesSnapshotUncoalesced(context, ctx, timeoutMs),
  );
}

function fetchVariablesSnapshotUncoalesced(
  context: {
    chatId: string;
    currentMessageId: string;
    currentMessageIndex: number;
  },
  ctx: SpindleFrontendContext,
  timeoutMs: number,
): Promise<MvuData> {
  return new Promise((resolve) => {
    const requestId = nextBackendRequestId();
    let settled = false;
    let unsub: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (value: MvuData): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (unsub) {
        try { unsub(); } catch { /* ignore */ }
        unsub = null;
      }
      resolve(value);
    };

    unsub = ctx.onBackendMessage((payload) => {
      if (!isThHelpersResponse(payload, requestId)) return;
      if (payload.ok && payload.result && typeof payload.result === 'object' && !Array.isArray(payload.result)) {
        const r = payload.result as MvuData;
        if (r.stat_data && typeof r.stat_data === 'object') {
          finish(r);
          return;
        }
      }
      console.warn(
        '[vishrun:th-helpers] variables snapshot fetch failed:',
        payload.ok ? 'malformed result' : payload.error || 'unknown error',
      );
      finish(emptyMvuData());
    });

    timer = setTimeout(() => {
      console.warn('[vishrun:th-helpers] variables snapshot fetch timed out');
      finish(emptyMvuData());
    }, timeoutMs);

    try {
      ctx.sendToBackend({
        type: 'th_helpers_request',
        requestId,
        op: 'th-get-variables-snapshot',
        chatId: context.chatId,
        currentMessageId: context.currentMessageId,
        currentMessageIndex: context.currentMessageIndex,
        body: {},
      });
    } catch (err) {
      console.warn(
        '[vishrun:th-helpers] sendToBackend threw:',
        err instanceof Error ? err.message : String(err),
      );
      finish(emptyMvuData());
    }
  });
}

export function computeMessageIndexInChat(messageId: string, doc: Document = document): number {
  const all = doc.querySelectorAll('[data-message-id]');
  for (let i = 0; i < all.length; i++) {
    if (all[i].getAttribute('data-message-id') === messageId) return i;
  }
  return -1;
}
