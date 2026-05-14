import JQUERY_SOURCE from '../vendor/jquery-3.5.1.min.js' with { type: 'text' };

// jQuery 3.5.1 full inlined into the iframe srcdoc head when widget tier
// is tavern-jq or higher (Queen Bee Anonymous News Flash, future tavern-mvu
// widgets). 3.5.1 full was the locally available copy from SillyTavern's
// own bundle; cards in scope only call `$(fn)` and basic selectors, which
// are covered by every 3.x release. Slim variant would save ~14KB but
// isn't locally available.

export function jqueryShim(): string {
  return '<script>' + JQUERY_SOURCE + '</script>';
}

// Strip a `<script src="...jquery...">` (and the closing tag) before
// injecting our in-tree jQuery. Cards that ship their own jQuery via CDN
// (Xiao Gu sinner) would otherwise either CSP-fail (host blocks remote
// scripts) or double-load. Conservative regex: only matches code.jquery.com
// or cdnjs paths whose filename includes the literal `jquery`. Whitespace
// and attribute order tolerant.
const JQUERY_CDN_SCRIPT_RE =
  /<script\b[^>]*\bsrc\s*=\s*["'][^"']*\b(?:code\.jquery\.com|cdnjs\.cloudflare\.com|unpkg\.com|cdn\.jsdelivr\.net)\/[^"']*\bjquery[^"']*["'][^>]*>\s*<\/script>/gi;

export function stripCdnJQuery(html: string): string {
  if (html.indexOf('jquery') === -1) return html;
  return html.replace(JQUERY_CDN_SCRIPT_RE, '');
}
