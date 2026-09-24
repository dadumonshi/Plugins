/**
 * denoise-graph.js — график Movexe DeNoise: спектр входа/выхода, профиль шума (красно-
 * оранжевая область), остаточный шум, кривая подавления в реальном времени (циан),
 * целевая кривая (рисуется пальцем), точки, зум по частоте, лупа, прогресс обучения.
 * denoise-graph.js — Movexe DeNoise graph.
 *
 * Шкалы / scales:
 *   слева — уровень по бинам, дБ (0 = синус 0 дБFS) — спектр, профиль, порог;
 *   справа (циан) — подавление 0…−40 дБ.
 */
import { CURVE_FREQS, curveAt } from './spectral.js';
import { canvasDpr, releaseCanvas } from './touch.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const F_MIN = 20, F_MAX = 20000, DB_TOP = 0, DB_BOT = -110, RED_MAX = 40;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const fmtHzRu = (f) => (f >= 1000 ? (f / 1000).toFixed(f >= 10000 ? 1 : 2).replace(/\.?0+$/, '') + ' кГц' : f.toFixed(0) + ' Гц');

export class DenoiseGraph {
  constructor(wrap, { lowPower = false } = {}) {
    this.wrap = wrap;
    this.lowPower = lowPower;
    this.plugin = null;
    this.view = { fMin: F_MIN, fMax: F_MAX };
    this.w = 0; this.h = 0; this.dpr = 1;
    this.dirtyGrid = true;
    this.disp = null;          // сглаженные столбцы спектра / smoothed spectrum columns
    this.drawing = null;       // точка рисования (для лупы) / drawing point
    const mk = (cls) => { const c = document.createElement('canvas'); c.className = 'g-layer ' + cls; c.setAttribute('aria-hidden', 'true'); wrap.appendChild(c); return c; };
    this.cGrid = mk('dn-grid');
    this.cMain = mk('dn-main');
    this.svg = document.createElementNS(SVGNS, 'svg');
    this.svg.setAttribute('class', 'g-layer g-nodes dn-taps');
    this.svg.setAttribute('aria-label', 'Спектр: рисуйте кривую подавления пальцем');
    this.svg.innerHTML = '<g class="node dn-point" style="display:none"><circle class="node-hit"></circle><circle class="node-halo"></circle><circle class="node-dot"></circle></g>';
    this.point = this.svg.querySelector('.dn-point');
    wrap.appendChild(this.svg);
    this.loupe = document.createElement('div');
    this.loupe.className = 'g-loupe';
    this.loupe.innerHTML = '<canvas></canvas><div class="g-loupe-text mono"></div>';
    wrap.appendChild(this.loupe);
    this.tip = document.createElement('div');
    this.tip.className = 'g-tip mono';
    wrap.appendChild(this.tip);
    this.badge = document.createElement('div');
    this.badge.className = 'g-badge mono';
    wrap.appendChild(this.badge);
    this.learnBar = document.createElement('div');
    this.learnBar.className = 'dn-learnbar';
    this.learnBar.innerHTML = '<i></i><span></span>';
    wrap.appendChild(this.learnBar);
    if ('ResizeObserver' in window) { this._ro = new ResizeObserver(() => this.resize()); this._ro.observe(wrap); }
    else window.addEventListener('resize', () => this.resize());
  }

  bind(plugin, engine) {
    this.plugin = plugin;
    this.engine = engine;
    this.disp = null;
    this.dirtyGrid = true;
  }

  get model() { return this.plugin?.model; }
  get fs() { return this.plugin ? this.plugin.ctx.sampleRate : 48000; }

  /* ---------------- геометрия / geometry ---------------- */
  resize() {
    const r = this.wrap.getBoundingClientRect();
    const w = Math.max(10, Math.round(r.width)), h = Math.max(10, Math.round(r.height));
    const dpr = canvasDpr(this.lowPower);
    if (w === this.w && h === this.h && dpr === this.dpr) return;
    this.w = w; this.h = h; this.dpr = dpr;
    for (const c of [this.cGrid, this.cMain]) {
      c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
      c.style.width = w + 'px'; c.style.height = h + 'px';
    }
    this.svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    this.compact = w < 480;
    this.nodeR = this.compact || matchMedia('(pointer: coarse)').matches ? 14 : 9;
    this._cols = null;
    this.disp = null;
    this.dirtyGrid = true;
    this.render();
  }

  get padTop() { return 8; }
  get padBottom() { return this.compact ? 18 : 22; }
  freqToX(f) { return (Math.log(f / this.view.fMin) / Math.log(this.view.fMax / this.view.fMin)) * this.w; }
  xToFreq(x) { return this.view.fMin * Math.pow(this.view.fMax / this.view.fMin, x / this.w); }
  dbToY(db) { return this.padTop + ((DB_TOP - db) / (DB_TOP - DB_BOT)) * (this.h - this.padTop - this.padBottom); }
  yToDb(y) { return DB_TOP - ((y - this.padTop) / (this.h - this.padTop - this.padBottom)) * (DB_TOP - DB_BOT); }
  get redTop() { return this.padTop + (this.h - this.padTop - this.padBottom) * 0.06; }
  /** Подавление (дБ, ≥0) → y / reduction depth → y */
  redToY(d) { return this.redTop + (clamp(d, 0, RED_MAX) / RED_MAX) * (this.h - this.padBottom - this.redTop); }
  yToRed(y) { return clamp(((y - this.redTop) / (this.h - this.padBottom - this.redTop)) * RED_MAX, 0, RED_MAX); }

  /** Зум/сдвиг по частоте (минимум 2 октавы) / frequency zoom/pan (min 2 octaves). */
  setView(fMin, fMax) {
    let a = clamp(fMin, F_MIN, F_MAX), b = clamp(fMax, F_MIN, F_MAX);
    if (b / a < 4) { const c = Math.sqrt(a * b); a = Math.max(F_MIN, c / 2); b = Math.min(F_MAX, a * 4); }
    this.view = { fMin: a, fMax: b };
    this._cols = null;
    this.disp = null;
    this.dirtyGrid = true;
  }
  resetView() { this.setView(F_MIN, F_MAX); }
  get zoomed() { return this.view.fMin > F_MIN * 1.01 || this.view.fMax < F_MAX * 0.99; }

  /** Экранные координаты точки кривой / screen position of a curve point. */
  pointPos(i) {
    const m = this.model;
    const f = CURVE_FREQS[i];
    const y = m.target === 'profile' ? this.dbToY(this.profileDb(f)) : this.redToY(this.depthAt(f));
    return { x: this.freqToX(f), y };
  }
  depthAt(f) { const m = this.model; return curveAt(m.reductionCurve, f, m.params.reduction); }
  /** Профиль с правкой (дБ) на частоте f / edited profile level at f. */
  profileDb(f) {
    const m = this.model;
    const base = this._baseProfileAt(f);
    return base + curveAt(m.profileOffset, f, 0);
  }
  _baseProfileAt(f) {
    const p = this.model.profile;
    if (!p) {
      // Без профиля — живая оценка шума / without a print — the live estimate
      const nz = this.plugin.meters.noise;
      if (!nz) return -100;
      const n = (nz.length - 1) * 2;
      return nz[clamp(Math.round((f / this.fs) * n), 0, nz.length - 1)];
    }
    // Среднее по ±1/12 октавы — ровная линия для редактирования / smoothed for editing
    const n = p.fftSize, fs = p.sampleRate;
    const k0 = Math.max(1, Math.floor((f * Math.pow(2, -1 / 12) / fs) * n));
    const k1 = Math.min(p.bins.length - 1, Math.ceil((f * Math.pow(2, 1 / 12) / fs) * n));
    let s = 0, c = 0;
    for (let k = k0; k <= k1; k++) { s += Math.pow(10, p.bins[k] / 10); c++; }
    return c ? 10 * Math.log10(s / c) : -140;
  }

  /** Ближайшая точка кривой к x / nearest curve point to x. */
  nearestPoint(x) {
    const f = this.xToFreq(x);
    const i = Math.round((Math.log(clamp(f, 20, 20000) / 20) / Math.log(1000)) * 95);
    return clamp(i, 0, 95);
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
      if (this.lowPower && (n++ & 1)) return;
      this.render();
    };
    this._raf = requestAnimationFrame(loop);
  }
  stop() {
    this._running = false;
    cancelAnimationFrame(this._raf);
    [this.cGrid, this.cMain].forEach(releaseCanvas); // скрытый редактор без памяти GPU
    this.w = this.h = 0;
    this.dirtyGrid = true;
  }
  refreshTheme() { this.dirtyGrid = true; }

  /** Колонки экрана → диапазоны бинов / screen columns → bin ranges. */
  _columns(bins) {
    if (this._cols && this._cols.bins === bins && this._cols.w === this.w) return this._cols;
    const step = this.lowPower || this.compact ? 3 : 2;
    const n = (bins - 1) * 2, fs = this.fs;
    const cols = Math.ceil(this.w / step) + 1;
    const k0 = new Uint16Array(cols), k1 = new Uint16Array(cols);
    for (let i = 0; i < cols; i++) {
      const fa = this.xToFreq(i * step), fb = this.xToFreq((i + 1) * step);
      k0[i] = clamp(Math.floor((fa / fs) * n), 0, bins - 1);
      k1[i] = clamp(Math.max(k0[i] + 1, Math.ceil((fb / fs) * n)), 1, bins);
    }
    this._cols = { bins, w: this.w, step, cols, k0, k1 };
    return this._cols;
  }

  _drawGrid() {
    const c = this.cGrid.getContext('2d'), { w, h, dpr } = this;
    const cs = getComputedStyle(document.documentElement);
    const v = (n, d) => cs.getPropertyValue(n).trim() || d;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = v('--graph-bg', '#151515');
    c.fillRect(0, 0, w, h);
    c.strokeStyle = v('--grid', 'rgba(255,255,255,0.05)');
    c.beginPath();
    for (let dec = 10; dec <= 10000; dec *= 10) for (let k = 1; k <= 9; k++) {
      const f = dec * k; if (f < this.view.fMin || f > this.view.fMax) continue;
      const x = Math.round(this.freqToX(f)) + 0.5; c.moveTo(x, 0); c.lineTo(x, h - this.padBottom);
    }
    c.stroke();
    // Подписи частот: не ближе 44 px / labels at least 44 px apart
    const cand = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 30, 300, 3000, 70, 700, 7000].filter((f) => f >= this.view.fMin && f <= this.view.fMax).sort((a, b) => a - b);
    const labels = [];
    for (const f of cand) if (!labels.length || this.freqToX(f) - this.freqToX(labels[labels.length - 1]) >= (this.compact ? 40 : 48)) labels.push(f);
    c.strokeStyle = v('--grid-major', 'rgba(255,255,255,0.11)');
    c.beginPath();
    for (const f of labels) { const x = Math.round(this.freqToX(f)) + 0.5; c.moveTo(x, 0); c.lineTo(x, h - this.padBottom); }
    for (let d = -20; d > DB_BOT; d -= 20) { const y = Math.round(this.dbToY(d)) + 0.5; c.moveTo(0, y); c.lineTo(w, y); }
    c.stroke();
    c.font = `${this.compact ? 10 : 11}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
    c.fillStyle = v('--label', 'rgba(255,255,255,0.5)');
    c.textBaseline = 'middle';
    c.textAlign = 'left';
    for (let d = -20; d > DB_BOT; d -= 20) c.fillText(String(d), 4, this.dbToY(d) - 7);
    c.textAlign = 'right';
    c.fillStyle = 'rgba(0,180,216,0.85)';
    for (let d = 0; d <= RED_MAX; d += this.compact ? 20 : 10) c.fillText(d ? '−' + d : '0', w - 4, this.redToY(d) - 7);
    c.fillStyle = v('--label', 'rgba(255,255,255,0.5)');
    c.textAlign = 'center';
    c.textBaseline = 'alphabetic';
    for (const f of labels) {
      const t = f >= 1000 ? f / 1000 + 'k' : String(f);
      const tw = c.measureText(t).width;
      c.fillText(t, clamp(this.freqToX(f), tw / 2 + 2, w - tw / 2 - 2), h - 6);
    }
  }

  render() {
    if (!this.w || !this.plugin) return;
    if (this.dirtyGrid) { this._drawGrid(); this.dirtyGrid = false; }
    const c = this.cMain.getContext('2d'), { w, h, dpr } = this;
    const m = this.model, p = m.params, mt = this.plugin.meters;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    const bottom = h - this.padBottom;
    const live = mt.gains && performance.now() - mt.t < 500 && this.engine?.running && this.engine.hasSignal;

    if (live) {
      const cl = this._columns(mt.gains.length);
      const { step, cols, k0, k1 } = cl;
      if (!this.disp || this.disp.spec.length !== cols) {
        this.disp = { spec: new Float32Array(cols).fill(-140), noise: new Float32Array(cols), red: new Float32Array(cols), out: new Float32Array(cols) };
      }
      const D = this.disp;
      for (let i = 0; i < cols; i++) {
        let sMax = -200, nSum = 0, gMin = 1, cnt = 0;
        for (let k = k0[i]; k < k1[i]; k++) {
          if (mt.spec[k] > sMax) sMax = mt.spec[k];
          nSum += Math.pow(10, mt.noise[k] / 10);
          if (mt.gains[k] < gMin) gMin = mt.gains[k];
          cnt++;
        }
        // Баллистика: быстрый подъём, плавный спад / fast rise, smooth fall
        D.spec[i] = sMax > D.spec[i] - 1.2 ? sMax : D.spec[i] - 1.2;
        D.noise[i] += ((cnt ? 10 * Math.log10(nSum / cnt) : -140) - D.noise[i]) * 0.3;
        D.red[i] += (-20 * Math.log10(Math.max(gMin, 1e-4)) - D.red[i]) * 0.35;
        D.out[i] = D.spec[i] - D.red[i];
      }
      // 1) спектр входа (серо-зелёный) / input spectrum
      c.beginPath(); c.moveTo(0, bottom);
      for (let i = 0; i < cols; i++) c.lineTo(i * step, clamp(this.dbToY(D.spec[i]), 0, bottom));
      c.lineTo((cols - 1) * step, bottom); c.closePath();
      const g = c.createLinearGradient(0, 0, 0, bottom);
      g.addColorStop(0, 'rgba(120,200,150,0.36)'); g.addColorStop(1, 'rgba(90,110,100,0.04)');
      c.fillStyle = g; c.fill();
      // 2) профиль/оценка шума (красно-оранжевая область) / noise estimate area
      c.beginPath(); c.moveTo(0, bottom);
      for (let i = 0; i < cols; i++) c.lineTo(i * step, clamp(this.dbToY(D.noise[i]), 0, bottom));
      c.lineTo((cols - 1) * step, bottom); c.closePath();
      c.fillStyle = 'rgba(255,90,40,0.22)'; c.fill();
      // 3) остаточный шум (шум − подавление) / residual noise
      c.beginPath();
      for (let i = 0; i < cols; i++) { const y = clamp(this.dbToY(D.noise[i] - D.red[i]), 0, bottom); i ? c.lineTo(i * step, y) : c.moveTo(0, y); }
      c.setLineDash([2, 3]); c.strokeStyle = 'rgba(255,150,80,0.75)'; c.lineWidth = 1.2; c.stroke(); c.setLineDash([]);
      // 4) выход / output
      c.beginPath();
      for (let i = 0; i < cols; i++) { const y = clamp(this.dbToY(D.out[i]), 0, bottom); i ? c.lineTo(i * step, y) : c.moveTo(0, y); }
      c.strokeStyle = 'rgba(160,215,180,0.55)'; c.lineWidth = 1; c.stroke();
      // 5) подавление в реальном времени (циан) / live reduction curve (cyan)
      c.beginPath();
      for (let i = 0; i < cols; i++) { const y = this.redToY(D.red[i]); i ? c.lineTo(i * step, y) : c.moveTo(0, y); }
      c.strokeStyle = '#00b4d8'; c.lineWidth = 2;
      if (!this.lowPower) { c.shadowColor = 'rgba(0,180,216,0.55)'; c.shadowBlur = 7; }
      c.stroke(); c.shadowBlur = 0;
    }

    // 6) профиль шума для редактирования (оранжевая линия) / editable noise print
    const editProfile = m.target === 'profile';
    if (m.profile || editProfile) {
      c.beginPath();
      for (let x = 0; x <= w; x += 3) { const y = clamp(this.dbToY(this.profileDb(this.xToFreq(x))), 0, bottom); x ? c.lineTo(x, y) : c.moveTo(0, y); }
      c.strokeStyle = editProfile ? '#ff7a3d' : 'rgba(255,122,61,0.55)';
      c.lineWidth = editProfile ? 2.2 : 1.2;
      c.stroke();
    }
    // 7) целевая глубина подавления (белая пунктирная) / target depth (dashed white)
    c.beginPath();
    for (let x = 0; x <= w; x += 3) { const y = this.redToY(this.depthAt(this.xToFreq(x))); x ? c.lineTo(x, y) : c.moveTo(0, y); }
    c.setLineDash(m.reductionCurve ? [] : [6, 5]);
    c.strokeStyle = m.target === 'reduction' ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.35)';
    c.lineWidth = m.target === 'reduction' ? 1.8 : 1;
    c.stroke(); c.setLineDash([]);
    // Точки кривой, если между ними ≥ 12 px / curve points when ≥ 12 px apart
    const gap = this.freqToX(CURVE_FREQS[1] * this.view.fMin / 20) - this.freqToX(this.view.fMin);
    if (gap >= 12) {
      c.fillStyle = editProfile ? '#ff7a3d' : '#fff';
      for (let i = 0; i < 96; i++) {
        const pp = this.pointPos(i);
        if (pp.x < -4 || pp.x > w + 4) continue;
        c.beginPath(); c.arc(pp.x, pp.y, 2.5, 0, Math.PI * 2); c.fill();
      }
    }
    // 8) порог / threshold
    if (p.threshold > -79) {
      const ty = this.dbToY(p.threshold);
      c.setLineDash([4, 6]); c.strokeStyle = 'rgba(255,255,255,0.4)';
      c.beginPath(); c.moveTo(0, ty); c.lineTo(w, ty); c.stroke(); c.setLineDash([]);
    }
    // 9) выбранная точка (SVG ≥ 28 px) / selected point
    if (m.selectedPoint >= 0) {
      const pp = this.pointPos(m.selectedPoint);
      this.point.style.display = '';
      this.point.setAttribute('transform', `translate(${pp.x.toFixed(1)} ${clamp(pp.y, 14, bottom - 14).toFixed(1)})`);
      this.point.style.setProperty('--c', editProfile ? '#ff7a3d' : '#00b4d8');
      const [hit, halo, dot] = this.point.children;
      hit.setAttribute('r', this.nodeR * 2); halo.setAttribute('r', this.nodeR + 6); dot.setAttribute('r', this.nodeR);
    } else this.point.style.display = 'none';

    // Обучение / learning
    const lp = m.learnProgress;
    this.learnBar.classList.toggle('is-on', lp >= 0);
    if (lp >= 0) {
      this.learnBar.firstChild.style.transform = `scaleX(${lp.toFixed(3)})`;
      this.learnBar.lastChild.textContent = `Обучение шуму… ${Math.round(lp * 100)} % — не говорите в микрофон`;
    }
    const src = { profile: 'профиль', adaptive: 'адаптивно', auto: 'авто-оценка' }[mt.source] || '';
    const txt = `${p.bypass ? 'ОБХОД · ' : ''}${m.profile ? m.profile.name : 'нет профиля'}${live && src ? ' · шум: ' + src : ''}${p.freeze ? ' · заморожено' : ''}`;
    if (this.badge.textContent !== txt) this.badge.textContent = txt;
    this.wrap.classList.toggle('is-bypassed', p.bypass);
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
    c.strokeStyle = 'rgba(255,255,255,0.45)';
    c.beginPath(); c.moveTo(size / 2, 0); c.lineTo(size / 2, size); c.moveTo(0, size / 2); c.lineTo(size, size / 2); c.stroke();
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
    this.tip.style.transform = `translate(${clamp(x + 18, 4, this.w - 160)}px, ${clamp(y - 70, 4, this.h - 90)}px)`;
    this.tip.classList.add('is-on');
    clearTimeout(this._tipT);
    if (ms) this._tipT = setTimeout(() => this.tip.classList.remove('is-on'), ms);
  }

  ripple(x, y) {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const s = document.createElement('span');
    s.className = 'g-ripple';
    s.style.left = x + 'px'; s.style.top = y + 'px';
    s.style.setProperty('--c', '#00b4d8');
    this.wrap.appendChild(s);
    s.addEventListener('animationend', () => s.remove(), { once: true });
    setTimeout(() => s.remove(), 1000);
  }
}
