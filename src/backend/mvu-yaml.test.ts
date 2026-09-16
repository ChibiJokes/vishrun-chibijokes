import { test, expect, mock } from 'bun:test';
import { parseYaml } from './mvu-yaml';

test('parseYaml: flat map of string values', () => {
  expect(parseYaml('a: x\nb: y')).toEqual({ a: 'x', b: 'y' });
});

test('parseYaml: integer values are numbers', () => {
  expect(parseYaml('a: 0\nb: -5\nc: 1000')).toEqual({ a: 0, b: -5, c: 1000 });
});

test('parseYaml: float values are numbers', () => {
  expect(parseYaml('a: 3.14\nb: -0.5')).toEqual({ a: 3.14, b: -0.5 });
});

test('parseYaml: nested map via empty-value parent', () => {
  expect(parseYaml('parent:\n  child: 1')).toEqual({ parent: { child: 1 } });
});

test('parseYaml: two siblings each with their own nested map', () => {
  const src = 'a:\n  x: 1\nb:\n  y: 2';
  expect(parseYaml(src)).toEqual({ a: { x: 1 }, b: { y: 2 } });
});

test('parseYaml: blank lines between groups are ignored', () => {
  const src = 'a:\n  x: 1\n\nb:\n  y: 2';
  expect(parseYaml(src)).toEqual({ a: { x: 1 }, b: { y: 2 } });
});

test('parseYaml: CJK keys are preserved verbatim', () => {
  const src = '世界:\n  当前时间: 14:30';
  expect(parseYaml(src)).toEqual({ '世界': { '当前时间': '14:30' } });
});

test('parseYaml: value containing `:` splits only on the FIRST `: `', () => {
  // The value contains both a colon-no-space (`19:45`) and the
  // separator-after-Saturday. We split only on the first `: `.
  const src = '世界:\n  当前时间: Fall Semester, Saturday 19:45';
  expect(parseYaml(src)).toEqual({
    '世界': { '当前时间': 'Fall Semester, Saturday 19:45' },
  });
});

test('parseYaml: value with non-ASCII (middle dot) preserved', () => {
  const src = '世界:\n  当前地点: Greyhounds Main Stadium · ΚΣ VIP Lounge';
  expect(parseYaml(src)).toEqual({
    '世界': { '当前地点': 'Greyhounds Main Stadium · ΚΣ VIP Lounge' },
  });
});

test('parseYaml: three-level nesting', () => {
  const src = 'a:\n  b:\n    c: 1\n  d: 2';
  expect(parseYaml(src)).toEqual({ a: { b: { c: 1 }, d: 2 } });
});

test('parseYaml: four-space indent works too (any consistent width)', () => {
  const src = 'a:\n    b: 1\n    c: 2';
  expect(parseYaml(src)).toEqual({ a: { b: 1, c: 2 } });
});

test('parseYaml: empty source returns empty map', () => {
  expect(parseYaml('')).toEqual({});
});

test('parseYaml: only blank lines returns empty map', () => {
  expect(parseYaml('\n\n   \n\n')).toEqual({});
});

test('parseYaml: trailing whitespace on values is trimmed', () => {
  expect(parseYaml('a:   value   ')).toEqual({ a: 'value' });
});

test('parseYaml: Windows CRLF line endings', () => {
  expect(parseYaml('a: 1\r\nb: 2')).toEqual({ a: 1, b: 2 });
});

test('parseYaml: malformed line without colon-space is skipped with warn', () => {
  const restoreWarn = console.warn;
  console.warn = mock(() => {});
  try {
    // Second line has no `: ` and no trailing `:` — skipped.
    expect(parseYaml('a: 1\nbare line\nb: 2')).toEqual({ a: 1, b: 2 });
  } finally {
    console.warn = restoreWarn;
  }
});

test('parseYaml: comment line is silently skipped', () => {
  expect(parseYaml('# top comment\na: 1\n  # nested comment\nb: 2')).toEqual({ a: 1, b: 2 });
});

test('parseYaml: quoted value preserves quotes as part of the string (V1 limitation)', () => {
  // V1 does not strip surrounding quotes. The string is returned with
  // quotes intact. Locked here so future quote-stripping is a flagged change.
  expect(parseYaml('a: "value"')).toEqual({ a: '"value"' });
});

test('parseYaml: Queen Bee greeting 0 produces the expected stat_data shape', () => {
  const src = `世界:
  当前时间: Fall Semester, Saturday 19:45
  当前地点: Greyhounds Main Stadium · ΚΣ VIP Lounge

状态:
  校园声望: 0

兄弟会好感度:
  科尔: 0
  尼科: 0
  杰克斯: 0
  伊利亚: 0
  迪恩: 0`;
  expect(parseYaml(src)).toEqual({
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

test('parseYaml: Queen Bee greeting 1 (different seeded values)', () => {
  const src = `世界:
  当前时间: Fall Semester, Tuesday 05:30
  当前地点: ΚΣ Mansion · 3rd Floor Hive

状态:
  校园声望: 100

兄弟会好感度:
  科尔: 15
  尼科: 18
  杰克斯: 15
  伊利亚: 14
  迪恩: 17`;
  expect(parseYaml(src)).toEqual({
    '世界': {
      '当前时间': 'Fall Semester, Tuesday 05:30',
      '当前地点': 'ΚΣ Mansion · 3rd Floor Hive',
    },
    '状态': { '校园声望': 100 },
    '兄弟会好感度': {
      '科尔': 15, '尼科': 18, '杰克斯': 15, '伊利亚': 14, '迪恩': 17,
    },
  });
});
