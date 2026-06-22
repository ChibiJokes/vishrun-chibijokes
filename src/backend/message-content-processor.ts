import type {
  MessageContentProcessorCtxDTO,
  MessageContentProcessorResultDTO,
} from 'lumiverse-spindle-types';
import { api, varsLog } from './common';
import { parseSetvarChain } from './parsers/setvar';
import { applySetvarOp as applySetvarOpDefault } from './setvar-ops';

const EMPTY_REPLACEMENT = '_(variables updated)_';

// ─── /inject storage ─────────────────────────────────────────────────────────

interface InjectSpec {
  id: string;
  content: string;
  role: 'system' | 'user' | 'assistant';
  depth: number;
  position: 'chat' | 'before' | 'after';
  turns: number;
}

function injectKey(): string { return 'lumi_injects'; }

async function readInjects(chatId: string): Promise<InjectSpec[]> {
  try {
    const raw = await api.variables.chat.get(chatId, injectKey());
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
      await api.variables.chat.delete(chatId, injectKey());
    } else {
      await api.variables.chat.set(chatId, injectKey(), JSON.stringify(injects));
    }
  } catch (e) {
    // best-effort
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

export function installMessageContentProcessor(): void {
  api.registerMessageContentProcessor((ctx) => processMessageContent(ctx), 50);
}
