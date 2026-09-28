import type { MessageContentProcessorCtxDTO, MessageContentProcessorResultDTO } from 'lumiverse-spindle-types';
import { api } from './common';

type CurtainMode = 'holding' | 'committing';

interface CurtainState {
  generationId: string;
  chatId: string;
  messageId: string;
  swipeId: number;
  mode: CurtainMode;
  allowedContent?: string;
  armedAt: number;
  expiresAt: number;
}

export interface ResponseCurtainSpec {
  generationId: string;
  chatId: string;
  messageId: string;
  swipeId?: number;
}

export interface ResponseCommitSpec extends ResponseCurtainSpec {
  content: string;
}

const CURTAIN_TTL_MS = 5 * 60 * 1000;
const curtains = new Map<string, CurtainState>();
const targetOwners = new Map<string, string>();

function targetKey(chatId: string, messageId: string): string {
  return `${chatId}\u0000${messageId}`;
}

function sanitizeSpec(spec: ResponseCurtainSpec): ResponseCurtainSpec {
  const generationId = String(spec?.generationId || '').trim();
  const chatId = String(spec?.chatId || '').trim();
  const messageId = String(spec?.messageId || '').trim();
  const swipeId = Number.isFinite(Number(spec?.swipeId)) ? Math.max(0, Math.trunc(Number(spec.swipeId))) : 0;
  if (!generationId) throw new Error('Response Interceptor generationId is required.');
  if (!chatId) throw new Error('Response Interceptor chatId is required.');
  if (!messageId) throw new Error('Response Interceptor messageId is required.');
  return { generationId, chatId, messageId, swipeId };
}

function clearCurtain(generationId: string): CurtainState | null {
  const state = curtains.get(generationId) ?? null;
  if (!state) return null;
  curtains.delete(generationId);
  const key = targetKey(state.chatId, state.messageId);
  if (targetOwners.get(key) === generationId) targetOwners.delete(key);
  return state;
}

function pruneExpired(): void {
  const now = Date.now();
  for (const [generationId, state] of curtains) {
    if (state.expiresAt <= now) clearCurtain(generationId);
  }
}

async function getMessage(chatId: string, messageId: string): Promise<any | null> {
  const rows = await api.chat.getMessages(chatId);
  return Array.isArray(rows) ? rows.find((row: any) => String(row?.id) === messageId) ?? null : null;
}

export async function armResponseCurtain(spec: ResponseCurtainSpec): Promise<Record<string, unknown>> {
  pruneExpired();
  const safe = sanitizeSpec(spec);

  // Only one post-generation curtain may own a chat at a time. A newer host
  // generation supersedes an older unfinished interception in that chat.
  for (const [generationId, state] of curtains) {
    if (state.chatId === safe.chatId && generationId !== safe.generationId) clearCurtain(generationId);
  }

  const key = targetKey(safe.chatId, safe.messageId);
  const previousOwner = targetOwners.get(key);
  if (previousOwner && previousOwner !== safe.generationId) clearCurtain(previousOwner);

  const state: CurtainState = {
    generationId: safe.generationId,
    chatId: safe.chatId,
    messageId: safe.messageId,
    swipeId: safe.swipeId ?? 0,
    mode: 'holding',
    armedAt: Date.now(),
    expiresAt: Date.now() + CURTAIN_TTL_MS,
  };
  curtains.set(state.generationId, state);
  targetOwners.set(key, state.generationId);
  return { armed: true, ...state };
}

export async function commitResponseCurtain(spec: ResponseCommitSpec): Promise<Record<string, unknown>> {
  pruneExpired();
  const safe = sanitizeSpec(spec);
  const replacement = String(spec?.content ?? '');
  const state = curtains.get(safe.generationId);
  if (!state) throw new Error('Response Interceptor curtain is no longer armed for this generation.');
  if (state.chatId !== safe.chatId || state.messageId !== safe.messageId) {
    throw new Error('Response Interceptor target changed before commit.');
  }

  const message = await getMessage(safe.chatId, safe.messageId);
  if (!message) throw new Error('Lumiverse target message no longer exists.');
  const swipes = Array.isArray(message.swipes) ? message.swipes.map((value: unknown) => String(value ?? '')) : [String(message.content ?? '')];
  const targetSwipe = safe.swipeId ?? state.swipeId;
  if (targetSwipe < 0 || targetSwipe >= swipes.length) {
    throw new Error(`Lumiverse target swipe ${targetSwipe} no longer exists.`);
  }
  const activeSwipe = Number.isFinite(Number(message.swipe_id)) ? Math.trunc(Number(message.swipe_id)) : 0;

  swipes[targetSwipe] = replacement;
  state.mode = 'committing';
  state.swipeId = targetSwipe;
  // The active display may be a different swipe if the user navigated while
  // Council was thinking. Allow exactly what Lumiverse should display after the
  // canonical rewrite while continuing to suppress the superseded raw target.
  state.allowedContent = targetSwipe === activeSwipe ? replacement : String(message.content ?? swipes[activeSwipe] ?? '');
  state.expiresAt = Date.now() + CURTAIN_TTL_MS;

  await api.chat.updateMessage(safe.chatId, safe.messageId, {
    swipes,
    swipe_id: activeSwipe,
  } as any);

  const updated = await getMessage(safe.chatId, safe.messageId);
  if (!updated) throw new Error('Lumiverse target disappeared after the Interceptor commit.');
  state.allowedContent = String(updated.content ?? '');

  return {
    committed: true,
    generationId: safe.generationId,
    chatId: safe.chatId,
    messageId: safe.messageId,
    swipeId: targetSwipe,
    activeSwipeId: Number(updated.swipe_id ?? activeSwipe),
    content: String(updated.content ?? ''),
    targetContent: Array.isArray(updated.swipes) ? String(updated.swipes[targetSwipe] ?? '') : replacement,
    swipes: Array.isArray(updated.swipes) ? updated.swipes : undefined,
  };
}

export async function releaseResponseCurtain(
  generationId: string,
  options: { refresh?: boolean } = {},
): Promise<Record<string, unknown>> {
  pruneExpired();
  const id = String(generationId || '').trim();
  if (!id) return { released: false };
  const state = clearCurtain(id);
  if (!state) return { released: false };

  if (options.refresh) {
    // Force Lumiverse to re-render the current canonical content after a failed
    // or cancelled interception. This is a same-content canonical edit, not a
    // second assistant message.
    const message = await getMessage(state.chatId, state.messageId);
    if (message) {
      await api.chat.updateMessage(state.chatId, state.messageId, {
        content: String(message.content ?? ''),
      } as any);
    }
  }

  return { released: true, generationId: id, chatId: state.chatId, messageId: state.messageId };
}

export function responseCurtainStatus(generationId?: string): unknown {
  pruneExpired();
  if (generationId) return curtains.get(String(generationId)) ?? null;
  return Array.from(curtains.values()).map((state) => ({ ...state }));
}

async function processResponseCurtain(
  ctx: MessageContentProcessorCtxDTO,
): Promise<MessageContentProcessorResultDTO | void> {
  if (ctx.origin !== 'render' || ctx.isUser || !ctx.messageId) return;
  pruneExpired();
  const generationId = targetOwners.get(targetKey(String(ctx.chatId), String(ctx.messageId)));
  if (!generationId) return;
  const state = curtains.get(generationId);
  if (!state) return;

  const content = String(ctx.content ?? '');
  if (state.mode === 'committing' && state.allowedContent !== undefined && content === state.allowedContent) {
    return;
  }

  // Invisible separator keeps the render pipeline structurally non-empty while
  // preventing streamed/raw assistant text from reaching first paint.
  return { content: '\u2063' };
}

export function installResponseInterceptorBridge(): void {
  // Run before Vishrun's ordinary render transforms so the raw generated text
  // never leaks to later display processors while Council owns the response.
  api.registerMessageContentProcessor((ctx) => processResponseCurtain(ctx), 5);
}
