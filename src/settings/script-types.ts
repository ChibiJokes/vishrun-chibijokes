/**
 * Script type definitions for vishrun's script management system.
 *
 * These are intentionally wire-compatible with JS-Slash-Runner's
 * ScriptTree / Script / ScriptFolder types so that characters exported
 * from SillyTavern+JSLR arrive with their `extensions.tavern_helper.scripts`
 * already readable by vishrun without any migration step.
 */

export interface ScriptButton {
  name: string;
  visible: boolean;
}

export interface ScriptExportWith {
  /** Include transient script data on export. Default true. */
  data: boolean;
  /** Include button state on export. Default true. */
  button: boolean;
}

export interface Script {
  type: 'script';
  enabled: boolean;
  name: string;
  id: string;
  content: string;
  info: string;
  button: {
    enabled: boolean;
    buttons: ScriptButton[];
  };
  data: Record<string, unknown>;
  export_with: ScriptExportWith;
  /** Set at load time — not persisted to storage. */
  scope?: 'global' | 'character' | 'preset';
}

export interface ScriptFolder {
  type: 'folder';
  enabled: boolean;
  name: string;
  id: string;
  icon: string;
  color: string;
  scripts: Script[];
}

export type ScriptTree = Script | ScriptFolder;

export function isScript(tree: ScriptTree): tree is Script {
  return tree.type === 'script';
}

export function isFolder(tree: ScriptTree): tree is ScriptFolder {
  return tree.type === 'folder';
}

/** Create a new Script with safe defaults. */
export function makeScript(partial: Partial<Script> = {}): Script {
  return {
    type: 'script',
    enabled: partial.enabled ?? true,
    name: partial.name ?? 'New Script',
    id: partial.id ?? crypto.randomUUID(),
    content: partial.content ?? '',
    info: partial.info ?? '',
    button: partial.button ?? { enabled: true, buttons: [] },
    data: partial.data ?? {},
    export_with: partial.export_with ?? { data: true, button: true },
  };
}

/**
 * Parse an unknown value (typically from tavern_helper.scripts) into a
 * ScriptTree. Returns null for unrecognisable input rather than throwing.
 */
export function normalizeScriptTree(raw: unknown): ScriptTree | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  if (r.type === 'folder') {
    return {
      type: 'folder',
      enabled: typeof r.enabled === 'boolean' ? r.enabled : true,
      name: typeof r.name === 'string' ? r.name : '',
      id: typeof r.id === 'string' ? r.id : crypto.randomUUID(),
      icon: typeof r.icon === 'string' ? r.icon : 'fa-solid fa-folder',
      color: typeof r.color === 'string' ? r.color : '#888888',
      scripts: Array.isArray(r.scripts)
        ? (r.scripts
            .map(normalizeScriptTree)
            .filter((s): s is Script => s !== null && s.type === 'script'))
        : [],
    };
  }

  // Handles both type:'script' and legacy bare objects from older JSLR exports.
  return makeScript({
    enabled: typeof r.enabled === 'boolean' ? r.enabled : true,
    name:
      typeof r.name === 'string'
        ? r.name
        : typeof r.scriptName === 'string'
          ? r.scriptName
          : '',
    id: typeof r.id === 'string' ? r.id : crypto.randomUUID(),
    content: typeof r.content === 'string' ? r.content : '',
    info: typeof r.info === 'string' ? r.info : '',
    button:
      r.button && typeof r.button === 'object'
        ? (r.button as Script['button'])
        : { enabled: true, buttons: [] },
    data:
      r.data && typeof r.data === 'object'
        ? (r.data as Record<string, unknown>)
        : {},
    export_with:
      r.export_with && typeof r.export_with === 'object'
        ? (r.export_with as ScriptExportWith)
        : { data: true, button: true },
  });
}

export function normalizeScriptTrees(raw: unknown[]): ScriptTree[] {
  return raw.map(normalizeScriptTree).filter((s): s is ScriptTree => s !== null);
}
