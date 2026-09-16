import type { SnapshotMessage } from '../backend/th-helpers';

// TS twin of the ES5 shim string in thHelpersShim() below. The twin is
// testable with happy-dom; the string runs in the sandbox iframe.
// Read APIs stay synchronous from host-maintained snapshots. Mutations use
// the backend bridge because Lumiverse's persisted chat-variable API is async.

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
  variablesBaseSnapshot?: Record<string, unknown>;
  chatVariablesChatId?: string;
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

export interface ChatVariableOption {
  type: 'chat';
}

export interface DeleteVariableResult {
  variables: Record<string, unknown>;
  delete_occurred: boolean;
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
  getAllVariables(): Record<string, unknown>;
  getVariable(key: string): unknown;
  setVariable(key: string, value: unknown): Promise<void>;
  getVariables(option?: ChatVariableOption): Record<string, unknown>;
  replaceVariables(
    variables: Record<string, unknown>,
    option?: ChatVariableOption,
  ): Promise<void>;
  updateVariablesWith(
    updater: (variables: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>,
    option?: ChatVariableOption,
  ): Promise<Record<string, unknown>>;
  insertOrAssignVariables(
    variables: Record<string, unknown>,
    option?: ChatVariableOption,
  ): Promise<Record<string, unknown>>;
  insertVariables(
    variables: Record<string, unknown>,
    option?: ChatVariableOption,
  ): Promise<Record<string, unknown>>;
  deleteVariable(variablePath: string, option?: ChatVariableOption): Promise<DeleteVariableResult>;
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  if (typeof structuredClone === 'function') {
    try { return structuredClone(value); } catch { /* JSON fallback below */ }
  }
  try { return JSON.parse(JSON.stringify(value)) as Record<string, unknown>; }
  catch { return { ...value }; }
}

function assertChatOption(option: ChatVariableOption = { type: 'chat' }): void {
  if (!option || option.type !== 'chat') {
    throw new Error("Vishrun currently supports getVariables-style APIs only for { type: 'chat' }");
  }
}

function currentChatVariables(consts: ThHelpersConstants): Record<string, unknown> {
  if ((consts.chatVariablesChatId ?? consts.chatId) !== consts.chatId) return {};
  return cloneRecord(consts.chatVariablesSnapshot ?? {});
}

function currentAllVariables(consts: ThHelpersConstants): Record<string, unknown> {
  if ((consts.variablesChatId ?? consts.chatId) !== consts.chatId) return {};
  const separated = consts.variablesBaseSnapshot !== undefined || consts.chatVariablesSnapshot !== undefined;
  if (!separated) return cloneRecord(consts.variablesSnapshot ?? {});
  return {
    ...cloneRecord(consts.variablesBaseSnapshot ?? {}),
    ...currentChatVariables(consts),
  };
}

function applyChatVariablesResult(
  consts: ThHelpersConstants,
  result: unknown,
  fallback: Record<string, unknown>,
  expectedChatId: string,
): Record<string, unknown> {
  const next = isPlainRecord(result) ? result : fallback;
  // A write may finish after the user switches chats. Return the authoritative
  // result to the caller, but never install Chat A's result into Chat B's mirror.
  if (consts.chatId !== expectedChatId) return cloneRecord(next);
  consts.chatVariablesChatId = expectedChatId;
  consts.chatVariablesSnapshot = cloneRecord(next);
  return cloneRecord(next);
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
    getAllVariables() {
      return currentAllVariables(consts);
    },
    getVariable(key: string) {
      const vars = currentAllVariables(consts);
      return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : null;
    },
    async setVariable(key: string, value: unknown) {
      await bridge.postRequest('th-set-variable', { key, value });
    },
    getVariables(option = { type: 'chat' }) {
      assertChatOption(option);
      return currentChatVariables(consts);
    },
    async replaceVariables(variables, option = { type: 'chat' }) {
      assertChatOption(option);
      if (!isPlainRecord(variables)) throw new TypeError('replaceVariables expects an object');
      const requested = cloneRecord(variables);
      const expectedChatId = consts.chatId;
      const result = await bridge.postRequest('th-replace-chat-variables', { variables: requested, chatId: expectedChatId });
      applyChatVariablesResult(consts, result, requested, expectedChatId);
    },
    async updateVariablesWith(updater, option = { type: 'chat' }) {
      assertChatOption(option);
      if (typeof updater !== 'function') throw new TypeError('updateVariablesWith expects a function');
      const expectedChatId = consts.chatId;
      const result = await updater(currentChatVariables(consts));
      if (!isPlainRecord(result)) throw new TypeError('updateVariablesWith callback must return an object');
      const requested = cloneRecord(result);
      const persisted = await bridge.postRequest('th-replace-chat-variables', { variables: requested, chatId: expectedChatId });
      return applyChatVariablesResult(consts, persisted, requested, expectedChatId);
    },
    async insertOrAssignVariables(variables, option = { type: 'chat' }) {
      assertChatOption(option);
      if (!isPlainRecord(variables)) throw new TypeError('insertOrAssignVariables expects an object');
      const expectedChatId = consts.chatId;
      const result = await bridge.postRequest('th-patch-chat-variables', { variables, chatId: expectedChatId });
      return applyChatVariablesResult(consts, result, { ...currentChatVariables(consts), ...variables }, expectedChatId);
    },
    async insertVariables(variables, option = { type: 'chat' }) {
      assertChatOption(option);
      if (!isPlainRecord(variables)) throw new TypeError('insertVariables expects an object');
      const expectedChatId = consts.chatId;
      const current = currentChatVariables(consts);
      const result = await bridge.postRequest('th-insert-chat-variables', { variables, chatId: expectedChatId });
      return applyChatVariablesResult(consts, result, { ...variables, ...current }, expectedChatId);
    },
    async deleteVariable(variablePath, option = { type: 'chat' }) {
      assertChatOption(option);
      const expectedChatId = consts.chatId;
      const result = await bridge.postRequest('th-delete-chat-variable', { path: String(variablePath), chatId: expectedChatId });
      if (isPlainRecord(result) && isPlainRecord(result.variables)) {
        const variables = applyChatVariablesResult(consts, result.variables, currentChatVariables(consts), expectedChatId);
        return { variables, delete_occurred: result.delete_occurred === true };
      }
      return { variables: currentChatVariables(consts), delete_occurred: false };
    },
  };
}

// ES5 shim string injected into the iframe srcdoc head. Read APIs resolve
// synchronously from host-maintained state. Chat-variable mutations use the
// backend bridge and then immediately replace the iframe's mirrored chat bag
// with the authoritative result returned by spindle.variables.chat.
export function thHelpersShim(consts: ThHelpersConstants): string {
  const constsJson = JSON.stringify({
    currentMessageIndex: consts.currentMessageIndex,
    currentMessageId: consts.currentMessageId,
    chatId: consts.chatId,
    messagesSnapshot: consts.messagesSnapshot,
    variablesChatId: consts.variablesChatId ?? consts.chatId,
    variablesSnapshot: consts.variablesSnapshot ?? {},
    variablesBaseSnapshot: consts.variablesBaseSnapshot,
    chatVariablesChatId: consts.chatVariablesSnapshot !== undefined
      ? (consts.chatVariablesChatId ?? consts.chatId)
      : undefined,
    chatVariablesSnapshot: consts.chatVariablesSnapshot,
  });
  return `<script>(function(){
var THC = ${constsJson};
var pending = {};
var nextId = 0;
function makeRequestId(){ nextId = (nextId + 1) | 0; return 'th-' + Date.now().toString(36) + '-' + nextId.toString(36); }
function isRecord(value){ return !!value && typeof value === 'object' && !Array.isArray(value); }
function cloneRecord(value){
  value = isRecord(value) ? value : {};
  if (typeof structuredClone === 'function') {
    try { return structuredClone(value); } catch (e) {}
  }
  try { return JSON.parse(JSON.stringify(value)); } catch (e) {}
  var out = {};
  for (var key in value) if (Object.prototype.hasOwnProperty.call(value, key)) out[key] = value[key];
  return out;
}
function assertChatOption(option){
  option = option || { type: 'chat' };
  if (!option || option.type !== 'chat') throw new Error("Vishrun currently supports getVariables-style APIs only for { type: 'chat' }");
  return option;
}
function getChatSnapshot(){
  if (THC.chatVariablesChatId !== THC.chatId) return {};
  return cloneRecord(THC.chatVariablesSnapshot || {});
}
function getAllSnapshot(){
  if (THC.variablesChatId !== THC.chatId) return {};
  var separated = THC.variablesBaseSnapshot !== undefined || THC.chatVariablesSnapshot !== undefined;
  if (!separated) return cloneRecord(THC.variablesSnapshot || {});
  var out = cloneRecord(THC.variablesBaseSnapshot || {});
  var chat = getChatSnapshot();
  for (var key in chat) if (Object.prototype.hasOwnProperty.call(chat, key)) out[key] = chat[key];
  return out;
}
function applyChatVariables(nextVars, expectedChatId){
  nextVars = isRecord(nextVars) ? nextVars : {};
  if (typeof expectedChatId === 'string' && THC.chatId !== expectedChatId) return cloneRecord(nextVars);
  THC.chatVariablesChatId = THC.chatId;
  THC.chatVariablesSnapshot = cloneRecord(nextVars);
  return cloneRecord(THC.chatVariablesSnapshot);
}
function applyVariableState(nextChatId, nextBaseVars, nextChatVars, nextCombinedVars, emitChanged){
  nextChatId = typeof nextChatId === 'string' ? nextChatId : '';
  nextBaseVars = isRecord(nextBaseVars) ? nextBaseVars : {};
  nextChatVars = isRecord(nextChatVars) ? nextChatVars : {};
  nextCombinedVars = isRecord(nextCombinedVars) ? nextCombinedVars : {};
  THC.chatId = nextChatId;
  THC.variablesChatId = nextChatId;
  THC.chatVariablesChatId = nextChatId;
  THC.variablesBaseSnapshot = nextBaseVars;
  THC.chatVariablesSnapshot = nextChatVars;
  THC.variablesSnapshot = nextCombinedVars;
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
window.__vishrunSetVariableState = function(nextChatId, nextBaseVars, nextChatVars, nextCombinedVars, emitChanged){
  applyVariableState(nextChatId, nextBaseVars, nextChatVars, nextCombinedVars, !!emitChanged);
};
function setup(){
  if (!window.spindleSandbox || typeof window.spindleSandbox.onMessage !== 'function') return;
  window.spindleSandbox.onMessage(function(payload){
    if (!payload || typeof payload !== 'object') return;
    if (payload.type === 'vsh_th_variables') {
      applyVariableState(payload.chatId, payload.variablesBase, payload.chatVariables, payload.variables, !!payload.emitChanged);
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
window.getAllVariables = function(){ return getAllSnapshot(); };
window.getVariable = function(key){
  var vars = getAllSnapshot();
  return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : null;
};
window.setVariable = function(key, value){
  return postRequest('th-set-variable', { key: key, value: value });
};
window.getVariables = function(option){
  assertChatOption(option || { type: 'chat' });
  return getChatSnapshot();
};
window.replaceVariables = function(variables, option){
  assertChatOption(option || { type: 'chat' });
  if (!isRecord(variables)) return Promise.reject(new TypeError('replaceVariables expects an object'));
  var requested = cloneRecord(variables);
  var expectedChatId = THC.chatId;
  return postRequest('th-replace-chat-variables', { variables: requested, chatId: expectedChatId }).then(function(result){
    applyChatVariables(isRecord(result) ? result : requested, expectedChatId);
  });
};
window.updateVariablesWith = function(updater, option){
  assertChatOption(option || { type: 'chat' });
  if (typeof updater !== 'function') return Promise.reject(new TypeError('updateVariablesWith expects a function'));
  var expectedChatId = THC.chatId;
  var result;
  try { result = updater(getChatSnapshot()); } catch (e) { return Promise.reject(e); }
  return Promise.resolve(result).then(function(next){
    if (!isRecord(next)) throw new TypeError('updateVariablesWith callback must return an object');
    var requested = cloneRecord(next);
    return postRequest('th-replace-chat-variables', { variables: requested, chatId: expectedChatId }).then(function(persisted){
      return applyChatVariables(isRecord(persisted) ? persisted : requested, expectedChatId);
    });
  });
};
window.insertOrAssignVariables = function(variables, option){
  assertChatOption(option || { type: 'chat' });
  if (!isRecord(variables)) return Promise.reject(new TypeError('insertOrAssignVariables expects an object'));
  var expectedChatId = THC.chatId;
  var fallback = getChatSnapshot();
  for (var key in variables) if (Object.prototype.hasOwnProperty.call(variables, key)) fallback[key] = variables[key];
  return postRequest('th-patch-chat-variables', { variables: variables, chatId: expectedChatId }).then(function(result){
    return applyChatVariables(isRecord(result) ? result : fallback, expectedChatId);
  });
};
window.insertVariables = function(variables, option){
  assertChatOption(option || { type: 'chat' });
  if (!isRecord(variables)) return Promise.reject(new TypeError('insertVariables expects an object'));
  var expectedChatId = THC.chatId;
  var current = getChatSnapshot();
  var fallback = cloneRecord(variables);
  for (var key in current) if (Object.prototype.hasOwnProperty.call(current, key)) fallback[key] = current[key];
  return postRequest('th-insert-chat-variables', { variables: variables, chatId: expectedChatId }).then(function(result){
    return applyChatVariables(isRecord(result) ? result : fallback, expectedChatId);
  });
};
window.deleteVariable = function(variablePath, option){
  assertChatOption(option || { type: 'chat' });
  var expectedChatId = THC.chatId;
  return postRequest('th-delete-chat-variable', { path: String(variablePath), chatId: expectedChatId }).then(function(result){
    if (isRecord(result) && isRecord(result.variables)) {
      return { variables: applyChatVariables(result.variables, expectedChatId), delete_occurred: result.delete_occurred === true };
    }
    return { variables: getChatSnapshot(), delete_occurred: false };
  });
};
})();</script>`;
}
