import { test, expect } from 'bun:test';
import { classifyTrigger } from './classify-trigger';

// Cases involving unicode delimiters (【】「」《》『』↦↤) use `new RegExp(...)`
// instead of regex literals. Bun's TS parser escapes literal unicode chars in
// regex sources to \uXXXX form, while `bun build` and the runtime path in
// production (cards arrive as findRegex strings → new RegExp(...)) preserve
// the literal chars. The constructor form matches production behavior.

test('CJK brackets with no captures classify as placeholder', () => {
  expect(classifyTrigger(new RegExp('【女王蜂】'))).toBe('placeholder');
});

test('self-closing tag with no captures classifies as placeholder', () => {
  expect(classifyTrigger(/<StatusPlaceHolderImpl\/>/)).toBe('placeholder');
});

test('paired tag with single capture classifies as pairedTag', () => {
  expect(classifyTrigger(/<status_top>([\s\S]*?)<\/status_top>/)).toBe('pairedTag');
});

test('paired tag with attribute and captures classifies as pairedTag', () => {
  expect(classifyTrigger(/<phone app="([^"]*)">([\s\S]*?)<\/phone>/)).toBe('pairedTag');
});

test('paired tag with multiple attributes classifies as pairedTag', () => {
  expect(classifyTrigger(/<phone a="x" b="y">([\s\S]*?)<\/phone>/)).toBe('pairedTag');
});

test('paired tag with dash in name classifies as pairedTag', () => {
  expect(classifyTrigger(/<my-widget>([\s\S]*?)<\/my-widget>/)).toBe('pairedTag');
});

test('CJK brackets with captures classify as delimitedCapture', () => {
  expect(classifyTrigger(new RegExp('【SYS_HUD \\| Loc: (.*?) \\| Time: (.*?)】'))).toBe('delimitedCapture');
});

test('double CJK brackets with block capture classify as delimitedCapture', () => {
  expect(classifyTrigger(new RegExp('『Present Characters Start』([\\s\\S]*?)『Present Characters End』'))).toBe('delimitedCapture');
});

test('asymmetric arrows with captures classify as delimitedCapture', () => {
  expect(classifyTrigger(new RegExp('↦(\\S+)\\s([^:]+):([\\s\\S]*?)↤'))).toBe('delimitedCapture');
});

test('corner brackets with capture classify as delimitedCapture', () => {
  expect(classifyTrigger(new RegExp('「(.*?)」'))).toBe('delimitedCapture');
});

test('double angle brackets with capture classify as delimitedCapture', () => {
  expect(classifyTrigger(new RegExp('《(.*?)》'))).toBe('delimitedCapture');
});

test('START OF / END OF textual markers with capture classify as delimitedCapture', () => {
  const re = new RegExp('\\[\\s*START OF ANN SYS\\s*\\]([\\s\\S]*?)\\[\\s*END OF ANN SYS\\s*\\]');
  expect(classifyTrigger(re)).toBe('delimitedCapture');
});

test('capture with no recognized delimiter classifies as unknown', () => {
  expect(classifyTrigger(/foo(.*?)bar/)).toBe('unknown');
});
