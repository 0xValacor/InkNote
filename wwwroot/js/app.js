import { CanvasEngine } from './canvas-engine.js';
import { EmbedManager } from './embeds.js';
import { ColorPicker } from './color-picker.js';
import * as api from './api.js';
import * as invApi from './osint-api.js';
import { MindMap } from './mindmap.js';

// ─── State ────────────────────────────────────────────────────────────────────

let engine, embedMgr, colorPicker, mindMap;
let notebooks = [], pages = [];
let investigations = [];
let activeNotebookId = null, activePageId = null;
let activeInvestigationId = null;
let isDirty = false;
const SAVE_INTERVAL_MS = 2 * 60 * 1000;
let saveStatus = 'saved';
let isSwitching = false;
let pendingSwitch = null;

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

  engine.onChange = () => markDirty();
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

  buildPresets();
  setupToolbar();

  setInterval(() => { if (isDirty) saveCurrentPage(); }, SAVE_INTERVAL_MS);

  // Mindmap
  mindMap = new MindMap(
    document.getElementById('mindmap-graph'),
    document.getElementById('mindmap-detail'),
    document.getElementById('mindmap-osint-panel'),
    document.getElementById('mindmap-context-menu')
  );
  mindMap.onGraphChange = () => markDirty();
  setupMindmapToolbar();
  setupSplitter();

  // Load both sections
  await Promise.all([loadInvestigations(), loadNotebooks()]);

  // Paste handler
  document.addEventListener('paste', async (e) => {
    if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;

    const imageItem = [...(e.clipboardData?.items ?? [])].find(i => i.type.startsWith('image/'));
    const binaryFile = imageItem?.getAsFile()
      ?? [...(e.clipboardData?.files ?? [])].find(f => f.type.startsWith('image/'))
      ?? null;

    const htmlSrc = binaryFile ? null
      : (e.clipboardData?.getData('text/html') ?? '').match(/<img[^>]+\bsrc="(data:image\/[^"]+)"/i)?.[1] ?? null;

    const text = (binaryFile || htmlSrc) ? '' : (e.clipboardData?.getData('text/plain') ?? '');

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

  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 's' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveCurrentPage(); }
    if (e.key === '+' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); engine.zoomAt(1.15, window.innerWidth / 2, window.innerHeight / 2); }
    if (e.key === '-' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); engine.zoomAt(0.87, window.innerWidth / 2, window.innerHeight / 2); }
  });

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
  document.getElementById('btn-pen').addEventListener('click', () => { engine.penType = 'pen'; engine.setTool('pen'); });
  document.getElementById('btn-pencil').addEventListener('click', () => { engine.penType = 'pencil'; engine.setTool('pen'); });
  document.getElementById('btn-brush').addEventListener('click', () => { engine.penType = 'brush'; engine.setTool('pen'); });
  document.getElementById('btn-marker').addEventListener('click', () => { engine.penType = 'marker'; engine.setTool('pen'); });
  document.getElementById('btn-eraser').addEventListener('click', () => {
    if (engine.tool === 'eraser') engine.setTool(engine.prevTool || 'pen');
    else engine.toggleEraser();
  });
  document.getElementById('btn-pan').addEventListener('click', () => engine.setTool('pan'));

  document.getElementById('btn-text').addEventListener('click', () => _insertEmbed({ type: 'text', content: '', width: 240 }));
  document.getElementById('btn-sticky').addEventListener('click', () => _insertEmbed({ type: 'sticky', content: '', color: '#fef08a', width: 200, height: 200 }));
  document.getElementById('btn-code').addEventListener('click', () => _insertEmbed({ type: 'code', content: '', language: 'auto', width: 460, height: 280 }));

  document.getElementById('btn-undo').addEventListener('click', () => { engine.undo(); updateUndoRedo(); });
  document.getElementById('btn-redo').addEventListener('click', () => { engine.redo(); updateUndoRedo(); });
  document.getElementById('btn-save').addEventListener('click', () => saveCurrentPage());

  document.getElementById('color-swatch-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    document.getElementById('color-picker-popup').classList.toggle('visible');
  });

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

  document.getElementById('btn-sidebar').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('collapsed');
  });
  document.getElementById('sidebar').addEventListener('transitionend', () => {
    engine._resize();
  });

  document.getElementById('btn-zoom-in').addEventListener('click', () => engine.zoomAt(1.2, window.innerWidth / 2, window.innerHeight / 2));
  document.getElementById('btn-zoom-out').addEventListener('click', () => engine.zoomAt(0.83, window.innerWidth / 2, window.innerHeight / 2));
  document.getElementById('btn-zoom-reset').addEventListener('click', () => engine.resetView());
}

function setupMindmapToolbar() {
  document.querySelectorAll('.mm-add-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!activeInvestigationId) return;
      const type = btn.dataset.type;
      const label = prompt(`${type.charAt(0).toUpperCase() + type.slice(1)} value:`);
      if (!label?.trim()) return;
      const entity = await invApi.addEntity(activeInvestigationId, type, label.trim());
      mindMap.addEntity(entity);
      markDirty();
    });
  });

  document.getElementById('mm-btn-layout').addEventListener('click', () => mindMap.runLayout());
  document.getElementById('mm-btn-fit').addEventListener('click', () => mindMap.fit());
}

function setupSplitter() {
  const splitter = document.getElementById('mindmap-splitter');
  const mindmapPanel = document.getElementById('mindmap-panel');
  const canvasContainer = document.getElementById('canvas-container');
  let dragging = false, startX, startMW;

  splitter.addEventListener('pointerdown', e => {
    dragging = true;
    startX = e.clientX;
    startMW = mindmapPanel.offsetWidth;
    splitter.classList.add('dragging');
    splitter.setPointerCapture(e.pointerId);
  });
  splitter.addEventListener('pointermove', e => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const newW = Math.max(260, Math.min(startMW + dx, window.innerWidth - 300));
    mindmapPanel.style.flex = 'none';
    mindmapPanel.style.width = newW + 'px';
    engine._resize();
  });
  splitter.addEventListener('pointerup', () => { dragging = false; splitter.classList.remove('dragging'); });
  splitter.addEventListener('pointercancel', () => { dragging = false; splitter.classList.remove('dragging'); });
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

function updatePresets() { }

// ─── Investigations sidebar ────────────────────────────────────────────────────

async function loadInvestigations() {
  investigations = await invApi.getInvestigations();
  renderInvestigationList();
}

function renderInvestigationList() {
  const list = document.getElementById('investigation-list');
  list.innerHTML = '';

  for (const inv of investigations) {
    const el = document.createElement('div');
    el.className = 'inv-item' + (inv.id === activeInvestigationId ? ' active' : '');

    el.innerHTML = `<span class="inv-icon">🔍</span><span class="inv-name">${esc(inv.name)}</span>`;

    const del = document.createElement('button');
    del.className = 'inv-del';
    del.title = 'Delete investigation';
    del.innerHTML = '&times;';
    del.addEventListener('click', async e => {
      e.stopPropagation();
      if (!confirm(`Delete investigation "${inv.name}"?`)) return;
      await invApi.deleteInvestigation(inv.id);
      if (activeInvestigationId === inv.id) closeInvestigation();
      await loadInvestigations();
    });
    el.appendChild(del);

    el.addEventListener('click', () => selectInvestigation(inv.id));
    el.addEventListener('dblclick', () => {
      const nameEl = el.querySelector('.inv-name');
      inlineRename(nameEl, inv.name, async v => {
        await invApi.renameInvestigation(inv.id, v);
        inv.name = v;
      });
    });

    list.appendChild(el);
  }

  document.getElementById('add-investigation-btn').onclick = async () => {
    const name = prompt('Investigation name:', 'New Investigation');
    if (!name?.trim()) return;
    const inv = await invApi.createInvestigation(name.trim());
    investigations.unshift(inv);
    renderInvestigationList();
    await selectInvestigation(inv.id);
  };
}

async function selectInvestigation(id) {
  if (activeInvestigationId === id) return;

  // Save current page if dirty
  if (isDirty) await saveCurrentPage();

  activeInvestigationId = id;
  activePageId = null;
  activeNotebookId = null;

  // Show split layout
  document.getElementById('mindmap-panel').style.display = 'flex';
  document.getElementById('mindmap-panel').style.flex = '1';
  document.getElementById('mindmap-panel').style.width = '';
  document.getElementById('mindmap-splitter').style.display = 'block';

  // Load investigation graph
  const detail = await invApi.getInvestigation(id);
  mindMap.load(detail);

  // Load investigation canvas drawing
  try {
    const result = await invApi.getInvestigationDrawing(id);
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
  } catch {
    engine.loadData({ strokes: [], embeds: [] });
  }

  isDirty = false;
  setSaveStatus('saved');
  renderInvestigationList();
  renderSidebar(); // clear notebook selection highlight
}

function closeInvestigation() {
  activeInvestigationId = null;
  document.getElementById('mindmap-panel').style.display = 'none';
  document.getElementById('mindmap-splitter').style.display = 'none';
  engine.loadData({ strokes: [], embeds: [] });
  isDirty = false;
  setSaveStatus('saved');
}

// ─── Sidebar / Notebooks ──────────────────────────────────────────────────────

async function loadNotebooks() {
  notebooks = await api.getNotebooks();
  renderSidebar();

  if (notebooks.length === 0) {
    const nb = await api.createNotebook('My Notebook');
    notebooks = [nb];
    renderSidebar();
  }

  // Only auto-select a notebook page if no investigation is active
  if (notebooks.length > 0 && !activeInvestigationId) {
    await selectNotebook(notebooks[0].id);
  }
}

function selectNotebook(nbId) {
  if (activeNotebookId === nbId) return;
  // Deselect investigation when switching to notebook
  if (activeInvestigationId) {
    activeInvestigationId = null;
    document.getElementById('mindmap-panel').style.display = 'none';
    document.getElementById('mindmap-splitter').style.display = 'none';
    renderInvestigationList();
  }
  pendingSwitch = { type: 'notebook', id: nbId };
  _drainSwitchQueue();
}

function selectPage(pageId) {
  if (activePageId === pageId) return;
  if (activeInvestigationId) {
    activeInvestigationId = null;
    document.getElementById('mindmap-panel').style.display = 'none';
    document.getElementById('mindmap-splitter').style.display = 'none';
    renderInvestigationList();
  }
  pendingSwitch = { type: 'page', id: pageId };
  _drainSwitchQueue();
}

async function _drainSwitchQueue() {
  if (isSwitching) return;
  isSwitching = true;
  try {
    while (pendingSwitch) {
      const queued = pendingSwitch;
      pendingSwitch = null;
      try {
        if (queued.type === 'notebook') {
          if (queued.id !== activeNotebookId) await _doSelectNotebook(queued.id);
          if (pendingSwitch?.type === 'page' && !pages.some(p => p.id === pendingSwitch.id))
            pendingSwitch = null;
        } else {
          if (queued.id !== activePageId && pages.some(p => p.id === queued.id))
            await _doSelectPage(queued.id);
        }
      } catch (e) { console.error('Navigation error', e); }
    }
  } finally {
    isSwitching = false;
  }
}

async function _doSelectNotebook(nbId) {
  if (isDirty) await saveCurrentPage();
  activeNotebookId = nbId;
  activePageId = null;
  pages = await api.getPages(nbId);
  if (pages.length > 0) {
    await _loadPage(pages[0].id);
  } else {
    engine.loadData({ strokes: [], embeds: [] });
    isDirty = false;
    setSaveStatus('saved');
    renderSidebar();
  }
}

async function _doSelectPage(pageId) {
  if (isDirty) await saveCurrentPage();
  await _loadPage(pageId);
}

async function _loadPage(pageId) {
  activePageId = pageId;
  try {
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
  } catch (e) {
    console.error('Failed to load page', e);
    engine.loadData({ strokes: [], embeds: [] });
  }
  isDirty = false;
  setSaveStatus('saved');
  renderSidebar();
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
          } else {
            renderSidebar();
          }
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

function markDirty() {
  isDirty = true;
  setSaveStatus('unsaved');
  updateUndoRedo();
}

async function saveCurrentPage() {
  // Save investigation canvas if in investigation mode
  if (activeInvestigationId) {
    const invId = activeInvestigationId;
    const data = engine.getData();
    try {
      setSaveStatus('saving');
      const compressed = await api.compressData(data);
      await invApi.saveInvestigationDrawing(invId, compressed);
      isDirty = false;
      setSaveStatus('saved');
    } catch (e) {
      console.error('Save failed', e);
      setSaveStatus('error');
    }
    return;
  }

  if (!activePageId) return;
  const pageId = activePageId;
  const data = engine.getData();
  try {
    setSaveStatus('saving');
    const compressed = await api.compressData(data);
    await api.saveDrawing(pageId, compressed);
    isDirty = false;
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
