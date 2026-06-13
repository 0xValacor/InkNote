import { CanvasEngine } from './canvas-engine.js';
import { EmbedManager } from './embeds.js';
import { ColorPicker } from './color-picker.js';
import * as api from './api.js';

// ─── State ────────────────────────────────────────────────────────────────────

let engine, embedMgr, colorPicker;
let notebooks = [], pages = [];
let activeNotebookId = null, activePageId = null;
let saveTimer = null;
let saveStatus = 'saved'; // 'saved' | 'saving' | 'unsaved'

const PRESET_COLORS = [
  '#ffffff', '#c0c0c0', '#808080', '#ff6b6b', '#ff9f43',
  '#ffd700', '#51cf66', '#339af0', '#cc5de8', '#f06595'
];

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  const container = document.getElementById('canvas-container');
  const committed = document.getElementById('canvas-committed');
  const active = document.getElementById('canvas-active');
  const embedsLayer = document.getElementById('embeds-layer');

  engine = new CanvasEngine(container, committed, active, embedsLayer);
  embedMgr = new EmbedManager(engine, embedsLayer);

  engine.onChange = () => scheduleSave();
  engine.onToolChange = (tool) => {
    updateToolbar(tool);
    embedMgr.setInteractive(tool === 'pan');
  };

  // Color picker
  const cpContainer = document.getElementById('color-picker-panel');
  colorPicker = new ColorPicker(cpContainer, (hex, alpha) => {
    engine.color = hex;
    engine.opacity = alpha;
    document.getElementById('color-swatch').style.background = hex;
    updatePresets();
  });
  colorPicker.setColor('#ffffff', 1.0);
  engine.color = '#ffffff';

  // Preset colors
  buildPresets();

  // Toolbar events
  setupToolbar();

  // Sidebar
  await loadNotebooks();

  // Paste handler — read ALL clipboard data synchronously before any await
  document.addEventListener('paste', async (e) => {
    if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;

    // Binary image: items (Chrome/Firefox 87+) or files (Linux fallback)
    const imageItem = [...(e.clipboardData?.items ?? [])].find(i => i.type.startsWith('image/'));
    const binaryFile = imageItem?.getAsFile()
      ?? [...(e.clipboardData?.files ?? [])].find(f => f.type.startsWith('image/'))
      ?? null;

    // Firefox "Copy Image" may embed the image as a data URL inside text/html
    const htmlSrc = binaryFile ? null
      : (e.clipboardData?.getData('text/html') ?? '').match(/<img[^>]+\bsrc="(data:image\/[^"]+)"/i)?.[1] ?? null;

    const text = (binaryFile || htmlSrc) ? '' : (e.clipboardData?.getData('text/plain') ?? '');

    // Handle asynchronously
    if (binaryFile) {
      e.preventDefault();
      try { await embedMgr.handleImagePaste(binaryFile); } catch (err) { console.error('Image paste failed:', err); }
    } else if (htmlSrc) {
      e.preventDefault();
      try {
        const blob = await (await fetch(htmlSrc)).blob();
        await embedMgr.handleImagePaste(new File([blob], 'clipboard', { type: blob.type }));
      } catch (err) { console.error('Image paste (HTML) failed:', err); }
    } else if (text) {
      await embedMgr.handlePaste(text);
    }
  });

  // Keyboard: zoom shortcuts
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === '+' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); engine.zoomAt(1.15, window.innerWidth / 2, window.innerHeight / 2); }
    if (e.key === '-' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); engine.zoomAt(0.87, window.innerWidth / 2, window.innerHeight / 2); }
  });

  // Close panels on outside click/tap
  document.addEventListener('pointerdown', e => {
    if (!e.target.closest('#color-picker-popup') && !e.target.closest('#color-swatch-btn')) {
      document.getElementById('color-picker-popup').classList.remove('visible');
    }
    if (!e.target.closest('#brush-popup') && !e.target.closest('#brush-btn')) {
      document.getElementById('brush-popup').classList.remove('visible');
    }
  });

  updateUndoRedo();
}

// ─── Toolbar ──────────────────────────────────────────────────────────────────

function setupToolbar() {
  // Tool buttons
  document.getElementById('btn-pen').addEventListener('click', () => { engine.penType = 'pen'; engine.setTool('pen'); });
  document.getElementById('btn-pencil').addEventListener('click', () => { engine.penType = 'pencil'; engine.setTool('pen'); });
  document.getElementById('btn-brush').addEventListener('click', () => { engine.penType = 'brush'; engine.setTool('pen'); });
  document.getElementById('btn-marker').addEventListener('click', () => { engine.penType = 'marker'; engine.setTool('pen'); });
  document.getElementById('btn-eraser').addEventListener('click', () => {
    if (engine.tool === 'eraser') engine.setTool(engine.prevTool || 'pen');
    else engine.toggleEraser();
  });
  document.getElementById('btn-pan').addEventListener('click', () => engine.setTool('pan'));

  document.getElementById('btn-text').addEventListener('click', () => _insertEmbed({
    type: 'text', content: '', width: 240
  }));
  document.getElementById('btn-sticky').addEventListener('click', () => _insertEmbed({
    type: 'sticky', content: '', color: '#fef08a', width: 200, height: 200
  }));
  document.getElementById('btn-code').addEventListener('click', () => _insertEmbed({
    type: 'code', content: '', language: 'auto', width: 460, height: 280
  }));

  document.getElementById('btn-undo').addEventListener('click', () => { engine.undo(); updateUndoRedo(); });
  document.getElementById('btn-redo').addEventListener('click', () => { engine.redo(); updateUndoRedo(); });

  // Color swatch opens picker
  document.getElementById('color-swatch-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    document.getElementById('color-picker-popup').classList.toggle('visible');
  });

  // Brush size popup
  document.getElementById('brush-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const popup = document.getElementById('brush-popup');
    popup.classList.toggle('visible');
    document.getElementById('size-slider').value = engine.size;
    document.getElementById('size-val').textContent = engine.size;
    document.getElementById('eraser-slider').value = engine.eraserSize ?? 24;
    document.getElementById('eraser-val').textContent = engine.eraserSize ?? 24;
  });

  document.getElementById('size-slider').addEventListener('input', e => {
    engine.size = parseInt(e.target.value);
    document.getElementById('size-val').textContent = engine.size;
  });
  document.getElementById('eraser-slider').addEventListener('input', e => {
    engine.eraserSize = parseInt(e.target.value);
    document.getElementById('eraser-val').textContent = engine.eraserSize;
  });

  // Toggle sidebar
  document.getElementById('btn-sidebar').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('collapsed');
  });
  document.getElementById('sidebar').addEventListener('transitionend', () => {
    engine._resize();
  });

  // Zoom controls
  document.getElementById('btn-zoom-in').addEventListener('click', () => engine.zoomAt(1.2, window.innerWidth / 2, window.innerHeight / 2));
  document.getElementById('btn-zoom-out').addEventListener('click', () => engine.zoomAt(0.83, window.innerWidth / 2, window.innerHeight / 2));
  document.getElementById('btn-zoom-reset').addEventListener('click', () => engine.resetView());
}

function updateToolbar(tool) {
  const toolBtns = ['btn-pen', 'btn-pencil', 'btn-brush', 'btn-marker', 'btn-eraser', 'btn-pan'];
  toolBtns.forEach(id => document.getElementById(id)?.classList.remove('active'));

  if (tool === 'eraser') {
    document.getElementById('btn-eraser')?.classList.add('active');
  } else if (tool === 'pan') {
    document.getElementById('btn-pan')?.classList.add('active');
  } else {
    const map = { pen: 'btn-pen', pencil: 'btn-pencil', brush: 'btn-brush', marker: 'btn-marker' };
    document.getElementById(map[engine.penType] ?? 'btn-pen')?.classList.add('active');
  }
  updateUndoRedo();
}

function updateUndoRedo() {
  document.getElementById('btn-undo').disabled = !engine?.canUndo();
  document.getElementById('btn-redo').disabled = !engine?.canRedo();
}

function buildPresets() {
  const container = document.getElementById('color-presets');
  container.innerHTML = '';
  PRESET_COLORS.forEach(c => {
    const el = document.createElement('button');
    el.className = 'preset-swatch';
    el.style.background = c;
    el.title = c;
    el.addEventListener('click', () => {
      colorPicker.setColor(c, engine.opacity);
      engine.color = c;
      document.getElementById('color-swatch').style.background = c;
    });
    container.appendChild(el);
  });
}

function updatePresets() { /* presets don't need to change */ }

// ─── Sidebar / Notebooks ──────────────────────────────────────────────────────

async function loadNotebooks() {
  notebooks = await api.getNotebooks();
  renderSidebar();

  if (notebooks.length === 0) {
    const nb = await api.createNotebook('My Notebook');
    notebooks = [nb];
    renderSidebar();
  }

  if (notebooks.length > 0) {
    await selectNotebook(notebooks[0].id);
  }
}

async function selectNotebook(nbId) {
  activeNotebookId = nbId;
  pages = await api.getPages(nbId);
  renderSidebar();

  if (pages.length > 0) {
    await selectPage(pages[0].id);
  }
}

async function selectPage(pageId) {
  if (activePageId === pageId) return;
  await saveCurrentPage();
  activePageId = pageId;

  const result = await api.getDrawing(pageId);
  if (result.data) {
    try {
      const data = await api.decompressData(result.data);
      engine.loadData(data);
    } catch {
      engine.loadData({ strokes: [], embeds: [] });
    }
  } else {
    engine.loadData({ strokes: [], embeds: [] });
  }

  renderSidebar();
  setSaveStatus('saved');
}

function renderSidebar() {
  const nbList = document.getElementById('notebook-list');
  nbList.innerHTML = '';

  for (const nb of notebooks) {
    const nbEl = document.createElement('div');
    nbEl.className = 'notebook-item' + (nb.id === activeNotebookId ? ' active' : '');

    const header = document.createElement('div');
    header.className = 'nb-header';
    header.innerHTML = `<span class="nb-icon">▸</span><span class="nb-name">${esc(nb.name)}</span>`;
    header.addEventListener('click', () => selectNotebook(nb.id));
    header.addEventListener('dblclick', () => inlineRename(header.querySelector('.nb-name'), nb.name, async (v) => {
      await api.renameNotebook(nb.id, v);
      nb.name = v;
    }));

    const delBtn = document.createElement('button');
    delBtn.className = 'nb-del';
    delBtn.title = 'Delete notebook';
    delBtn.innerHTML = '&times;';
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete "${nb.name}"?`)) return;
      await api.deleteNotebook(nb.id);
      await loadNotebooks();
    });
    header.appendChild(delBtn);
    nbEl.appendChild(header);

    if (nb.id === activeNotebookId) {
      const pageList = document.createElement('div');
      pageList.className = 'page-list';

      for (const pg of pages) {
        const pgEl = document.createElement('div');
        pgEl.className = 'page-item' + (pg.id === activePageId ? ' active' : '');
        pgEl.innerHTML = `<span class="page-icon">·</span><span class="page-name">${esc(pg.title)}</span>`;
        pgEl.addEventListener('click', () => selectPage(pg.id));
        pgEl.addEventListener('dblclick', () => inlineRename(pgEl.querySelector('.page-name'), pg.title, async (v) => {
          await api.renamePage(pg.id, v);
          pg.title = v;
        }));

        const pgDel = document.createElement('button');
        pgDel.className = 'nb-del';
        pgDel.title = 'Delete page';
        pgDel.innerHTML = '&times;';
        pgDel.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (pages.length <= 1) { alert('Cannot delete the last page.'); return; }
          if (!confirm(`Delete "${pg.title}"?`)) return;
          await api.deletePage(pg.id);
          pages = pages.filter(p => p.id !== pg.id);
          if (activePageId === pg.id) {
            activePageId = null;
            await selectPage(pages[0].id);
          }
          renderSidebar();
        });
        pgEl.appendChild(pgDel);
        pageList.appendChild(pgEl);
      }

      const addBtn = document.createElement('button');
      addBtn.className = 'add-page-btn';
      addBtn.textContent = 'Add page';
      addBtn.addEventListener('click', async () => {
        const pg = await api.createPage(activeNotebookId, `Page ${pages.length + 1}`);
        pages.push(pg);
        await selectPage(pg.id);
      });
      pageList.appendChild(addBtn);
      nbEl.appendChild(pageList);
    }

    nbList.appendChild(nbEl);
  }

  const addNbBtn = document.getElementById('add-notebook-btn');
  addNbBtn.onclick = async () => {
    const name = prompt('Notebook name:', 'New Notebook');
    if (!name) return;
    const nb = await api.createNotebook(name);
    notebooks.unshift(nb);
    await selectNotebook(nb.id);
  };
}

function inlineRename(el, current, onSave) {
  const input = document.createElement('input');
  input.className = 'inline-rename';
  input.value = current;
  el.replaceWith(input);
  input.focus();
  input.select();
  const done = async () => {
    const val = input.value.trim() || current;
    await onSave(val);
    input.replaceWith(el);
    el.textContent = val;
  };
  input.addEventListener('blur', done);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); if (e.key === 'Escape') { input.value = current; input.blur(); } });
}

// ─── Save ─────────────────────────────────────────────────────────────────────

function scheduleSave() {
  setSaveStatus('unsaved');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveCurrentPage(), 2000);
  updateUndoRedo();
}

async function saveCurrentPage() {
  if (!activePageId) return;
  try {
    setSaveStatus('saving');
    const data = engine.getData();
    const compressed = await api.compressData(data);
    await api.saveDrawing(activePageId, compressed);
    setSaveStatus('saved');
  } catch (e) {
    console.error('Save failed', e);
    setSaveStatus('error');
  }
}

function setSaveStatus(status) {
  saveStatus = status;
  const el = document.getElementById('save-status');
  if (!el) return;
  el.className = 'save-status ' + status;
  el.textContent = { saved: 'Saved', saving: 'Saving...', unsaved: 'Unsaved', error: 'Save error' }[status] ?? status;
}

// Before unload, save
window.addEventListener('beforeunload', (e) => {
  if (saveStatus === 'unsaved') {
    saveCurrentPage();
    e.preventDefault();
  }
});

function esc(s) { return s?.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') ?? ''; }

// ─── Insert embeds ────────────────────────────────────────────────────────────

function _insertEmbed(fields) {
  const rect = document.getElementById('canvas-container').getBoundingClientRect();
  const center = engine.screenToCanvas(rect.width / 2, rect.height / 2);
  const embed = {
    id: api.generateId(),
    x: center.x - (fields.width  || 0) / 2,
    y: center.y - (fields.height || 0) / 2,
    ...fields
  };
  engine.setTool('pan');
  embedMgr.focusPendingId = embed.id;
  engine.addEmbed(embed);
}

// ─── Start ────────────────────────────────────────────────────────────────────
init().catch(console.error);
