/**
 * ScriptStorageClient — REST-based, no backend messages required.
 *
 * Global / Preset scripts → GET|PUT /api/v1/settings/:key
 * Character scripts       → read:  GET /api/v1/characters/:id (extensions.tavern_helper.scripts)
 *                           write: read-modify-write to preserve regex_scripts and all other keys
 *
 * IMPORTANT: PUT /api/v1/characters/:id does a plain spread of the body's
 * extensions field — it does NOT shallow-merge with the existing extensions
 * the way spindle.characters.update() does. Sending only { tavern_helper: {...} }
 * would wipe regex_scripts (breaking every widget). saveCharacter therefore
 * reads the current extensions first, merges only tavern_helper.scripts,
 * then writes the full merged blob back.
 */

import { normalizeScriptTrees, isFolder, type Script, type ScriptTree } from './script-types';

const BASE = '/api/v1';
const GLOBAL_KEY = encodeURIComponent('vishrun_chibijokes.scripts.global');
function presetKey(presetId: string): string {
  return encodeURIComponent(`vishrun_chibijokes.scripts.preset.${presetId}`);
}

async function getJson(url: string): Promise<unknown> {
  const r = await fetch(url, { credentials: 'same-origin' });
  if (!r.ok) return null;
  return r.json();
}

async function putJson(url: string, body: unknown): Promise<void> {
  await fetch(url, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export class ScriptStorageClient {
  // ── Global ──────────────────────────────────────────────────────────

  async loadGlobal(): Promise<ScriptTree[]> {
    const row = await getJson(`${BASE}/settings/${GLOBAL_KEY}`) as { value?: { scripts?: unknown[] } } | null;
    return Array.isArray(row?.value?.scripts) ? normalizeScriptTrees(row!.value!.scripts!) : [];
  }

  async saveGlobal(scripts: ScriptTree[]): Promise<void> {
    await putJson(`${BASE}/settings/${GLOBAL_KEY}`, { value: { scripts } });
  }

  // ── Preset ───────────────────────────────────────────────────────────

  async loadPreset(presetId: string | null): Promise<ScriptTree[]> {
    if (!presetId) return [];
    const row = await getJson(`${BASE}/settings/${presetKey(presetId)}`) as { value?: { scripts?: unknown[] } } | null;
    return Array.isArray(row?.value?.scripts) ? normalizeScriptTrees(row!.value!.scripts!) : [];
  }

  async savePreset(presetId: string | null, scripts: ScriptTree[]): Promise<void> {
    if (!presetId) return;
    await putJson(`${BASE}/settings/${presetKey(presetId)}`, { value: { scripts } });
  }

  // ── Character ────────────────────────────────────────────────────────

  async loadCharacter(characterId: string): Promise<ScriptTree[]> {
    const char = await getJson(`${BASE}/characters/${encodeURIComponent(characterId)}`) as {
      extensions?: { tavern_helper?: { scripts?: unknown[] } };
    } | null;
    const scripts = char?.extensions?.tavern_helper?.scripts;
    return Array.isArray(scripts) ? normalizeScriptTrees(scripts) : [];
  }

  /**
   * Read-modify-write: fetches the full current extensions object, merges
   * only tavern_helper.scripts, then writes everything back. This preserves
   * regex_scripts and any other extension keys that vishrun didn't touch.
   */
  async saveCharacter(characterId: string, scripts: ScriptTree[]): Promise<void> {
    const url = `${BASE}/characters/${encodeURIComponent(characterId)}`;

    // Read current state to get the full extensions blob.
    const current = await getJson(url) as {
      extensions?: Record<string, unknown>;
    } | null;

    const existing = (current?.extensions ?? {}) as Record<string, unknown>;
    const existingTh = (existing.tavern_helper ?? {}) as Record<string, unknown>;

    const merged: Record<string, unknown> = {
      ...existing,
      tavern_helper: { ...existingTh, scripts },
    };

    await putJson(url, { extensions: merged });
  }

  destroy(): void {}
}

// ── Combined loader for the script runner ───────────────────────────────────

function flattenEnabled(trees: ScriptTree[]): Script[] {
  const out: Script[] = [];
  for (const tree of trees) {
    if (!tree.enabled) continue;
    if (isFolder(tree)) {
      for (const s of tree.scripts) {
        if (s.enabled && s.content.trim()) out.push(s);
      }
    } else if (tree.content.trim()) {
      out.push(tree);
    }
  }
  return out;
}

export async function loadEnabledScripts(
  characterId: string | null,
  presetId: string | null,
): Promise<Script[]> {
  const storage = new ScriptStorageClient();
  const [global, preset, char] = await Promise.all([
    storage.loadGlobal(),
    storage.loadPreset(presetId),
    characterId ? storage.loadCharacter(characterId) : Promise.resolve([] as ScriptTree[]),
  ]);
  return [
    ...flattenEnabled(global),
    ...flattenEnabled(char),
    ...flattenEnabled(preset),
  ];
}

// ── First-run initialisation ─────────────────────────────────────────────────
// Pre-creates the global and preset settings keys so subsequent GETs return
// 200 + empty arrays instead of 404. Call once during extension setup.
// Uses PUT-if-missing: fetches first; only writes if the key isn't there yet.

export async function initScriptStorage(): Promise<void> {
  const storage = new ScriptStorageClient();

  const globalResp = await fetch(`${BASE}/settings/${GLOBAL_KEY}`, { credentials: 'same-origin' });
  if (!globalResp.ok) await storage.saveGlobal([]);
  // Preset keys are per-loom — no blanket pre-creation needed.
}

// ── Loom helpers ──────────────────────────────────────────────────────────────

/** Returns the currently active Loom preset ID, or null if none is set. */
export async function getActiveLoomPresetId(): Promise<string | null> {
  const row = await getJson(`${BASE}/settings/activeLoomPresetId`) as { value?: unknown } | null;
  const id = row?.value;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/** Returns the display name of a preset, or falls back to its ID. */
export async function getPresetName(presetId: string): Promise<string> {
  const preset = await getJson(`${BASE}/presets/${encodeURIComponent(presetId)}`) as { name?: string } | null;
  return typeof preset?.name === 'string' ? preset.name : presetId;
}
