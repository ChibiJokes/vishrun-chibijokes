import type { SpindleAPI, RequestInitDTO } from 'lumiverse-spindle-types';

/**
 * Backend worker module. Vishrun is logically frontend-only — card widget
 * rendering, regex evaluation, and DOM injection all happen in the browser —
 * but the worker still has to exist and do two things:
 *
 *  1. Keep the worker alive so the sandbox's `window.spindleSandbox.corsProxy`
 *     bridge works. That bridge runs as a catch-all on `frontend_message`
 *     packets shaped `__cors_proxy_request` inside the host worker runtime
 *     (worker-runtime.ts), independent of anything this module registers — but
 *     the runtime only spawns the worker if a backend entry exists. Without it,
 *     `__cors_proxy_request` packets disappear and the frontend's 30s timeout
 *     fires; that was the symptom when external image fetches were first wired.
 *
 *  2. Serve the `fetch_external` protocol for the frontend module. The frontend
 *     needs to download cross-origin assets (today the Tailwind Play CDN
 *     bundle; later React/Babel UMDs) to inline into widget sandboxes, but
 *     `SpindleFrontendContext` has no CORS proxy — only the worker's
 *     `spindle.cors` does. So the frontend sends
 *     `{ type: 'fetch_external', requestId, url }`, this handler proxies via
 *     `spindle.cors(url, { responseType: 'text' })`, and replies with
 *     `{ type: 'fetch_external_response', requestId, ok, body | error }`.
 *     `spindle.cors` requires the `cors_proxy` permission (declared in
 *     spindle.json); if it isn't granted the call rejects and we report
 *     `ok: false`, and the frontend silently renders the widget without the
 *     asset.
 *
 * The host worker runtime loads this file with a bare `import()` and exposes
 * the `SpindleAPI` as `globalThis.spindle` beforehand — there is no `setup(api)`
 * callback for backend modules — so the handler is registered at module top
 * level. `setup()` is kept as a no-op export for forward compatibility / the
 * prior convention.
 */

declare const spindle: SpindleAPI;

interface FetchExternalRequest {
  type: 'fetch_external';
  requestId: string;
  url: string;
}

function isFetchExternalRequest(p: unknown): p is FetchExternalRequest {
  return (
    !!p &&
    typeof p === 'object' &&
    (p as { type?: unknown }).type === 'fetch_external' &&
    typeof (p as { requestId?: unknown }).requestId === 'string' &&
    typeof (p as { url?: unknown }).url === 'string'
  );
}

function extractBody(result: unknown): string {
  // spindle.cors(url, { responseType: 'text' }) resolves with
  // { status, statusText, headers, body } where body is the response text.
  if (result && typeof result === 'object' && typeof (result as { body?: unknown }).body === 'string') {
    return (result as { body: string }).body;
  }
  return '';
}

spindle.onFrontendMessage((payload, userId) => {
  if (!isFetchExternalRequest(payload)) return;
  const { requestId, url } = payload;
  const options: RequestInitDTO = { responseType: 'text' };
  spindle.cors(url, options).then(
    (result) => {
      spindle.sendToFrontend(
        { type: 'fetch_external_response', requestId, ok: true, body: extractBody(result) },
        userId,
      );
    },
    (err: unknown) => {
      spindle.sendToFrontend(
        {
          type: 'fetch_external_response',
          requestId,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        },
        userId,
      );
    },
  );
});

export function setup(): void {
  // intentionally empty — registration happens at module top level (see above)
}
