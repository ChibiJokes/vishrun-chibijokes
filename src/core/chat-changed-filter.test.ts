import { test, expect } from 'bun:test';
import { shouldRescanForChangedFields } from './chat-changed-filter';

test('undefined changedFields -> rescan (conservative fallback)', () => {
  expect(shouldRescanForChangedFields(undefined)).toBe(true);
});

test('empty array changedFields -> skip (idempotent write)', () => {
  expect(shouldRescanForChangedFields([])).toBe(false);
});

test('var-only paths (macro_variables) -> skip', () => {
  expect(shouldRescanForChangedFields([
    'metadata.macro_variables',
    'metadata.macro_variables.local.player_yen',
  ])).toBe(false);
});

test('var-only paths (chat_variables) -> skip', () => {
  expect(shouldRescanForChangedFields(['metadata.chat_variables.foo'])).toBe(false);
});

test('message content change -> rescan', () => {
  expect(shouldRescanForChangedFields(['messages.0.content'])).toBe(true);
});

test('character_id change -> rescan', () => {
  expect(shouldRescanForChangedFields(['character_id'])).toBe(true);
});

test('name change -> rescan', () => {
  expect(shouldRescanForChangedFields(['name'])).toBe(true);
});

test('mixed var + non-var -> rescan (at least one non-var)', () => {
  expect(shouldRescanForChangedFields(['metadata.macro_variables', 'messages.2'])).toBe(true);
});

test('other metadata key (not variables) -> rescan', () => {
  expect(shouldRescanForChangedFields(['metadata.wallpaper'])).toBe(true);
});

test('similar prefix but not a var path -> rescan', () => {
  expect(shouldRescanForChangedFields(['metadata.macro_variables_legacy'])).toBe(true);
});
