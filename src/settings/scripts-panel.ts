/**
 * createScriptsPanel
 *
 * Renders vishrun's Script settings into the host's Extensions settings panel
 * (Settings → Extensions). The host card is already provided by Lumiverse via
 * the [data-spindle-mount="settings_extensions"] container — we just render our
 * content into `root` and the host wraps it in a border + padding card.
 *
 * Three sections mirror JS-Slash-Runner's Script tab:
 *   Global    → stored in extension storage (scripts/global.json)
 *   Character → stored in character.extensions.tavern_helper.scripts
 *   Preset    → stored in extension storage (scripts/preset.json)
 *
 * Character scripts round-trip with SillyTavern+JSLR automatically — they
 * share the same storage field and need no import step.
 */

import type { SpindleFrontendContext } from 'lumiverse-spindle-types';
import { ScriptStorageClient, getPresetName } from './script-storage';
import {
  type Script,
  type ScriptFolder,
  type ScriptTree,
  isFolder,
  makeScript,
} from './script-types';
import { getActiveCard } from '../state/active-card';

// ── CSS ─────────────────────────────────────────────────────────────────────
// The host card already supplies outer border + padding (14px 16px), so the
// panel root padding is 0. We add our own internal gap/spacing only.

const CSS = `
.vsh-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--lumiverse-border);
}
.vsh-panel-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--lumiverse-text);
  display: flex;
  align-items: center;
  gap: 6px;
}
.vsh-panel-badge {
  font-size: 10px;
  font-weight: 500;
  padding: 1px 6px;
  background: var(--lumiverse-accent);
  color: var(--lumiverse-accent-fg);
  border-radius: 99px;
}
.vsh-scripts-panel {
  display: flex;
  flex-direction: column;
  gap: 0;
  font-size: 13px;
  color: var(--lumiverse-text);
}
.vsh-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 0;
}
.vsh-section + .vsh-section {
  border-top: 1px solid var(--lumiverse-border);
}
.vsh-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.vsh-section-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--lumiverse-text-muted);
}
.vsh-section-sub {
  font-size: 11px;
  color: var(--lumiverse-text-dim);
  margin: 0;
}
.vsh-add-btn {
  padding: 3px 8px;
  background: transparent;
  border: 1px solid var(--lumiverse-border);
  border-radius: var(--lumiverse-radius);
  color: var(--lumiverse-text-muted);
  font-size: 11px;
  cursor: pointer;
  transition: var(--lumiverse-transition-fast);
  white-space: nowrap;
  font-family: inherit;
}
.vsh-add-btn:hover:not(:disabled) {
  border-color: var(--lumiverse-accent);
  color: var(--lumiverse-accent);
}
.vsh-add-btn:disabled {
  opacity: 0.4;
  cursor: default;
}
.vsh-script-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.vsh-empty {
  padding: 10px;
  text-align: center;
  color: var(--lumiverse-text-dim);
  font-size: 11px;
  border: 1px dashed var(--lumiverse-border);
  border-radius: var(--lumiverse-radius);
}
.vsh-script-item {
  border: 1px solid var(--lumiverse-border);
  border-radius: var(--lumiverse-radius);
  overflow: hidden;
}
.vsh-script-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  background: var(--lumiverse-fill);
  transition: background var(--lumiverse-transition-fast);
}
.vsh-script-row:hover {
  background: var(--lumiverse-fill-subtle);
}
.vsh-enable-toggle {
  flex-shrink: 0;
  width: 13px;
  height: 13px;
  cursor: pointer;
  accent-color: var(--lumiverse-accent);
  margin: 0;
}
.vsh-script-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--lumiverse-text);
}
.vsh-script-name.vsh-disabled {
  color: var(--lumiverse-text-dim);
  text-decoration: line-through;
}
.vsh-btn {
  flex-shrink: 0;
  padding: 2px 7px;
  background: transparent;
  border: 1px solid var(--lumiverse-border);
  border-radius: var(--lumiverse-radius);
  color: var(--lumiverse-text-muted);
  font-size: 10px;
  cursor: pointer;
  transition: var(--lumiverse-transition-fast);
  font-family: inherit;
  line-height: 1.4;
}
.vsh-btn:hover {
  border-color: var(--lumiverse-border-hover);
  color: var(--lumiverse-text);
}
.vsh-btn-delete:hover {
  border-color: #c0392b;
  color: #c0392b;
}
.vsh-editor {
  border-top: 1px solid var(--lumiverse-border);
  padding: 10px;
  background: var(--lumiverse-fill-subtle);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.vsh-editor[hidden] {
  display: none;
}
.vsh-field {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.vsh-field-label {
  font-size: 10px;
  color: var(--lumiverse-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.vsh-input {
  padding: 5px 7px;
  background: var(--lumiverse-fill);
  border: 1px solid var(--lumiverse-border);
  border-radius: var(--lumiverse-radius);
  color: var(--lumiverse-text);
  font-size: 12px;
  width: 100%;
  box-sizing: border-box;
  font-family: inherit;
  transition: border-color var(--lumiverse-transition-fast);
}
.vsh-input:focus { outline: none; border-color: var(--lumiverse-accent); }
.vsh-textarea {
  padding: 7px 8px;
  background: var(--lumiverse-fill);
  border: 1px solid var(--lumiverse-border);
  border-radius: var(--lumiverse-radius);
  color: var(--lumiverse-text);
  font-family: 'Fira Code', 'Cascadia Code', 'Consolas', ui-monospace, monospace;
  font-size: 11px;
  line-height: 1.5;
  resize: vertical;
  min-height: 130px;
  width: 100%;
  box-sizing: border-box;
  transition: border-color var(--lumiverse-transition-fast);
}
.vsh-textarea:focus { outline: none; border-color: var(--lumiverse-accent); }
.vsh-folder-item {
  border: 1px solid var(--lumiverse-border);
  border-radius: var(--lumiverse-radius);
  overflow: hidden;
}
.vsh-folder-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  background: var(--lumiverse-fill-subtle);
  border-bottom: 1px solid var(--lumiverse-border);
}
.vsh-folder-scripts {
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  background: var(--lumiverse-fill);
}
/* Search bar */
.vsh-search-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
}
.vsh-search-input {
  flex: 1;
  padding: 5px 8px;
  background: var(--lumiverse-fill);
  border: 1px solid var(--lumiverse-border);
  border-radius: var(--lumiverse-radius);
  color: var(--lumiverse-text);
  font-size: 12px;
  font-family: inherit;
  transition: border-color var(--lumiverse-transition-fast);
}
.vsh-search-input:focus { outline: none; border-color: var(--lumiverse-accent); }
.vsh-search-input::placeholder { color: var(--lumiverse-text-dim); }
/* Section header controls */
.vsh-section-controls {
  display: flex;
  align-items: center;
  gap: 5px;
}
/* Section toggle */
.vsh-section-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  color: var(--lumiverse-text-muted);
  cursor: pointer;
  user-select: none;
  padding: 2px 6px;
  border: 1px solid var(--lumiverse-border);
  border-radius: var(--lumiverse-radius);
  transition: var(--lumiverse-transition-fast);
}
.vsh-section-toggle:hover { border-color: var(--lumiverse-accent); color: var(--lumiverse-accent); }
.vsh-section-toggle.active { border-color: var(--lumiverse-accent); color: var(--lumiverse-accent); background: color-mix(in srgb, var(--lumiverse-accent) 10%, transparent); }
/* Section disabled state */
.vsh-section.vsh-section-disabled .vsh-script-list { opacity: 0.4; pointer-events: none; }
/* Editor tabs */
.vsh-editor-tabs {
  display: flex;
  gap: 2px;
  border-bottom: 1px solid var(--lumiverse-border);
  margin-bottom: 8px;
}
.vsh-editor-tab {
  padding: 4px 10px;
  font-size: 10px;
  font-family: inherit;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--lumiverse-text-muted);
  cursor: pointer;
  transition: var(--lumiverse-transition-fast);
  margin-bottom: -1px;
}
.vsh-editor-tab:hover { color: var(--lumiverse-text); }
.vsh-editor-tab.vsh-tab-active { color: var(--lumiverse-accent); border-bottom-color: var(--lumiverse-accent); }
.vsh-editor-tabpanel { display: flex; flex-direction: column; gap: 8px; }
.vsh-editor-tabpanel[hidden] { display: none; }
/* export_with row */
.vsh-checkbox-row {
  display: flex;
  gap: 14px;
  align-items: center;
  flex-wrap: wrap;
}
.vsh-checkbox-label {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--lumiverse-text-muted);
  cursor: pointer;
  user-select: none;
}
/* Drag handle */
.vsh-drag-handle {
  flex-shrink: 0;
  cursor: grab;
  color: var(--lumiverse-text-dim);
  font-size: 11px;
  padding: 0 3px;
  user-select: none;
  line-height: 1;
}
.vsh-drag-handle:active { cursor: grabbing; }
/* Drag-over indicator */
.vsh-drag-over {
  outline: 2px dashed var(--lumiverse-accent);
  outline-offset: -2px;
}
.vsh-drag-over-folder {
  background: color-mix(in srgb, var(--lumiverse-accent) 8%, transparent);
}
/* Dragging opacity */
[draggable=true].vsh-dragging { opacity: 0.4; }
`;

// ── Types ────────────────────────────────────────────────────────────────────

type Target = 'global' | 'character' | 'preset';

export interface ScriptsPanel {
  onCharacterChanged(characterId: string | null): void;
  onPresetChanged(presetId: string | null): void;
  /** Called after fetchCharacter to show a badge when the card has JSLR scripts. */
  setHasTavernHelperScripts(has: boolean): void;
  destroy(): void;
}

export type OnReloadScript = (scriptId: string) => void;

// ── Entry point ──────────────────────────────────────────────────────────────

export function createScriptsPanel(
  root: HTMLElement,
  ctx: SpindleFrontendContext,
  onScriptsSaved?: () => void,
  onReloadScript?: OnReloadScript,
): ScriptsPanel {
  const storage = new ScriptStorageClient();
  const removeStyle = ctx.dom.addStyle(CSS);

  // ── State ──────────────────────────────────────────────────────────
  let globalScripts: ScriptTree[] = [];
  let charScripts: ScriptTree[] = [];
  let presetScripts: ScriptTree[] = [];
  let currentCharId: string | null = null;
  let currentPresetId: string | null = null;
  let currentPresetName: string | null = null;
  const saveTimers = new Map<Target, ReturnType<typeof setTimeout>>();
  const LS_KEY = (t: Target) => `vsh_section_enabled_${t}`;
  const sectionEnabled: Record<Target, boolean> = {
    global:    localStorage.getItem(LS_KEY('global'))    !== 'false',
    character: localStorage.getItem(LS_KEY('character')) !== 'false',
    preset:    localStorage.getItem(LS_KEY('preset'))    !== 'false',
  };
  let searchFilter = '';

  // Drag state — shared across all lists
  let dragSrc: { list: ScriptTree[]; idx: number } | null = null;

  // ── Root container (direct child of the host card) ─────────────────
  const container = document.createElement('div');
  root.appendChild(container);

  // Panel header: extension label + optional ST-import badge
  const panelHeader = document.createElement('div');
  panelHeader.className = 'vsh-panel-header';

  const panelTitle = document.createElement('span');
  panelTitle.className = 'vsh-panel-title';
  panelTitle.textContent = 'Vishrun · Scripts';

  const stBadge = document.createElement('span');
  stBadge.className = 'vsh-panel-badge';
  stBadge.textContent = 'ST import';
  stBadge.title = 'Character has scripts from a SillyTavern+JSLR export';
  stBadge.hidden = true;

  panelHeader.append(panelTitle, stBadge);

  // Three sections
  const panel = document.createElement('div');
  panel.className = 'vsh-scripts-panel';

  const globalSec = makeSection('Global Scripts', '🌐 Available in every chat', 'global');
  const charSec = makeSection('Character Scripts', getCharSubtitle(), 'character');
  const presetSec = makeSection('Preset Scripts', getPresetSubtitle(), 'preset');

  globalSec.addBtn.addEventListener('click', () => addScript('global'));
  globalSec.addFolderBtn.addEventListener('click', () => addFolder('global'));
  charSec.addBtn.addEventListener('click', () => addScript('character'));
  charSec.addFolderBtn.addEventListener('click', () => addFolder('character'));
  presetSec.addBtn.addEventListener('click', () => addScript('preset'));
  presetSec.addFolderBtn.addEventListener('click', () => addFolder('preset'));

  panel.append(globalSec.el, charSec.el, presetSec.el);

  // Search bar
  const searchBar = document.createElement('div');
  searchBar.className = 'vsh-search-bar';

  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.className = 'vsh-search-input';
  searchInput.placeholder = 'Search scripts...';
  searchInput.addEventListener('input', () => {
    searchFilter = searchInput.value.trim().toLowerCase();
    renderGlobal(); renderChar(); renderPreset();
  });

  const importBtn = document.createElement('button');
  importBtn.className = 'vsh-add-btn';
  importBtn.textContent = '⬆ Import';
  importBtn.title = 'Import scripts from a JSLR-format JSON file';
  importBtn.addEventListener('click', () => {
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.json';
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        const trees: ScriptTree[] = normalizeScriptTrees(
          Array.isArray(parsed) ? parsed : (parsed.scripts ?? [])
        );
        // ID conflict resolution — matching JSLR's useResolveIdConflict
        const allIds = new Set([
          ...globalScripts, ...charScripts, ...presetScripts,
        ].map(t => t.id));
        const deduped = trees.map(tree => {
          if (allIds.has(tree.id)) {
            return { ...tree, id: crypto.randomUUID() };
          }
          return tree;
        });
        // Default target: global
        const target: Target = 'global';
        getList(target).push(...deduped);
        saveTarget(target);
        refreshTarget(target);
      } catch (e) {
        console.error('[vishrun] import failed:', e);
      }
    });
    fileInput.click();
  });

  searchBar.append(searchInput, importBtn);
  container.append(panelHeader, searchBar, panel);

  // ── Section factory ────────────────────────────────────────────────
  function makeSection(title: string, subtitle: string, target: Target) {
    const el = document.createElement('div');
    el.className = 'vsh-section';
    if (!sectionEnabled[target]) el.classList.add('vsh-section-disabled');

    const header = document.createElement('div');
    header.className = 'vsh-section-header';

    const titleEl = document.createElement('span');
    titleEl.className = 'vsh-section-title';
    titleEl.textContent = title;

    const controls = document.createElement('div');
    controls.className = 'vsh-section-controls';

    // Section enable/disable toggle
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'vsh-section-toggle' + (sectionEnabled[target] ? ' active' : '');
    toggleBtn.textContent = sectionEnabled[target] ? '● On' : '○ Off';
    toggleBtn.title = 'Enable / disable this entire section';
    toggleBtn.addEventListener('click', () => {
      sectionEnabled[target] = !sectionEnabled[target];
      localStorage.setItem(LS_KEY(target), String(sectionEnabled[target]));
      toggleBtn.textContent = sectionEnabled[target] ? '● On' : '○ Off';
      toggleBtn.classList.toggle('active', sectionEnabled[target]);
      el.classList.toggle('vsh-section-disabled', !sectionEnabled[target]);
      onScriptsSaved?.();
    });

    const addFolderBtn = document.createElement('button');
    addFolderBtn.className = 'vsh-add-btn';
    addFolderBtn.textContent = '+ Folder';

    const addBtn = document.createElement('button');
    addBtn.className = 'vsh-add-btn';
    addBtn.textContent = '+ Script';

    controls.append(toggleBtn, addFolderBtn, addBtn);
    header.append(titleEl, controls);

    const subEl = document.createElement('p');
    subEl.className = 'vsh-section-sub';
    subEl.textContent = subtitle;

    const list = document.createElement('div');
    list.className = 'vsh-script-list';

    el.append(header, subEl, list);
    return { el, list, subEl, addBtn, addFolderBtn };
  }

  // ── Subtitle helpers ───────────────────────────────────────────────
  function getCharSubtitle(): string {
    const card = getActiveCard();
    if (card?.characterName) return `🎭 Bound to: ${card.characterName}`;
    if (currentCharId) return '🎭 Bound to current character';
    return '🎭 Load a character to view character scripts';
  }

  function getPresetSubtitle(): string {
    if (currentPresetName) return `⚙️ Bound to: ${currentPresetName}`;
    if (currentPresetId) return `⚙️ Bound to current loom`;
    return '⚙️ Load a loom to view preset scripts';
  }

  // ── Render ─────────────────────────────────────────────────────────
  function matchesSearch(name: string): boolean {
    return !searchFilter || name.toLowerCase().includes(searchFilter);
  }

  function renderList(listEl: HTMLElement, scripts: ScriptTree[], target: Target) {
    listEl.innerHTML = '';
    const visible = searchFilter
      ? scripts.filter(t =>
          t.type === 'folder'
            ? matchesSearch(t.name) || t.scripts.some(s => matchesSearch(s.name))
            : matchesSearch(t.name)
        )
      : scripts;
    if (visible.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'vsh-empty';
      empty.textContent = 'No scripts yet. Click "+ Script" to create one.';
      listEl.appendChild(empty);
      return;
    }
    for (const tree of visible) {
      listEl.appendChild(
        isFolder(tree)
          ? buildFolderItem(tree, target)
          : buildScriptItem(tree, scripts, target),
      );
    }
  }

  function renderGlobal() { renderList(globalSec.list, globalScripts, 'global'); }
  function renderChar() {
    charSec.subEl.textContent = getCharSubtitle();
    charSec.addBtn.disabled = !currentCharId;
    renderList(charSec.list, charScripts, 'character');
  }
  function renderPreset() {
    presetSec.subEl.textContent = getPresetSubtitle();
    presetSec.addBtn.disabled = !currentPresetId;
    renderList(presetSec.list, presetScripts, 'preset');
  }

  // ── Script item ────────────────────────────────────────────────────
  function buildScriptItem(
    script: Script,
    parentList: ScriptTree[],
    target: Target,
  ): HTMLElement {
    const item = document.createElement('div');
    item.className = 'vsh-script-item';

    const row = document.createElement('div');
    row.className = 'vsh-script-row';

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.className = 'vsh-enable-toggle';
    toggle.checked = script.enabled;
    toggle.title = 'Enable / disable';
    toggle.addEventListener('change', () => {
      script.enabled = toggle.checked;
      nameEl.classList.toggle('vsh-disabled', !script.enabled);
      saveTarget(target);
    });

    const nameEl = document.createElement('span');
    nameEl.className = 'vsh-script-name' + (script.enabled ? '' : ' vsh-disabled');
    nameEl.textContent = script.name || '(unnamed)';

    const editBtn = document.createElement('button');
    editBtn.className = 'vsh-btn';
    editBtn.textContent = 'Edit';

    const reloadBtn = document.createElement('button');
    reloadBtn.className = 'vsh-btn';
    reloadBtn.textContent = '↺';
    reloadBtn.title = 'Reload script (force restart without content change)';
    reloadBtn.addEventListener('click', () => {
      onReloadScript?.(script.id);
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'vsh-btn vsh-btn-delete';
    delBtn.textContent = '✕';
    delBtn.title = 'Delete script';
    delBtn.addEventListener('click', () => {
      const idx = parentList.indexOf(script);
      if (idx !== -1) parentList.splice(idx, 1);
      saveTarget(target);
      refreshTarget(target);
    });

    // Drag handle
    const dragHandle = document.createElement('span');
    dragHandle.className = 'vsh-drag-handle';
    dragHandle.textContent = '⠿';
    dragHandle.title = 'Drag to reorder or move into a folder';

    // Export button
    const exportBtn = document.createElement('button');
    exportBtn.className = 'vsh-btn';
    exportBtn.textContent = '⬇';
    exportBtn.title = 'Export this script as JSON';
    exportBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const json = JSON.stringify([script], null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${script.name || 'script'}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });

    row.append(dragHandle, toggle, nameEl, editBtn, reloadBtn, exportBtn, delBtn);

    // Native drag-and-drop for reorder / move-to-folder
    item.draggable = true;
    item.addEventListener('dragstart', (e) => {
      const idx = parentList.indexOf(script);
      if (idx === -1) return;
      dragSrc = { list: parentList, idx };
      item.classList.add('vsh-dragging');
      e.dataTransfer!.effectAllowed = 'move';
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('vsh-dragging');
      dragSrc = null;
    });
    item.addEventListener('dragover', (e) => {
      if (!dragSrc) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'move';
      item.classList.add('vsh-drag-over');
    });
    item.addEventListener('dragleave', () => item.classList.remove('vsh-drag-over'));
    item.addEventListener('drop', (e) => {
      e.preventDefault();
      item.classList.remove('vsh-drag-over');
      if (!dragSrc) return;
      const destIdx = parentList.indexOf(script);
      if (destIdx === -1) return;
      if (dragSrc.list === parentList && dragSrc.idx === destIdx) return;
      const [moved] = dragSrc.list.splice(dragSrc.idx, 1);
      parentList.splice(destIdx, 0, moved);
      dragSrc = null;
      saveTarget(target);
      refreshTarget(target);
    });

    const editor = buildEditor(script, target, (newName) => {
      nameEl.textContent = newName || '(unnamed)';
    });
    editor.hidden = true;

    editBtn.addEventListener('click', () => {
      editor.hidden = !editor.hidden;
      editBtn.textContent = editor.hidden ? 'Edit' : 'Done';
    });

    item.append(row, editor);
    return item;
  }

  function buildEditor(
    script: Script,
    target: Target,
    onNameChange: (name: string) => void,
  ): HTMLElement {
    const el = document.createElement('div');
    el.className = 'vsh-editor';

    // Tab bar
    const tabBar = document.createElement('div');
    tabBar.className = 'vsh-editor-tabs';
    const tabCode = document.createElement('button');
    tabCode.className = 'vsh-editor-tab vsh-tab-active';
    tabCode.textContent = 'Code';
    const tabData = document.createElement('button');
    tabData.className = 'vsh-editor-tab';
    tabData.textContent = 'Data';
    const tabSettings = document.createElement('button');
    tabSettings.className = 'vsh-editor-tab';
    tabSettings.textContent = 'Settings';
    tabBar.append(tabCode, tabData, tabSettings);

    // Tab panels
    const panelCode = document.createElement('div');
    panelCode.className = 'vsh-editor-tabpanel';
    const panelData = document.createElement('div');
    panelData.className = 'vsh-editor-tabpanel';
    panelData.hidden = true;
    const panelSettings = document.createElement('div');
    panelSettings.className = 'vsh-editor-tabpanel';
    panelSettings.hidden = true;

    const switchTab = (active: HTMLButtonElement, panel: HTMLElement) => {
      [tabCode, tabData, tabSettings].forEach(t => t.classList.remove('vsh-tab-active'));
      [panelCode, panelData, panelSettings].forEach(p => { p.hidden = true; });
      active.classList.add('vsh-tab-active');
      panel.hidden = false;
    };
    tabCode.addEventListener('click', () => switchTab(tabCode, panelCode));
    tabData.addEventListener('click', () => switchTab(tabData, panelData));
    tabSettings.addEventListener('click', () => switchTab(tabSettings, panelSettings));

    // ── Code tab ──────────────────────────────────────────────────
    const nameField = makeField('Name');
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'vsh-input';
    nameInput.value = script.name;
    nameInput.placeholder = 'Script name...';
    nameInput.addEventListener('input', () => {
      script.name = nameInput.value;
      onNameChange(nameInput.value);
      debouncedSave(target);
    });
    nameField.appendChild(nameInput);

    const contentField = makeField('Script (JavaScript)');
    const contentArea = document.createElement('textarea');
    contentArea.className = 'vsh-textarea';
    contentArea.value = script.content;
    contentArea.placeholder =
      '// JavaScript runs in an isolated iframe.\n// The tavernHelper API is available via window.tavernHelper.';
    contentArea.addEventListener('input', () => {
      script.content = contentArea.value;
      debouncedSave(target);
    });
    contentField.appendChild(contentArea);
    panelCode.append(nameField, contentField);

    // ── Data tab ──────────────────────────────────────────────────
    const dataField = makeField('script.data (JSON)');
    const dataArea = document.createElement('textarea');
    dataArea.className = 'vsh-textarea';
    dataArea.style.fontFamily = 'monospace';
    dataArea.style.minHeight = '100px';
    try { dataArea.value = JSON.stringify(script.data, null, 2); } catch { dataArea.value = '{}'; }
    dataArea.placeholder = '{}';
    dataArea.addEventListener('input', () => {
      try {
        script.data = JSON.parse(dataArea.value);
        dataArea.style.borderColor = '';
        debouncedSave(target);
      } catch {
        dataArea.style.borderColor = '#c0392b';
      }
    });
    dataField.appendChild(dataArea);
    panelData.append(dataField);

    // ── Settings tab ──────────────────────────────────────────────
    const infoField = makeField('Description');
    const infoInput = document.createElement('input');
    infoInput.type = 'text';
    infoInput.className = 'vsh-input';
    infoInput.value = script.info;
    infoInput.placeholder = 'What does this script do?';
    infoInput.addEventListener('input', () => {
      script.info = infoInput.value;
      debouncedSave(target);
    });
    infoField.appendChild(infoInput);

    const exportField = makeField('Export with');
    const exportRow = document.createElement('div');
    exportRow.className = 'vsh-checkbox-row';

    const mkCheck = (label: string, checked: boolean, onChange: (v: boolean) => void) => {
      const lbl = document.createElement('label');
      lbl.className = 'vsh-checkbox-label';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = checked;
      cb.addEventListener('change', () => { onChange(cb.checked); debouncedSave(target); });
      lbl.append(cb, document.createTextNode(label));
      return lbl;
    };
    exportRow.append(
      mkCheck('Data', script.export_with.data,   v => { script.export_with.data   = v; }),
      mkCheck('Buttons', script.export_with.button, v => { script.export_with.button = v; }),
    );
    exportField.appendChild(exportRow);
    panelSettings.append(infoField, exportField);

    el.append(tabBar, panelCode, panelData, panelSettings);
    return el;
  }

  function makeField(label: string): HTMLElement {
    const field = document.createElement('div');
    field.className = 'vsh-field';
    const lbl = document.createElement('label');
    lbl.className = 'vsh-field-label';
    lbl.textContent = label;
    field.appendChild(lbl);
    return field;
  }

  // ── Folder item ────────────────────────────────────────────────────
  function buildFolderItem(folder: ScriptFolder, target: Target): HTMLElement {
    const item = document.createElement('div');
    item.className = 'vsh-folder-item';

    const header = document.createElement('div');
    header.className = 'vsh-folder-header';

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.className = 'vsh-enable-toggle';
    toggle.checked = folder.enabled;
    toggle.addEventListener('change', () => {
      folder.enabled = toggle.checked;
      saveTarget(target);
    });

    const dragHandle = document.createElement('span');
    dragHandle.className = 'vsh-drag-handle';
    dragHandle.textContent = '⠿';

    const nameEl = document.createElement('span');
    nameEl.className = 'vsh-script-name';
    nameEl.textContent = `📁 ${folder.name || '(unnamed folder)'}`;

    // Export folder
    const exportBtn = document.createElement('button');
    exportBtn.className = 'vsh-btn';
    exportBtn.textContent = '⬇';
    exportBtn.title = 'Export folder as JSON';
    exportBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const json = JSON.stringify([folder], null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${folder.name || 'folder'}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });

    const delFolderBtn = document.createElement('button');
    delFolderBtn.className = 'vsh-btn vsh-btn-delete';
    delFolderBtn.textContent = '✕';
    delFolderBtn.title = 'Delete folder';
    delFolderBtn.addEventListener('click', () => {
      const list = getList(target);
      const idx = list.indexOf(folder);
      if (idx !== -1) list.splice(idx, 1);
      saveTarget(target);
      refreshTarget(target);
    });

    header.append(dragHandle, toggle, nameEl, exportBtn, delFolderBtn);

    const inner = document.createElement('div');
    inner.className = 'vsh-folder-scripts';

    if (folder.scripts.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'vsh-empty';
      empty.textContent = 'Drag scripts here or click + Script';
      inner.appendChild(empty);
    } else {
      for (const script of folder.scripts) {
        inner.appendChild(buildScriptItem(script, folder.scripts, target));
      }
    }

    // Folder is a drop target — scripts dragged onto it are moved inside
    inner.addEventListener('dragover', (e) => {
      if (!dragSrc) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer!.dropEffect = 'move';
      inner.classList.add('vsh-drag-over-folder');
    });
    inner.addEventListener('dragleave', () => inner.classList.remove('vsh-drag-over-folder'));
    inner.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      inner.classList.remove('vsh-drag-over-folder');
      if (!dragSrc) return;
      const [moved] = dragSrc.list.splice(dragSrc.idx, 1);
      if (moved.type === 'folder') return; // can't nest folders
      folder.scripts.push(moved as Script);
      dragSrc = null;
      saveTarget(target);
      refreshTarget(target);
    });

    // Folder item itself is draggable for reordering
    item.draggable = true;
    item.addEventListener('dragstart', (e) => {
      const list = getList(target);
      const idx = list.indexOf(folder);
      if (idx === -1) return;
      dragSrc = { list, idx };
      item.classList.add('vsh-dragging');
      e.dataTransfer!.effectAllowed = 'move';
      e.stopPropagation();
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('vsh-dragging');
      dragSrc = null;
    });

    item.append(header, inner);
    return item;
  }

  // ── Add / save / refresh ───────────────────────────────────────────
  function addScript(target: Target) {
    if (target === 'character' && !currentCharId) return;
    getList(target).push(makeScript({ name: 'New Script' }));
    saveTarget(target);
    refreshTarget(target);
  }

  function addFolder(target: Target) {
    if (target === 'character' && !currentCharId) return;
    const folder: ScriptFolder = {
      type: 'folder',
      enabled: true,
      name: 'New Folder',
      id: crypto.randomUUID(),
      icon: 'fa-solid fa-folder',
      color: '#888888',
      scripts: [],
    };
    getList(target).push(folder);
    saveTarget(target);
    refreshTarget(target);
  }

  function getList(target: Target): ScriptTree[] {
    if (target === 'global') return globalScripts;
    if (target === 'character') return charScripts;
    return presetScripts;
  }

  function debouncedSave(target: Target) {
    clearTimeout(saveTimers.get(target));
    saveTimers.set(target, setTimeout(() => saveTarget(target), 600));
  }

  function saveTarget(target: Target) {
    clearTimeout(saveTimers.get(target));
    if (target === 'global') {
      storage.saveGlobal(globalScripts).then(() => onScriptsSaved?.()).catch(console.error);
    } else if (target === 'character' && currentCharId) {
      storage.saveCharacter(currentCharId, charScripts).then(() => onScriptsSaved?.()).catch(console.error);
    } else if (target === 'preset') {
      storage.savePreset(currentPresetId, presetScripts).then(() => onScriptsSaved?.()).catch(console.error);
    }
  }

  function refreshTarget(target: Target) {
    if (target === 'global') renderGlobal();
    else if (target === 'character') renderChar();
    else renderPreset();
  }

  // ── Initial load ───────────────────────────────────────────────────
  async function loadAll() {
    const chat = ctx.getActiveChat();
    currentCharId = chat.characterId ?? null;

    const [global, preset] = await Promise.all([
      storage.loadGlobal(),
      storage.loadPreset(currentPresetId),
    ]);
    globalScripts = global;
    presetScripts = preset;
    renderGlobal();
    renderPreset();

    if (currentCharId) {
      charScripts = await storage.loadCharacter(currentCharId);
    }
    renderChar();
  }

  loadAll().catch(console.error);

  // ── Public interface ───────────────────────────────────────────────
  return {
    onCharacterChanged(characterId: string | null) {
      currentCharId = characterId;
      clearTimeout(saveTimers.get('character'));

      if (!characterId) {
        charScripts = [];
        renderChar();
        return;
      }

      charScripts = [];
      renderChar();

      storage
        .loadCharacter(characterId)
        .then((scripts) => {
          if (currentCharId === characterId) {
            charScripts = scripts;
            renderChar();
          }
        })
        .catch(console.error);
    },

    onPresetChanged(presetId: string | null) {
      currentPresetId = presetId;
      clearTimeout(saveTimers.get('preset'));
      if (!presetId) {
        currentPresetName = null;
        presetScripts = [];
        renderPreset();
        return;
      }
      presetScripts = [];
      renderPreset();
      Promise.all([
        storage.loadPreset(presetId),
        getPresetName(presetId),
      ]).then(([scripts, name]) => {
        if (currentPresetId === presetId) {
          presetScripts = scripts;
          currentPresetName = name;
          renderPreset();
        }
      }).catch(console.error);
    },

    setHasTavernHelperScripts(has: boolean) {
      stBadge.hidden = !has;
    },

    destroy() {
      storage.destroy();
      removeStyle();
      container.remove();
      for (const t of saveTimers.values()) clearTimeout(t);
      saveTimers.clear();
    },
  };
}
