import type { SpindleFrontendContext, SpindleSandboxFrameHandle } from 'lumiverse-spindle-types';
import { thHelpersShim } from '../render/th-helpers-shim';
import { fetchMessagesSnapshot } from '../render/th-helpers-bridge';
import { handleClipboardWriteText, handleHostAlert } from '../render/clipboard-shim';
import type { Script } from './script-types';

// ── Event bridge shim ────────────────────────────────────────────────────────
// This shim runs BEFORE user code. It does two things:
//
// 1. pagehide gate — Lumiverse fires pagehide on every SPA navigation,
//    including on frames we just created. Without this gate, The Quill's
//    triggerNuke() removes the button the instant it's created. We intercept
//    window.addEventListener('pagehide') so those handlers only run when WE
//    explicitly request teardown via vsh_teardown. All other pagehide events
//    from Lumiverse's navigation are silently swallowed.
//
// 2. eventSource bridge — forwards vsh_event host messages as eventSource
//    emissions so JSLR scripts can call eventSource.on(event_types.*, fn).
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
    if(!msg)return;
    if(msg.type==='vsh_teardown'){
      try{window.dispatchEvent(new Event('pagehide'));}catch(e){}
      return;
    }
    if(msg.type!=='vsh_event')return;
    window.eventSource.emit(msg.event,msg.data);
  });
}
})()</script>`;

// ── Clipboard / alert shim ───────────────────────────────────────────────────
// Mirrors the shim injected into regex widget iframes (clipboardAlertShim in
// widget-iframe.ts). Intercepts navigator.clipboard.writeText and alert so
// quill.js's pushToSillyTavern fallback routes through the same
// dispatch_slash_text backend path that widget frames use.
const CLIPBOARD_SHIM = `<script>(function(){` +
  `try{` +
  `if(!navigator.clipboard){Object.defineProperty(navigator,'clipboard',{value:{},configurable:true});}` +
  `navigator.clipboard.writeText=function(text){` +
  `try{window.spindleSandbox.postMessage({kind:'clipboard-write-text',payload:{text:String(text)}});return Promise.resolve();}` +
  `catch(e){return Promise.reject(e);}` +
  `};}catch(e){}` +
  `window.alert=function(msg){` +
  `try{window.spindleSandbox.postMessage({kind:'alert',payload:{message:String(msg)}});}catch(e){}` +
  `};` +
  `})();<\/script>`;

const BRIDGED_EVENTS = [
  'CHAT_CHANGED','MESSAGE_RECEIVED','MESSAGE_SENT',
  'GENERATION_STARTED','GENERATION_ENDED','GENERATION_STOPPED',
  'CHARACTER_MESSAGE_RENDERED','USER_MESSAGE_RENDERED',
  'MESSAGE_SWIPED','MESSAGE_EDITED',
] as const;

interface LiveFrame {
  scriptId: string;
  scriptName: string;
  contentHash: number;
  handle: SpindleSandboxFrameHandle;
  container: HTMLDivElement;
}

export class ScriptRunner {
  private frames = new Map<string, LiveFrame>();
  private eventUnsubs: Array<() => void> = [];

  constructor(private readonly ctx: SpindleFrontendContext) {
    this.installEventBridge();
  }

  /**
   * Diff the new script set against currently running frames — JSLR style.
   * Frames whose script id + content hash hasn't changed are kept alive.
   * Only added/changed scripts get new frames; only removed scripts get torn down.
   *
   * This means switching to the same character in a different chat never
   * touches the frames at all — no pagehide, button stays, exactly like JSLR's
   * keyed v-for where the key = script.source + script.id + script.reload_memo.
   */
  async run(scripts: Script[], chatId: string | null): Promise<void> {
    const effectiveChatId = chatId ?? '';

    // Build a key for each incoming script (id + content hash).
    // If the key matches a running frame, keep it. Otherwise rebuild.
    const incoming = new Map<string, Script>();
    for (const s of scripts) {
      incoming.set(s.id + '::' + this.hashContent(s.content), s);
    }

    // Tear down frames that are no longer in the incoming set.
    const toRemove: LiveFrame[] = [];
    for (const [key, frame] of this.frames) {
      if (!incoming.has(key)) toRemove.push(frame);
    }
    for (const frame of toRemove) {
      this.frames.delete(this.frameKey(frame));
      await this.destroyFrame(frame);
    }

    // Fetch snapshot once for any new frames that need launching.
    const needsLaunch = [...incoming.entries()].filter(([key]) => !this.frames.has(key));
    if (needsLaunch.length === 0) return;

    let messagesSnapshot: Awaited<ReturnType<typeof fetchMessagesSnapshot>> = [];
    if (effectiveChatId) {
      try {
        messagesSnapshot = await fetchMessagesSnapshot(
          { chatId: effectiveChatId, currentMessageId: '', currentMessageIndex: -1 },
          this.ctx,
        );
      } catch { /* non-fatal */ }
    }

    for (const [key, script] of needsLaunch) {
      this.launchFrame(script, effectiveChatId, messagesSnapshot, key);
    }
  }

  destroy(): void {
    void this.teardownAll();
    for (const unsub of this.eventUnsubs) unsub();
    this.eventUnsubs = [];
  }

  private frameKey(frame: LiveFrame): string {
    return frame.scriptId + '::' + frame.contentHash;
  }

  private hashContent(content: string): number {
    // Simple but fast djb2-style hash — good enough for change detection.
    let h = 5381;
    for (let i = 0; i < content.length; i++) {
      h = ((h << 5) + h) ^ content.charCodeAt(i);
      h = h >>> 0; // keep uint32
    }
    return h;
  }

  private async destroyFrame(frame: LiveFrame): Promise<void> {
    try { frame.handle.postMessage({ type: 'vsh_teardown' }); } catch { /* no-op */ }
    await new Promise<void>(r => setTimeout(r, 60));
    try { frame.handle.destroy?.(); } catch { /* no-op */ }
    try { frame.container.remove(); } catch { /* no-op */ }
  }

  private async teardownAll(): Promise<void> {
    const all = [...this.frames.values()];
    this.frames.clear();
    for (const frame of all) await this.destroyFrame(frame);
  }

  private launchFrame(
    script: Script,
    chatId: string,
    messagesSnapshot: Awaited<ReturnType<typeof fetchMessagesSnapshot>>,
    frameKey: string,
  ): void {
    try {
      const shim = thHelpersShim({
        currentMessageIndex: -1,
        currentMessageId: '',
        chatId,
        messagesSnapshot,
      });

      const srcdoc = [
        CLIPBOARD_SHIM,
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

      // Route clipboard / alert messages from the frame through the same
      // host-side handlers that widget iframes use — this is what makes
      // quill.js's pushToSillyTavern → /sys path work in character scripts.
      handle.onMessage((raw: unknown) => {
        const p = raw as { kind?: string; payload?: unknown } | null;
        if (!p) return;
        if (p.kind === 'clipboard-write-text') {
          void handleClipboardWriteText(p.payload, this.ctx);
        } else if (p.kind === 'alert') {
          handleHostAlert(p.payload);
        }
      });

      const contentHash = this.hashContent(script.content);
      this.frames.set(frameKey, { scriptId: script.id, scriptName: script.name, contentHash, handle, container });
      console.log(`[vishrun:script-runner] launched: ${script.name} (${script.id})`);
    } catch (err) {
      console.error('[vishrun:script-runner] failed to launch:', script.name, err);
    }
  }

  private async teardownAll(): Promise<void> {
    if (this.frames.size === 0) return;
    console.log(`[vishrun:script-runner] tearing down ${this.frames.size} script frame(s)`);

    // Step 1: signal each frame to clean up its own DOM artifacts.
    // The vsh_teardown handler in EVENT_BRIDGE_SHIM dispatches a synthetic
    // pagehide so scripts like quill.js run triggerNuke() and remove buttons
    // they added to the parent document — before we destroy the frames.
    for (const frame of this.frames.values()) {
      try { frame.handle.postMessage({ type: 'vsh_teardown' }); } catch { /* no-op */ }
    }

    // Step 2: give frames ~60ms to process the message and run their cleanup.
    await new Promise<void>(r => setTimeout(r, 60));

    // Step 3: now actually remove the frames.
    for (const frame of this.frames.values()) {
      try { frame.handle.destroy?.(); } catch { /* no-op */ }
      try { frame.container.remove(); } catch { /* no-op */ }
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
