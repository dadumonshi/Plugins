/**
 * graph.js — график Movexe DeEss: спектр входа/выхода, зона детекции, кривая фильтра,
 * зона подавления, порог и узел (SVG tap-area), GR-метр с историей 2 с, LED, лупа, подсказки.
 *
 * graph.js — Movexe DeEss graph: in/out spectrum, detection zone, filter curve,
 * reduction area, threshold & node (SVG tap-area), GR meter with 2 s history, LED, loupe, tips.
 *
 * Шкалы / Scales:
 *   слева — спектр и порог, дБFS (0 … −90);
 *   справа (голубая) — усиление обработки, дБ (0 … −30).
 */
import { SpectrumAnalyzer } from './spectrum.js';
import { designFilters, detectionResponseDb, processingGainDb } from './detection.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const F_MIN = 20, F_MAX = 20000;
const HISTORY_S = 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function fmtHz(f, short = false) {
  if (f >= 1000) {
    const k = f / 1000;
    const s = (k >= 10 ? k.toFixed(short ? 0 : 1) : k.toFixed(short ? 1 : 2)).replace(/\.0+$/, '');
    return s + (short ? 'k' : ' кГц');
  }
  return f.toFixed(0) + (short ? '' : ' Гц');
}
export const fmtDb = (v, d = 1) => (v > 0.05 ? '+' : v < -0.05 ? '−' : '') + Math.abs(v).toFixed(d) + ' дБ';

export class DeEssGraph {
  /**
   * @param {HTMLElement} wrap    контейнер графика / graph container
   * @param {object} els          { history: canvas, grBar: canvas, led, grText, inMeter, outMeter }
   */
  constructor(wrap, els, { lowPower = false } = {}) {
    this.wrap = wrap;
    this.els = els;
    this.lowPower = lowPower;
    this.plugin = null;
    this.w = 0; this.h = 0; this.dpr = 1;
    this.dragging = false;
    this.hover = false;
    this.hist = [];           // { t, gr, det, thr }
    this.grDisp = 0;          // сглаженное значение для стрелки / smoothed needle value
    this.dirtyGrid = true;
    this._build();
    this._colors();
    this.specIn = new SpectrumAnalyzer({ xToFreq: (x) => this.xToFreq(x), dbToY: (d) => this.specToY(d) });
    this.specOut = new SpectrumAnalyzer({ xToFreq: (x) => this.xToFreq(x), dbToY: (d) => this.specToY(d), decay: 1.6 });
    if ('ResizeObserver' in window) {
      this._ro = new ResizeObserver(() => this.resize());
      this._ro.observe(wrap);
      if (els.history) this._ro.observe(els.history);
    } else window.addEventListener('resize', () => this.resize());
  }

  _build() {
    const mk = (cls) => { const c = document.createElement('canvas'); c.className = 'g-layer ' + cls; c.setAttribute('aria-hidden', 'true'); this.wrap.appendChild(c); return c; };
    this.cGrid = mk('ds-grid');
    this.cMain = mk('ds-main');
    this.xGrid = this.cGrid.getContext('2d');
    this.xMain = this.cMain.getContext('2d');
    this.svg = document.createElementNS(SVGNS, 'svg');
    this.svg.setAttribute('class', 'g-layer g-nodes');
    this.svg.setAttribute('role', 'application');
    this.svg.setAttribute('aria-label', 'График де-эссера: перетащите узел — частота и порог');
    this.svg.innerHTML = `<g class="node ds-node"><circle class="node-hit"></circle><circle class="node-halo"></circle><circle class="node-dot"></circle><text class="node-num" text-anchor="middle" dominant-baseline="central">S</text></g>`;
    this.node = this.svg.querySelector('.ds-node');
    this.wrap.appendChild(this.svg);

    this.loupe = document.createElement('div');
    this.loupe.className = 'g-loupe';
    this.loupe.innerHTML = '<canvas></canvas><div class="g-loupe-text mono"></div>';
    this.wrap.appendChild(this.loupe);
    this.tip = document.createElement('div');
    this.tip.className = 'g-tip mono';
    this.tip.setAttribute('role', 'status');
    this.wrap.appendChild(this.tip);
    this.badge = document.createElement('div');
    this.badge.className = 'g-badge mono';
    this.wrap.appendChild(this.badge);
  }

  _colors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n, d) => cs.getPropertyValue(n).trim() || d;
    this.col = {
      bg: v('--graph-bg', '#151515'),
      grid: v('--grid', 'rgba(255,255,255,0.05)'),
      gridMajor: v('--grid-major', 'rgba(255,255,255,0.11)'),
      label: v('--label', 'rgba(255,255,255,0.5)'),
      ds: v('--ds', '#00b4d8'),
      gr: v('--gr', '#ff6b35')
    };
  }

  refreshTheme() { this._colors(); this.dirtyGrid = true; }

  bind(plugin, engine) {
    this.plugin = plugin;
    this.engine = engine;
    this.hist = [];
    this.specIn.reset(); this.specOut.reset();
    this._filtersKey = '';
    this.dirtyGrid = true;
  }

  get model() { return this.plugin ? this.plugin.model : null; }
  get fs() { return this.plugin ? this.plugin.ctx.sampleRate : 48000; }

  /* ---------------- геометрия / geometry ---------------- */

  resize() {
    const r = this.wrap.getBoundingClientRect();
    const w = Math.max(10, Math.round(r.width)), h = Math.max(10, Math.round(r.height));
    const dpr = Math.min(window.devicePixelRatio || 1, this.lowPower ? 1.5 : 2.5);
    const hc = this.els.history;
    if (hc) {
      const hr = hc.getBoundingClientRect();
      hc.width = Math.round(hr.width * dpr); hc.height = Math.round(hr.height * dpr);
      this.histW = hr.width; this.histH = hr.height;
    }
    const gb = this.els.grBar;
    if (gb) {
      const br = gb.getBoundingClientRect();
      gb.width = Math.round(br.width * dpr); gb.height = Math.round(br.height * dpr);
      this.barW = br.width; this.barH = br.height;
    }
    if (w === this.w && h === this.h && dpr === this.dpr) { this.render(); return; }
    this.w = w; this.h = h; this.dpr = dpr;
    for (const c of [this.cGrid, this.cMain]) {
      c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
      c.style.width = w + 'px'; c.style.height = h + 'px';
    }
    this.svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    this.svg.setAttribute('width', w); this.svg.setAttribute('height', h);
    this.compact = w < 480;
    this.nodeR = parseFloat(getComputedStyle(this.wrap).getPropertyValue('--node-r')) || 14;
    this.specIn.reset(); this.specOut.reset();
    this.dirtyGrid = true;
    this.render(); // перерисовка сразу — очищенный canvas не успевает «мигнуть» / redraw immediately
  }

  get padTop() { return 8; }
  get padBottom() { return this.compact ? 18 : 22; }
  freqToX(f) { return (Math.log(f / F_MIN) / Math.log(F_MAX / F_MIN)) * this.w; }
  xToFreq(x) { return F_MIN * Math.pow(F_MAX / F_MIN, x / this.w); }
  specToY(db) { return this.padTop + (-db / 90) * (this.h - this.padTop - this.padBottom); }
  yToSpec(y) { return -((y - this.padTop) / (this.h - this.padTop - this.padBottom)) * 90; }
  /** Шкала усиления обработки 0…−30 дБ / processing gain scale. */
  gainToY(db) { const top = this.padTop + (this.h - this.padTop - this.padBottom) * 0.06; return top + (-db / 30) * (this.h - this.padBottom - top); }

  nodePos() {
    const p = this.model.params;
    const thr = p.autoThreshold ? this.plugin.meters.thr : p.threshold;
    const m = (this.nodeR || 10) + 2;
    return { x: clamp(this.freqToX(p.frequency), m, this.w - m), y: clamp(this.specToY(thr), this.padTop + m, this.h - this.padBottom - m) };
  }

  hitNode(x, y, type = 'mouse') {
    if (!this.model) return false;
    const p = this.nodePos();
    return Math.hypot(p.x - x, p.y - y) <= (type === 'mouse' ? this.nodeR + 5 : this.nodeR * 2);
  }

  /** Близко к линии порога внутри зоны детекции / near the threshold line. */
  hitThreshold(x, y) {
    if (!this.model) return false;
    return x >= this.freqToX(this.model.params.frequency) - 10 && Math.abs(y - this.nodePos().y) < 18;
  }

  /* ---------------- цикл / loop ---------------- */

  start() {
    if (this._running) return;
    this._running = true;
    let n = 0;
    const loop = () => {
      if (!this._running) return;
      this._raf = requestAnimationFrame(loop);
      if (document.hidden) return;
      // Слабые устройства: 30 fps / weak devices: 30 fps
      if (this.lowPower && (n++ & 1)) return;
      this.render();
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() { this._running = false; cancelAnimationFrame(this._raf); }

  render() {
    if (!this.w || !this.plugin) return;
    if (this.dirtyGrid) { this._drawGrid(); this.dirtyGrid = false; }
    this._pushHistory();
    this._drawMain();
    this._drawNode();
    this._drawMeters();
  }

  _filters() {
    const p = this.model.params;
    const key = `${p.frequency}|${p.filterShape}|${p.slope}|${this.fs}`;
    if (key !== this._filtersKey) {
      this._filtersKey = key;
      this._flt = designFilters(p, this.fs);
      this._detCurve = null;
    }
    return this._flt;
  }

  /* ---------------- сетка / grid ---------------- */

  _drawGrid() {
    const c = this.xGrid, { w, h, dpr } = this;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = this.col.bg;
    c.fillRect(0, 0, w, h);
    c.lineWidth = 1;
    c.strokeStyle = this.col.grid;
    c.beginPath();
    for (let dec = 10; dec <= 10000; dec *= 10) {
      for (let k = 1; k <= 9; k++) {
        const f = dec * k;
        if (f < F_MIN || f > F_MAX) continue;
        const x = Math.round(this.freqToX(f)) + 0.5;
        c.moveTo(x, 0); c.lineTo(x, h - this.padBottom);
      }
    }
    c.stroke();
    // Подписи частот: меньше на узких экранах / fewer labels on narrow screens
    const labels = this.compact ? [100, 1000, 5000, 10000] : [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
    c.strokeStyle = this.col.gridMajor;
    c.beginPath();
    for (const f of labels) { const x = Math.round(this.freqToX(f)) + 0.5; c.moveTo(x, 0); c.lineTo(x, h - this.padBottom); }
    for (let d = 0; d >= -90; d -= this.compact ? 20 : 10) { const y = Math.round(this.specToY(d)) + 0.5; c.moveTo(0, y); c.lineTo(w, y); }
    c.stroke();
    c.font = `${this.compact ? 10 : 11}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
    c.fillStyle = this.col.label;
    c.textAlign = 'left';
    c.textBaseline = 'middle';
    for (let d = -20; d > -90; d -= 20) c.fillText(String(d), 4, this.specToY(d) - 7);
    c.textAlign = 'right';
    c.fillStyle = this.col.ds;
    c.globalAlpha = 0.8;
    for (let g = 0; g >= -30; g -= this.compact ? 10 : 6) c.fillText(String(g), w - 4, this.gainToY(g) - 7);
    c.globalAlpha = 1;
    c.fillStyle = this.col.label;
    c.textAlign = 'center';
    c.textBaseline = 'alphabetic';
    for (const f of labels) {
      const t = fmtHz(f, true);
      const tw = c.measureText(t).width;
      c.fillText(t, clamp(this.freqToX(f), tw / 2 + 2, w - tw / 2 - 2), h - 6);
    }
  }

  /* ---------------- основной слой / main layer ---------------- */

  _active() { return !!(this.engine && this.engine.running && this.engine.hasSignal); }

  _drawMain() {
    const c = this.xMain, { w, h, dpr } = this;
    const p = this.model.params;
    const m = this.plugin.meters;
    const flt = this._filters();
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    const bottom = h - this.padBottom;

    // 1) Зона детекции: прозрачность ∝ АЧХ фильтра детекции / detection zone
    if (!this._detCurve || this._detCurve.w !== w) {
      const step = 3, arr = [];
      for (let x = 0; x <= w + step; x += step) arr.push(detectionResponseDb(flt, this.xToFreq(x), this.fs));
      this._detCurve = { w, step, arr };
    }
    const dc = this._detCurve;
    const active = m.gr > 0.3 && !p.bypass;
    for (let i = 0; i < dc.arr.length; i++) {
      const a = Math.pow(10, dc.arr[i] / 20);
      if (a < 0.03) continue;
      c.fillStyle = `rgba(0,180,216,${(a * (active ? 0.2 : 0.12)).toFixed(3)})`;
      c.fillRect(i * dc.step, 0, dc.step + 0.5, bottom);
    }

    // 2) Спектр входа (серо-зелёный) и выхода (линия) — лениво, только при сигнале
    // Input (grey-green) and output (line) spectrum — lazy, only with signal
    if (this._active()) {
      const step = this.lowPower || this.compact ? 3 : 2;
      this.specIn.update(this.plugin.inAnalyser, w, this.fs, step);
      this.specIn.draw(c, bottom);
      this.specOut.update(this.plugin.outAnalyser, w, this.fs, step);
      this.specOut.draw(c, bottom, { fill: false, line: 'rgba(0,180,216,0.55)' });
    } else {
      this.specIn.reset(); this.specOut.reset();
    }

    // 3) Кривая фильтра детекции (тонкая) / detection filter curve (thin)
    c.beginPath();
    for (let i = 0; i < dc.arr.length; i++) {
      const y = this.gainToY(Math.max(dc.arr[i], -30));
      i ? c.lineTo(i * dc.step, y) : c.moveTo(0, y);
    }
    c.setLineDash([3, 4]);
    c.strokeStyle = 'rgba(0,180,216,0.55)';
    c.lineWidth = 1;
    c.stroke();
    c.setLineDash([]);

    // 4) Кривая обработки + полупрозрачная зона подавления / processing curve + reduction area
    const gr = p.bypass ? 0 : this.grDisp;
    const pts = [];
    const stepC = this.compact ? 4 : 3;
    for (let x = 0; x <= w + stepC; x += stepC) pts.push([x, this.gainToY(Math.max(-30, processingGainDb(p, flt, gr, this.xToFreq(x), this.fs)))]);
    const y0 = this.gainToY(0);
    c.beginPath();
    c.moveTo(0, y0);
    for (const [x, y] of pts) c.lineTo(x, y);
    c.lineTo(w, y0);
    c.closePath();
    c.fillStyle = 'rgba(0,180,216,0.28)';
    c.fill();
    c.beginPath();
    pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
    c.strokeStyle = p.bypass ? 'rgba(150,150,150,0.7)' : this.col.ds;
    c.lineWidth = 2.2;
    if (!this.lowPower) { c.shadowColor = 'rgba(0,180,216,0.6)'; c.shadowBlur = 8; }
    c.stroke();
    c.shadowBlur = 0;

    // 5) Порог и уровень детекции / threshold and detection level
    const x0 = p.filterShape === 'bandpass' ? this.freqToX(p.frequency * 0.7) : this.freqToX(p.frequency);
    const x1 = p.filterShape === 'bandpass' ? this.freqToX(p.frequency * 2.2) : w;
    const thr = p.autoThreshold ? m.thr : p.threshold;
    const ty = this.specToY(thr);
    c.setLineDash([6, 4]);
    c.strokeStyle = 'rgba(255,255,255,0.75)';
    c.lineWidth = 1.2;
    c.beginPath(); c.moveTo(x0, ty); c.lineTo(x1, ty); c.stroke();
    c.setLineDash([]);
    if (this._active() && m.det > -100) {
      const dy = clamp(this.specToY(m.det), this.padTop, bottom);
      c.fillStyle = m.det > thr ? this.col.gr : 'rgba(200,220,210,0.7)';
      c.fillRect(x0 + 2, dy - 1.5, Math.min(60, x1 - x0 - 4), 3);
    }
  }

  _drawNode() {
    const p = this.nodePos();
    const r = this.nodeR;
    const [hit, halo, dot] = this.node.children;
    this.node.setAttribute('transform', `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`);
    this.node.style.setProperty('--c', this.col.ds);
    hit.setAttribute('r', r * 2); // зона захвата ×2 / 2× capture zone
    halo.setAttribute('r', r + 6);
    dot.setAttribute('r', r);
    this.node.classList.toggle('is-drag', this.dragging);
    this.node.classList.toggle('is-hover', this.hover);
    this.node.classList.toggle('is-selected', this.model.selected === 'frequency' || this.model.selected === 'threshold');
    const b = this.model.params.bypass, a = this.model.params.audition;
    const txt = `${b ? 'ОБХОД · ' : ''}${a ? 'ПРОСЛУШИВАНИЕ · ' : ''}Упреждение ${this.model.params.lookahead.toFixed(1)} мс`;
    if (this.badge.textContent !== txt) this.badge.textContent = txt;
    this.wrap.classList.toggle('is-bypassed', b);
    this.wrap.classList.toggle('is-audition', a);
  }

  /* ---------------- GR: история и метры / history and meters ---------------- */

  _pushHistory() {
    const m = this.plugin.meters;
    const now = performance.now();
    // Стрелка: быстрая атака, плавный спад / needle: fast attack, smooth fall
    this.grDisp = m.gr > this.grDisp ? m.gr : this.grDisp + (m.gr - this.grDisp) * 0.18;
    this.hist.push({ t: now, gr: m.gr, det: m.det, thr: m.thr });
    while (this.hist.length && now - this.hist[0].t > HISTORY_S * 1000) this.hist.shift();
  }

  get peakGr() { let pk = 0; for (const e of this.hist) if (e.gr > pk) pk = e.gr; return pk; }

  _drawMeters() {
    const { els, dpr } = this;
    const m = this.plugin.meters;
    const range = Math.max(1, this.model.params.range);
    const on = m.gr > 0.5 && !this.model.params.bypass;
    if (els.led) els.led.classList.toggle('is-on', on);
    if (els.grText) {
      const t = (this.grDisp > 0.05 ? '−' : '') + this.grDisp.toFixed(1);
      if (els.grText.textContent !== t) els.grText.textContent = t;
    }
    if (els.peakText) {
      const t = (this.peakGr > 0.05 ? '−' : '') + this.peakGr.toFixed(1);
      if (els.peakText.textContent !== t) els.peakText.textContent = t;
    }
    // Вертикальная полоса GR вниз от 0 дБ + пик за 2 с / GR bar down from 0 dB + 2 s peak
    const gb = els.grBar;
    if (gb && this.barH) {
      const c = gb.getContext('2d');
      const W = this.barW, H = this.barH;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, W, H);
      c.fillStyle = 'rgba(255,255,255,0.06)';
      c.fillRect(0, 0, W, H);
      const scale = (v) => (Math.min(v, 30) / 30) * H;
      const g = c.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, '#ffb347'); g.addColorStop(1, '#ff3b30');
      c.fillStyle = g;
      c.fillRect(0, 0, W, scale(this.grDisp));
      c.fillStyle = '#fff';
      c.fillRect(0, scale(this.peakGr) - 1, W, 2);
      c.fillStyle = 'rgba(0,180,216,0.8)';
      c.fillRect(0, scale(range) - 0.5, W, 1); // метка Range / range mark
    }
    // История 2 с / 2 s history strip
    const hc = els.history;
    if (hc && this.histW) {
      const c = hc.getContext('2d');
      const W = this.histW, H = this.histH;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, W, H);
      const now = performance.now();
      const X = (t) => W - ((now - t) / (HISTORY_S * 1000)) * W;
      // уровень детекции (серо-зелёный) / detection level
      c.beginPath();
      c.moveTo(W, H);
      for (let i = this.hist.length - 1; i >= 0; i--) {
        const e = this.hist[i];
        c.lineTo(X(e.t), H - clamp((e.det + 90) / 90, 0, 1) * H);
      }
      c.lineTo(X(this.hist[0]?.t ?? now), H);
      c.closePath();
      c.fillStyle = 'rgba(120,200,150,0.22)';
      c.fill();
      // подавление (красно-оранжевое, вниз от верха) / reduction (down from the top)
      c.beginPath();
      c.moveTo(W, 0);
      for (let i = this.hist.length - 1; i >= 0; i--) {
        const e = this.hist[i];
        c.lineTo(X(e.t), (Math.min(e.gr, 30) / range) * H * 0.9);
      }
      c.lineTo(X(this.hist[0]?.t ?? now), 0);
      c.closePath();
      const g = c.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, 'rgba(255,140,60,0.9)'); g.addColorStop(1, 'rgba(255,59,48,0.9)');
      c.fillStyle = g;
      c.fill();
    }
    const lvl = (el, v) => {
      if (!el) return;
      const pct = clamp((20 * Math.log10(v + 1e-9) + 60) / 60, 0, 1);
      el.style.transform = `scaleY(${pct.toFixed(3)})`;
    };
    lvl(els.inMeter, this._active() ? m.inPk : 0);
    lvl(els.outMeter, this._active() ? m.outPk : 0);
  }

  /* ---------------- лупа, подсказка, ripple / loupe, tip, ripple ---------------- */

  showLoupe(x, y, text) {
    const size = 120, zoom = 2, dpr = this.dpr;
    const lc = this.loupe.querySelector('canvas');
    if (lc.width !== size * dpr) { lc.width = lc.height = size * dpr; lc.style.width = lc.style.height = size + 'px'; }
    const c = lc.getContext('2d');
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, lc.width, lc.height);
    const src = size / zoom;
    for (const layer of [this.cGrid, this.cMain]) {
      try { c.drawImage(layer, (x - src / 2) * dpr, (y - src / 2) * dpr, src * dpr, src * dpr, 0, 0, lc.width, lc.height); } catch { /* out of bounds */ }
    }
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.strokeStyle = 'rgba(255,255,255,0.4)';
    c.beginPath(); c.moveTo(size / 2, 0); c.lineTo(size / 2, size); c.moveTo(0, size / 2); c.lineTo(size, size / 2); c.stroke();
    c.beginPath(); c.arc(size / 2, size / 2, 9, 0, Math.PI * 2); c.fillStyle = this.col.ds; c.fill();
    c.lineWidth = 2; c.strokeStyle = '#fff'; c.stroke();
    this.loupe.querySelector('.g-loupe-text').textContent = text;
    let lx = x - size / 2, ly = y - size - 56;
    if (ly < 4) { ly = clamp(y - size / 2, 4, this.h - size - 30); lx = x + (x > this.w / 2 ? -size - 50 : 50); }
    this.loupe.style.transform = `translate(${clamp(lx, 4, this.w - size - 4)}px, ${ly}px)`;
    this.loupe.classList.add('is-on');
  }

  hideLoupe() { this.loupe.classList.remove('is-on'); }

  showTip(html, x, y, ms = 0) {
    if (!html) { this.tip.classList.remove('is-on'); return; }
    this.tip.innerHTML = html;
    this.tip.style.transform = `translate(${clamp(x + 18, 4, this.w - 150)}px, ${clamp(y - 70, 4, this.h - 90)}px)`;
    this.tip.classList.add('is-on');
    clearTimeout(this._tipT);
    if (ms) this._tipT = setTimeout(() => this.tip.classList.remove('is-on'), ms);
  }

  ripple(x, y) {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const s = document.createElement('span');
    s.className = 'g-ripple';
    s.style.left = x + 'px';
    s.style.top = y + 'px';
    s.style.setProperty('--c', this.col.ds);
    this.wrap.appendChild(s);
    s.addEventListener('animationend', () => s.remove(), { once: true });
    setTimeout(() => s.remove(), 1000);
  }
}
