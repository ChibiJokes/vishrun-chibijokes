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
        `(not placeholder, paired-tag, nor delimited-capture) — will not render. findRegex: ${src}`,
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
