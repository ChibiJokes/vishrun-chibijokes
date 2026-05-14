import { test, expect } from 'bun:test';
import { createThHelpers, thHelpersShim } from './th-helpers-shim';

function makeBridge(handler: (kind: string, body: Record<string, unknown>) => unknown) {
  const calls: Array<{ kind: string; body: Record<string, unknown> }> = [];
  return {
    calls,
    bridge: {
      async postRequest(kind: string, payload: Record<string, unknown>) {
        calls.push({ kind, body: payload });
        return handler(kind, payload);
      },
    },
  };
}

test('getCurrentMessageId returns baked-in index sync', () => {
  const consts = { currentMessageIndex: 3, currentMessageId: 'uuid-3', chatId: 'chat-x' };
  const helpers = createThHelpers(consts, { postRequest: async () => null });
  expect(helpers.getCurrentMessageId()).toBe(3);
});

test('getChatId returns baked-in id sync', () => {
  const consts = { currentMessageIndex: 0, currentMessageId: 'uuid-0', chatId: 'chat-x' };
  const helpers = createThHelpers(consts, { postRequest: async () => null });
  expect(helpers.getChatId()).toBe('chat-x');
});

test('getChatMessages forwards range and opts via postRequest', async () => {
  const fake = makeBridge(() => [{ message_id: 0, message: 'hi' }]);
  const helpers = createThHelpers(
    { currentMessageIndex: 0, currentMessageId: 'u', chatId: 'c' },
    fake.bridge,
  );
  const out = await helpers.getChatMessages('0', { include_swipe: true });
  expect(fake.calls).toEqual([
    { kind: 'th-get-chat-messages', body: { range: '0', opts: { include_swipe: true } } },
  ]);
  expect(out).toEqual([{ message_id: 0, message: 'hi' }]);
});

test('getChatMessages with no opts passes empty opts', async () => {
  const fake = makeBridge(() => []);
  const helpers = createThHelpers(
    { currentMessageIndex: 0, currentMessageId: 'u', chatId: 'c' },
    fake.bridge,
  );
  await helpers.getChatMessages(0);
  expect(fake.calls[0].body).toEqual({ range: 0, opts: {} });
});

test('setChatMessage normalizes string fieldValues to { message }', async () => {
  const fake = makeBridge(() => undefined);
  const helpers = createThHelpers(
    { currentMessageIndex: 0, currentMessageId: 'u', chatId: 'c' },
    fake.bridge,
  );
  await helpers.setChatMessage('new content', 0, { swipe_id: 1 });
  expect(fake.calls).toEqual([
    {
      kind: 'th-set-chat-message',
      body: {
        fieldValues: { message: 'new content' },
        messageId: 0,
        opts: { swipe_id: 1 },
      },
    },
  ]);
});

test('setChatMessage passes object fieldValues unchanged', async () => {
  const fake = makeBridge(() => undefined);
  const helpers = createThHelpers(
    { currentMessageIndex: 0, currentMessageId: 'u', chatId: 'c' },
    fake.bridge,
  );
  await helpers.setChatMessage({ message: 'x', data: { y: 1 } } as Record<string, unknown>, 0, {});
  expect(fake.calls[0].body.fieldValues).toEqual({ message: 'x', data: { y: 1 } });
});

test('getChatMessages bubbles up bridge errors', async () => {
  const helpers = createThHelpers(
    { currentMessageIndex: 0, currentMessageId: 'u', chatId: 'c' },
    {
      async postRequest() {
        throw new Error('bridge down');
      },
    },
  );
  await expect(helpers.getChatMessages(0)).rejects.toThrow('bridge down');
});

test('thHelpersShim produces a script with baked constants and request plumbing', () => {
  const out = thHelpersShim({ currentMessageIndex: 7, currentMessageId: 'abc', chatId: 'chatZ' });
  expect(out.startsWith('<script>')).toBe(true);
  expect(out.includes('"currentMessageIndex":7')).toBe(true);
  expect(out.includes('"currentMessageId":"abc"')).toBe(true);
  expect(out.includes('"chatId":"chatZ"')).toBe(true);
  expect(out.includes("window.getCurrentMessageId = function()")).toBe(true);
  expect(out.includes("window.getChatId = function()")).toBe(true);
  expect(out.includes('th-get-chat-messages')).toBe(true);
  expect(out.includes('th-set-chat-message')).toBe(true);
  expect(out.includes("'th-request'")).toBe(true);
});
