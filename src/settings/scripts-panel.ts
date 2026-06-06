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
import { ScriptStorageClient } from './script-storage';
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
`;

// ── Types ────────────────────────────────────────────────────────────────────

type Target = 'global' | 'character' | 'preset';

export interface ScriptsPanel {
  onCharacterChanged(characterId: string | null): void;
  /** Called after fetchCharacter to show a badge when the card has JSLR scripts. */
  setHasTavernHelperScripts(has: boolean): void;
  destroy(): void;
}

// ── Entry point ──────────────────────────────────────────────────────────────

export function createScriptsPanel(
  root: HTMLElement,
  ctx: SpindleFrontendContext,
  onScriptsSaved?: () => void,
): ScriptsPanel {
  const storage = new ScriptStorageClient();
  const removeStyle = ctx.dom.addStyle(CSS);

  // ── State ──────────────────────────────────────────────────────────
  let globalScripts: ScriptTree[] = [];
  let charScripts: ScriptTree[] = [];
  let presetScripts: ScriptTree[] = [];
  let currentCharId: string | null = null;
  const saveTimers = new Map<Target, ReturnType<typeof setTimeout>>();

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

  const globalSec = makeSection('Global Scripts', '🌐 Available in every chat');
  const charSec = makeSection('Character Scripts', getCharSubtitle());
  const presetSec = makeSection('Preset Scripts', '⚙️ Bound to the current preset');

  globalSec.addBtn.addEventListener('click', () => addScript('global'));
  charSec.addBtn.addEventListener('click', () => addScript('character'));
  presetSec.addBtn.addEventListener('click', () => addScript('preset'));

  panel.append(globalSec.el, charSec.el, presetSec.el);
  container.append(panelHeader, panel);

  // ── Section factory ────────────────────────────────────────────────
  function makeSection(title: string, subtitle: string) {
    const el = document.createElement('div');
    el.className = 'vsh-section';

    const header = document.createElement('div');
    header.className = 'vsh-section-header';

    const titleEl = document.createElement('span');
    titleEl.className = 'vsh-section-title';
    titleEl.textContent = title;

    const addBtn = document.createElement('button');
    addBtn.className = 'vsh-add-btn';
    addBtn.textContent = '+ Add Script';

    header.append(titleEl, addBtn);

    const subEl = document.createElement('p');
    subEl.className = 'vsh-section-sub';
    subEl.textContent = subtitle;

    const list = document.createElement('div');
    list.className = 'vsh-script-list';

    el.append(header, subEl, list);
    return { el, list, subEl, addBtn };
  }

  // ── Subtitle helpers ───────────────────────────────────────────────
  function getCharSubtitle(): string {
    const card = getActiveCard();
    if (card?.characterName) return `🎭 Bound to: ${card.characterName}`;
    if (currentCharId) return '🎭 Bound to current character';
    return '🎭 Load a character to view character scripts';
  }

  // ── Render ─────────────────────────────────────────────────────────
  function renderList(listEl: HTMLElement, scripts: ScriptTree[], target: Target) {
    listEl.innerHTML = '';
    if (scripts.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'vsh-empty';
      empty.textContent = 'No scripts yet. Click "+ Add Script" to create one.';
      listEl.appendChild(empty);
      return;
    }
    for (const tree of scripts) {
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
  function renderPreset() { renderList(presetSec.list, presetScripts, 'preset'); }

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

    row.append(toggle, nameEl, editBtn, delBtn);

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

    const infoField = makeField('Description (optional)');
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

    el.append(nameField, contentField, infoField);
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

    const nameEl = document.createElement('span');
    nameEl.className = 'vsh-script-name';
    nameEl.textContent = `📁 ${folder.name || '(unnamed folder)'}`;

    header.append(toggle, nameEl);

    const inner = document.createElement('div');
    inner.className = 'vsh-folder-scripts';

    if (folder.scripts.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'vsh-empty';
      empty.textContent = 'Empty folder';
      inner.appendChild(empty);
    } else {
      for (const script of folder.scripts) {
        inner.appendChild(buildScriptItem(script, folder.scripts, target));
      }
    }

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
      storage.savePreset(presetScripts).then(() => onScriptsSaved?.()).catch(console.error);
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
      storage.loadPreset(),
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
