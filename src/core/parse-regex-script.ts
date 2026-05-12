import type { RawRegexScript } from '../lumiverse/fetch-character';
import { classifyTrigger, type TriggerKind } from './classify-trigger';

export interface CompiledScript {
  id: string;
  scriptName: string;
  findRe: RegExp;
  replaceString: string;
  /**
   * Trigger classification — drives pipeline routing in inject-into-message
   * and tag-interceptor. See `classify-trigger.ts` for what each kind means
   * and why the old `isPlaceholder: boolean` was insufficient (Pacifica
   * surfaced the bug: paired-tag shape with no capture groups).
   */
  kind: TriggerKind;
  sourceIndex: number;
}

/**
 * Strip a markdown code fence wrapping the entire string.
 *
 * Tolerates:
 *  - optional language hint (case-insensitive: ```html, ```HTML, ```)
 *  - leading/trailing whitespace around the whole block
 *  - trailing whitespace on the opening line (after the language hint)
 *  - CRLF or LF line endings
 *
 * Pass-through (returns input unchanged) when:
 *  - no fence at all
 *  - opening fence with no matching close
 *  - any other shape we can't unambiguously unwrap
 */
const FENCE_RE = /^\s*```[A-Za-z]*[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```\s*$/;

export function stripCodeFence(s: string): string {
  if (!s) return s;
  const m = s.match(FENCE_RE);
  return m ? m[1] : s;
}

/**
 * Parse a JS-style regex literal `/pattern/flags` out of a card's findRegex
 * source. Some cards (e.g. ↦/↤-delimited capture scripts) author their
 * findRegex with the literal delimiters intact; passing such a string raw
 * to `new RegExp` makes the slashes part of the pattern and the regex
 * never matches anything.
 *
 * The inner pattern is parsed tolerantly: escape sequences (`\.`, `\/`,
 * `\\`) are preserved as-is; the closing `/` is the first unescaped slash.
 * Flags are validated against the JS-supported set; anything else falls
 * through to "not a literal" so we don't silently misinterpret a pattern
 * that happens to start with `/`.
 *
 * Returns `{ pattern, flags }` — `flags` is `''` when the input wasn't a
 * literal (caller treats the whole input as the pattern).
 */
export function parseRegexLiteral(s: string): { pattern: string; flags: string } {
  const m = s.match(/^\s*\/((?:\\.|[^/\\])*)\/([gimsuy]*)\s*$/);
  if (!m || !m[1]) return { pattern: s, flags: '' };
  return { pattern: m[1], flags: m[2] };
}

/**
 * Merge user flags from a regex literal with the default `gs` Vishrun
 * relies on. `g` is required for `matchAll`-style scanning in the render
 * pipeline; `s` (dotAll) is needed so paired-tag scripts whose inner
 * content spans lines still match. Duplicates are deduped.
 */
export function mergeFlags(userFlags: string): string {
  const set = new Set<string>(['g', 's']);
  for (const f of userFlags) set.add(f);
  return Array.from(set).join('');
}

/**
 * Compile raw regex_scripts into a usable form.
 *  - Drops disabled scripts.
 *  - Drops scripts whose `placement` is set and excludes 2 (render-side).
 *    Scripts with no placement are kept (treat as "applies anywhere").
 *  - Builds findRe with `new RegExp(pattern, flags)`. Pattern/flags come
 *    from `parseRegexLiteral` which strips `/.../flags` delimiters when
 *    the card authored them (ts-edition cards do; older Lumi cards don't).
 *    Default flags `gs` are always merged in: `g` for matchAll scanning,
 *    `s` (dotAll) so paired-tag scripts whose inner content spans lines
 *    (e.g. Xiao Gu's 12 pipe-separated groups when the AI breaks them
 *    across lines) still match.
 *  - Strips markdown code fence around replaceString.
 *  - Drops scripts whose findRegex fails to compile (with debug log).
 */
export function compileScripts(rawScripts: RawRegexScript[]): CompiledScript[] {
  const out: CompiledScript[] = [];
  for (let i = 0; i < rawScripts.length; i++) {
    const s = rawScripts[i];
    if (s.disabled) continue;
    if (Array.isArray(s.placement) && !s.placement.includes(2)) continue;
    const src = s.findRegex;
    if (!src || typeof src !== 'string') continue;
    const replace = stripCodeFence(s.replaceString ?? '');

    const { pattern, flags } = parseRegexLiteral(src);
    let re: RegExp;
    try {
      re = new RegExp(pattern, mergeFlags(flags));
    } catch (err) {
      console.debug(`[vishrun] script "${s.scriptName ?? '(unnamed)'}" findRegex failed to compile:`, err);
      continue;
    }

    const kind = classifyTrigger(re);
    if (kind === 'unknown') {
      console.debug(
        `[vishrun] script "${s.scriptName ?? '(unnamed)'}" has unrecognized trigger shape ` +
        `(neither placeholder nor paired-tag) — will not render. findRegex: ${src}`,
      );
    }

    out.push({
      id: s.id ?? `idx-${i}`,
      scriptName: s.scriptName ?? '(unnamed)',
      findRe: re,
      replaceString: replace,
      kind,
      sourceIndex: i,
    });
  }
  return out;
}

// ─── In-module sanity tests for stripCodeFence ──────────────────────────
// Run once at import time. Cheap, catches surprise inputs early. Wrapped
// so any assertion failure logs but never crashes the extension.
(function selfTest() {
  try {
    const t1 = '```html\n<!DOCTYPE html>\n<body>x</body>\n```';
    console.assert(
      stripCodeFence(t1) === '<!DOCTYPE html>\n<body>x</body>',
      '[vishrun] stripCodeFence: lowercase html lang hint',
    );

    const t2 = '```HTML\n  hi  \n```';
    console.assert(
      stripCodeFence(t2) === '  hi  ',
      '[vishrun] stripCodeFence: uppercase HTML lang hint preserves inner whitespace',
    );

    const t3 = '```\nfoo\n```';
    console.assert(
      stripCodeFence(t3) === 'foo',
      '[vishrun] stripCodeFence: no lang hint',
    );

    const t4 = '   ```html  \r\nfoo\r\n```   ';
    console.assert(
      stripCodeFence(t4) === 'foo',
      '[vishrun] stripCodeFence: surrounding whitespace + CRLF + trailing space on opening line',
    );

    const t5 = '<!DOCTYPE html>\nno fence here';
    console.assert(
      stripCodeFence(t5) === t5,
      '[vishrun] stripCodeFence: pass-through when no fence',
    );

    const t6 = '```html\nopener but no close';
    console.assert(
      stripCodeFence(t6) === t6,
      '[vishrun] stripCodeFence: pass-through when opening fence has no close',
    );

    // Real Vavesta shape: opens with ```html\n<!DOCTYPE html>...\n```
    const t7 = '```html\n<!DOCTYPE html>\n<html lang="en">\n<body><div class="vav-home-wrap"></div></body>\n</html>\n```';
    const stripped = stripCodeFence(t7);
    console.assert(
      stripped.startsWith('<!DOCTYPE html>') && stripped.endsWith('</html>'),
      '[vishrun] stripCodeFence: Vavesta-shaped block unwraps cleanly',
    );

    const r1 = parseRegexLiteral('/↦(\\S+)\\s([^:]+):([\\s\\S]*?)↤/g');
    console.assert(
      r1.pattern === '↦(\\S+)\\s([^:]+):([\\s\\S]*?)↤' && r1.flags === 'g',
      '[vishrun] parseRegexLiteral: ↦/↤-delimited literal with g flag',
    );

    const r2 = parseRegexLiteral('【VAVESTA_HOME】');
    console.assert(
      r2.pattern === '【VAVESTA_HOME】' && r2.flags === '',
      '[vishrun] parseRegexLiteral: non-literal placeholder passes through',
    );

    const r3 = parseRegexLiteral('<\\s*PACIFICA_UI\\s*>([\\s\\S]*?)<\\s*\\/PACIFICA_UI\\s*>');
    console.assert(
      r3.pattern === '<\\s*PACIFICA_UI\\s*>([\\s\\S]*?)<\\s*\\/PACIFICA_UI\\s*>' && r3.flags === '',
      '[vishrun] parseRegexLiteral: paired-tag source without delimiters passes through',
    );

    const r4 = parseRegexLiteral('/foo\\/bar/i');
    console.assert(
      r4.pattern === 'foo\\/bar' && r4.flags === 'i',
      '[vishrun] parseRegexLiteral: escaped slash inside pattern is not a closer',
    );

    const r5 = parseRegexLiteral('/no closer');
    console.assert(
      r5.pattern === '/no closer' && r5.flags === '',
      '[vishrun] parseRegexLiteral: unmatched leading / passes through',
    );

    console.assert(
      mergeFlags('') === 'gs',
      '[vishrun] mergeFlags: empty user flags → default gs',
    );
    console.assert(
      [...mergeFlags('gi')].sort().join('') === 'gis',
      '[vishrun] mergeFlags: dedupes g and adds i',
    );
  } catch (err) {
    console.error('[vishrun] parse-regex-script self-test threw:', err);
  }
})();
