/**
 * Trigger classification — four buckets:
 *
 *   - `placeholder` → trigger is a literal-ish marker that isn't shaped like
 *     an HTML tag and has no capture groups (e.g. `【VAVESTA_HOME】`,
 *     `<StatusPlaceHolderImpl/>`). Renders via the post-DOMPurify text-node
 *     scan in `replacePlaceholderMatches`.
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
 *   - `delimitedCapture` → trigger has capture group(s) wrapped in a
 *     recognized non-tag delimiter: a Unicode bracket pair (`【】` `「」` `《》`
 *     `『』`, the asymmetric `↦↤`) or a symmetric `[ START OF X ]…[ END OF X ]`
 *     textual block marker. Behaves like `placeholder` for DOM purposes (the
 *     delimiters survive DOMPurify, so it goes through the text-node scan +
 *     `$N` substitution). Jujutsu Kaisen World's HUD/Profile/Inventory lines,
 *     Domain Clash, Inner Monologue, Present Characters, the Check scripts.
 *
 *   - `unknown` → has captures or other regex structure but matches none of
 *     the above. We log once at compile time so the card author has a hint.
 *
 * Why we no longer use the "has capture group" heuristic alone: it conflates
 * "needs paired-tag pipeline" with "needs $N substitution". Pacifica needs
 * paired-tag (because of DOMPurify) but uses only `$0` (full match) — zero
 * captures. Vavesta Home is the inverse: placeholder shape, no captures.
 * The two axes are independent. Step 6 split them; Fix B added the fourth bucket.
 */

export type TriggerKind = 'placeholder' | 'pairedTag' | 'delimitedCapture' | 'unknown';

/** Kinds that render through the placeholder pipeline (text-node scan + $N). */
export function isPlaceholderLikeKind(kind: TriggerKind): boolean {
  return kind === 'placeholder' || kind === 'delimitedCapture';
}

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

// Unicode delimiter pairs Vishrun recognizes for `delimitedCapture` — symmetric
// CJK brackets plus the asymmetric ↦…↤. Strict allowlist on purpose: a future
// card with another delimiter gets added here, no generic wildcard.
const DELIM_PAIRS: ReadonlyArray<readonly [open: string, close: string]> = [
  ['【', '】'],
  ['「', '」'],
  ['《', '》'],
  ['『', '』'],
  ['↦', '↤'],
];

/**
 * Heuristic: regex source contains a `(` that opens a real capturing group —
 * i.e. not `(?:`, `(?=`, `(?!`, or `(?<...` (lookbehind / named group). Skips
 * escapes and char classes the same way `isPlaceholder` does.
 */
function hasRealCapture(src: string): boolean {
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === '[') {
      i++;
      while (i < src.length && src[i] !== ']') { i += src[i] === '\\' ? 2 : 1; }
      i++;
      continue;
    }
    if (ch === '(') {
      const a = src.slice(i + 1, i + 3);
      const grouping = a === '?:' || a === '?=' || a === '?!' || (a[0] === '?' && a[1] === '<');
      if (!grouping) return true;
    }
    i++;
  }
  return false;
}

/**
 * For `[ START OF X ]…[ END OF X ]` textual block markers: the decoration-
 * stripped name following `kw` in the regex source, up to the first `]` /
 * `\]`. `null` if `kw` (or its closing bracket) isn't present. Used only to
 * confirm the START and END names match (symmetric markers).
 */
function textualMarkerName(src: string, kw: 'START OF' | 'END OF'): string | null {
  const i = src.indexOf(kw);
  if (i < 0) return null;
  const rest = src.slice(i + kw.length);
  const end = rest.search(/\\?\]/);
  if (end < 0) return null;
  const name = rest
    .slice(0, end)
    .replace(/\\s[*+]?/g, '')   // drop `\s` / `\s*` / `\s+` decorations
    .replace(/\\/g, '')          // drop stray backslashes
    .replace(/\s+/g, ' ')
    .trim();
  return name || null;
}

/**
 * Heuristic: regex carries real capture group(s) AND wraps them in a
 * recognized non-tag delimiter — a Unicode pair from `DELIM_PAIRS` (opener
 * before a matching closer) or symmetric `START OF X` / `END OF X` textual
 * markers. Tag-shaped sources are explicitly rejected (that's `pairedTag`'s
 * job, checked first). Conservative: anything else stays `unknown`.
 */
export function isDelimitedCapture(re: RegExp): boolean {
  const src = re.source;
  if (!hasRealCapture(src)) return false;
  const head = src.replace(/^(?:\\s[*+]?|\s)+/, '');
  if (/^<[a-zA-Z_]/.test(head)) return false; // tag-like opener — not ours
  for (const [open, close] of DELIM_PAIRS) {
    const oi = src.indexOf(open);
    if (oi >= 0 && src.indexOf(close, oi + open.length) >= 0) return true;
  }
  const n1 = textualMarkerName(src, 'START OF');
  const n2 = textualMarkerName(src, 'END OF');
  return !!n1 && n1 === n2;
}

/**
 * Four-bucket classification. Order matters: `pairedTag` wins over `placeholder`
 * (Pacifica satisfies `isPlaceholder` — no captures — but is structurally a
 * paired tag); both win over `delimitedCapture` (a `<TAGNAME (foo)>…</TAGNAME>`
 * with captures is a paired tag, not a delimited-capture marker).
 */
export function classifyTrigger(re: RegExp): TriggerKind {
  if (isPairedTag(re)) return 'pairedTag';
  if (isPlaceholder(re)) return 'placeholder';
  if (isDelimitedCapture(re)) return 'delimitedCapture';
  return 'unknown';
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── In-module sanity tests for classifyTrigger ─────────────────────────
// Run once at import time. Cheap; catches classifier regressions. Wrapped so
// any assertion failure logs but never crashes the extension.
(function selfTest() {
  try {
    const ck = (re: RegExp, expect: TriggerKind, label: string) => {
      const got = classifyTrigger(re);
      console.assert(got === expect, `[vishrun] classifyTrigger: ${label} → expected ${expect}, got ${got}`);
    };
    ck(/【女王蜂】/, 'placeholder', '【】 no captures');
    ck(/<StatusPlaceHolderImpl\/>/, 'placeholder', 'self-closing tag, no captures');
    ck(/<status_top>([\s\S]*?)<\/status_top>/, 'pairedTag', 'paired tag with capture');
    ck(/<phone app="([^"]*)">([\s\S]*?)<\/phone>/, 'pairedTag', 'paired tag with attr + captures');
    ck(/【SYS_HUD \| Loc: (.*?) \| Time: (.*?)】/, 'delimitedCapture', '【】 with captures');
    ck(/『Present Characters Start』([\s\S]*?)『Present Characters End』/, 'delimitedCapture', '『』 block with capture');
    ck(/↦(\S+)\s([^:]+):([\s\S]*?)↤/, 'delimitedCapture', '↦↤ with captures');
    ck(/「(.*?)」/, 'delimitedCapture', '「」 with capture');
    ck(/《(.*?)》/, 'delimitedCapture', '《》 with capture');
    ck(
      new RegExp('\\[\\s*START OF ANN SYS\\s*\\]([\\s\\S]*?)\\[\\s*END OF ANN SYS\\s*\\]'),
      'delimitedCapture',
      '[ START OF X ]…[ END OF X ] textual markers with capture',
    );
    ck(/foo(.*?)bar/, 'unknown', 'capture but no recognized delimiter');
  } catch (err) {
    console.error('[vishrun] classify-trigger self-test threw:', err);
  }
})();
