import type { SpindleFrontendContext } from 'lumiverse-spindle-types';
import type { CompiledScript } from '../core/parse-regex-script';
import { substitute } from '../core/substitute';
import { buildWidgetIframe, widgetNeedsIsolation } from './widget-iframe';
import { getCapturesForMessage } from '../hooks/tag-interceptor';

/**
 * Process a single message DOM. Two pipelines, kept separate per the
 * Step 3 design constraint:
 *
 *   1. Placeholder pipeline (Step 2 + iframe extension)
 *      For each compiled placeholder script, find every match in the
 *      message's text nodes and replace with a widget. The widget is a
 *      <div> with innerHTML if the replaceString has no <script>, or a
 *      sandboxed iframe if it does.
 *
 *   2. Paired-tag pipeline (Step 3)
 *      Read the captures map populated by tag-interceptor.ts. For each
 *      capture not already rendered as a widget in this message, append
 *      one to the message's [data-component="MessageContent"] node.
 *      Widgets are always iframes here for safety — paired-tag widgets
 *      tend to carry behavior (Vavesta Court Ledger has <script>) and
 *      keeping them isolated from the host CSS is conservative.
 *
 * Idempotency: both pipelines skip work where a [data-vishrun-widget] is
 * already in place. Re-running on the same DOM is a no-op.
 */
export function processNode(
  root: HTMLElement,
  scripts: CompiledScript[],
  ctx: SpindleFrontendContext,
): number {
  let total = 0;
  for (const script of scripts) {
    // Only placeholder triggers run through the post-DOMPurify text scan.
    // pairedTag scripts go through registerTagInterceptor (pre-sanitizer)
    // and surface here as captures via getCapturesForMessage. unknown
    // scripts are skipped (logged once at compile time).
    if (script.kind !== 'placeholder') continue;
    total += replacePlaceholderMatches(root, script, ctx);
  }
  const messageId = root.getAttribute('data-message-id') || undefined;
  if (messageId) {
    total += renderPairedTagCaptures(root, messageId, ctx);
  }
  return total;
}

// ─── Placeholder pipeline ──────────────────────────────────────────────

function replacePlaceholderMatches(
  root: HTMLElement,
  script: CompiledScript,
  ctx: SpindleFrontendContext,
): number {
  const textNodes = collectTextNodes(root);
  let count = 0;

  for (const tn of textNodes) {
    const text = tn.nodeValue ?? '';
    if (!text) continue;

    script.findRe.lastIndex = 0;
    const ranges: { start: number; end: number; match: RegExpExecArray }[] = [];
    let m: RegExpExecArray | null;
    while ((m = script.findRe.exec(text)) !== null) {
      ranges.push({ start: m.index, end: m.index + m[0].length, match: m });
      if (m[0].length === 0) script.findRe.lastIndex++;
    }
    if (ranges.length === 0) continue;

    const parent = tn.parentNode;
    if (!parent) continue;

    const frag = document.createDocumentFragment();
    let cursor = 0;
    for (const { start, end, match } of ranges) {
      if (start > cursor) {
        frag.appendChild(document.createTextNode(text.slice(cursor, start)));
      }
      // Placeholders typically have no captures, but a future card could
      // introduce them via (?:...) or (...). Pass match[1..] regardless;
      // substitute() handles the no-groups case fine.
      const groups = match.slice(1).map((g) => g ?? '');
      const html = substitute(script.replaceString, match[0], groups);
      const widget = buildWidget(html, script.scriptName, script.id, ctx);
      frag.appendChild(widget);
      cursor = end;
      count++;
    }
    if (cursor < text.length) {
      frag.appendChild(document.createTextNode(text.slice(cursor)));
    }
    parent.replaceChild(frag, tn);
  }

  return count;
}

// ─── Paired-tag pipeline ───────────────────────────────────────────────

function renderPairedTagCaptures(
  root: HTMLElement,
  messageId: string,
  ctx: SpindleFrontendContext,
): number {
  const captures = getCapturesForMessage(messageId);
  const target = findContentRoot(root);
  let added = 0;
  let removed = 0;

  // Phase 1 (cleanup): drop paired-tag widgets in this message that no
  // longer match any current capture. Greeting switch / edit / regen
  // depend on this — `onCapture` evicts the prior capture for a
  // (messageId, scriptId) when a new fullMatch arrives, and this loop
  // removes the matching stale widget. Filter on data-vishrun-paired-
  // fullmatch presence so we don't touch placeholder widgets — those
  // live inside the React-owned markdown subtree and React handles
  // unmount on content change.
  const existingPaired = target.querySelectorAll<HTMLElement>(
    '[data-vishrun-widget][data-vishrun-paired-fullmatch]',
  );
  existingPaired.forEach((el) => {
    const sid = el.getAttribute('data-vishrun-script-id');
    const fmHash = el.getAttribute('data-vishrun-paired-fullmatch');
    const stillValid = captures.some(
      (c) => c.scriptId === sid && hashKey(c.fullMatch) === fmHash,
    );
    if (!stillValid) {
      el.remove();
      removed++;
    }
  });

  // Phase 2 (inject): for each capture without a matching widget in the
  // DOM, build and insert. The querySelector at the top of the loop is
  // the within-scan idempotency check (a capture iterated twice in one
  // scan doesn't double-insert).
  for (const cap of captures) {
    const sel = `[data-vishrun-widget][data-vishrun-script-id="${cssEscape(cap.scriptId)}"][data-vishrun-paired-fullmatch="${cssEscape(hashKey(cap.fullMatch))}"]`;
    if (target.querySelector(sel)) continue;

    // Re-run findRe on fullMatch to recover the real capture groups.
    // payload.content (which the interceptor delivers) is a single inner
    // string and would only populate $1 — leaving $2..$N literal for cards
    // whose findRegex defines multiple groups.
    cap.findRe.lastIndex = 0;
    const m = cap.findRe.exec(cap.fullMatch);
    if (!m) {
      // Card's regex doesn't match its own fullMatch. Should be rare —
      // the tag interceptor already confirmed the tag is present — but a
      // mis-authored findRegex (extra anchors, lookarounds that miss) can
      // land here. Render the raw text inside a marked wrapper so:
      //  - ctx.dom.cleanup() removes it on teardown (vs orphan text node).
      //  - The idempotency selector at the top of this loop matches it
      //    next scan, so we don't re-append on every observer fire.
      //  - data-vishrun-widget-failed lets us spot mis-authored cards.
      console.debug(`[vishrun] paired-tag findRegex failed to re-match fullMatch for "${cap.scriptName}" — rendering raw text`);
      const failed = ctx.dom.createElement('span', {
        'data-vishrun-widget': cap.scriptName,
        'data-vishrun-widget-failed': cap.scriptName,
        'data-vishrun-script-id': cap.scriptId,
      }) as HTMLElement;
      failed.setAttribute('data-vishrun-paired-fullmatch', hashKey(cap.fullMatch));
      failed.textContent = cap.fullMatch;
      target.appendChild(failed);
      added++;
      continue;
    }
    const groups = m.slice(1).map((g) => g ?? '');
    const html = substitute(cap.replaceString, m[0], groups);
    // Paired-tag widgets always go through the iframe path. Vavesta
    // Court Ledger contains <script>, and even for hypothetical
    // script-free paired widgets the isolation is cheap insurance.
    const iframe = buildWidgetIframe(html, cap.scriptName, cap.scriptId, ctx);
    iframe.setAttribute('data-vishrun-paired-fullmatch', hashKey(cap.fullMatch));
    target.appendChild(iframe);
    added++;
  }

  return added;
}

function findContentRoot(messageNode: HTMLElement): HTMLElement {
  // Prefer MessageContent's own div — keeps widgets visually inside the
  // bubble, alongside the rendered markdown.
  const inner = messageNode.querySelector('[data-component="MessageContent"]') as HTMLElement | null;
  return inner ?? messageNode;
}

// ─── Shared helpers ────────────────────────────────────────────────────

function buildWidget(
  html: string,
  scriptName: string,
  scriptId: string,
  ctx: SpindleFrontendContext,
): HTMLElement {
  if (widgetNeedsIsolation(html)) {
    return buildWidgetIframe(html, scriptName, scriptId, ctx);
  }
  const wrapper = ctx.dom.createElement('div', {
    'data-vishrun-widget': scriptName,
    'data-vishrun-script-id': scriptId,
  }) as HTMLElement;
  // Match the iframe path's vertical breathing room (12px in widget-iframe.ts).
  // Without this, no-isolation widgets (innerHTML+div path) render flush
  // against adjacent message text and feel cramped — Step 6 user feedback.
  wrapper.style.margin = '12px 0';
  wrapper.innerHTML = html;
  return wrapper;
}

function collectTextNodes(root: HTMLElement): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      let p = node.parentElement;
      while (p && p !== root) {
        if (p.hasAttribute('data-vishrun-widget')) return NodeFilter.FILTER_REJECT;
        p = p.parentElement;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let n: Node | null;
  while ((n = walker.nextNode()) !== null) {
    out.push(n as Text);
  }
  return out;
}

function cssEscape(s: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(s)
    : s.replace(/["\\]/g, '\\$&');
}

/**
 * Compress an arbitrary fullMatch string into a short stable token usable
 * inside an attribute selector. djb2 hash → base36; collisions don't
 * matter for the (scriptId, fullMatch) idempotency check because the
 * scriptId already disambiguates per-script, and within a single script
 * collisions on inner content of paired tags are vanishingly unlikely.
 */
function hashKey(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}
