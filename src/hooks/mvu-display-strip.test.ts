import { test, expect } from 'bun:test';
import type { SpindleFrontendContext } from 'lumiverse-spindle-types';
import { registerMvuDisplayStrip } from './mvu-display-strip';

interface RegisterCall {
  options: { tagName: string; removeFromMessage?: boolean };
  handler: (...args: unknown[]) => unknown;
}

function makeCtx() {
  const calls: RegisterCall[] = [];
  let unsubCalled = false;
  const ctx = {
    messages: {
      registerTagInterceptor(options: RegisterCall['options'], handler: RegisterCall['handler']) {
        calls.push({ options, handler });
        return () => { unsubCalled = true; };
      },
    },
  } as unknown as SpindleFrontendContext;
  return { ctx, calls, getUnsubCalled: () => unsubCalled };
}

test('registerMvuDisplayStrip registers a tag interceptor for the lowercase tagName', () => {
  const { ctx, calls } = makeCtx();
  registerMvuDisplayStrip(ctx);
  expect(calls).toHaveLength(1);
  expect(calls[0].options.tagName).toBe('updatevariable');
});

test('registerMvuDisplayStrip uses removeFromMessage:true (display-only strip)', () => {
  const { ctx, calls } = makeCtx();
  registerMvuDisplayStrip(ctx);
  expect(calls[0].options.removeFromMessage).toBe(true);
});

test('registerMvuDisplayStrip handler is a no-op (does not throw, returns nothing)', () => {
  const { ctx, calls } = makeCtx();
  registerMvuDisplayStrip(ctx);
  expect(() => calls[0].handler({ tagName: 'updatevariable', content: 'whatever' })).not.toThrow();
});

test('registerMvuDisplayStrip returns the unsubscribe function from registerTagInterceptor', () => {
  const { ctx, getUnsubCalled } = makeCtx();
  const unsub = registerMvuDisplayStrip(ctx);
  expect(getUnsubCalled()).toBe(false);
  unsub();
  expect(getUnsubCalled()).toBe(true);
});
