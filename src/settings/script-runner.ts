import type { SpindleFrontendContext, SpindleSandboxFrameHandle } from 'lumiverse-spindle-types';
import { thHelpersShim } from '../render/th-helpers-shim';
import { fetchMessagesSnapshot } from '../render/th-helpers-bridge';
import type { Script } from './script-types';
import { handleClipboardWriteText, handleHostAlert } from '../render/clipboard-shim';

// ── Event bridge shim ────────────────────────────────────────────────────────
// Provides window.eventSource + window.event_types inside each frame so JSLR
// scripts can call eventSource.on(event_types.CHAT_CHANGED, fn) unchanged.
// The host forwards Lumiverse events via handle.postMessage({ type:'vsh_event' });
// the bridge here re-emits them through eventSource so handlers fire normally.
const EVENT_BRIDGE_SHIM = `<script>(function(){
var ET={
  CHAT_CHANGED:'CHAT_CHANGED',CHAT_SWITCHED:'CHAT_SWITCHED',MESSAGE_RECEIVED:'MESSAGE_RECEIVED',
  MESSAGE_SENT:'MESSAGE_SENT',GENERATION_STARTED:'GENERATION_STARTED',
  GENERATION_ENDED:'GENERATION_ENDED',GENERATION_STOPPED:'GENERATION_STOPPED',
  CHARACTER_MESSAGE_RENDERED:'CHARACTER_MESSAGE_RENDERED',
  USER_MESSAGE_RENDERED:'USER_MESSAGE_RENDERED',
  MESSAGE_SWIPED:'MESSAGE_SWIPED',MESSAGE_EDITED:'MESSAGE_EDITED',
};
window.event_types=ET;
var _h={};
window.eventSource={
  on:function(e,fn){(_h[e]=_h[e]||[]).push(fn);},
  makeFirst:function(e,fn){(_h[e]=_h[e]||[]).unshift(fn);},
  off:function(e,fn){
    if(!fn){_h[e]=[];return;}
    _h[e]=(_h[e]||[]).filter(function(h){return h!==fn;});
  },
  emit:function(e,d){
    (_h[e]||[]).forEach(function(fn){try{fn(d);}catch(ex){console.error('[vsh-script]',ex);}});
  },
};
if(window.spindleSandbox&&typeof window.spindleSandbox.onMessage==='function'){
  window.spindleSandbox.onMessage(function(msg){
    if(!msg||msg.type!=='vsh_event')return;
    window.eventSource.emit(msg.event,msg.data);
  });
}
})()</script>`;

const CLIPBOARD_SHIM = `<script>(function(){
try{
if(!navigator.clipboard){Object.defineProperty(navigator,'clipboard',{value:{},configurable:true});}
navigator.clipboard.writeText=function(text){
try{window.spindleSandbox.postMessage({kind:'clipboard-write-text',payload:{text:String(text)}});return Promise.resolve();}
catch(e){return Promise.reject(e);}
};
}catch(e){}
window.alert=function(msg){
try{window.spindleSandbox.postMessage({kind:'alert',payload:{message:String(msg)}});}catch(e){}
};
})()</script>`;

const BRIDGED_EVENTS = [
  'CHAT_CHANGED','MESSAGE_RECEIVED','MESSAGE_SENT',
  'GENERATION_STARTED','GENERATION_ENDED','GENERATION_STOPPED',
  'CHARACTER_MESSAGE_RENDERED','USER_MESSAGE_RENDERED',
  'MESSAGE_SWIPED','MESSAGE_EDITED',
] as const;

interface LiveFrame {
  scriptId: string;
  scriptName: string;
  scope: Script['scope'];
  contentHash: string;
  reloadMemo: string;
  handle: SpindleSandboxFrameHandle;
  container: HTMLDivElement;
}

/** Frame map key = source + id, matching JSLR's :key="script.source + script.id + ...". */
function frameKey(scope: Script['scope'], id: string): string {
  return `${scope ?? 'global'}::${id}`;
}

/** Cheap non-cryptographic hash — same purpose as JSLR's getStringHash on content. */
function hashContent(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(31, h) + s.charCodeAt(i) | 0;
  }
  return h.toString(36);
}

export class ScriptRunner {
  private frames = new Map<string, LiveFrame>();
  private reloadMemos = new Map<string, string>();
  private eventUnsubs: Array<() => void> = [];
  private currentChatId = '';
  private variableRefreshSerial = 0;

  constructor(private readonly ctx: SpindleFrontendContext) {
    this.installEventBridge();
  }

  /**
   * Reconcile running frames against the incoming script list.
   *
   * - Scripts no longer in the list are torn down.
   * - Scripts already running with identical content are left completely alone,
   *   regardless of scope — same behaviour as JSLR's :key reconciliation.
   * - Scripts that are new or whose content changed are (re)launched.
   */
  async run(scripts: Script[], chatId: string | null): Promise<void> {
    const incomingIds = new Set(scripts.map(s => s.id));

    // Tear down frames that are no longer in the incoming list.
    for (const [key, frame] of this.frames) {
      if (!incomingIds.has(frame.scriptId)) {
        this.destroyFrame(frame);
        this.frames.delete(key);
      }
    }

    // Tear down frames whose content OR reload memo changed.
    for (const script of scripts) {
      const key = frameKey(script.scope, script.id);
      const frame = this.frames.get(key);
      if (frame && (
        frame.contentHash !== hashContent(script.content) ||
        frame.reloadMemo !== (this.reloadMemos.get(script.id) ?? '')
      )) {
        this.destroyFrame(frame);
        this.frames.delete(key);
      }
    }

    // Fix 2: sort by id before launching — matches JSLR's sortBy(script => script.id).
    const scriptsToLaunch = [...scripts]
      .filter(s => !this.frames.has(frameKey(s.scope, s.id)))
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

    // Keep already-running Tavern Helper frames on the active chat's variable
    // snapshot. This lets synchronous JSLR-style getAllVariables() stay current
    // without forcing otherwise-unchanged scripts to restart on every chat switch.
    const effectiveChatId = chatId ?? '';
    if (effectiveChatId !== this.currentChatId) {
      if (this.frames.size > 0) {
        const refreshed = await this.refreshVariablesSnapshot(effectiveChatId);
        if (refreshed) this.broadcast('CHAT_SWITCHED', { chatId: effectiveChatId || null });
      } else {
        this.currentChatId = effectiveChatId;
      }
    }

    if (scriptsToLaunch.length === 0) return;

    // Give Lumiverse one tick to finish updating its active-chat state before
    // we snapshot. CHAT_CHANGED fires slightly before getActiveChat() reflects
    // the new chatId, so without this the snapshot (and the iframe shim) would
    // use the *previous* chat's id on rapid chat switches.
    await new Promise<void>((r) => setTimeout(r, 50));

    // chatId used for snapshots. Use '' when no chat is open.
    let messagesSnapshot: Awaited<ReturnType<typeof fetchMessagesSnapshot>> = [];
    let variablesSnapshot: Record<string, unknown> = {};
    if (effectiveChatId) {
      try {
        const [messages, variables] = await Promise.all([
          fetchMessagesSnapshot(
            { chatId: effectiveChatId, currentMessageId: '', currentMessageIndex: -1 },
            this.ctx,
          ),
          this.fetchNativeVariablesSnapshot(effectiveChatId),
        ]);
        messagesSnapshot = messages;
        variablesSnapshot = variables;
      } catch { /* non-fatal */ }
    }

    console.log(`[vishrun:script-runner] launching ${scriptsToLaunch.length} script(s)`, scriptsToLaunch.map(s => s.name));

    for (const script of scriptsToLaunch) {
      this.launchFrame(script, effectiveChatId, messagesSnapshot, variablesSnapshot);
    }
  }

  /** Force-restart a single script frame even if its content hasn't changed. */
  reload(scriptId: string): void {
    this.reloadMemos.set(scriptId, crypto.randomUUID());
  }

  /** Force-restart all running script frames. */
  reloadAll(): void {
    for (const frame of this.frames.values()) {
      this.reloadMemos.set(frame.scriptId, crypto.randomUUID());
    }
  }

  destroy(): void {
    this.teardownAll();
    for (const unsub of this.eventUnsubs) unsub();
    this.eventUnsubs = [];
  }

  private destroyFrame(frame: LiveFrame): void {
    try { frame.handle.destroy?.(); } catch { /* no-op */ }
    try { frame.container.remove(); } catch { /* no-op */ }
  }

  private launchFrame(
    script: Script,
    chatId: string,
    messagesSnapshot: Awaited<ReturnType<typeof fetchMessagesSnapshot>>,
    variablesSnapshot: Record<string, unknown>,
  ): void {
    try {
      const shim = thHelpersShim({
        currentMessageIndex: -1,
        currentMessageId: '',
        chatId,
        messagesSnapshot,
        variablesSnapshot,
      });

      const srcdoc = [
        EVENT_BRIDGE_SHIM,
        CLIPBOARD_SHIM,
        shim,
        `<script>\n// [vishrun] Script: ${script.name}\n${script.content}\n</script>`,
      ].join('\n');

      const handle = this.ctx.dom.createSandboxFrame({
        html: srcdoc,
        autoResize: false,
        minHeight: 1,
        initialHeight: 1,
        allowEval: true,
      } as Parameters<typeof this.ctx.dom.createSandboxFrame>[0] & { allowEval?: boolean });

      // Widen Lumiverse's restrictive default sandbox so scripts can actually run.
      // createSandboxFrame (since staging d157784) locks iframes down by default;
      // without allow-scripts the iframe loads but all JS is silently blocked.
      // This mirrors the identical setAttribute call in widget-iframe.ts.
      handle.element.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-forms');

      // IMPORTANT: must NOT use display:none — hidden iframes do not load
      // their srcdoc content in Chromium/Firefox. Use off-screen positioning
      // with visibility:hidden to keep the frame in the render tree while
      // making it invisible and non-interactive.
      const container = document.createElement('div');
      container.dataset.vishrunScript = script.id;
      container.style.cssText = [
        'position:fixed',
        'left:-99999px',
        'top:-99999px',
        'width:1px',
        'height:1px',
        'visibility:hidden',
        'pointer-events:none',
        'overflow:hidden',
      ].join(';');
      container.appendChild(handle.element);
      document.body.appendChild(container);

      this.frames.set(frameKey(script.scope, script.id), {
        scriptId: script.id,
        scriptName: script.name,
        scope: script.scope,
        contentHash: hashContent(script.content),
        reloadMemo: this.reloadMemos.get(script.id) ?? '',
        handle,
        container,
      });

      handle.onMessage((payload: unknown) => {
        const p = payload as { kind?: string; payload?: unknown } | null;
        if (!p || typeof p.kind !== 'string') return;
        if (p.kind === 'clipboard-write-text') {
          void handleClipboardWriteText(p.payload, this.ctx);
        } else if (p.kind === 'alert') {
          handleHostAlert(p.payload);
        }
      });

      console.log(`[vishrun:script-runner] launched: ${script.name} (${script.id})`);
    } catch (err) {
      console.error('[vishrun:script-runner] failed to launch:', script.name, err);
    }
  }

  private teardownAll(): void {
    for (const frame of this.frames.values()) {
      this.destroyFrame(frame);
    }
    if (this.frames.size > 0) {
      console.log(`[vishrun:script-runner] tore down ${this.frames.size} script frame(s)`);
    }
    this.frames.clear();
  }

  private installEventBridge(): void {
    for (const eventName of BRIDGED_EVENTS) {
      const unsub = this.ctx.events.on(eventName, (data: unknown) => {
        if (eventName === 'CHAT_CHANGED') {
          void this.refreshVariablesThenBroadcastChatChanged(data);
          return;
        }
        this.broadcast(eventName, data);
      });
      this.eventUnsubs.push(unsub);
    }
  }

  private async refreshVariablesThenBroadcastChatChanged(data: unknown): Promise<void> {
    const payload = (data || {}) as { chatId?: string | null };
    const chatId = payload.chatId ?? this.ctx.getActiveChat().chatId ?? '';
    const refreshed = await this.refreshVariablesSnapshot(chatId);
    if (!refreshed) return;
    this.broadcast('CHAT_CHANGED', data);
  }

  private async fetchNativeVariablesSnapshot(chatId: string): Promise<Record<string, unknown>> {
    if (!chatId) return {};
    try {
      const response = await fetch(`/api/v1/chats/${encodeURIComponent(chatId)}?_t=${Date.now()}`, {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`chat HTTP ${response.status}`);
      const chat = await response.json() as {
        metadata?: {
          macro_variables?: { local?: Record<string, unknown> };
          chat_variables?: Record<string, unknown>;
        };
      };
      return {
        ...(chat.metadata?.macro_variables?.local ?? {}),
        ...(chat.metadata?.chat_variables ?? {}),
      };
    } catch (err) {
      console.warn(
        '[vishrun:script-runner] variable snapshot fetch failed:',
        err instanceof Error ? err.message : String(err),
      );
      return {};
    }
  }

  private async refreshVariablesSnapshot(chatId: string): Promise<boolean> {
    const serial = ++this.variableRefreshSerial;
    let variablesSnapshot: Record<string, unknown> = {};

    if (chatId) {
      variablesSnapshot = await this.fetchNativeVariablesSnapshot(chatId);
    }

    // A newer chat/variable refresh won the race. Never let an older response
    // overwrite the snapshot for the chat the user is currently on.
    if (serial !== this.variableRefreshSerial) return false;

    this.currentChatId = chatId;
    const msg = { type: 'vsh_th_variables_snapshot', chatId, variablesSnapshot };
    for (const frame of this.frames.values()) {
      try { frame.handle.postMessage(msg); } catch { /* frame torn down */ }
    }
    return true;
  }

  private broadcast(event: string, data: unknown): void {
    if (this.frames.size === 0) return;
    const msg = { type: 'vsh_event', event, data };
    for (const frame of this.frames.values()) {
      try { frame.handle.postMessage(msg); } catch { /* frame torn down */ }
    }
  }
}
