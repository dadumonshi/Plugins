/**
 * api560.js — Movexe EQ Lite: 10-полосный графический эквалайзер в духе API 560.
 * Модель (история, A/B) и аудио-плагин для FX-цепочки.
 * api560.js — Movexe EQ Lite: API 560-style 10-band graphic EQ.
 * Model (history, A/B) and FX-chain audio plugin.
 *
 * Граф / Graph:
 *   in ─► матрица режима (Stereo/Mono/Mid/Side) ─► 2 × [10 × BiquadFilterNode 'peaking']
 *      ─► обратная матрица ─► аналоговое насыщение (WaveShaper, 2x/4x oversampling)
 *      ─► выход + автокомпенсация ─► wet ─┐
 *   in ─────────────────────────────────► dry ─┴► out   (IN/OUT = плавный кроссфейд)
 */
import { LITE_FREQS, GAIN_MAX, proportionalQ, autoGainDb } from './proportionalq.js';

export const LITE_MODES = ['stereo', 'mono', 'mid', 'side'];
export const LITE_MODE_LABELS = { stereo: 'Стерео', mono: 'Моно', mid: 'Mid', side: 'Side' };
export const LITE_UPSAMPLING = [1, 2, 4, 8];

export const LITE_DEFAULTS = Object.freeze({
  gains: Object.freeze(new Array(10).fill(0)),
  mode: 'stereo',
  bypass: false,
  upsampling: 4,
  analog: true,       // аналоговое насыщение; false = «чистый цифровой» режим / pure digital
  autoGain: false,
  outputGain: 0
});

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** Нормализация состояния / normalise state. */
export function sanitizeLite(src = {}) {
  const out = { ...LITE_DEFAULTS, gains: [...LITE_DEFAULTS.gains] };
  // Принимаем и массив gains, и формат пресета bands:[{freq,gain}] / accept both formats
  if (Array.isArray(src.gains)) {
    src.gains.slice(0, 10).forEach((g, i) => { const v = Number(g); if (Number.isFinite(v)) out.gains[i] = clamp(v, -GAIN_MAX, GAIN_MAX); });
  } else if (Array.isArray(src.bands)) {
    for (const b of src.bands) {
      const i = LITE_FREQS.indexOf(Number(b && b.freq));
      const v = Number(b && b.gain);
      if (i >= 0 && Number.isFinite(v)) out.gains[i] = clamp(v, -GAIN_MAX, GAIN_MAX);
    }
  }
  if (LITE_MODES.includes(src.mode)) out.mode = src.mode;
  if (LITE_UPSAMPLING.includes(Number(src.upsampling))) out.upsampling = Number(src.upsampling);
  for (const k of ['bypass', 'analog', 'autoGain']) if (typeof src[k] === 'boolean') out[k] = src[k];
  if (Number.isFinite(Number(src.outputGain))) out.outputGain = clamp(Number(src.outputGain), -18, 18);
  return out;
}

/** Состояние → формат пресета из ТЗ / state → preset format. */
export function liteToPreset(p) {
  return {
    bands: LITE_FREQS.map((freq, i) => ({ freq, gain: Math.round(p.gains[i] * 10) / 10 })),
    mode: p.mode, bypass: p.bypass, upsampling: p.upsampling,
    analog: p.analog, autoGain: p.autoGain, outputGain: p.outputGain
  };
}

/* ================================================================== *
 *  МОДЕЛЬ / MODEL
 * ================================================================== */

export class LiteModel extends EventTarget {
  constructor() {
    super();
    this.params = sanitizeLite();
    this.selected = -1;          // подсвеченная полоса / highlighted band
    this.ab = { active: 'A', A: null, B: null };
    this._undo = []; this._redo = []; this._gesture = null;
  }

  emit(kind, detail = {}) { this.dispatchEvent(new CustomEvent('change', { detail: { kind, ...detail } })); }

  snapshot() { const { bypass, ...rest } = this.params; return JSON.stringify(rest); }
  _restore(s) { const bypass = this.params.bypass; this.params = sanitizeLite({ ...JSON.parse(s), bypass }); this.emit('params', { all: true }); }
  _record() {
    if (this._gesture) return;
    this._undo.push(this.snapshot());
    if (this._undo.length > 200) this._undo.shift();
    this._redo.length = 0;
    this.emit('history');
  }
  begin() { if (!this._gesture) this._gesture = this.snapshot(); }
  commit() {
    const s = this._gesture; this._gesture = null;
    if (s && s !== this.snapshot()) { this._undo.push(s); this._redo.length = 0; this.emit('history'); }
  }
  get canUndo() { return this._undo.length > 0; }
  get canRedo() { return this._redo.length > 0; }
  undo() { if (!this._undo.length) return false; this._redo.push(this.snapshot()); this._restore(this._undo.pop()); this.emit('history'); return true; }
  redo() { if (!this._redo.length) return false; this._undo.push(this.snapshot()); this._restore(this._redo.pop()); this.emit('history'); return true; }

  /** Усиление полосы (внутри begin/commit — без лишних записей истории). Band gain. */
  setGain(i, g) {
    const v = clamp(g, -GAIN_MAX, GAIN_MAX);
    if (Math.abs(this.params.gains[i] - v) < 1e-6) return;
    this._record();
    this.params.gains[i] = v;
    this.emit('params', { band: i });
  }

  set(patch, { history = true } = {}) {
    const next = sanitizeLite({ ...this.params, ...patch, gains: patch.gains || this.params.gains });
    const keys = Object.keys(patch).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(this.params[k]));
    if (!keys.length) return;
    if (history) this._record();
    this.params = next;
    this.emit('params', { keys });
  }

  resetAll() { this.set({ gains: new Array(10).fill(0) }); }

  select(i) { if (this.selected !== i) { this.selected = i; this.emit('select', { band: i }); } }

  /* ---------- A/B сравнение / A/B comparison ---------- */
  switchAB() {
    const cur = this.ab.active, next = cur === 'A' ? 'B' : 'A';
    this.ab[cur] = this.snapshot();
    this.ab.active = next;
    if (this.ab[next]) { this._restore(this.ab[next]); }
    this.emit('ab', { active: next });
  }
  copyAB() {
    const other = this.ab.active === 'A' ? 'B' : 'A';
    this.ab[other] = this.snapshot();
    this.emit('ab', { copied: other });
    return other;
  }

  toJSON() { return { ...liteToPreset(this.params), ab: this.ab.active }; }
  loadJSON(obj, { history = true } = {}) {
    if (!obj || typeof obj !== 'object') throw new Error('Некорректный пресет Movexe EQ Lite');
    if (history) this._record();
    const bypass = this.params.bypass;
    this.params = sanitizeLite({ ...obj, bypass: history ? bypass : obj.bypass });
    this.emit('params', { all: true });
  }
}

/* ================================================================== *
 *  АУДИО / AUDIO
 * ================================================================== */

const T = 0.015; // постоянная сглаживания параметров, с / param smoothing time constant

/**
 * Кривая «аналогового» насыщения: симметричный мягкий tanh (нечётные гармоники, без
 * постоянной составляющей). На обычных уровнях почти прозрачна, на пиках мягко скругляет.
 * Soft symmetric tanh (odd harmonics, no DC offset): near-transparent at normal levels.
 */
function makeSatCurve() {
  const n = 4096, HEAD = 4; // вход WaveShaper нормирован на ±4 (≈ +12 дБFS запаса)
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s = ((i / (n - 1)) * 2 - 1) * HEAD;
    c[i] = Math.tanh(1.05 * s) / 1.05 / HEAD;
  }
  return c;
}

export class LitePlugin {
  constructor(ctx, { fftSize = 8192 } = {}) {
    this.ctx = ctx;
    this.model = new LiteModel();
    this.latency = 0;
    this.autoGain = 0;
    const g = (v = 1) => { const n = ctx.createGain(); n.gain.value = v; return n; };
    const mono = (n) => { n.channelCount = 1; n.channelCountMode = 'explicit'; n.channelInterpretation = 'discrete'; return n; };

    this.input = g();
    this.input.channelCount = 2;
    this.input.channelCountMode = 'explicit';
    this.input.channelInterpretation = 'speakers'; // моно-микрофон → L=R / mono mic → L=R
    this.output = g();

    this.inAnalyser = ctx.createAnalyser();
    this.outAnalyser = ctx.createAnalyser();
    for (const a of [this.inAnalyser, this.outAnalyser]) { a.fftSize = fftSize; a.minDecibels = -120; a.maxDecibels = 0; a.smoothingTimeConstant = 0.75; }
    this.input.connect(this.inAnalyser);
    this.output.connect(this.outAnalyser);

    // ── матрица режима / mode matrix ──
    const split = ctx.createChannelSplitter(2);
    const merge = ctx.createChannelMerger(2);
    this.input.connect(split);
    this.m = {
      LA: g(1), RA: g(0), RB: g(1),     // входы цепочек A и B / chain inputs
      oAL: g(1), oAR: g(0), oBR: g(1),  // выходы цепочек / chain outputs
      mL: g(0), mR: g(0), sL: g(0), sR: g(0) // «сырые» M/S пути / raw M/S paths
    };
    const sumA = mono(g()), inB = mono(g());
    const rawM = mono(g()), rawS = mono(g());
    split.connect(this.m.LA, 0); split.connect(this.m.RA, 1);
    this.m.LA.connect(sumA); this.m.RA.connect(sumA);
    split.connect(this.m.RB, 1); this.m.RB.connect(inB);
    const hM = g(0.5), hM2 = g(0.5), hS = g(0.5), hS2 = g(-0.5);
    split.connect(hM, 0); split.connect(hM2, 1); hM.connect(rawM); hM2.connect(rawM);
    split.connect(hS, 0); split.connect(hS2, 1); hS.connect(rawS); hS2.connect(rawS);

    // ── две цепочки по 10 peaking-фильтров / two chains of 10 peaking filters ──
    const chain = (src) => {
      const fl = LITE_FREQS.map((f) => {
        const b = ctx.createBiquadFilter();
        b.type = 'peaking';
        b.frequency.value = Math.min(f, ctx.sampleRate * 0.45);
        b.gain.value = 0;
        b.Q.value = proportionalQ(0);
        return b;
      });
      let prev = src;
      for (const b of fl) { prev.connect(b); prev = b; }
      return { filters: fl, out: prev };
    };
    this.A = chain(sumA);
    this.B = chain(inB);
    this.A.out.connect(this.m.oAL).connect(merge, 0, 0);
    this.A.out.connect(this.m.oAR).connect(merge, 0, 1);
    this.B.out.connect(this.m.oBR).connect(merge, 0, 1);
    rawM.connect(this.m.mL).connect(merge, 0, 0);
    rawM.connect(this.m.mR).connect(merge, 0, 1);
    rawS.connect(this.m.sL).connect(merge, 0, 0);
    rawS.connect(this.m.sR).connect(merge, 0, 1);

    // ── насыщение (вкл/выкл кроссфейдом) / saturation (crossfaded on/off) ──
    this.shaper = ctx.createWaveShaper();
    this.shaper.curve = makeSatCurve();
    this.satPre = g(0.25);   // ÷4 → вход кривой / into the curve domain
    this.satPost = g(4);     // ×4 обратно / back
    this.satWet = g(1);
    this.satDry = g(0);
    const post = g();
    merge.connect(this.satPre).connect(this.shaper).connect(this.satPost).connect(this.satWet).connect(post);
    merge.connect(this.satDry).connect(post);

    this.outGain = g();
    this.wet = g(1);
    this.dry = g(0);
    post.connect(this.outGain).connect(this.wet).connect(this.output);
    this.input.connect(this.dry).connect(this.output);

    this._onChange = (e) => { if (e.detail.kind === 'params') this._apply(e.detail); };
    this.model.addEventListener('change', this._onChange);
  }

  _apply(d = {}) {
    const p = this.model.params;
    const t = this.ctx.currentTime;
    // Полосы: gain и Q плавно (Proportional Q без скачков) / smooth gain & Q
    const bands = d.band !== undefined ? [d.band] : LITE_FREQS.map((_, i) => i);
    for (const i of bands) {
      const q = proportionalQ(p.gains[i]);
      for (const ch of [this.A, this.B]) {
        ch.filters[i].gain.setTargetAtTime(p.gains[i], t, T);
        ch.filters[i].Q.setTargetAtTime(q, t, T);
      }
    }
    // Матрица режима / mode matrix
    const M = {
      stereo: { LA: 1, RA: 0, RB: 1, oAL: 1, oAR: 0, oBR: 1, mL: 0, mR: 0, sL: 0, sR: 0 },
      mono: { LA: 0.5, RA: 0.5, RB: 0, oAL: 1, oAR: 1, oBR: 0, mL: 0, mR: 0, sL: 0, sR: 0 },
      mid: { LA: 0.5, RA: 0.5, RB: 0, oAL: 1, oAR: 1, oBR: 0, mL: 0, mR: 0, sL: 1, sR: -1 },
      side: { LA: 0.5, RA: -0.5, RB: 0, oAL: 1, oAR: -1, oBR: 0, mL: 1, mR: 1, sL: 0, sR: 0 }
    }[p.mode];
    for (const [k, v] of Object.entries(M)) this.m[k].gain.setTargetAtTime(v, t, T);
    // Насыщение и передискретизация (WaveShaper умеет только 2x/4x) / oversampling
    this.shaper.oversample = p.upsampling >= 4 ? '4x' : p.upsampling === 2 ? '2x' : 'none';
    this.satWet.gain.setTargetAtTime(p.analog ? 1 : 0, t, T);
    this.satDry.gain.setTargetAtTime(p.analog ? 0 : 1, t, T);
    // Выход и Gain Match / output & gain match
    this.autoGain = p.autoGain ? autoGainDb(p.gains, this.ctx.sampleRate) : 0;
    this.outGain.gain.setTargetAtTime(Math.pow(10, (p.outputGain + this.autoGain) / 20), t, 0.03);
    this.wet.gain.setTargetAtTime(p.bypass ? 0 : 1, t, 0.01);
    this.dry.gain.setTargetAtTime(p.bypass ? 1 : 0, t, 0.01);
  }

  setFftSize(n) { this.inAnalyser.fftSize = n; this.outAnalyser.fftSize = n; }
  init(state) { if (state) this.model.loadJSON(state, { history: false }); this._apply(); }
  getState() { return this.model.toJSON(); }
  setState(s) { this.model.loadJSON(s, { history: false }); }

  dispose() {
    this.model.removeEventListener('change', this._onChange);
    try { this.input.disconnect(); this.output.disconnect(); } catch { /* noop */ }
  }
}

LitePlugin.descriptor = {
  id: 'lite',
  name: 'Movexe EQ Lite',
  category: 'Эквалайзер',
  description: 'Графический 10-полосный эквалайзер с пропорциональной добротностью (в духе API 560)',
  editor: 'lite'
};
