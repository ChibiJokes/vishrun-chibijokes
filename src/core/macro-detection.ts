// Cheap pre-filter so widget HTML with no macros skips the backend round-trip.
// Matches `{{name}}` and `{{name::...}}`, incl. `@`/`$`-prefixed forms. Leans
// permissive: a false positive costs a no-op resolve, a false negative just
// leaves a macro literal (no worse than before MVU-lite).
const MACRO_RE = /\{\{\s*[A-Za-z_@$][\w@$]*\s*(?:::|\}\})/;

export function hasMacros(html: string): boolean {
  return MACRO_RE.test(html);
}
