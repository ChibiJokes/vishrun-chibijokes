import { lodashShim } from './lodash-shim';
import { chatVariablesShim } from './chat-variables-shim';
import type { SnapshotMessage } from '../backend/th-helpers';

// TS twin of the ES5 shim string in thHelpersShim() below. The twin is
// testable with happy-dom; the string runs in the sandbox iframe.
// getChatMessages and the two id helpers are sync per the JSR contract;
// setChatMessage stays async via the backend round-trip.

export interface ThHelpersBridge {
  postRequest(kind: string, payload: Record<string, unknown>): Promise<unknown>;
}

export interface ThHelpersConstants {
  currentMessageIndex: number;
  currentMessageId: string;
  chatId: string;
  messagesSnapshot: SnapshotMessage[];
  variablesChatId?: string;
  variablesSnapshot?: Record<string, unknown>;
  chatVariablesSnapshot?: Record<string, unknown>;
}

export interface ChatMessageNonSwiped {
  message_id: number;
  name: string;
  role: 'system' | 'user' | 'assistant';
  is_hidden: boolean;
  message: string;
  // swipe_id/swipes carried on the default shape too: cards read .swipes
  // without passing include_swipes (the strict JSR split is stricter than
  // the live ST runtime, where message objects carry swipes regardless).
  swipe_id: number;
  swipes: string[];
  data: Record<string, unknown>;
  extra: Record<string, unknown>;
}

export interface ChatMessageSwiped {
  message_id: number;
  name: string;
  role: 'system' | 'user' | 'assistant';
  is_hidden: boolean;
  swipe_id: number;
  swipes: string[];
  swipes_data: Record<string, unknown>[];
  swipes_info: Record<string, unknown>[];
}

export interface ChatMessageCreating {
  name?: string;
  role: 'system' | 'assistant' | 'user';
  is_hidden?: boolean;
  message: string;
  data?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

export interface CreateChatMessagesOption {
  /** @deprecated JSLR keeps this as an alias of insert_before. */
  insert_at?: number | 'end';
  insert_before?: number | 'end';
  refresh?: 'none' | 'affected' | 'all';
}

export interface ThHelpersHandle {
  getCurrentMessageId(): number;
  getChatId(): string;
  getChatMessages(
    range: string | number,
    opts?: Record<string, unknown>,
  ): Array<ChatMessageNonSwiped | ChatMessageSwiped>;
  setChatMessage(
    fieldValues: string | Record<string, unknown>,
    messageId: number | string,
    opts?: Record<string, unknown>,
  ): Promise<void>;
  createChatMessages(
    chatMessages: ChatMessageCreating[],
    options?: CreateChatMessagesOption,
  ): Promise<void>;
  triggerSlash(command: string): Promise<string>;
  triggerSlashWithResult(command: string): Promise<string>;
  getAllVariables(): Record<string, unknown>;
  getVariable(key: string): unknown;
  setVariable(key: string, value: unknown): Promise<void>;
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

function shapeFromSnapshot(
  msg: SnapshotMessage,
  includeSwipes: boolean,
): ChatMessageNonSwiped | ChatMessageSwiped {
  if (includeSwipes) {
    const swipes = msg.swipes;
    return {
      message_id: msg.message_id,
      name: msg.name,
      role: msg.role,
      is_hidden: msg.is_hidden,
      swipe_id: msg.swipe_id,
      swipes,
      swipes_data: swipes.map(() => ({})),
      swipes_info: swipes.map(() => ({})),
    };
  }
  return {
    message_id: msg.message_id,
    name: msg.name,
    role: msg.role,
    is_hidden: msg.is_hidden,
    message: msg.message,
    swipe_id: msg.swipe_id,
    swipes: msg.swipes,
    data: msg.data,
    extra: msg.extra,
  };
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
    getChatMessages(range, opts) {
      const snap = consts.messagesSnapshot;
      const idx = resolveRangeToIndex(range, snap.length, consts.currentMessageIndex);
      if (idx === null || idx < 0 || idx >= snap.length) return [];
      const includeSwipes =
        !!opts && (opts.include_swipe === true || opts.include_swipes === true);
      return [shapeFromSnapshot(snap[idx], includeSwipes)];
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
    async createChatMessages(chatMessages, options) {
      await bridge.postRequest('th-create-chat-messages', {
        chatMessages,
        options: options ?? {},
      });
    },
    async triggerSlash(command) {
      if (typeof command !== 'string') throw new TypeError('triggerSlash command must be a string');
      return String(await bridge.postRequest('th-trigger-slash', { command }) ?? '');
    },
    async triggerSlashWithResult(command) {
      if (typeof command !== 'string') throw new TypeError('triggerSlash command must be a string');
      return String(await bridge.postRequest('th-trigger-slash', { command }) ?? '');
    },
    getAllVariables() {
      if ((consts.variablesChatId ?? consts.chatId) !== consts.chatId) return {};
      return { ...(consts.variablesSnapshot ?? {}) };
    },
    getVariable(key: string) {
      if ((consts.variablesChatId ?? consts.chatId) !== consts.chatId) return null;
      const vars = consts.variablesSnapshot ?? {};
      return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : null;
    },
    async setVariable(key: string, value: unknown) {
      await bridge.postRequest('th-set-variable', { key, value });
    },
  };
}

// ES5 shim string injected into the iframe srcdoc head. getChatMessages,
// getAllVariables, getVariable, and the id helpers resolve synchronously from
// host-maintained state; setChatMessage/setVariable still use the backend bridge.
// (host-side dispatcher posts 'th-response' back keyed by requestId).
export function thHelpersShim(consts: ThHelpersConstants): string {
  const constsJson = JSON.stringify({
    currentMessageIndex: consts.currentMessageIndex,
    currentMessageId: consts.currentMessageId,
    chatId: consts.chatId,
    messagesSnapshot: consts.messagesSnapshot,
    variablesChatId: consts.variablesChatId ?? consts.chatId,
    variablesSnapshot: consts.variablesSnapshot ?? {},
    chatVariablesSnapshot: consts.chatVariablesSnapshot,
  }).replace(/</g, '\\u003c');
  return lodashShim() + `<script>(function(){
var THC = ${constsJson};
var pending = {};
var nextId = 0;
function makeRequestId(){ nextId = (nextId + 1) | 0; return 'th-' + Date.now().toString(36) + '-' + nextId.toString(36); }
function applyVariableState(nextChatId, nextVars, emitChanged){
  nextChatId = typeof nextChatId === 'string' ? nextChatId : '';
  nextVars = nextVars && typeof nextVars === 'object' && !Array.isArray(nextVars) ? nextVars : {};
  if (THC.chatId !== nextChatId) invalidateChatVariables();
  THC.chatId = nextChatId;
  THC.variablesChatId = nextChatId;
  THC.variablesSnapshot = nextVars;
  if (emitChanged && window.eventSource && typeof window.eventSource.emit === 'function') {
    window.eventSource.emit('CHAT_CHANGED', {
      chatId: nextChatId,
      changedFields: ['metadata.macro_variables', 'metadata.chat_variables']
    });
  }
}
// Same-origin fast path used by ScriptRunner. This deliberately updates state
// and fires the compatibility event in the same call stack, matching JSLR's
// direct parent-window binding more closely than an asynchronous postMessage.
window.__vishrunSetVariableState = function(nextChatId, nextVars, emitChanged){
  applyVariableState(nextChatId, nextVars, !!emitChanged);
};
function setup(){
  if (!window.spindleSandbox || typeof window.spindleSandbox.onMessage !== 'function') return;
  window.spindleSandbox.onMessage(function(payload){
    if (!payload || typeof payload !== 'object') return;
    if (payload.type === 'vsh_chat_variables') {
      window.__vishrunSetChatVariables(payload.state);
      return;
    }
    if (payload.type === 'vsh_th_variables') {
      applyVariableState(payload.chatId, payload.variables, !!payload.emitChanged);
      return;
    }
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
function resolveIdx(range, total, cur){
  if (total === 0) return null;
  if (typeof range === 'number') return range >= 0 ? range : total + range;
  if (typeof range === 'string') {
    var t = range.trim();
    if (t === '' || t === 'latest') return total - 1;
    if (t === 'this') return cur;
    if (/^-?\\d+$/.test(t)) {
      var n = parseInt(t, 10);
      return n >= 0 ? n : total + n;
    }
  }
  return null;
}
function shape(m, withSwipes){
  if (withSwipes) {
    var sw = m.swipes;
    var blanks = [];
    for (var i = 0; i < sw.length; i++) blanks.push({});
    return {
      message_id: m.message_id, name: m.name, role: m.role, is_hidden: m.is_hidden,
      swipe_id: m.swipe_id, swipes: sw, swipes_data: blanks.slice(), swipes_info: blanks.slice()
    };
  }
  return {
    message_id: m.message_id, name: m.name, role: m.role, is_hidden: m.is_hidden,
    message: m.message, swipe_id: m.swipe_id, swipes: m.swipes, data: m.data, extra: m.extra
  };
}
window.getCurrentMessageId = function(){ return THC.currentMessageIndex; };
window.getChatId = function(){ return THC.chatId; };
window.getChatMessages = function(range, opts){
  var snap = THC.messagesSnapshot;
  var idx = resolveIdx(range, snap.length, THC.currentMessageIndex);
  if (idx === null || idx < 0 || idx >= snap.length) return [];
  var withSwipes = !!opts && (opts.include_swipe === true || opts.include_swipes === true);
  return [shape(snap[idx], withSwipes)];
};
window.setChatMessage = function(fieldValues, messageId, opts){
  var normalized = (typeof fieldValues === 'string') ? { message: fieldValues } : fieldValues;
  return postRequest('th-set-chat-message', { fieldValues: normalized, messageId: messageId, opts: opts || {} });
};
var JSLR_DATA_EXTRA_KEY = '__vishrun_jslr_message_data_v1';
function isPlainRecord(value){ return !!value && typeof value === 'object' && !Array.isArray(value); }
function cloneRecord(value){
  var out = {};
  if (!isPlainRecord(value)) return out;
  for (var key in value) if (Object.prototype.hasOwnProperty.call(value, key)) out[key] = value[key];
  return out;
}
function defaultMessageName(role){
  if (role === 'system') return 'system';
  var snap = THC.messagesSnapshot || [];
  for (var i = snap.length - 1; i >= 0; i--) {
    var item = snap[i];
    if (item && item.role === role && typeof item.name === 'string' && item.name.trim()) return item.name;
  }
  return role === 'user' ? 'User' : 'Assistant';
}
function hostJsonFetch(path, init){
  var hostWindow = window;
  try { if (window.parent && window.parent !== window && window.parent.fetch) hostWindow = window.parent; } catch (_) {}
  var fetcher = hostWindow.fetch ? hostWindow.fetch.bind(hostWindow) : window.fetch.bind(window);
  var origin = '';
  try { origin = hostWindow.location && hostWindow.location.origin ? hostWindow.location.origin : window.location.origin; } catch (_) { origin = window.location.origin; }
  return fetcher(origin + path, init).then(function(response){
    if (response.ok) return response.json().catch(function(){ return {}; });
    return response.text().catch(function(){ return ''; }).then(function(text){
      throw new Error('Lumiverse message update failed (HTTP ' + response.status + ')' + (text ? ': ' + text.slice(0, 300) : ''));
    });
  });
}
function normalizeCreatingMessage(raw, index){
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('chat_messages[' + index + '] must be an object');
  if (raw.role !== 'system' && raw.role !== 'assistant' && raw.role !== 'user') throw new TypeError('chat_messages[' + index + '].role must be system, assistant, or user');
  if (typeof raw.message !== 'string') throw new TypeError('chat_messages[' + index + '].message must be a string');
  if (raw.name !== undefined && typeof raw.name !== 'string') throw new TypeError('chat_messages[' + index + '].name must be a string');
  if (raw.is_hidden !== undefined && typeof raw.is_hidden !== 'boolean') throw new TypeError('chat_messages[' + index + '].is_hidden must be a boolean');
  if (raw.data !== undefined && !isPlainRecord(raw.data)) throw new TypeError('chat_messages[' + index + '].data must be an object');
  if (raw.extra !== undefined && !isPlainRecord(raw.extra)) throw new TypeError('chat_messages[' + index + '].extra must be an object');
  return raw;
}
function patchCreatedMessage(chatId, created, message){
  var extra = cloneRecord(message.extra);
  // Lumiverse represents the three-way JSLR role on persisted chat rows with
  // is_user + extra.spindle_role. Keep this host-native marker authoritative.
  extra.spindle_role = message.role;
  if (message.data !== undefined) extra[JSLR_DATA_EXTRA_KEY] = cloneRecord(message.data);
  if (message.is_hidden !== undefined) {
    if (message.is_hidden) extra.hidden = true;
    else delete extra.hidden;
  }
  var name = message.name !== undefined ? message.name : defaultMessageName(message.role);
  var path = '/api/v1/chats/' + encodeURIComponent(chatId) + '/messages/' + encodeURIComponent(created.id);
  return hostJsonFetch(path, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name, extra: extra })
  }).then(function(){
    var exposedExtra = cloneRecord(extra);
    delete exposedExtra[JSLR_DATA_EXTRA_KEY];
    return {
      id: created.id,
      message_id: created.message_id,
      name: name,
      role: message.role,
      is_hidden: extra.hidden === true,
      message: message.message,
      swipe_id: 0,
      swipes: [message.message],
      data: message.data !== undefined ? cloneRecord(message.data) : {},
      extra: exposedExtra
    };
  });
}
function rollbackCreatedMessages(chatId, created){
  return Promise.all((created || []).map(function(row){
    var path = '/api/v1/chats/' + encodeURIComponent(chatId) + '/messages/' + encodeURIComponent(row.id);
    return hostJsonFetch(path, { method: 'DELETE', credentials: 'include' }).catch(function(){ return undefined; });
  }));
}
window.triggerSlash = function(command){
  if (typeof command !== 'string') return Promise.reject(new TypeError('triggerSlash command must be a string'));
  return postRequest('th-trigger-slash', { command: command }).then(function(result){
    return result == null ? '' : String(result);
  });
};
window.triggerSlashWithResult = window.triggerSlash;
window.createChatMessages = function(chatMessages, options){
  if (!Array.isArray(chatMessages)) return Promise.reject(new TypeError('chat_messages must be an array'));
  var normalized;
  try {
    normalized = chatMessages.map(function(message, index){ return normalizeCreatingMessage(message, index); });
  } catch (error) {
    return Promise.reject(error);
  }
  options = options || {};
  if (!isPlainRecord(options)) return Promise.reject(new TypeError('createChatMessages options must be an object'));
  if (options.refresh !== undefined && options.refresh !== 'none' && options.refresh !== 'affected' && options.refresh !== 'all') {
    return Promise.reject(new TypeError('refresh must be none, affected, or all'));
  }
  return postRequest('th-create-chat-messages', { chatMessages: normalized, options: options }).then(function(result){
    if (!result || !Array.isArray(result.created) || result.created.length !== normalized.length) {
      throw new Error('createChatMessages backend returned an invalid creation result');
    }
    return Promise.all(normalized.map(function(message, index){
      return patchCreatedMessage(THC.chatId, result.created[index], message);
    })).then(function(rows){
      // JSLR mutates the live chat array immediately. Vishrun's synchronous
      // getChatMessages() reads a baked snapshot, so mirror the appended rows
      // locally after persistence to keep same-frame reads coherent.
      for (var i = 0; i < rows.length; i++) THC.messagesSnapshot.push(rows[i]);
      THC.messagesSnapshot.sort(function(a, b){ return a.message_id - b.message_id; });
      return undefined;
    }, function(error){
      // Avoid leaving half-customized rows behind if Lumiverse rejects a name/extra patch.
      return rollbackCreatedMessages(THC.chatId, result.created).then(function(){ throw error; });
    });
  });
};
window.getAllVariables = function(){
  if (THC.variablesChatId !== THC.chatId) return {};
  var vars = chatVariablesReady ? allChatVariables : THC.variablesSnapshot || {};
  var out = {};
  for (var key in vars) {
    if (Object.prototype.hasOwnProperty.call(vars, key)) out[key] = vars[key];
  }
  return out;
};
window.getVariable = function(key){
  if (THC.variablesChatId !== THC.chatId) return null;
  var vars = chatVariablesReady ? allChatVariables : THC.variablesSnapshot || {};
  return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : null;
};
window.setVariable = function(key, value){
  return postRequest('th-set-variable', { key: key, value: value });
};
${chatVariablesShim()}
})();</script>`;
}
