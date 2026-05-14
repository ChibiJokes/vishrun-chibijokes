// TS twin of the ES5 shim string that lives in widget-iframe.ts as
// `thHelpersShim()`. Mirror the logic in both — the twin is testable
// with happy-dom, the string runs inside the sandbox iframe.

export interface ThHelpersBridge {
  postRequest(kind: string, payload: Record<string, unknown>): Promise<unknown>;
}

export interface ThHelpersConstants {
  currentMessageIndex: number;
  currentMessageId: string;
  chatId: string;
}

export interface ThHelpersHandle {
  getCurrentMessageId(): number;
  getChatId(): string;
  getChatMessages(range: string | number, opts?: Record<string, unknown>): Promise<unknown>;
  setChatMessage(
    fieldValues: string | Record<string, unknown>,
    messageId: number | string,
    opts?: Record<string, unknown>,
  ): Promise<void>;
}

export function createThHelpers(
  consts: ThHelpersConstants,
  bridge: ThHelpersBridge,
): ThHelpersHandle {
  return {
    getCurrentMessageId(): number {
      return consts.currentMessageIndex;
    },
    getChatId(): string {
      return consts.chatId;
    },
    async getChatMessages(range, opts) {
      const result = await bridge.postRequest('th-get-chat-messages', {
        range,
        opts: opts ?? {},
      });
      return result;
    },
    async setChatMessage(fieldValues, messageId, opts) {
      const normalized =
        typeof fieldValues === 'string' ? { message: fieldValues } : fieldValues;
      await bridge.postRequest('th-set-chat-message', {
        fieldValues: normalized,
        messageId,
        opts: opts ?? {},
      });
    },
  };
}

// ES5 shim string injected into the iframe srcdoc head. The host-side
// frontend module routes 'th-request' postMessages to backend via
// ctx.sendToBackend and forwards backend responses back to the iframe
// via frame.postMessage with kind 'th-response'.
export function thHelpersShim(consts: ThHelpersConstants): string {
  const constsJson = JSON.stringify({
    currentMessageIndex: consts.currentMessageIndex,
    currentMessageId: consts.currentMessageId,
    chatId: consts.chatId,
  });
  return `<script>(function(){
var THC = ${constsJson};
var pending = {};
var nextId = 0;
function makeRequestId(){ nextId = (nextId + 1) | 0; return 'th-' + Date.now().toString(36) + '-' + nextId.toString(36); }
function setup(){
  if (!window.spindleSandbox || typeof window.spindleSandbox.onMessage !== 'function') return;
  window.spindleSandbox.onMessage(function(payload){
    if (!payload || typeof payload !== 'object') return;
    if (payload.kind !== 'th-response') return;
    var rid = payload.requestId;
    var slot = pending[rid];
    if (!slot) return;
    delete pending[rid];
    if (payload.ok) slot.resolve(payload.result);
    else slot.reject(new Error(String(payload.error || 'th-helpers backend error')));
  });
}
setup();
function postRequest(kind, body){
  return new Promise(function(resolve, reject){
    if (!window.spindleSandbox || typeof window.spindleSandbox.postMessage !== 'function') {
      reject(new Error('spindleSandbox.postMessage unavailable'));
      return;
    }
    var rid = makeRequestId();
    pending[rid] = { resolve: resolve, reject: reject };
    try {
      window.spindleSandbox.postMessage({ kind: 'th-request', requestId: rid, op: kind, body: body });
    } catch (e) {
      delete pending[rid];
      reject(e);
    }
  });
}
window.getCurrentMessageId = function(){ return THC.currentMessageIndex; };
window.getChatId = function(){ return THC.chatId; };
window.getChatMessages = function(range, opts){
  return postRequest('th-get-chat-messages', { range: range, opts: opts || {} });
};
window.setChatMessage = function(fieldValues, messageId, opts){
  var normalized = (typeof fieldValues === 'string') ? { message: fieldValues } : fieldValues;
  return postRequest('th-set-chat-message', { fieldValues: normalized, messageId: messageId, opts: opts || {} });
};
})();</script>`;
}
