// Inserted inside thHelpersShim's closure: reuses its request/response bridge.
// Reads stay synchronous. Mutations return Promises because persistence crosses
// Lumiverse's worker boundary; await them before depending on a saved write.
export function chatVariablesShim(): string {
  return `
var chatWriteTail = Promise.resolve();
var chatVariableEpoch = 0;
var chatVariablesReady = !!THC.chatVariablesSnapshot;
var chatVariables = THC.chatVariablesSnapshot || {};
var allChatVariables = THC.variablesSnapshot || {};
function checkChatOption(option){
  if (option !== undefined && (!option || option.type !== 'chat')) {
    throw new Error('Vishrun variable API currently supports only { type: "chat" }');
  }
}
function cloneVariables(value){ return _.cloneDeep(value); }
function validateVariables(value){
  if (!_.isPlainObject(value)) throw new TypeError('Variables must be a plain object');
  return value;
}
window.__vishrunSetChatVariables = function(state){
  if (!state || state.chatId !== THC.chatId) return;
  var becameReady = !chatVariablesReady && state.ready !== false;
  chatVariablesReady = state.ready !== false;
  chatVariables = cloneVariables(state.variables || {});
  allChatVariables = cloneVariables(state.allVariables || {});
  THC.variablesSnapshot = cloneVariables(allChatVariables);
  if (becameReady && window.eventSource && typeof window.eventSource.emit === 'function') {
    window.eventSource.emit('CHAT_CHANGED', { chatId: THC.chatId, changedFields: ['metadata.chat_variables'] });
  }
};
function invalidateChatVariables(){
  ++chatVariableEpoch;
  chatVariablesReady = false;
  chatVariables = {};
  allChatVariables = {};
}
window.getVariables = function(option){
  checkChatOption(option);
  return cloneVariables(chatVariablesReady ? chatVariables : {});
};
function queueChatWrite(updater, option){
  checkChatOption(option);
  var chatId = THC.chatId;
  var epoch = chatVariableEpoch;
  function checkCurrent(){
    if (!chatId || THC.chatId !== chatId || epoch !== chatVariableEpoch) {
      throw new Error('The chat changed before the variable update completed');
    }
    if (!chatVariablesReady) throw new Error('Chat variables are not loaded yet');
  }
  var work = chatWriteTail.then(function(){
    checkCurrent();
    return updater(window.getVariables());
  }).then(function(result){
    checkCurrent();
    var saved = cloneVariables(validateVariables(result));
    return postRequest('th-replace-chat-variables', { variables: saved, chatId: chatId }).then(function(state){
      // Never install a late response into another chat (including A -> B -> A).
      if (THC.chatId === chatId && epoch === chatVariableEpoch) {
        window.__vishrunSetChatVariables(state);
      }
      return cloneVariables(saved);
    });
  });
  chatWriteTail = work.then(function(){}, function(){});
  return work;
}
window.replaceVariables = function(variables, option){
  var copy = cloneVariables(validateVariables(variables));
  return queueChatWrite(function(){ return copy; }, option).then(function(){});
};
window.updateVariablesWith = function(updater, option){
  if (typeof updater !== 'function') throw new TypeError('The variable updater must be a function');
  return queueChatWrite(updater, option);
};
window.insertOrAssignVariables = function(variables, option){
  var copy = cloneVariables(validateVariables(variables));
  return queueChatWrite(function(old_variables){
    return _.mergeWith(old_variables, copy, function(lhs, rhs){ return _.isArray(rhs) ? rhs : undefined; });
  }, option);
};
window.insertVariables = function(variables, option){
  var copy = cloneVariables(validateVariables(variables));
  return queueChatWrite(function(old_variables){
    return _.mergeWith({}, copy, old_variables, function(lhs, rhs){ return _.isArray(rhs) ? rhs : undefined; });
  }, option);
};
window.deleteVariable = function(variable_path, option){
  var delete_occurred = false;
  return queueChatWrite(function(old_variables){
    delete_occurred = _.unset(old_variables, variable_path);
    return old_variables;
  }, option).then(function(variables){ return { variables: variables, delete_occurred: delete_occurred }; });
};
`;
}
