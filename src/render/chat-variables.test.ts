import { test, expect } from 'bun:test';
import { createContext, runInContext } from 'node:vm';
import { thHelpersShim } from './th-helpers-shim';
import { mvuShim } from './mvu-shim';
import { handleReplaceChatVariables } from '../backend/th-helpers';
import { bindChatVariableState, chatVariableState, publishChatVariableState } from './chat-variable-state';
import { dispatchThRequest } from './th-helpers-bridge';
import { classifyWidgetEnvironment } from '../core/widget-environment';
import { ScriptRunner } from '../settings/script-runner';
import { makeScript } from '../settings/script-types';
import { buildWidgetIframe, destroyWidgetIframe } from './widget-iframe';

function runtime(initial: Record<string, unknown> = {}, save?: (body: any) => Promise<any>) {
  const handlers: Array<(p: any) => void> = [];
  const requests: any[] = [];
  let stored = structuredClone(initial);
  const sandbox: any = { console, setTimeout, clearTimeout };
  sandbox.window = sandbox;
  sandbox.spindleSandbox = {
    onMessage: (fn: (p: any) => void) => handlers.push(fn),
    postMessage: (request: any) => {
      requests.push(request);
      Promise.resolve().then(async () => {
        try {
          const state = save ? await save(request.body) : {
            chatId: 'a', variables: stored = structuredClone(request.body.variables),
            allVariables: stored,
          };
          handlers.forEach(h => h({ kind: 'th-response', requestId: request.requestId, ok: true, result: state }));
        } catch (e) {
          handlers.forEach(h => h({ kind: 'th-response', requestId: request.requestId, ok: false, error: String(e) }));
        }
      });
    },
  };
  const context = createContext(sandbox);
  function execute(html: string) {
    for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) runInContext(match[1], context);
  }
  execute(thHelpersShim({ currentMessageIndex: 0, currentMessageId: 'm', chatId: 'a',
    messagesSnapshot: [], variablesSnapshot: initial, chatVariablesSnapshot: initial }));
  return { w: sandbox, requests, execute, send: (p: any) => handlers.forEach(h => h(p)), stored: () => stored };
}

test('all six direct API names select helper injection', () => {
  for (const name of ['getVariables', 'replaceVariables', 'updateVariablesWith', 'insertOrAssignVariables', 'insertVariables', 'deleteVariable']) {
    expect(classifyWidgetEnvironment(`<script>window.${name}({});</script>`)).toBe('tavern-helpers-light');
  }
});

test('actual iframe getters are synchronous deep copies; scoped reads exclude other bags', () => {
  const r = runtime({ nested: { value: 1 } });
  r.w.__vishrunSetChatVariables({ chatId: 'a', variables: { nested: { value: 1 } }, allVariables: { localOnly: 4, nested: { value: 1 } } });
  const result = r.w.getVariables();
  expect(result.then).toBeUndefined();
  result.nested.value = 99;
  expect(r.w.getVariables()).toEqual({ nested: { value: 1 } });
  expect(r.w.getAllVariables().localOnly).toBe(4);
  expect(() => r.w.getVariables({ type: 'global' })).toThrow('only');
});

test('quotes, pipes, multiline, unicode and closing-script text survive without slash parsing', async () => {
  const values = { quote: '"Hello"', pipe: 'A | B', multiline: 'one\ntwo', unicode: '◈ Eslion', html: '</script><script>bad()</script>' };
  const r = runtime(values);
  await r.w.insertOrAssignVariables(values);
  expect(r.stored()).toEqual(values);
  expect(r.w.getVariables()).toEqual(values);
  expect(r.requests[0].op).toBe('th-replace-chat-variables');
});

test('JSLR merge semantics: nested objects merge, arrays replace, defaults keep existing values', async () => {
  const r = runtime({ nested: { a: 1, list: [1, 2, 3] }, keep: false });
  expect(await r.w.insertOrAssignVariables({ nested: { b: 2, list: [9] } })).toEqual({ nested: { a: 1, b: 2, list: [9] }, keep: false });
  expect(await r.w.insertVariables({ nested: { a: 5, c: 3, list: [0, 0] }, keep: true })).toEqual({ nested: { a: 1, b: 2, c: 3, list: [9] }, keep: false });
  expect(await r.w.replaceVariables({ only: 1 })).toBeUndefined();
  expect(r.w.getAllVariables()).toEqual({ only: 1 });
});

test('sync/async updaters and queued writes preserve values; rejection does not poison queue', async () => {
  const r = runtime({});
  await Promise.all([
    r.w.updateVariablesWith((v: any) => ({ ...v, a: 1 })),
    r.w.updateVariablesWith(async (v: any) => ({ ...v, b: 2 })),
  ]);
  expect(r.w.getVariables()).toEqual({ a: 1, b: 2 });
  await expect(r.w.updateVariablesWith(async () => { throw Error('bad callback'); })).rejects.toThrow('bad callback');
  await expect(r.w.updateVariablesWith(() => undefined)).rejects.toThrow('plain object');
  await r.w.insertOrAssignVariables({ c: 3 });
  expect(r.w.getVariables()).toEqual({ a: 1, b: 2, c: 3 });
});

test('delete follows Lodash paths and its true return for a missing path', async () => {
  const r = runtime({ nested: { list: [{ value: 2 }] }, 'literal.dot': 1 });
  const result = await r.w.deleteVariable('nested.list[0].value');
  expect(result).toEqual({ variables: { nested: { list: [{}] }, 'literal.dot': 1 }, delete_occurred: true });
  expect((await r.w.deleteVariable('missing')).delete_occurred).toBe(true);
  await r.w.deleteVariable('literal.dot');
  expect(r.w.getVariables()['literal.dot']).toBeUndefined();
});

test('failed saves leave the mirrored state unchanged and surface the error', async () => {
  const r = runtime({ hp: 1 }, async () => { throw Error('save refused'); });
  await expect(r.w.insertOrAssignVariables({ hp: 2 })).rejects.toThrow('save refused');
  expect(r.w.getVariables()).toEqual({ hp: 1 });
});

test('async updater cannot write to another chat, even when returning to the first chat', async () => {
  const r = runtime({ old: true });
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const updating = r.w.updateVariablesWith(async (v: any) => {
    entered();
    await new Promise<void>(resolve => { release = resolve; });
    return v;
  });
  await started;
  r.w.__vishrunSetVariableState('b', {});
  expect(r.w.getVariables()).toEqual({});
  r.w.__vishrunSetVariableState('a', {});
  r.w.__vishrunSetChatVariables({ chatId: 'a', variables: { new: true }, allVariables: { new: true } });
  release();
  await expect(updating).rejects.toThrow('chat changed');
  expect(r.requests).toHaveLength(0);
  expect(r.w.getVariables()).toEqual({ new: true });
});

test('late successful save cannot repopulate a different chat', async () => {
  let release!: (state: any) => void;
  const r = runtime({}, () => new Promise(resolve => { release = resolve; }));
  const write = r.w.insertOrAssignVariables({ a: 1 });
  while (!release) await Promise.resolve();
  r.w.__vishrunSetVariableState('b', {});
  r.w.__vishrunSetChatVariables({ chatId: 'b', variables: { b: 2 }, allVariables: { b: 2 } });
  release({ chatId: 'a', variables: { a: 1 }, allVariables: { a: 1 } });
  await write;
  expect(r.w.getVariables()).toEqual({ b: 2 });
});

test('MVU remains separate while getAllVariables includes persisted chat values', async () => {
  const r = runtime({ player: 'Alive' });
  r.execute(mvuShim({ variablesSnapshot: { stat_data: { hp: 42 } } }));
  await r.w.insertOrAssignVariables({ player: 'Deceased' });
  expect(r.w.getAllVariables()).toEqual({ stat_data: { hp: 42 }, player: 'Deceased' });
  expect(r.w.Mvu.getMvuData()).toEqual({ stat_data: { hp: 42 } });
});

test('backend replaces only chat_variables, passes user scope, and persists across reloads', async () => {
  const rows: any = { a: { metadata: { chat_variables: { old: 1 }, macro_variables: { local: { local: 'x' } }, chat_world_book_ids: ['book'], notes: 'keep' } }, b: { metadata: { chat_variables: { other: 2 } } } };
  const calls: any[] = [];
  const chats: any = {
    get: async (id: string, user: string) => { calls.push(['get', id, user]); return structuredClone(rows[id] ?? null); },
    update: async (id: string, input: any, user: string) => { calls.push(['update', id, user]); rows[id] = structuredClone(input); return structuredClone(rows[id]); },
  };
  const result = await handleReplaceChatVariables({ chatId: 'a', variables: { nested: { hp: 1 }, text: 'A | B\n"◈"' } }, 'a', 'user', chats);
  expect(rows.a.metadata.notes).toBe('keep');
  expect(rows.a.metadata.chat_world_book_ids).toEqual(['book']);
  expect(rows.a.metadata.chat_variables.old).toBeUndefined();
  expect(rows.b.metadata.chat_variables).toEqual({ other: 2 });
  expect(result.allVariables.local).toBe('x');
  expect(runtime((await chats.get('a', 'user')).metadata.chat_variables).w.getVariables()).toEqual(result.variables);
  expect(calls.every(c => c[2] === 'user')).toBe(true);
  await expect(handleReplaceChatVariables({ chatId: 'b', variables: {} }, 'a', 'user', chats)).rejects.toThrow('target');
  await expect(handleReplaceChatVariables({ chatId: 'missing', variables: {} }, 'missing', 'user', chats)).rejects.toThrow('not found');
});

test('live frames receive direct saves and native metadata events; cleanup removes subscriptions', async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ metadata: { chat_variables: { hp: '1' } } }))) as unknown as typeof fetch;
  try {
    const events = new Map<string, Set<(p: any) => void>>();
    const ctx: any = { getActiveChat: () => ({ chatId: 'a' }), events: { on: (name: string, fn: any) => {
      if (!events.has(name)) events.set(name, new Set());
      events.get(name)!.add(fn); return () => events.get(name)!.delete(fn);
    } } };
    const r1 = runtime({ hp: '1' }), r2 = runtime({ hp: '1' });
    function frame(r: ReturnType<typeof runtime>) {
      const element = new EventTarget() as any;
      element.contentWindow = r.w;
      return { element, postMessage: r.send } as any;
    }
    const stop1 = bindChatVariableState(frame(r1), ctx, chatVariableState('a', { chat_variables: { hp: '1' } }), false);
    const stop2 = bindChatVariableState(frame(r2), ctx, chatVariableState('a', { chat_variables: { hp: '1' } }), false);
    publishChatVariableState(ctx, chatVariableState('a', { chat_variables: { hp: '2' } }));
    expect(r1.w.getVariables().hp).toBe('2'); expect(r2.w.getVariables().hp).toBe('2');
    for (const fn of events.get('CHAT_CHANGED')!) fn({ chat: { id: 'a', metadata: { chat_variables: { macro: 'changed' } } } });
    expect(r1.w.getVariables()).toEqual({ macro: 'changed' });
    await Promise.resolve(); await Promise.resolve();
    expect(r1.w.getVariables()).toEqual({ macro: 'changed' });
    stop1(); stop2();
    expect([...events.values()].every(set => set.size === 0)).toBe(true);
  } finally { globalThis.fetch = oldFetch; }
});

test('two iframe writes with identical local request IDs get distinct backend IDs', () => {
  const sent: any[] = [], handlers = new Set<(p: any) => void>();
  const ctx: any = { sendToBackend: (p: any) => sent.push(p), onBackendMessage: (fn: any) => { handlers.add(fn); return () => handlers.delete(fn); } };
  const replies: any[][] = [[], []];
  for (let i = 0; i < 2; ++i) dispatchThRequest({ postMessage: (p: any) => replies[i].push(p) } as any,
    { kind: 'th-request', requestId: 'same', op: 'th-replace-chat-variables', body: { chatId: 'a' } },
    { chatId: 'a', currentMessageId: '', currentMessageIndex: -1 }, ctx);
  expect(sent[0].requestId).not.toBe(sent[1].requestId);
  for (let i = 0; i < 2; ++i) for (const fn of [...handlers]) fn({ type: 'th_helpers_response', requestId: sent[i].requestId, ok: false, error: `error-${i}` });
  expect(replies[0][0].error).toBe('error-0'); expect(replies[1][0].error).toBe('error-1');
});

test('real ScriptRunner forwards direct writes, updates sibling scripts and follows chat switches', async () => {
  const oldFetch = globalThis.fetch;
  const rows: any = { a: { metadata: { chat_variables: { hp: '10' } } }, b: { metadata: { chat_variables: { hp: '20' } } } };
  globalThis.fetch = (async (url: any) => new Response(JSON.stringify(rows[String(url).includes('/b') ? 'b' : 'a']))) as unknown as typeof fetch;
  const events = new Map<string, Set<(p: any) => void>>(), backend = new Set<(p: any) => void>();
  const frames: any[] = [];
  let active = 'a';
  const ctx: any = {
    getActiveChat: () => ({ chatId: active }),
    events: { on: (name: string, fn: any) => {
      if (!events.has(name)) events.set(name, new Set());
      events.get(name)!.add(fn); return () => events.get(name)!.delete(fn);
    } },
    onBackendMessage: (fn: any) => { backend.add(fn); return () => backend.delete(fn); },
    sendToBackend: (request: any) => queueMicrotask(() => {
      let result: any = [];
      if (request.op === 'th-replace-chat-variables') {
        rows[request.chatId].metadata.chat_variables = structuredClone(request.body.variables);
        result = chatVariableState(request.chatId, rows[request.chatId].metadata);
      }
      for (const fn of [...backend]) fn({ type: 'th_helpers_response', requestId: request.requestId, ok: true, result });
    }),
    dom: { createSandboxFrame: ({ html }: any) => {
      const incoming: any[] = [], outgoing: any[] = [];
      const w: any = { console, navigator: { clipboard: {} }, setTimeout, clearTimeout };
      w.window = w;
      w.spindleSandbox = { onMessage: (fn: any) => incoming.push(fn), postMessage: (p: any) => outgoing.forEach(fn => fn(p)) };
      const context = createContext(w);
      const element = document.createElement('iframe');
      Object.defineProperty(element, 'contentWindow', { value: w });
      const handle = { element, postMessage: (p: any) => incoming.forEach(fn => fn(p)), onMessage: (fn: any) => outgoing.push(fn), destroy: () => element.remove() };
      frames.push({ w, load: () => {
        for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
          // Exercise the generated variable bridge in VM; visual/layout shims
          // require a real browser and are covered by their existing tests.
          if (html.includes('window.initialHP') && !/Lodash lodash.com|var THC =|window.initialHP/.test(match[1])) continue;
          runInContext(match[1], context);
        }
        element.dispatchEvent(new Event('load'));
      } });
      return handle;
    } },
  };
  const runner = new ScriptRunner(ctx);
  let widget: HTMLIFrameElement | undefined;
  try {
    await runner.run([makeScript({ id: 'one' }), makeScript({ id: 'two' })], 'a');
    expect(frames).toHaveLength(2);
    frames.forEach(f => f.load());
    widget = await buildWidgetIframe('<script>window.initialHP = getVariables().hp;</script>', 'test', 'test-widget', 'message', ctx);
    frames[2].load();
    expect(frames[2].w.initialHP).toBe('10');
    await frames[0].w.insertOrAssignVariables({ player: '◈ A | B\n"Hello"' });
    expect(rows.a.metadata.chat_variables.player).toBe('◈ A | B\n"Hello"');
    expect(frames[1].w.getVariables()).toEqual(rows.a.metadata.chat_variables);
    expect(frames[2].w.getVariables()).toEqual(rows.a.metadata.chat_variables);
    await frames[2].w.insertOrAssignVariables({ fromWidget: true });
    expect(frames[0].w.getVariables().fromWidget).toBe(true);
    active = 'b';
    for (const fn of events.get('SETTINGS_UPDATED')!) fn({ key: 'activeChatId' });
    expect(frames[0].w.getVariables()).toEqual({});
    for (const fn of events.get('CHAT_CHANGED')!) fn({ chat: { id: 'b', metadata: rows.b.metadata } });
    expect(frames[0].w.getVariables()).toEqual({ hp: '20' });
    await frames[1].w.insertOrAssignVariables({ current: true });
    expect(rows.b.metadata.chat_variables.current).toBe(true);
    expect(rows.a.metadata.chat_variables.current).toBeUndefined();
    await expect(frames[2].w.insertOrAssignVariables({ staleWidget: true })).rejects.toThrow('chat changed');
  } finally { if (widget) destroyWidgetIframe(widget); runner.destroy(); globalThis.fetch = oldFetch; }
  expect([...events.values()].every(set => set.size === 0)).toBe(true);
});
