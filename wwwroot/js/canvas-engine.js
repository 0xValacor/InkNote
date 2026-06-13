import { generateId } from './api.js';

export class CanvasEngine {
  constructor(container, committed, active, embedsLayer) {
    this.container = container;
    this.committed = committed;
    this.active = active;
    this.embedsLayer = embedsLayer;
    this.ctx = committed.getContext('2d');
    this.actCtx = active.getContext('2d');

    this.tx = 0; this.ty = 0; this.scale = 1;

    this.tool = 'pen';
    this.penType = 'pen'; // pen | pencil | brush | marker
    this.color = '#ffffff';
    this.size = 4;
    this.opacity = 1.0;

    this.strokes = [];
    this.embeds = [];
    this.undoStack = [];
    this.redoStack = [];

    this.drawing = false;
    this.panning = false;
    this.lastPan = null;
    this.spaceHeld = false;
    this.altHeld = false;
    this.prevTool = 'pen';
    this.currentStroke = null;
    this.lastPoint = null;

    this.activePointers = new Map();
    this.gestureMode = false;
    this._lastPointerEventMs = 0;

    this._setupEvents();
    this._resize();
  }

  // ─── Serialization ───────────────────────────────────────────────────────

  getData() {
    // Strip ephemeral _* properties (e.g. _cx/_cy used for post-load centering)
    const embeds = this.embeds.map(e => {
      const out = {};
      for (const k of Object.keys(e)) { if (!k.startsWith('_')) out[k] = e[k]; }
      return out;
    });
    return { version: 1, strokes: this.strokes, embeds };
  }

  loadData(data) {
    this.strokes = data.strokes ?? [];
    this.embeds = data.embeds ?? [];
    this.undoStack = [];
    this.redoStack = [];
    this._renderAll();
    this._syncEmbeds();
  }

  // ─── History ─────────────────────────────────────────────────────────────

  undo() {
    const op = this.undoStack.pop();
    if (!op) return;
    this.redoStack.push(op);
    if (op.type === 'stroke') {
      this.strokes = this.strokes.filter(s => s.id !== op.stroke.id);
      this._renderAll();
    } else if (op.type === 'add_embed') {
      this.embeds = this.embeds.filter(e => e.id !== op.embed.id);
      this._syncEmbeds();
    } else if (op.type === 'remove_embed') {
      this.embeds.push(op.embed);
      this._syncEmbeds();
    }
    this._notifyChange();
  }

  redo() {
    const op = this.redoStack.pop();
    if (!op) return;
    this.undoStack.push(op);
    if (op.type === 'stroke') {
      this.strokes.push(op.stroke);
      this._renderStroke(this.ctx, op.stroke);
    } else if (op.type === 'add_embed') {
      this.embeds.push(op.embed);
      this._syncEmbeds();
    } else if (op.type === 'remove_embed') {
      this.embeds = this.embeds.filter(e => e.id !== op.embed.id);
      this._syncEmbeds();
    }
    this._notifyChange();
  }

  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }

  // ─── Embeds ───────────────────────────────────────────────────────────────

  addEmbed(embed) {
    embed.id = embed.id ?? generateId();
    this.embeds.push(embed);
    this.undoStack.push({ type: 'add_embed', embed });
    this.redoStack = [];
    this._syncEmbeds();
    this._notifyChange();
    return embed;
  }

  removeEmbed(id) {
    const embed = this.embeds.find(e => e.id === id);
    if (!embed) return;
    this.embeds = this.embeds.filter(e => e.id !== id);
    this.undoStack.push({ type: 'remove_embed', embed });
    this.redoStack = [];
    this._syncEmbeds();
    this._notifyChange();
  }

  updateEmbedPosition(id, x, y) {
    const embed = this.embeds.find(e => e.id === id);
    if (embed) { embed.x = x; embed.y = y; }
    this._notifyChange();
  }

  updateEmbedContent(id, content) {
    const embed = this.embeds.find(e => e.id === id);
    if (embed) embed.content = content;
    this._notifyChange();
  }

  updateEmbedColor(id, color) {
    const embed = this.embeds.find(e => e.id === id);
    if (embed) embed.color = color;
    this._notifyChange();
  }

  updateEmbedSize(id, width, height) {
    const embed = this.embeds.find(e => e.id === id);
    if (embed) { embed.width = width; embed.height = height; }
    this._notifyChange();
  }

  // ─── Transform ───────────────────────────────────────────────────────────

  panBy(dx, dy) {
    this.tx += dx;
    this.ty += dy;
    this._renderAll();
    this._updateEmbedTransform();
  }

  zoomAt(factor, cx, cy) {
    const newScale = Math.min(10, Math.max(0.05, this.scale * factor));
    const ratio = newScale / this.scale;
    this.tx = cx - (cx - this.tx) * ratio;
    this.ty = cy - (cy - this.ty) * ratio;
    this.scale = newScale;
    this._renderAll();
    this._updateEmbedTransform();
  }

  resetView() {
    this.tx = 0; this.ty = 0; this.scale = 1;
    this._renderAll();
    this._updateEmbedTransform();
  }

  screenToCanvas(sx, sy) {
    return { x: (sx - this.tx) / this.scale, y: (sy - this.ty) / this.scale };
  }

  // ─── Rendering ───────────────────────────────────────────────────────────

  _renderAll() {
    const ctx = this.ctx;
    const w = this.committed.width;
    const h = this.committed.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0f0f14';
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.translate(this.tx, this.ty);
    ctx.scale(this.scale, this.scale);

    const prev = ctx.globalCompositeOperation;
    for (const stroke of this.strokes) {
      ctx.globalCompositeOperation = stroke.tool === 'eraser' ? 'destination-out' : 'source-over';
      this._renderStrokeRaw(ctx, stroke);
    }
    ctx.globalCompositeOperation = prev;
    ctx.restore();
  }

  _renderStroke(ctx, stroke) {
    ctx.save();
    ctx.translate(this.tx, this.ty);
    ctx.scale(this.scale, this.scale);
    ctx.globalCompositeOperation = stroke.tool === 'eraser' ? 'destination-out' : 'source-over';
    this._renderStrokeRaw(ctx, stroke);
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();
  }

  _renderStrokeRaw(ctx, stroke) {
    const pts = stroke.points;
    if (!pts || pts.length === 0) return;

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (stroke.tool === 'eraser') {
      ctx.strokeStyle = 'rgba(0,0,0,1)';
      ctx.lineWidth = stroke.size;
      this._drawSmooth(ctx, pts);
      return;
    }

    const alpha = stroke.opacity ?? 1;

    if (stroke.penType === 'marker') {
      ctx.globalAlpha = alpha * 0.55;
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.size;
      ctx.lineCap = 'square';
      this._drawSmooth(ctx, pts);
    } else if (stroke.penType === 'brush') {
      this._drawBrush(ctx, pts, stroke.color, stroke.size, alpha);
    } else if (stroke.penType === 'pencil') {
      ctx.globalAlpha = alpha * 0.85;
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = Math.max(1, stroke.size * 0.6);
      this._drawSmooth(ctx, pts, true);
    } else {
      // pen (default)
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.size;
      this._drawSmooth(ctx, pts);
    }

    ctx.globalAlpha = 1;
  }

  _drawSmooth(ctx, pts, jitter = false) {
    if (pts.length < 2) {
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = (pts[i].y + pts[i + 1].y) / 2;
      const jx = jitter ? (Math.random() - 0.5) * 0.4 : 0;
      const jy = jitter ? (Math.random() - 0.5) * 0.4 : 0;
      ctx.quadraticCurveTo(pts[i].x + jx, pts[i].y + jy, mx, my);
    }
    ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    ctx.stroke();
  }

  _drawBrush(ctx, pts, color, maxSize, alpha) {
    ctx.fillStyle = color;
    let prev = pts[0];
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i];
      const dist = Math.hypot(p.x - prev.x, p.y - prev.y);
      const steps = Math.max(1, Math.floor(dist / 2));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const x = prev.x + (p.x - prev.x) * t;
        const y = prev.y + (p.y - prev.y) * t;
        const pressure = (prev.pressure ?? 0.5) + ((p.pressure ?? 0.5) - (prev.pressure ?? 0.5)) * t;
        const r = Math.max(1, (0.3 + pressure * 0.7) * maxSize * 0.5);
        ctx.globalAlpha = alpha * 0.15;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      prev = p;
    }
    ctx.globalAlpha = 1;
  }

  _renderActiveStroke() {
    this.actCtx.clearRect(0, 0, this.active.width, this.active.height);
    if (!this.currentStroke || this.currentStroke.points.length === 0) return;
    this.actCtx.save();
    this.actCtx.translate(this.tx, this.ty);
    this.actCtx.scale(this.scale, this.scale);
    if (this.currentStroke.tool === 'eraser') {
      this.actCtx.strokeStyle = 'rgba(255,80,80,0.4)';
      this.actCtx.lineWidth = this.currentStroke.size;
      this.actCtx.lineCap = 'round';
      this.actCtx.globalCompositeOperation = 'source-over';
      this._drawSmooth(this.actCtx, this.currentStroke.points);
    } else {
      this.actCtx.globalCompositeOperation = 'source-over';
      this._renderStrokeRaw(this.actCtx, this.currentStroke);
    }
    this.actCtx.restore();
  }

  // ─── Input handling ───────────────────────────────────────────────────────

  _setupEvents() {
    const el = this.container;
    el.addEventListener('pointerdown', e => {
      this._lastPointerEventMs = Date.now();
      this._onDown(e);
    }, { passive: false });
    el.addEventListener('pointermove', e => this._onMove(e), { passive: false });
    el.addEventListener('pointerup', e => this._onUp(e));
    el.addEventListener('pointercancel', e => this._onUp(e));

    // Touch fallback: activates on browsers/devices where pointer events don't
    // fire reliably on canvas (some tablet WebViews, older iOS Safari, etc.).
    // Skipped when pointer events are working (fired within the last 100 ms).
    el.addEventListener('touchstart', e => {
      if (Date.now() - this._lastPointerEventMs < 100) return;
      e.preventDefault();
      for (const t of e.changedTouches) this._onDown(this._touchSynth(t, 0));
    }, { passive: false });
    el.addEventListener('touchmove', e => {
      if (Date.now() - this._lastPointerEventMs < 100) return;
      e.preventDefault();
      for (const t of e.changedTouches) this._onMove(this._touchSynth(t, -1));
    }, { passive: false });
    el.addEventListener('touchend', e => {
      if (Date.now() - this._lastPointerEventMs < 100) return;
      for (const t of e.changedTouches) this._onUp(this._touchSynth(t, -1));
    });
    el.addEventListener('touchcancel', e => {
      if (Date.now() - this._lastPointerEventMs < 100) return;
      for (const t of e.changedTouches) this._onUp(this._touchSynth(t, -1));
    });

    el.addEventListener('wheel', e => this._onWheel(e), { passive: false });
    el.addEventListener('contextmenu', e => e.preventDefault());

    window.addEventListener('keydown', e => this._onKey(e, true));
    window.addEventListener('keyup', e => this._onKey(e, false));
    window.addEventListener('resize', () => this._resize());
  }

  _touchSynth(t, button) {
    return {
      pointerId: t.identifier,
      clientX: t.clientX,
      clientY: t.clientY,
      pointerType: 'touch',
      button,
      buttons: button === 0 ? 1 : 0,
      pressure: t.force || 0.5,
      preventDefault: () => {}
    };
  }

  _capturePointer(id) {
    try { this.container.setPointerCapture(id); } catch {}
  }

  _onKey(e, down) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    if (e.code === 'Space') {
      e.preventDefault();
      if (down && !this.spaceHeld) {
        this.spaceHeld = true;
        this.prevTool = this.tool;
        this.setTool('pan');
        this.container.style.cursor = 'grab';
      } else if (!down && this.spaceHeld) {
        this.spaceHeld = false;
        this.setTool(this.prevTool);
      }
    }

    if (down && e.code === 'AltLeft') {
      this.altHeld = true;
      if (this.tool !== 'eraser') {
        this.prevTool = this.tool;
        this.setTool('eraser');
      }
    }
    if (!down && e.code === 'AltLeft') {
      this.altHeld = false;
      if (this.prevTool && this.prevTool !== 'eraser') {
        this.setTool(this.prevTool);
      }
    }

    if (down) {
      if (e.code === 'KeyE' && !e.ctrlKey && !e.metaKey) this.toggleEraser();
      if (e.code === 'KeyB' && !e.ctrlKey && !e.metaKey) { this.setTool('pen'); }
      if ((e.code === 'KeyZ') && (e.ctrlKey || e.metaKey) && !e.shiftKey) { e.preventDefault(); this.undo(); }
      if ((e.code === 'KeyZ') && (e.ctrlKey || e.metaKey) && e.shiftKey) { e.preventDefault(); this.redo(); }
      if ((e.code === 'KeyY') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.redo(); }
      if ((e.code === 'Digit0') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.resetView(); }
    }
  }

  _onDown(e) {
    if (this.embedsLayer.contains(e.target)) return;
    // Blur any active textarea/input so Ctrl+V paste fires on the document, not the text field
    const active = document.activeElement;
    if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) active.blur();
    e.preventDefault();
    // Palm rejection: ignore finger touches while a stylus is active
    if (e.pointerType === 'touch' && [...this.activePointers.values()].some(p => p.type === 'pen')) return;

    // Pen priority: if a stylus just came down, cancel any touch-initiated drawing/gesture
    if (e.pointerType === 'pen') {
      for (const [id, p] of this.activePointers) {
        if (p.type === 'touch') this.activePointers.delete(id);
      }
      if (this.gestureMode) {
        this.gestureMode = false;
        this.drawing = false;
        this.currentStroke = null;
        this.actCtx.clearRect(0, 0, this.active.width, this.active.height);
      }
    }

    this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });

    // Two-finger gesture: cancel drawing and enter pinch/pan mode
    if (this.activePointers.size >= 2) {
      if (this.drawing) {
        this.drawing = false;
        this.currentStroke = null;
        this.actCtx.clearRect(0, 0, this.active.width, this.active.height);
      }
      this.panning = false;
      this.gestureMode = true;
      this._capturePointer(e.pointerId);
      return;
    }

    if (e.pointerType === 'mouse' && e.button === 1) {
      this.panning = true;
      this.lastPan = { x: e.clientX, y: e.clientY };
      this.container.style.cursor = 'grabbing';
      this._capturePointer(e.pointerId);
      return;
    }
    if (e.button !== 0) return;

    const rect = this.container.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    if (this.tool === 'pan' || this.spaceHeld) {
      this.panning = true;
      this.lastPan = { x: e.clientX, y: e.clientY };
      this.container.style.cursor = 'grabbing';
      this._capturePointer(e.pointerId);
      return;
    }

    this.drawing = true;
    const cp = this.screenToCanvas(sx, sy);
    this.currentStroke = {
      id: generateId(),
      tool: this.tool,
      penType: this.tool === 'eraser' ? 'eraser' : this.penType,
      color: this.color,
      size: this.tool === 'eraser' ? this.eraserSize ?? 24 : this.size,
      opacity: this.opacity,
      points: [{ x: cp.x, y: cp.y, pressure: e.pressure || 0.5 }]
    };
    this._capturePointer(e.pointerId);
  }

  _onMove(e) {
    e.preventDefault();
    if (this.gestureMode) {
      const ptrsOld = [...this.activePointers.values()].map(p => ({ x: p.x, y: p.y }));
      this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: this.activePointers.get(e.pointerId)?.type });
      const ptrsNew = [...this.activePointers.values()];

      if (ptrsOld.length >= 2 && ptrsNew.length >= 2) {
        const oldDist = Math.hypot(ptrsOld[1].x - ptrsOld[0].x, ptrsOld[1].y - ptrsOld[0].y);
        const newDist = Math.hypot(ptrsNew[1].x - ptrsNew[0].x, ptrsNew[1].y - ptrsNew[0].y);
        const oldMidX = (ptrsOld[0].x + ptrsOld[1].x) / 2;
        const oldMidY = (ptrsOld[0].y + ptrsOld[1].y) / 2;
        const newMidX = (ptrsNew[0].x + ptrsNew[1].x) / 2;
        const newMidY = (ptrsNew[0].y + ptrsNew[1].y) / 2;
        const rect = this.container.getBoundingClientRect();
        if (oldDist > 1) this.zoomAt(newDist / oldDist, newMidX - rect.left, newMidY - rect.top);
        this.panBy(newMidX - oldMidX, newMidY - oldMidY);
      }
      return;
    }

    if (this.activePointers.has(e.pointerId)) {
      this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: this.activePointers.get(e.pointerId).type });
    }

    if (this.panning) {
      const dx = e.clientX - this.lastPan.x;
      const dy = e.clientY - this.lastPan.y;
      this.lastPan = { x: e.clientX, y: e.clientY };
      this.panBy(dx, dy);
      return;
    }
    if (!this.drawing || !this.currentStroke) return;

    const rect = this.container.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const cp = this.screenToCanvas(sx, sy);

    this.currentStroke.points.push({ x: cp.x, y: cp.y, pressure: e.pressure || 0.5 });
    this._renderActiveStroke();
  }

  _onUp(e) {
    this.activePointers.delete(e.pointerId);

    if (this.gestureMode) {
      if (this.activePointers.size < 2) this.gestureMode = false;
      return;
    }

    if (this.panning) {
      this.panning = false;
      this.container.style.cursor = this.tool === 'pan' ? 'grab' : 'crosshair';
      return;
    }
    if (!this.drawing || !this.currentStroke) return;
    this.drawing = false;

    if (this.currentStroke.points.length > 0) {
      this.strokes.push(this.currentStroke);
      this.undoStack.push({ type: 'stroke', stroke: this.currentStroke });
      this.redoStack = [];
      this._renderStroke(this.ctx, this.currentStroke);
      this._notifyChange();
    }
    this.currentStroke = null;
    this.actCtx.clearRect(0, 0, this.active.width, this.active.height);
  }

  _onWheel(e) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const rect = this.container.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      this.zoomAt(e.deltaY < 0 ? 1.1 : 0.9, cx, cy);
    } else {
      this.panBy(-e.deltaX, -e.deltaY);
    }
  }

  // ─── Misc ─────────────────────────────────────────────────────────────────

  setTool(tool) {
    this.tool = tool;
    const cursor = tool === 'pan' ? 'grab' : 'crosshair';
    this.container.style.cursor = cursor;
    this.onToolChange?.(tool);
  }

  toggleEraser() {
    if (this.tool === 'eraser') {
      this.setTool(this.prevTool || 'pen');
    } else {
      this.prevTool = this.tool;
      this.setTool('eraser');
    }
  }

  _resize() {
    const rect = this.container.getBoundingClientRect();
    const w = rect.width || window.innerWidth;
    const h = rect.height || window.innerHeight;
    this.committed.width = w;
    this.committed.height = h;
    this.active.width = w;
    this.active.height = h;
    this._renderAll();
  }

  _updateEmbedTransform() {
    this.embedsLayer.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.scale})`;
    this.embedsLayer.style.transformOrigin = '0 0';
  }

  _syncEmbeds() {
    this.onEmbedsChange?.(this.embeds);
  }

  _notifyChange() {
    this.onChange?.();
  }
}
