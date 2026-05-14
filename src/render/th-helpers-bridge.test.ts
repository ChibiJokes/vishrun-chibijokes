import { test, expect, beforeEach } from 'bun:test';
import { computeMessageIndexInChat, isThRequest, dispatchThRequest } from './th-helpers-bridge';

beforeEach(() => {
  document.body.innerHTML = '';
});

test('computeMessageIndexInChat returns DOM order for matching uuid', () => {
  const root = document.createElement('div');
  ['a', 'b', 'c'].forEach((id) => {
    const el = document.createElement('div');
    el.setAttribute('data-message-id', id);
    root.appendChild(el);
  });
  document.body.appendChild(root);
  expect(computeMessageIndexInChat('a')).toBe(0);
  expect(computeMessageIndexInChat('b')).toBe(1);
  expect(computeMessageIndexInChat('c')).toBe(2);
});

test('computeMessageIndexInChat returns -1 for missing id', () => {
  expect(computeMessageIndexInChat('absent')).toBe(-1);
});

test('isThRequest accepts well-formed payload', () => {
  expect(isThRequest({ kind: 'th-request', requestId: 'r1', op: 'th-get-chat-messages', body: { range: 0 } })).toBe(true);
});

test('isThRequest rejects malformed payloads', () => {
  expect(isThRequest(null)).toBe(false);
  expect(isThRequest({ kind: 'wrong', requestId: 'r1', op: 'x', body: {} })).toBe(false);
  expect(isThRequest({ kind: 'th-request' })).toBe(false);
  expect(isThRequest({ kind: 'th-request', requestId: 'r1', op: 'x' })).toBe(false);
  expect(isThRequest({ kind: 'th-request', requestId: 'r1', op: 'x', body: 'not-obj' })).toBe(false);
});

interface FakeFrame {
  posted: Array<unknown>;
  postMessage(p: unknown): void;
}

interface FakeCtx {
  sent: unknown[];
  listeners: Array<(p: unknown) => void>;
  sendToBackend(p: unknown): void;
  onBackendMessage(h: (p: unknown) => void): () => void;
}

function makeFakeFrame(): FakeFrame {
  return {
    posted: [],
    postMessage(p: unknown) { this.posted.push(p); },
  };
}

function makeFakeCtx(): FakeCtx {
  const listeners: Array<(p: unknown) => void> = [];
  return {
    sent: [],
    listeners,
    sendToBackend(p: unknown) { this.sent.push(p); },
    onBackendMessage(h) {
      listeners.push(h);
      return () => {
        const i = listeners.indexOf(h);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
  };
}

test('dispatchThRequest forwards to backend with the same requestId', () => {
  const frame = makeFakeFrame();
  const ctx = makeFakeCtx();
  dispatchThRequest(
    frame as unknown as Parameters<typeof dispatchThRequest>[0],
    { kind: 'th-request', requestId: 'r1', op: 'th-get-chat-messages', body: { range: 0 } },
    { chatId: 'c', currentMessageId: 'mid', currentMessageIndex: 2 },
    ctx as unknown as Parameters<typeof dispatchThRequest>[3],
  );
  expect(ctx.sent.length).toBe(1);
  const s = ctx.sent[0] as Record<string, unknown>;
  expect(s.type).toBe('th_helpers_request');
  expect(s.requestId).toBe('r1');
  expect(s.op).toBe('th-get-chat-messages');
  expect(s.chatId).toBe('c');
  expect(s.currentMessageIndex).toBe(2);
});

test('dispatchThRequest posts response to iframe when backend replies with matching requestId', () => {
  const frame = makeFakeFrame();
  const ctx = makeFakeCtx();
  dispatchThRequest(
    frame as unknown as Parameters<typeof dispatchThRequest>[0],
    { kind: 'th-request', requestId: 'rid', op: 'th-get-chat-messages', body: { range: 0 } },
    { chatId: 'c', currentMessageId: 'mid', currentMessageIndex: 0 },
    ctx as unknown as Parameters<typeof dispatchThRequest>[3],
  );
  expect(ctx.listeners.length).toBe(1);
  ctx.listeners[0]({ type: 'th_helpers_response', requestId: 'rid', ok: true, result: [{ a: 1 }] });
  expect(frame.posted.length).toBe(1);
  const r = frame.posted[0] as Record<string, unknown>;
  expect(r.kind).toBe('th-response');
  expect(r.requestId).toBe('rid');
  expect(r.ok).toBe(true);
  expect(r.result).toEqual([{ a: 1 }]);
  expect(ctx.listeners.length).toBe(0);
});

test('dispatchThRequest ignores responses for other requestIds', () => {
  const frame = makeFakeFrame();
  const ctx = makeFakeCtx();
  dispatchThRequest(
    frame as unknown as Parameters<typeof dispatchThRequest>[0],
    { kind: 'th-request', requestId: 'rid', op: 'op', body: {} },
    { chatId: 'c', currentMessageId: 'mid', currentMessageIndex: 0 },
    ctx as unknown as Parameters<typeof dispatchThRequest>[3],
  );
  ctx.listeners[0]({ type: 'th_helpers_response', requestId: 'OTHER', ok: true });
  expect(frame.posted).toEqual([]);
  expect(ctx.listeners.length).toBe(1);
});

test('dispatchThRequest forwards backend error', () => {
  const frame = makeFakeFrame();
  const ctx = makeFakeCtx();
  dispatchThRequest(
    frame as unknown as Parameters<typeof dispatchThRequest>[0],
    { kind: 'th-request', requestId: 'rid', op: 'op', body: {} },
    { chatId: 'c', currentMessageId: 'mid', currentMessageIndex: 0 },
    ctx as unknown as Parameters<typeof dispatchThRequest>[3],
  );
  ctx.listeners[0]({ type: 'th_helpers_response', requestId: 'rid', ok: false, error: 'boom' });
  const r = frame.posted[0] as Record<string, unknown>;
  expect(r.ok).toBe(false);
  expect(r.error).toBe('boom');
});
