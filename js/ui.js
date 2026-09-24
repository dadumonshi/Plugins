/**
 * ui.js — интерактивный график: сетка, спектр-анализатор, кривые ЭК, узлы (SVG tap-area),
 * лупа, подсказки, ripple. Только отображение и хит-тест; жесты — в gestures.js.
 *
 * ui.js — interactive graph: grid, spectrum analyser, EQ curves, nodes (SVG tap-area),
 * loupe, tooltips, ripple. Rendering and hit-testing only; gestures live in gestures.js.
 *
 * Слои / Layers (снизу вверх / bottom → top):
 *   canvas.g-grid  — сетка и подписи (перерисовка только при resize/zoom)
 *   canvas.g-spec  — спектр (каждый кадр, «лениво»: только когда есть сигнал)
 *   canvas.g-curve — кривые (только при изменениях — dirty flag)
 *   svg.g-nodes    — узлы + увеличенные невидимые зоны захвата
 */
import { makeResponder, magDb, GAINLESS, FILTER_LABELS, LIMITS, clamp } from './dsp.js';
import { BAND_COLORS } from './eq.js';
import { canvasDpr, releaseCanvas } from './touch.js';

/* ---------------- форматирование / formatting ---------------- */

export function fmtFreq(f, short = false) {
  if (f >= 1000) {
    const k = f / 1000;
    return (k >= 10 ? k.toFixed(short ? 0 : 1) : k.toFixed(short ? 1 : 2)).replace(/\.0+$/, '') + (short ? 'k' : ' кГц');
  }
  if (short) return f.toFixed(f >= 10 ? 0 : 1);
  return (f >= 100 ? f.toFixed(0) : f.toFixed(1)) + ' Гц';
}
export const fmtGain = (g) => (g > 0 ? '+' : g < 0 ? '−' : '') + Math.abs(g).toFixed(Math.abs(g) < 10 ? 2 : 1) + ' дБ';
export const fmtQ = (q) => q.toFixed(q < 10 ? 2 : 1);

/** Множитель положения узла по вертикали / vertical node placement factor. */
export function nodeGainFactor(type) {
  if (type === 'bell') return 1;
  if (GAINLESS.has(type)) return 0;
  return 0.5; // полки и наклоны: узел на середине перехода / shelves & tilts: node at mid-transition
}

const SVGNS = 'http://www.w3.org/2000/svg';
const FREQ_TIERS = [
  [100, 1000, 10000],
  [20, 50, 200, 500, 2000, 5000, 20000],
  [30, 300, 3000],
  [40, 60, 80, 400, 600, 800, 4000, 6000, 8000],
  [10, 15, 25, 150, 1500, 15000, 30000]
];

export class EQGraph extends EventTarget {
  constructor(wrap, { lowPower = false } = {}) {
    super();
    this.wrap = wrap;
    this.lowPower = lowPower;
    this.plugin = null;
    this.engine = null;
    this.view = { fMin: LIMITS.freqMin, fMax: LIMITS.freqMax, range: 12 };
    this.analyzer = { pre: true, post: true, speed: 'medium', tilt: 4.5 };
    this.w = 0; this.h = 0; this.dpr = 1;
    this.hoverId = null;
    this.dragId = null;
    this.peaks = [];
    this.showPeaks = false;
    this.cache = new Map();
    this.dirty = { grid: true, curve: true, nodes: true };
    this._specPrev = { pre: null, post: null };
    this._specBuf = null;
    this._frameN = 0;
    this._running = false;
    this._build();
    this._colors();

    // ResizeObserver ловит и поворот экрана, и изменения раскладки.
    // ResizeObserver catches both device rotation and layout changes.
    if ('ResizeObserver' in window) {
      this._ro = new ResizeObserver(() => this.resize());
      this._ro.observe(wrap);
    } else {
      window.addEventListener('resize', () => this.resize());
    }
    // Смена темы / theme change
    window.matchMedia?.('(prefers-color-scheme: light)').addEventListener?.('change', () => this.refreshTheme());
    this.resize();
  }

  _build() {
    const mk = (cls) => { const c = document.createElement('canvas'); c.className = cls; c.setAttribute('aria-hidden', 'true'); this.wrap.appendChild(c); return c; };
    this.cGrid = mk('g-layer g-grid');
    this.cSpec = mk('g-layer g-spec');
    this.cCurve = mk('g-layer g-curve');
    this.xGrid = this.cGrid.getContext('2d');
    this.xSpec = this.cSpec.getContext('2d');
    this.xCurve = this.cCurve.getContext('2d');

    this.svg = document.createElementNS(SVGNS, 'svg');
    this.svg.setAttribute('class', 'g-layer g-nodes');
    this.svg.setAttribute('role', 'application');
    this.svg.setAttribute('aria-label', 'Кривая эквалайзера');
    this.gNodes = document.createElementNS(SVGNS, 'g');
    this.svg.appendChild(this.gNodes);
    this.wrap.appendChild(this.svg);

    this.loupe = document.createElement('div');
    this.loupe.className = 'g-loupe';
    this.loupe.innerHTML = '<canvas></canvas><div class="g-loupe-text mono"></div>';
    this.wrap.appendChild(this.loupe);
    this.loupeCanvas = this.loupe.querySelector('canvas');
    this.loupeText = this.loupe.querySelector('.g-loupe-text');

    this.tip = document.createElement('div');
    this.tip.className = 'g-tip mono';
    this.tip.setAttribute('role', 'status');
    this.wrap.appendChild(this.tip);

    this.hint = document.createElement('div');
    this.hint.className = 'g-hint';
    this.wrap.appendChild(this.hint);

    this.badge = document.createElement('div');
    this.badge.className = 'g-badge mono';
    this.wrap.appendChild(this.badge);
  }

  _colors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n, d) => cs.getPropertyValue(n).trim() || d;
    this.col = {
      grid: v('--grid', 'rgba(255,255,255,0.06)'),
      gridMajor: v('--grid-major', 'rgba(255,255,255,0.13)'),
      zero: v('--grid-zero', 'rgba(255,255,255,0.25)'),
      label: v('--label', 'rgba(255,255,255,0.45)'),
      curve: v('--curve', '#ffffff'),
      specPost: v('--spec-post', 'rgba(120,170,255,0.35)'),
      specPostLine: v('--spec-post-line', 'rgba(160,200,255,0.7)'),
      specPre: v('--spec-pre', 'rgba(255,255,255,0.18)'),
      bg: v('--graph-bg', '#141414')
    };
  }

  refreshTheme() {
    this._colors();
    this.dirty.grid = this.dirty.curve = true;
  }

  /* ---------------- привязка / binding ---------------- */

  bind(plugin, engine) {
    if (this._unbind) this._unbind();
    this.plugin = plugin;
    this.engine = engine;
    this.cache.clear();
    this.dirty.curve = this.dirty.nodes = true;
    this._specPrev = { pre: null, post: null };
    if (plugin) {
      const on = (e) => {
        const k = e.detail.kind;
        if (k === 'bands' || k === 'settings' || k === 'select') { this.dirty.curve = true; this.dirty.nodes = true; }
        if (k === 'latency' || k === 'settings') this._updateBadge();
      };
      plugin.model.addEventListener('change', on);
      this._unbind = () => plugin.model.removeEventListener('change', on);
    }
    this._updateBadge();
    this._updateHint();
  }

  get model() { return this.plugin ? this.plugin.model : null; }
  get fs() { return this.plugin ? this.plugin.ctx.sampleRate : 48000; }

  _updateBadge() {
    const m = this.model;
    if (!m) { this.badge.textContent = ''; return; }
    const lat = this.plugin.latency || 0;
    const mode = { zero: 'Без задержки', natural: 'Натуральная фаза', linear: 'Линейная фаза' }[m.settings.mode];
    this.badge.textContent = `${mode}${lat ? ` · ${(lat / this.fs * 1000).toFixed(1)} мс` : ''}${m.settings.bypass ? ' · ОБХОД' : ''}`;
    this.wrap.classList.toggle('is-bypassed', !!m.settings.bypass);
  }

  _updateHint() {
    const m = this.model;
    const touch = matchMedia('(pointer: coarse)').matches;
    this.hint.textContent = !m ? 'Добавьте эффект в цепочку'
      : touch ? 'Двойной тап — добавить полосу'
        : 'Двойной клик — добавить полосу';
    this.hint.hidden = !!(m && m.bands.length);
  }

  /* ---------------- геометрия / geometry ---------------- */

  resize() {
    const r = this.wrap.getBoundingClientRect();
    const w = Math.max(10, Math.round(r.width));
    const h = Math.max(10, Math.round(r.height));
    // DPR ограничиваем на слабых устройствах (меньше пикселей → быстрее).
    // Cap DPR on weak devices (fewer pixels → faster).
    const dpr = canvasDpr(this.lowPower);
    if (w === this.w && h === this.h && dpr === this.dpr) return;
    this.w = w; this.h = h; this.dpr = dpr;
    for (const c of [this.cGrid, this.cSpec, this.cCurve]) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      c.style.width = w + 'px';
      c.style.height = h + 'px';
    }
    this.svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    this.svg.setAttribute('width', w);
    this.svg.setAttribute('height', h);
    this.compact = w < 480;
    this.nodeR = parseFloat(getComputedStyle(this.wrap).getPropertyValue('--node-r')) || (matchMedia('(pointer: coarse)').matches ? 14 : 9);
    this.cache.clear();
    this._specPrev = { pre: null, post: null };
    this.dirty.grid = this.dirty.curve = this.dirty.nodes = true;
    this.renderNow();
  }

  get padTop() { return 6; }
  get padBottom() { return this.compact ? 18 : 22; }

  freqToX(f) {
    const { fMin, fMax } = this.view;
    return (Math.log(f / fMin) / Math.log(fMax / fMin)) * this.w;
  }
  xToFreq(x) {
    const { fMin, fMax } = this.view;
    return fMin * Math.pow(fMax / fMin, x / this.w);
  }
  gainToY(g) {
    const top = this.padTop, bot = this.h - this.padBottom;
    return top + ((this.view.range - g) / (2 * this.view.range)) * (bot - top);
  }
  yToGain(y) {
    const top = this.padTop, bot = this.h - this.padBottom;
    return this.view.range - ((y - top) / (bot - top)) * 2 * this.view.range;
  }
  /** Шкала анализатора: 0 dBFS сверху, −96 внизу / analyser scale. */
  specToY(db) {
    const top = this.padTop, bot = this.h - this.padBottom;
    return top + (-db / 96) * (bot - top);
  }

  setZoom({ fMin, fMax, range }) {
    const v = this.view;
    if (range !== undefined) v.range = clamp(range, 3, 30);
    if (fMin !== undefined && fMax !== undefined) {
      let a = clamp(fMin, LIMITS.freqMin, LIMITS.freqMax);
      let b = clamp(fMax, LIMITS.freqMin, LIMITS.freqMax);
      if (b / a < 4) { // минимум 2 октавы / at least 2 octaves
        const c = Math.sqrt(a * b);
        a = Math.max(LIMITS.freqMin, c / 2); b = Math.min(LIMITS.freqMax, a * 4);
      }
      v.fMin = a; v.fMax = b;
    }
    this.cache.clear();
    this._specPrev = { pre: null, post: null };
    this.dirty.grid = this.dirty.curve = this.dirty.nodes = true;
    this.dispatchEvent(new CustomEvent('zoom'));
  }

  resetZoom() { this.setZoom({ fMin: LIMITS.freqMin, fMax: LIMITS.freqMax }); }
  get zoomed() { return this.view.fMin > LIMITS.freqMin * 1.01 || this.view.fMax < LIMITS.freqMax * 0.99; }

  /** Экранная позиция узла / node screen position. */
  nodePos(b) {
    const x = this.freqToX(b.freq);
    let y;
    if (GAINLESS.has(b.type)) {
      const r = makeResponder(b, this.model.settings.mode, this.fs)(Math.min(b.freq, this.fs * 0.49));
      const db = magDb(r);
      y = this.gainToY(Number.isFinite(db) ? clamp(db, -this.view.range, this.view.range) : 0);
    } else {
      y = this.gainToY(b.gain * nodeGainFactor(b.type));
    }
    // Узел целиком внутри графика — иначе палец «промахивается» на соседние элементы.
    // Keep the whole node inside the graph, otherwise touch adjustment picks neighbours.
    const m = (this.nodeR || 9) + 2;
    return { x: clamp(x, m, this.w - m), y: clamp(y, this.padTop + m, this.h - this.padBottom - m) };
  }

  /** Хит-тест с зоной захвата ×2 от радиуса узла / hit-test with a 2× capture zone. */
  hitTest(x, y, pointerType = 'mouse') {
    const m = this.model;
    if (!m) return null;
    const R = pointerType === 'mouse' ? this.nodeR + 5 : this.nodeR * 2;
    let best = null, bestD = Infinity;
    for (const b of m.bands) {
      const p = this.nodePos(b);
      const d = Math.hypot(p.x - x, p.y - y);
      // Выбранный узел имеет приоритет при перекрытии / selected node wins ties
      const bias = b.id === m.selectedId ? 0.8 : 1;
      if (d <= R && d * bias < bestD) { best = b; bestD = d * bias; }
    }
    return best;
  }

  /** Пик спектра рядом с точкой (Spectrum Grab) / nearby spectrum peak. */
  peakNear(x, y, radius = 30) {
    let best = null, bd = radius;
    for (const p of this.peaks) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  /* ---------------- цикл отрисовки / render loop ---------------- */

  start() {
    if (this._running) return;
    this._running = true;
    const loop = () => {
      if (!this._running) return;
      this._raf = requestAnimationFrame(loop);
      // Не рисуем в фоне (экономия батареи) / skip when hidden (battery)
      if (document.hidden) return;
      this._frameN++;
      this.renderNow();
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    this._running = false;
    cancelAnimationFrame(this._raf);
    // Скрытый редактор не держит память GPU / a hidden editor holds no GPU memory
    [this.cGrid, this.cSpec, this.cCurve].forEach(releaseCanvas);
    this.w = this.h = 0;
    this.dirty.grid = this.dirty.curve = true;
  }

  renderNow() {
    if (!this.w) return;
    if (this.dirty.grid) { this._drawGrid(); this.dirty.grid = false; }
    // Ленивый спектр: 30 fps на слабых устройствах / lazy spectrum: 30 fps on weak devices
    if (!this.lowPower || this._frameN % 2 === 0) this._drawSpectrum();
    if (this.dirty.curve) { this._drawCurves(); this.dirty.curve = false; }
    if (this.dirty.nodes) { this._drawNodes(); this.dirty.nodes = false; this._updateHint(); }
  }

  invalidate() { this.dirty.curve = this.dirty.nodes = true; }

  /* ---------------- сетка / grid ---------------- */

  _freqLabels() {
    // Добавляем уровни подписей, пока между ними ≥ minGap px (меньше подписей на узких экранах).
    // Add label tiers while spacing ≥ minGap px (fewer labels on narrow screens).
    const minGap = this.compact ? 36 : 44;
    let chosen = [];
    for (const tier of FREQ_TIERS) {
      const cand = chosen.concat(tier.filter((f) => f >= this.view.fMin && f <= this.view.fMax)).sort((a, b) => a - b);
      let ok = true;
      for (let i = 1; i < cand.length; i++) if (this.freqToX(cand[i]) - this.freqToX(cand[i - 1]) < minGap) { ok = false; break; }
      if (!ok) break;
      chosen = cand;
    }
    return chosen;
  }

  _gainStep() {
    const usable = this.h - this.padTop - this.padBottom;
    const minPx = this.compact ? 34 : 40;
    for (const s of [1, 2, 3, 6, 10, 12, 15, 30]) {
      if ((usable / (2 * this.view.range)) * s >= minPx) return s;
    }
    return 30;
  }

  _drawGrid() {
    const c = this.xGrid, { w, h, dpr } = this;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    c.fillStyle = this.col.bg;
    c.fillRect(0, 0, w, h);

    // Мелкая логарифмическая сетка / minor log grid
    c.lineWidth = 1;
    c.strokeStyle = this.col.grid;
    c.beginPath();
    for (let dec = 10; dec <= 10000; dec *= 10) {
      for (let k = 1; k <= 9; k++) {
        const f = dec * k;
        if (f < this.view.fMin || f > this.view.fMax) continue;
        const x = Math.round(this.freqToX(f)) + 0.5;
        c.moveTo(x, 0); c.lineTo(x, h - this.padBottom);
      }
    }
    c.stroke();

    const labels = this._freqLabels();
    c.strokeStyle = this.col.gridMajor;
    c.beginPath();
    for (const f of labels) {
      const x = Math.round(this.freqToX(f)) + 0.5;
      c.moveTo(x, 0); c.lineTo(x, h - this.padBottom);
    }
    c.stroke();

    // Усиление / gain lines
    const step = this._gainStep();
    const fontPx = this.compact ? 10 : 11;
    c.font = `${fontPx}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
    c.textBaseline = 'middle';
    for (let g = -Math.floor(this.view.range / step) * step; g <= this.view.range; g += step) {
      const y = Math.round(this.gainToY(g)) + 0.5;
      c.strokeStyle = g === 0 ? this.col.zero : this.col.gridMajor;
      c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke();
      if (Math.abs(g) < this.view.range - 0.01 || g === 0) {
        c.fillStyle = this.col.label;
        c.textAlign = 'right';
        c.fillText((g > 0 ? '+' : '') + g, w - 4, y - 7);
      }
    }
    // Шкала анализатора слева (скрыта на узких) / analyser scale left (hidden on narrow)
    this._gridAnalyzer = this.analyzerActive();
    if (w >= 900 && this.analyzer.post && this._gridAnalyzer) {
      c.textAlign = 'left';
      c.fillStyle = this.col.grid.replace(/[\d.]+\)$/, '0.35)');
      for (let d = -12; d >= -84; d -= 12) {
        const y = this.specToY(d);
        if (y > h - this.padBottom - 6) break;
        c.fillText(String(d), 4, y);
      }
    }
    // Частоты / frequencies
    c.fillStyle = this.col.label;
    c.textAlign = 'center';
    c.textBaseline = 'alphabetic';
    for (const f of labels) {
      const x = this.freqToX(f);
      const t = fmtFreq(f, true);
      const tw = c.measureText(t).width;
      c.fillText(t, clamp(x, tw / 2 + 2, w - tw / 2 - 2), h - 6);
    }
  }

  /* ---------------- спектр / spectrum ---------------- */

  analyzerActive() {
    return !!(this.plugin && this.engine && this.engine.running && this.engine.hasSignal &&
      (this.analyzer.pre || this.analyzer.post));
  }

  _drawSpectrum() {
    const c = this.xSpec, { w, h, dpr } = this;
    const active = this.analyzerActive();
    if (active !== this._gridAnalyzer) this.dirty.grid = true; // шкала анализатора / analyser scale
    if (!active && !this._specHadData) return; // ленивый рендер / lazy render
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    if (!active) {
      this._specHadData = false;
      this.peaks = [];
      this._specPrev = { pre: null, post: null };
      return;
    }
    this._specHadData = true;
    const smooth = { slow: 0.9, medium: 0.8, fast: 0.6 }[this.analyzer.speed] || 0.8;
    const pa = this.plugin.preAnalyser, qa = this.plugin.postAnalyser;
    pa.smoothingTimeConstant = qa.smoothingTimeConstant = smooth;
    if (this.analyzer.pre) this._spectrumPath(pa, 'pre', false);
    if (this.analyzer.post) {
      const arr = this._spectrumPath(qa, 'post', true);
      this._findPeaks(arr);
    } else this.peaks = [];
    if (this.showPeaks && this.model?.settings.grab) this._drawPeaks();
  }

  _spectrumPath(an, key, fill) {
    const c = this.xSpec, { w, h } = this;
    const n = an.frequencyBinCount;
    if (!this._specBuf || this._specBuf.length !== n) this._specBuf = new Float32Array(n);
    const buf = this._specBuf;
    an.getFloatFrequencyData(buf);
    const fs = this.fs;
    const step = this.lowPower || this.compact ? 3 : 2;
    const cols = Math.ceil(w / step) + 1;
    let prev = this._specPrev[key];
    if (!prev || prev.length !== cols) prev = this._specPrev[key] = new Float32Array(cols).fill(-140);
    const binHz = fs / an.fftSize;
    const tilt = this.analyzer.tilt;
    const decay = { slow: 0.6, medium: 1.2, fast: 2.5 }[this.analyzer.speed] || 1.2;
    for (let i = 0; i < cols; i++) {
      const x = i * step;
      const f0 = this.xToFreq(x), f1 = this.xToFreq(x + step);
      const k0 = f0 / binHz, k1 = f1 / binHz;
      let db;
      if (k1 - k0 < 1) { // интерполяция на НЧ / interpolate at lows
        const k = Math.floor(k0), fr = k0 - k;
        const a = buf[Math.min(k, n - 1)], b = buf[Math.min(k + 1, n - 1)];
        db = a + (b - a) * fr;
      } else { // максимум по бинам на ВЧ / max over bins at highs
        db = -200;
        for (let k = Math.floor(k0); k < Math.min(Math.ceil(k1), n); k++) if (buf[k] > db) db = buf[k];
      }
      if (f0 > fs / 2) db = -200;
      db += tilt * Math.log2(Math.max(f0, 1) / 1000); // наклон 4.5 дБ/окт как в Pro-Q / slope compensation
      prev[i] = Math.max(db, prev[i] - decay);
    }
    const ys = new Float32Array(cols);
    for (let i = 0; i < cols; i++) ys[i] = clamp(this.specToY(prev[i]), 0, h);
    c.beginPath();
    c.moveTo(0, h);
    for (let i = 0; i < cols; i++) c.lineTo(i * step, ys[i]);
    c.lineTo(w, h);
    c.closePath();
    if (fill) {
      const g = c.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, this.col.specPost);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g;
      c.fill();
      c.strokeStyle = this.col.specPostLine;
      c.lineWidth = 1;
      c.beginPath();
      for (let i = 0; i < cols; i++) i ? c.lineTo(i * step, ys[i]) : c.moveTo(0, ys[0]);
      c.stroke();
    } else {
      c.fillStyle = this.col.specPre;
      c.fill();
    }
    return { vals: prev, ys, step };
  }

  _findPeaks({ vals, ys, step }) {
    // Локальные максимумы с «выступом» ≥ 6 дБ / local maxima with ≥ 6 dB prominence
    const out = [];
    const span = Math.max(4, Math.round(24 / step));
    for (let i = span; i < vals.length - span; i++) {
      const v = vals[i];
      if (v < -80) continue;
      let isMax = true, minL = v, minR = v;
      for (let j = 1; j <= span; j++) {
        if (vals[i - j] > v || vals[i + j] > v) { isMax = false; break; }
        minL = Math.min(minL, vals[i - j]); minR = Math.min(minR, vals[i + j]);
      }
      if (isMax && v - Math.max(minL, minR) >= 6) out.push({ x: i * step, y: ys[i], v, freq: this.xToFreq(i * step) });
    }
    out.sort((a, b) => b.v - a.v);
    this.peaks = out.slice(0, 8);
  }

  _drawPeaks() {
    const c = this.xSpec;
    c.save();
    for (const p of this.peaks) {
      c.beginPath();
      c.arc(p.x, p.y, 5, 0, Math.PI * 2);
      c.fillStyle = 'rgba(255,255,255,0.85)';
      c.fill();
      c.beginPath();
      c.arc(p.x, p.y, 10, 0, Math.PI * 2);
      c.strokeStyle = 'rgba(255,255,255,0.35)';
      c.stroke();
    }
    c.restore();
  }

  /* ---------------- кривые / curves ---------------- */

  _bandCurve(b, xs) {
    const mode = this.model.settings.mode;
    const key = `${b.type}|${b.freq}|${b.gain}|${b.q}|${b.slope}|${mode}|${this.fs}|${this.w}|${this.view.fMin}|${this.view.fMax}`;
    const hit = this.cache.get(b.id);
    if (hit && hit.key === key) return hit.db;
    const resp = makeResponder(b, mode, this.fs);
    const db = new Float32Array(xs.length);
    for (let i = 0; i < xs.length; i++) {
      const v = magDb(resp(this.xToFreq(xs[i])));
      db[i] = Number.isFinite(v) ? v : NaN;
    }
    this.cache.set(b.id, { key, db });
    return db;
  }

  _drawCurves() {
    const c = this.xCurve, { w, h, dpr } = this;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    const m = this.model;
    if (!m) return;
    const step = this.compact ? 2 : 1.5;
    const xs = [];
    for (let x = 0; x <= w + step; x += step) xs.push(x);
    const zeroY = this.gainToY(0);
    const bands = m.bands;
    const curves = new Map();
    for (const b of bands) curves.set(b.id, this._bandCurve(b, xs));

    // skipFlat: не рисовать участки ≈0 дБ (иначе у полосы тянется линия через весь график).
    // skipFlat: skip ≈0 dB stretches (otherwise a band draws a line across the whole graph).
    const path = (arr, skipFlat = false) => {
      c.beginPath();
      let started = false;
      for (let i = 0; i < xs.length; i++) {
        if (!Number.isFinite(arr[i]) || (skipFlat && Math.abs(arr[i]) < 0.05)) { started = false; continue; }
        const y = clamp(this.gainToY(arr[i]), -50, h + 50);
        if (!started) { c.moveTo(xs[i], y); started = true; } else c.lineTo(xs[i], y);
      }
    };

    // Кривые отдельных полос / individual band curves
    for (const b of bands) {
      const sel = b.id === m.selectedId || b.id === this.hoverId || b.id === this.dragId;
      const col = BAND_COLORS[b.color];
      const arr = curves.get(b.id);
      if (!b.enabled) continue;
      if (sel) {
        path(arr);
        c.lineTo(xs[xs.length - 1], zeroY);
        c.lineTo(xs[0], zeroY);
        c.closePath();
        c.globalAlpha = 0.22;
        c.fillStyle = col;
        c.fill();
        c.globalAlpha = 1;
      }
      path(arr, true);
      c.lineWidth = sel ? 1.6 : 1;
      c.strokeStyle = col;
      c.globalAlpha = sel ? 0.95 : 0.35;
      c.stroke();
      c.globalAlpha = 1;
    }

    // Суммарные кривые по компонентам / composite curves per component
    const active = bands.filter((b) => b.enabled);
    const pls = new Set(active.map((b) => b.placement));
    const comps = [];
    if (!pls.has('left') && !pls.has('right') && !pls.has('mid') && !pls.has('side')) comps.push({ name: '', inc: ['stereo'] });
    else {
      if (pls.has('left') || pls.has('right')) comps.push({ name: 'L', inc: ['stereo', 'left'], dash: [] }, { name: 'R', inc: ['stereo', 'right'], dash: [5, 4] });
      if (pls.has('mid') || pls.has('side')) comps.push({ name: 'M', inc: ['stereo', 'mid'], dash: [] }, { name: 'S', inc: ['stereo', 'side'], dash: [2, 3] });
    }
    for (const comp of comps) {
      const sum = new Float32Array(xs.length);
      for (const b of active) {
        if (!comp.inc.includes(b.placement)) continue;
        const arr = curves.get(b.id);
        for (let i = 0; i < xs.length; i++) sum[i] += arr[i];
      }
      path(sum);
      c.setLineDash(comp.dash || []);
      c.lineWidth = this.compact ? 2 : 2.2;
      c.strokeStyle = m.settings.bypass ? 'rgba(160,160,160,0.6)' : this.col.curve;
      // Свечение кривой (отключается в low-power) / curve glow (off in low-power)
      if (!this.lowPower) { c.shadowColor = 'rgba(255,255,255,0.35)'; c.shadowBlur = 6; }
      c.stroke();
      c.shadowBlur = 0;
      c.setLineDash([]);
      if (comp.name) {
        const yEnd = this.gainToY(sum[sum.length - 1] || 0);
        c.font = 'bold 11px ui-monospace, monospace';
        c.fillStyle = this.col.curve;
        c.textAlign = 'right';
        c.fillText(comp.name, w - 30, clamp(yEnd - 6, 12, h - 24));
      }
    }
  }

  /* ---------------- узлы (SVG) / nodes (SVG) ---------------- */

  _drawNodes() {
    const m = this.model;
    const g = this.gNodes;
    if (!m) { g.textContent = ''; return; }
    const existing = new Map([...g.children].map((el) => [el.dataset.id, el]));
    const r = this.nodeR;
    m.bands.forEach((b, idx) => {
      let el = existing.get(b.id);
      if (!el) {
        el = document.createElementNS(SVGNS, 'g');
        el.dataset.id = b.id;
        el.setAttribute('class', 'node');
        el.innerHTML = '<circle class="node-hit"></circle><circle class="node-halo"></circle><circle class="node-dot"></circle><text class="node-num" text-anchor="middle" dominant-baseline="central"></text>';
        g.appendChild(el);
      }
      existing.delete(b.id);
      const p = this.nodePos(b);
      const col = BAND_COLORS[b.color];
      const [hit, halo, dot, num] = el.children;
      el.setAttribute('transform', `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`);
      el.style.setProperty('--c', col);
      el.classList.toggle('is-selected', b.id === m.selectedId);
      el.classList.toggle('is-disabled', !b.enabled);
      el.classList.toggle('is-hover', b.id === this.hoverId);
      el.classList.toggle('is-drag', b.id === this.dragId);
      hit.setAttribute('r', r * 2); // невидимая зона захвата ×2 / invisible 2× capture zone
      halo.setAttribute('r', r + 6);
      dot.setAttribute('r', r);
      num.textContent = String(idx + 1);
      el.setAttribute('aria-label', `${idx + 1}: ${FILTER_LABELS[b.type]} ${fmtFreq(b.freq)} ${fmtGain(b.gain)}`);
    });
    existing.forEach((el) => el.remove());
  }

  /* ---------------- лупа / loupe ---------------- */

  /** Лупа над пальцем при перетаскивании / magnifier above the finger while dragging. */
  showLoupe(x, y, band) {
    const size = 120, zoom = 2;
    const lc = this.loupeCanvas;
    const dpr = this.dpr;
    if (lc.width !== size * dpr) { lc.width = lc.height = size * dpr; lc.style.width = lc.style.height = size + 'px'; }
    const c = lc.getContext('2d');
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, lc.width, lc.height);
    const src = size / zoom;
    const sx = (x - src / 2) * dpr, sy = (y - src / 2) * dpr;
    for (const layer of [this.cGrid, this.cSpec, this.cCurve]) {
      try { c.drawImage(layer, sx, sy, src * dpr, src * dpr, 0, 0, lc.width, lc.height); } catch { /* out of bounds */ }
    }
    // Узел и перекрестие / node and crosshair
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const col = band ? BAND_COLORS[band.color] : '#fff';
    c.strokeStyle = 'rgba(255,255,255,0.4)';
    c.beginPath(); c.moveTo(size / 2, 0); c.lineTo(size / 2, size); c.moveTo(0, size / 2); c.lineTo(size, size / 2); c.stroke();
    c.beginPath(); c.arc(size / 2, size / 2, 9, 0, Math.PI * 2); c.fillStyle = col; c.fill();
    c.lineWidth = 2; c.strokeStyle = '#fff'; c.stroke();

    if (band) {
      this.loupeText.textContent = GAINLESS.has(band.type)
        ? `${fmtFreq(band.freq)} · Q ${fmtQ(band.q)}`
        : `${fmtFreq(band.freq)} · ${fmtGain(band.gain)}`;
    }
    // Над пальцем; если у верхнего края — сбоку / above the finger; beside it near the top edge
    let lx = x - size / 2, ly = y - size - 56;
    if (ly < 4) { ly = clamp(y - size / 2, 4, this.h - size - 30); lx = x + (x > this.w / 2 ? -size - 50 : 50); }
    lx = clamp(lx, 4, this.w - size - 4);
    this.loupe.style.transform = `translate(${lx}px, ${ly}px)`;
    this.loupe.classList.add('is-on');
  }

  hideLoupe() { this.loupe.classList.remove('is-on'); }

  /* ---------------- подсказка / tooltip ---------------- */

  showTip(band, ms = 0) {
    if (!band) { this.tip.classList.remove('is-on'); return; }
    const p = this.nodePos(band);
    const idx = this.model.bands.indexOf(band) + 1;
    this.tip.innerHTML = `<b style="color:${BAND_COLORS[band.color]}">${idx} · ${FILTER_LABELS[band.type]}</b><br>${fmtFreq(band.freq)}` +
      (GAINLESS.has(band.type) ? '' : `<br>${fmtGain(band.gain)}`) + `<br>Q ${fmtQ(band.q)}`;
    const tw = 120;
    const left = clamp(p.x + 18, 4, this.w - tw - 4);
    const top = clamp(p.y - 70, 4, this.h - 80);
    this.tip.style.transform = `translate(${left}px, ${top}px)`;
    this.tip.classList.add('is-on');
    clearTimeout(this._tipT);
    if (ms) this._tipT = setTimeout(() => this.tip.classList.remove('is-on'), ms);
  }

  /** Визуальный отклик касания / touch ripple. */
  ripple(x, y, color = '#fff') {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const s = document.createElement('span');
    s.className = 'g-ripple';
    s.style.left = x + 'px';
    s.style.top = y + 'px';
    s.style.setProperty('--c', color);
    this.wrap.appendChild(s);
    s.addEventListener('animationend', () => s.remove(), { once: true });
    setTimeout(() => s.remove(), 1000);
  }
}
