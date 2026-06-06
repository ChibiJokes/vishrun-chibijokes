/**
 * Lumiverse REST helper.
 *
 * The character JSON returned by GET /api/v1/characters/:id is FLAT
 * (Lumiverse stores `extensions` as a top-level column, not nested under `data`
 * like the SillyTavern V2 card spec). Verified against the live server
 * 2026-04-28: `character.extensions.regex_scripts` is the correct path.
 *
 * tavern_helper note
 * ──────────────────
 * Cards exported from SillyTavern+JSLR carry their character scripts inside
 * `data.extensions.tavern_helper.scripts`. After import into Lumiverse that
 * blob surfaces at `extensions.tavern_helper` (flat). vishrun reads this field
 * directly — no migration needed, cards from ST work out of the box.
 */

export interface RawRegexScript {
  id?: string;
  scriptName?: string;
  findRegex?: string;
  replaceString?: string;
  trimStrings?: string[];
  placement?: number[];
  disabled?: boolean;
  markdownOnly?: boolean;
  promptOnly?: boolean;
  runOnEdit?: boolean;
  minDepth?: number | null;
  maxDepth?: number | null;
  [k: string]: unknown;
}

/**
 * Loose shape of the tavern_helper extension blob written by JSLR.
 * We only read `scripts` here; variables and other fields are left alone.
 */
export interface RawTavernHelper {
  scripts?: unknown[];
  variables?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface LumiverseCharacter {
  id: string;
  name?: string;
  first_mes?: string;
  alternate_greetings?: string[];
  extensions?: {
    regex_scripts?: RawRegexScript[];
    /** Character scripts written by JSLR (or vishrun itself). */
    tavern_helper?: RawTavernHelper;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export async function fetchCharacter(characterId: string): Promise<LumiverseCharacter> {
  const url = `/api/v1/characters/${encodeURIComponent(characterId)}`;
  const r = await fetch(url, { credentials: 'same-origin' });
  if (!r.ok) {
    throw new Error(`fetchCharacter ${characterId}: HTTP ${r.status} ${r.statusText}`);
  }
  return (await r.json()) as LumiverseCharacter;
}

export function extractRegexScripts(char: LumiverseCharacter): RawRegexScript[] {
  const scripts = char?.extensions?.regex_scripts;
  return Array.isArray(scripts) ? scripts : [];
}

/**
 * Returns true if this character has JSLR-style scripts in tavern_helper.
 * Used by frontend.ts to decide whether to surface a "scripts available" badge
 * on the drawer tab when the panel is first opened.
 */
export function hasTavernHelperScripts(char: LumiverseCharacter): boolean {
  const scripts = char?.extensions?.tavern_helper?.scripts;
  return Array.isArray(scripts) && scripts.length > 0;
}
