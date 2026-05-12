import type { CompiledScript } from './parse-regex-script';
import { substitute } from './substitute';

// Real nested cards are ≤2 levels (Satoru Bottom2 → role_npc). 5 is a safety
// bound so a misauthored mutual reference can't blow the stack — at the limit
// we stop and leave the deeper tags as raw text.
export const MAX_RECURSION = 5;

/**
 * Recursively expand regex_scripts inside an already-substituted HTML fragment.
 * When script A's replaceString embeds tags that script B matches (Satoru
 * Bottom2's <status_bottom_npc> wraps several <role_npc> blocks), B is
 * substituted inline so the single iframe carries the whole nested tree.
 *
 * `allScripts` is the card's full compiled set (disabled ones already dropped
 * by compileScripts). `processing` holds the script ids on the current
 * recursion path — a script never re-matches itself, which bounds recursion
 * alongside MAX_RECURSION. `unknown`-shape scripts are skipped (no usable
 * substitution route; already logged at compile time).
 */
export function applyNestedPipeline(
  html: string,
  allScripts: CompiledScript[],
  processing: Set<string> = new Set(),
  depth: number = 0,
): string {
  if (depth >= MAX_RECURSION) {
    console.warn(`[vishrun] nested pipeline hit MAX_RECURSION (${MAX_RECURSION}); deeper tags left unsubstituted`);
    return html;
  }
  let out = html;
  for (const script of allScripts) {
    if (script.kind === 'unknown') continue;
    if (processing.has(script.id)) continue;
    out = expand(out, script, allScripts, processing, depth);
  }
  return out;
}

// Replace every match of `script` in `html`, substituting $N from captures and
// recursing into each substituted fragment. Returns `html` unchanged when
// nothing matched (avoids rebuilding the string).
function expand(
  html: string,
  script: CompiledScript,
  allScripts: CompiledScript[],
  processing: Set<string>,
  depth: number,
): string {
  script.findRe.lastIndex = 0;
  let m = script.findRe.exec(html);
  if (m === null) return html;
  const nextProcessing = new Set(processing).add(script.id);
  let out = '';
  let cursor = 0;
  while (m !== null) {
    out += html.slice(cursor, m.index);
    const groups = m.slice(1).map((g) => g ?? '');
    const substituted = substitute(script.replaceString, m[0], groups);
    out += applyNestedPipeline(substituted, allScripts, nextProcessing, depth + 1);
    cursor = m.index + m[0].length;
    if (m[0].length === 0) script.findRe.lastIndex++;
    m = script.findRe.exec(html);
  }
  out += html.slice(cursor);
  return out;
}
