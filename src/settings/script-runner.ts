import type { SpindleFrontendContext, SpindleSandboxFrameHandle } from 'lumiverse-spindle-types';
import { thHelpersShim } from '../render/th-helpers-shim';
import { fetchMessagesSnapshot } from '../render/th-helpers-bridge';
import type { Script } from './script-types';

// ── Event bridge shim ────────────────────────────────────────────────────────
// Provides window.eventSource + window.event_types inside each frame so JSLR
// scripts can call eventSource.on(event_types.CHAT_CHANGED, fn) unchanged.
// The host forwards Lumiverse events via handle.postMessage({ type:'vsh_event' });
// the bridge here re-emits them through eventSource so handlers fire normally.
const EVENT_BRIDGE_SHIM = `<script>(function(){
var ET={
  CHAT_CHANGED:'CHAT_CHANGED',MESSAGE_RECEIVED:'MESSAGE_RECEIVED',
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

const BRIDGED_EVENTS = [
  'CHAT_CHANGED','MESSAGE_RECEIVED','MESSAGE_SENT',
  'GENERATION_STARTED','GENERATION_ENDED','GENERATION_STOPPED',
  'CHARACTER_MESSAGE_RENDERED','USER_MESSAGE_RENDERED',
  'MESSAGE_SWIPED','MESSAGE_EDITED',
] as const;

interface LiveFrame {
  scriptId: string;
  scriptName: string;
  handle: SpindleSandboxFrameHandle;
  container: HTMLDivElement;
}

export class ScriptRunner {
  private frames = new Map<string, LiveFrame>();
  private eventUnsubs: Array<() => void> = [];

  constructor(private readonly ctx: SpindleFrontendContext) {
    this.installEventBridge();
  }

  async run(scripts: Script[], chatId: string | null): Promise<void> {
    this.teardownAll();
    if (scripts.length === 0) return;

    // chatId used for getChatMessages snapshot. Use '' when no chat is open —
    // scripts that don't call getChatMessages still run fine.
    const effectiveChatId = chatId ?? '';

    let messagesSnapshot: Awaited<ReturnType<typeof fetchMessagesSnapshot>> = [];
    if (effectiveChatId) {
      try {
        messagesSnapshot = await fetchMessagesSnapshot(
          { chatId: effectiveChatId, currentMessageId: '', currentMessageIndex: -1 },
          this.ctx,
        );
      } catch { /* non-fatal */ }
    }

    console.log(`[vishrun:script-runner] launching ${scripts.length} script(s)`, scripts.map(s => s.name));

    for (const script of scripts) {
      this.launchFrame(script, effectiveChatId, messagesSnapshot);
    }
  }

  destroy(): void {
    this.teardownAll();
    for (const unsub of this.eventUnsubs) unsub();
    this.eventUnsubs = [];
  }

  private launchFrame(
    script: Script,
    chatId: string,
    messagesSnapshot: Awaited<ReturnType<typeof fetchMessagesSnapshot>>,
  ): void {
    try {
      const shim = thHelpersShim({
        currentMessageIndex: -1,
        currentMessageId: '',
        chatId,
        messagesSnapshot,
      });

      const srcdoc = [
        EVENT_BRIDGE_SHIM,
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

      this.frames.set(script.id, { scriptId: script.id, scriptName: script.name, handle, container });
      console.log(`[vishrun:script-runner] launched: ${script.name} (${script.id})`);
    } catch (err) {
      console.error('[vishrun:script-runner] failed to launch:', script.name, err);
    }
  }

  private teardownAll(): void {
    for (const frame of this.frames.values()) {
      try { frame.handle.destroy?.(); } catch { /* no-op */ }
      try { frame.container.remove(); } catch { /* no-op */ }
    }
    if (this.frames.size > 0) {
      console.log(`[vishrun:script-runner] tore down ${this.frames.size} script frame(s)`);
    }
    this.frames.clear();
  }

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
      try { frame.handle.postMessage(msg); } catch { /* frame torn down */ }
    }
  }
}
