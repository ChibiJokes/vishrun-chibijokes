import { test, expect } from 'bun:test';
import { createMvuHelpers, MVU_EVENTS, mvuShim } from './mvu-shim';
import type { MvuData } from '../backend/mvu-parser';

function makeSnapshot(stat: Record<string, unknown> = {}): MvuData {
  return { stat_data: stat };
}

test('MVU_EVENTS exposes the JSR-canonical strings', () => {
  expect(MVU_EVENTS.VARIABLE_INITIALIZED).toBe('mag_variable_initiailized');
  expect(MVU_EVENTS.VARIABLE_UPDATE_STARTED).toBe('mag_variable_update_started');
  expect(MVU_EVENTS.COMMAND_PARSED).toBe('mag_command_parsed');
  expect(MVU_EVENTS.VARIABLE_UPDATE_ENDED).toBe('mag_variable_update_ended');
  expect(MVU_EVENTS.BEFORE_MESSAGE_UPDATE).toBe('mag_before_message_update');
});

test('getAllVariables returns the baked snapshot reference', () => {
  const snap = makeSnapshot({ '世界': { '当前时间': '14:30' } });
  const h = createMvuHelpers({ variablesSnapshot: snap });
  expect(h.getAllVariables()).toBe(snap);
});

test('Mvu.getMvuData returns the same snapshot', () => {
  const snap = makeSnapshot({ a: 1 });
  const h = createMvuHelpers({ variablesSnapshot: snap });
  expect(h.Mvu.getMvuData()).toBe(snap);
});

test('Mvu.events is on the Mvu surface for eventOn(Mvu.events.X) pattern', () => {
  const h = createMvuHelpers({ variablesSnapshot: makeSnapshot() });
  expect(h.Mvu.events.VARIABLE_UPDATE_ENDED).toBe('mag_variable_update_ended');
});

test('waitGlobalInitialized("Mvu") resolves immediately', async () => {
  const h = createMvuHelpers({ variablesSnapshot: makeSnapshot() });
  await h.waitGlobalInitialized('Mvu');
});

test('waitGlobalInitialized for unknown name stays pending (not testable directly — verify return type)', async () => {
  const h = createMvuHelpers({ variablesSnapshot: makeSnapshot() });
  const p = h.waitGlobalInitialized('SomethingElse');
  // Race with a 30ms timer; the unknown-name promise must not resolve.
  const result = await Promise.race([p.then(() => 'resolved'), new Promise((r) => setTimeout(() => r('pending'), 30))]);
  expect(result).toBe('pending');
});

test('eventOn registers listener; eventEmit fires it with args', () => {
  const h = createMvuHelpers({ variablesSnapshot: makeSnapshot() });
  const calls: unknown[][] = [];
  h.eventOn('foo', (...args) => calls.push(args));
  h.eventEmit('foo', 1, 'two');
  h.eventEmit('foo', 3);
  expect(calls).toEqual([[1, 'two'], [3]]);
});

test('eventOnce only fires the listener once', () => {
  const h = createMvuHelpers({ variablesSnapshot: makeSnapshot() });
  let n = 0;
  h.eventOnce('foo', () => { n++; });
  h.eventEmit('foo');
  h.eventEmit('foo');
  expect(n).toBe(1);
});

test('eventRemoveListener stops further firings', () => {
  const h = createMvuHelpers({ variablesSnapshot: makeSnapshot() });
  let n = 0;
  const fn = () => { n++; };
  h.eventOn('foo', fn);
  h.eventEmit('foo');
  h.eventRemoveListener('foo', fn);
  h.eventEmit('foo');
  expect(n).toBe(1);
});

test('eventClearAll drops all listeners across events', () => {
  const h = createMvuHelpers({ variablesSnapshot: makeSnapshot() });
  let n = 0;
  h.eventOn('a', () => { n++; });
  h.eventOn('b', () => { n++; });
  h.eventClearAll();
  h.eventEmit('a');
  h.eventEmit('b');
  expect(n).toBe(0);
});

test('eventOn — listener that throws does not break other listeners', () => {
  const h = createMvuHelpers({ variablesSnapshot: makeSnapshot() });
  const restoreWarn = console.warn;
  console.warn = () => {};
  try {
    let n = 0;
    h.eventOn('foo', () => { throw new Error('first failed'); });
    h.eventOn('foo', () => { n++; });
    h.eventEmit('foo');
    expect(n).toBe(1);
  } finally {
    console.warn = restoreWarn;
  }
});

test('errorCatched wraps a function and rethrows after logging', () => {
  const h = createMvuHelpers({ variablesSnapshot: makeSnapshot() });
  const restoreErr = console.error;
  console.error = () => {};
  try {
    const wrapped = h.errorCatched(() => { throw new Error('boom'); });
    expect(() => wrapped()).toThrow('boom');
  } finally {
    console.error = restoreErr;
  }
});

test('errorCatched passes args + return through when no throw', () => {
  const h = createMvuHelpers({ variablesSnapshot: makeSnapshot() });
  const wrapped = h.errorCatched((a: number, b: number) => a + b);
  expect(wrapped(2, 3)).toBe(5);
});

test('Queen Bee Status Bar end-to-end pattern with the twin', async () => {
  // Simulates: $(errorCatched(init)) where init calls waitGlobalInitialized
  // then populateCharacterData (read variables) then eventOn(VARIABLE_UPDATE_ENDED).
  const snap = makeSnapshot({
    '世界': { '当前时间': '14:30', '当前地点': 'Campus' },
    '状态': { '校园声望': 500 },
  });
  const h = createMvuHelpers({ variablesSnapshot: snap });
  let populated = 0;
  function populate() {
    const all = h.getAllVariables();
    const stat = all.stat_data as Record<string, Record<string, unknown>>;
    expect(stat['世界']['当前时间']).toBe('14:30');
    expect(stat['状态']['校园声望']).toBe(500);
    populated++;
  }
  const init = h.errorCatched(async () => {
    await h.waitGlobalInitialized('Mvu');
    populate();
    h.eventOn(h.Mvu.events.VARIABLE_UPDATE_ENDED, populate);
  });
  await init();
  expect(populated).toBe(1);
  // Firing the event should re-run populate.
  h.eventEmit(h.Mvu.events.VARIABLE_UPDATE_ENDED);
  expect(populated).toBe(2);
});

test('mvuShim string bakes the variables snapshot and defines window.Mvu', () => {
  const snap = makeSnapshot({ X: { Y: 1 } });
  const out = mvuShim({ variablesSnapshot: snap });
  expect(out.startsWith('<script>')).toBe(true);
  expect(out.endsWith('</script>')).toBe(true);
  expect(out.includes('"X":{"Y":1}')).toBe(true);
  expect(out.includes('window.Mvu')).toBe(true);
  expect(out.includes('window.getAllVariables')).toBe(true);
  expect(out.includes('window.waitGlobalInitialized')).toBe(true);
  expect(out.includes('window.eventOn')).toBe(true);
  expect(out.includes('window.errorCatched')).toBe(true);
  expect(out.includes('mag_variable_update_ended')).toBe(true);
});
