import type {
  MessageContentProcessorCtxDTO,
  MessageContentProcessorResultDTO,
  LlmMessageDTO,
  InterceptorResultDTO,
} from 'lumiverse-spindle-types';
import { api, varsLog } from './common';
import { parseSetvarChain } from './parsers/setvar';
import { applySetvarOp as applySetvarOpDefault } from './setvar-ops';

const EMPTY_REPLACEMENT = '_(variables updated)_';

// ─── /inject infrastructure ──────────────────────────────────────────────────
// Inject specs are stored in api.storage (extension-scoped file storage) rather
// than api.variables.chat. This avoids a race where generate.service.ts writes
// the macro environment's snapshot of chat_variables back to the DB after the
// interceptor has already updated them, clobbering the turn decrement.

interface InjectSpec {
  id: string;
  content: string;
  role: 'system' | 'user' | 'assistant';
  depth: number;
  position: 'chat' | 'before' | 'after';
  turns: number;
}

function injectPath(chatId: string): string {
  return `injects/${chatId}.json`;
}

async function readInjects(chatId: string): Promise<InjectSpec[]> {
  try {
    return await api.storage.getJson<InjectSpec[]>(injectPath(chatId), { fallback: [] });
  } catch (e) {
    return [];
  }
}

async function writeInjects(chatId: string, injects: InjectSpec[]): Promise<void> {
  try {
    if (injects.length === 0) {
      await api.storage.delete(injectPath(chatId));
    } else {
      await api.storage.setJson(injectPath(chatId), injects);
    }
  } catch (e) {
    // best-effort; don't crash the processor
  }
}

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

// ─────────────────────────────────────────────────────────────────────────────

const SETVAR_RE = /\/(setvar|setchatvar|setgvar|setglobalvar)\b/i;
const INJECT_RE = /\/inject\b/i;
const FLUSHINJECT_RE = /\/flushinject\b/i;

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

export async function processMessageContent(
  ctx: MessageContentProcessorCtxDTO,
  deps: ContentProcessorDeps = {},
): Promise<MessageContentProcessorResultDTO | void> {
  const applySetvar = deps.applySetvarOp ?? applySetvarOpDefault;

  const workingContent = expandSelfClosingTags(ctx.content);
  const selfCloseChanged = workingContent !== ctx.content;

  if (ctx.origin === 'render') {
    return selfCloseChanged ? { content: workingContent } : undefined;
  }

  if (!SETVAR_RE.test(workingContent) && !INJECT_RE.test(workingContent) && !FLUSHINJECT_RE.test(workingContent)) {
    return selfCloseChanged ? { content: workingContent } : undefined;
  }

  let content = workingContent;

  if (SETVAR_RE.test(content)) {
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
  }

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

function installInjectInterceptor(): void {
  // Use `any` for the payload to defensively capture the entire generation state object
  api.registerInterceptor(async (payload: any, context: unknown): Promise<InterceptorResultDTO | any> => {
    const ctx = context as { chatId?: string };
    
    // Safely extract messages whether Spindle passes an array directly or a payload object
    const isArray = Array.isArray(payload);
    const messagesArray: LlmMessageDTO[] = isArray ? payload : (payload.messages || []);

    if (!ctx.chatId) return payload;

    const injects = await readInjects(ctx.chatId);
    if (injects.length === 0) return payload; // Return unmodified payload if no injects

    const result: LlmMessageDTO[] = [...messagesArray];
    const surviving: InjectSpec[] = [];
    const breakdown: Array<{ messageIndex: number; name: string }> = isArray ? [] : (payload.breakdown || []);

    for (const spec of injects) {
      const msg: LlmMessageDTO = { role: spec.role, content: spec.content };
      let insertAt: number;

      if (spec.position === 'before') {
        const first = result.findIndex((m: any) => m.__isChatHistory === true);
        insertAt = first >= 0 ? first : 0;
      } else if (spec.position === 'after') {
        insertAt = result.length;
      } else {
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
    }

    if (surviving.length !== injects.length) {
      await writeInjects(ctx.chatId, surviving);
    }

    // CRITICAL FIX: If payload is an object, spread it to preserve all variables and system state!
    if (isArray) {
      return { messages: result, breakdown };
    } else {
      return { ...payload, messages: result, breakdown };
    }
  });
}

export function installMessageContentProcessor(): void {
  api.registerMessageContentProcessor((ctx) => processMessageContent(ctx), 50);
  installInjectInterceptor();
}
