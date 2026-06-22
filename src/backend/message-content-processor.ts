import type {
  MessageContentProcessorCtxDTO,
  MessageContentProcessorResultDTO,
  LlmMessageDTO,
  InterceptorResultDTO,
} from 'lumiverse-spindle-types';
import { api, varsLog } from './common';
import { parseSetvarChain } from './parsers/setvar';
import { applySetvarOp as applySetvarOpDefault } from './setvar-ops';

// Shown when a user message was nothing but setvar-family commands — an
// empty string is accepted by the route but gives a blank bubble and an
// empty LLM turn (some providers reject that).
const EMPTY_REPLACEMENT = '_(variables updated)_';

// ─── /inject infrastructure ──────────────────────────────────────────────────

const INJECT_STORAGE_KEY = 'lumi_injects';

interface InjectSpec {
  id: string;
  content: string;
  role: 'system' | 'user' | 'assistant';
  depth: number;
  /** 'chat' = depth-based within chat history; 'before' = before first history
   *  message; 'after' = append after all messages. */
  position: 'chat' | 'before' | 'after';
  /** 0 = permanent; >0 = generations remaining before auto-removal. */
  turns: number;
}

/** Parse leading key=value pairs from a string, return remainder as content. */
function parseInjectArgs(raw: string): { args: Record<string, string>; content: string } {
  const args: Record<string, string> = {};
  let remaining = raw.trim();
  const ARG_RE = /^([a-zA-Z_]\w*)=(\S+)\s*/;
  let m: RegExpExecArray | null;
  while ((m = ARG_RE.exec(remaining)) !== null) {
    args[m[1].toLowerCase()] = m[2];
    remaining = remaining.slice(m[0].length);
  }
  return { args, content: remaining };
}

async function readInjects(chatId: string): Promise<InjectSpec[]> {
  try {
    const raw = await api.variables.chat.get(chatId, INJECT_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as InjectSpec[]) : [];
  } catch (e) {
    return [];
  }
}

async function writeInjects(chatId: string, injects: InjectSpec[]): Promise<void> {
  try {
    if (injects.length === 0) {
      await api.variables.chat.delete(chatId, INJECT_STORAGE_KEY);
    } else {
      await api.variables.chat.set(chatId, INJECT_STORAGE_KEY, JSON.stringify(injects));
    }
  } catch (e) {
    // best-effort; don't crash the message processor
  }
}

// ─────────────────────────────────────────────────────────────────────────────

const SETVAR_RE = /\/(setvar|setchatvar|setgvar|setglobalvar)\b/i;
const INJECT_RE = /\/inject\b/i;
const FLUSHINJECT_RE = /\/flushinject\b/i;

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

  if (!SETVAR_RE.test(workingContent) && !INJECT_RE.test(workingContent) && !FLUSHINJECT_RE.test(workingContent)) {
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

  // Handle /inject — store an injection spec in chat_variables for the interceptor.
  // Syntax: /inject [id=<id>] [depth=<n>] [role=system|user|assistant] [position=chat|before|after] [turns=<n>] <content>
  if (INJECT_RE.test(content)) {
    const INJECT_CMD_RE = /^\/inject(?:\s+(.*?))?\s*$/gim;
    const injects = await readInjects(ctx.chatId);
    let im: RegExpExecArray | null;
    while ((im = INJECT_CMD_RE.exec(content)) !== null) {
      const { args, content: body } = parseInjectArgs(im[1] ?? '');
      if (!body.trim()) continue;
      const id = args.id ?? Math.random().toString(36).slice(2, 10);
      const spec: InjectSpec = {
        id,
        content: body,
        role: (args.role === 'user' || args.role === 'assistant') ? args.role : 'system',
        depth: Math.max(0, parseInt(args.depth ?? '0', 10) || 0),
        position: (args.position === 'before' || args.position === 'after') ? args.position : 'chat',
        turns: Math.max(0, parseInt(args.turns ?? '0', 10) || 0),
      };
      const existing = injects.findIndex((e) => e.id === id);
      if (existing >= 0) { injects[existing] = spec; } else { injects.push(spec); }
    }
    await writeInjects(ctx.chatId, injects);
    content = content.replace(/^\/inject(?:\s+.*?)?\s*$/gim, '').replace(/\n{3,}/g, '\n\n');
  }

  // Handle /flushinject — remove one or all injections.
  // Syntax: /flushinject [id=<id>]   (omit id to flush all)
  if (FLUSHINJECT_RE.test(content)) {
    const FLUSH_CMD_RE = /^\/flushinject(?:\s+id=(\S+))?\s*$/gim;
    let injects = await readInjects(ctx.chatId);
    let fm: RegExpExecArray | null;
    while ((fm = FLUSH_CMD_RE.exec(content)) !== null) {
      const id = fm[1];
      injects = id ? injects.filter((e) => e.id !== id) : [];
    }
    await writeInjects(ctx.chatId, injects);
    content = content.replace(/^\/flushinject(?:\s+\S+)?\s*$/gim, '').replace(/\n{3,}/g, '\n\n');
  }

  if (content === ctx.content) return;
  const stripped = content.trim();
  return { content: stripped.length > 0 ? stripped : EMPTY_REPLACEMENT };
}

// ─── Prompt interceptor ───────────────────────────────────────────────────────
// Reads lumi_injects from chat_variables on every generation and splices each
// active entry into the assembled message array at the requested position/depth.
// Turn-counted entries are decremented and removed when they reach zero.

function installInjectInterceptor(): void {
  api.registerInterceptor(async (messages: LlmMessageDTO[], context: unknown): Promise<InterceptorResultDTO> => {
    const ctx = context as { chatId?: string };
    if (!ctx.chatId) return { messages };

    const injects = await readInjects(ctx.chatId);
    if (injects.length === 0) return { messages };

    const result: LlmMessageDTO[] = [...messages];
    const surviving: InjectSpec[] = [];
    const breakdown: Array<{ messageIndex: number; name: string }> = [];

    for (const spec of injects) {
      const msg: LlmMessageDTO = { role: spec.role, content: spec.content };
      let insertAt: number;

      if (spec.position === 'before') {
        const first = result.findIndex((m) => m.__isChatHistory === true);
        insertAt = first >= 0 ? first : 0;
      } else if (spec.position === 'after') {
        insertAt = result.length;
      } else {
        // 'chat': depth-based within chat history (depth 0 = append)
        if (spec.depth === 0) {
          insertAt = result.length;
        } else {
          let count = 0;
          insertAt = result.length;
          for (let i = result.length - 1; i >= 0; i--) {
            if (result[i].__isChatHistory === true) {
              count++;
              if (count === spec.depth) { insertAt = i; break; }
            }
          }
        }
      }

      result.splice(insertAt, 0, msg);
      breakdown.push({ messageIndex: insertAt, name: 'Inject: ' + spec.id });

      if (spec.turns === 0) {
        surviving.push(spec);
      } else if (spec.turns > 1) {
        surviving.push({ ...spec, turns: spec.turns - 1 });
      }
      // turns === 1: this was the last use, don't push back
    }

    if (surviving.length !== injects.length) {
      await writeInjects(ctx.chatId, surviving);
    }

    return { messages: result, breakdown };
  });
}

export function installMessageContentProcessor(): void {
  api.registerMessageContentProcessor((ctx) => processMessageContent(ctx), 50);
  installInjectInterceptor();
}
