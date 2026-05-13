import { test, expect, mock } from 'bun:test';
import type { SpindleFrontendContext } from 'lumiverse-spindle-types';
import { handleClipboardWriteText, handleHostAlert } from './clipboard-shim';

interface DispatchCall { chatId: string; text: string }
interface ClipCall { text: string }
interface AlertCall { message: string }

function makeCtx(chatId: string | null): SpindleFrontendContext {
  return {
    getActiveChat: () => ({ chatId, characterId: null }),
    sendToBackend: () => {},
    onBackendMessage: () => () => {},
  } as unknown as SpindleFrontendContext;
}

// ── handleClipboardWriteText ────────────────────────────────────────────────

test('/setvar prefix dispatches, skips clipboard, records entry before await', async () => {
  const dispatched = new Map<string, number>();
  const clip: ClipCall[] = [];
  const disp: DispatchCall[] = [];
  await handleClipboardWriteText({ text: '/setvar key=yen 5000' }, makeCtx('chatX'), {
    clipboardWriteText: async (t) => { clip.push({ text: t }); },
    dispatch: async (_ctx, chatId, text) => { disp.push({ chatId, text }); return { handled: true, kind: 'setvar_chain' }; },
    recentlyDispatched: dispatched,
    now: () => 1000,
  });
  expect(disp).toEqual([{ chatId: 'chatX', text: '/setvar key=yen 5000' }]);
  expect(clip).toEqual([]);
  expect(dispatched.get('/setvar key=yen 5000')).toBe(1000);
});

test('non-whitelist text falls through to clipboard with no dispatch', async () => {
  const dispatched = new Map<string, number>();
  const clip: ClipCall[] = [];
  const disp: DispatchCall[] = [];
  await handleClipboardWriteText({ text: 'https://example.com' }, makeCtx('chatX'), {
    clipboardWriteText: async (t) => { clip.push({ text: t }); },
    dispatch: async (_ctx, chatId, text) => { disp.push({ chatId, text }); return { handled: true, kind: 'setvar_chain' }; },
    recentlyDispatched: dispatched,
  });
  expect(disp).toEqual([]);
  expect(clip).toEqual([{ text: 'https://example.com' }]);
  expect(dispatched.size).toBe(0);
});

test('null active chatId falls back to clipboard with warning', async () => {
  const restoreWarn = console.warn;
  console.warn = mock(() => {});
  try {
    const dispatched = new Map<string, number>();
    const clip: ClipCall[] = [];
    const disp: DispatchCall[] = [];
    await handleClipboardWriteText({ text: '/setvar key=yen 5000' }, makeCtx(null), {
      clipboardWriteText: async (t) => { clip.push({ text: t }); },
      dispatch: async (_ctx, chatId, text) => { disp.push({ chatId, text }); return { handled: true, kind: 'setvar_chain' }; },
      recentlyDispatched: dispatched,
    });
    expect(disp).toEqual([]);
    expect(clip).toEqual([{ text: '/setvar key=yen 5000' }]);
  } finally {
    console.warn = restoreWarn;
  }
});

test('dispatch throws sets entry before await then deletes in catch', async () => {
  const restoreWarn = console.warn;
  console.warn = mock(() => {});
  try {
    const dispatched = new Map<string, number>();
    const clip: ClipCall[] = [];
    await handleClipboardWriteText({ text: '/setvar key=yen 5000' }, makeCtx('chatX'), {
      clipboardWriteText: async (t) => { clip.push({ text: t }); },
      dispatch: async () => { throw new Error('boom'); },
      recentlyDispatched: dispatched,
    });
    expect(clip).toEqual([{ text: '/setvar key=yen 5000' }]);
    expect(dispatched.size).toBe(0);
  } finally {
    console.warn = restoreWarn;
  }
});

test('backend handled:false sets entry then deletes after', async () => {
  const dispatched = new Map<string, number>();
  const clip: ClipCall[] = [];
  await handleClipboardWriteText({ text: '/setvar key=yen 5000' }, makeCtx('chatX'), {
    clipboardWriteText: async (t) => { clip.push({ text: t }); },
    dispatch: async () => ({ handled: false, kind: 'none' as const }),
    recentlyDispatched: dispatched,
  });
  expect(clip).toEqual([{ text: '/setvar key=yen 5000' }]);
  expect(dispatched.size).toBe(0);
});

// ── handleHostAlert (temporal correlation only, no text whitelist) ──────────

test('alert with Anchor Soul-style text + recent dispatch is suppressed', () => {
  const dispatched = new Map<string, number>([['/setvar...', 900]]);
  const alerts: AlertCall[] = [];
  handleHostAlert({ message: 'Security Sandbox Active! Please copy this manually.' }, {
    alert: (m) => { alerts.push({ message: m }); },
    recentlyDispatched: dispatched,
    now: () => 1000,
  });
  expect(alerts).toEqual([]);
});

test('alert with Mission Board-style text + recent dispatch is suppressed', () => {
  const dispatched = new Map<string, number>([['/setvar...', 900]]);
  const alerts: AlertCall[] = [];
  handleHostAlert({ message: 'Sandbox active — copied to clipboard.' }, {
    alert: (m) => { alerts.push({ message: m }); },
    recentlyDispatched: dispatched,
    now: () => 1000,
  });
  expect(alerts).toEqual([]);
});

test('alert with arbitrary text + recent dispatch is suppressed', () => {
  const dispatched = new Map<string, number>([['/setvar...', 900]]);
  const alerts: AlertCall[] = [];
  handleHostAlert({ message: 'Are you sure?' }, {
    alert: (m) => { alerts.push({ message: m }); },
    recentlyDispatched: dispatched,
    now: () => 1000,
  });
  expect(alerts).toEqual([]);
});

test('alert with no recent dispatch fires', () => {
  const dispatched = new Map<string, number>();
  const alerts: AlertCall[] = [];
  handleHostAlert({ message: 'Security Sandbox Active!' }, {
    alert: (m) => { alerts.push({ message: m }); },
    recentlyDispatched: dispatched,
    now: () => 1000,
  });
  expect(alerts).toEqual([{ message: 'Security Sandbox Active!' }]);
});

test('alert with stale dispatch (>1000ms) fires', () => {
  const dispatched = new Map<string, number>([['/setvar...', 900]]);
  const alerts: AlertCall[] = [];
  handleHostAlert({ message: 'Security Sandbox Active!' }, {
    alert: (m) => { alerts.push({ message: m }); },
    recentlyDispatched: dispatched,
    now: () => 2000,
  });
  expect(alerts).toEqual([{ message: 'Security Sandbox Active!' }]);
});
