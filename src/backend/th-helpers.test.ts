import { test, expect, mock } from 'bun:test';
import { handleGetMessagesSnapshot, handleSetChatMessage } from './th-helpers';

function makeMessages(specs: Array<{ id?: string; content: string; swipes?: string[]; swipeId?: number; isUser?: boolean; extra?: Record<string, unknown> }>) {
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
    extra: s.extra ?? {},
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

test('handleGetMessagesSnapshot returns rich shape per message with .message and .swipes', async () => {
  const api = makeChatApi(makeMessages([
    { content: 'greeting', swipes: ['greeting', 'alt1', 'alt2'], swipeId: 0 },
    { content: 'user line', isUser: true },
    { content: 'assistant reply', swipes: ['assistant reply'], swipeId: 0, extra: { reason: 'ok' } },
  ]));
  const snap = await handleGetMessagesSnapshot('chat-1', api.chat);
  expect(snap.length).toBe(3);
  expect(snap[0]).toEqual({
    message_id: 0,
    name: 'char',
    role: 'assistant',
    is_hidden: false,
    message: 'greeting',
    swipe_id: 0,
    swipes: ['greeting', 'alt1', 'alt2'],
    data: {},
    extra: {},
  });
  expect(snap[1].role).toBe('user');
  expect(snap[1].name).toBe('user');
  expect(snap[2].extra).toEqual({ reason: 'ok' });
});

test('handleGetMessagesSnapshot fills swipes with [content] when message has no swipes array', async () => {
  const api = makeChatApi(makeMessages([{ content: 'solo' }]));
  // Simulate a row whose .swipes is empty (some old chats).
  (api.getMessages()[0] as { swipes: string[] }).swipes = [];
  const snap = await handleGetMessagesSnapshot('chat-1', api.chat);
  expect(snap[0].swipes).toEqual(['solo']);
});

test('handleGetMessagesSnapshot on empty chat returns []', async () => {
  const api = makeChatApi(makeMessages([]));
  const snap = await handleGetMessagesSnapshot('chat-1', api.chat);
  expect(snap).toEqual([]);
});

test('handleSetChatMessage writes content patch via updateMessage', async () => {
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

test('handleSetChatMessage without swipe_id omits it from patch', async () => {
  const api = makeChatApi(makeMessages([{ content: 'a' }]));
  await handleSetChatMessage(
    { fieldValues: { message: 'b' }, messageId: 0, opts: {} },
    'chat-1',
    0,
    api.chat,
  );
  expect(api.updates[0].patch).toEqual({ content: 'b' });
});

test('handleSetChatMessage ignores write when message field missing', async () => {
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

test('handleSetChatMessage ignores write on out-of-range message id', async () => {
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

test('handleSetChatMessage skips on empty chat', async () => {
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

test('handleSetChatMessage resolves messageId="0" string to first message', async () => {
  const api = makeChatApi(makeMessages([{ content: 'orig' }]));
  await handleSetChatMessage(
    { fieldValues: { message: 'new' }, messageId: '0', opts: {} },
    'chat-1',
    0,
    api.chat,
  );
  expect(api.updates[0].messageId).toBe('msg-0');
});

test('handleSetChatMessage with negative messageId counts from end', async () => {
  const api = makeChatApi(makeMessages([{ content: 'a' }, { content: 'b' }, { content: 'c' }]));
  await handleSetChatMessage(
    { fieldValues: { message: 'new' }, messageId: -1, opts: {} },
    'chat-1',
    0,
    api.chat,
  );
  expect(api.updates[0].messageId).toBe('msg-2');
});
