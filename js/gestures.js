/**
 * gestures.js — смысловые жесты графика ЭК поверх touch.js.
 * gestures.js — semantic EQ-graph gestures on top of touch.js.
 *
 *  1 палец по узлу ............ перемещение (freq / gain, у срезов — Q)
 *  1 finger on node ........... move (freq / gain, Q for cut filters)
 *  2 пальца pinch ............. Q узла / node Q
 *  2 пальца вертикально ....... Gain узла / node gain
 *  long press (500 мс) узел ... удалить / delete
 *  long press пусто ........... контекстное меню / context menu
 *  double tap узел ............ сброс к дефолту / reset to default
 *  double tap пусто ........... новая полоса / new band
 *  tap узел ................... выбор + панель параметров / select + parameter sheet
 *  быстрый свайп ←/→ по узлу .. смена типа фильтра / cycle filter type
 *  3 пальца свайп вниз ........ сброс всех полос / reset all bands
 *  2 пальца pinch по пустому .. зум частоты/усиления / zoom freq/gain
 */
import { PointerGestures, haptics } from './touch.js';
import { GAINLESS, FILTER_LABELS, clamp } from './dsp.js';
import { nodeGainFactor } from './ui.js';
import { autoTypeFor, BAND_COLORS } from './eq.js';
import { DS_DEFAULTS, DS_PARAMS } from './detection.js';
import { fmtHz, fmtDb } from './graph.js';

export class GraphGestures {
  /**
   * @param {import('./ui.js').EQGraph} graph
   * @param {object} hooks { openSheet(band), closeSheet(), contextMenu(band|null, p, freq, gain), toast(msg, opts), unlock() }
   */
  constructor(graph, hooks) {
    this.g = graph;
    this.hooks = hooks;
    this.target = null;   // id полосы под пальцем / band id under the finger
    this.start = null;
    this.multi = null;
    this.grabPeak = null;
    this._lastZeroSide = 0;

    this.pg = new PointerGestures(graph.svg, {
      down: (p) => this._down(p),
      up: () => this._up(),
      tap: (p) => this._tap(p),
      doubleTap: (p) => this._doubleTap(p),
      longPress: (p) => this._longPress(p),
      dragStart: (i) => this._dragStart(i),
      dragMove: (i) => this._dragMove(i),
      dragEnd: (i, o) => this._dragEnd(i, o),
      multiStart: (i) => this._multiStart(i),
      multiMove: (i) => this._multiMove(i),
      multiEnd: (i, o) => this._multiEnd(i, o),
      hover: (p) => this._hover(p),
      hoverEnd: () => this._hoverEnd()
    });

    // Правый клик мышью → контекстное меню / right click → context menu
    graph.svg.addEventListener('contextmenu', (e) => {
      if (this.pg._lastType && this.pg._lastType !== 'mouse') return;
      e.preventDefault();
      const r = graph.svg.getBoundingClientRect();
      const p = { x: e.clientX - r.left, y: e.clientY - r.top, type: 'mouse' };
      const b = graph.hitTest(p.x, p.y, 'mouse');
      if (b) this.model.select(b.id);
      this.hooks.contextMenu(b, { clientX: e.clientX, clientY: e.clientY }, graph.xToFreq(p.x), graph.yToGain(p.y));
    });

    // Колесо: Q узла, Ctrl/⌘ — усиление; по пустому с Ctrl — диапазон дБ.
    // Wheel: node Q, Ctrl/⌘ — gain; on empty area with Ctrl — dB range.
    graph.svg.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
  }

  get model() { return this.g.model; }

  _band(id = this.target) { return id ? this.model?.getBand(id) : null; }

  /* ---------------- касание / touch ---------------- */

  _down(p) {
    this.hooks.unlock?.();
    if (!this.model) return;
    const b = this.g.hitTest(p.x, p.y, p.type);
    this.target = b ? b.id : null;
    this.grabPeak = null;
    if (b) {
      if (this.model.selectedId !== b.id) haptics.select();
      this.model.select(b.id);
      this.g.dragId = b.id;
      this.g.invalidate();
    } else if (this.model.settings.grab) {
      this.g.showPeaks = true;
      this.grabPeak = this.g.peakNear(p.x, p.y, p.type === 'mouse' ? 18 : 32);
    }
  }

  _up() {
    this.g.dragId = null;
    this.g.hideLoupe();
    if (this.pg._lastType !== 'mouse') this.g.showPeaks = false;
    this.g.invalidate();
  }

  _tap(p) {
    if (!this.model) return;
    const b = this._band();
    if (b) {
      this.g.ripple(p.x, p.y, BAND_COLORS[b.color]);
      this.hooks.openSheet(b);
      if (p.type !== 'mouse') this.g.showTip(b, 1500); // tooltip по касанию, не по hover
    } else {
      this.model.select(null);
      this.hooks.closeSheet?.();
      this.g.showTip(null);
    }
  }

  _doubleTap(p) {
    if (!this.model) return;
    const b = this.g.hitTest(p.x, p.y, p.type);
    if (b) {
      this.model.resetBand(b.id);
      haptics.select();
      this.g.ripple(p.x, p.y, BAND_COLORS[b.color]);
      this.hooks.toast(`Полоса ${this.model.bands.indexOf(b) + 1} сброшена`);
      return;
    }
    const freq = this.g.xToFreq(p.x);
    const type = autoTypeFor(freq);
    const gain = GAINLESS.has(type) ? 0 : clamp(this.g.yToGain(p.y) / (nodeGainFactor(type) || 1), -30, 30);
    const nb = this.model.addBand({ freq, gain: Math.round(gain * 10) / 10, type });
    if (nb) {
      haptics.select();
      this.g.ripple(p.x, p.y, BAND_COLORS[nb.color]);
      this.hooks.openSheet(nb);
    } else {
      this.hooks.toast(`Достигнут лимит полос: ${this.model.maxBands}`, { action: { label: 'Настройки', fn: () => this.hooks.openDrawer?.() } });
    }
  }

  _longPress(p) {
    if (!this.model) return;
    const b = this._band();
    if (b) {
      const idx = this.model.bands.indexOf(b) + 1;
      haptics.heavy();
      this.model.removeBand(b.id);
      this.g.dragId = null;
      this.hooks.closeSheet?.();
      this.hooks.toast(`Полоса ${idx} удалена`, { action: { label: 'Отменить', fn: () => this.model.undo() } });
      this.target = null;
      return;
    }
    haptics.select();
    const r = this.g.svg.getBoundingClientRect();
    this.hooks.contextMenu(null, { clientX: p.x + r.left, clientY: p.y + r.top }, this.g.xToFreq(p.x), this.g.yToGain(p.y));
  }

  /* ---------------- перетаскивание / drag ---------------- */

  _dragStart(info) {
    if (!this.model) return;
    if (!this.target && this.grabPeak) {
      // Spectrum Grab: создаём полосу на пике и сразу тянем её.
      // Spectrum Grab: create a band on the peak and drag it right away.
      const nb = this.model.addBand({ freq: this.grabPeak.freq, gain: 0, type: 'bell', q: 4 });
      if (nb) { this.target = nb.id; this.g.dragId = nb.id; haptics.select(); }
      this.grabPeak = null;
    }
    const b = this._band();
    if (!b) return;
    this.model.begin();
    const pos = this.g.nodePos(b);
    this.start = { freq: b.freq, gain: b.gain, q: b.q, x: pos.x, y: pos.y, type: b.type };
    this._lastZeroSide = Math.sign(b.gain);
    this.g.showTip(null);
  }

  _dragMove(info) {
    const b = this._band();
    if (!b || !this.start) return;
    const fine = info.cur.shift ? 0.15 : 1; // Shift — точная подстройка / fine adjust
    const x = this.start.x + info.dx * fine;
    const patch = { freq: clamp(this.g.xToFreq(x), 10, 30000) };
    if (GAINLESS.has(b.type)) {
      patch.q = clamp(this.start.q * Math.pow(2, (-info.dy * fine) / 60), 0.025, 40);
    } else {
      const f = nodeGainFactor(b.type) || 1;
      let gain = this.g.yToGain(this.start.y + info.dy * fine) / f;
      // Прилипание к 0 дБ для пальца / 0 dB snap for fingers
      if (info.type !== 'mouse' && Math.abs(gain) < 0.35) gain = 0;
      patch.gain = clamp(gain, -30, 30);
      const side = Math.sign(patch.gain);
      if (side !== this._lastZeroSide) { haptics.tick(); this._lastZeroSide = side; }
    }
    this.model.updateBand(b.id, patch);
    this.g.renderNow();
    if (info.type === 'mouse') this.g.showTip(b);
    else {
      const p = this.g.nodePos(b);
      this.g.showLoupe(p.x, p.y, b);
    }
  }

  _dragEnd(info, { interrupted, cancelled } = {}) {
    this.g.hideLoupe();
    const b = this._band();
    if (!b || !this.start) { this.start = null; return; }
    if (interrupted) return; // продолжится мультитачем / continues as multi-touch
    // Быстрый горизонтальный флик = свайп смены типа (откатываем перемещение).
    // Fast horizontal flick = type-cycle swipe (revert the move).
    const isSwipe = info.type !== 'mouse' && info.duration < 260 && Math.abs(info.dx) > 45 &&
      Math.abs(info.dy) < Math.abs(info.dx) * 0.45 && Math.abs(info.vx) > 0.3;
    if (isSwipe && !cancelled) {
      this.model.cancelGesture();
      this.model.cycleType(b.id, info.dx > 0 ? 1 : -1);
      haptics.select();
      const nb = this.model.getBand(b.id);
      this.hooks.toast(`${FILTER_LABELS[nb.type]}`, { short: true });
    } else if (cancelled) {
      this.model.cancelGesture();
    } else {
      this.model.commit();
    }
    this.start = null;
    if (info.type === 'mouse') this.g.showTip(this.model.getBand(b.id), 900);
  }

  /* ---------------- мультитач / multi-touch ---------------- */

  _multiStart(info) {
    if (!this.model) return;
    const sel = this.model.selected;
    let nodeId = this.target;
    if (!nodeId && sel) {
      const p = this.g.nodePos(sel);
      if (Math.hypot(p.x - info.centroid.x, p.y - info.centroid.y) < 110) nodeId = sel.id;
    }
    this.g.hideLoupe();
    if (nodeId) {
      const b = this._band(nodeId);
      this.model.begin();
      this.multi = { kind: 'node', id: nodeId, q0: b.q, gain0: b.gain, y0: this.g.nodePos(b).y };
      this.g.dragId = nodeId;
    } else {
      const v = this.g.view;
      this.multi = { kind: 'zoom', fMin: v.fMin, fMax: v.fMax, range: v.range, cf: this.g.xToFreq(info.centroid.x), cx: info.centroid.x };
    }
  }

  _multiMove(info) {
    const m = this.multi;
    if (!m || info.count >= 3) return;
    if (m.kind === 'node') {
      const b = this._band(m.id);
      if (!b) return;
      const patch = {};
      // Pinch: разводим пальцы → шире полоса → меньше Q / spread → wider → lower Q
      if (Math.abs(info.scale - 1) > 0.05) patch.q = clamp(m.q0 / info.scale, 0.025, 40);
      // Вертикальный свайп двумя пальцами → Gain / two-finger vertical swipe → gain
      if (!GAINLESS.has(b.type) && Math.abs(info.dy) > 6) {
        const f = nodeGainFactor(b.type) || 1;
        const dGain = (this.g.yToGain(m.y0 + info.dy) - this.g.yToGain(m.y0)) / f;
        patch.gain = clamp(m.gain0 + dGain, -30, 30);
      }
      if (Object.keys(patch).length) {
        this.model.updateBand(b.id, patch);
        this.g.showTip(this.model.getBand(b.id));
        this.g.renderNow();
      }
    } else {
      // Зум графика: горизонталь → частота, вертикаль → диапазон дБ.
      // Graph zoom: horizontal → frequency, vertical → dB range.
      const span0 = Math.log(m.fMax / m.fMin);
      const span = span0 / clamp(info.scaleX, 0.2, 8);
      const rel = m.cx / this.g.w;
      const lc = Math.log(m.cf) - (info.dx / this.g.w) * span;
      const fMin = Math.exp(lc - rel * span), fMax = Math.exp(lc + (1 - rel) * span);
      const range = m.range / clamp(info.scaleY, 0.2, 8);
      this.g.setZoom({ fMin, fMax, range });
    }
  }

  _multiEnd(info, { cancelled } = {}) {
    const m = this.multi;
    this.multi = null;
    this.g.showTip(null);
    if (info.count >= 3) {
      if (m && m.kind === 'node') this.model.cancelGesture();
      if (!cancelled && info.dy > 70 && Math.abs(info.dx) < 90 && this.model?.bands.length) {
        this.model.resetAll();
        haptics.heavy();
        this.hooks.closeSheet?.();
        this.hooks.toast('Все полосы сброшены', { action: { label: 'Отменить', fn: () => this.model.undo() } });
      }
      return;
    }
    if (m && m.kind === 'node') this.model.commit();
    if (m && m.kind === 'zoom') this.hooks.zoomChanged?.();
  }

  /* ---------------- мышь / mouse ---------------- */

  _hover(p) {
    if (!this.model) return;
    const b = this.g.hitTest(p.x, p.y, 'mouse');
    const id = b ? b.id : null;
    this.g.svg.style.cursor = b ? 'grab' : (this.model.settings.grab && this.g.peakNear(p.x, p.y, 18) ? 'copy' : 'crosshair');
    this.g.showPeaks = this.model.settings.grab && p.y > this.g.h * 0.15;
    if (id !== this.g.hoverId) {
      this.g.hoverId = id;
      this.g.invalidate();
      this.g.showTip(b);
    }
  }

  _hoverEnd() {
    this.g.hoverId = null;
    this.g.showPeaks = false;
    this.g.showTip(null);
    this.g.invalidate();
  }

  _wheel(e) {
    if (!this.model) return;
    const r = this.g.svg.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const b = this.g.hitTest(x, y, 'mouse') || (this.g.hoverId && this.model.getBand(this.g.hoverId));
    const d = clamp(-e.deltaY, -120, 120) / 120;
    e.preventDefault();
    if (b) {
      this.model.begin();
      if (e.ctrlKey || e.metaKey) {
        if (!GAINLESS.has(b.type)) this.model.updateBand(b.id, { gain: clamp(b.gain + d * 0.5, -30, 30) });
      } else {
        this.model.updateBand(b.id, { q: clamp(b.q * Math.pow(1.12, d), 0.025, 40) });
      }
      // Коммит с задержкой: серия прокруток = одна запись истории / debounced commit
      clearTimeout(this._wheelT);
      this._wheelT = setTimeout(() => this.model.commit(), 400);
      this.g.showTip(this.model.getBand(b.id));
    } else if (e.ctrlKey || e.metaKey) {
      this.g.setZoom({ range: this.g.view.range * Math.pow(1.15, -d) });
    } else {
      // Прокрутка по пустому: зум частоты вокруг курсора / zoom frequency around cursor
      const v = this.g.view;
      const cf = Math.log(this.g.xToFreq(x));
      const k = Math.pow(1.15, -d);
      this.g.setZoom({ fMin: Math.exp(cf - (cf - Math.log(v.fMin)) * k), fMax: Math.exp(cf + (Math.log(v.fMax) - cf) * k) });
      this.hooks.zoomChanged?.();
    }
  }
}


/* ======================================================================
 * Жесты Movexe DeEss / Movexe DeEss gestures
 *
 *  1 палец по узлу ........ частота (→) и порог (↕)
 *  2 пальца вертикально ... порог
 *  2 пальца горизонтально . частота
 *  long press (500 мс) .... узел — сброс частоты и порога; пусто — сброс выбранного параметра
 *  double tap ............. обход вкл/выкл
 *  tap .................... выбор параметра + открытие панели
 *  колесо (desktop) ....... порог; Shift+колесо — частота
 * ====================================================================== */
export class DeEssGestures {
  /**
   * @param {import('./graph.js').DeEssGraph} graph
   * @param {object} hooks { openSheet(), toast(msg, o), unlock() }
   */
  constructor(graph, hooks) {
    this.g = graph;
    this.hooks = hooks;
    this.onNode = false;
    this.start = null;
    this.multi = null;
    this.pg = new PointerGestures(graph.svg, {
      down: (p) => this._down(p),
      up: () => this._up(),
      tap: (p) => this._tap(p),
      doubleTap: (p) => this._doubleTap(p),
      longPress: (p) => this._longPress(p),
      dragStart: (i) => this._dragStart(i),
      dragMove: (i) => this._dragMove(i),
      dragEnd: (i, o) => this._dragEnd(i, o),
      multiStart: (i) => this._multiStart(i),
      multiMove: (i) => this._multiMove(i),
      multiEnd: () => this._multiEnd(),
      hover: (p) => this._hover(p),
      hoverEnd: () => { this.g.hover = false; this.g.showTip(null); }
    });
    graph.svg.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
  }

  get model() { return this.g.model; }

  _tipFor(x, y, ms = 0) {
    const p = this.model.params;
    this.g.showTip(`<b style="color:var(--ds)">Детекция</b><br>${fmtHz(p.frequency)}<br>Порог ${fmtDb(p.threshold)}`, x, y, ms);
  }

  _down(p) {
    this.hooks.unlock?.();
    if (!this.model) return;
    this.onNode = this.g.hitNode(p.x, p.y, p.type);
    if (this.onNode) { this.g.dragging = true; haptics.select(); }
  }

  _up() { this.g.dragging = false; this.g.hideLoupe(); }

  _tap(p) {
    if (!this.model) return;
    let key = null;
    if (this.onNode) key = 'frequency';
    else if (this.g.hitThreshold(p.x, p.y)) key = 'threshold';
    if (key) this.model.select(key);
    this.g.ripple(p.x, p.y);
    this.hooks.openSheet();
    // Подсказка по касанию (на touch нет hover) / tooltip on touch (no hover)
    if (p.type !== 'mouse') { const n = this.g.nodePos(); this._tipFor(n.x, n.y, 1500); }
  }

  _doubleTap(p) {
    if (!this.model) return;
    const on = !this.model.params.bypass;
    this.model.set({ bypass: on }, { history: false });
    haptics.heavy();
    this.g.ripple(p.x, p.y);
    this.hooks.toast(on ? 'Обход включён' : 'Обход выключен', { short: true });
  }

  _longPress(p) {
    if (!this.model) return;
    haptics.heavy();
    if (this.onNode) {
      this.model.reset(['frequency', 'threshold']);
      this.hooks.toast('Частота и порог сброшены', { action: { label: 'Отменить', fn: () => this.model.undo() } });
    } else {
      const k = this.model.selected;
      if (!(k in DS_DEFAULTS)) return;
      this.model.reset([k]);
      this.hooks.toast(`«${DS_PARAMS[k]?.label || k}» сброшен`, { action: { label: 'Отменить', fn: () => this.model.undo() } });
    }
    this.g.dragging = false;
  }

  _dragStart() {
    if (!this.onNode || !this.model) return;
    const pos = this.g.nodePos();
    this.model.begin();
    this.start = { x: pos.x, y: pos.y };
    this.g.showTip(null);
  }

  _dragMove(i) {
    if (!this.start) return;
    const fine = i.cur.shift ? 0.15 : 1;
    const patch = { frequency: clamp(this.g.xToFreq(this.start.x + i.dx * fine), 1000, 20000) };
    // При автопороге узел по вертикали не двигается / with auto threshold only frequency moves
    if (!this.model.params.autoThreshold) patch.threshold = clamp(this.g.yToSpec(this.start.y + i.dy * fine), -60, 0);
    this.model.set(patch);
    const n = this.g.nodePos();
    const p = this.model.params;
    const text = `${fmtHz(p.frequency)} · ${fmtDb(p.threshold)}`;
    if (i.type === 'mouse') this._tipFor(n.x, n.y);
    else this.g.showLoupe(n.x, n.y, text);
  }

  _dragEnd() {
    this.g.hideLoupe();
    if (!this.start) return;
    this.start = null;
    this.model.commit();
  }

  _multiStart() {
    if (!this.model) return;
    this.g.hideLoupe();
    if (this.start) this.start = null;
    this.model.begin();
    this.multi = { f0: this.model.params.frequency, t0: this.model.params.threshold, axis: null };
  }

  _multiMove(i) {
    const m = this.multi;
    if (!m || i.count > 2) return;
    // Ось выбирается по первому заметному движению — без случайных смещений второй оси.
    // The axis locks on the first clear movement — no accidental drift on the other one.
    if (!m.axis && Math.hypot(i.dx, i.dy) > 12) m.axis = Math.abs(i.dy) > Math.abs(i.dx) ? 'y' : 'x';
    if (m.axis === 'y' && !this.model.params.autoThreshold) {
      const dDb = (-i.dy / (this.g.h - this.g.padTop - this.g.padBottom)) * 90;
      this.model.set({ threshold: clamp(m.t0 + dDb * 0.6, -60, 0) });
      this.model.select('threshold');
    } else if (m.axis === 'x') {
      const oct = (i.dx / this.g.w) * Math.log2(1000) * 0.8;
      this.model.set({ frequency: clamp(m.f0 * Math.pow(2, oct), 1000, 20000) });
      this.model.select('frequency');
    }
    const n = this.g.nodePos();
    this._tipFor(n.x, n.y);
  }

  _multiEnd() {
    if (!this.multi) return;
    this.multi = null;
    this.model.commit();
    haptics.tick();
    this.g.showTip(null);
  }

  _hover(p) {
    if (!this.model) return;
    const on = this.g.hitNode(p.x, p.y, 'mouse');
    this.g.svg.style.cursor = on ? 'grab' : this.g.hitThreshold(p.x, p.y) ? 'ns-resize' : 'default';
    if (on !== this.g.hover) {
      this.g.hover = on;
      if (on) { const n = this.g.nodePos(); this._tipFor(n.x, n.y); } else this.g.showTip(null);
    }
  }

  _wheel(e) {
    if (!this.model) return;
    e.preventDefault();
    const d = clamp(-e.deltaY, -120, 120) / 120;
    this.model.begin();
    if (e.shiftKey) this.model.set({ frequency: clamp(this.model.params.frequency * Math.pow(2, d / 12), 1000, 20000) });
    else if (!this.model.params.autoThreshold) this.model.set({ threshold: clamp(this.model.params.threshold + d * 0.5, -60, 0) });
    clearTimeout(this._wt);
    this._wt = setTimeout(() => this.model.commit(), 400);
  }
}
