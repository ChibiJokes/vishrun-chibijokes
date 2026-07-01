import type {
  MessageContentProcessorCtxDTO,
  MessageContentProcessorResultDTO,
  LlmMessageDTO,
  InterceptorResultDTO,
} from 'lumiverse-spindle-types';
import { api, varsLog } from './common';
import { parseSetvarChain } from './parsers/setvar';
import { applySetvarOp as applySetvarOpDefault } from './setvar-ops';
import { resolveMacroText, resolveDynamicVarMacros, resolveLocalDynamicMacros, DYNAMIC_VAR_MACRO_NAMES, LOCAL_DYNAMIC_MACRO_NAMES } from './macro-resolve';

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
  /** 'chat' = depth-based within chat history; 'before' = before first history
   *  message; 'after' = append after all messages. */
  position: 'chat' | 'before' | 'after';
  /** 0 = permanent; >0 = generations remaining before auto-removal. */
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

// ─────────────────────────────────────────────────────────────────────────────

const SETVAR_RE = /\/(setvar|setchatvar|setgvar|setglobalvar)\b/i;
const INJECT_RE = /\/inject\b/i;
const FLUSHINJECT_RE = /\/flushinject\b/i;

// Macros deferred at /inject command time so they're re-resolved fresh on
// every generation by the interceptor instead of being frozen forever.
// getvar/getchatvar need a live value lookup; random/roll/pick need a fresh
// roll each time; newline/input are included too for consistency even
// though their resolved value wouldn't actually differ by timing.
const DEFERRED_MACRO_NAMES: ReadonlySet<string> = new Set([
  ...DYNAMIC_VAR_MACRO_NAMES,
  ...LOCAL_DYNAMIC_MACRO_NAMES,
  'user', 'char', 'group',
]);

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

  // Handle /inject — store a spec in extension storage for the interceptor.
  // Syntax: /inject [id=<id>] [depth=<n>] [role=system|user|assistant] [position=chat|before|after] [turns=<n>] <content>
  if (INJECT_RE.test(content)) {
    const INJECT_CMD_RE = /^\/inject(?:\s+(.*?))?\s*$/gim;
    const injects = await readInjects(ctx.chatId);
    let im: RegExpExecArray | null;
    while ((im = INJECT_CMD_RE.exec(content)) !== null) {
      const { args, content: body } = parseInjectArgs(im[1] ?? '');
      if (!body.trim()) continue;
      // Resolve {{macros}} in the inject body NOW, at /inject command time —
      // EXCEPT the names in DEFERRED_MACRO_NAMES, which are deliberately left
      // as literal text here and resolved fresh on every generation by the
      // interceptor below: getvar/getchatvar via resolveDynamicVarMacros,
      // random/roll/pick/newline/input via resolveLocalDynamicMacros. Both of
      // those need only (chatId, key) or nothing at all — no userId — so they
      // can actually run inside the interceptor, unlike the full macro engine.
      // Everything else (user/char/group/setvar/...) genuinely can't be:
      // api.macros.resolve requires userId, which only this function
      // (MessageContentProcessorCtx) has — the interceptor's context, per
      // Lumiverse host source (interceptor-pipeline.ts, generate.service.ts),
      // is {chatId, connectionId, personaId, generationType} with no userId
      // at all for an operator-scoped extension. So those stay frozen at
      // /inject time; this is a hard host-API limit, not a choice. Falls
      // back to the raw body on failure.
      const resolvedBody = await resolveMacroText(body, ctx.chatId, undefined, ctx.userId, DEFERRED_MACRO_NAMES);
      const id = args.id ?? Math.random().toString(36).slice(2, 10);
      const spec: InjectSpec = {
        id,
        content: resolvedBody,
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
// Reads inject specs from extension storage on every generation and splices
// each active entry into the assembled message array at the right depth.
// Turn-counted entries are decremented and removed when they expire.

function installInjectInterceptor(): void {
  api.registerInterceptor(async (messages: LlmMessageDTO[], context: unknown): Promise<InterceptorResultDTO> => {
    const ctx = context as { chatId?: string; characterId?: string; userId?: string };
    if (!ctx.chatId) return { messages };

    const injects = await readInjects(ctx.chatId);
    if (injects.length === 0) return { messages };

    const result: LlmMessageDTO[] = [...messages];
    const surviving: InjectSpec[] = [];
    const breakdown: Array<{ messageIndex: number; name: string }> = [];

    // {{input}} resolves to the last user message — already sitting right
    // here in `messages` (the interceptor's first argument), no host
    // lookup needed. Computed once: `messages` doesn't change across the
    // loop below (only the `result` splice copy does).
    let lastUserMessage = '';
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') { lastUserMessage = messages[i].content ?? ''; break; }
    }

    for (const spec of injects) {
      // Dynamic path — re-resolves {{getvar::x}}/{{getchatvar::x}} fresh on
      // every generation. Uses api.variables.local.get/chat.get directly,
      // which take only (chatId, key) — no userId — so this actually works
      // inside the interceptor, unlike the full macro engine. This is what
      // makes /inject content non-static for the variable-getter macros.
      let resolvedContent = await resolveDynamicVarMacros(spec.content, ctx.chatId);
      // Same idea for {{random}}/{{roll}}/{{pick}}/{{newline}}/{{input}} —
      // these need no host lookup at all (pure Math.random(), or data
      // already in `messages`), so they resolve synchronously and locally
      // right here, fresh every generation, with no userId dependency.
      resolvedContent = resolveLocalDynamicMacros(resolvedContent, lastUserMessage);
      // Forward-compat fallback: any OTHER macro type left in spec.content
      // (shouldn't normally happen — those are resolved once at /inject
      // time in processMessageContent, see above) only resolves here if a
      // future host version starts threading userId into the interceptor's
      // context. Today ctx.userId is always undefined here, so this is a
      // guaranteed no-op pass-through.
      if (ctx.userId) {
        resolvedContent = await resolveMacroText(resolvedContent, ctx.chatId, ctx.characterId, ctx.userId);
      }
      const msg: LlmMessageDTO = { role: spec.role, content: resolvedContent };
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
      // turns === 1: last use this generation, don't carry forward
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
