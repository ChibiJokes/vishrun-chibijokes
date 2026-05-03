/**
 * Minimal backend stub. Vishrun is logically frontend-only: all card
 * widget rendering, regex evaluation, and DOM injection happen in the
 * browser. The reason this file exists is the cors-proxy bridge.
 *
 * window.spindleSandbox.corsProxy() routes through:
 *   child sandbox  →  host frontend  →  WS  →  extension worker  →
 *   spindleApi.cors()  →  backend host fetch
 *
 * The frontend → worker hop goes through ws/handler.ts:189-200 which
 * looks up the worker via getWorkerHost(extensionId) and silently drops
 * the message if no worker exists. Without a backend entry the worker
 * never spawns, so __cors_proxy_request packets disappear into the
 * void and the frontend's 30s timeout fires — exactly the symptom
 * observed when external image fetches were first wired up.
 *
 * worker-runtime.ts:2762-2787 implements the cors-proxy bridge as a
 * catch-all on `frontend_message`, independent of anything the
 * extension's setup() does. So as long as the worker is alive, the
 * bridge works. An empty setup is sufficient — we don't need to
 * register handlers, subscribe to events, or expose any backend API.
 */
export function setup(): void {
  // intentionally empty
}
