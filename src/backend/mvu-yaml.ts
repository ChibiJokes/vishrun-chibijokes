// Minimal YAML parser for the MVU <initvar> subset documented in
// docs/mvu-design.md. Block-style mappings only, space indentation,
// scalar values (string / int / float). CJK keys supported. Quoted
// strings, flow style, arrays, block scalars, anchors, tags are not
// supported — malformed lines are skipped with a warning.

export type YamlValue = string | number | YamlMap;
export interface YamlMap {
  [key: string]: YamlValue;
}

const INT_RE = /^-?\d+$/;
const FLOAT_RE = /^-?\d+\.\d+$/;

function parseScalar(raw: string): string | number {
  const v = raw.trim();
  if (INT_RE.test(v)) return parseInt(v, 10);
  if (FLOAT_RE.test(v)) return parseFloat(v);
  return v;
}

interface LineToken {
  lineNo: number;
  indent: number;
  key: string;
  value: string | null;
}

function tokenizeLines(source: string): LineToken[] {
  const out: LineToken[] = [];
  const lines = source.split(/\r?\n/).map((l) => l.replace(/\r+$/, ''));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const m = /^( *)(.*)$/.exec(line);
    if (!m) continue;
    const indent = m[1].length;
    const rest = m[2];
    if (rest === '') continue;

    // Split on the FIRST `: ` (colon followed by space). A bare trailing
    // `:` (key followed by `:` with nothing after) introduces a nested map.
    const sepIdx = rest.indexOf(': ');
    let key: string;
    let value: string | null;
    if (sepIdx >= 0) {
      key = rest.slice(0, sepIdx).trim();
      value = rest.slice(sepIdx + 2);
    } else if (rest.endsWith(':')) {
      key = rest.slice(0, -1).trim();
      value = null;
    } else {
      console.warn('[vishrun:mvu-yaml] skipped malformed line', { lineNo: i + 1, line });
      continue;
    }
    if (key === '') {
      console.warn('[vishrun:mvu-yaml] skipped empty-key line', { lineNo: i + 1, line });
      continue;
    }
    out.push({ lineNo: i + 1, indent, key, value });
  }
  return out;
}

export function parseYaml(source: string): YamlMap {
  const tokens = tokenizeLines(source);
  const root: YamlMap = {};
  // Stack of frames. The root sentinel has indent -1.
  const stack: Array<{ indent: number; container: YamlMap }> = [
    { indent: -1, container: root },
  ];
  for (const t of tokens) {
    while (stack.length > 1 && stack[stack.length - 1].indent >= t.indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1].container;
    if (t.value === null) {
      const child: YamlMap = {};
      parent[t.key] = child;
      stack.push({ indent: t.indent, container: child });
    } else {
      parent[t.key] = parseScalar(t.value);
    }
  }
  return root;
}
