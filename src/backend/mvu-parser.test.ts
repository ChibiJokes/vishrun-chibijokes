import { test, expect } from 'bun:test';
import {
  applyMvuCommands,
  applyOperation,
  computeVariablesSnapshot,
  emptyMvuData,
  extractUpdateVariableBlocks,
  InitvarYamlRecognizer,
  LodashSetRecognizer,
  lodashSet,
  parseMvuBlocks,
  recognizers,
  resolveActiveContent,
  type MvuData,
  type Operation,
  type ReplaceStatDataOp,
  type SetPathOp,
} from './mvu-parser';

// ---- legacy _.set parser (kept for Phase 2a) ----

test('lodashSet writes a leaf at a dot-separated path, creating intermediates', () => {
  const obj: Record<string, unknown> = {};
  lodashSet(obj, 'a.b.c', 5);
  expect(obj).toEqual({ a: { b: { c: 5 } } });
});

test('lodashSet replaces existing primitives along the way', () => {
  const obj: Record<string, unknown> = { a: 1 };
  lodashSet(obj, 'a.b.c', 'x');
  expect(obj).toEqual({ a: { b: { c: 'x' } } });
});

test('lodashSet overwrites existing leaf', () => {
  const obj: Record<string, unknown> = { a: { b: 'old' } };
  lodashSet(obj, 'a.b', 'new');
  expect(obj).toEqual({ a: { b: 'new' } });
});

test('lodashSet supports unicode (CJK) path segments', () => {
  const obj: Record<string, unknown> = {};
  lodashSet(obj, '世界.当前时间', '14:30');
  expect(obj).toEqual({ '世界': { '当前时间': '14:30' } });
});

test('parseMvuBlocks: no UpdateVariable blocks -> no commands and unchanged content', () => {
  const out = parseMvuBlocks('hello world');
  expect(out.commands).toEqual([]);
  expect(out.strippedContent).toBe('hello world');
});

test('parseMvuBlocks: single block, single set with string value', () => {
  const out = parseMvuBlocks(`before <UpdateVariable>_.set('stat_data.世界.当前时间', '14:30')</UpdateVariable> after`);
  expect(out.commands).toEqual([{ path: 'stat_data.世界.当前时间', value: '14:30' }]);
  expect(out.strippedContent).toBe('before  after');
});

test('parseMvuBlocks: multiple sets in one block', () => {
  const out = parseMvuBlocks(`<UpdateVariable>
    _.set('stat_data.X', 'a')
    _.set('stat_data.Y', 'b')
  </UpdateVariable>`);
  expect(out.commands).toEqual([
    { path: 'stat_data.X', value: 'a' },
    { path: 'stat_data.Y', value: 'b' },
  ]);
});

test('parseMvuBlocks: multiple blocks combined', () => {
  const out = parseMvuBlocks(`<UpdateVariable>_.set('a','1')</UpdateVariable>middle<UpdateVariable>_.set('b','2')</UpdateVariable>`);
  expect(out.commands).toEqual([
    { path: 'a', value: '1' },
    { path: 'b', value: '2' },
  ]);
  expect(out.strippedContent).toBe('middle');
});

test('parseMvuBlocks: number value', () => {
  const out = parseMvuBlocks(`<UpdateVariable>_.set('rep', 500)</UpdateVariable>`);
  expect(out.commands).toEqual([{ path: 'rep', value: 500 }]);
});

test('parseMvuBlocks: negative + float numbers', () => {
  const out = parseMvuBlocks(`<UpdateVariable>_.set('a', -5)_.set('b', 3.14)</UpdateVariable>`);
  expect(out.commands).toEqual([
    { path: 'a', value: -5 },
    { path: 'b', value: 3.14 },
  ]);
});

test('parseMvuBlocks: boolean and null primitives', () => {
  const out = parseMvuBlocks(`<UpdateVariable>_.set('a', true)_.set('b', false)_.set('c', null)</UpdateVariable>`);
  expect(out.commands).toEqual([
    { path: 'a', value: true },
    { path: 'b', value: false },
    { path: 'c', value: null },
  ]);
});

test('parseMvuBlocks: double-quoted strings supported', () => {
  const out = parseMvuBlocks(`<UpdateVariable>_.set("path", "value")</UpdateVariable>`);
  expect(out.commands).toEqual([{ path: 'path', value: 'value' }]);
});

test('parseMvuBlocks: tolerant to whitespace around args', () => {
  const out = parseMvuBlocks(`<UpdateVariable>_.set(  'p'  ,  'v'  )</UpdateVariable>`);
  expect(out.commands).toEqual([{ path: 'p', value: 'v' }]);
});

test('parseMvuBlocks: unmatched <UpdateVariable> not consumed by greedy match', () => {
  const out = parseMvuBlocks(`<UpdateVariable>_.set('a','1')</UpdateVariable> text <UpdateVariable> with no close`);
  expect(out.commands).toEqual([{ path: 'a', value: '1' }]);
  expect(out.strippedContent.includes('<UpdateVariable> with no close')).toBe(true);
});

test('applyMvuCommands writes paths into blob.stat_data via the canonical prefix', () => {
  const blob = emptyMvuData();
  applyMvuCommands(blob, [
    { path: 'stat_data.世界.当前时间', value: '14:30' },
    { path: 'stat_data.状态.校园声望', value: 500 },
  ]);
  expect(blob).toEqual({
    stat_data: {
      '世界': { '当前时间': '14:30' },
      '状态': { '校园声望': 500 },
    },
  });
});

test('applyMvuCommands sequential writes accumulate on the same blob', () => {
  const blob = emptyMvuData();
  applyMvuCommands(blob, [{ path: 'stat_data.a', value: 1 }]);
  applyMvuCommands(blob, [{ path: 'stat_data.b', value: 2 }]);
  expect(blob.stat_data).toEqual({ a: 1, b: 2 });
});

// ---- V1 pipeline: extractUpdateVariableBlocks ----

test('extractUpdateVariableBlocks: no blocks returns []', () => {
  expect(extractUpdateVariableBlocks('plain text')).toEqual([]);
});

test('extractUpdateVariableBlocks: single block returns body', () => {
  expect(extractUpdateVariableBlocks('a<UpdateVariable>BODY</UpdateVariable>b')).toEqual(['BODY']);
});

test('extractUpdateVariableBlocks: multiple blocks preserved in document order', () => {
  const out = extractUpdateVariableBlocks(
    'x<UpdateVariable>one</UpdateVariable>y<UpdateVariable>two</UpdateVariable>z',
  );
  expect(out).toEqual(['one', 'two']);
});

test('extractUpdateVariableBlocks: lowercase tag matches (case-insensitive)', () => {
  expect(extractUpdateVariableBlocks('<updatevariable>x</updatevariable>')).toEqual(['x']);
});

test('extractUpdateVariableBlocks: multiline body preserved', () => {
  const out = extractUpdateVariableBlocks('<UpdateVariable>\nline1\nline2\n</UpdateVariable>');
  expect(out).toEqual(['\nline1\nline2\n']);
});

test('extractUpdateVariableBlocks: non-string input returns []', () => {
  expect(extractUpdateVariableBlocks(null as unknown as string)).toEqual([]);
  expect(extractUpdateVariableBlocks(undefined as unknown as string)).toEqual([]);
});

// ---- V1 pipeline: InitvarYamlRecognizer ----

test('InitvarYamlRecognizer: extracts one op per <initvar> block', () => {
  const block = '<initvar>\na: 1\n</initvar>';
  const ops = InitvarYamlRecognizer.extract(block);
  expect(ops).toHaveLength(1);
  expect(ops[0].kind).toBe('replace_stat_data');
  expect((ops[0] as ReplaceStatDataOp).payload).toEqual({ a: 1 });
});

test('InitvarYamlRecognizer: no <initvar> returns []', () => {
  expect(InitvarYamlRecognizer.extract('no initvar here')).toEqual([]);
});

test('InitvarYamlRecognizer: lowercase + optional code-fence wrapper tolerated', () => {
  const block = '<initvar>\n```yaml\na: 1\nb: 2\n```\n</initvar>';
  const ops = InitvarYamlRecognizer.extract(block);
  expect(ops).toHaveLength(1);
  expect((ops[0] as ReplaceStatDataOp).payload).toEqual({ a: 1, b: 2 });
});

test('InitvarYamlRecognizer: op carries index for ordering', () => {
  const block = 'prefix-padding<initvar>a: 1</initvar>';
  const ops = InitvarYamlRecognizer.extract(block);
  expect(ops[0].index).toBe(block.indexOf('<initvar>'));
});

test('InitvarYamlRecognizer: multiple <initvar> in one block emits multiple ops in order', () => {
  const block = '<initvar>a: 1</initvar><initvar>b: 2</initvar>';
  const ops = InitvarYamlRecognizer.extract(block);
  expect(ops).toHaveLength(2);
  expect((ops[0] as ReplaceStatDataOp).payload).toEqual({ a: 1 });
  expect((ops[1] as ReplaceStatDataOp).payload).toEqual({ b: 2 });
  expect(ops[0].index).toBeLessThan(ops[1].index);
});

test('recognizers array: InitvarYamlRecognizer first, LodashSetRecognizer second (Phase 2a)', () => {
  expect(recognizers).toEqual([InitvarYamlRecognizer, LodashSetRecognizer]);
});

// ---- V1 pipeline: applyOperation ----

test('applyOperation: replace_stat_data replaces state.stat_data entirely', () => {
  const before = { stat_data: { existing: 'value' } };
  const op: Operation = { kind: 'replace_stat_data', index: 0, payload: { fresh: 1 } };
  const after = applyOperation(before, op);
  expect(after.stat_data).toEqual({ fresh: 1 });
  // Pure: original state untouched.
  expect(before.stat_data).toEqual({ existing: 'value' });
});

test('applyOperation: unknown kind returns state unchanged', () => {
  const before = { stat_data: { x: 1 } };
  const after = applyOperation(before, { kind: 'unknown_kind', index: 0 });
  expect(after).toBe(before);
});

// ---- V1 pipeline: computeVariablesSnapshot ----

test('computeVariablesSnapshot: empty message list -> empty stat_data', async () => {
  expect(await computeVariablesSnapshot([])).toEqual({ stat_data: {} });
});

test('computeVariablesSnapshot: messages with no <UpdateVariable> -> empty stat_data', async () => {
  const snap = await computeVariablesSnapshot([{ content: 'just narrative' }, { content: 'more narrative' }]);
  expect(snap.stat_data).toEqual({});
});

test('computeVariablesSnapshot: single greeting with <initvar> seeds stat_data', async () => {
  const greeting = `narrative<UpdateVariable>
<initvar>
a: 1
b: hi
</initvar>
</UpdateVariable>tail`;
  const snap = await computeVariablesSnapshot([{ content: greeting }]);
  expect(snap.stat_data).toEqual({ a: 1, b: 'hi' });
});

test('computeVariablesSnapshot: later message replaces earlier stat_data', async () => {
  const msgs = [
    { content: '<UpdateVariable><initvar>a: 1</initvar></UpdateVariable>' },
    { content: '<UpdateVariable><initvar>b: 2</initvar></UpdateVariable>' },
  ];
  // V1 semantics: replace_stat_data wipes prior state. So final = {b: 2}.
  expect((await computeVariablesSnapshot(msgs)).stat_data).toEqual({ b: 2 });
});

test('computeVariablesSnapshot: messages without `.content` are skipped', async () => {
  const snap = await computeVariablesSnapshot([
    {} as { content: string },
    { content: undefined as unknown as string },
    { content: '<UpdateVariable><initvar>a: 1</initvar></UpdateVariable>' },
  ]);
  expect(snap.stat_data).toEqual({ a: 1 });
});

test('computeVariablesSnapshot: multiple <UpdateVariable> blocks in one message apply in document order', async () => {
  const content =
    '<UpdateVariable><initvar>a: 1</initvar></UpdateVariable>' +
    '<UpdateVariable><initvar>a: 2</initvar></UpdateVariable>';
  expect((await computeVariablesSnapshot([{ content }])).stat_data).toEqual({ a: 2 });
});

// ---- Queen Bee end-to-end fixtures (8 alternate greetings) ----

test('Queen Bee greeting 0 -> stat_data has time/location/rep/favors', async () => {
  const greeting = `<UpdateVariable>
<initvar>
世界:
  当前时间: Fall Semester, Saturday 19:45
  当前地点: Greyhounds Main Stadium · ΚΣ VIP Lounge

状态:
  校园声望: 0

兄弟会好感度:
  科尔: 0
  尼科: 0
  杰克斯: 0
  伊利亚: 0
  迪恩: 0
</initvar>
</UpdateVariable>`;
  const snap = await computeVariablesSnapshot([{ content: greeting }]);
  expect(snap.stat_data).toEqual({
    '世界': {
      '当前时间': 'Fall Semester, Saturday 19:45',
      '当前地点': 'Greyhounds Main Stadium · ΚΣ VIP Lounge',
    },
    '状态': { '校园声望': 0 },
    '兄弟会好感度': {
      '科尔': 0, '尼科': 0, '杰克斯': 0, '伊利亚': 0, '迪恩': 0,
    },
  });
});

test('Queen Bee greeting 3 -> mid-game seeded values', async () => {
  const greeting = `<UpdateVariable>
<initvar>
世界:
  当前时间: Fall Semester, Wednesday 14:30
  当前地点: St. Oak Main Lawn · Greek Week Beer Pong Zone

状态:
  校园声望: 420

兄弟会好感度:
  科尔: 65
  尼科: 58
  杰克斯: 52
  伊利亚: 48
  迪恩: 62
</initvar>
</UpdateVariable>`;
  const snap = await computeVariablesSnapshot([{ content: greeting }]);
  // Spot-check the widget-consumed paths.
  expect(snap.stat_data['状态']).toEqual({ '校园声望': 420 });
  expect(snap.stat_data['兄弟会好感度']).toEqual({
    '科尔': 65, '尼科': 58, '杰克斯': 52, '伊利亚': 48, '迪恩': 62,
  });
});

test('Queen Bee greeting 6 -> max-reputation/endgame seeded values', async () => {
  const greeting = `<UpdateVariable>
<initvar>
世界:
  当前时间: Summer Semester, Saturday 14:00
  当前地点: St. Oak Main Lawn · Graduation Ceremony

状态:
  校园声望: 1000

兄弟会好感度:
  科尔: 100
  尼科: 100
  杰克斯: 100
  伊利亚: 100
  迪恩: 100
</initvar>
</UpdateVariable>`;
  const snap = await computeVariablesSnapshot([{ content: greeting }]);
  expect(snap.stat_data['状态']).toEqual({ '校园声望': 1000 });
  expect(snap.stat_data['兄弟会好感度']).toEqual({
    '科尔': 100, '尼科': 100, '杰克斯': 100, '伊利亚': 100, '迪恩': 100,
  });
});

// ---- resolveActiveContent (swipe-aware resolution) ----

test('resolveActiveContent: prefers swipes[swipe_id] when populated', () => {
  expect(
    resolveActiveContent({
      content: 'mirror-of-swipe-0',
      swipes: ['s0', 's1', 's2'],
      swipe_id: 1,
    }),
  ).toBe('s1');
});

test('resolveActiveContent: swipe_id defaults to 0 when absent', () => {
  expect(
    resolveActiveContent({ swipes: ['first', 'second'] }),
  ).toBe('first');
});

test('resolveActiveContent: empty/missing swipe entry falls back to content', () => {
  expect(
    resolveActiveContent({ content: 'fallback', swipes: ['', 'second'], swipe_id: 0 }),
  ).toBe('fallback');
});

test('resolveActiveContent: out-of-bounds swipe_id falls back to content', () => {
  expect(
    resolveActiveContent({ content: 'fallback', swipes: ['only-one'], swipe_id: 5 }),
  ).toBe('fallback');
});

test('resolveActiveContent: empty swipes array falls back to content', () => {
  expect(resolveActiveContent({ content: 'fallback', swipes: [] })).toBe('fallback');
});

test('resolveActiveContent: no swipes array uses content directly (user messages)', () => {
  expect(resolveActiveContent({ content: 'user typed' })).toBe('user typed');
});

test('resolveActiveContent: nothing present returns empty string', () => {
  expect(resolveActiveContent({})).toBe('');
});

// ---- computeVariablesSnapshot: swipe-aware behaviour ----

test('computeVariablesSnapshot: reads active swipe (swipe_id=1) not the canonical content', async () => {
  // Simulates the bug scenario: content mirrors swipes[0] (greeting A) but
  // the user swiped to greeting B at swipes[1]. The replay must read B.
  const greetingA = '<UpdateVariable><initvar>状态:\n  校园声望: 0</initvar></UpdateVariable>';
  const greetingB = '<UpdateVariable><initvar>状态:\n  校园声望: 420</initvar></UpdateVariable>';
  const snap = await computeVariablesSnapshot([
    {
      content: greetingA,
      swipes: [greetingA, greetingB],
      swipe_id: 1,
      id: 'msg-0',
    },
  ]);
  expect(snap.stat_data).toEqual({ '状态': { '校园声望': 420 } });
});

test('computeVariablesSnapshot: with swipes only — uses swipes[0] when swipe_id is missing', async () => {
  const block = '<UpdateVariable><initvar>a: 1</initvar></UpdateVariable>';
  const snap = await computeVariablesSnapshot([{ swipes: [block, 'unrelated'] }]);
  expect(snap.stat_data).toEqual({ a: 1 });
});

test('computeVariablesSnapshot: falls back to content when swipe_id points to empty slot', async () => {
  const block = '<UpdateVariable><initvar>a: 7</initvar></UpdateVariable>';
  const snap = await computeVariablesSnapshot([
    { content: block, swipes: ['', ''], swipe_id: 0 },
  ]);
  expect(snap.stat_data).toEqual({ a: 7 });
});

test('computeVariablesSnapshot: user message (no swipes) replays via content', async () => {
  const block = '<UpdateVariable><initvar>a: 9</initvar></UpdateVariable>';
  const snap = await computeVariablesSnapshot([{ content: block }]);
  expect(snap.stat_data).toEqual({ a: 9 });
});

test('computeVariablesSnapshot: chat with no <UpdateVariable> in any swipe -> empty stat_data', async () => {
  const snap = await computeVariablesSnapshot([
    { content: 'narrative', swipes: ['narrative', 'other narrative'], swipe_id: 1 },
    { content: 'still none' },
  ]);
  expect(snap.stat_data).toEqual({});
});

test('Queen Bee: greeting followed by non-MVU AI messages keeps the seeded state', async () => {
  const messages = [
    {
      content: `<UpdateVariable>
<initvar>
状态:
  校园声望: 100
</initvar>
</UpdateVariable>`,
    },
    { content: 'user: hello' },
    { content: 'ai narrative only, no UpdateVariable here' },
  ];
  const snap = await computeVariablesSnapshot(messages);
  expect(snap.stat_data).toEqual({ '状态': { '校园声望': 100 } });
});

// ---- Recovery from card greetings (Step 4) ----

const QB_GREETING_3 = `<UpdateVariable>
<initvar>
状态:
  校园声望: 420
</initvar>
</UpdateVariable>
<StatusPlaceHolderImpl></StatusPlaceHolderImpl>
Some prose about Greek Week...`;

const QB_GREETING_0 = `<UpdateVariable>
<initvar>
状态:
  校园声望: 0
</initvar>
</UpdateVariable>
<StatusPlaceHolderImpl></StatusPlaceHolderImpl>
Welcome to ΚΣ...`;

// stripped: same text as above but with <UpdateVariable>...</UpdateVariable>
// removed. Mirrors what an old buggy code path persisted to the DB.
const QB_GREETING_3_STRIPPED = `
<StatusPlaceHolderImpl></StatusPlaceHolderImpl>
Some prose about Greek Week...`;

test('recovery: stripped greeting content matches card greeting and recovers stat_data', async () => {
  const snap = await computeVariablesSnapshot(
    [{ content: QB_GREETING_3_STRIPPED, index_in_chat: 0, id: 'msg-0' }],
    async () => ['<first_mes>', QB_GREETING_0, '<greeting-2>', QB_GREETING_3],
  );
  expect(snap.stat_data).toEqual({ '状态': { '校园声望': 420 } });
});

test('recovery: no matching greeting in card -> empty snapshot, no crash', async () => {
  const snap = await computeVariablesSnapshot(
    [{ content: 'totally-unrelated-stripped-content', index_in_chat: 0, id: 'msg-0' }],
    async () => [QB_GREETING_0, QB_GREETING_3],
  );
  expect(snap.stat_data).toEqual({});
});

test('recovery: undefined alternate_greetings (card with no alternates) -> empty snapshot', async () => {
  const snap = await computeVariablesSnapshot(
    [{ content: QB_GREETING_3_STRIPPED, index_in_chat: 0, id: 'msg-0' }],
    // The caller of computeVariablesSnapshot wraps "no alternates" as [first_mes]
    // (or []). Either way recovery should not crash and just yield empty.
    async () => [],
  );
  expect(snap.stat_data).toEqual({});
});

test('recovery: NOT attempted on a fresh chat where the block is in the active content', async () => {
  let fetcherCalls = 0;
  const snap = await computeVariablesSnapshot(
    [{ content: QB_GREETING_3, index_in_chat: 0, id: 'msg-0' }],
    async () => { fetcherCalls++; return [QB_GREETING_3]; },
  );
  expect(snap.stat_data).toEqual({ '状态': { '校园声望': 420 } });
  expect(fetcherCalls).toBe(0);
});

test('recovery: NOT attempted for non-greeting messages (index_in_chat > 0)', async () => {
  let fetcherCalls = 0;
  const snap = await computeVariablesSnapshot(
    [
      { content: QB_GREETING_3, index_in_chat: 0, id: 'msg-0' },
      // Message at index 1 has no block — recovery should NOT fire for it.
      { content: 'plain ai narrative no block', index_in_chat: 1, id: 'msg-1' },
    ],
    async () => { fetcherCalls++; return [QB_GREETING_3]; },
  );
  expect(snap.stat_data).toEqual({ '状态': { '校园声望': 420 } });
  expect(fetcherCalls).toBe(0); // greeting at index 0 had the block, no recovery needed
});

test('recovery: fetcher invoked at most once per snapshot read', async () => {
  let fetcherCalls = 0;
  await computeVariablesSnapshot(
    [{ content: QB_GREETING_3_STRIPPED, index_in_chat: 0, id: 'msg-0' }],
    async () => { fetcherCalls++; return [QB_GREETING_3]; },
  );
  expect(fetcherCalls).toBe(1);
});

test('recovery: fetcher throwing -> falls back to empty candidate list, no crash', async () => {
  const restoreWarn = console.warn;
  console.warn = () => {};
  try {
    const snap = await computeVariablesSnapshot(
      [{ content: QB_GREETING_3_STRIPPED, index_in_chat: 0, id: 'msg-0' }],
      async () => { throw new Error('character fetch failed'); },
    );
    expect(snap.stat_data).toEqual({});
  } finally {
    console.warn = restoreWarn;
  }
});

// ---- Phase 2a: LodashSetRecognizer replay ----

test('LodashSetRecognizer.extract: returns one set_path op per _.set call, in source order', () => {
  // MVU convention: LLM emits BARE paths (no `stat_data.` prefix).
  const block = `_.set('状态.校园声望', 0, 100)
_.set('状态.位置', 'old', 'new')`;
  const ops = LodashSetRecognizer.extract(block);
  expect(ops).toHaveLength(2);
  expect(ops[0].kind).toBe('set_path');
  expect((ops[0] as SetPathOp).path).toBe('状态.校园声望');
  expect((ops[0] as SetPathOp).value).toBe(100);
  expect((ops[1] as SetPathOp).path).toBe('状态.位置');
  expect((ops[1] as SetPathOp).value).toBe('new');
  expect(ops[0].index).toBeLessThan(ops[1].index);
});

test('applyOperation: set_path writes value at a bare path INSIDE state.stat_data', () => {
  // Path is bare (`状态.校园声望`), interpreted relative to stat_data.
  // Result lands at state.stat_data.状态.校园声望.
  const before: MvuData = { stat_data: { 状态: { 校园声望: 0 } } };
  const op: SetPathOp = {
    kind: 'set_path', index: 0,
    path: '状态.校园声望', value: 100,
  };
  const after = applyOperation(before, op);
  expect(after.stat_data).toEqual({ 状态: { 校园声望: 100 } });
  // Pure: original state untouched.
  expect(before.stat_data).toEqual({ 状态: { 校园声望: 0 } });
});

test('applyOperation: set_path creates missing intermediate path segments inside stat_data', () => {
  const before: MvuData = { stat_data: { existing: 'yes' } };
  const op: SetPathOp = {
    kind: 'set_path', index: 0,
    path: '世界.当前地点', value: 'Library',
  };
  const after = applyOperation(before, op);
  expect(after.stat_data).toEqual({
    existing: 'yes',
    世界: { 当前地点: 'Library' },
  });
  expect(before.stat_data).toEqual({ existing: 'yes' });
});

test('applyOperation: set_path with bracket-notation path is a no-op (returns state unchanged)', () => {
  // Path validator rejects bracket notation this iteration; the
  // recognizer's onDiagnostic already logged via the parser layer.
  const before: MvuData = { stat_data: { x: 1 } };
  const op: SetPathOp = {
    kind: 'set_path', index: 0,
    path: '状态["x"]', value: 2,
  };
  const after = applyOperation(before, op);
  expect(after.stat_data).toEqual({ x: 1 });
});

test('applyOperation: set_path with no stat_data on state creates one and writes into it', () => {
  // Defensive: an orphan _.set with no preceding initvar. Old behavior
  // would silently drop; new behavior creates stat_data and writes the
  // bare path inside it. The LLM's update lands somewhere readable.
  const before: MvuData = { stat_data: {} };
  const op: SetPathOp = {
    kind: 'set_path', index: 0,
    path: '状态.校园声望', value: 42,
  };
  const after = applyOperation(before, op);
  expect(after.stat_data).toEqual({ 状态: { 校园声望: 42 } });
});

test('applyOperation: set_path with EXPLICIT `stat_data.` prefix is treated literally (non-canonical)', () => {
  // Locks the deliberate semantics: a path with `stat_data.` prefix
  // lands at state.stat_data.stat_data.X. We surface this via the
  // set-path-applied diagnostic — a future change to silently strip
  // the prefix would have to update this test, making the strip
  // visible rather than invisible.
  const before: MvuData = { stat_data: {} };
  const op: SetPathOp = {
    kind: 'set_path', index: 0,
    path: 'stat_data.世界.当前地点', value: 'Library',
  };
  const after = applyOperation(before, op);
  expect(after.stat_data).toEqual({
    stat_data: { 世界: { 当前地点: 'Library' } },
  });
});

test('replay: greeting initvar + one LLM message with one _.set: final state is merged', async () => {
  const greeting = `<UpdateVariable>
<initvar>
状态:
  校园声望: 0
兄弟会好感度:
  科尔: 0
</initvar>
</UpdateVariable>`;
  // Bare path per MVU convention — applied inside state.stat_data.
  const llmReply = `Narrative prose...<UpdateVariable>
_.set('状态.校园声望', 0, 100)
</UpdateVariable>more prose`;
  const snap = await computeVariablesSnapshot([
    { content: greeting, index_in_chat: 0, id: 'msg-0' },
    { content: llmReply, index_in_chat: 1, id: 'msg-1' },
  ]);
  expect(snap.stat_data).toEqual({
    状态: { 校园声望: 100 },
    兄弟会好感度: { 科尔: 0 },
  });
});

test('replay: greeting + multiple LLM messages with cumulative _.sets', async () => {
  const greeting = `<UpdateVariable>
<initvar>
状态:
  校园声望: 0
</initvar>
</UpdateVariable>`;
  const llm1 = `<UpdateVariable>
_.set('状态.校园声望', 0, 100)
</UpdateVariable>`;
  const llm2 = `<UpdateVariable>
_.set('状态.校园声望', 100, 250)
_.set('状态.位置', '宿舍', '图书馆')
</UpdateVariable>`;
  const snap = await computeVariablesSnapshot([
    { content: greeting, index_in_chat: 0, id: 'msg-0' },
    { content: llm1, index_in_chat: 1, id: 'msg-1' },
    { content: llm2, index_in_chat: 2, id: 'msg-2' },
  ]);
  expect(snap.stat_data).toEqual({
    状态: { 校园声望: 250, 位置: '图书馆' },
  });
});

test('replay: _.set targeting a path that does NOT exist in initvar creates the path', async () => {
  const greeting = `<UpdateVariable>
<initvar>
状态:
  校园声望: 0
</initvar>
</UpdateVariable>`;
  const llm = `<UpdateVariable>
_.set('新组.新键', 0, 42)
</UpdateVariable>`;
  const snap = await computeVariablesSnapshot([
    { content: greeting, index_in_chat: 0, id: 'msg-0' },
    { content: llm, index_in_chat: 1, id: 'msg-1' },
  ]);
  expect(snap.stat_data).toEqual({
    状态: { 校园声望: 0 },
    新组: { 新键: 42 },
  });
});

test('replay: swipe semantics — only the active swipe contributes _.sets', async () => {
  const greeting = `<UpdateVariable>
<initvar>
状态:
  校园声望: 0
</initvar>
</UpdateVariable>`;
  const activeSwipe = `<UpdateVariable>
_.set('状态.校园声望', 0, 100)
</UpdateVariable>`;
  const inactiveSwipe = `<UpdateVariable>
_.set('状态.校园声望', 0, 999)
</UpdateVariable>`;
  const snap = await computeVariablesSnapshot([
    { content: greeting, index_in_chat: 0, id: 'msg-0' },
    {
      content: activeSwipe,
      swipes: [inactiveSwipe, activeSwipe],
      swipe_id: 1,
      index_in_chat: 1,
      id: 'msg-1',
    },
  ]);
  // Active swipe's _.set wins; inactive's value (999) is ignored.
  expect(snap.stat_data).toEqual({
    状态: { 校园声望: 100 },
  });
});

test('replay: a single block containing BOTH <initvar> AND _.set: both recognizers contribute', async () => {
  // The initvar appears first in source, so its replace_stat_data lands
  // first (wiping any prior state). Then the _.set lands after, mutating
  // a single path on top of the freshly-seeded stat_data.
  const content = `<UpdateVariable>
<initvar>
状态:
  校园声望: 100
</initvar>
_.set('状态.位置', '宿舍', '图书馆')
</UpdateVariable>`;
  const snap = await computeVariablesSnapshot([
    { content, index_in_chat: 0, id: 'msg-0' },
  ]);
  expect(snap.stat_data).toEqual({
    状态: { 校园声望: 100, 位置: '图书馆' },
  });
});

test('replay: _.set with literal types all parse correctly through the pipeline', async () => {
  const greeting = `<UpdateVariable>
<initvar>
state:
  ready: false
</initvar>
</UpdateVariable>`;
  const llm = `<UpdateVariable>
_.set('state.ready', false, true)
_.set('state.name', 'old', 'Vera')
_.set('state.score', 0, 3.14)
_.set('state.note', null, null)
</UpdateVariable>`;
  const snap = await computeVariablesSnapshot([
    { content: greeting, index_in_chat: 0, id: 'msg-0' },
    { content: llm, index_in_chat: 1, id: 'msg-1' },
  ]);
  expect(snap.stat_data).toEqual({
    state: { ready: true, name: 'Vera', score: 3.14, note: null },
  });
});

test('replay: unsupported _.set value (delta-shape) is dropped, surrounding ops succeed', async () => {
  const greeting = `<UpdateVariable>
<initvar>
状态:
  校园声望: 100
</initvar>
</UpdateVariable>`;
  const llm = `<UpdateVariable>
_.set('状态.校园声望', 100, '+50')
_.set('状态.位置', '宿舍', '图书馆')
</UpdateVariable>`;
  const snap = await computeVariablesSnapshot([
    { content: greeting, index_in_chat: 0, id: 'msg-0' },
    { content: llm, index_in_chat: 1, id: 'msg-1' },
  ]);
  // The delta-shape value is reported as value-not-literal and skipped;
  // 校园声望 stays at the initvar-seeded 100. The location set succeeds.
  expect(snap.stat_data).toEqual({
    状态: { 校园声望: 100, 位置: '图书馆' },
  });
});
