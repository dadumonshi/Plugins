/**
 * spectral-editor.js — рисование кривой подавления и правка профиля шума пальцем/мышью.
 * spectral-editor.js — drawing the reduction curve and editing the noise print.
 *
 *  1 палец ........... рисование текущей кистью (Draw / Smooth / Erase)
 *  палец по точке .... перетаскивание выбранной точки
 *  2 пальца (pinch) .. зум по частоте;  2 пальца (pan) — сдвиг по частоте
 *  long press ........ меню кистей и слоя (кривая / профиль)
 *  double tap ........ сброс кривой к профилю (подавление «по профилю»)
 *  tap ............... выбор точки + подсказка
 *  колесо (ПК) ....... зум вокруг курсора; Shift+колесо — сдвиг
 *
 * Ширина кисти задана в пикселях (не в точках кривой) — при любом зуме она одинаково
 * удобна для пальца. Brush width is in pixels, so it suits a finger at any zoom level.
 */
import { PointerGestures, haptics } from './touch.js';
import { CURVE_FREQS } from './spectral.js';
import { fmtHzRu } from './denoise-graph.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const BRUSH_LABELS = { draw: 'Рисовать', smooth: 'Сгладить', erase: 'Стереть' };
export const TARGET_LABELS = { reduction: 'Кривая подавления', profile: 'Профиль шума' };

export class SpectralEditor {
  /**
   * @param {import('./denoise-graph.js').DenoiseGraph} graph
   * @param {object} hooks { unlock(), toast(msg,o), brushMenu(clientX, clientY), openSheet() }
   */
  constructor(graph, hooks) {
    this.g = graph;
    this.hooks = hooks;
    this.stroke = null;
    this.multi = null;
    this.pg = new PointerGestures(graph.svg, {
      down: (p) => this._down(p),
      up: () => { this.g.hideLoupe(); },
      tap: (p) => this._tap(p),
      doubleTap: (p) => this._doubleTap(p),
      longPress: (p) => this._longPress(p),
      dragStart: (i) => this._dragStart(i),
      dragMove: (i) => this._dragMove(i),
      dragEnd: () => this._dragEnd(),
      multiStart: () => this._multiStart(),
      multiMove: (i) => this._multiMove(i),
      multiEnd: () => { this.multi = null; hooks.zoomChanged?.(); },
      hover: (p) => this._hover(p),
      hoverEnd: () => this.g.showTip(null)
    });
    graph.svg.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
  }

  get model() { return this.g.model; }

  /* ---------------- значения кривых / curve values ---------------- */

  /** Рабочая копия кривой без null / working copy of the curve without nulls. */
  _working() {
    const m = this.model;
    const src = m.target === 'reduction' ? m.reductionCurve : m.profileOffset;
    const base = m.target === 'reduction' ? m.params.reduction : 0;
    return CURVE_FREQS.map((_, i) => (src && src[i] != null ? src[i] : base));
  }

  /** Значение под пальцем в единицах кривой / value under the finger in curve units. */
  _valueAt(i, y) {
    const m = this.model;
    if (m.target === 'reduction') return this.g.yToRed(y);
    // Профиль: уровень пальца минус обученный уровень = правка / finger level − learned = offset
    return clamp(this.g.yToDb(y) - this.g._baseProfileAt(CURVE_FREQS[i]), -60, 60);
  }

  /** @param {boolean} short короткий формат для лупы / short format for the loupe */
  _fmt(i, arr, short = false) {
    const m = this.model;
    const f = fmtHzRu(CURVE_FREQS[i]);
    if (m.target === 'reduction') return short ? `${f} · −${arr[i].toFixed(1)} дБ` : `${f} · подавление ${arr[i].toFixed(1)} дБ`;
    const lvl = this.g._baseProfileAt(CURVE_FREQS[i]) + arr[i];
    return short ? `${f} · шум ${lvl.toFixed(0)} дБ` : `${f} · шум ${lvl.toFixed(1)} дБ (${arr[i] >= 0 ? '+' : ''}${arr[i].toFixed(1)})`;
  }

  /** Сохранить рабочую кривую (без правок → null) / store the working curve. */
  _commitArr(arr) {
    const m = this.model;
    const base = m.target === 'reduction' ? m.params.reduction : 0;
    const out = arr.map((v) => (Math.abs(v - base) < 0.05 ? null : Math.round(v * 10) / 10));
    m.setCurve(m.target, out.every((v) => v == null) ? null : out);
  }

  /* ---------------- кисть / brush ---------------- */

  /** Применить кисть в точке экрана (x, y) / apply the brush at (x, y). */
  _applyBrush(arr, x, y, type) {
    const m = this.model;
    const radiusPx = type === 'mouse' ? 14 : 26;       // палец — шире / wider for a finger
    const f0 = this.g.xToFreq(x - radiusPx), f1 = this.g.xToFreq(x + radiusPx);
    const base = m.target === 'reduction' ? m.params.reduction : 0;
    for (let i = 0; i < 96; i++) {
      const f = CURVE_FREQS[i];
      if (f < f0 * 0.9 || f > f1 * 1.1) continue;
      const d = Math.abs(this.g.freqToX(f) - x) / radiusPx;       // 0 в центре / 0 at centre
      const w = d <= 0.5 ? 1 : d >= 1.2 ? 0 : 1 - (d - 0.5) / 0.7; // мягкий край / soft edge
      if (w <= 0) continue;
      if (m.brush === 'draw') arr[i] += (this._valueAt(i, y) - arr[i]) * w;
      else if (m.brush === 'erase') arr[i] += (base - arr[i]) * w * 0.6;
      else {
        const avg = (arr[Math.max(0, i - 1)] + arr[i] + arr[Math.min(95, i + 1)]) / 3;
        arr[i] += (avg - arr[i]) * w * 0.5;
      }
    }
  }

  /* ---------------- жесты / gestures ---------------- */

  _down(p) {
    this.hooks.unlock?.();
    const m = this.model;
    if (!m) return;
    this.onPoint = false;
    if (m.selectedPoint >= 0) {
      const pp = this.g.pointPos(m.selectedPoint);
      this.onPoint = Math.hypot(pp.x - p.x, pp.y - p.y) <= (p.type === 'mouse' ? this.g.nodeR + 6 : this.g.nodeR * 2);
    }
  }

  _tap(p) {
    const m = this.model;
    if (!m) return;
    const i = this.g.nearestPoint(p.x);
    m.selectedPoint = i;
    m.emit('tool');
    haptics.tick();
    this.g.ripple(p.x, p.y);
    const pp = this.g.pointPos(i);
    this.g.showTip(this._fmt(i, this._working()), pp.x, pp.y, p.type === 'mouse' ? 0 : 1800);
    this.hooks.openSheet?.();
  }

  _doubleTap(p) {
    const m = this.model;
    if (!m) return;
    m.resetCurve(m.target);
    haptics.select();
    this.g.ripple(p.x, p.y);
    this.hooks.toast(m.target === 'reduction' ? 'Кривая подавления сброшена к профилю' : 'Правки профиля сброшены',
      { action: { label: 'Отменить', fn: () => m.undo() } });
  }

  _longPress(p) {
    haptics.select();
    const r = this.g.svg.getBoundingClientRect();
    this.hooks.brushMenu(p.x + r.left, p.y + r.top);
  }

  _dragStart(info) {
    const m = this.model;
    if (!m) return;
    m.begin();
    this.stroke = { arr: this._working(), lastX: info.start.x, lastY: info.start.y, point: this.onPoint };
    if (!this.onPoint) this._applyBrush(this.stroke.arr, info.start.x, info.start.y, info.type);
    this.g.showTip(null);
  }

  _dragMove(info) {
    const s = this.stroke;
    if (!s) return;
    const x = info.cur.x, y = info.cur.y;
    const m = this.model;
    if (s.point) {
      // Точка: значение под пальцем, соседи тянутся вполовину / point with half-weight neighbours
      const i = m.selectedPoint;
      const v = this._valueAt(i, y);
      const d = v - s.arr[i];
      s.arr[i] = v;
      if (i > 0) s.arr[i - 1] += d * 0.5;
      if (i < 95) s.arr[i + 1] += d * 0.5;
      if (i > 1) s.arr[i - 2] += d * 0.2;
      if (i < 94) s.arr[i + 2] += d * 0.2;
    } else {
      // Интерполяция между событиями — сплошной мазок даже при быстром движении пальца.
      // Interpolate between events — a continuous stroke even on fast finger moves.
      const steps = Math.max(1, Math.ceil(Math.abs(x - s.lastX) / 4));
      for (let k = 1; k <= steps; k++) {
        const t = k / steps;
        this._applyBrush(s.arr, s.lastX + (x - s.lastX) * t, s.lastY + (y - s.lastY) * t, info.type);
      }
    }
    if (m.target === 'reduction') for (let i = 0; i < 96; i++) s.arr[i] = clamp(s.arr[i], 0, 40);
    s.lastX = x; s.lastY = y;
    this._commitArr(s.arr);
    const i = s.point ? m.selectedPoint : this.g.nearestPoint(x);
    const pp = this.g.pointPos(i);
    if (info.type === 'mouse') this.g.showTip(this._fmt(i, s.arr), pp.x, pp.y);
    else this.g.showLoupe(clamp(x, 0, this.g.w), clamp(y, 0, this.g.h), this._fmt(i, s.arr, true));
  }

  _dragEnd() {
    this.g.hideLoupe();
    if (!this.stroke) return;
    this.stroke = null;
    this.model.commit();
    haptics.tick();
  }

  _multiStart() {
    // Мазок, начатый первым пальцем, отменяется — второй палец означает зум/сдвиг.
    // A stroke begun by the first finger is dropped — a second finger means zoom/pan.
    if (this.stroke) { this.stroke = null; this.model.commit(); }
    this.g.hideLoupe();
    const v = this.g.view;
    this.multi = { fMin: v.fMin, fMax: v.fMax };
  }

  _multiMove(i) {
    const m = this.multi;
    if (!m || i.count > 2) return;
    const span0 = Math.log(m.fMax / m.fMin);
    const span = span0 / clamp(i.scaleX, 0.25, 12);
    const rel = i.start.x / this.g.w;
    const cf = Math.log(m.fMin) + rel * span0 - (i.dx / this.g.w) * span; // pan по центроиду
    this.g.setView(Math.exp(cf - rel * span), Math.exp(cf + (1 - rel) * span));
  }

  _hover(p) {
    const m = this.model;
    if (!m) return;
    const i = this.g.nearestPoint(p.x);
    const pp = this.g.pointPos(i);
    this.g.svg.style.cursor = m.brush === 'erase' ? 'cell' : 'crosshair';
    if (Math.abs(pp.y - p.y) < 24) this.g.showTip(this._fmt(i, this._working()), pp.x, pp.y);
    else this.g.showTip(null);
  }

  _wheel(e) {
    e.preventDefault();
    const r = this.g.svg.getBoundingClientRect();
    const x = e.clientX - r.left;
    const v = this.g.view;
    const d = clamp(-e.deltaY, -120, 120) / 120;
    if (e.shiftKey) {
      const k = Math.pow(v.fMax / v.fMin, -d * 0.08);
      this.g.setView(v.fMin * k, v.fMax * k);
    } else {
      const cf = Math.log(this.g.xToFreq(x)), k = Math.pow(1.15, -d);
      this.g.setView(Math.exp(cf - (cf - Math.log(v.fMin)) * k), Math.exp(cf + (Math.log(v.fMax) - cf) * k));
    }
    this.hooks.zoomChanged?.();
  }
}
