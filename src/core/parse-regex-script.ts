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
 * Compile raw regex_scripts into a usable form.
 *  - Drops disabled scripts.
 *  - Drops scripts whose `placement` is set and excludes 2 (render-side).
 *    Scripts with no placement are kept (treat as "applies anywhere").
 *  - Builds findRe with `new RegExp(source, 'gs')` from raw source — no
 *    slash-stripping (Step 1 finding: source arrives without delimiters).
 *    `s` (dotAll) lets `.` match newlines so paired-tag scripts whose
 *    inner content spans lines (e.g. Xiao Gu's 12 pipe-separated groups
 *    when the AI breaks them across lines) still match.
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

    let re: RegExp;
    try {
      re = new RegExp(src, 'gs');
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
  } catch (err) {
    console.error('[vishrun] stripCodeFence self-test threw:', err);
  }
})();
