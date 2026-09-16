const WIDGET_ATTR = 'data-vishrun-widget';
const WIDGET_SEL = '[data-vishrun-widget]';

function isOrContainsWidget(node: Node): boolean {
  if (node.nodeType !== 1) return false;
  const el = node as Element;
  if (el.hasAttribute(WIDGET_ATTR)) return true;
  return !!el.querySelector?.(WIDGET_SEL);
}

function isInsideWidget(node: Node): boolean {
  let cur: Node | null = node.parentNode;
  while (cur) {
    if (cur.nodeType === 1 && (cur as Element).hasAttribute?.(WIDGET_ATTR)) return true;
    cur = cur.parentNode;
  }
  return false;
}

// A "self" mutation is one Vishrun caused itself by injecting or removing widgets.
// Added widgets are unambiguously ours. Added text-only is external (React content
// update). characterData inside an existing widget is ours. Removal-only records
// are treated as external — we can't distinguish Vishrun's cleanupOrphans from
// React reconciliation tearing our widget out, and the safe side is to rescan.
export function isSelfMutation(record: MutationRecord): boolean {
  if (record.type === 'characterData') return isInsideWidget(record.target);
  if (record.addedNodes.length === 0) return false;
  for (let i = 0; i < record.addedNodes.length; i++) {
    if (isOrContainsWidget(record.addedNodes[i])) return true;
  }
  return false;
}

export function allSelf(records: MutationRecord[]): boolean {
  for (let i = 0; i < records.length; i++) {
    if (!isSelfMutation(records[i])) return false;
  }
  return true;
}
