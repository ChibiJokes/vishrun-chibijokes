import { test, expect } from 'bun:test';
import { linearizeBubble, getLinearizedBubble, invalidateLinearizedBubble } from './linearize-bubble';

function bubble(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

test('single <p> with one text node returns its textContent', () => {
  const b = bubble('<p>hello world</p>');
  const r = linearizeBubble(b);
  expect(r.text).toBe('hello world');
  expect(r.offsetMap).toHaveLength(1);
  expect(r.offsetMap[0].sourceStart).toBe(0);
  expect(r.offsetMap[0].sourceEnd).toBe(11);
});

test('<br> inside a paragraph becomes \\n', () => {
  const b = bubble('<p>foo<br>bar</p>');
  const r = linearizeBubble(b);
  expect(r.text).toBe('foo\nbar');
  expect(r.offsetMap).toHaveLength(2);
  expect(r.offsetMap[0].sourceStart).toBe(0);
  expect(r.offsetMap[0].sourceEnd).toBe(3);
  expect(r.offsetMap[1].sourceStart).toBe(4);
  expect(r.offsetMap[1].sourceEnd).toBe(7);
});

test('two <p> siblings produce \\n\\n gap', () => {
  const b = bubble('<p>foo</p><p>bar</p>');
  const r = linearizeBubble(b);
  expect(r.text).toBe('foo\n\nbar');
  expect(r.offsetMap[0].sourceStart).toBe(0);
  expect(r.offsetMap[0].sourceEnd).toBe(3);
  expect(r.offsetMap[1].sourceStart).toBe(5);
  expect(r.offsetMap[1].sourceEnd).toBe(8);
});

test('inline <span> flattens with no separator', () => {
  const b = bubble('<p>foo<span>bar</span>baz</p>');
  const r = linearizeBubble(b);
  expect(r.text).toBe('foobarbaz');
  expect(r.offsetMap).toHaveLength(3);
});

test('data-vishrun-widget subtree is skipped entirely', () => {
  const b = bubble('<p>before</p><div data-vishrun-widget="foo"><span>SHOULD_NOT_APPEAR</span></div><p>after</p>');
  const r = linearizeBubble(b);
  expect(r.text).toBe('before\n\nafter');
  expect(r.text.includes('SHOULD_NOT_APPEAR')).toBe(false);
});

test('Jujutsu announcement shape: 3 <p> siblings with <br> internals', () => {
  const b = bubble(
    '<p>[ START OF ANNOUNCEMENT SYSTEM ]<br>[ SYSTEM INITIALIZATION : MANUAL ENTRY ]<br>Entity has defined.</p>' +
    '<p>⬡ Name: Sol<br>⬡ Age: 30</p>' +
    '<p>Acknowledge.<br>[ END OF ANNOUNCEMENT SYSTEM ]</p>',
  );
  const r = linearizeBubble(b);
  expect(r.text.startsWith('[ START OF ANNOUNCEMENT SYSTEM ]\n')).toBe(true);
  expect(r.text.includes('\n\n⬡ Name: Sol\n')).toBe(true);
  expect(r.text.endsWith('[ END OF ANNOUNCEMENT SYSTEM ]')).toBe(true);
  // A multi-line regex on this text can match across paragraphs:
  const re = /\[\s*START OF ANNOUNCEMENT SYSTEM\s*\][\s\S]*?\[\s*END OF ANNOUNCEMENT SYSTEM\s*\]/;
  expect(re.test(r.text)).toBe(true);
});

test('getLinearizedBubble caches by textContent hash', () => {
  const b = bubble('<p>hello</p>');
  const r1 = getLinearizedBubble(b);
  const r2 = getLinearizedBubble(b);
  expect(r1).toBe(r2); // same reference: cache hit
});

test('cache invalidates when bubble content changes', () => {
  const b = bubble('<p>hello</p>');
  const r1 = getLinearizedBubble(b);
  b.innerHTML = '<p>changed</p>';
  const r2 = getLinearizedBubble(b);
  expect(r2.text).toBe('changed');
  expect(r1).not.toBe(r2);
});

test('invalidateLinearizedBubble forces re-linearization', () => {
  const b = bubble('<p>hello</p>');
  const r1 = getLinearizedBubble(b);
  invalidateLinearizedBubble(b);
  const r2 = getLinearizedBubble(b);
  expect(r1).not.toBe(r2);
  expect(r2.text).toBe(r1.text); // same content though
});
