import * as invApi from './osint-api.js';
import { compressData, decompressData } from './api.js';

// ── Node type config ─────────────────────────────────────────────────────────

const TYPE_META = {
  person:   { color: '#6366f1', shape: 'ellipse',         icon: '👤' },
  org:      { color: '#a78bfa', shape: 'round-rectangle', icon: '🏢' },
  domain:   { color: '#34d399', shape: 'diamond',         icon: '🌐' },
  ip:       { color: '#fb923c', shape: 'hexagon',         icon: '🖥️' },
  email:    { color: '#fbbf24', shape: 'tag',             icon: '✉️' },
  username: { color: '#f472b6', shape: 'star',            icon: '👾' },
  phone:    { color: '#67e8f9', shape: 'ellipse',         icon: '📞' },
  url:      { color: '#94a3b8', shape: 'rectangle',       icon: '🔗' },
  unknown:  { color: '#4b4b6a', shape: 'ellipse',         icon: '❓' },
};

// Which OSINT actions are available per entity type
const OSINT_ACTIONS = {
  domain:   ['dns', 'subdomains', 'whois'],
  ip:       ['ipinfo', 'shodan'],
  email:    ['hibp'],
  username: ['usernames'],
  person:   [],
  org:      [],
  phone:    [],
  url:      [],
  unknown:  [],
};

const ACTION_LABEL = {
  dns:       'DNS Lookup',
  subdomains:'Find Subdomains',
  whois:     'WHOIS / RDAP',
  ipinfo:    'IP Info',
  shodan:    'Shodan',
  hibp:      'HIBP Breach Check',
  usernames: 'Social Platforms',
};

export class MindMap {
  /**
   * @param {HTMLElement} graphEl      - Cytoscape mount point
   * @param {HTMLElement} detailEl     - entity detail panel container
   * @param {HTMLElement} osintEl      - OSINT results panel container
   * @param {HTMLElement} contextMenuEl- context menu element
   */
  constructor(graphEl, detailEl, osintEl, contextMenuEl) {
    this._graphEl     = graphEl;
    this._detailEl    = detailEl;
    this._osintEl     = osintEl;
    this._menuEl      = contextMenuEl;
    this._invId       = null;
    this._cy          = null;
    this._selectedId  = null;
    this._connectMode = false; // waiting for second node click
    this._connectSrc  = null;
    this._posTimer    = null;
    this.onGraphChange = null; // called when nodes/edges change (for dirty flag)

    this._initCytoscape();
    this._setupContextMenu();
  }

  // ── Cytoscape init ─────────────────────────────────────────────────────────

  _initCytoscape() {
    this._cy = cytoscape({
      container: this._graphEl,
      style: this._buildStyle(),
      layout: { name: 'preset' },
      elements: [],
      minZoom: 0.1,
      maxZoom: 5,
      boxSelectionEnabled: false,
    });

    this._cy.on('tap', 'node', e => this._onNodeTap(e));
    this._cy.on('tap', 'edge', e => this._onEdgeTap(e));
    this._cy.on('tap', e => { if (e.target === this._cy) this._onBgTap(); });
    this._cy.on('cxttap', 'node', e => this._onNodeRightClick(e));
    this._cy.on('dragfreeon', 'node', e => this._onNodeDragged(e));
  }

  _buildStyle() {
    return [
      {
        selector: 'node',
        style: {
          'background-color':   'data(color)',
          'shape':              'data(shape)',
          'label':              'data(shortLabel)',
          'color':              '#e8e8f5',
          'text-valign':        'bottom',
          'text-halign':        'center',
          'font-size':          '11px',
          'font-family':        'Inter, system-ui, sans-serif',
          'text-margin-y':      '5px',
          'text-max-width':     '120px',
          'text-wrap':          'ellipsis',
          'width':              '44px',
          'height':             '44px',
          'border-width':       '2px',
          'border-color':       'rgba(255,255,255,0.15)',
          'text-background-color':   '#0c0c12',
          'text-background-opacity': '0.65',
          'text-background-padding': '2px',
          'text-background-shape':   'roundrectangle',
          'overlay-padding':    '4px',
        }
      },
      {
        selector: 'node:selected',
        style: {
          'border-color': '#fff',
          'border-width': '3px',
          'background-blacken': -0.15,
        }
      },
      {
        selector: 'node.connect-source',
        style: { 'border-color': '#fbbf24', 'border-width': '3px' }
      },
      {
        selector: 'node.connect-target',
        style: { 'border-color': '#34d399', 'border-width': '3px' }
      },
      {
        selector: 'edge',
        style: {
          'width':                  '1.5',
          'line-color':             'rgba(180,180,220,0.25)',
          'target-arrow-color':     'rgba(180,180,220,0.35)',
          'target-arrow-shape':     'triangle',
          'curve-style':            'bezier',
          'label':                  'data(label)',
          'font-size':              '9px',
          'color':                  'rgba(200,200,230,0.6)',
          'text-background-color':  '#0c0c12',
          'text-background-opacity':'0.7',
          'text-background-padding':'2px',
          'text-background-shape':  'roundrectangle',
          'edge-text-rotation':     'autorotate',
        }
      },
      {
        selector: 'edge:selected',
        style: { 'line-color': '#6366f1', 'target-arrow-color': '#6366f1' }
      },
    ];
  }

  // ── Load investigation ─────────────────────────────────────────────────────

  load(investigation) {
    this._invId = investigation.id;
    this._cy.elements().remove();
    this._selectedId = null;
    this._hideDetail();
    this._hideOsint();

    const elements = [];
    for (const e of investigation.entities) {
      elements.push(this._entityToCyNode(e));
    }
    for (const r of investigation.relations) {
      elements.push({ data: { id: `r${r.id}`, ridId: r.id, source: `e${r.sourceId}`, target: `e${r.targetId}`, label: r.label ?? '' } });
    }
    this._cy.add(elements);

    // If no nodes have positions, run layout
    const hasPositions = investigation.entities.some(e => e.x !== 0 || e.y !== 0);
    if (!hasPositions && investigation.entities.length > 0) {
      this._cy.layout({ name: 'cose', animate: false, randomize: true, idealEdgeLength: 120 }).run();
    }
  }

  _entityToCyNode(e) {
    const meta = TYPE_META[e.type] ?? TYPE_META.unknown;
    return {
      data: {
        id: `e${e.id}`,
        entityId: e.id,
        type: e.type,
        label: e.label,
        shortLabel: e.label.length > 20 ? e.label.slice(0, 18) + '…' : e.label,
        color: meta.color,
        shape: meta.shape,
        icon: meta.icon,
      },
      position: { x: e.x || 0, y: e.y || 0 },
    };
  }

  // ── Add / remove ──────────────────────────────────────────────────────────

  addEntity(entity) {
    const meta = TYPE_META[entity.type] ?? TYPE_META.unknown;
    // Place near center of current viewport if no position
    const pos = (entity.x === 0 && entity.y === 0)
      ? this._cy.extent() && { x: (this._cy.extent().x1 + this._cy.extent().x2) / 2 + (Math.random() - 0.5) * 200, y: (this._cy.extent().y1 + this._cy.extent().y2) / 2 + (Math.random() - 0.5) * 200 }
      : { x: entity.x, y: entity.y };
    this._cy.add({
      data: {
        id: `e${entity.id}`,
        entityId: entity.id,
        type: entity.type,
        label: entity.label,
        shortLabel: entity.label.length > 20 ? entity.label.slice(0, 18) + '…' : entity.label,
        color: meta.color,
        shape: meta.shape,
        icon: meta.icon,
      },
      position: pos || { x: 0, y: 0 },
    });
  }

  removeEntity(entityId) {
    this._cy.$(`#e${entityId}`).remove();
    if (this._selectedId === entityId) this._hideDetail();
  }

  addRelation(relation) {
    this._cy.add({
      data: {
        id: `r${relation.id}`,
        ridId: relation.id,
        source: `e${relation.sourceId}`,
        target: `e${relation.targetId}`,
        label: relation.label ?? '',
      }
    });
  }

  removeRelation(relationId) {
    this._cy.$(`#r${relationId}`).remove();
  }

  // ── Layout ────────────────────────────────────────────────────────────────

  runLayout() {
    this._cy.layout({ name: 'cose', animate: true, animationDuration: 500, idealEdgeLength: 130 }).run();
  }

  fit() {
    this._cy.fit(undefined, 40);
  }

  // ── Position persistence ──────────────────────────────────────────────────

  _onNodeDragged(e) {
    const node = e.target;
    const pos = node.position();
    const entityId = node.data('entityId');
    clearTimeout(this._posTimer);
    this._posTimer = setTimeout(async () => {
      if (this._invId && entityId) {
        await invApi.updateEntity(this._invId, entityId, { x: pos.x, y: pos.y });
      }
    }, 800);
    this.onGraphChange?.();
  }

  // ── Node tap / selection ──────────────────────────────────────────────────

  _onNodeTap(e) {
    const node = e.target;
    const entityId = node.data('entityId');

    if (this._connectMode) {
      if (!this._connectSrc) {
        // First click: set source
        this._connectSrc = entityId;
        this._cy.nodes().removeClass('connect-source connect-target');
        node.addClass('connect-source');
      } else if (this._connectSrc !== entityId) {
        // Second click: create relation
        this._finishConnect(entityId);
      }
      return;
    }

    this._selectedId = entityId;
    this._showDetail(entityId, node.data());
    this._hideOsint();
  }

  _onEdgeTap(e) {
    const rid = e.target.data('ridId');
    if (!this._invId || !rid) return;
    // Show edge label; clicking background deselects
  }

  _onBgTap() {
    if (this._connectMode) { this._cancelConnect(); return; }
    this._selectedId = null;
    this._hideDetail();
  }

  // ── Right-click context menu ──────────────────────────────────────────────

  _setupContextMenu() {
    document.addEventListener('click', () => this._menuEl.classList.remove('visible'));
    document.addEventListener('keydown', e => { if (e.key === 'Escape') { this._menuEl.classList.remove('visible'); this._cancelConnect(); } });
  }

  _onNodeRightClick(e) {
    e.preventDefault();
    const node = e.target;
    const entityId = node.data('entityId');
    const type = node.data('type');
    const rendPos = node.renderedPosition();
    const graphRect = this._graphEl.getBoundingClientRect();

    this._menuEl.innerHTML = this._buildContextMenu(entityId, type, node.data('label'));
    this._menuEl.style.left = (graphRect.left + rendPos.x + 10) + 'px';
    this._menuEl.style.top  = (graphRect.top  + rendPos.y + 10) + 'px';
    this._menuEl.classList.add('visible');

    this._menuEl.onclick = async ev => {
      const action = ev.target.closest('[data-action]')?.dataset.action;
      if (!action) return;
      this._menuEl.classList.remove('visible');
      await this._handleMenuAction(action, entityId, type, node.data('label'));
    };
  }

  _buildContextMenu(entityId, type, label) {
    const osintActions = (OSINT_ACTIONS[type] ?? [])
      .map(a => `<button class="cm-item" data-action="osint:${a}">${ACTION_LABEL[a]}</button>`)
      .join('');
    const osintSection = osintActions
      ? `<div class="cm-section">Enrich</div>${osintActions}<div class="cm-divider"></div>`
      : '';
    return `
      ${osintSection}
      <button class="cm-item" data-action="connect">Connect to…</button>
      <button class="cm-item" data-action="edit">Edit label</button>
      <button class="cm-item cm-item-danger" data-action="delete">Delete</button>
    `;
  }

  async _handleMenuAction(action, entityId, type, label) {
    if (action.startsWith('osint:')) {
      const osintType = action.slice(6);
      await this._runOsint(entityId, type, label, osintType);
    } else if (action === 'connect') {
      this._startConnect(entityId);
    } else if (action === 'edit') {
      const newLabel = prompt('New label:', label);
      if (newLabel && newLabel.trim() && newLabel.trim() !== label) {
        await invApi.updateEntity(this._invId, entityId, { label: newLabel.trim() });
        const node = this._cy.$(`#e${entityId}`);
        const nl = newLabel.trim();
        node.data('label', nl);
        node.data('shortLabel', nl.length > 20 ? nl.slice(0, 18) + '…' : nl);
        this.onGraphChange?.();
        if (this._selectedId === entityId) this._refreshDetail(entityId, node.data());
      }
    } else if (action === 'delete') {
      if (!confirm(`Delete "${label}"?`)) return;
      await invApi.deleteEntity(this._invId, entityId);
      this.removeEntity(entityId);
      this.onGraphChange?.();
    }
  }

  // ── Connect mode ──────────────────────────────────────────────────────────

  _startConnect(entityId) {
    this._connectMode = true;
    this._connectSrc  = entityId;
    this._cy.nodes().removeClass('connect-source connect-target');
    this._cy.$(`#e${entityId}`).addClass('connect-source');
    this._graphEl.classList.add('connect-mode');
  }

  async _finishConnect(targetEntityId) {
    const srcId = this._connectSrc;
    this._cancelConnect();
    const label = prompt('Relation label (optional):', '') ?? '';
    const relation = await invApi.addRelation(this._invId, srcId, targetEntityId, label || null);
    this.addRelation(relation);
    this.onGraphChange?.();
  }

  _cancelConnect() {
    this._connectMode = false;
    this._connectSrc  = null;
    this._cy.nodes().removeClass('connect-source connect-target');
    this._graphEl.classList.remove('connect-mode');
  }

  // ── OSINT enrichment ──────────────────────────────────────────────────────

  async _runOsint(entityId, type, label, osintAction) {
    this._showOsintLoading(ACTION_LABEL[osintAction] ?? osintAction, label);

    let result;
    try {
      switch (osintAction) {
        case 'dns':        result = await invApi.osintDns(label);        break;
        case 'subdomains': result = await invApi.osintSubdomains(label);  break;
        case 'whois':      result = await invApi.osintWhois(label);       break;
        case 'ipinfo':     result = await invApi.osintIp(label);          break;
        case 'shodan':     result = await invApi.osintShodan(label);      break;
        case 'hibp':       result = await invApi.osintHibp(label);        break;
        case 'usernames':  result = await invApi.osintUsernames(label);   break;
        default:           result = { success: false, error: 'Unknown action' };
      }
    } catch (err) {
      result = { success: false, error: String(err) };
    }

    this._showOsintResults(entityId, label, ACTION_LABEL[osintAction] ?? osintAction, result);

    // Append raw OSINT data to the entity's OsintJson
    if (result.success && this._invId) {
      const node = this._cy.$(`#e${entityId}`);
      let existing = {};
      try { existing = JSON.parse(node.data('osintJson') || '{}'); } catch { }
      existing[osintAction] = result.data;
      const newJson = JSON.stringify(existing);
      node.data('osintJson', newJson);
      await invApi.updateEntity(this._invId, entityId, { osintJson: newJson });
    }
  }

  // ── OSINT results panel ───────────────────────────────────────────────────

  _showOsintLoading(actionName, target) {
    this._osintEl.style.display = 'flex';
    this._osintEl.innerHTML = `
      <div class="osint-header">
        <span>${_esc(actionName)} → <strong>${_esc(target)}</strong></span>
        <button class="osint-close" onclick="this.closest('#mindmap-osint-panel').style.display='none'">×</button>
      </div>
      <div class="osint-body osint-loading">Running query…</div>
    `;
  }

  _showOsintResults(sourceEntityId, sourceLabel, actionName, result) {
    if (!result.success) {
      this._osintEl.innerHTML = `
        <div class="osint-header">
          <span>${_esc(actionName)}</span>
          <button class="osint-close" onclick="this.closest('#mindmap-osint-panel').style.display='none'">×</button>
        </div>
        <div class="osint-body osint-error">Error: ${_esc(result.error ?? 'Unknown error')}</div>
      `;
      return;
    }

    const suggestions = result.suggestions ?? [];
    const suggestionsHtml = suggestions.length > 0 ? `
      <div class="osint-suggestions">
        <div class="osint-suggest-title">Add to graph (${suggestions.length} found)</div>
        ${suggestions.map((s, i) => `
          <label class="osint-suggest-row">
            <input type="checkbox" class="osint-cb" data-idx="${i}" checked>
            <span class="osint-suggest-type osint-type-${_esc(s.type)}">${_esc(s.type)}</span>
            <span class="osint-suggest-label" title="${_esc(s.label)}">${_esc(s.label.length > 40 ? s.label.slice(0, 38) + '…' : s.label)}</span>
            <span class="osint-suggest-rel">${_esc(s.relationLabel)}</span>
          </label>
        `).join('')}
        <button class="osint-add-btn" id="osint-add-selected">Add selected to graph</button>
      </div>
    ` : '<div class="osint-no-suggest">No graph suggestions from this query.</div>';

    this._osintEl.innerHTML = `
      <div class="osint-header">
        <span>${_esc(actionName)} → <strong>${_esc(sourceLabel)}</strong></span>
        <button class="osint-close" onclick="this.closest('#mindmap-osint-panel').style.display='none'">×</button>
      </div>
      <div class="osint-body">
        ${suggestionsHtml}
        <details class="osint-raw-details">
          <summary>Raw data</summary>
          <pre class="osint-raw">${_esc(JSON.stringify(result.data, null, 2))}</pre>
        </details>
      </div>
    `;

    const addBtn = document.getElementById('osint-add-selected');
    if (addBtn) {
      addBtn.addEventListener('click', async () => {
        const checked = [...this._osintEl.querySelectorAll('.osint-cb:checked')]
          .map(cb => suggestions[parseInt(cb.dataset.idx)]);
        if (checked.length === 0) return;
        addBtn.disabled = true;
        addBtn.textContent = 'Adding…';
        for (const s of checked) {
          const entity = await invApi.addEntity(this._invId, s.type, s.label);
          this.addEntity(entity);
          const relation = await invApi.addRelation(this._invId, sourceEntityId, entity.id, s.relationLabel);
          this.addRelation(relation);
        }
        this.onGraphChange?.();
        addBtn.textContent = `Added ${checked.length} node${checked.length > 1 ? 's' : ''}`;
      });
    }
  }

  _hideOsint() {
    this._osintEl.style.display = 'none';
  }

  // ── Entity detail panel ───────────────────────────────────────────────────

  _showDetail(entityId, nodeData) {
    const meta = TYPE_META[nodeData.type] ?? TYPE_META.unknown;
    this._detailEl.style.display = 'flex';
    this._detailEl.innerHTML = `
      <div class="detail-type-badge" style="background:${meta.color}22;color:${meta.color};border-color:${meta.color}44">
        ${meta.icon} ${_esc(nodeData.type)}
      </div>
      <div class="detail-label">${_esc(nodeData.label)}</div>
      <div class="detail-osint-btns" id="detail-osint-btns"></div>
      <textarea class="detail-notes" id="detail-notes" placeholder="Notes…"></textarea>
    `;

    // OSINT action buttons
    const btnsEl = document.getElementById('detail-osint-btns');
    const actions = OSINT_ACTIONS[nodeData.type] ?? [];
    for (const a of actions) {
      const btn = document.createElement('button');
      btn.className = 'detail-osint-btn';
      btn.textContent = ACTION_LABEL[a];
      btn.onclick = () => this._runOsint(entityId, nodeData.type, nodeData.label, a);
      btnsEl.appendChild(btn);
    }

    // Notes
    const notesEl = document.getElementById('detail-notes');
    if (notesEl) {
      // Load notes from DB lazily
      invApi.updateEntity(this._invId, entityId, {}).catch(() => {});
      // We store notes in the cy node data after first load
      notesEl.value = nodeData.notes ?? '';
      let notesTimer;
      notesEl.addEventListener('input', () => {
        clearTimeout(notesTimer);
        notesTimer = setTimeout(async () => {
          const n = notesEl.value;
          await invApi.updateEntity(this._invId, entityId, { notes: n });
          this._cy.$(`#e${entityId}`).data('notes', n);
        }, 800);
      });
    }
  }

  _refreshDetail(entityId, nodeData) {
    if (this._selectedId === entityId && this._detailEl.style.display !== 'none') {
      this._showDetail(entityId, nodeData);
    }
  }

  _hideDetail() {
    this._detailEl.style.display = 'none';
    this._detailEl.innerHTML = '';
  }
}

function _esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
