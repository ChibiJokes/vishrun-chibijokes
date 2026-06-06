/**
 * ScriptStorageClient
 *
 * Thin frontend wrapper over vishrun's backend scripts handler.
 * Uses the same request/response protocol as th-helpers and fetch-external:
 *   frontend sends  { type: 'scripts_request',  requestId, op, ...body }
 *   backend replies { type: 'scripts_response', requestId, ok, result? }
 *
 * All methods return empty arrays on timeout or backend error, so the panel
 * degrades gracefully without throwing.
 */

import type { SpindleFrontendContext } from 'lumiverse-spindle-types';
import { normalizeScriptTrees, type ScriptTree } from './script-types';

interface ScriptsResponse {
  type: 'scripts_response';
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

function isScriptsResponse(p: unknown): p is ScriptsResponse {
  return (
    !!p &&
    typeof p === 'object' &&
    (p as Record<string, unknown>).type === 'scripts_response' &&
    typeof (p as Record<string, unknown>).requestId === 'string'
  );
}

const TIMEOUT_MS = 8_000;

export class ScriptStorageClient {
  private pending = new Map<
    string,
    { resolve: (v: unknown) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private counter = 0;
  private readonly unsub: () => void;

  constructor(private readonly ctx: SpindleFrontendContext) {
    this.unsub = ctx.onBackendMessage((payload) => {
      if (!isScriptsResponse(payload)) return;
      const entry = this.pending.get(payload.requestId);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(payload.requestId);
      entry.resolve(payload.ok ? payload.result : null);
    });
  }

  destroy(): void {
    this.unsub();
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
  }

  private request<T>(op: string, body: Record<string, unknown> = {}): Promise<T | null> {
    const requestId = `vsh_scripts_${++this.counter}`;
    return new Promise<T | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        console.warn('[vishrun:scripts] request timed out:', op, requestId);
        resolve(null);
      }, TIMEOUT_MS);
      this.pending.set(requestId, { resolve: resolve as (v: unknown) => void, timer });
      this.ctx.sendToBackend({ type: 'scripts_request', requestId, op, ...body });
    });
  }

  // ── Readers ─────────────────────────────────────────────────────────

  async loadGlobal(): Promise<ScriptTree[]> {
    const r = await this.request<{ scripts: unknown[] }>('read_global');
    return Array.isArray(r?.scripts) ? normalizeScriptTrees(r.scripts) : [];
  }

  async loadPreset(): Promise<ScriptTree[]> {
    const r = await this.request<{ scripts: unknown[] }>('read_preset');
    return Array.isArray(r?.scripts) ? normalizeScriptTrees(r.scripts) : [];
  }

  /**
   * Reads character scripts from character.extensions.tavern_helper.scripts.
   * Cards exported from SillyTavern+JSLR already carry scripts here, so they
   * appear in vishrun's panel automatically without any import step.
   */
  async loadCharacter(characterId: string): Promise<ScriptTree[]> {
    const r = await this.request<{ scripts: unknown[] }>('read_character', { characterId });
    return Array.isArray(r?.scripts) ? normalizeScriptTrees(r.scripts) : [];
  }

  // ── Writers ─────────────────────────────────────────────────────────

  async saveGlobal(scripts: ScriptTree[]): Promise<void> {
    await this.request('save_global', { scripts });
  }

  async savePreset(scripts: ScriptTree[]): Promise<void> {
    await this.request('save_preset', { scripts });
  }

  async saveCharacter(characterId: string, scripts: ScriptTree[]): Promise<void> {
    await this.request('save_character', { characterId, scripts });
  }
}
