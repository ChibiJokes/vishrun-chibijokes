// @bun
// src/backend.ts
function isFetchExternalRequest(p) {
  return !!p && typeof p === "object" && p.type === "fetch_external" && typeof p.requestId === "string" && typeof p.url === "string";
}
function extractBody(result) {
  if (result && typeof result === "object" && typeof result.body === "string") {
    return result.body;
  }
  return "";
}
spindle.onFrontendMessage((payload, userId) => {
  if (!isFetchExternalRequest(payload))
    return;
  const { requestId, url } = payload;
  const options = { responseType: "text" };
  spindle.cors(url, options).then((result) => {
    spindle.sendToFrontend({ type: "fetch_external_response", requestId, ok: true, body: extractBody(result) }, userId);
  }, (err) => {
    spindle.sendToFrontend({
      type: "fetch_external_response",
      requestId,
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }, userId);
  });
});
function setup() {}
export {
  setup
};
