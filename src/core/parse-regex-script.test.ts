import { test, expect } from 'bun:test';
import { stripCodeFence, parseRegexLiteral, mergeFlags } from './parse-regex-script';

test('stripCodeFence: lowercase html lang hint', () => {
  const t = '```html\n<!DOCTYPE html>\n<body>x</body>\n```';
  expect(stripCodeFence(t)).toBe('<!DOCTYPE html>\n<body>x</body>');
});

test('stripCodeFence: uppercase HTML lang hint preserves inner whitespace', () => {
  expect(stripCodeFence('```HTML\n  hi  \n```')).toBe('  hi  ');
});

test('stripCodeFence: no lang hint', () => {
  expect(stripCodeFence('```\nfoo\n```')).toBe('foo');
});

test('stripCodeFence: surrounding whitespace + CRLF + trailing space on opening line', () => {
  expect(stripCodeFence('   ```html  \r\nfoo\r\n```   ')).toBe('foo');
});

test('stripCodeFence: pass-through when no fence', () => {
  const t = '<!DOCTYPE html>\nno fence here';
  expect(stripCodeFence(t)).toBe(t);
});

test('stripCodeFence: pass-through when opening fence has no close', () => {
  const t = '```html\nopener but no close';
  expect(stripCodeFence(t)).toBe(t);
});

test('stripCodeFence: Vavesta-shaped block unwraps cleanly', () => {
  const t = '```html\n<!DOCTYPE html>\n<html lang="en">\n<body><div class="vav-home-wrap"></div></body>\n</html>\n```';
  const stripped = stripCodeFence(t);
  expect(stripped.startsWith('<!DOCTYPE html>')).toBe(true);
  expect(stripped.endsWith('</html>')).toBe(true);
});

test('parseRegexLiteral: arrow-delimited literal with g flag', () => {
  const r = parseRegexLiteral('/↦(\\S+)\\s([^:]+):([\\s\\S]*?)↤/g');
  expect(r.pattern).toBe('↦(\\S+)\\s([^:]+):([\\s\\S]*?)↤');
  expect(r.flags).toBe('g');
});

test('parseRegexLiteral: non-literal placeholder passes through', () => {
  const r = parseRegexLiteral('【VAVESTA_HOME】');
  expect(r.pattern).toBe('【VAVESTA_HOME】');
  expect(r.flags).toBe('');
});

test('parseRegexLiteral: paired-tag source without delimiters passes through', () => {
  const r = parseRegexLiteral('<\\s*PACIFICA_UI\\s*>([\\s\\S]*?)<\\s*\\/PACIFICA_UI\\s*>');
  expect(r.pattern).toBe('<\\s*PACIFICA_UI\\s*>([\\s\\S]*?)<\\s*\\/PACIFICA_UI\\s*>');
  expect(r.flags).toBe('');
});

test('parseRegexLiteral: escaped slash inside pattern is not a closer', () => {
  const r = parseRegexLiteral('/foo\\/bar/i');
  expect(r.pattern).toBe('foo\\/bar');
  expect(r.flags).toBe('i');
});

test('parseRegexLiteral: unmatched leading slash passes through', () => {
  const r = parseRegexLiteral('/no closer');
  expect(r.pattern).toBe('/no closer');
  expect(r.flags).toBe('');
});

test('mergeFlags: empty user flags defaults to gs', () => {
  expect(mergeFlags('')).toBe('gs');
});

test('mergeFlags: dedupes g and adds i for gi input', () => {
  expect([...mergeFlags('gi')].sort().join('')).toBe('gis');
});
