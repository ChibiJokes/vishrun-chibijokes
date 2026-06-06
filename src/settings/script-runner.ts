/**
 * ScriptRunner
 *
 * Executes enabled scripts (global → character → preset, in that order) as
 * hidden sandbox iframes when a chat becomes active. Provides the same
 * tavernHelper compatibility layer that vishrun's widget iframes already use,
 * plus a minimal eventSource + event_types shim so scripts written for
 * JS-Slash-Runner can subscribe to chat events without modification.
 *
 * How it works
 * ────────────
 *  1. Each enabled Script gets a ctx.dom.createSandboxFrame with:
 *       • thHelpersShim   — getChatMessages / setChatMessage / getChatId / getCurrentMessageId
 *       • eventBridgeShim — eventSource.on(event_types.CHAT_CHANGED, ...) etc.
 *       • script.content  — the user's raw JavaScript
 *  2. The frame's element is appended to a hidden host-side container.
 *  3. Key Lumiverse events (CHAT_CHANGED, GENERATION_ENDED, MESSAGE_SWIPED,
 *     MESSAGE_EDITED, MESSAGE_RECEIVED) are forwarded to every live frame via
 *     handle.postMessage({ type: 'vsh_event', event, data }).
 *     Inside the iframe the eventSource bridge picks these up and fires the
 *     registered handlers.
 *  4. On chat change / extension teardown, all frames are destroyed.
 *
 * Limitations (fixable later)
 * ───────────────────────────
 *  • getChatMessages() uses a snapshot baked at frame-creation time. Calling
 *    it after new messages arrive returns stale data (same trade-off as
 *    vishrun's widget iframes).
 *  • ST-specific globals (SillyTavern, characters[], etc.) are not provided.
 *    Scripts that access them will hit ReferenceError. The tavernHelper API
 *    covers the majority of card-script use cases.
 */

import type { SpindleFrontendContext, SpindleSandboxFrameHandle } from 'lumiverse-spindle-types';
import { thHelpersShim } from '../render/th-helpers-shim';
import { fetchMessagesSnapshot } from '../render/th-helpers-bridge';
import type { Script } from './script-types';

// ── Event bridge shim (injected before user code) ───────────────────────────
// Provides window.eventSource + window.event_types so JSLR scripts that call
// eventSource.on(event_types.CHAT_CHANGED, fn) compile and run without errors.
// Events are forwarded from the host as { type: 'vsh_event', event, data }
// messages via window.spindleSandbox.onMessage.
const EVENT_BRIDGE_SHIM = `<script>(function(){
var ET = {
  CHAT_CHANGED:'CHAT_CHANGED',
  MESSAGE_RECEIVED:'MESSAGE_RECEIVED',
  MESSAGE_SENT:'MESSAGE_SENT',
  GENERATION_STARTED:'GENERATION_STARTED',
  GENERATION_ENDED:'GENERATION_ENDED',
  GENERATION_STOPPED:'GENERATION_STOPPED',
  CHARACTER_MESSAGE_RENDERED:'CHARACTER_MESSAGE_RENDERED',
  USER_MESSAGE_RENDERED:'USER_MESSAGE_RENDERED',
  MESSAGE_SWIPED:'MESSAGE_SWIPED',
  MESSAGE_EDITED:'MESSAGE_EDITED',
};
window.event_types = ET;
var _h = {};
window.eventSource = {
  on:function(e,fn){ (_h[e]=_h[e]||[]).push(fn); },
  makeFirst:function(e,fn){ (_h[e]=_h[e]||[]).unshift(fn); },
  off:function(e,fn){
    if(!fn){ _h[e]=[]; return; }
    _h[e]=(_h[e]||[]).filter(function(h){ return h!==fn; });
  },
  emit:function(e,d){
    (_h[e]||[]).forEach(function(fn){ try{ fn(d); }catch(ex){ console.error('[vsh-script]',ex); } });
  },
};
if(window.spindleSandbox && typeof window.spindleSandbox.onMessage==='function'){
  window.spindleSandbox.onMessage(function(msg){
    if(!msg||msg.type!=='vsh_event') return;
    window.eventSource.emit(msg.event, msg.data);
  });
}
})()</script>`;

// Lumiverse event names we forward into script frames.
const BRIDGED_EVENTS = [
  'CHAT_CHANGED',
  'MESSAGE_RECEIVED',
  'MESSAGE_SENT',
  'GENERATION_STARTED',
  'GENERATION_ENDED',
  'GENERATION_STOPPED',
  'CHARACTER_MESSAGE_RENDERED',
  'USER_MESSAGE_RENDERED',
  'MESSAGE_SWIPED',
  'MESSAGE_EDITED',
] as const;

// ── Types ────────────────────────────────────────────────────────────────────

interface LiveFrame {
  scriptId: string;
  scriptName: string;
  handle: SpindleSandboxFrameHandle;
  container: HTMLDivElement;
}

// ── Runner ───────────────────────────────────────────────────────────────────

export class ScriptRunner {
  private frames = new Map<string, LiveFrame>();
  private eventUnsubs: Array<() => void> = [];

  constructor(private readonly ctx: SpindleFrontendContext) {
    this.installEventBridge();
  }

  // ── Public ──────────────────────────────────────────────────────────

  /**
   * Replace all running scripts with a new set. Called by frontend.ts on
   * every CHAT_CHANGED after loading the character and fetching scripts.
   * Pass null/[] for chatId or scripts to just tear down existing frames.
   */
  async run(
    scripts: Script[],
    chatId: string | null,
  ): Promise<void> {
    this.teardownAll();
    if (!chatId || scripts.length === 0) return;

    // Fetch message snapshot once and share across all frames.
    let messagesSnapshot: Awaited<ReturnType<typeof fetchMessagesSnapshot>> = [];
    try {
      messagesSnapshot = await fetchMessagesSnapshot(
        { chatId, currentMessageId: '', currentMessageIndex: -1 },
        this.ctx,
      );
    } catch {
      // Non-fatal — scripts still run, getChatMessages() returns [].
    }

    for (const script of scripts) {
      await this.launchFrame(script, chatId, messagesSnapshot);
    }
  }

  destroy(): void {
    this.teardownAll();
    for (const unsub of this.eventUnsubs) unsub();
    this.eventUnsubs = [];
  }

  // ── Private ─────────────────────────────────────────────────────────

  private async launchFrame(
    script: Script,
    chatId: string,
    messagesSnapshot: Awaited<ReturnType<typeof fetchMessagesSnapshot>>,
  ): Promise<void> {
    try {
      const shim = thHelpersShim({
        currentMessageIndex: -1,
        currentMessageId: '',
        chatId,
        messagesSnapshot,
      });

      // Build srcdoc: event-bridge shim → thHelpers shim → user script
      const srcdoc = [
        EVENT_BRIDGE_SHIM,
        shim,
        `<script>\n// Script: ${script.name}\n${script.content}\n</script>`,
      ].join('\n');

      const handle = this.ctx.dom.createSandboxFrame({
        html: srcdoc,
        autoResize: false,
        minHeight: 0,
        initialHeight: 0,
        allowEval: true,
      } as Parameters<typeof this.ctx.dom.createSandboxFrame>[0] & { allowEval?: boolean });

      // Hidden container — frame must be in the DOM to run.
      const container = document.createElement('div');
      container.dataset.vishrunScript = script.id;
      container.style.cssText = 'display:none;position:fixed;width:0;height:0;overflow:hidden;pointer-events:none;';
      container.appendChild(handle.element);
      document.body.appendChild(container);

      this.frames.set(script.id, { scriptId: script.id, scriptName: script.name, handle, container });
    } catch (err) {
      console.error('[vishrun:script-runner] failed to launch script:', script.name, err);
    }
  }

  private teardownAll(): void {
    for (const frame of this.frames.values()) {
      try { frame.handle.destroy?.(); } catch { /* no-op */ }
      try { frame.container.remove(); } catch { /* no-op */ }
    }
    this.frames.clear();
  }

  /**
   * Subscribe to key Lumiverse events and forward them to every live script
   * frame as { type: 'vsh_event', event: string, data: unknown }.
   */
  private installEventBridge(): void {
    for (const eventName of BRIDGED_EVENTS) {
      const unsub = this.ctx.events.on(eventName, (data: unknown) => {
        this.broadcast(eventName, data);
      });
      this.eventUnsubs.push(unsub);
    }
  }

  private broadcast(event: string, data: unknown): void {
    if (this.frames.size === 0) return;
    const msg = { type: 'vsh_event', event, data };
    for (const frame of this.frames.values()) {
      try {
        frame.handle.postMessage(msg);
      } catch {
        // Frame may be in a torn-down state; ignore.
      }
    }
  }
}
