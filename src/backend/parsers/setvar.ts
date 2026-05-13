// Parser for SillyTavern `/setvar` slash-command chains pasted into the chat
// input. Subset only — `/setvar key=NAME VALUE` with `|` chaining, quoted or
// bare values. No other slash commands. Used by message-content-processor.ts.

export interface SetvarPair {
  key: string;
  value: string;
}

export interface SetvarParseResult {
  pairs: SetvarPair[];
  /** The message content with the parsed `/setvar` commands removed. */
  strippedContent: string;
}

// Leading `/setvar key=NAME VALUE` at the start of a (trimmed) chain segment.
// NAME: up to whitespace / quote / `=` / `|`. VALUE: "..."(\-escapes) | '...'(\-escapes) | bare token.
const SETVAR_HEAD =
  /^\/setvar\s+key\s*=\s*([^\s"'=|]+)\s+(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\S+))\s*/i;

// Cheap pre-check: does the content reference a `/setvar` command at all?
const SETVAR_HINT = /\/setvar\b/i;

function unescapeQuoted(s: string, quote: '"' | "'"): string {
  // Only `\<quote>` and `\\` are real escapes; leave other backslash pairs intact.
  return s.replace(/\\(.)/g, (_m, c: string) => (c === quote || c === '\\' ? c : '\\' + c));
}

// Split a chain on top-level `|` and newlines, ignoring separators inside
// "..." / '...' (with `\` escapes). A newline inside quotes survives.
function splitChain(s: string): string[] {
  const out: string[] = [];
  let buf = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      buf += ch;
      if (ch === '\\' && i + 1 < s.length) {
        buf += s[++i];
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
    } else if (ch === '|' || ch === '\n') {
      out.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
  }
  out.push(buf);
  return out;
}

// Parse one chain segment. If it leads with `/setvar key=...`, return the pair
// plus any trailing non-command text from the same segment. Otherwise the whole
// (trimmed) segment is preserved text.
function parseSegment(seg: string): { pair: SetvarPair | null; rest: string } {
  const trimmed = seg.trim();
  const m = SETVAR_HEAD.exec(trimmed);
  if (!m) return { pair: null, rest: trimmed };
  const key = m[1];
  let value: string;
  if (m[2] !== undefined) value = unescapeQuoted(m[2], '"');
  else if (m[3] !== undefined) value = unescapeQuoted(m[3], "'");
  else value = m[4]; // bare token
  return { pair: { key, value }, rest: trimmed.slice(m[0].length).trim() };
}

// Extract `/setvar` pairs from a message and return the content with those
// commands removed (preserved text re-joined with ` | `). `null` when there's
// no parseable `/setvar` — caller leaves the message untouched.
export function parseSetvarChain(content: string): SetvarParseResult | null {
  if (!SETVAR_HINT.test(content)) return null;
  const pairs: SetvarPair[] = [];
  const kept: string[] = [];
  for (const seg of splitChain(content)) {
    const { pair, rest } = parseSegment(seg);
    if (pair) pairs.push(pair);
    if (rest) kept.push(rest);
  }
  if (pairs.length === 0) return null;
  return { pairs, strippedContent: kept.join(' | ').trim() };
}
