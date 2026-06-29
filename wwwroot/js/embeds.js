import { getLinkPreview, generateId } from './api.js';

const STICKY_COLORS = ['#fef08a', '#fca5a5', '#86efac', '#93c5fd', '#d8b4fe', '#fdba74'];

const CODE_LANGUAGES = [
  { value: 'auto',       label: 'Auto' },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'typescript', label: 'TypeScript' },
  { value: 'python',     label: 'Python' },
  { value: 'csharp',     label: 'C#' },
  { value: 'java',       label: 'Java' },
  { value: 'cpp',        label: 'C++' },
  { value: 'rust',       label: 'Rust' },
  { value: 'go',         label: 'Go' },
  { value: 'html',       label: 'HTML' },
  { value: 'css',        label: 'CSS' },
  { value: 'sql',        label: 'SQL' },
  { value: 'bash',       label: 'Shell' },
  { value: 'json',       label: 'JSON' },
  { value: 'markdown',   label: 'Markdown' },
];

export class EmbedManager {
  constructor(engine, embedsLayer) {
    this.engine = engine;
    this.layer = embedsLayer;
    this.elements = new Map(); // id -> DOM element
    this.focusPendingId = null;

    engine.onEmbedsChange = (embeds) => this.syncAll(embeds);
  }

  syncAll(embeds) {
    const ids = new Set(embeds.map(e => e.id));

    for (const [id, el] of this.elements) {
      if (!ids.has(id)) {
        el.remove();
        this.elements.delete(id);
      }
    }

    for (const embed of embeds) {
      if (!this.elements.has(embed.id)) {
        this._createElement(embed);
      } else {
        this._updatePosition(embed);
      }
    }
  }

  async handlePaste(text) {
    const trimmed = text.trim();
    if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) return false;

    const rect = this.engine.container.getBoundingClientRect();
    const cx = (rect.width / 2 - this.engine.tx) / this.engine.scale;
    const cy = (rect.height / 2 - this.engine.ty) / this.engine.scale;

    // Direct image URL — skip link preview
    if (/\.(jpe?g|png|gif|webp|svg|bmp|avif|ico)(\?[^#]*)?$/i.test(trimmed)) {
      this._placeImageEmbed(trimmed);
      return true;
    }

    const preview = await getLinkPreview(trimmed);

    let embed;
    if (preview.isYoutube) {
      embed = {
        id: generateId(), type: 'youtube',
        url: trimmed, videoId: preview.youtubeId, title: preview.title,
        x: cx - 320, y: cy - 180, width: 640, height: 360
      };
    } else {
      embed = {
        id: generateId(), type: 'link',
        url: trimmed, title: preview.title, description: preview.description,
        imageUrl: preview.imageUrl, siteName: preview.siteName,
        x: cx - 180, y: cy - 75, width: 360, height: 150
      };
    }

    this.engine.setTool('pan');
    this.engine.addEmbed(embed);
    return true;
  }

  async handleImagePaste(file) {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => resolve(e.target.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    this._placeImageEmbed(dataUrl);
  }

  _placeImageEmbed(url) {
    const rect = this.engine.container.getBoundingClientRect();
    const cx = (rect.width / 2 - this.engine.tx) / this.engine.scale;
    const cy = (rect.height / 2 - this.engine.ty) / this.engine.scale;
    const embed = { id: generateId(), type: 'image', url, x: cx, y: cy, _cx: cx, _cy: cy };
    this.engine.setTool('pan');
    this.engine.addEmbed(embed);
  }

  setInteractive(enabled) {
    this.layer.classList.toggle('interactive', enabled);
  }

  // ─── Element creation ────────────────────────────────────────────────────

  _createElement(embed) {
    if (embed.type === 'text')   { this._createTextEl(embed);   return; }
    if (embed.type === 'sticky') { this._createStickyEl(embed); return; }
    if (embed.type === 'code')   { this._createCodeEl(embed);   return; }
    if (embed.type === 'image')  { this._createImageEl(embed);  return; }

    const el = document.createElement('div');
    el.className = 'embed-card';
    el.dataset.id = embed.id;
    el.style.left = embed.x + 'px';
    el.style.top = embed.y + 'px';
    el.style.width = embed.width + 'px';

    if (embed.type === 'youtube') {
      el.classList.add('embed-video');
      el.style.height = embed.height + 'px';
      const dragBar = _makeDragBar(() => this.engine.removeEmbed(embed.id));
      // Override position:absolute from CSS — bar must be in the flex flow so it
      // occupies a real row above the iframe with zero overlap.
      dragBar.style.cssText = 'position:relative;top:auto;left:auto;right:auto;opacity:1;flex-shrink:0;border-radius:10px 10px 0 0;';
      el.appendChild(dragBar);
      const iframe = document.createElement('iframe');
      iframe.src = `https://www.youtube.com/embed/${embed.videoId}?rel=0`;
      iframe.allowFullscreen = true;
      iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
      iframe.style.cssText = 'flex:1;width:100%;border:none;border-radius:0 0 8px 8px;min-height:0;';
      el.appendChild(iframe);
      this._makeDraggable(el, embed, dragBar);
    } else {
      el.classList.add('embed-link');
      el.style.height = 'auto';
      el.innerHTML = this._linkCardHTML(embed);
      el.querySelector('a')?.addEventListener('click', e => e.stopPropagation());

      const rh = document.createElement('div');
      rh.className = 'embed-resize-handle';
      rh.style.cssText = 'position:absolute;bottom:5px;right:5px;width:16px;height:16px;background:#1cb065;border-radius:3px;cursor:nwse-resize;pointer-events:all;opacity:0.7;z-index:9999;box-shadow:0 0 0 2px rgba(255,255,255,0.4),0 2px 6px rgba(0,0,0,0.7);';
      rh.addEventListener('pointerenter', () => { rh.style.opacity = '1'; });
      rh.addEventListener('pointerleave', () => { rh.style.opacity = '0.7'; });
      rh.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        e.stopPropagation(); e.preventDefault();
        const pid = e.pointerId, rsX = e.clientX, rsY = e.clientY;
        const rsW = el.offsetWidth, rsH = el.offsetHeight;
        el.style.height = rsH + 'px';
        const onMove = ev => {
          if (ev.pointerId !== pid) return;
          const newW = Math.max(180, rsW + (ev.clientX - rsX) / this.engine.scale);
          const newH = Math.max(80,  rsH + (ev.clientY - rsY) / this.engine.scale);
          el.style.width  = newW + 'px';
          el.style.height = newH + 'px';
        };
        const onEnd = ev => {
          if (ev.pointerId !== pid) return;
          document.removeEventListener('pointermove', onMove);
          document.removeEventListener('pointerup',   onEnd);
          document.removeEventListener('pointercancel', onEnd);
          this.engine.updateEmbedSize(embed.id, el.offsetWidth, el.offsetHeight);
        };
        document.addEventListener('pointermove',   onMove);
        document.addEventListener('pointerup',     onEnd);
        document.addEventListener('pointercancel', onEnd);
      });
      el.appendChild(rh);

      const dragBar = _makeDragBar(() => this.engine.removeEmbed(embed.id));
      el.appendChild(dragBar);
      this._makeDraggable(el, embed);
    }

    this.layer.appendChild(el);
    this.elements.set(embed.id, el);
  }

  _createTextEl(embed) {
    const el = document.createElement('div');
    el.className = 'embed-card embed-text';
    el.dataset.id = embed.id;
    el.style.left = embed.x + 'px';
    el.style.top = embed.y + 'px';
    el.style.width = (embed.width || 240) + 'px';
    if (embed.height) el.style.height = embed.height + 'px';

    const header = document.createElement('div');
    header.className = 'embed-text-header';

    const handle = document.createElement('span');
    handle.className = 'embed-drag-handle';
    handle.textContent = '⠿';
    header.appendChild(handle);

    header.appendChild(_makeCloseSmall(() => this.engine.removeEmbed(embed.id)));
    el.appendChild(header);

    const textarea = document.createElement('textarea');
    textarea.className = 'embed-text-content';
    textarea.placeholder = 'Type here…';
    textarea.value = embed.content || '';
    textarea.addEventListener('pointerdown', e => e.stopPropagation());
    textarea.addEventListener('input', () => {
      if (!embed.height) _autoResize(textarea);
      embed.content = textarea.value;
      this.engine.updateEmbedContent(embed.id, embed.content);
    });
    el.appendChild(textarea);

    // Resize handle — same pattern as link/image handles
    const rh = document.createElement('div');
    rh.style.cssText = 'position:absolute;bottom:5px;right:5px;width:16px;height:16px;background:#1cb065;border-radius:3px;cursor:nwse-resize;pointer-events:all;opacity:0.7;z-index:9999;box-shadow:0 0 0 2px rgba(255,255,255,0.4),0 2px 6px rgba(0,0,0,0.7);touch-action:none;';
    rh.addEventListener('pointerenter', () => { rh.style.opacity = '1'; });
    rh.addEventListener('pointerleave', () => { rh.style.opacity = '0.7'; });
    rh.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.stopPropagation(); e.preventDefault();
      rh.setPointerCapture(e.pointerId);
      const rsX = e.clientX, rsY = e.clientY;
      const rsW = el.offsetWidth, rsH = el.offsetHeight;
      const onMove = ev => {
        const newW = Math.max(140, rsW + (ev.clientX - rsX) / this.engine.scale);
        const newH = Math.max(80,  rsH + (ev.clientY - rsY) / this.engine.scale);
        el.style.width  = newW + 'px';
        el.style.height = newH + 'px';
        embed.height = newH;
        textarea.style.height   = Math.max(40, newH - header.offsetHeight) + 'px';
        textarea.style.overflow = 'auto';
      };
      const onEnd = () => {
        rh.removeEventListener('pointermove',   onMove);
        rh.removeEventListener('pointerup',     onEnd);
        rh.removeEventListener('pointercancel', onEnd);
        this.engine.updateEmbedSize(embed.id, el.offsetWidth, el.offsetHeight);
      };
      rh.addEventListener('pointermove',   onMove);
      rh.addEventListener('pointerup',     onEnd);
      rh.addEventListener('pointercancel', onEnd);
    });
    el.appendChild(rh);

    this._makeDraggable(el, embed, header);
    this.layer.appendChild(el);
    this.elements.set(embed.id, el);

    if (embed.height) {
      requestAnimationFrame(() => {
        textarea.style.height   = Math.max(40, embed.height - header.offsetHeight) + 'px';
        textarea.style.overflow = 'auto';
      });
    } else {
      requestAnimationFrame(() => _autoResize(textarea));
    }

    if (this.focusPendingId === embed.id) {
      this.focusPendingId = null;
      requestAnimationFrame(() => textarea.focus());
    }
  }

  _createStickyEl(embed) {
    const color = embed.color || STICKY_COLORS[0];

    const el = document.createElement('div');
    el.className = 'embed-card embed-sticky';
    el.dataset.id = embed.id;
    el.style.left = embed.x + 'px';
    el.style.top = embed.y + 'px';
    el.style.width  = (embed.width  || 200) + 'px';
    el.style.height = (embed.height || 200) + 'px';
    el.style.background = color;

    const header = document.createElement('div');
    header.className = 'embed-sticky-header';

    const colorRow = document.createElement('div');
    colorRow.className = 'embed-sticky-colors';
    for (const c of STICKY_COLORS) {
      const btn = document.createElement('button');
      btn.className = 'sticky-color-btn' + (c === color ? ' active' : '');
      btn.style.background = c;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        embed.color = c;
        el.style.background = c;
        colorRow.querySelectorAll('.sticky-color-btn').forEach(b => b.classList.toggle('active', b === btn));
        this.engine.updateEmbedColor(embed.id, c);
      });
      colorRow.appendChild(btn);
    }
    header.appendChild(colorRow);
    const stickyDragIcon = document.createElement('span');
    stickyDragIcon.className = 'embed-drag-handle';
    stickyDragIcon.textContent = '⠿';
    header.appendChild(stickyDragIcon);
    header.appendChild(_makeCloseSmall(() => this.engine.removeEmbed(embed.id)));
    el.appendChild(header);

    const textarea = document.createElement('textarea');
    textarea.className = 'embed-sticky-content';
    textarea.placeholder = 'Note…';
    textarea.value = embed.content || '';
    textarea.addEventListener('pointerdown', e => e.stopPropagation());
    textarea.addEventListener('input', () => {
      embed.content = textarea.value;
      this.engine.updateEmbedContent(embed.id, embed.content);
    });
    el.appendChild(textarea);

    this._makeDraggable(el, embed, header);
    this.layer.appendChild(el);
    this.elements.set(embed.id, el);

    if (this.focusPendingId === embed.id) {
      this.focusPendingId = null;
      requestAnimationFrame(() => textarea.focus());
    }
  }

  _createCodeEl(embed) {
    const lang = embed.language || 'auto';

    const el = document.createElement('div');
    el.className = 'embed-card embed-code';
    el.dataset.id = embed.id;
    el.style.left   = embed.x + 'px';
    el.style.top    = embed.y + 'px';
    el.style.width  = (embed.width  || 460) + 'px';
    el.style.height = (embed.height || 280) + 'px';

    // Header
    const header = document.createElement('div');
    header.className = 'embed-code-header';

    const select = document.createElement('select');
    select.className = 'code-lang-select';
    for (const { value, label } of CODE_LANGUAGES) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      if (value === lang) opt.selected = true;
      select.appendChild(opt);
    }
    header.appendChild(select);

    const spacer = document.createElement('span');
    spacer.className = 'embed-code-spacer embed-drag-handle';
    spacer.textContent = '⠿';
    header.appendChild(spacer);

    header.appendChild(_makeCloseSmall(() => this.engine.removeEmbed(embed.id)));
    el.appendChild(header);

    // Body
    const body = document.createElement('div');
    body.className = 'embed-code-body';

    const pre = document.createElement('pre');
    pre.className = 'embed-code-pre';
    const codeEl = document.createElement('code');
    codeEl.className = 'embed-code-el';
    pre.appendChild(codeEl);
    body.appendChild(pre);

    const textarea = document.createElement('textarea');
    textarea.className = 'embed-code-textarea';
    textarea.spellcheck = false;
    textarea.value = embed.content || '';
    textarea.addEventListener('pointerdown', e => e.stopPropagation());
    textarea.addEventListener('keydown', e => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const s = textarea.selectionStart, end = textarea.selectionEnd;
        textarea.value = textarea.value.slice(0, s) + '  ' + textarea.value.slice(end);
        textarea.selectionStart = textarea.selectionEnd = s + 2;
      }
    });
    textarea.addEventListener('input', () => {
      embed.content = textarea.value;
      this.engine.updateEmbedContent(embed.id, embed.content);
    });
    textarea.addEventListener('blur', () => {
      _highlightCode(codeEl, embed.content || '', embed.language || 'auto');
      _setCodeEmpty(pre, !embed.content);
      textarea.style.display = 'none';
      pre.style.display = '';
    });
    body.appendChild(textarea);
    el.appendChild(body);

    // Click pre → switch to edit (pan mode only)
    pre.addEventListener('click', () => {
      if (this.engine.tool !== 'pan') return;
      pre.style.display = 'none';
      textarea.style.display = 'block';
      textarea.focus();
    });

    // Language change
    select.addEventListener('change', () => {
      embed.language = select.value;
      if (textarea.style.display === 'none') {
        _highlightCode(codeEl, embed.content || '', embed.language);
      }
      this.engine.updateEmbedContent(embed.id, embed.content || '');
    });

    this._makeDraggable(el, embed, header);
    this.layer.appendChild(el);
    this.elements.set(embed.id, el);

    // Initial state
    if (embed.content) {
      _highlightCode(codeEl, embed.content, lang);
    } else {
      _setCodeEmpty(pre, true);
    }

    if (this.focusPendingId === embed.id) {
      this.focusPendingId = null;
      requestAnimationFrame(() => {
        pre.style.display = 'none';
        textarea.style.display = 'block';
        textarea.focus();
      });
    }
  }

  _createImageEl(embed) {
    const el = document.createElement('div');
    el.className = 'embed-card embed-image';
    el.dataset.id = embed.id;
    el.style.left = embed.x + 'px';
    el.style.top  = embed.y + 'px';
    if (embed.width)  el.style.width  = embed.width  + 'px';
    if (embed.height) el.style.height = embed.height + 'px';

    const img = document.createElement('img');
    img.className = 'embed-image-img';
    img.draggable = false;
    img.alt = '';

    let naturalAR = (embed.width && embed.height) ? embed.height / embed.width : null;

    img.addEventListener('load', () => {
      if (!naturalAR) naturalAR = img.naturalHeight / img.naturalWidth;

      if ('_cx' in embed) {
        // Fit within 80 % of the visible canvas so the resize handle stays on-screen
        const maxW = (this.engine.container.clientWidth  * 0.8) / this.engine.scale;
        const maxH = (this.engine.container.clientHeight * 0.8) / this.engine.scale;
        let w = img.naturalWidth, h = img.naturalHeight;
        if (w > maxW) { h = Math.round(h * maxW / w); w = Math.round(maxW); }
        if (h > maxH) { w = Math.round(w * maxH / h); h = Math.round(maxH); }

        const cx = embed._cx, cy = embed._cy;
        delete embed._cx; delete embed._cy;
        embed.x = cx - w / 2;
        embed.y = cy - h / 2;
        el.style.width   = w + 'px';
        el.style.height  = h + 'px';
        img.style.width  = w + 'px';
        img.style.height = h + 'px';
        el.style.left    = embed.x + 'px';
        el.style.top     = embed.y + 'px';
        this.engine.updateEmbedSize(embed.id, w, h);
      } else if (embed.width) {
        // Loaded from saved data — apply saved dimensions explicitly so the img
        // is never left relying on percentage-height CSS resolution.
        img.style.width  = embed.width  + 'px';
        img.style.height = embed.height + 'px';
      } else {
        const w = img.naturalWidth, h = img.naturalHeight;
        el.style.width   = w + 'px';
        el.style.height  = h + 'px';
        img.style.width  = w + 'px';
        img.style.height = h + 'px';
        this.engine.updateEmbedSize(embed.id, w, h);
      }
    });

    img.src = embed.url;

    // Corner resize handle (bottom-right) — uses document-level listeners for reliability
    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'embed-resize-handle';
    resizeHandle.style.cssText = 'position:absolute;bottom:5px;right:5px;width:16px;height:16px;background:#1cb065;border-radius:3px;cursor:nwse-resize;pointer-events:all;opacity:0.7;z-index:9999;box-shadow:0 0 0 2px rgba(255,255,255,0.4),0 2px 6px rgba(0,0,0,0.7);';
    resizeHandle.addEventListener('pointerenter', () => { resizeHandle.style.opacity = '1'; });
    resizeHandle.addEventListener('pointerleave', () => { resizeHandle.style.opacity = '0.7'; });

    resizeHandle.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      const pid = e.pointerId;
      const rsX = e.clientX, rsY = e.clientY;
      // clientWidth/clientHeight gives the content size (excludes border) so the
      // saved embed.width matches exactly what we set on el.style.width.
      const rsW = el.clientWidth,  rsH = el.clientHeight;
      let lastW = rsW, lastH = rsH;

      const onMove = ev => {
        if (ev.pointerId !== pid) return;
        lastW = Math.max(40, rsW + (ev.clientX - rsX) / this.engine.scale);
        lastH = naturalAR ? Math.round(lastW * naturalAR) : Math.max(40, rsH + (ev.clientY - rsY) / this.engine.scale);
        el.style.width   = lastW + 'px';
        el.style.height  = lastH + 'px';
        img.style.width  = lastW + 'px';
        img.style.height = lastH + 'px';
      };
      const onEnd = ev => {
        if (ev.pointerId !== pid) return;
        document.removeEventListener('pointermove',   onMove);
        document.removeEventListener('pointerup',     onEnd);
        document.removeEventListener('pointercancel', onEnd);
        this.engine.updateEmbedSize(embed.id, lastW, lastH);
      };
      document.addEventListener('pointermove',   onMove);
      document.addEventListener('pointerup',     onEnd);
      document.addEventListener('pointercancel', onEnd);
    });

    el.appendChild(img);
    el.appendChild(resizeHandle);
    el.appendChild(_makeDragBar(() => this.engine.removeEmbed(embed.id)));
    this._makeDraggable(el, embed);
    this.layer.appendChild(el);
    this.elements.set(embed.id, el);
  }

  _linkCardHTML(embed) {
    const img = embed.imageUrl
      ? `<div class="embed-thumb" style="background-image:url('${escapeHtml(embed.imageUrl)}')"></div>`
      : '';
    const site  = embed.siteName    ? `<span class="embed-site">${escapeHtml(embed.siteName)}</span>` : '';
    const title = embed.title       ? `<div class="embed-title">${escapeHtml(embed.title)}</div>`     : '';
    const desc  = embed.description ? `<div class="embed-desc">${escapeHtml(embed.description)}</div>` : '';
    return `
      ${img}
      <div class="embed-info">
        ${site}${title}${desc}
        <a href="${escapeHtml(embed.url)}" target="_blank" rel="noopener" class="embed-url">${escapeHtml(embed.url.slice(0, 60))}${embed.url.length > 60 ? '…' : ''}</a>
      </div>`;
  }

  _updatePosition(embed) {
    const el = this.elements.get(embed.id);
    if (el) {
      el.style.left = embed.x + 'px';
      el.style.top  = embed.y + 'px';
    }
  }

  // ─── Drag ────────────────────────────────────────────────────────────────
  // handle defaults to el (whole-card drag for link/image).
  // For text/sticky/code, pass the header so the body stays typeable.
  // For youtube, pass the dragBar since the iframe blocks all other events.

  _makeDraggable(el, embed, handle = el) {
    let dragging = false, startX, startY, startEX, startEY, capturedId;
    const fullCard = handle === el;

    handle.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      // Full-card drag: skip iframes, links, and the overlay close button
      if (fullCard && (e.target.closest('iframe') || e.target.closest('a') || e.target.closest('.embed-close'))) { e.stopPropagation(); return; }
      // Header drag: skip buttons and selects (close, color swatches, lang picker)
      if (!fullCard && e.target.closest('button, select')) { e.stopPropagation(); return; }
      if (this.engine.tool !== 'pan') return;
      e.stopPropagation();
      e.preventDefault();
      dragging = true;
      capturedId = e.pointerId;
      startX = e.clientX; startY = e.clientY;
      startEX = embed.x;  startEY = embed.y;
      handle.setPointerCapture(e.pointerId);
      el.style.cursor = 'grabbing';
      handle.style.cursor = 'grabbing';
    });

    handle.addEventListener('pointermove', e => {
      if (!dragging || e.pointerId !== capturedId) return;
      const dx = (e.clientX - startX) / this.engine.scale;
      const dy = (e.clientY - startY) / this.engine.scale;
      embed.x = startEX + dx;
      embed.y = startEY + dy;
      el.style.left = embed.x + 'px';
      el.style.top  = embed.y + 'px';
    });

    const endDrag = e => {
      if (!dragging || e.pointerId !== capturedId) return;
      dragging = false;
      el.style.cursor = fullCard ? 'grab' : '';
      handle.style.cursor = '';
      this.engine.updateEmbedPosition(embed.id, embed.x, embed.y);
    };
    handle.addEventListener('pointerup',     endDrag);
    handle.addEventListener('pointercancel', endDrag);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function _makeDragBar(onClose) {
  const bar = document.createElement('div');
  bar.className = 'embed-drag-bar';
  const icon = document.createElement('span');
  icon.className = 'embed-drag-bar-icon';
  icon.textContent = '⠿ ⠿';
  bar.appendChild(icon);
  bar.appendChild(_makeCloseSmall(onClose));
  return bar;
}

function _makeClose(onClick) {
  const btn = document.createElement('button');
  btn.className = 'embed-close';
  btn.innerHTML = '&times;';
  btn.addEventListener('pointerdown', e => e.stopPropagation());
  btn.addEventListener('click', e => { e.stopPropagation(); onClick(); });
  return btn;
}

function _makeCloseSmall(onClick) {
  const btn = document.createElement('button');
  btn.className = 'embed-close-sm';
  btn.innerHTML = '&times;';
  btn.addEventListener('pointerdown', e => e.stopPropagation());
  btn.addEventListener('click', e => { e.stopPropagation(); onClick(); });
  return btn;
}

function _autoResize(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = textarea.scrollHeight + 'px';
}

function _highlightCode(codeEl, content, language) {
  const hljs = window.hljs;
  if (!hljs) { codeEl.textContent = content; return; }
  try {
    const result = (language && language !== 'auto')
      ? hljs.highlight(content, { language })
      : hljs.highlightAuto(content);
    codeEl.innerHTML = result.value;
  } catch {
    codeEl.textContent = content;
  }
}

function _setCodeEmpty(pre, empty) {
  pre.classList.toggle('embed-code-pre-empty', empty);
}

function escapeHtml(s) {
  return s?.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') ?? '';
}
