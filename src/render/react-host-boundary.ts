// React owns the host nodes rendered by JSX, not the HTML descendants that
// Lumiverse inserts into ProseHtml. Check the node itself, never its ancestors:
// ordinary Markdown paragraphs and streaming spans must remain removable.
export function isReactManagedNode(node: Node): boolean {
  if (Object.getOwnPropertyNames(node).some((key) =>
    key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$') ||
    key.startsWith('__reactProps$') || key.startsWith('__reactContainer$'),
  )) return true;
  // Fallback for host DOM bridges that do not expose React's expando keys.
  // Match CSS-module local names, not a particular build hash.
  if (node.nodeType !== 1) return false;
  const el = node as Element;
  return el.getAttribute('data-component') === 'MessageContent' ||
    (el.tagName === 'DIV' && Array.from(el.classList).some((name) =>
      /^(?:_?(?:prose|longMessageBody))(?:_|$)/.test(name),
    ));
}

// Native Range.deleteContents removes wholly selected nodes, including React
// hosts between two prose sections. Split at such nodes so only their contents
// are removed, leaving their original identity and parent relationship intact.
function partitionRange(range: Range): Range[] {
  const hosts: Node[] = [];
  const walk = (parent: Node): void => {
    Array.from(parent.childNodes).forEach((child, index) => {
      if (!range.intersectsNode(child)) return;
      if (isReactManagedNode(child) && range.comparePoint(parent, index) === 0 &&
          range.comparePoint(parent, index + 1) === 0) {
        hosts.push(child);
        return;
      }
      walk(child);
    });
  };
  walk(range.commonAncestorContainer);
  if (!hosts.length) return [range];
  const parts: Range[] = [];
  let tail = range.cloneRange();
  for (const host of hosts) {
    const before = tail.cloneRange();
    before.setEndBefore(host);
    if (!before.collapsed) parts.push(before);
    const inside = range.cloneRange();
    inside.selectNodeContents(host);
    if (!inside.collapsed) parts.push(...partitionRange(inside));
    tail.setStartAfter(host);
  }
  if (!tail.collapsed) parts.push(tail);
  return parts;
}

export function deleteRangePreservingReactHosts(range: Range): Range {
  const parts = partitionRange(range);
  if (parts.length === 1 && parts[0] === range) {
    range.deleteContents();
    return range;
  }
  const insertion = range.cloneRange();
  insertion.collapse(true);
  for (let i = parts.length - 1; i >= 0; i--) parts[i].deleteContents();
  return insertion;
}
