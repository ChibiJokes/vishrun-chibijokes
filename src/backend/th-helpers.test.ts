import { test, expect, mock } from 'bun:test';
import { handleGetChatMessages, handleSetChatMessage } from './th-helpers';

function makeMessages(specs: Array<{ id?: string; content: string; swipes?: string[]; swipeId?: number; isUser?: boolean }>) {
  return specs.map((s, i) => ({
    id: s.id ?? `msg-${i}`,
    chat_id: 'chat-1',
    index_in_chat: i,
    is_user: s.isUser ?? false,
    name: s.isUser ? 'user' : 'char',
    content: s.content,
    send_date: 0,
    swipe_id: s.swipeId ?? 0,
    swipes: s.swipes ?? [s.content],
    swipe_dates: [0],
    extra: {},
    parent_message_id: null,
    branch_id: null,
    created_at: 0,
    role: (s.isUser ? 'user' : 'assistant') as 'user' | 'assistant',
  }));
}

function makeChatApi(initial: ReturnType<typeof makeMessages>) {
  let messages = initial;
  const updates: Array<{ chatId: string; messageId: string; patch: unknown }> = [];
  return {
    chat: {
      getMessages: async () => messages,
      updateMessage: async (chatId: string, messageId: string, patch: unknown) => {
        updates.push({ chatId, messageId, patch });
        const p = patch as { content?: string; swipe_id?: number };
        messages = messages.map((m) => {
          if (m.id !== messageId) return m;
          const next = { ...m };
          if (typeof p.content === 'string') next.content = p.content;
          if (typeof p.swipe_id === 'number') next.swipe_id = p.swipe_id;
          return next;
        });
      },
    },
    updates,
    getMessages: () => messages,
  } as unknown as {
    chat: import('lumiverse-spindle-types').SpindleAPI['chat'];
    updates: typeof updates;
    getMessages: () => ReturnType<typeof makeMessages>;
  };
}

test('getChatMessages range "0" returns first message non-swipe shape', async () => {
  const api = makeChatApi(makeMessages([{ content: 'greet' }, { content: 'reply', isUser: true }]));
  const out = (await handleGetChatMessages({ range: '0', opts: {} }, 'chat-1', 0, api.chat)) as Array<Record<string, unknown>>;
  expect(out.length).toBe(1);
  expect(out[0].message_id).toBe(0);
  expect(out[0].message).toBe('greet');
  expect((out[0] as { swipes?: unknown }).swipes).toBeUndefined();
});

test('getChatMessages with include_swipe returns swipes array', async () => {
  const api = makeChatApi(makeMessages([{ content: 'g1', swipes: ['g1', 'g2', 'g3'], swipeId: 0 }]));
  const out = (await handleGetChatMessages(
    { range: '0', opts: { include_swipe: true } },
    'chat-1',
    0,
    api.chat,
  )) as Array<Record<string, unknown>>;
  expect(out[0].swipes).toEqual(['g1', 'g2', 'g3']);
  expect(out[0].swipe_id).toBe(0);
  expect((out[0] as { message?: unknown }).message).toBeUndefined();
});

test('getChatMessages with include_swipes (plural) also returns swipes', async () => {
  const api = makeChatApi(makeMessages([{ content: 'x', swipes: ['x', 'y'] }]));
  const out = (await handleGetChatMessages(
    { range: 0, opts: { include_swipes: true } },
    'chat-1',
    0,
    api.chat,
  )) as Array<Record<string, unknown>>;
  expect(out[0].swipes).toEqual(['x', 'y']);
});

test('getChatMessages numeric range', async () => {
  const api = makeChatApi(makeMessages([{ content: 'a' }, { content: 'b' }, { content: 'c' }]));
  const out = (await handleGetChatMessages({ range: 2, opts: {} }, 'chat-1', 0, api.chat)) as Array<Record<string, unknown>>;
  expect(out[0].message).toBe('c');
});

test('getChatMessages "latest" returns last', async () => {
  const api = makeChatApi(makeMessages([{ content: 'a' }, { content: 'b' }]));
  const out = (await handleGetChatMessages({ range: 'latest', opts: {} }, 'chat-1', 0, api.chat)) as Array<Record<string, unknown>>;
  expect(out[0].message).toBe('b');
});

test('getChatMessages negative index counts from end', async () => {
  const api = makeChatApi(makeMessages([{ content: 'a' }, { content: 'b' }, { content: 'c' }]));
  const out = (await handleGetChatMessages({ range: -1, opts: {} }, 'chat-1', 0, api.chat)) as Array<Record<string, unknown>>;
  expect(out[0].message).toBe('c');
});

test('getChatMessages out-of-range returns []', async () => {
  const api = makeChatApi(makeMessages([{ content: 'a' }]));
  const out = await handleGetChatMessages({ range: 5, opts: {} }, 'chat-1', 0, api.chat);
  expect(out).toEqual([]);
});

test('getChatMessages on empty chat returns []', async () => {
  const api = makeChatApi(makeMessages([]));
  const out = await handleGetChatMessages({ range: '0', opts: {} }, 'chat-1', 0, api.chat);
  expect(out).toEqual([]);
});

test('getChatMessages "this" uses currentMessageIndex', async () => {
  const api = makeChatApi(makeMessages([{ content: 'a' }, { content: 'b' }, { content: 'c' }]));
  const out = (await handleGetChatMessages({ range: 'this', opts: {} }, 'chat-1', 1, api.chat)) as Array<Record<string, unknown>>;
  expect(out[0].message).toBe('b');
});

test('getChatMessages unsupported range returns []', async () => {
  const restoreDebug = console.debug;
  console.debug = mock(() => {});
  try {
    const api = makeChatApi(makeMessages([{ content: 'a' }]));
    const out = await handleGetChatMessages({ range: { weird: true }, opts: {} }, 'chat-1', 0, api.chat);
    expect(out).toEqual([]);
  } finally {
    console.debug = restoreDebug;
  }
});

test('setChatMessage writes content patch via updateMessage', async () => {
  const api = makeChatApi(makeMessages([{ content: 'orig', swipes: ['orig', 'alt'], swipeId: 0 }]));
  await handleSetChatMessage(
    { fieldValues: { message: 'new' }, messageId: 0, opts: { swipe_id: 1 } },
    'chat-1',
    0,
    api.chat,
  );
  expect(api.updates).toEqual([
    { chatId: 'chat-1', messageId: 'msg-0', patch: { content: 'new', swipe_id: 1 } },
  ]);
});

test('setChatMessage without swipe_id omits it from patch', async () => {
  const api = makeChatApi(makeMessages([{ content: 'a' }]));
  await handleSetChatMessage(
    { fieldValues: { message: 'b' }, messageId: 0, opts: {} },
    'chat-1',
    0,
    api.chat,
  );
  expect(api.updates[0].patch).toEqual({ content: 'b' });
});

test('setChatMessage ignores write when message missing', async () => {
  const restoreWarn = console.warn;
  console.warn = mock(() => {});
  try {
    const api = makeChatApi(makeMessages([{ content: 'a' }]));
    await handleSetChatMessage(
      { fieldValues: {}, messageId: 0, opts: {} },
      'chat-1',
      0,
      api.chat,
    );
    expect(api.updates).toEqual([]);
  } finally {
    console.warn = restoreWarn;
  }
});

test('setChatMessage ignores write on out-of-range message id', async () => {
  const restoreWarn = console.warn;
  console.warn = mock(() => {});
  try {
    const api = makeChatApi(makeMessages([{ content: 'a' }]));
    await handleSetChatMessage(
      { fieldValues: { message: 'x' }, messageId: 5, opts: {} },
      'chat-1',
      0,
      api.chat,
    );
    expect(api.updates).toEqual([]);
  } finally {
    console.warn = restoreWarn;
  }
});

test('setChatMessage skips entirely on empty chat', async () => {
  const restoreWarn = console.warn;
  console.warn = mock(() => {});
  try {
    const api = makeChatApi(makeMessages([]));
    await handleSetChatMessage(
      { fieldValues: { message: 'x' }, messageId: 0, opts: {} },
      'chat-1',
      0,
      api.chat,
    );
    expect(api.updates).toEqual([]);
  } finally {
    console.warn = restoreWarn;
  }
});
