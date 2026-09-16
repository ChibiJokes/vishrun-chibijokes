import { test, expect } from 'bun:test';
import { isSelfMutation, allSelf } from './self-mutation';

function widgetEl(): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute('data-vishrun-widget', 'Test');
  return el;
}

function nonWidgetEl(tag = 'p', html = 'hi'): HTMLElement {
  const el = document.createElement(tag);
  el.innerHTML = html;
  return el;
}

function wrapperWith(widget: HTMLElement): HTMLElement {
  const wrap = document.createElement('section');
  wrap.appendChild(widget);
  return wrap;
}

function childListRecord(added: Node[] = [], removed: Node[] = [], target?: Node): MutationRecord {
  return {
    type: 'childList',
    target: target ?? document.body,
    addedNodes: added as unknown as NodeList,
    removedNodes: removed as unknown as NodeList,
    previousSibling: null,
    nextSibling: null,
    attributeName: null,
    attributeNamespace: null,
    oldValue: null,
  } as unknown as MutationRecord;
}

function charDataRecord(target: Node): MutationRecord {
  return {
    type: 'characterData',
    target,
    addedNodes: [] as unknown as NodeList,
    removedNodes: [] as unknown as NodeList,
    previousSibling: null,
    nextSibling: null,
    attributeName: null,
    attributeNamespace: null,
    oldValue: null,
  } as unknown as MutationRecord;
}

// ── isSelfMutation ───────────────────────────────────────────────────────

test('addedNodes contains a Vishrun widget -> self', () => {
  expect(isSelfMutation(childListRecord([widgetEl()]))).toBe(true);
});

test('addedNodes contains a wrapper holding a Vishrun widget -> self', () => {
  expect(isSelfMutation(childListRecord([wrapperWith(widgetEl())]))).toBe(true);
});

test('addedNodes mixed: widget + accompanying text nodes (frag insert) -> self', () => {
  const text1 = document.createTextNode('before ');
  const text2 = document.createTextNode(' after');
  expect(isSelfMutation(childListRecord([text1, widgetEl(), text2]))).toBe(true);
});

test('addedNodes only plain element (no widget) -> external', () => {
  expect(isSelfMutation(childListRecord([nonWidgetEl('p', 'hello')]))).toBe(false);
});

test('addedNodes only text nodes -> external', () => {
  expect(isSelfMutation(childListRecord([document.createTextNode('hi')]))).toBe(false);
});

test('removedNodes only, addedNodes empty (could be widget cleanup OR React removal) -> external (safe)', () => {
  expect(isSelfMutation(childListRecord([], [widgetEl()]))).toBe(false);
});

test('characterData inside a Vishrun widget -> self', () => {
  const widget = widgetEl();
  const inner = document.createElement('span');
  widget.appendChild(inner);
  const text = document.createTextNode('hi');
  inner.appendChild(text);
  expect(isSelfMutation(charDataRecord(text))).toBe(true);
});

test('characterData outside any widget -> external', () => {
  const p = nonWidgetEl('p');
  const text = document.createTextNode('hi');
  p.appendChild(text);
  expect(isSelfMutation(charDataRecord(text))).toBe(false);
});

test('characterData on a detached node -> external (no ancestor widget reachable)', () => {
  const text = document.createTextNode('hi');
  expect(isSelfMutation(charDataRecord(text))).toBe(false);
});

// ── allSelf ──────────────────────────────────────────────────────────────

test('empty batch -> allSelf is true (no-op)', () => {
  expect(allSelf([])).toBe(true);
});

test('batch with one self record -> true', () => {
  expect(allSelf([childListRecord([widgetEl()])])).toBe(true);
});

test('batch with one external record -> false', () => {
  expect(allSelf([childListRecord([nonWidgetEl()])])).toBe(false);
});

test('batch mixed: all self plus one external -> false', () => {
  expect(allSelf([
    childListRecord([widgetEl()]),
    childListRecord([widgetEl()]),
    childListRecord([nonWidgetEl()]),
  ])).toBe(false);
});

test('batch all self (multiple widget injections) -> true', () => {
  expect(allSelf([
    childListRecord([widgetEl()]),
    childListRecord([wrapperWith(widgetEl())]),
  ])).toBe(true);
});
