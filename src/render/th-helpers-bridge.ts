import type { SpindleFrontendContext, SpindleSandboxFrameHandle } from 'lumiverse-spindle-types';

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

  unsub = ctx.onBackendMessage((payload) => {
    if (!isThHelpersResponse(payload, requestId)) return;
    respond({ ok: payload.ok, result: payload.result, error: payload.error });
  });

  timer = setTimeout(() => {
    respond({ ok: false, error: 'th-helpers backend timeout' });
  }, TH_TIMEOUT_MS);

  try {
    ctx.sendToBackend({
      type: 'th_helpers_request',
      requestId,
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

// Compute the message's zero-based index_in_chat by DOM order of
// [data-message-id] elements. Returns -1 when the message element is
// not (yet) attached. Sync, O(n) over visible messages.
export function computeMessageIndexInChat(messageId: string, doc: Document = document): number {
  const all = doc.querySelectorAll('[data-message-id]');
  for (let i = 0; i < all.length; i++) {
    if (all[i].getAttribute('data-message-id') === messageId) return i;
  }
  return -1;
}
