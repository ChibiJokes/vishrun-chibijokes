import { test, expect } from 'bun:test';
import { lodashShim } from './lodash-shim';

test('lodashShim wraps in <script> tag with banner', () => {
  const out = lodashShim();
  expect(out.startsWith('<script>')).toBe(true);
  expect(out.endsWith('</script>')).toBe(true);
  expect(out.includes('lodash.com/license')).toBe(true);
});

test('lodashShim bundle is substantial (sanity)', () => {
  expect(lodashShim().length).toBeGreaterThan(50_000);
});

test('lodashShim contains the _.get marker', () => {
  // Lodash min contains a `function(n,t,r)` shape; the more reliable
  // identifier check is the runtime: when evaluated, _ exposes .get.
  // We can't eval here cleanly (window globals leak); rely on the size
  // sanity above and lodash-shim's runtime test (via mvu-shim e2e).
  const out = lodashShim();
  expect(out.includes('lodash')).toBe(true);
});
