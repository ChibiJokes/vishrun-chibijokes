import type {
  MessageContentProcessorCtxDTO,
  MessageContentProcessorResultDTO,
} from 'lumiverse-spindle-types';
import { api, varsLog } from './common';
import { parseSetvarChain } from './parsers/setvar';
import { applySetvarOp as applySetvarOpDefault } from './setvar-ops';

// Shown when a user message was nothing but setvar-family commands — an
// empty string is accepted by the route but gives a blank bubble and an
// empty LLM turn (some providers reject that).
const EMPTY_REPLACEMENT = '_(variables updated)_';

const SETVAR_RE = /\/(setvar|setchatvar|setgvar|setglobalvar)\b/i;

// Self-closing custom tags → paired form. Lumiverse's tag interceptor only
// handles paired tags (<TAG>...</TAG>); DOMPurify strips unknown self-closing
// elements. Expanding here (before Lumiverse renders) lets the interceptor
// pipeline work without modifying Lumiverse.
const SELF_CLOSING_CUSTOM_RE = /<([A-Z][a-zA-Z0-9_-]*)(\s[^>]*)?\s*\/>/g;
export function expandSelfClosingTags(content: string): string {
  return content.replace(SELF_CLOSING_CUSTOM_RE, (_m, tag: string, attrs: string | undefined) => {
    const a = attrs ? attrs.trimEnd() : '';
    return `<${tag}${a}></${tag}>`;
  });
}

export interface ContentProcessorDeps {
  applySetvarOp?: typeof applySetvarOpDefault;
}

// Pure handler — exported for unit testing. The host wraps it in
// installMessageContentProcessor() with priority 50.
//
// Important invariant: this processor MUST NOT strip <UpdateVariable>
// blocks from the stored content. The MVU snapshot is computed by replaying
// chat messages through computeVariablesSnapshot, which needs the blocks
// intact in the DB row. Visual stripping is done at render time by a tag
// interceptor with removeFromMessage:true (see frontend setup).
export async function processMessageContent(
  ctx: MessageContentProcessorCtxDTO,
  deps: ContentProcessorDeps = {},
): Promise<MessageContentProcessorResultDTO | void> {
  const applySetvar = deps.applySetvarOp ?? applySetvarOpDefault;

  // Expand self-closing custom tags on every origin. Pure, idempotent.
  const workingContent = expandSelfClosingTags(ctx.content);
  const selfCloseChanged = workingContent !== ctx.content;

  // Render is non-persisting and must not run /setvar (which writes to
  // backend state). Return display-only expansion if anything changed.
  if (ctx.origin === 'render') {
    return selfCloseChanged ? { content: workingContent } : undefined;
  }

  if (!SETVAR_RE.test(workingContent)) {
    return selfCloseChanged ? { content: workingContent } : undefined;
  }

  let content = workingContent;
  const parsed = parseSetvarChain(content);
  if (parsed) {
    for (const { kind, key, value } of parsed.pairs) {
      try {
        await applySetvar({ kind, name: key, value }, ctx.chatId, ctx.userId);
      } catch (err) {
        varsLog.warn(
          `setvar failed for "${kind}::${key}":`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    content = parsed.strippedContent;
  }

  if (content === ctx.content) return;
  const stripped = content.trim();
  return { content: stripped.length > 0 ? stripped : EMPTY_REPLACEMENT };
}

export function installMessageContentProcessor(): void {
  api.registerMessageContentProcessor((ctx) => processMessageContent(ctx), 50);
}
