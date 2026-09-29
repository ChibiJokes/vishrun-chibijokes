import type { MessageContentProcessorCtxDTO, MessageContentProcessorResultDTO } from 'lumiverse-spindle-types';
import { api } from './common';

interface MessageRenderHold {
  id: string;
  chatId: string;
  messageId: string | null;
  overrideContent: string;
  allowedContent?: string;
  expiresAt: number;
}

export interface MessageRenderHoldSpec {
  id: string;
  chatId: string;
  messageId?: string;
  content: string;
}

const HOLD_TTL_MS = 5 * 60 * 1000;
const DISPLAY_OWNER_NAMESPACE = 'vishrun_chibijokes';
const holds = new Map<string, MessageRenderHold>();
const targetOwners = new Map<string, string>();
const pendingOwners = new Map<string, string>();

function targetKey(chatId: string, messageId: string): string {
  return `${chatId}\u0000${messageId}`;
}

function normalizeHold(spec: MessageRenderHoldSpec): MessageRenderHoldSpec {
  const id = String(spec?.id || '').trim();
  const chatId = String(spec?.chatId || '').trim();
  const messageId = spec?.messageId == null ? '' : String(spec.messageId).trim();
  if (!id) throw new Error('Message render hold id is required.');
  if (!chatId) throw new Error('Message render chatId is required.');
  return { id, chatId, ...(messageId ? { messageId } : {}), content: String(spec?.content ?? '') };
}

function removeHold(id: string): MessageRenderHold | null {
  const hold = holds.get(id) ?? null;
  if (!hold) return null;
  holds.delete(id);
  if (hold.messageId) {
    const key = targetKey(hold.chatId, hold.messageId);
    if (targetOwners.get(key) === id) targetOwners.delete(key);
  }
  if (pendingOwners.get(hold.chatId) === id) pendingOwners.delete(hold.chatId);
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
  removeHold(safe.id);

  const hold: MessageRenderHold = {
    id: safe.id,
    chatId: safe.chatId,
    messageId: safe.messageId || null,
    overrideContent: safe.content,
    expiresAt: Date.now() + HOLD_TTL_MS,
  };
  holds.set(hold.id, hold);

  if (hold.messageId) {
    const key = targetKey(hold.chatId, hold.messageId);
    const previous = targetOwners.get(key);
    if (previous && previous !== hold.id) removeHold(previous);
    targetOwners.set(key, hold.id);
  } else {
    const previous = pendingOwners.get(hold.chatId);
    if (previous && previous !== hold.id) removeHold(previous);
    pendingOwners.set(hold.chatId, hold.id);
  }

  return { held: true, pending: !hold.messageId, id: hold.id, chatId: hold.chatId, messageId: hold.messageId };
}

export async function bindMessageRender(idValue: string, messageIdValue: string): Promise<Record<string, unknown>> {
  pruneExpired();
  const id = String(idValue || '').trim();
  const messageId = String(messageIdValue || '').trim();
  if (!id) throw new Error('Message render hold id is required.');
  if (!messageId) throw new Error('Message render messageId is required.');
  const hold = holds.get(id);
  if (!hold) throw new Error('Message render hold is not active.');

  if (hold.messageId) {
    const previousKey = targetKey(hold.chatId, hold.messageId);
    if (targetOwners.get(previousKey) === id) targetOwners.delete(previousKey);
  }
  if (pendingOwners.get(hold.chatId) === id) pendingOwners.delete(hold.chatId);

  const key = targetKey(hold.chatId, messageId);
  const previous = targetOwners.get(key);
  if (previous && previous !== id) removeHold(previous);
  hold.messageId = messageId;
  hold.expiresAt = Date.now() + HOLD_TTL_MS;
  targetOwners.set(key, id);
  return { bound: true, id, chatId: hold.chatId, messageId };
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

  if (options.refresh && hold.messageId) {
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


export async function ensureMessageRenderDisplayOwner(
  characterIdValue: string,
  userId?: string,
): Promise<Record<string, unknown>> {
  const characterId = String(characterIdValue || '').trim();
  if (!characterId) throw new Error('Character id is required.');

  const character = await (api.characters.get as any)(characterId, userId);
  if (!character) throw new Error('Character not found.');

  const extensions =
    character.extensions && typeof character.extensions === 'object'
      ? character.extensions as Record<string, unknown>
      : {};
  const own =
    extensions[DISPLAY_OWNER_NAMESPACE] && typeof extensions[DISPLAY_OWNER_NAMESPACE] === 'object'
      ? { ...(extensions[DISPLAY_OWNER_NAMESPACE] as Record<string, unknown>) }
      : {};

  if (own.display_owner === true) {
    return { changed: false, characterId, owner: DISPLAY_OWNER_NAMESPACE };
  }

  await (api.characters.update as any)(
    characterId,
    {
      extensions: {
        [DISPLAY_OWNER_NAMESPACE]: {
          ...own,
          display_owner: true,
        },
      },
    },
    userId,
  );

  return { changed: true, characterId, owner: DISPLAY_OWNER_NAMESPACE };
}

async function processMessageRender(
  ctx: MessageContentProcessorCtxDTO,
): Promise<MessageContentProcessorResultDTO | void> {
  if (ctx.origin !== 'render' || ctx.isUser || !ctx.messageId) return;
  pruneExpired();
  const chatId = String(ctx.chatId);
  const messageId = String(ctx.messageId);
  const id = targetOwners.get(targetKey(chatId, messageId));
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
