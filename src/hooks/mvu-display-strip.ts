import type { SpindleFrontendContext } from 'lumiverse-spindle-types';

// System-wide tag interceptor that hides <UpdateVariable> blocks from the
// rendered chat UI. The block must remain in the stored message body for
// the replay-from-messages snapshot (see backend/mvu-parser.ts), so we
// strip visually rather than destructively in message-content-processor.
//
// removeFromMessage:true is display-only — verified in
// Lumiverse/frontend/src/lib/spindle/message-interceptors.ts: the host
// substitutes the match with '' in the output string, the DB row is
// untouched.
//
// The handler is a no-op. We don't need the captured content here — the
// backend replay reads it directly from chat.getMessages.
export function registerMvuDisplayStrip(ctx: SpindleFrontendContext): () => void {
  return ctx.messages.registerTagInterceptor(
    { tagName: 'updatevariable', removeFromMessage: true },
    () => { /* handler is intentionally empty */ },
  );
}
