/**
 * api560-ui.js — интерфейс Movexe EQ Lite: график (спектр + кривая с Proportional Q),
 * банк из 10 вертикальных фейдеров с мультитачем, лупа над пальцем, индикаторы уровня,
 * панель настроек (bottom sheet).
 * api560-ui.js — Movexe EQ Lite UI: graph (spectrum + Proportional-Q curve), a bank of 10
 * multi-touch vertical faders, finger loupe, level meters, settings panel (bottom sheet).
 */
import {
  LITE_FREQS, LITE_LABELS, GAIN_MAX, proportionalQ, qToOctaves, posToGain, gainToPos,
  applyDetent, bandDb, totalDb
} from './proportionalq.js';
import { LITE_MODES, LITE_MODE_LABELS, LITE_UPSAMPLING } from './api560.js';
import { SpectrumAnalyzer } from './spectrum.js';
import { IndependentPointers } from './gestures.js';
import { Knob } from './mobile-ui.js';
import { haptics, canvasDpr, releaseCanvas } from './touch.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const F_MIN = 20, F_MAX = 20000, RANGE = 15;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const fmtLiteGain = (g) => (g > 0.05 ? '+' : g < -0.05 ? '−' : '') + Math.abs(g).toFixed(1);
const fmtF = (f) => (f >= 1000 ? f / 1000 + ' кГц' : f + ' Гц');

/* ================================================================== *
 *  Лупа над пальцем / finger loupe
 * ================================================================== */
class Loupe {
  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'lite-loupe';
    this.el.innerHTML = '<canvas width="240" height="110"></canvas><div class="lite-loupe-text mono"></div>';
    document.body.appendChild(this.el);
    this.cv = this.el.querySelector('canvas');
    this.txt = this.el.querySelector('.lite-loupe-text');
  }

  /** Показать увеличенную форму полосы и значения над точкой (x, y) экрана. */
  show(x, y, i, gain, fs) {
    const c = this.cv.getContext('2d');
    const W = 240, H = 110;
    c.clearRect(0, 0, W, H);
    c.fillStyle = 'rgba(18,18,18,0.94)';
    c.fillRect(0, 0, W, H);
    c.strokeStyle = 'rgba(255,255,255,0.12)';
    c.beginPath(); c.moveTo(0, H / 2); c.lineTo(W, H / 2); c.stroke();
    // Две октавы вокруг центра полосы, ±12 дБ / two octaves around the band centre
    const f0 = LITE_FREQS[i];
    c.beginPath();
    for (let px = 0; px <= W; px += 3) {
      const f = f0 * Math.pow(2, ((px / W) - 0.5) * 4);
      const y = H / 2 - (bandDb(f0, gain, f, fs) / GAIN_MAX) * (H / 2 - 8);
      px ? c.lineTo(px, y) : c.moveTo(px, y);
    }
    c.strokeStyle = '#ffae00';
    c.lineWidth = 2.5;
    c.stroke();
    const q = proportionalQ(gain);
    this.txt.textContent = `${fmtF(f0)} · ${fmtLiteGain(gain)} дБ · Q ${q.toFixed(2)}`;
    const w = 240;
    const left = clamp(x - w / 2, 6, window.innerWidth - w - 6);
    const top = Math.max(6, y - 170);
    this.el.style.transform = `translate(${left}px, ${top}px)`;
    this.el.classList.add('is-on');
  }

  hide() { this.el.classList.remove('is-on'); }
}

/* ================================================================== *
 *  График / Graph
 * ================================================================== */
export class LiteGraph {
  constructor(wrap, { lowPower = false } = {}) {
    this.wrap = wrap;
    this.lowPower = lowPower;
    this.plugin = null;
    this.w = 0; this.h = 0; this.dpr = 1;
    this.dirtyGrid = true;
    this.active = new Set();   // полосы под пальцем / bands under a finger
    const mk = (cls) => { const c = document.createElement('canvas'); c.className = 'g-layer ' + cls; c.setAttribute('aria-hidden', 'true'); wrap.appendChild(c); return c; };
    this.cGrid = mk('lite-grid');
    this.cMain = mk('lite-main');
    // Tap-area: прозрачный SVG-слой поверх canvas (10 колонок-зон) / tap-area layer
    this.svg = document.createElementNS(SVGNS, 'svg');
    this.svg.setAttribute('class', 'g-layer g-nodes lite-taps');
    this.svg.setAttribute('aria-label', 'Кривая эквалайзера: тяните колонку полосы вверх или вниз');
    wrap.appendChild(this.svg);
    this.specIn = new SpectrumAnalyzer({ xToFreq: (x) => this.xToFreq(x), dbToY: (d) => this.specToY(d) });
    this.specOut = new SpectrumAnalyzer({ xToFreq: (x) => this.xToFreq(x), dbToY: (d) => this.specToY(d), decay: 1.6 });
    if ('ResizeObserver' in window) { this._ro = new ResizeObserver(() => this.resize()); this._ro.observe(wrap); }
    else window.addEventListener('resize', () => this.resize());
  }

  bind(plugin, engine) {
    this.plugin = plugin;
    this.engine = engine;
    this.specIn.reset(); this.specOut.reset();
    this.dirtyGrid = true;
  }

  get fs() { return this.plugin ? this.plugin.ctx.sampleRate : 48000; }
  get model() { return this.plugin?.model; }

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
    // Колонки полос: границы — геометрические середины между центрами / band columns
    this.svg.innerHTML = LITE_FREQS.map((f, i) => {
      const x0 = i ? this.freqToX(Math.sqrt(f * LITE_FREQS[i - 1])) : 0;
      const x1 = i < 9 ? this.freqToX(Math.sqrt(f * LITE_FREQS[i + 1])) : w;
      return `<rect class="lite-col" data-i="${i}" x="${x0}" y="0" width="${x1 - x0}" height="${h}"></rect>`;
    }).join('');
    this.specIn.reset(); this.specOut.reset();
    this.dirtyGrid = true;
    this.render(); // сразу — без «мигания» очищенного canvas / immediately — no flash
  }

  get padTop() { return 8; }
  get padBottom() { return this.compact ? 18 : 22; }
  freqToX(f) { return (Math.log(f / F_MIN) / Math.log(F_MAX / F_MIN)) * this.w; }
  xToFreq(x) { return F_MIN * Math.pow(F_MAX / F_MIN, x / this.w); }
  gainToY(g) { return this.padTop + ((RANGE - g) / (2 * RANGE)) * (this.h - this.padTop - this.padBottom); }
  get pxPerDb() { return (this.h - this.padTop - this.padBottom) / (2 * RANGE); }
  specToY(db) { return this.padTop + (-db / 90) * (this.h - this.padTop - this.padBottom); }

  /** Полоса по координате x (ближайший центр в лог-шкале) / band at x. */
  bandAtX(x) {
    const f = this.xToFreq(x);
    let best = 0, bd = Infinity;
    LITE_FREQS.forEach((c, i) => { const d = Math.abs(Math.log2(f / c)); if (d < bd) { bd = d; best = i; } });
    return best;
  }

  start() {
    if (this._running) return;
    this._running = true;
    let n = 0;
    const loop = () => {
      if (!this._running) return;
      this._raf = requestAnimationFrame(loop);
      if (document.hidden) return;
      if (this.lowPower && (n++ & 1)) return; // 30 fps на слабых / 30 fps on weak devices
      this.render();
    };
    this._raf = requestAnimationFrame(loop);
  }
  stop() {
    this._running = false;
    cancelAnimationFrame(this._raf);
    // Скрытый редактор не держит память GPU / a hidden editor holds no GPU memory
    [this.cGrid, this.cMain].forEach(releaseCanvas);
    this.w = this.h = 0;
    this.dirtyGrid = true;
  }

  refreshTheme() { this.dirtyGrid = true; }

  _drawGrid() {
    const c = this.cGrid.getContext('2d'), { w, h, dpr } = this;
    const cs = getComputedStyle(document.documentElement);
    const v = (n, d) => cs.getPropertyValue(n).trim() || d;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = v('--graph-bg', '#151515');
    c.fillRect(0, 0, w, h);
    c.strokeStyle = v('--grid', 'rgba(255,255,255,0.05)');
    c.lineWidth = 1;
    c.beginPath();
    for (let dec = 10; dec <= 10000; dec *= 10) for (let k = 1; k <= 9; k++) {
      const f = dec * k; if (f < F_MIN || f > F_MAX) continue;
      const x = Math.round(this.freqToX(f)) + 0.5; c.moveTo(x, 0); c.lineTo(x, h - this.padBottom);
    }
    c.stroke();
    // Колонки фиксированных полос / fixed band columns
    c.strokeStyle = 'rgba(255,174,0,0.16)';
    c.beginPath();
    for (const f of LITE_FREQS) { const x = Math.round(this.freqToX(f)) + 0.5; c.moveTo(x, 0); c.lineTo(x, h - this.padBottom); }
    c.stroke();
    c.strokeStyle = v('--grid-major', 'rgba(255,255,255,0.11)');
    c.font = `${this.compact ? 10 : 11}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
    c.fillStyle = v('--label', 'rgba(255,255,255,0.5)');
    c.textAlign = 'right';
    c.textBaseline = 'middle';
    // Шаг подписей по реальной высоте: ≥ 16 px между строками / label step from real height
    const stepDb = this.pxPerDb * 3 >= 16 ? 3 : this.pxPerDb * 6 >= 16 ? 6 : 12;
    for (let g = -12; g <= 12; g += stepDb) {
      const y = Math.round(this.gainToY(g)) + 0.5;
      c.strokeStyle = g === 0 ? v('--grid-zero', 'rgba(255,255,255,0.28)') : v('--grid-major', 'rgba(255,255,255,0.11)');
      c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke();
      c.fillText((g > 0 ? '+' : '') + g, w - 4, y - 7);
    }
    c.textAlign = 'center';
    c.textBaseline = 'alphabetic';
    LITE_FREQS.forEach((f, i) => {
      if (this.compact && i % 2 && i !== 9) return; // меньше подписей на узких / fewer labels
      c.fillText(LITE_LABELS[i], clamp(this.freqToX(f), 12, w - 14), h - 6);
    });
  }

  render() {
    if (!this.w || !this.plugin) return;
    if (this.dirtyGrid) { this._drawGrid(); this.dirtyGrid = false; }
    const c = this.cMain.getContext('2d'), { w, h, dpr } = this;
    const p = this.model.params;
    const fs = this.fs;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    const bottom = h - this.padBottom;

    // Спектр (лениво — только при сигнале) / spectrum (lazy — only with signal)
    if (this.engine?.running && this.engine.hasSignal) {
      const step = this.lowPower || this.compact ? 3 : 2;
      this.specIn.update(this.plugin.inAnalyser, w, fs, step);
      this.specIn.draw(c, bottom);
      this.specOut.update(this.plugin.outAnalyser, w, fs, step);
      this.specOut.draw(c, bottom, { fill: false, line: 'rgba(255,174,0,0.45)' });
    } else { this.specIn.reset(); this.specOut.reset(); }

    // Выделенные/активные полосы: заливка формы (видно, как Q сужается с усилением)
    // Selected/active bands: filled shape (shows Q narrowing with gain)
    const hl = new Set(this.active);
    if (this.model.selected >= 0) hl.add(this.model.selected);
    const y0 = this.gainToY(0);
    for (const i of hl) {
      const g = p.gains[i];
      if (Math.abs(g) < 0.05) continue;
      c.beginPath();
      c.moveTo(0, y0);
      for (let x = 0; x <= w; x += 3) c.lineTo(x, this.gainToY(bandDb(LITE_FREQS[i], g, this.xToFreq(x), fs)));
      c.lineTo(w, y0);
      c.closePath();
      c.fillStyle = 'rgba(255,174,0,0.22)';
      c.fill();
      c.strokeStyle = 'rgba(255,174,0,0.9)';
      c.lineWidth = 1.2;
      c.stroke();
    }

    // Суммарная кривая / total curve
    c.beginPath();
    const step = this.compact ? 3 : 2;
    for (let x = 0; x <= w + step; x += step) {
      const y = clamp(this.gainToY(totalDb(p.gains, this.xToFreq(x), fs)), -20, h + 20);
      x ? c.lineTo(x, y) : c.moveTo(0, y);
    }
    c.strokeStyle = p.bypass ? 'rgba(150,150,150,0.7)' : '#1fc8ff';
    c.lineWidth = this.compact ? 2.2 : 2.5;
    if (!this.lowPower) { c.shadowColor = 'rgba(31,200,255,0.55)'; c.shadowBlur = 8; }
    c.stroke();
    c.shadowBlur = 0;

    // Маркеры полос / band markers
    const r = this.compact ? 5 : 6;
    LITE_FREQS.forEach((f, i) => {
      const x = this.freqToX(f), y = this.gainToY(p.gains[i]);
      const on = hl.has(i);
      c.beginPath();
      c.arc(x, y, on ? r + 3 : r, 0, Math.PI * 2);
      c.fillStyle = Math.abs(p.gains[i]) < 0.05 ? 'rgba(255,174,0,0.35)' : '#ffae00';
      c.fill();
      if (on) { c.lineWidth = 2; c.strokeStyle = '#fff'; c.stroke(); }
    });
    this.wrap.classList.toggle('is-bypassed', p.bypass);
  }
}

/* ================================================================== *
 *  Банк фейдеров / Fader bank
 * ================================================================== */
export class FaderBank {
  constructor(root, { graph }) {
    this.root = root;
    this.graph = graph;
    this.model = null;
    this.loupe = new Loupe();
    this._build();
  }

  bind(plugin) {
    if (this.model && this._on) this.model.removeEventListener('change', this._on);
    this.plugin = plugin;
    this.model = plugin ? plugin.model : null;
    if (this.model) {
      this._on = (e) => { if (e.detail.kind === 'params' || e.detail.kind === 'select') this.render(); };
      this.model.addEventListener('change', this._on);
    }
    this.render();
  }

  _build() {
    const ticks = [12, 8, 4, 2, 0, -2, -4, -8, -12];
    this.root.innerHTML = `
      <div class="vmeter lite-meter" title="Вход"><i data-meter="in"></i><b>ВХ</b></div>
      <div class="faders" role="group" aria-label="Полосы эквалайзера">
        ${LITE_FREQS.map((f, i) => `
          <div class="fader" data-i="${i}" role="slider" tabindex="0" aria-label="${fmtF(f)}"
               aria-valuemin="-12" aria-valuemax="12" aria-valuenow="0">
            <div class="fader-val mono">0.0</div>
            <div class="fader-track">
              <div class="fader-scale">${ticks.map((t) => `<i style="bottom:${((gainToPos(t) + 1) / 2) * 100}%"${t === 0 ? ' class="z"' : ''}></i>`).join('')}</div>
              <div class="fader-fill"></div>
              <div class="fader-cap"><span></span></div>
            </div>
            <div class="fader-label mono">${LITE_LABELS[i]}</div>
          </div>`).join('')}
      </div>
      <div class="vmeter lite-meter" title="Выход"><i data-meter="out"></i><b>ВЫХ</b></div>`;
    this.faders = [...this.root.querySelectorAll('.fader')];
    this.meterIn = this.root.querySelector('[data-meter="in"]');
    this.meterOut = this.root.querySelector('[data-meter="out"]');

    const drag = { };
    const bind = (el, targetAt, pxPerUnit) => new IndependentPointers(el, {
      targetAt,
      start: (i, e) => {
        if (!this.model) return;
        this.model.begin();
        this.model.select(i);
        drag[e.pointerId] = { p0: gainToPos(this.model.params.gains[i]), g0: this.model.params.gains[i], wasZero: Math.abs(this.model.params.gains[i]) < 1e-6 };
        this._setActive(i, true);
        haptics.tick();
      },
      move: (i, dy, rec) => {
        const d = drag[rec.id];
        if (!d || !this.model) return;
        const fine = rec.shift ? 0.25 : 1;
        let g;
        if (pxPerUnit === 'graph') {
          g = d.g0 - (dy * fine) / this.graph.pxPerDb; // на графике — линейно в дБ / linear dB on the graph
        } else {
          const track = this.faders[i].querySelector('.fader-track').getBoundingClientRect().height || 200;
          g = posToGain(d.p0 - ((dy * fine) / track) * 2);  // на фейдере — шкала с точной зоной ±4 дБ
        }
        g = applyDetent(Math.round(g * 10) / 10);
        const zero = g === 0;
        if (zero && !d.wasZero) haptics.select(); // «щелчок» детента / detent click
        d.wasZero = zero;
        this.model.setGain(i, g);
        // Лупа над пальцем — только для touch/pen (мышь не закрывает значение) / loupe for touch only
        if (rec.type !== 'mouse') {
          const r = (pxPerUnit === 'graph' ? this.graph.wrap : this.faders[i]).getBoundingClientRect();
          const x = pxPerUnit === 'graph' ? r.left + this.graph.freqToX(LITE_FREQS[i]) : r.left + r.width / 2;
          this.loupe.show(x, rec.y, i, g, this.graph.fs);
        }
      },
      end: (i, e) => {
        delete drag[e.pointerId];
        this.model?.commit();
        this._setActive(i, false);
        this.loupe.hide();
      },
      doubleTap: (i) => this._reset(i),
      longPress: (i) => this._reset(i)
    });

    bind(this.root.querySelector('.faders'), (e) => {
      const f = e.target.closest('.fader');
      return f ? Number(f.dataset.i) : -1;
    }, 'fader');
    bind(this.graph.svg, (e) => {
      const r = this.graph.svg.getBoundingClientRect();
      return this.graph.bandAtX(e.clientX - r.left);
    }, 'graph');

    // Клавиатура / keyboard
    this.root.addEventListener('keydown', (e) => {
      const f = e.target.closest('.fader');
      if (!f || !this.model) return;
      const i = Number(f.dataset.i);
      const step = e.shiftKey ? 0.1 : 0.5;
      let d = 0;
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') d = step;
      if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') d = -step;
      if (e.key === '0' || e.key === 'Home') { e.preventDefault(); this._reset(i); return; }
      if (!d) return;
      e.preventDefault();
      this.model.setGain(i, applyDetent(this.model.params.gains[i] + d));
    });
    this.root.addEventListener('focusin', (e) => { const f = e.target.closest('.fader'); if (f && this.model) this.model.select(Number(f.dataset.i)); });
  }

  _setActive(i, on) {
    this.faders[i].classList.toggle('is-active', on);
    if (on) this.graph.active.add(i); else this.graph.active.delete(i);
  }

  /** Сброс полосы в 0 дБ / reset band to 0 dB. */
  _reset(i) {
    if (!this.model) return;
    this.model.setGain(i, 0);
    haptics.select();
    this.faders[i].classList.add('is-reset');
    setTimeout(() => this.faders[i].classList.remove('is-reset'), 250);
  }

  render() {
    if (!this.model) return;
    const p = this.model.params;
    this.faders.forEach((f, i) => {
      const g = p.gains[i];
      const pos = (gainToPos(g) + 1) / 2;       // 0…1 снизу вверх / bottom to top
      f.style.setProperty('--pos', pos.toFixed(4));
      const v = f.querySelector('.fader-val');
      const t = fmtLiteGain(g);
      if (v.textContent !== t) v.textContent = t;
      f.classList.toggle('is-boost', g > 0.05);
      f.classList.toggle('is-cut', g < -0.05);
      f.classList.toggle('is-selected', this.model.selected === i);
      f.setAttribute('aria-valuenow', g.toFixed(1));
      f.setAttribute('aria-valuetext', `${fmtF(LITE_FREQS[i])}: ${t} дБ, добротность ${proportionalQ(g).toFixed(2)} (${qToOctaves(proportionalQ(g)).toFixed(2)} окт)`);
    });
  }

  /** Индикаторы уровня (вызывать из цикла кадров) / level meters (call per frame). */
  meters(engine) {
    if (!this.plugin) return;
    const active = engine?.running && engine.hasSignal;
    const lvl = (an, el) => {
      if (!active) { el.style.transform = 'scaleY(0)'; return; }
      if (!this._buf || this._buf.length !== an.fftSize) this._buf = new Float32Array(an.fftSize);
      an.getFloatTimeDomainData(this._buf);
      let pk = 0;
      for (let k = 0; k < this._buf.length; k += 4) { const a = Math.abs(this._buf[k]); if (a > pk) pk = a; }
      el.style.transform = `scaleY(${clamp((20 * Math.log10(pk + 1e-9) + 60) / 60, 0, 1).toFixed(3)})`;
    };
    lvl(this.plugin.inAnalyser, this.meterIn);
    lvl(this.plugin.outAnalyser, this.meterOut);
  }
}

/* ================================================================== *
 *  Панель настроек / settings panel (bottom sheet)
 * ================================================================== */
export class LitePanel {
  constructor(root, sheet, { toast, onScale }) {
    this.root = root;
    this.sheet = sheet;
    this.toast = toast;
    this.onScale = onScale;
    this.model = null;
    this.head = root.querySelector('.band-head');
    this.body = root.querySelector('.band-body');
    this._build();
  }

  bind(plugin) {
    if (this.model && this._on) this.model.removeEventListener('change', this._on);
    this.plugin = plugin;
    this.model = plugin ? plugin.model : null;
    if (this.model) { this._on = () => this.render(); this.model.addEventListener('change', this._on); }
    this.render();
  }

  _build() {
    this.head.innerHTML = `
      <div class="sheet-grabber" data-sheet-handle aria-hidden="true"></div>
      <div class="band-head-row" data-sheet-handle>
        <div class="band-title"><div class="band-type">Настройки Movexe EQ Lite</div><div class="band-sum mono" data-sum></div></div>
        <button class="icon-btn" data-act="expand" aria-label="Развернуть"><svg viewBox="0 0 24 24"><path d="M6 15l6-6 6 6"/></svg></button>
      </div>`;
    const seg = (key, vals) => `<div class="seg" role="radiogroup" data-seg="${key}">${vals.map(([v, t]) => `<button type="button" role="radio" data-v="${v}">${t}</button>`).join('')}</div>`;
    this.body.innerHTML = `
      <div class="opt-row">
        <div class="opt"><span>Режим обработки</span>${seg('mode', LITE_MODES.map((m) => [m, LITE_MODE_LABELS[m]]))}</div>
        <div class="opt"><span>Передискретизация</span>${seg('upsampling', LITE_UPSAMPLING.map((u) => [u, u + 'x']))}</div>
      </div>
      <div class="act-row">
        <button type="button" class="tgl" data-toggle="analog" title="Выкл — чистый цифровой режим">Аналоговое насыщение</button>
        <button type="button" class="tgl" data-toggle="autoGain" title="Автоматически выравнивает громкость до/после">Автокомпенсация</button>
      </div>
      <div class="opt-row lite-out-row">
        <div class="lite-out"></div>
        <label class="opt"><span>Масштаб интерфейса</span>
          <select data-scale>${[80, 90, 100, 115, 130].map((s) => `<option value="${s}">${s} %</option>`).join('')}</select>
        </label>
      </div>
      <div class="act-row">
        <button type="button" class="chip-btn" data-act="copyab">Копировать в другой слот A/B</button>
        <button type="button" class="chip-btn is-danger" data-act="reset">Сбросить все полосы</button>
      </div>
      <p class="panel-note">Добротность каждой полосы задаётся автоматически (Proportional Q):
        Q = 0,7 + 0,0375·|G| + 0,009375·G² — от 0,7 (2 октавы) при малых значениях до 2,5 (0,57 октавы) при ±12 дБ.
        Передискретизация действует на аналоговое насыщение; браузер поддерживает до 4x, режим 8x работает как 4x.</p>`;
    this.out = new Knob({ id: 'outputGain', min: -18, max: 18, log: false, label: 'Выход', bipolar: true, fmt: (v) => fmtLiteGain(v) + ' дБ' }, {
      onBegin: () => this.model?.begin(),
      onChange: (v) => this.model?.set({ outputGain: Math.round(v * 10) / 10 }),
      onEnd: () => this.model?.commit(),
      getDefault: () => 0
    });
    this.out.setColor('#ffae00');
    this.body.querySelector('.lite-out').appendChild(this.out.root);
    this.root.addEventListener('click', (e) => {
      if (!this.model) return;
      const s = e.target.closest('[data-seg] [data-v]');
      if (s) {
        const key = s.closest('[data-seg]').dataset.seg;
        this.model.set({ [key]: key === 'upsampling' ? Number(s.dataset.v) : s.dataset.v });
        haptics.tick();
        return;
      }
      const t = e.target.closest('[data-toggle]');
      if (t) { this.model.set({ [t.dataset.toggle]: !this.model.params[t.dataset.toggle] }); haptics.tick(); return; }
      const a = e.target.closest('[data-act]');
      if (!a) return;
      if (a.dataset.act === 'expand') this.sheet.set(this.sheet.state === 'full' ? 'peek' : 'full');
      if (a.dataset.act === 'copyab') this.toast.show(`Настройки скопированы в слот ${this.model.copyAB()}`, { short: true });
      if (a.dataset.act === 'reset') {
        this.model.resetAll();
        this.toast.show('Все полосы сброшены', { action: { label: 'Отменить', fn: () => this.model.undo() } });
      }
    });
    this.body.querySelector('[data-scale]').addEventListener('change', (e) => this.onScale?.(Number(e.target.value)));
  }

  setScale(v) { this.body.querySelector('[data-scale]').value = String(v); }

  render() {
    if (!this.model) return;
    const p = this.model.params;
    for (const g of this.root.querySelectorAll('[data-seg]')) {
      for (const b of g.querySelectorAll('[data-v]')) {
        const on = String(p[g.dataset.seg]) === b.dataset.v;
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-checked', String(on));
      }
    }
    for (const t of this.root.querySelectorAll('[data-toggle]')) {
      t.classList.toggle('is-on', !!p[t.dataset.toggle]);
      t.setAttribute('aria-pressed', String(!!p[t.dataset.toggle]));
    }
    this.out.set(p.outputGain);
    this.out.labelEl.textContent = p.autoGain ? `Выход (авто ${fmtLiteGain(this.plugin.autoGain)})` : 'Выход';
    this.head.querySelector('[data-sum]').textContent = `${LITE_MODE_LABELS[p.mode]} · ${p.upsampling}x · ${p.analog ? 'аналог' : 'цифра'}${p.autoGain ? ' · авто' : ''}`;
    this.head.querySelector('[data-act="expand"]').classList.toggle('is-flipped', this.sheet.state === 'full');
  }
}
