/**
 * ScriptStorageClient — REST-based, no backend messages required.
 *
 * Follows the same pattern as fetch-character.ts: direct fetch() calls to
 * the Lumiverse REST API at /api/v1. No ctx needed; no message timeouts;
 * no async bus complexity.
 *
 * Global / Preset scripts  → GET|PUT /api/v1/settings/:key
 * Character scripts        → GET /api/v1/characters/:id  (read extensions.tavern_helper.scripts)
 *                            PUT /api/v1/characters/:id  (write extensions.tavern_helper.scripts)
 *
 * Storing character scripts under tavern_helper keeps them ST-compatible:
 * cards exported from Lumiverse carry the scripts in the same field that
 * JSLR reads, so the round-trip works without any import step.
 */

import { normalizeScriptTrees, isFolder, type Script, type ScriptTree } from './script-types';

const BASE = '/api/v1';
const GLOBAL_KEY = encodeURIComponent('vishrun_chibijokes.scripts.global');
const PRESET_KEY  = encodeURIComponent('vishrun_chibijokes.scripts.preset');

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

  async loadPreset(): Promise<ScriptTree[]> {
    const row = await getJson(`${BASE}/settings/${PRESET_KEY}`) as { value?: { scripts?: unknown[] } } | null;
    return Array.isArray(row?.value?.scripts) ? normalizeScriptTrees(row!.value!.scripts!) : [];
  }

  async savePreset(scripts: ScriptTree[]): Promise<void> {
    await putJson(`${BASE}/settings/${PRESET_KEY}`, { value: { scripts } });
  }

  // ── Character ────────────────────────────────────────────────────────
  // Reads from extensions.tavern_helper.scripts so ST-exported cards
  // (which carry JSLR scripts there) appear in the panel automatically.

  async loadCharacter(characterId: string): Promise<ScriptTree[]> {
    const char = await getJson(`${BASE}/characters/${encodeURIComponent(characterId)}`) as {
      extensions?: { tavern_helper?: { scripts?: unknown[] } };
    } | null;
    const scripts = char?.extensions?.tavern_helper?.scripts;
    return Array.isArray(scripts) ? normalizeScriptTrees(scripts) : [];
  }

  /**
   * Writes scripts back to extensions.tavern_helper.scripts.
   * Lumiverse shallow-merges the extensions object, so only tavern_helper
   * is touched — regex_scripts and every other extension key are preserved.
   */
  async saveCharacter(characterId: string, scripts: ScriptTree[]): Promise<void> {
    await putJson(`${BASE}/characters/${encodeURIComponent(characterId)}`, {
      extensions: {
        tavern_helper: { scripts },
      },
    });
  }

  // No persistent state — nothing to clean up.
  destroy(): void {}
}

// ── Combined loader for the script runner ───────────────────────────────────
// Returns all enabled flat Scripts across global → character → preset tiers.
// Folders are flattened; disabled items at any level are skipped.

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

export async function loadEnabledScripts(characterId: string | null): Promise<Script[]> {
  const storage = new ScriptStorageClient();
  const [global, preset, char] = await Promise.all([
    storage.loadGlobal(),
    storage.loadPreset(),
    characterId ? storage.loadCharacter(characterId) : Promise.resolve([] as ScriptTree[]),
  ]);
  // JSLR execution order: global → character → preset
  return [
    ...flattenEnabled(global),
    ...flattenEnabled(char),
    ...flattenEnabled(preset),
  ];
}
