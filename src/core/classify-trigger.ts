/**
 * Heuristic: a regex is a "placeholder" trigger if its source contains no
 * unescaped, non-grouping `(`. Paired-tag triggers like
 * `<VAVESTA_STATUS>([\s\S]*?)<\/VAVESTA_STATUS>` always carry a capture
 * group to inline emitted data; placeholders like `【VAVESTA_HOME】` don't.
 *
 * Step 2 only handles placeholders. Step 3 will register paired-tag scripts
 * via ctx.messages.registerTagInterceptor — a different code path that
 * synchronously fires during render with the captured inner content.
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
