/**
 * Trigger classification — three buckets:
 *
 *   - `placeholder` → trigger is a literal-ish marker that isn't shaped like
 *     an HTML tag (e.g. `【VAVESTA_HOME】`, `[STATUS]`). Renders via the
 *     post-DOMPurify text-node scan in `replacePlaceholderMatches`.
 *
 *   - `pairedTag` → trigger has `<TAGNAME>...</TAGNAME>` shape regardless of
 *     whether it carries capture groups. Pacifica University is the canonical
 *     no-capture-group example (its findRegex wraps `PACIFICA_UI` with `\s*`
 *     decoration on both ends, matched by the tolerant detector below).
 *     These MUST go through `ctx.messages.registerTagInterceptor` because
 *     Lumiverse's DOMPurify (`richHtmlSanitizer.ts`) strips unknown elements
 *     before render — by the time the placeholder pipeline scans text nodes,
 *     `<TAGNAME>` is gone (only the inner text content survives via
 *     KEEP_CONTENT). The interceptor fires PRE-sanitizer in
 *     `stripAndDispatchMessageTags` (`MessageContent.tsx:561`).
 *
 *   - `unknown` → trigger has captures or other regex structure but doesn't
 *     match the paired-tag shape. None of the cards in scope hit this; we
 *     log once at compile time so the card author has a hint if it ever
 *     surfaces.
 *
 * Why we no longer use the "has capture group" heuristic alone: it conflates
 * "needs paired-tag pipeline" with "needs $N substitution". Pacifica needs
 * paired-tag (because of DOMPurify) but uses only `$0` (full match) — zero
 * captures. Vavesta Home is the inverse: placeholder shape, no captures.
 * The two axes are independent. Step 6 split them.
 */

export type TriggerKind = 'placeholder' | 'pairedTag' | 'unknown';

/**
 * Heuristic: regex source has no unescaped, non-grouping `(`.
 *
 * Used as a building block of `classifyTrigger`. Not a sufficient signal on
 * its own (Pacifica satisfies this — no captures — but is paired-tag, not
 * placeholder), so callers should use `classifyTrigger` instead.
 */
export function isPlaceholder(re: RegExp): boolean {
  const src = re.source;
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') { i += 2; continue; } // escape — skip next char
    if (ch === '[') {
      // skip char class — `[(...)]` is literal `(`, not a group.
      // Char classes can contain `\]` escapes.
      i++;
      while (i < src.length && src[i] !== ']') {
        if (src[i] === '\\') i += 2; else i++;
      }
      i++; // past `]`
      continue;
    }
    if (ch === '(') {
      // `(?:` non-capturing, `(?=` lookahead, `(?!` negative — none of
      // these inline captured data, so a script using only those would
      // also be a placeholder. But none of the cards in scope use them,
      // so we treat any `(` other than `(?:` as a capture-bearing group.
      if (src.slice(i, i + 3) === '(?:') { i += 3; continue; }
      return false;
    }
    i++;
  }
  return true;
}

/**
 * Heuristic: regex source matches `<TAGNAME>...</TAGNAME>` paired shape,
 * tolerant of whitespace decorations (`\s*` literal sequence, plain
 * whitespace) and the regex-escape `\/` style (e.g. `<\/TAGNAME>`).
 *
 * Stays in sync with `extractTagName` in `tag-interceptor.ts` — if a regex's
 * tag name isn't extractable by the same tolerant pattern there, no
 * interceptor can be registered, so it shouldn't be classified as
 * `pairedTag` here either. The shared assumption: card authors decorate
 * with `\s*` for paranoia, but the underlying tag name is a plain ASCII
 * identifier.
 *
 * Limitation: assumes the close tag follows the open in the same source.
 * A regex that wraps in lookaheads or has the close inside an alternation
 * could slip through. None of the cards in scope hit this.
 */
export function isPairedTag(re: RegExp): boolean {
  const src = re.source;
  // Normalize for structural matching:
  //  1. Drop `\s*` literal decorations (3-char sequence `\`, `s`, `*`).
  //  2. Drop plain whitespace.
  //  3. Replace `\/` with `/` (regex-escape style from /.../-delimited
  //     copy-paste sources).
  // After these, paired tags reduce to a clean `<TAGNAME>...</TAGNAME>`.
  const stripped = src
    .replace(/\\s\*/g, '')
    .replace(/\s+/g, '')
    .replace(/\\\//g, '/');

  const open = stripped.match(/^<([a-zA-Z_][a-zA-Z0-9_-]*)/);
  if (!open) return false;
  const tagName = open[1];
  const closeRe = new RegExp(`</${escapeRegex(tagName)}\\b`);
  return closeRe.test(stripped);
}

/**
 * Three-bucket classification. `pairedTag` wins over `placeholder` when both
 * could apply (Pacifica's regex satisfies `isPlaceholder` because it has no
 * captures, but it's structurally a paired tag and must go that route).
 */
export function classifyTrigger(re: RegExp): TriggerKind {
  if (isPairedTag(re)) return 'pairedTag';
  if (isPlaceholder(re)) return 'placeholder';
  return 'unknown';
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
