// Stubs `globalThis.spindle` so source modules that bind `api = spindle` at
// import time don't ReferenceError under `bun test`. Tests inject their own
// fakes via dependency-injection params; the stub is just to let modules load.

(globalThis as Record<string, unknown>).spindle = {
  onFrontendMessage: () => {},
  sendToFrontend: () => {},
  registerMessageContentProcessor: () => {},
  macros: { resolve: async () => ({ text: '', diagnostics: [] }) },
  cors: { fetch: async () => ({ status: 200, headers: {}, body: '' }) },
  chat: { onMessageContent: () => () => {}, appendMessage: async () => ({ id: 'stub' }) },
  variables: { local: { set: async () => {} }, chat: { set: async () => {} }, global: { set: async () => {} } },
};
