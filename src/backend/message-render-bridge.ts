import type { MessageContentProcessorCtxDTO, MessageContentProcessorResultDTO } from 'lumiverse-spindle-types';
import { api } from './common';

interface MessageRenderHold {
  id: string;
  chatId: string;
  messageId: string;
  overrideContent: string;
  allowedContent?: string;
  expiresAt: number;
}

export interface MessageRenderHoldSpec {
  id: string;
  chatId: string;
  messageId: string;
  content: string;
}

const HOLD_TTL_MS = 5 * 60 * 1000;
const holds = new Map<string, MessageRenderHold>();
const targetOwners = new Map<string, string>();

function targetKey(chatId: string, messageId: string): string {
  return `${chatId}\u0000${messageId}`;
}

function normalizeHold(spec: MessageRenderHoldSpec): MessageRenderHoldSpec {
  const id = String(spec?.id || '').trim();
  const chatId = String(spec?.chatId || '').trim();
  const messageId = String(spec?.messageId || '').trim();
  if (!id) throw new Error('Message render hold id is required.');
  if (!chatId) throw new Error('Message render chatId is required.');
  if (!messageId) throw new Error('Message render messageId is required.');
  return { id, chatId, messageId, content: String(spec?.content ?? '') };
}

function removeHold(id: string): MessageRenderHold | null {
  const hold = holds.get(id) ?? null;
  if (!hold) return null;
  holds.delete(id);
  const key = targetKey(hold.chatId, hold.messageId);
  if (targetOwners.get(key) === id) targetOwners.delete(key);
  return hold;
}

function pruneExpired(): void {
  const now = Date.now();
  for (const [id, hold] of holds) {
    if (hold.expiresAt <= now) removeHold(id);
  }
}

async function getMessage(chatId: string, messageId: string): Promise<any | null> {
  const rows = await api.chat.getMessages(chatId);
  return Array.isArray(rows)
    ? rows.find((row: any) => String(row?.id) === messageId) ?? null
    : null;
}

export async function holdMessageRender(spec: MessageRenderHoldSpec): Promise<Record<string, unknown>> {
  pruneExpired();
  const safe = normalizeHold(spec);
  const key = targetKey(safe.chatId, safe.messageId);
  const previous = targetOwners.get(key);
  if (previous && previous !== safe.id) removeHold(previous);

  const hold: MessageRenderHold = {
    id: safe.id,
    chatId: safe.chatId,
    messageId: safe.messageId,
    overrideContent: safe.content,
    expiresAt: Date.now() + HOLD_TTL_MS,
  };
  holds.set(hold.id, hold);
  targetOwners.set(key, hold.id);
  return { held: true, id: hold.id, chatId: hold.chatId, messageId: hold.messageId };
}

export async function allowMessageRender(idValue: string, content: string): Promise<Record<string, unknown>> {
  pruneExpired();
  const id = String(idValue || '').trim();
  const hold = holds.get(id);
  if (!hold) throw new Error('Message render hold is not active.');
  hold.allowedContent = String(content ?? '');
  hold.expiresAt = Date.now() + HOLD_TTL_MS;
  return { allowed: true, id };
}

export async function releaseMessageRender(
  idValue: string,
  options: { refresh?: boolean } = {},
): Promise<Record<string, unknown>> {
  pruneExpired();
  const id = String(idValue || '').trim();
  if (!id) return { released: false };
  const hold = removeHold(id);
  if (!hold) return { released: false };

  if (options.refresh) {
    const message = await getMessage(hold.chatId, hold.messageId);
    if (message) {
      await api.chat.updateMessage(hold.chatId, hold.messageId, {
        content: String(message.content ?? ''),
      } as any);
    }
  }

  return { released: true, id, chatId: hold.chatId, messageId: hold.messageId };
}

export function messageRenderStatus(idValue?: string): unknown {
  pruneExpired();
  if (idValue) return holds.get(String(idValue)) ?? null;
  return Array.from(holds.values()).map((hold) => ({ ...hold }));
}

async function processMessageRender(
  ctx: MessageContentProcessorCtxDTO,
): Promise<MessageContentProcessorResultDTO | void> {
  if (ctx.origin !== 'render' || ctx.isUser || !ctx.messageId) return;
  pruneExpired();
  const id = targetOwners.get(targetKey(String(ctx.chatId), String(ctx.messageId)));
  if (!id) return;
  const hold = holds.get(id);
  if (!hold) return;

  const content = String(ctx.content ?? '');
  if (hold.allowedContent !== undefined && content === hold.allowedContent) return;
  return { content: hold.overrideContent };
}

export function installMessageRenderBridge(): void {
  api.registerMessageContentProcessor((ctx) => processMessageRender(ctx), 5);
}
