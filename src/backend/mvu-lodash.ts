// Pure parser for `_.set(...)` calls emitted by MVU-aware cards in
// LLM responses (Queen Bee's mid-chat variable updates). Strictly
// scoped to the two- and three-arg forms with literal newValue types
// (number / string / boolean / null). Anything else — `_.assign`,
// `_.add`, deltas like `'+50'`, JSON literals like `[1,2,3]`, math
// expressions — is reported via the optional onUnsupported callback
// and skipped. The recognizer in mvu-parser.ts wraps this.

export type LiteralValue = string | number | boolean | null;

export interface LodashSetCall {
  /** Dotted path argument, quotes stripped. */
  path: string;
  /** Parsed literal value (last positional argument). */
  newValue: LiteralValue;
  /** Source offset of the call's `_.set(` prefix in the input block. */
  index: number;
}

export type OnUnsupported = (snippet: string, reason: string) => void;

const CMD_RE = /_\.([a-zA-Z][a-zA-Z0-9_]*)\s*\(/g;
const SNIPPET_LEN = 80;

/**
 * Parse every `_.<cmd>(...)` call in `blockContent`. For each one:
 *   - If cmd !== 'set': onUnsupported(reason='not-dot-set') and skip.
 *   - If the call is malformed (unbalanced parens): onUnsupported(reason='malformed-call') and skip.
 *   - If arg count is not 2 or 3: onUnsupported(reason='malformed-call') and skip.
 *   - If path arg isn't a plain quoted string of our supported shape:
 *       onUnsupported(reason='path-not-string-literal') and skip.
 *   - If newValue arg isn't a supported literal:
 *       onUnsupported(reason='value-not-literal') and skip.
 *   - Else: append { path, newValue, index } to the result list.
 *
 * Defensive: never throws on malformed input.
 */
export function parseLodashSetCalls(
  blockContent: string,
  onUnsupported?: OnUnsupported,
): LodashSetCall[] {
  const out: LodashSetCall[] = [];
  CMD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CMD_RE.exec(blockContent)) !== null) {
    const cmd = m[1];
    const callStart = m.index;
    const argsStart = m.index + m[0].length;

    const argsParse = scanArgList(blockContent, argsStart);
    if (argsParse === null) {
      onUnsupported?.(snippet(blockContent, callStart), 'malformed-call');
      continue;
    }
    const { args, endIndex } = argsParse;

    if (cmd !== 'set') {
      onUnsupported?.(snippet(blockContent, callStart), 'not-dot-set');
      CMD_RE.lastIndex = endIndex;
      continue;
    }

    if (args.length !== 2 && args.length !== 3) {
      onUnsupported?.(snippet(blockContent, callStart), 'malformed-call');
      CMD_RE.lastIndex = endIndex;
      continue;
    }

    const pathArg = args[0].trim();
    const valueArg = args[args.length - 1].trim();

    const path = parseStringLiteral(pathArg);
    if (path === null || path.length === 0) {
      onUnsupported?.(snippet(blockContent, callStart), 'path-not-string-literal');
      CMD_RE.lastIndex = endIndex;
      continue;
    }

    const newValue = parseLiteralValue(valueArg);
    if (newValue === undefined) {
      onUnsupported?.(snippet(blockContent, callStart), 'value-not-literal');
      CMD_RE.lastIndex = endIndex;
      continue;
    }

    out.push({ path, newValue, index: callStart });
    CMD_RE.lastIndex = endIndex;
  }
  return out;
}

// ---- Internal helpers ----

function snippet(src: string, start: number): string {
  return src.slice(start, start + SNIPPET_LEN);
}

interface ArgParseResult {
  args: string[];
  /** Source index immediately AFTER the closing paren. */
  endIndex: number;
}

// Walk the source from `start` (the char right after `_.set(`), tracking
// paren / bracket / brace depth and quote state, until we find the
// matching close paren. Splits top-level commas (depth-zero across all
// three bracket families) into argument substrings. Returns null on
// unbalanced input.
//
// Bracket / brace tracking matters because JSON-literal newValues like
// `[1, 2, 3]` or `{ x: 1, y: 2 }` contain internal commas that would
// otherwise split into spurious extra "args" and confuse the call shape.
// We keep these as a single arg so parseLiteralValue can reject them
// uniformly as `'value-not-literal'`.
function scanArgList(src: string, start: number): ArgParseResult | null {
  const args: string[] = [];
  let cur = '';
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let inString: '"' | "'" | null = null;
  let i = start;
  while (i < src.length) {
    const c = src[i];
    if (inString !== null) {
      cur += c;
      if (c === '\\' && i + 1 < src.length) {
        cur += src[i + 1];
        i += 2;
        continue;
      }
      if (c === inString) inString = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = c;
      cur += c;
      i++;
      continue;
    }
    if (c === '(') { parenDepth++; cur += c; i++; continue; }
    if (c === '[') { bracketDepth++; cur += c; i++; continue; }
    if (c === '{') { braceDepth++; cur += c; i++; continue; }
    if (c === ')') {
      if (parenDepth === 0) {
        if (cur.length > 0 || args.length > 0) args.push(cur);
        return { args, endIndex: i + 1 };
      }
      parenDepth--;
      cur += c;
      i++;
      continue;
    }
    if (c === ']') {
      if (bracketDepth > 0) bracketDepth--;
      cur += c;
      i++;
      continue;
    }
    if (c === '}') {
      if (braceDepth > 0) braceDepth--;
      cur += c;
      i++;
      continue;
    }
    if (c === ',' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      args.push(cur);
      cur = '';
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  return null;
}

// Plain string literal: surrounded by matching `'` or `"`, no backslash
// escapes, no embedded same-quote char, no brackets, no dots-with-escape.
// Returns the inner content, or null on any non-conforming shape.
function parseStringLiteral(raw: string): string | null {
  if (raw.length < 2) return null;
  const open = raw[0];
  if (open !== '"' && open !== "'") return null;
  if (raw[raw.length - 1] !== open) return null;
  const inner = raw.slice(1, -1);
  // Out of scope: backslash escapes within quotes.
  if (inner.indexOf('\\') !== -1) return null;
  // Out of scope: bracket notation (`stat_data["x"]`).
  if (inner.indexOf('[') !== -1 || inner.indexOf(']') !== -1) return null;
  // Embedded same-quote that wasn't terminated — argsplit should have
  // tolerated this only if escaped; defensive check.
  if (inner.indexOf(open) !== -1) return null;
  return inner;
}

// Recognise newValue forms supported in this iteration:
//   - true / false / null (case-sensitive bare keyword)
//   - quoted string (single or double), with the same restrictions as
//     parseStringLiteral, plus a delta-shape guard that rejects strings
//     starting with `+digit` or `-digit` — those are intended math
//     expressions (out of scope) and we'd silently misinterpret them
//     as literal strings.
//   - number (integer or decimal, optionally negative).
// Returns undefined for anything else (caller logs value-not-literal).
function parseLiteralValue(raw: string): LiteralValue | undefined {
  const t = raw.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;

  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0]) {
    const inner = parseStringLiteral(t);
    if (inner === null) return undefined;
    // Delta-shape guard: `'+50'` or `'-7'` inside quotes is the MVU
    // convention for "add 50" / "subtract 7" — a delta operation, not
    // a literal string assignment. Out of scope this iteration; the
    // recognizer reports it via onUnsupported instead of writing the
    // string at the path (which would silently misinterpret intent).
    if (/^[+-]\d/.test(inner)) return undefined;
    return inner;
  }

  // Number: optional minus, digits, optional fractional part. No
  // exponent / hex / bigint forms — none of the cards in scope use them.
  if (/^-?\d+(?:\.\d+)?$/.test(t)) return parseFloat(t);

  return undefined;
}
