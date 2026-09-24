/**
 * mobile-ui.js — мобильный UI: bottom sheet, крутилки/слайдеры, drawer, контекстное меню,
 * toast, fullscreen, ориентация, определение слабых устройств. Панель параметров полосы.
 *
 * mobile-ui.js — mobile UI: bottom sheet, knobs/sliders, drawer, context menu, toast,
 * fullscreen, orientation, weak-device detection. Band parameter panel.
 */
import { FILTER_TYPES, FILTER_LABELS, SLOPES, PLACEMENTS, GAINLESS, HAS_SLOPE, LIMITS, clamp } from './dsp.js';
import { BAND_COLORS, DEFAULT_Q, EQModel } from './eq.js';
import { fmtFreq, fmtGain, fmtQ } from './ui.js';
import { haptics } from './touch.js';

/* ================================================================== *
 *  Определение возможностей устройства (feature detection, не UA)
 *  Device capability detection (feature detection, no UA sniffing)
 * ================================================================== */
export function detectDevice() {
  const mq = (q) => !!(window.matchMedia && matchMedia(q).matches);
  const cores = navigator.hardwareConcurrency || 4;
  const mem = navigator.deviceMemory || 8; // Chrome-only; иначе считаем достаточной
  const saveData = !!(navigator.connection && navigator.connection.saveData);
  const params = new URLSearchParams(location.search);
  const lowPower = params.has('lowpower') || cores < 4 || mem < 3 || saveData;
  return {
    lowPower,
    coarse: mq('(pointer: coarse)'),
    reducedMotion: mq('(prefers-reduced-motion: reduce)'),
    small: mq('(max-width: 767px)'),
    standalone: mq('(display-mode: standalone)') || navigator.standalone === true, // iOS standalone
    fullscreen: !!(document.fullscreenEnabled || document.webkitFullscreenEnabled),
    vibrate: typeof navigator.vibrate === 'function'
  };
}

/* ================================================================== *
 *  Fullscreen API (с webkit-префиксом для Safari iPad)
 * ================================================================== */
export const fullscreen = {
  get active() { return !!(document.fullscreenElement || document.webkitFullscreenElement); },
  async toggle() {
    try {
      if (this.active) {
        await (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      } else {
        const el = document.documentElement;
        const req = el.requestFullscreen || el.webkitRequestFullscreen;
        await req.call(el, { navigationUI: 'hide' });
        // Android: пытаемся зафиксировать текущую ориентацию (не везде поддерживается).
        // Android: try to keep current orientation locked (not universally supported).
        try { await screen.orientation?.lock?.(screen.orientation.type); } catch { /* not supported */ }
      }
    } catch (e) {
      console.warn('[fullscreen]', e);
    }
  }
};

/** Отслеживание ориентации через matchMedia (надёжнее orientationchange). */
export function watchOrientation(cb) {
  const mq = matchMedia('(orientation: landscape)');
  const fire = () => cb(mq.matches ? 'landscape' : 'portrait');
  // Safari < 14: addListener вместо addEventListener
  if (mq.addEventListener) mq.addEventListener('change', fire); else mq.addListener(fire);
  window.addEventListener('orientationchange', () => setTimeout(fire, 120)); // старые iOS
  fire();
}

/* ================================================================== *
 *  Toast
 * ================================================================== */
export class Toast {
  constructor(el) { this.el = el; this._t = 0; }
  show(msg, { action, short = false } = {}) {
    clearTimeout(this._t);
    this.el.innerHTML = '';
    const span = document.createElement('span');
    span.textContent = msg;
    this.el.appendChild(span);
    if (action) {
      const b = document.createElement('button');
      b.className = 'toast-action';
      b.textContent = action.label;
      b.onclick = () => { action.fn(); this.hide(); };
      this.el.appendChild(b);
    }
    this.el.classList.add('is-on');
    this._t = setTimeout(() => this.hide(), short ? 1300 : action ? 4500 : 2600);
  }
  hide() { this.el.classList.remove('is-on'); }
}

/* ================================================================== *
 *  Контекстное меню (long press / правый клик)
 *  Context menu (long press / right click)
 * ================================================================== */
export class ContextMenu {
  constructor(el) {
    this.el = el;
    this._close = (e) => { if (!this.el.contains(e.target)) this.hide(); };
    this._key = (e) => { if (e.key === 'Escape') this.hide(); };
  }

  show(items, x, y) {
    this.el.innerHTML = '';
    const list = document.createElement('div');
    list.className = 'ctx-list';
    list.setAttribute('role', 'menu');
    for (const it of items) {
      if (it === '-') { const hr = document.createElement('div'); hr.className = 'ctx-sep'; list.appendChild(hr); continue; }
      const b = document.createElement('button');
      b.className = 'ctx-item' + (it.danger ? ' is-danger' : '') + (it.checked ? ' is-checked' : '');
      b.setAttribute('role', 'menuitem');
      b.disabled = !!it.disabled;
      b.innerHTML = `<span class="ctx-sw" style="${it.color ? `background:${it.color}` : ''}"></span><span>${it.label}</span>`;
      b.onclick = () => { this.hide(); it.fn?.(); };
      list.appendChild(b);
    }
    this.el.appendChild(list);
    this.el.classList.add('is-on');
    // Позиционирование с учётом краёв экрана / keep inside viewport
    const r = list.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const left = clamp(x, 8, vw - r.width - 8);
    const top = clamp(y, 8, vh - r.height - 8);
    list.style.left = left + 'px';
    list.style.top = top + 'px';
    setTimeout(() => {
      document.addEventListener('pointerdown', this._close, true);
      document.addEventListener('keydown', this._key);
    }, 0);
    list.querySelector('button:not([disabled])')?.focus({ preventScroll: true });
  }

  hide() {
    this.el.classList.remove('is-on');
    document.removeEventListener('pointerdown', this._close, true);
    document.removeEventListener('keydown', this._key);
  }
}

/* ================================================================== *
 *  Drawer (≡) — второстепенные настройки / secondary settings
 * ================================================================== */
export class Drawer {
  constructor(el, backdrop) {
    this.el = el;
    this.backdrop = backdrop;
    backdrop.addEventListener('click', () => this.close());
    // Свайп влево закрывает / swipe left closes
    let sx = null, sy = 0;
    el.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') { sx = e.clientX; sy = e.clientY; } });
    el.addEventListener('pointerup', (e) => {
      if (sx !== null && sx - e.clientX > 70 && Math.abs(e.clientY - sy) < 60) this.close();
      sx = null;
    });
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.close(); });
  }
  get isOpen() { return this.el.classList.contains('is-open'); }
  open() {
    this.el.classList.add('is-open');
    this.backdrop.classList.add('is-on');
    this.el.setAttribute('aria-hidden', 'false');
    this.el.querySelector('button, select, input')?.focus({ preventScroll: true });
  }
  close() {
    this.el.classList.remove('is-open');
    this.backdrop.classList.remove('is-on');
    this.el.setAttribute('aria-hidden', 'true');
  }
  toggle() { this.isOpen ? this.close() : this.open(); }
}

/* ================================================================== *
 *  Bottom Sheet: hidden → peek → full, свайпы вверх/вниз
 *  Bottom Sheet: hidden → peek → full, swipe up/down
 * ================================================================== */
export class BottomSheet extends EventTarget {
  constructor(el) {
    super();
    this.el = el;
    this.state = 'hidden';
    this.mqSheet = matchMedia('(max-width: 767px) and (orientation: portrait)');
    const upd = () => this._mode();
    if (this.mqSheet.addEventListener) this.mqSheet.addEventListener('change', upd); else this.mqSheet.addListener(upd);
    this._mode();
    // Делегирование: ручки создаются позже (BandPanel) / delegation: handles are created later
    this._bindDrag(el);
  }

  _mode() {
    this.isSheet = this.mqSheet.matches;
    this.el.dataset.mode = this.isSheet ? 'sheet' : 'panel';
    this.el.style.transform = '';
  }

  set(state) {
    if (state === this.state) return;
    this.state = state;
    this.el.dataset.state = state;
    this.el.style.transform = '';
    this.el.setAttribute('aria-hidden', state === 'hidden' ? 'true' : 'false');
    document.documentElement.dataset.sheet = state;
    this.dispatchEvent(new CustomEvent('state', { detail: { state } }));
  }

  _bindDrag(handle) {
    let startY = 0, startT = 0, baseY = 0, dragging = false, moved = false, pid = null;
    const yFor = (state) => {
      const h = this.el.offsetHeight;
      const peek = parseFloat(getComputedStyle(this.el).getPropertyValue('--peek-h')) || 96;
      return state === 'full' ? 0 : state === 'peek' ? h - peek : h + 20;
    };
    let grabbed = null;
    handle.addEventListener('pointerdown', (e) => {
      grabbed = e.target.closest('[data-sheet-handle]');
      if (!this.isSheet || !grabbed || e.target.closest('button, input, select')) return;
      dragging = true; moved = false; pid = e.pointerId;
      startY = e.clientY; startT = performance.now();
      baseY = yFor(this.state);
      try { handle.setPointerCapture(pid); } catch { /* noop */ }
      this.el.classList.add('is-dragging'); // без transition во время drag / no transition while dragging
    });
    handle.addEventListener('pointermove', (e) => {
      if (!dragging || e.pointerId !== pid) return;
      const dy = e.clientY - startY;
      if (Math.abs(dy) > 4) moved = true;
      // Резинка у верхнего края / rubber-band at the top
      let y = baseY + dy;
      if (y < 0) y = y * 0.25;
      this.el.style.transform = `translateY(${y}px)`;
    });
    const end = (e) => {
      if (!dragging || e.pointerId !== pid) return;
      dragging = false;
      this.el.classList.remove('is-dragging');
      const dy = e.clientY - startY;
      const v = dy / Math.max(1, performance.now() - startT); // px/ms
      this.el.style.transform = '';
      if (!moved) { // тап по ручке переключает peek/full / tap on handle toggles
        if (grabbed && grabbed.classList.contains('sheet-grabber')) this.set(this.state === 'full' ? 'peek' : 'full');
        return;
      }
      const order = ['hidden', 'peek', 'full'];
      let idx = order.indexOf(this.state);
      if (Math.abs(v) > 0.45) idx += v < 0 ? 1 : -1; // флик / flick
      else {
        const y = baseY + dy;
        const ys = order.map(yFor);
        idx = ys.reduce((bi, yy, i) => (Math.abs(yy - y) < Math.abs(ys[bi] - y) ? i : bi), 0);
      }
      const next = order[clamp(idx, 0, 2)];
      haptics.tick();
      this.set(next);
      if (next === 'hidden') this.dispatchEvent(new CustomEvent('dismiss'));
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }
}

/* ================================================================== *
 *  Параметр → нормализация / parameter normalisation
 * ================================================================== */
const PARAMS = {
  freq: { min: LIMITS.freqMin, max: LIMITS.freqMax, log: true, label: 'Freq', fmt: (v) => fmtFreq(v) },
  gain: { min: LIMITS.gainMin, max: LIMITS.gainMax, log: false, label: 'Gain', fmt: (v) => fmtGain(v), bipolar: true },
  q: { min: LIMITS.qMin, max: LIMITS.qMax, log: true, label: 'Q', fmt: (v) => fmtQ(v) },
  output: { min: -36, max: 36, log: false, label: 'Output', fmt: (v) => fmtGain(v), bipolar: true }
};
const toNorm = (p, v) => (p.log ? Math.log(v / p.min) / Math.log(p.max / p.min) : (v - p.min) / (p.max - p.min));
const fromNorm = (p, n) => (p.log ? p.min * Math.pow(p.max / p.min, clamp(n, 0, 1)) : p.min + clamp(n, 0, 1) * (p.max - p.min));

/** Разбор ввода «1.2k», «-3», «350hz» / parse user input. */
function parseValue(str) {
  const s = String(str).trim().toLowerCase().replace(',', '.').replace('−', '-');
  const m = s.match(/^([-+]?\d*\.?\d+)\s*(k)?/);
  if (!m) return NaN;
  return parseFloat(m[1]) * (m[2] ? 1000 : 1);
}

/** Базовый регулятор: значение, ввод числа, двойной тап = дефолт. Base control. */
class ParamControl {
  constructor(key, { onBegin, onChange, onEnd, getDefault }) {
    this.key = key;
    this.p = PARAMS[key];
    this.onBegin = onBegin; this.onChange = onChange; this.onEnd = onEnd;
    this.getDefault = getDefault;
    this.value = this.p.min;
    this.root = document.createElement('div');
    this.root.className = 'ctl';
    this.valueBtn = document.createElement('button');
    this.valueBtn.className = 'ctl-value mono';
    this.valueBtn.type = 'button';
    this.valueBtn.title = 'Ввести значение / Type a value';
    this.valueBtn.addEventListener('click', () => this._edit());
    this.labelEl = document.createElement('div');
    this.labelEl.className = 'ctl-label';
    this.labelEl.textContent = this.p.label;
  }

  _edit() {
    const inp = document.createElement('input');
    inp.className = 'ctl-input mono';
    // inputmode=decimal → цифровая клавиатура на телефоне / numeric keypad on phones
    inp.inputMode = 'decimal';
    inp.enterKeyHint = 'done';
    inp.value = String(+this.value.toFixed(2));
    this.valueBtn.replaceWith(inp);
    inp.focus();
    inp.select();
    const done = (apply) => {
      if (!inp.isConnected) return;
      inp.replaceWith(this.valueBtn);
      if (apply) {
        const v = parseValue(inp.value);
        if (Number.isFinite(v)) { this.onBegin(); this.onChange(clamp(v, this.p.min, this.p.max)); this.onEnd(); }
      }
    };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(true); else if (e.key === 'Escape') done(false); });
    inp.addEventListener('blur', () => done(true));
  }

  set(v, disabled = false) {
    this.value = v;
    this.valueBtn.textContent = this.p.fmt(v);
    this.root.classList.toggle('is-disabled', disabled);
    this._render(toNorm(this.p, v));
  }

  setColor(c) { this.root.style.setProperty('--c', c); }
  _render() {}
}

/** Крутилка ≥ 80px: вертикальный/горизонтальный drag. Knob ≥ 80px: vertical/horizontal drag. */
export class Knob extends ParamControl {
  constructor(key, opts) {
    super(key, opts);
    this.root.classList.add('knob');
    this.dial = document.createElement('div');
    this.dial.className = 'knob-dial';
    this.dial.tabIndex = 0;
    this.dial.setAttribute('role', 'slider');
    this.dial.setAttribute('aria-label', this.p.label);
    this.dial.innerHTML = `<svg viewBox="0 0 100 100" aria-hidden="true">
      <circle class="knob-face" cx="50" cy="50" r="36"/>
      <path class="knob-track" d="${this._arc(0, 1)}"/>
      <path class="knob-val" d=""/>
      <line class="knob-ptr" x1="50" y1="50" x2="50" y2="20"/>
    </svg>`;
    this.valPath = this.dial.querySelector('.knob-val');
    this.ptr = this.dial.querySelector('.knob-ptr');
    this.root.append(this.dial, this.labelEl, this.valueBtn);
    this._bind();
  }

  _arc(n0, n1) {
    const a0 = (-135 + 270 * n0) * Math.PI / 180, a1 = (-135 + 270 * n1) * Math.PI / 180;
    const r = 44;
    const p = (a) => `${(50 + r * Math.sin(a)).toFixed(2)} ${(50 - r * Math.cos(a)).toFixed(2)}`;
    const large = Math.abs(a1 - a0) > Math.PI ? 1 : 0;
    const sweep = a1 >= a0 ? 1 : 0;
    return `M ${p(a0)} A ${r} ${r} 0 ${large} ${sweep} ${p(a1)}`;
  }

  _render(n) {
    const from = this.p.bipolar ? 0.5 : 0;
    this.valPath.setAttribute('d', Math.abs(n - from) < 0.002 ? '' : this._arc(Math.min(from, n), Math.max(from, n)));
    this.ptr.setAttribute('transform', `rotate(${-135 + 270 * n} 50 50)`);
    this.dial.setAttribute('aria-valuenow', this.value.toFixed(2));
    this.dial.setAttribute('aria-valuetext', this.p.fmt(this.value));
  }

  _bind() {
    let startN = 0, sx = 0, sy = 0, pid = null, lastTap = 0;
    const d = this.dial;
    d.addEventListener('pointerdown', (e) => {
      if (this.root.classList.contains('is-disabled')) return;
      const now = performance.now();
      if (now - lastTap < 300) { // двойной тап → дефолт / double tap → default
        this.onBegin(); this.onChange(this.getDefault()); this.onEnd(); haptics.tick();
        lastTap = 0; return;
      }
      lastTap = now;
      pid = e.pointerId; sx = e.clientX; sy = e.clientY;
      startN = toNorm(this.p, this.value);
      try { d.setPointerCapture(pid); } catch { /* noop */ }
      this.onBegin();
      d.classList.add('is-active');
    });
    d.addEventListener('pointermove', (e) => {
      if (e.pointerId !== pid) return;
      // 220 px = полный диапазон; Shift — точно / 220 px = full range; Shift = fine
      const k = e.shiftKey ? 0.2 : 1;
      const delta = ((sy - e.clientY) + (e.clientX - sx) * 0.6) / 220 * k;
      this.onChange(fromNorm(this.p, startN + delta));
    });
    const end = (e) => {
      if (e.pointerId !== pid) return;
      pid = null;
      d.classList.remove('is-active');
      this.onEnd();
    };
    d.addEventListener('pointerup', end);
    d.addEventListener('pointercancel', end);
    d.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 0.002 : 0.01;
      let dn = 0;
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') dn = step;
      if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') dn = -step;
      if (!dn) return;
      e.preventDefault();
      this.onBegin(); this.onChange(fromNorm(this.p, toNorm(this.p, this.value) + dn)); this.onEnd();
    });
  }
}

/** Горизонтальный слайдер с крупным thumb (альтернатива крутилкам). Horizontal slider. */
export class HSlider extends ParamControl {
  constructor(key, opts) {
    super(key, opts);
    this.root.classList.add('hslider');
    this.input = document.createElement('input');
    this.input.type = 'range';
    this.input.min = '0'; this.input.max = '1000'; this.input.step = '1';
    this.input.setAttribute('aria-label', this.p.label);
    const head = document.createElement('div');
    head.className = 'hslider-head';
    head.append(this.labelEl, this.valueBtn);
    this.root.append(head, this.input);
    let active = false;
    this.input.addEventListener('pointerdown', () => { active = true; this.onBegin(); });
    this.input.addEventListener('input', () => {
      if (!active) { this.onBegin(); active = true; }
      this.onChange(fromNorm(this.p, this.input.value / 1000));
    });
    this.input.addEventListener('change', () => { active = false; this.onEnd(); });
    let lastTap = 0;
    this.input.addEventListener('pointerup', () => {
      const now = performance.now();
      if (now - lastTap < 300) { this.onBegin(); this.onChange(this.getDefault()); this.onEnd(); }
      lastTap = now;
    });
  }
  _render(n) {
    if (document.activeElement !== this.input) this.input.value = String(Math.round(n * 1000));
    this.input.style.setProperty('--fill', `${(n * 100).toFixed(1)}%`);
  }
}

/* ================================================================== *
 *  Иконки типов фильтров / filter type icons
 * ================================================================== */
export const TYPE_ICONS = {
  bell: 'M2 16 C9 16 10 5 14 5 S19 16 26 16',
  lowshelf: 'M2 7 C9 7 10 16 16 16 L26 16',
  highshelf: 'M2 16 L12 16 C18 16 19 7 26 7',
  lowcut: 'M4 22 C8 10 10 10 14 10 L26 10',
  highcut: 'M2 10 L14 10 C18 10 20 10 24 22',
  notch: 'M2 9 L11 9 C13 9 13 22 14 22 C15 22 15 9 17 9 L26 9',
  bandpass: 'M3 22 C9 22 10 7 14 7 S19 22 25 22',
  tiltshelf: 'M2 17 C10 17 11 13 14 13 S18 8 26 8',
  flattilt: 'M2 20 L26 6'
};

/* ================================================================== *
 *  Панель параметров полосы / band parameter panel
 * ================================================================== */
export class BandPanel {
  /**
   * @param {HTMLElement} root  — контейнер .sheet
   * @param {BottomSheet} sheet
   */
  constructor(root, sheet, { toast, controlStyle = 'knobs' }) {
    this.root = root;
    this.sheet = sheet;
    this.toast = toast;
    this.model = null;
    this.controlStyle = controlStyle;
    this.head = root.querySelector('.band-head');
    this.body = root.querySelector('.band-body');
    this._buildHead();
    this._buildBody();
    this._onModel = (e) => {
      const k = e.detail.kind;
      if (k === 'select') this._syncSelection();
      if (k === 'bands' || k === 'select' || k === 'settings') this.render();
    };
  }

  bind(model) {
    if (this.model) this.model.removeEventListener('change', this._onModel);
    this.model = model;
    if (model) model.addEventListener('change', this._onModel);
    this._syncSelection();
    this.render();
  }

  setControlStyle(style) {
    this.controlStyle = style;
    this._buildControls();
    this.render();
  }

  _syncSelection() {
    const b = this.model?.selected;
    if (!b) this.sheet.set('hidden');
    else if (this.sheet.state === 'hidden') this.sheet.set(this.sheet.isSheet ? 'peek' : 'full');
  }

  open(band) {
    if (!band) return;
    this.model.select(band.id);
    this.sheet.set(this.sheet.isSheet ? (this.sheet.state === 'full' ? 'full' : 'peek') : 'full');
    this.render();
  }

  _buildHead() {
    this.head.innerHTML = `
      <div class="sheet-grabber" data-sheet-handle aria-hidden="true"></div>
      <div class="band-head-row" data-sheet-handle>
        <button class="icon-btn" data-act="prev" aria-label="Предыдущая полоса / Previous band"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></button>
        <span class="band-dot mono"></span>
        <div class="band-title">
          <div class="band-type"></div>
          <div class="band-sum mono"></div>
        </div>
        <button class="icon-btn" data-act="next" aria-label="Следующая полоса / Next band"><svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg></button>
        <button class="icon-btn band-power" data-act="power" aria-label="Вкл/выкл полосу / Band on/off"><svg viewBox="0 0 24 24"><path d="M12 3v8M7 6.5a7 7 0 1 0 10 0"/></svg></button>
        <button class="icon-btn" data-act="expand" aria-label="Развернуть / Expand"><svg viewBox="0 0 24 24"><path d="M6 15l6-6 6 6"/></svg></button>
      </div>`;
    this.head.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b || !this.model) return;
      const sel = this.model.selected;
      const act = b.dataset.act;
      if (act === 'prev' || act === 'next') {
        const bands = [...this.model.bands].sort((x, y) => x.freq - y.freq);
        if (!bands.length) return;
        const i = sel ? bands.findIndex((x) => x.id === sel.id) : -1;
        const n = bands[(i + (act === 'next' ? 1 : -1) + bands.length) % bands.length];
        this.model.select(n.id);
        haptics.tick();
      } else if (act === 'power' && sel) {
        this.model.updateBand(sel.id, { enabled: !sel.enabled });
        haptics.tick();
      } else if (act === 'expand') {
        this.sheet.set(this.sheet.state === 'full' ? 'peek' : 'full');
      }
    });
  }

  _buildBody() {
    this.body.innerHTML = `
      <div class="type-chips" role="radiogroup" aria-label="Тип фильтра / Filter type"></div>
      <div class="ctl-row"></div>
      <div class="opt-row">
        <label class="opt"><span>Slope</span>
          <select class="sel-slope" aria-label="Крутизна / Slope">${SLOPES.map((s) => `<option value="${s}">${s} dB/oct</option>`).join('')}</select>
        </label>
        <div class="opt"><span>Stereo</span>
          <div class="seg seg-place" role="radiogroup" aria-label="Стерео-размещение / Stereo placement">
            ${PLACEMENTS.map((p) => `<button type="button" role="radio" data-place="${p}">${{ stereo: 'St', left: 'L', right: 'R', mid: 'M', side: 'S' }[p]}</button>`).join('')}
          </div>
        </div>
      </div>
      <div class="act-row">
        <button type="button" class="chip-btn" data-act="copy">Copy</button>
        <button type="button" class="chip-btn" data-act="paste">Paste</button>
        <button type="button" class="chip-btn" data-act="reset">Reset</button>
        <button type="button" class="chip-btn is-danger" data-act="delete">Delete</button>
      </div>`;
    const chips = this.body.querySelector('.type-chips');
    for (const t of FILTER_TYPES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'type-chip';
      b.dataset.type = t;
      b.setAttribute('role', 'radio');
      b.title = FILTER_LABELS[t];
      b.innerHTML = `<svg viewBox="0 0 28 26" aria-hidden="true"><path d="${TYPE_ICONS[t]}"/></svg><span>${FILTER_LABELS[t]}</span>`;
      chips.appendChild(b);
    }
    chips.addEventListener('click', (e) => {
      const c = e.target.closest('.type-chip');
      const sel = this.model?.selected;
      if (!c || !sel) return;
      this.model.updateBand(sel.id, { type: c.dataset.type });
      haptics.tick();
    });
    this.body.querySelector('.sel-slope').addEventListener('change', (e) => {
      const sel = this.model?.selected;
      if (sel) this.model.updateBand(sel.id, { slope: Number(e.target.value) });
    });
    this.body.querySelector('.seg-place').addEventListener('click', (e) => {
      const b = e.target.closest('[data-place]');
      const sel = this.model?.selected;
      if (!b || !sel) return;
      this.model.updateBand(sel.id, { placement: b.dataset.place });
      haptics.tick();
    });
    this.body.querySelector('.act-row').addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      const sel = this.model?.selected;
      if (!b || !this.model) return;
      const act = b.dataset.act;
      if (act === 'copy' && sel) { this.model.copyBand(sel.id); this.toast.show('Скопировано · Copied', { short: true }); }
      if (act === 'paste') { if (!this.model.pasteBand()) this.toast.show('Буфер пуст · Clipboard empty', { short: true }); }
      if (act === 'reset' && sel) this.model.resetBand(sel.id);
      if (act === 'delete' && sel) {
        this.model.removeBand(sel.id);
        haptics.heavy();
        this.toast.show('Полоса удалена · Band deleted', { action: { label: 'Undo', fn: () => this.model.undo() } });
      }
    });
    this._buildControls();
  }

  _buildControls() {
    const row = this.body.querySelector('.ctl-row');
    row.innerHTML = '';
    row.dataset.style = this.controlStyle;
    const C = this.controlStyle === 'sliders' ? HSlider : Knob;
    const mk = (key) => new C(key, {
      onBegin: () => this.model?.begin(),
      onChange: (v) => { const s = this.model?.selected; if (s) this.model.updateBand(s.id, { [key]: v }); },
      onEnd: () => this.model?.commit(),
      getDefault: () => {
        const s = this.model?.selected;
        return key === 'freq' ? 1000 : key === 'gain' ? 0 : DEFAULT_Q[s ? s.type : 'bell'];
      }
    });
    this.ctl = { freq: mk('freq'), gain: mk('gain'), q: mk('q') };
    row.append(this.ctl.freq.root, this.ctl.gain.root, this.ctl.q.root);
  }

  render() {
    const m = this.model;
    const b = m?.selected;
    this.root.classList.toggle('has-band', !!b);
    if (!b) return;
    const idx = m.bands.indexOf(b) + 1;
    const col = BAND_COLORS[b.color];
    this.root.style.setProperty('--band', col);
    const dot = this.head.querySelector('.band-dot');
    dot.textContent = idx;
    dot.style.background = col;
    this.head.querySelector('.band-type').textContent = `${FILTER_LABELS[b.type]}${b.placement !== 'stereo' ? ' · ' + b.placement.toUpperCase() : ''}`;
    this.head.querySelector('.band-sum').textContent = GAINLESS.has(b.type)
      ? `${fmtFreq(b.freq)} · Q ${fmtQ(b.q)} · ${b.slope} dB/oct`
      : `${fmtFreq(b.freq)} · ${fmtGain(b.gain)} · Q ${fmtQ(b.q)}`;
    const pw = this.head.querySelector('.band-power');
    pw.classList.toggle('is-off', !b.enabled);
    pw.setAttribute('aria-pressed', String(b.enabled));
    this.head.querySelector('[data-act="expand"]').classList.toggle('is-flipped', this.sheet.state === 'full');

    for (const c of this.body.querySelectorAll('.type-chip')) {
      const on = c.dataset.type === b.type;
      c.classList.toggle('is-on', on);
      c.setAttribute('aria-checked', String(on));
    }
    this.ctl.freq.set(b.freq); this.ctl.freq.setColor(col);
    this.ctl.gain.set(b.gain, GAINLESS.has(b.type)); this.ctl.gain.setColor(col);
    this.ctl.q.set(b.q, b.type === 'flattilt' || ((b.type === 'lowcut' || b.type === 'highcut') && b.slope === 6)); this.ctl.q.setColor(col);
    const slope = this.body.querySelector('.sel-slope');
    slope.value = String(b.slope);
    slope.disabled = !HAS_SLOPE.has(b.type);
    for (const p of this.body.querySelectorAll('[data-place]')) {
      const on = p.dataset.place === b.placement;
      p.classList.toggle('is-on', on);
      p.setAttribute('aria-checked', String(on));
    }
    this.body.querySelector('[data-act="paste"]').disabled = !EQModel.hasClipboard;
  }
}
