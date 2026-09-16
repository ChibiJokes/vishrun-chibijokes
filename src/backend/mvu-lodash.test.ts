import { test, expect } from 'bun:test';
import { parseLodashSetCalls, type LodashSetCall } from './mvu-lodash';

function collectUnsupported() {
  const reports: Array<{ snippet: string; reason: string }> = [];
  return {
    reports,
    onUnsupported: (snippet: string, reason: string) => {
      reports.push({ snippet, reason });
    },
  };
}

test('three-arg _.set with number newValue: parsed, oldVal ignored', () => {
  const out = parseLodashSetCalls(`_.set('stat_data.x', 0, 42)`);
  expect(out).toHaveLength(1);
  expect(out[0].path).toBe('stat_data.x');
  expect(out[0].newValue).toBe(42);
});

test('three-arg _.set with quoted string newValue: parsed, quotes stripped', () => {
  const out = parseLodashSetCalls(`_.set('stat_data.状态.位置', '旧', '新')`);
  expect(out).toHaveLength(1);
  expect(out[0].path).toBe('stat_data.状态.位置');
  expect(out[0].newValue).toBe('新');
});

test('two-arg _.set: each literal type', () => {
  const cases: Array<{ src: string; expected: LodashSetCall['newValue'] }> = [
    { src: `_.set('a', 7)`, expected: 7 },
    { src: `_.set('a', -7)`, expected: -7 },
    { src: `_.set('a', 3.14)`, expected: 3.14 },
    { src: `_.set('a', "hello")`, expected: 'hello' },
    { src: `_.set('a', 'world')`, expected: 'world' },
    { src: `_.set('a', true)`, expected: true },
    { src: `_.set('a', false)`, expected: false },
    { src: `_.set('a', null)`, expected: null },
  ];
  for (const { src, expected } of cases) {
    const out = parseLodashSetCalls(src);
    expect(out).toHaveLength(1);
    expect(out[0].newValue).toBe(expected);
  }
});

test('multiple _.set calls in one block: parsed in source order', () => {
  const block = `narrative...
    _.set('stat_data.状态.校园声望', 0, 100);
    _.set('stat_data.状态.位置', '宿舍', '图书馆')
    _.set('stat_data.兄弟会好感度.科尔', 0, 15)
    more text`;
  const out = parseLodashSetCalls(block);
  expect(out).toHaveLength(3);
  expect(out[0].path).toBe('stat_data.状态.校园声望');
  expect(out[0].newValue).toBe(100);
  expect(out[1].path).toBe('stat_data.状态.位置');
  expect(out[1].newValue).toBe('图书馆');
  expect(out[2].path).toBe('stat_data.兄弟会好感度.科尔');
  expect(out[2].newValue).toBe(15);
  // Indices in source order, ascending.
  expect(out[0].index).toBeLessThan(out[1].index);
  expect(out[1].index).toBeLessThan(out[2].index);
});

test('non-_.set lodash command: reported, not in result', () => {
  const { reports, onUnsupported } = collectUnsupported();
  const out = parseLodashSetCalls(`_.assign(obj, { a: 1 })`, onUnsupported);
  expect(out).toEqual([]);
  expect(reports).toHaveLength(1);
  expect(reports[0].reason).toBe('not-dot-set');
});

test('mixed: _.set + _.assign in one block — only _.set parsed', () => {
  const { reports, onUnsupported } = collectUnsupported();
  const block = `_.set('a', 1); _.assign(b, {x:1}); _.set('c', 'two')`;
  const out = parseLodashSetCalls(block, onUnsupported);
  expect(out).toHaveLength(2);
  expect(out[0].path).toBe('a');
  expect(out[1].path).toBe('c');
  expect(reports).toHaveLength(1);
  expect(reports[0].reason).toBe('not-dot-set');
});

test('malformed call (unbalanced parens): reported, not in result', () => {
  const { reports, onUnsupported } = collectUnsupported();
  const out = parseLodashSetCalls(`_.set('a', 1`, onUnsupported);
  expect(out).toEqual([]);
  expect(reports).toHaveLength(1);
  expect(reports[0].reason).toBe('malformed-call');
});

test('wrong arg count (1 or 4 args): reported as malformed-call', () => {
  const { reports, onUnsupported } = collectUnsupported();
  parseLodashSetCalls(`_.set('a')`, onUnsupported);
  parseLodashSetCalls(`_.set('a', 1, 2, 3)`, onUnsupported);
  expect(reports.map((r) => r.reason)).toEqual(['malformed-call', 'malformed-call']);
});

test('value with delta-shape math expression (e.g. \'+50\'): reported as value-not-literal', () => {
  // MVU convention: '+50' inside quotes is a delta op intent, not a
  // literal string. Out of scope this iteration; report don't silently
  // write the string '+50' at the path.
  const { reports, onUnsupported } = collectUnsupported();
  const out = parseLodashSetCalls(`_.set('a', '+50')`, onUnsupported);
  expect(out).toEqual([]);
  expect(reports).toHaveLength(1);
  expect(reports[0].reason).toBe('value-not-literal');
});

test("value with negative-delta-shape '-7' (quoted): reported as value-not-literal", () => {
  const { reports, onUnsupported } = collectUnsupported();
  const out = parseLodashSetCalls(`_.set('a', '-7')`, onUnsupported);
  expect(out).toEqual([]);
  expect(reports[0].reason).toBe('value-not-literal');
});

test('value is unquoted negative number -7: parsed as number, NOT reported', () => {
  // Distinguish unquoted number from quoted delta-shape: unquoted is
  // a number literal we accept.
  const { reports, onUnsupported } = collectUnsupported();
  const out = parseLodashSetCalls(`_.set('a', -7)`, onUnsupported);
  expect(out).toHaveLength(1);
  expect(out[0].newValue).toBe(-7);
  expect(reports).toEqual([]);
});

test('JSON literal newValue ([1,2,3] / { x: 1 }): reported as value-not-literal', () => {
  const { reports, onUnsupported } = collectUnsupported();
  parseLodashSetCalls(`_.set('a', [1, 2, 3])`, onUnsupported);
  parseLodashSetCalls(`_.set('a', { x: 1 })`, onUnsupported);
  expect(reports.length).toBeGreaterThanOrEqual(1);
  expect(reports.every((r) => r.reason === 'value-not-literal')).toBe(true);
});

test('empty block: empty result, no error', () => {
  const out = parseLodashSetCalls('');
  expect(out).toEqual([]);
});

test('block without any lodash calls: empty result, no error', () => {
  const out = parseLodashSetCalls('Just some prose and no commands at all.');
  expect(out).toEqual([]);
});

test('path arg not a string literal (variable name): reported', () => {
  const { reports, onUnsupported } = collectUnsupported();
  const out = parseLodashSetCalls(`_.set(somePath, 1)`, onUnsupported);
  expect(out).toEqual([]);
  expect(reports[0].reason).toBe('path-not-string-literal');
});

test('path arg with bracket notation: reported (out of scope this iteration)', () => {
  const { reports, onUnsupported } = collectUnsupported();
  const out = parseLodashSetCalls(`_.set('stat_data["x"]["y"]', 1)`, onUnsupported);
  expect(out).toEqual([]);
  expect(reports[0].reason).toBe('path-not-string-literal');
});

test('string newValue containing a comma at top level: parsed correctly (comma is inside quotes)', () => {
  // The argsplit walks paren depth + quote state, so a `,` inside a
  // quoted value doesn't get treated as an arg separator.
  const out = parseLodashSetCalls(`_.set('stat_data.location', 'old', 'St. Oak, Building A')`);
  expect(out).toHaveLength(1);
  expect(out[0].newValue).toBe('St. Oak, Building A');
});

test('newline-separated _.set calls: all parsed', () => {
  const block = `_.set('a', 1)\n_.set('b', 2)\n_.set('c', 3)\n`;
  const out = parseLodashSetCalls(block);
  expect(out).toHaveLength(3);
  expect(out.map((c) => c.path)).toEqual(['a', 'b', 'c']);
});
