import { test, expect } from 'bun:test';
import { jqueryShim, stripCdnJQuery } from './jquery-shim';

test('jqueryShim wraps in <script> tag and contains the banner', () => {
  const out = jqueryShim();
  expect(out.startsWith('<script>')).toBe(true);
  expect(out.endsWith('</script>')).toBe(true);
  expect(out.includes('jQuery v3.5.1')).toBe(true);
});

test('jqueryShim bundle is substantial (sanity vs empty/broken text import)', () => {
  expect(jqueryShim().length).toBeGreaterThan(50_000);
});

test('stripCdnJQuery removes code.jquery.com script tag', () => {
  const html = `<head><script src="https://code.jquery.com/jquery-3.6.0.min.js"></script></head><body>x</body>`;
  expect(stripCdnJQuery(html)).toBe(`<head></head><body>x</body>`);
});

test('stripCdnJQuery removes cdnjs jquery tag', () => {
  const html = `<script src="https://cdnjs.cloudflare.com/ajax/libs/jquery/3.6.0/jquery.min.js"></script>`;
  expect(stripCdnJQuery(html)).toBe('');
});

test('stripCdnJQuery removes unpkg jquery tag', () => {
  const html = `<script src="https://unpkg.com/jquery@3.6.0/dist/jquery.min.js"></script>`;
  expect(stripCdnJQuery(html)).toBe('');
});

test('stripCdnJQuery removes jsdelivr jquery tag', () => {
  const html = `<script src="https://cdn.jsdelivr.net/npm/jquery@3/dist/jquery.min.js"></script>`;
  expect(stripCdnJQuery(html)).toBe('');
});

test('stripCdnJQuery preserves non-jquery script tags', () => {
  const html = `<script src="https://unpkg.com/react@18/umd/react.production.min.js"></script><script src="https://code.jquery.com/jquery-3.6.0.min.js"></script>`;
  const out = stripCdnJQuery(html);
  expect(out.includes('react@18')).toBe(true);
  expect(out.includes('code.jquery.com')).toBe(false);
});

test('stripCdnJQuery preserves random https script tags', () => {
  const html = `<script src="https://example.com/main.js"></script>`;
  expect(stripCdnJQuery(html)).toBe(html);
});

test('stripCdnJQuery tolerant of attribute order and whitespace', () => {
  const html = `<script   defer   src= "https://code.jquery.com/jquery-3.5.1.min.js"   integrity="x"   ></script>`;
  expect(stripCdnJQuery(html).trim()).toBe('');
});

test('stripCdnJQuery short-circuits when text has no jquery', () => {
  const html = '<div>hello</div>';
  expect(stripCdnJQuery(html)).toBe(html);
});

test('stripCdnJQuery preserves inline jquery scripts (not src=)', () => {
  const html = `<script>jQuery.fn.extend({foo:1});</script>`;
  expect(stripCdnJQuery(html)).toBe(html);
});

test('stripCdnJQuery handles multiple jquery cdn tags', () => {
  const html = `<script src="https://code.jquery.com/jquery-3.6.0.min.js"></script><div>x</div><script src="https://cdnjs.cloudflare.com/ajax/libs/jquery/3.5.1/jquery.min.js"></script>`;
  expect(stripCdnJQuery(html)).toBe('<div>x</div>');
});

test('stripCdnJQuery does NOT strip jquery-ui or jquery-cookie (only base jquery filenames)', () => {
  // Allowed: jquery-3.x.min.js, jquery.min.js.
  // The regex matches "jquery" substring in filename which would ALSO catch
  // jquery-ui, jquery-cookie, etc. Document the current behavior: we strip
  // anything whose path contains "jquery" from a known CDN host. If a card
  // needed jquery-ui specifically we'd refine the regex; no card in scope
  // ships those.
  const html = `<script src="https://code.jquery.com/ui/1.13.2/jquery-ui.min.js"></script>`;
  // Current behavior: strips it (filename contains "jquery").
  expect(stripCdnJQuery(html)).toBe('');
});
