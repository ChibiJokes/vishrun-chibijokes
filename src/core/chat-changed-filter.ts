const VAR_PATH_RE = /^metadata\.(macro_variables|chat_variables)(\.|$)/;

export function shouldRescanForChangedFields(changedFields: string[] | undefined): boolean {
  if (changedFields === undefined) return true;
  if (changedFields.length === 0) return false;
  return changedFields.some((f) => !VAR_PATH_RE.test(f));
}
