/**
 * touch.js — низкоуровневое распознавание касаний на Pointer Events.
 * touch.js — low-level touch recognition on top of Pointer Events.
 *
 * Единый код для мыши, пальца и стилуса (Pointer Events API, без дублирования touch- и mouse-событий).
 * One code path for mouse, finger and pen (Pointer Events, no duplicated touch and mouse handlers).
 *
 * Распознаёт / Recognises:
 *   tap, doubleTap, longPress (500 мс), drag (1 палец), multi (2–3 пальца: pinch/swipe),
 *   а также скорость/длительность для классификации свайпов.
 *   plus velocity/duration so higher layers can classify swipes.
 */

export const LONG_PRESS_MS = 500;
const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_DIST = 36;

/** Порог «сдвига» до начала drag: палец дрожит сильнее мыши. Drag slop: fingers jitter more than a mouse. */
const slopFor = (type) => (type === 'mouse' ? 3 : 9);

export class PointerGestures {
  /**
   * @param {HTMLElement|SVGElement} el
   * @param {object} h handlers
   */
  constructor(el, h = {}) {
    this.el = el;
    this.h = h;
    this.pointers = new Map();
    this.mode = 'idle'; // idle | pending | drag | multi
    this.rect = null;
    this.lastTap = null;
    this._lp = 0;
    this._raf = 0;
    this._pendingMove = false;
    this.multi = null;

    this._down = this._down.bind(this);
    this._move = this._move.bind(this);
    this._up = this._up.bind(this);
    this._hover = this._hover.bind(this);
    this._frame = this._frame.bind(this);

    el.addEventListener('pointerdown', this._down);
    el.addEventListener('pointermove', this._move);
    el.addEventListener('pointerup', this._up);
    el.addEventListener('pointercancel', this._up);
    el.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && !this.pointers.size) this.h.hoverEnd?.(); });
    // Хак iOS: блокируем системное контекстное меню/лупу при long press.
    // iOS hack: block the system context menu / magnifier on long press.
    el.addEventListener('contextmenu', (e) => {
      if (this._lastType !== 'mouse') e.preventDefault();
    });
    // Хак Safari: gesturestart (нестандартный pinch) масштабирует страницу — отключаем.
    // Safari hack: non-standard gesturestart pinch would zoom the page — cancel it.
    el.addEventListener('gesturestart', (e) => e.preventDefault());
  }

  _pt(e) {
    const r = this.rect || this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, id: e.pointerId, type: e.pointerType, t: performance.now(), target: e.target, button: e.button, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey };
  }

  _down(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return; // правую кнопку обрабатывает contextmenu
    this._lastType = e.pointerType;
    if (!this.pointers.size) this.rect = this.el.getBoundingClientRect();
    try { this.el.setPointerCapture(e.pointerId); } catch { /* noop */ }
    const p = this._pt(e);
    this.pointers.set(e.pointerId, { start: p, cur: p, prev: p });

    if (this.pointers.size === 1) {
      this.mode = 'pending';
      this.primary = p;
      this.h.down?.(p);
      clearTimeout(this._lp);
      this._lp = setTimeout(() => {
        if (this.mode === 'pending' && this.pointers.size === 1) {
          this.mode = 'consumed';
          this.h.longPress?.(this.primary);
        }
      }, LONG_PRESS_MS);
    } else {
      clearTimeout(this._lp);
      if (this.mode === 'drag') this.h.dragEnd?.(this._dragInfo(), { interrupted: true });
      this._startMulti();
    }
  }

  _startMulti() {
    this.mode = 'multi';
    const c = this._centroid();
    this.multi = {
      count: this.pointers.size,
      maxCount: this.pointers.size,
      c0: c, dist0: this._spread(), spreadX0: this._spreadAxis('x'), spreadY0: this._spreadAxis('y'),
      t0: performance.now(), primaryStart: this.primary
    };
    this.h.multiStart?.(this._multiInfo());
  }

  _centroid() {
    let x = 0, y = 0;
    for (const { cur } of this.pointers.values()) { x += cur.x; y += cur.y; }
    const n = this.pointers.size || 1;
    return { x: x / n, y: y / n };
  }

  _spread() {
    const pts = [...this.pointers.values()].map((p) => p.cur);
    if (pts.length < 2) return 1;
    return Math.max(1, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y));
  }

  _spreadAxis(axis) {
    const pts = [...this.pointers.values()].map((p) => p.cur);
    if (pts.length < 2) return 1;
    return Math.max(12, Math.abs(pts[0][axis] - pts[1][axis]));
  }

  _multiInfo() {
    const m = this.multi;
    const c = this._centroid();
    return {
      count: m.maxCount,
      centroid: c,
      start: m.c0,
      dx: c.x - m.c0.x,
      dy: c.y - m.c0.y,
      scale: this._spread() / m.dist0,
      scaleX: this._spreadAxis('x') / m.spreadX0,
      scaleY: this._spreadAxis('y') / m.spreadY0,
      duration: performance.now() - m.t0,
      primaryStart: m.primaryStart
    };
  }

  _dragInfo() {
    const p = this.pointers.get(this.primary.id) || { start: this.primary, cur: this.primary, prev: this.primary };
    const dt = Math.max(1, p.cur.t - p.start.t);
    return {
      start: p.start, cur: p.cur,
      dx: p.cur.x - p.start.x, dy: p.cur.y - p.start.y,
      duration: dt,
      vx: (p.cur.x - p.start.x) / dt, vy: (p.cur.y - p.start.y) / dt,
      type: p.start.type
    };
  }

  _hover(e) { this.h.hover?.(this._pt(e)); }

  _move(e) {
    const rec = this.pointers.get(e.pointerId);
    if (!rec) {
      if (e.pointerType === 'mouse') { this.rect = this.el.getBoundingClientRect(); this._hover(e); }
      return;
    }
    rec.prev = rec.cur;
    rec.cur = this._pt(e);
    if (this.mode === 'pending' && e.pointerId === this.primary.id) {
      const d = Math.hypot(rec.cur.x - rec.start.x, rec.cur.y - rec.start.y);
      if (d > slopFor(e.pointerType)) {
        clearTimeout(this._lp);
        this.mode = 'drag';
        this.h.dragStart?.(this._dragInfo());
      }
    }
    // Throttle: не чаще одного обновления за кадр (≤ 60 fps) / at most one update per frame.
    if (!this._pendingMove) {
      this._pendingMove = true;
      this._raf = requestAnimationFrame(this._frame);
    }
  }

  _frame() {
    this._pendingMove = false;
    if (this.mode === 'drag') this.h.dragMove?.(this._dragInfo());
    else if (this.mode === 'multi' && this.multi) this.h.multiMove?.(this._multiInfo());
  }

  _up(e) {
    const rec = this.pointers.get(e.pointerId);
    if (!rec) return;
    rec.cur = this._pt(e);
    try { this.el.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    clearTimeout(this._lp);
    const cancelled = e.type === 'pointercancel';

    if (this.mode === 'multi') {
      const info = this._multiInfo();
      this.pointers.delete(e.pointerId);
      if (!this.pointers.size) {
        this.h.multiEnd?.(info, { cancelled });
        this._reset();
      }
      return;
    }

    if (this.mode === 'drag') {
      const info = this._dragInfo();
      this.pointers.delete(e.pointerId);
      this.h.dragEnd?.(info, { cancelled });
      this._reset();
      return;
    }

    if (this.mode === 'pending' && !cancelled) {
      const p = rec.cur;
      const lt = this.lastTap;
      if (lt && p.t - lt.t < DOUBLE_TAP_MS && Math.hypot(p.x - lt.x, p.y - lt.y) < DOUBLE_TAP_DIST) {
        this.lastTap = null;
        this.h.doubleTap?.(rec.start);
      } else {
        this.lastTap = p;
        this.h.tap?.(rec.start);
      }
    }
    this.pointers.delete(e.pointerId);
    if (!this.pointers.size) this._reset();
  }

  _reset() {
    this.mode = 'idle';
    this.multi = null;
    this.pointers.clear();
    cancelAnimationFrame(this._raf);
    this._pendingMove = false;
    this.h.up?.();
  }

  destroy() {
    this.el.removeEventListener('pointerdown', this._down);
    this.el.removeEventListener('pointermove', this._move);
    this.el.removeEventListener('pointerup', this._up);
    this.el.removeEventListener('pointercancel', this._up);
  }
}

/**
 * Тактильный отклик. Feature detection: vibrate есть не везде (нет на iOS Safari).
 * Haptic feedback. Feature-detected: vibrate is missing on iOS Safari.
 */
export const haptics = {
  enabled: true,
  tick() { this._v(8); },
  select() { this._v(15); },
  heavy() { this._v([20, 40, 30]); },
  _v(p) {
    if (!this.enabled || typeof navigator.vibrate !== 'function') return;
    try { navigator.vibrate(p); } catch { /* noop */ }
  }
};
