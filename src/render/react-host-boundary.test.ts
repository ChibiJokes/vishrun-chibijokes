import { test, expect } from 'bun:test';
import { cleanupEmptyAroundWidget, replaceLinearRange } from './inject-into-message';
import { linearizeBubble } from './linearize-bubble';
import { hideRange } from './pending-hide';

function fixture(html: string): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute('data-component', 'MessageContent');
  el.innerHTML = html;
  return el;
}
function markHost<T extends Element>(el: T): T {
  Object.defineProperty(el, '__reactFiber$random-build-key', { value: { stateNode: el }, configurable: true });
  return el;
}
function widget(): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute('data-vishrun-widget', 'test');
  el.textContent = 'W';
  return el;
}

test('widget-only paragraph and chunkFade are physically removed without detaching React hosts', () => {
  const root = fixture('<div class="arbitrary-body"><div class="arbitrary-prose"><p><span class="_chunkFade_hash"> </span></p></div></div>');
  const body = markHost(root.firstElementChild!);
  const prose = markHost(body.firstElementChild!);
  const w = widget();
  prose.querySelector('span')!.appendChild(w);
  cleanupEmptyAroundWidget(w, root);
  expect(w.parentNode).toBe(prose);
  expect(prose.querySelector('p,span')).toBeNull();
  expect(prose.parentNode).toBe(body);
  expect(body.parentNode).toBe(root);
  expect(() => body.removeChild(prose)).not.toThrow();
});

test('hash-independent fallback preserves empty React prose and body containers', () => {
  const root = fixture('<div class="_longMessageBody_newhash_45"><div class="_prose_newhash_181"><p></p></div><div class="_prose_otherhash_181"></div></div>');
  const body = root.firstElementChild!;
  const prose = body.firstElementChild!;
  const sibling = prose.nextElementSibling!;
  const w = widget();
  prose.querySelector('p')!.appendChild(w);
  cleanupEmptyAroundWidget(w, root);
  expect(w.parentNode).toBe(prose);
  expect(prose.parentNode).toBe(body);
  expect(sibling.parentNode).toBe(body);
});

test('adjacent widget iframes survive and their temporary wrappers disappear in order', () => {
  const root = fixture('<div><p><span class="chunkFade"><iframe data-vishrun-widget="one"></iframe></span><span class="chunkFade"><iframe data-vishrun-widget="two"></iframe></span></p><p><br></p><div><iframe></iframe></div><p><span>Story</span></p></div>');
  const prose = markHost(root.firstElementChild!);
  const widgets = Array.from(root.querySelectorAll<HTMLIFrameElement>('[data-vishrun-widget]'));
  const media = root.querySelector('iframe:not([data-vishrun-widget])')!;
  for (const w of widgets) cleanupEmptyAroundWidget(w, root);
  expect(widgets[0].parentNode).toBe(prose);
  expect(widgets[1].parentNode).toBe(prose);
  expect(widgets[0].nextElementSibling).toBe(widgets[1]);
  expect(root.querySelector('iframe:not([data-vishrun-widget])')).toBe(media);
  expect(root.querySelectorAll('p')).toHaveLength(1);
  expect(root.querySelector('p span')!.textContent).toBe('Story');
});

test('multiline replacement preserves a fully selected middle React prose host', () => {
  const root = fixture('<div><div><p>before [START] first</p></div><div><p>middle</p></div><div><p>last [END] after</p></div></div>');
  const body = markHost(root.firstElementChild!);
  const hosts = Array.from(body.children).map(markHost);
  const linear = linearizeBubble(root);
  const w = widget();
  expect(replaceLinearRange(root, linear.offsetMap, linear.text.indexOf('[START]'), linear.text.indexOf('[END]') + 5, w)).toBe(true);
  expect(root.textContent).toBe('before W after');
  expect(root.querySelector('[data-vishrun-widget]')).toBe(w);
  for (const host of hosts) expect(host.parentNode).toBe(body);
});

test('pending raw captures do not hide a React structural host', () => {
  const root = fixture('<div><p>[START] raw text</p></div>');
  const prose = markHost(root.firstElementChild!);
  const linear = linearizeBubble(root);
  hideRange(root, linear.offsetMap, 0, linear.text.length);
  expect(prose.hasAttribute('data-vishrun-pending')).toBe(false);
  expect(prose.querySelector('p')!.hasAttribute('data-vishrun-pending')).toBe(true);
});
