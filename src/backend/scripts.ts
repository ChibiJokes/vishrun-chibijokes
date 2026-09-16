/**
 * Backend handler for the vishrun script-management system.
 *
 * Listens for { type: 'scripts_request' } messages from the frontend panel
 * and performs storage/character API calls, replying with
 * { type: 'scripts_response', requestId, ok, result? }.
 *
 * Storage layout
 * ──────────────
 *   Global scripts  → extension storage: scripts/global.json
 *   Preset scripts  → extension storage: scripts/preset.json
 *   Character scripts → character.extensions.tavern_helper.scripts
 *     (same field JSLR uses — ST-exported cards are readable without migration)
 */

import { api } from './common';

const LOG_PREFIX = '[vishrun:scripts]';
const log = {
  warn: (...args: unknown[]) => console.warn(LOG_PREFIX, ...args),
  debug: (...args: unknown[]) => console.debug(LOG_PREFIX, ...args),
};

const GLOBAL_PATH = 'scripts/global.json';
const PRESET_PATH = 'scripts/preset.json';
const EMPTY: { scripts: unknown[] } = { scripts: [] };

interface ScriptsRequest {
  type: 'scripts_request';
  requestId: string;
  op: string;
  characterId?: string;
  scripts?: unknown[];
}

function isScriptsRequest(p: unknown): p is ScriptsRequest {
  return (
    !!p &&
    typeof p === 'object' &&
    (p as Record<string, unknown>).type === 'scripts_request' &&
    typeof (p as Record<string, unknown>).requestId === 'string' &&
    typeof (p as Record<string, unknown>).op === 'string'
  );
}

async function handleOp(req: ScriptsRequest): Promise<unknown> {
  switch (req.op) {
    // ── Global ────────────────────────────────────────────────────────
    case 'read_global':
      return api.storage.getJson<{ scripts: unknown[] }>(GLOBAL_PATH, {
        fallback: EMPTY,
      });

    case 'save_global':
      await api.storage.setJson(GLOBAL_PATH, { scripts: req.scripts ?? [] }, { indent: 2 });
      return { ok: true };

    // ── Preset ────────────────────────────────────────────────────────
    case 'read_preset':
      return api.storage.getJson<{ scripts: unknown[] }>(PRESET_PATH, {
        fallback: EMPTY,
      });

    case 'save_preset':
      await api.storage.setJson(PRESET_PATH, { scripts: req.scripts ?? [] }, { indent: 2 });
      return { ok: true };

    // ── Character ─────────────────────────────────────────────────────
    case 'read_character': {
      const { characterId } = req;
      if (!characterId) throw new Error('read_character: characterId required');

      const char = await api.characters.get(characterId);
      if (!char) {
        log.debug('read_character: character not found', characterId);
        return EMPTY;
      }

      // Lumiverse stores extensions flat (not nested under data.extensions).
      // JSLR writes to data.extensions.tavern_helper in ST, which Lumiverse
      // surfaces at extensions.tavern_helper after import.
      const ext = char.extensions as Record<string, unknown> | undefined;
      const th = ext?.tavern_helper as Record<string, unknown> | undefined;
      const scripts = Array.isArray(th?.scripts) ? th.scripts : [];
      log.debug('read_character: found', scripts.length, 'scripts for', characterId);
      return { scripts };
    }

    case 'save_character': {
      const { characterId } = req;
      if (!characterId) throw new Error('save_character: characterId required');

      // Shallow-merge into extensions so we only overwrite the tavern_helper
      // key and leave every other extension (regex_scripts, etc.) untouched.
      await api.characters.update(characterId, {
        extensions: {
          tavern_helper: { scripts: req.scripts ?? [] },
        },
      });
      log.debug('save_character: saved', (req.scripts ?? []).length, 'scripts for', characterId);
      return { ok: true };
    }

    default:
      throw new Error(`scripts: unknown op "${req.op}"`);
  }
}

export function installScriptsHandler(): void {
  api.onFrontendMessage(async (payload, userId) => {
    if (!isScriptsRequest(payload)) return;

    const { requestId, op } = payload;

    try {
      const result = await handleOp(payload);
      api.sendToFrontend(
        { type: 'scripts_response', requestId, ok: true, result },
        userId,
      );
    } catch (err) {
      log.warn('op failed:', op, err);
      api.sendToFrontend(
        {
          type: 'scripts_response',
          requestId,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        },
        userId,
      );
    }
  });
}
