import { test, expect, mock } from 'bun:test';
import { applyAndStripSetvars } from './macro-resolve';
import type { VarsApi } from './setvar-ops';

interface Call { scope: 'local' | 'chat' | 'global'; args: unknown[] }

function makeFakeVars(opts?: { throwOn?: { scope: 'local' | 'chat' | 'global'; key: string } }): { vars: VarsApi; calls: Call[] } {
  const calls: Call[] = [];
  const mk = (scope: 'local' | 'chat' | 'global') => async (...args: unknown[]) => {
    const keyArg = scope === 'global' ? args[0] : args[1];
    if (opts?.throwOn && opts.throwOn.scope === scope && opts.throwOn.key === keyArg) {
      throw new Error(`fake set throws for ${scope}/${keyArg}`);
    }
    calls.push({ scope, args });
  };
  const vars = {
    local: { set: mk('local') },
    chat: { set: mk('chat') },
    global: { set: mk('global') },
  } as unknown as VarsApi;
  return { vars, calls };
}

const CHAT = 'chatX';
const USER = 'userX';

test('single setvar local applies and is stripped', async () => {
  const { vars, calls } = makeFakeVars();
  const out = await applyAndStripSetvars('{{setvar::yen::5000}}foo', CHAT, USER, vars);
  expect(out).toBe('foo');
  expect(calls).toEqual([{ scope: 'local', args: [CHAT, 'yen', '5000'] }]);
});

test('multiple setvars apply in order and are all stripped', async () => {
  const { vars, calls } = makeFakeVars();
  const out = await applyAndStripSetvars('{{setvar::yen::5000}}{{setvar::grade::Grade 2}}foo', CHAT, USER, vars);
  expect(out).toBe('foo');
  expect(calls).toEqual([
    { scope: 'local', args: [CHAT, 'yen', '5000'] },
    { scope: 'local', args: [CHAT, 'grade', 'Grade 2'] },
  ]);
});

test('duplicate name applied in document order', async () => {
  const { vars, calls } = makeFakeVars();
  const out = await applyAndStripSetvars('{{setvar::yen::5000}}foo{{setvar::yen::6000}}bar', CHAT, USER, vars);
  expect(out).toBe('foobar');
  expect(calls).toEqual([
    { scope: 'local', args: [CHAT, 'yen', '5000'] },
    { scope: 'local', args: [CHAT, 'yen', '6000'] },
  ]);
});

test('invalid NAME left in template, not applied', async () => {
  const { vars, calls } = makeFakeVars();
  const out = await applyAndStripSetvars('{{setvar::1bad::x}}foo', CHAT, USER, vars);
  expect(out).toBe('{{setvar::1bad::x}}foo');
  expect(calls).toEqual([]);
});

test('setgvar disabled — not stripped, no call', async () => {
  const restoreDebug = console.debug;
  console.debug = mock(() => {});
  try {
    const { vars, calls } = makeFakeVars();
    const out = await applyAndStripSetvars('{{setgvar::level::99}}foo', CHAT, USER, vars);
    expect(out).toBe('{{setgvar::level::99}}foo');
    expect(calls).toEqual([]);
  } finally {
    console.debug = restoreDebug;
  }
});

test('setglobalvar disabled — not stripped, no call', async () => {
  const restoreDebug = console.debug;
  console.debug = mock(() => {});
  try {
    const { vars, calls } = makeFakeVars();
    const out = await applyAndStripSetvars('{{setglobalvar::level::99}}foo', CHAT, USER, vars);
    expect(out).toBe('{{setglobalvar::level::99}}foo');
    expect(calls).toEqual([]);
  } finally {
    console.debug = restoreDebug;
  }
});

test('setchatvar routes to chat namespace', async () => {
  const { vars, calls } = makeFakeVars();
  const out = await applyAndStripSetvars('{{setchatvar::loc::Tokyo}}foo', CHAT, USER, vars);
  expect(out).toBe('foo');
  expect(calls).toEqual([{ scope: 'chat', args: [CHAT, 'loc', 'Tokyo'] }]);
});

test('JSX inline style untouched, setvar stripped', async () => {
  const { vars, calls } = makeFakeVars();
  const input = `<div style={{position:'absolute'}}>{{setvar::yen::5000}}</div>`;
  const out = await applyAndStripSetvars(input, CHAT, USER, vars);
  expect(out).toBe(`<div style={{position:'absolute'}}></div>`);
  expect(calls).toEqual([{ scope: 'local', args: [CHAT, 'yen', '5000'] }]);
});

test('empty value', async () => {
  const { vars, calls } = makeFakeVars();
  const out = await applyAndStripSetvars('{{setvar::yen::}}foo', CHAT, USER, vars);
  expect(out).toBe('foo');
  expect(calls).toEqual([{ scope: 'local', args: [CHAT, 'yen', ''] }]);
});

test('set throws → match not stripped', async () => {
  const restoreWarn = console.warn;
  console.warn = mock(() => {});
  try {
    const { vars, calls } = makeFakeVars({ throwOn: { scope: 'local', key: 'yen' } });
    const out = await applyAndStripSetvars('{{setvar::yen::5000}}foo', CHAT, USER, vars);
    expect(out).toBe('{{setvar::yen::5000}}foo');
    expect(calls).toEqual([]);
  } finally {
    console.warn = restoreWarn;
  }
});

test('mix setvar + getvar — setvar stripped, getvar untouched', async () => {
  const { vars, calls } = makeFakeVars();
  const out = await applyAndStripSetvars('{{setvar::yen::5000}}precio={{getvar::yen}}', CHAT, USER, vars);
  expect(out).toBe('precio={{getvar::yen}}');
  expect(calls).toEqual([{ scope: 'local', args: [CHAT, 'yen', '5000'] }]);
});
