// JS-Slash-Runner-compatible iframe sizing.
//
// SillyTavern's JS Slash Runner sizes message iframes from body.scrollHeight
// only. Vishrun previously added child margins and downward box-shadow extents
// to that number. For HUD cards with a large decorative box-shadow this made
// the sandbox itself much taller than the visible card, producing large blank
// gaps between consecutive widgets in Lumiverse.

export interface ChildMetrics {
  /** child.getBoundingClientRect().bottom + window.scrollY. */
  documentRelativeBottom: number;
  /** Retained for API/test compatibility; no longer added to iframe height. */
  marginBottom: number;
  /** Retained for API/test compatibility; no longer added to iframe height. */
  shadowDown: number;
}

const BOX_SHADOW_OFFSET_RE = /-?\d+px\s+(-?\d+)px\s+(-?\d+)px(?:\s+(-?\d+)px)?/;

/** Kept for callers/tests that inspect shadows, but sizing parity deliberately
 * does not use the result. */
export function parseBoxShadowDownExtent(boxShadow: string | null | undefined): number {
  if (!boxShadow || boxShadow === 'none') return 0;
  const m = boxShadow.match(BOX_SHADOW_OFFSET_RE);
  if (!m) return 0;
  const y = parseFloat(m[1]) || 0;
  if (y <= 0) return 0;
  const blur = parseFloat(m[2]) || 0;
  const spread = parseFloat(m[3] || '0') || 0;
  return y + blur + spread;
}

/**
 * Match JS Slash Runner: body.scrollHeight is authoritative.
 * A child-bottom fallback is only used when scrollHeight is unavailable/zero.
 * Margins and box-shadows are intentionally excluded because they are visual
 * overflow, not layout height, and were the source of Vishrun's dead space.
 */
export function computeContentHeight(
  children: readonly ChildMetrics[],
  bodyScrollHeight: number,
): number {
  if (Number.isFinite(bodyScrollHeight) && bodyScrollHeight > 0) {
    return Math.ceil(bodyScrollHeight);
  }

  let maxBottom = 0;
  for (const c of children) {
    if (Number.isFinite(c.documentRelativeBottom) && c.documentRelativeBottom > maxBottom) {
      maxBottom = c.documentRelativeBottom;
    }
  }
  return Math.ceil(Math.max(0, maxBottom));
}

/** Preserved helper for compatibility with older tests/callers. */
export function detectGrowthLoop(history: readonly number[]): boolean {
  if (history.length < 4) return false;
  const n = history.length;
  const d1 = history[n - 3] - history[n - 4];
  const d2 = history[n - 2] - history[n - 3];
  const d3 = history[n - 1] - history[n - 2];
  if (d1 === 0) return false;
  return d1 === d2 && d2 === d3;
}

/**
 * Injected reporter modeled on JS Slash Runner's adjust_iframe_height.js:
 * measure body.scrollHeight, schedule through rAF, and observe body resizes.
 */
export function buildSizeReporterShell(): string {
  return `
<script>
(function() {
  var scheduled = false;

  function measureAndPost() {
    scheduled = false;
    try {
      var body = document.body;
      if (!body) return;

      var h = body.scrollHeight;
      if (!isFinite(h) || h <= 0) {
        var rect = body.getBoundingClientRect();
        h = rect && isFinite(rect.height) ? rect.height : 0;
      }
      h = Math.ceil(h);
      if (!isFinite(h) || h <= 0) return;

      if (window.spindleSandbox && typeof window.spindleSandbox.requestResize === 'function') {
        window.spindleSandbox.requestResize(h);
      }
    } catch (e) {}
  }

  function postSize() {
    if (scheduled) return;
    scheduled = true;
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(measureAndPost);
    } else {
      setTimeout(measureAndPost, 0);
    }
  }

  function init() {
    postSize();
    if (typeof ResizeObserver !== 'undefined' && document.body) {
      try {
        var ro = new ResizeObserver(postSize);
        ro.observe(document.body);
      } catch (e) {}
    }
    window.addEventListener('load', postSize);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
</script>`;
}
