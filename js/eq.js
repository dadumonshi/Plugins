/**
 * eq.js — модель эквалайзера (полосы, история, буфер обмена) и аудио-движок плагина.
 * eq.js — EQ model (bands, history, clipboard) and the plugin's audio engine.
 */
import {
  FILTER_TYPES, SLOPES, PLACEMENTS, LIMITS, GAINLESS,
  clamp, bandSections, sectionToDigital, designFir, estimateAutoGain, dbToLin
} from './dsp.js';

/* ================================================================== *
 *  МОДЕЛЬ / MODEL
 * ================================================================== */

/** Цвета полос в духе Pro-Q 3 / Pro-Q 3-like band colours. */
export const BAND_COLORS = [
  '#f7d046', '#f6a23c', '#f06a4a', '#ec4f86', '#c35ee6', '#8a6cf2',
  '#5c87f5', '#3fb0f2', '#34d1d8', '#35d69c', '#6fdc55', '#b6e04a',
  '#f3e46a', '#f7bb6a', '#f38a76', '#f17aa7', '#d38cef', '#a996f5',
  '#8aa7f7', '#74c6f5', '#6fdde2', '#6fe0b8', '#98e584', '#cbe87c'
];

export const DEFAULT_Q = {
  bell: 1, lowshelf: Math.SQRT1_2, highshelf: Math.SQRT1_2, lowcut: Math.SQRT1_2,
  highcut: Math.SQRT1_2, notch: 3, bandpass: 1, tiltshelf: Math.SQRT1_2, flattilt: 1
};

const DEFAULT_SLOPE = {
  bell: 12, lowshelf: 12, highshelf: 12, lowcut: 24, highcut: 24,
  notch: 12, bandpass: 12, tiltshelf: 12, flattilt: 12
};

let uidCounter = 1;
const uid = () => `b${Date.now().toString(36)}${(uidCounter++).toString(36)}`;

/** Нормализация и валидация полосы / Normalise & validate a band. */
export function sanitizeBand(src = {}) {
  const type = FILTER_TYPES.includes(src.type) ? src.type : 'bell';
  const slope = SLOPES.includes(Number(src.slope)) ? Number(src.slope) : DEFAULT_SLOPE[type];
  return {
    id: typeof src.id === 'string' ? src.id : uid(),
    type,
    freq: clamp(Number(src.freq) || 1000, LIMITS.freqMin, LIMITS.freqMax),
    gain: GAINLESS.has(type) ? 0 : clamp(Number(src.gain) || 0, LIMITS.gainMin, LIMITS.gainMax),
    q: clamp(Number(src.q) || DEFAULT_Q[type], LIMITS.qMin, LIMITS.qMax),
    slope,
    placement: PLACEMENTS.includes(src.placement) ? src.placement : 'stereo',
    enabled: src.enabled !== false,
    color: Number.isInteger(src.color) ? src.color % BAND_COLORS.length : 0
  };
}

/** Автотип по частоте, как в Pro-Q (края → срезы/полки) / Auto type by position. */
export function autoTypeFor(freq) {
  if (freq < 30) return 'lowcut';
  if (freq < 120) return 'lowshelf';
  if (freq > 15000) return 'highcut';
  if (freq > 8000) return 'highshelf';
  return 'bell';
}

// Буфер обмена полос (общий для всех экземпляров) / band clipboard shared by all instances.
let bandClipboard = null;

export class EQModel extends EventTarget {
  constructor({ maxBands = 24 } = {}) {
    super();
    this.bands = [];
    this.selectedId = null;
    this.maxBands = maxBands;
    this.settings = {
      mode: 'zero',        // 'zero' | 'natural' | 'linear'
      autoGain: false,
      outputGain: 0,       // dB
      bypass: false,
      grab: true,          // Spectrum Grab
      linearQuality: 'medium'
    };
    this._undo = [];
    this._redo = [];
    this._gesture = null;
  }

  /* ---------- события / events ---------- */
  emit(kind, detail = {}) {
    this.dispatchEvent(new CustomEvent('change', { detail: { kind, ...detail } }));
  }

  /* ---------- история / history ---------- */
  snapshot() {
    return JSON.stringify({
      bands: this.bands,
      s: { mode: this.settings.mode, autoGain: this.settings.autoGain, outputGain: this.settings.outputGain }
    });
  }

  _restore(snap) {
    const o = JSON.parse(snap);
    this.bands = o.bands.map(sanitizeBand);
    Object.assign(this.settings, o.s);
    if (!this.bands.find((b) => b.id === this.selectedId)) this.selectedId = null;
    this.emit('bands', { structural: true });
    this.emit('settings');
  }

  /** Запомнить состояние ДО изменения / record state BEFORE a change. */
  _record() {
    if (this._gesture) return; // внутри жеста снимок уже есть / gesture already holds a snapshot
    this._undo.push(this.snapshot());
    if (this._undo.length > 200) this._undo.shift();
    this._redo.length = 0;
    this.emit('history');
  }

  /** Начало непрерывного жеста (drag/knob) / begin continuous gesture. */
  begin() { if (!this._gesture) this._gesture = this.snapshot(); }

  /** Конец жеста — одна запись в историю / end gesture — one history entry. */
  commit() {
    const snap = this._gesture;
    this._gesture = null;
    if (snap && snap !== this.snapshot()) {
      this._undo.push(snap);
      this._redo.length = 0;
      this.emit('history');
    }
  }

  /** Откатить текущий жест (например, свайп вместо перетаскивания). Revert running gesture. */
  cancelGesture() {
    const snap = this._gesture;
    this._gesture = null;
    if (snap) this._restore(snap);
  }

  get canUndo() { return this._undo.length > 0; }
  get canRedo() { return this._redo.length > 0; }

  undo() {
    if (!this._undo.length) return false;
    this._redo.push(this.snapshot());
    this._restore(this._undo.pop());
    this.emit('history');
    return true;
  }

  redo() {
    if (!this._redo.length) return false;
    this._undo.push(this.snapshot());
    this._restore(this._redo.pop());
    this.emit('history');
    return true;
  }

  /* ---------- полосы / bands ---------- */
  getBand(id) { return this.bands.find((b) => b.id === id) || null; }
  get selected() { return this.getBand(this.selectedId); }

  _freeColor() {
    const used = new Set(this.bands.map((b) => b.color));
    for (let i = 0; i < BAND_COLORS.length; i++) if (!used.has(i)) return i;
    return this.bands.length % BAND_COLORS.length;
  }

  addBand(props = {}) {
    if (this.bands.length >= this.maxBands) {
      this.emit('limit', { max: this.maxBands });
      return null;
    }
    this._record();
    const type = props.type || autoTypeFor(props.freq || 1000);
    const band = sanitizeBand({ ...props, type, id: uid(), color: this._freeColor() });
    this.bands.push(band);
    this.selectedId = band.id;
    this.emit('bands', { structural: true, id: band.id });
    this.emit('select', { id: band.id });
    return band;
  }

  removeBand(id) {
    const i = this.bands.findIndex((b) => b.id === id);
    if (i < 0) return;
    this._record();
    this.bands.splice(i, 1);
    if (this.selectedId === id) this.selectedId = null;
    this.emit('bands', { structural: true, id });
    this.emit('select', { id: this.selectedId });
  }

  /**
   * Изменить параметры полосы. Внутри begin()/commit() — без лишних записей истории.
   * Update band params. Inside begin()/commit() no extra history entries.
   */
  updateBand(id, patch) {
    const b = this.getBand(id);
    if (!b) return;
    this._record();
    const next = sanitizeBand({ ...b, ...patch, id: b.id, color: b.color });
    // Смена типа → дефолтные Q/slope, если не заданы / type change → default Q/slope unless given
    if (patch.type && patch.type !== b.type) {
      if (patch.q === undefined) next.q = DEFAULT_Q[next.type];
      if (patch.slope === undefined) next.slope = DEFAULT_SLOPE[next.type];
      if (GAINLESS.has(b.type) && !GAINLESS.has(next.type)) next.gain = 0;
    }
    const structural = next.type !== b.type || next.slope !== b.slope ||
      next.placement !== b.placement || next.enabled !== b.enabled;
    Object.assign(b, next);
    this.emit('bands', { structural, id });
  }

  /** Сброс полосы к дефолту (double tap) / reset band to defaults. */
  resetBand(id) {
    const b = this.getBand(id);
    if (!b) return;
    this.updateBand(id, { gain: 0, q: DEFAULT_Q[b.type], slope: DEFAULT_SLOPE[b.type], enabled: true });
  }

  resetAll() {
    if (!this.bands.length) return;
    this._record();
    this.bands = [];
    this.selectedId = null;
    this.emit('bands', { structural: true });
    this.emit('select', { id: null });
  }

  select(id) {
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.emit('select', { id });
  }

  /** Перебор типов фильтра (свайп) / cycle filter type (swipe). */
  cycleType(id, dir = 1) {
    const b = this.getBand(id);
    if (!b) return;
    const i = FILTER_TYPES.indexOf(b.type);
    const type = FILTER_TYPES[(i + dir + FILTER_TYPES.length) % FILTER_TYPES.length];
    this.updateBand(id, { type });
  }

  copyBand(id) {
    const b = this.getBand(id);
    if (!b) return false;
    bandClipboard = { ...b };
    // Системный буфер — best effort (может быть запрещён) / system clipboard, best effort.
    try { navigator.clipboard?.writeText(JSON.stringify({ proeqBand: bandClipboard })).catch(() => {}); } catch { /* noop */ }
    return true;
  }

  pasteBand() {
    if (!bandClipboard) return null;
    const sel = this.selected;
    if (sel) { // вставка параметров в выбранную / paste params into the selected band
      const { id, color, ...params } = bandClipboard;
      this.updateBand(sel.id, params);
      return sel;
    }
    const { id, color, ...params } = bandClipboard;
    return this.addBand({ ...params, freq: params.freq * 1.12 });
  }

  static get hasClipboard() { return !!bandClipboard; }

  /* ---------- настройки / settings ---------- */
  setSetting(key, value, { history = false } = {}) {
    if (this.settings[key] === value) return;
    if (history) this._record();
    this.settings[key] = value;
    this.emit('settings', { key });
  }

  setMaxBands(n) {
    this.maxBands = n;
    this.emit('settings', { key: 'maxBands' });
  }

  /* ---------- сериализация / serialisation ---------- */
  toJSON() {
    return {
      mode: this.settings.mode,
      autoGain: this.settings.autoGain,
      outputGain: this.settings.outputGain,
      bands: this.bands.map(({ id, color, ...rest }) => rest)
    };
  }

  loadJSON(obj, { history = true } = {}) {
    if (!obj || !Array.isArray(obj.bands)) throw new Error('Invalid EQ preset');
    if (history) this._record();
    const max = Math.max(this.maxBands, Math.min(obj.bands.length, 24));
    if (max > this.maxBands) this.maxBands = max; // пресет может расширить лимит / preset may raise the limit
    this.bands = obj.bands.slice(0, 24).map((b, i) => sanitizeBand({ ...b, id: undefined, color: i }));
    if (['zero', 'natural', 'linear'].includes(obj.mode)) this.settings.mode = obj.mode;
    if (typeof obj.autoGain === 'boolean') this.settings.autoGain = obj.autoGain;
    if (Number.isFinite(obj.outputGain)) this.settings.outputGain = clamp(obj.outputGain, -36, 36);
    this.selectedId = null;
    this.emit('bands', { structural: true });
    this.emit('settings');
    this.emit('select', { id: null });
  }
}

/* ================================================================== *
 *  АУДИО / AUDIO
 * ================================================================== */

const RAMP = 0.012; // сек, сглаживание параметров / param smoothing time constant

/** IIR-секция с перекрёстным затуханием при смене коэффициентов. IIR section with crossfade on coef change. */
class IirSection {
  constructor(ctx) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.cur = null;
    this.key = '';
  }

  set({ b, a }) {
    const key = b.concat(a).map((v) => v.toPrecision(7)).join(',');
    if (key === this.key) return;
    this.key = key;
    const ctx = this.ctx;
    let node;
    try {
      node = ctx.createIIRFilter(b, a);
    } catch (e) {
      console.warn('[EQ] IIRFilterNode failed', e);
      return;
    }
    const g = ctx.createGain();
    const t = ctx.currentTime;
    this.input.connect(node).connect(g).connect(this.output);
    if (this.cur) {
      // Кроссфейд 20 мс, чтобы не было щелчков / 20 ms crossfade to avoid clicks
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(1, t + 0.02);
      const old = this.cur;
      old.g.gain.setValueAtTime(1, t);
      old.g.gain.linearRampToValueAtTime(0, t + 0.02);
      setTimeout(() => { try { old.node.disconnect(); old.g.disconnect(); this.input.disconnect(old.node); } catch { /* already gone */ } }, 80);
    }
    this.cur = { node, g };
  }

  dispose() {
    try { this.input.disconnect(); this.output.disconnect(); this.cur?.node.disconnect(); this.cur?.g.disconnect(); } catch { /* noop */ }
  }
}

/** Секция на нативном BiquadFilterNode / Native BiquadFilterNode section. */
class NativeSection {
  constructor(ctx, type) {
    this.ctx = ctx;
    this.node = ctx.createBiquadFilter();
    this.node.type = type;
    this.input = this.node;
    this.output = this.node;
    this.first = true;
  }

  set(native) {
    const t = this.ctx.currentTime;
    const nyq = this.ctx.sampleRate / 2;
    const f = Math.min(native.f, nyq * 0.999);
    const p = this.node;
    if (this.first) { // первое значение без сглаживания / first set without smoothing
      p.frequency.value = f; p.Q.value = native.Q; p.gain.value = native.gain;
      this.first = false;
      return;
    }
    p.frequency.setTargetAtTime(f, t, RAMP);
    p.Q.setTargetAtTime(native.Q, t, RAMP);
    p.gain.setTargetAtTime(native.gain, t, RAMP);
  }

  dispose() { try { this.node.disconnect(); } catch { /* noop */ } }
}

/** Обработчик одной полосы с маршрутизацией L/R/M/S. Single band processor with L/R/M/S routing. */
class BandProcessor {
  constructor(ctx) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.sig = '';
    this.sections = [];
    this.aux = [];
  }

  update(band) {
    const secs = bandSections(band);
    const sig = `${band.enabled}|${band.placement}|` + secs.map((s) => (s.native ? 'n' + s.native.type : 'i' + s.order)).join(',');
    if (sig !== this.sig) this._build(band, secs, sig);
    const fs = this.ctx.sampleRate;
    secs.forEach((s, i) => {
      const node = this.sections[i];
      if (!node) return;
      if (s.native) node.set(s.native);
      else node.set(sectionToDigital(s, fs));
    });
  }

  _build(band, secs, sig) {
    this._teardown();
    this.sig = sig;
    const ctx = this.ctx;
    if (!band.enabled || !secs.length) {
      this.input.connect(this.output);
      return;
    }
    this.sections = secs.map((s) => (s.native ? new NativeSection(ctx, s.native.type) : new IirSection(ctx)));
    for (let i = 0; i < this.sections.length - 1; i++) this.sections[i].output.connect(this.sections[i + 1].input);
    const chainIn = this.sections[0].input;
    const chainOut = this.sections[this.sections.length - 1].output;
    const pl = band.placement;

    if (pl === 'stereo') {
      this.input.connect(chainIn);
      chainOut.connect(this.output);
      return;
    }
    const split = ctx.createChannelSplitter(2);
    const merge = ctx.createChannelMerger(2);
    this.aux.push(split, merge);
    this.input.connect(split);
    merge.connect(this.output);

    if (pl === 'left' || pl === 'right') {
      const ch = pl === 'left' ? 0 : 1;
      split.connect(chainIn, ch);
      chainOut.connect(merge, 0, ch);
      split.connect(merge, 1 - ch, 1 - ch);
      return;
    }
    // Mid/Side: M=(L+R)/2, S=(L−R)/2 → обработка → L=M+S, R=M−S
    const mid = ctx.createGain(); mid.gain.value = 0.5;
    const side = ctx.createGain(); side.gain.value = 0.5;
    const inv = ctx.createGain(); inv.gain.value = -0.5;
    const neg = ctx.createGain(); neg.gain.value = -1;
    this.aux.push(mid, side, inv, neg);
    split.connect(mid, 0); split.connect(mid, 1);
    split.connect(side, 0); split.connect(inv, 1); inv.connect(side);
    let M = mid, S = side;
    if (pl === 'mid') { mid.connect(chainIn); M = chainOut; } else { side.connect(chainIn); S = chainOut; }
    M.connect(merge, 0, 0); S.connect(merge, 0, 0);
    M.connect(merge, 0, 1); S.connect(neg); neg.connect(merge, 0, 1);
  }

  _teardown() {
    try { this.input.disconnect(); } catch { /* noop */ }
    this.sections.forEach((s) => s.dispose());
    this.aux.forEach((n) => { try { n.disconnect(); } catch { /* noop */ } });
    this.sections = [];
    this.aux = [];
  }

  dispose() {
    this._teardown();
    try { this.output.disconnect(); } catch { /* noop */ }
  }
}

/** FIR-процессор (1 или 4 свёртки) / FIR processor (1 or 4 convolvers). */
class FirProcessor {
  constructor(ctx, res) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.nodes = [];
    const mk = (ir) => {
      const buf = ctx.createBuffer(1, ir.length, ctx.sampleRate);
      buf.copyToChannel(ir, 0);
      const c = ctx.createConvolver();
      c.normalize = false; // ВАЖНО: до присвоения buffer / MUST be set before .buffer
      c.buffer = buf;
      this.nodes.push(c);
      return c;
    };
    if (res.kind === 'mono') {
      this.input.connect(mk(res.irs[0])).connect(this.output);
    } else {
      const split = ctx.createChannelSplitter(2);
      const merge = ctx.createChannelMerger(2);
      this.nodes.push(split, merge);
      this.input.connect(split);
      const [LL, LR, RL, RR] = res.irs.map(mk);
      // Моно-вход в свёртку / mono feed into each convolver
      for (const c of [LL, LR, RL, RR]) { c.channelCount = 1; c.channelCountMode = 'explicit'; }
      split.connect(LL, 0); split.connect(LR, 1);
      split.connect(RL, 0); split.connect(RR, 1);
      LL.connect(merge, 0, 0); LR.connect(merge, 0, 0);
      RL.connect(merge, 0, 1); RR.connect(merge, 0, 1);
      merge.connect(this.output);
    }
  }

  dispose() {
    try { this.input.disconnect(); this.output.disconnect(); } catch { /* noop */ }
    this.nodes.forEach((n) => { try { n.disconnect(); } catch { /* noop */ } });
  }
}

/** Общий воркер FIR (ленивый) / Shared lazy FIR worker. */
let firWorker = null;
let firWorkerFailed = false;
function getFirWorker() {
  if (firWorker || firWorkerFailed) return firWorker;
  try {
    // Feature detection: module workers (Safari 15+, Chrome 80+, Firefox 114+)
    firWorker = new Worker(new URL('./fir-worker.js', import.meta.url), { type: 'module' });
    firWorker.onerror = () => { firWorkerFailed = true; firWorker = null; };
  } catch (e) {
    firWorkerFailed = true;
    firWorker = null;
  }
  return firWorker;
}

let firReqId = 0;

/**
 * Плагин эквалайзера (интерфейс FX-плагина: input, output, dispose, getState, setState).
 * EQ plugin (FX plugin interface: input, output, dispose, getState, setState).
 */
export class ProEQPlugin {
  constructor(ctx, { maxBands = 24, fftSize = 8192, lowPower = false } = {}) {
    this.ctx = ctx;
    this.lowPower = lowPower;
    this.model = new EQModel({ maxBands });
    this.latency = 0;

    // Вход: форсируем стерео (моно-микрофон → L=R) / force stereo (mono mic → L=R)
    this.input = ctx.createGain();
    this.input.channelCount = 2;
    this.input.channelCountMode = 'explicit';
    this.input.channelInterpretation = 'speakers';
    this.output = ctx.createGain();

    this.preAnalyser = ctx.createAnalyser();
    this.postAnalyser = ctx.createAnalyser();
    for (const a of [this.preAnalyser, this.postAnalyser]) {
      a.fftSize = fftSize;
      a.minDecibels = -120;
      a.maxDecibels = 0;
      a.smoothingTimeConstant = 0.75;
    }
    this.input.connect(this.preAnalyser);

    this.iirIn = ctx.createGain();
    this.iirOut = ctx.createGain();
    this.iirPath = ctx.createGain();
    this.firPath = ctx.createGain();
    this.firPath.gain.value = 0;
    this.wetSum = ctx.createGain();
    this.outGain = ctx.createGain();
    this.wet = ctx.createGain();
    this.dry = ctx.createGain();
    this.dry.gain.value = 0;

    this.input.connect(this.iirIn);
    this.iirIn.connect(this.iirOut); // пустая цепочка / empty chain
    this.iirOut.connect(this.iirPath).connect(this.wetSum);
    this.firPath.connect(this.wetSum);
    this.wetSum.connect(this.outGain).connect(this.wet).connect(this.output);
    this.input.connect(this.dry).connect(this.output);
    this.output.connect(this.postAnalyser);

    this.procs = new Map(); // bandId → BandProcessor
    this.fir = null;
    this._firTimer = 0;
    this._firPending = 0;
    this._firInputConnected = false;
    this._iirInputConnected = true;
    this.autoGainDb = 0;

    this._onChange = (e) => this._handle(e.detail);
    this.model.addEventListener('change', this._onChange);
  }

  _handle(d) {
    if (d.kind === 'bands') {
      if (d.structural) this._rewire();
      else if (d.id) this.procs.get(d.id)?.update(this.model.getBand(d.id));
      this._afterBands();
    } else if (d.kind === 'settings') {
      this._applySettings();
    }
  }

  _afterBands() {
    this._updateGain();
    if (this.model.settings.mode !== 'zero') this._scheduleFir();
  }

  /** Перестроить последовательную цепочку полос / rebuild the serial band chain. */
  _rewire() {
    const bands = this.model.bands;
    const ids = new Set(bands.map((b) => b.id));
    for (const [id, p] of this.procs) if (!ids.has(id)) { p.dispose(); this.procs.delete(id); }
    try { this.iirIn.disconnect(); } catch { /* noop */ }
    let prev = this.iirIn;
    for (const b of bands) {
      let p = this.procs.get(b.id);
      if (!p) { p = new BandProcessor(this.ctx); this.procs.set(b.id, p); }
      try { p.output.disconnect(); } catch { /* noop */ }
      p.update(b);
      prev.connect(p.input);
      prev = p.output;
    }
    prev.connect(this.iirOut);
  }

  _applySettings() {
    const s = this.model.settings;
    const t = this.ctx.currentTime;
    this.wet.gain.setTargetAtTime(s.bypass ? 0 : 1, t, 0.01);
    this.dry.gain.setTargetAtTime(s.bypass ? 1 : 0, t, 0.01);
    this._updateGain();
    this._setMode(s.mode);
  }

  _updateGain() {
    const s = this.model.settings;
    this.autoGainDb = s.autoGain ? estimateAutoGain(this.model.bands) : 0;
    this.outGain.gain.setTargetAtTime(dbToLin(s.outputGain + this.autoGainDb), this.ctx.currentTime, 0.02);
  }

  _setMode(mode) {
    if (mode === this._mode) return;
    this._mode = mode;
    const t = this.ctx.currentTime;
    if (mode === 'zero') {
      if (!this._iirInputConnected) { this.input.connect(this.iirIn); this._iirInputConnected = true; }
      this.iirPath.gain.setTargetAtTime(1, t, 0.01);
      this.firPath.gain.setTargetAtTime(0, t, 0.01);
      this.latency = 0;
      clearTimeout(this._firDiscTimer);
      this._firDiscTimer = setTimeout(() => {
        if (this._mode === 'zero' && this.fir) { this.fir.dispose(); this.fir = null; }
      }, 120);
      this.model.emit('latency', { samples: 0 });
    } else {
      this.fir?.dispose();
      this.fir = null;
      this._scheduleFir(0);
    }
  }

  _firSize() {
    const fs = this.ctx.sampleRate;
    if (this.model.settings.mode === 'natural') return fs > 50000 ? 4096 : 2048;
    const q = this.model.settings.linearQuality;
    let n = q === 'low' ? 2048 : q === 'high' ? 16384 : 8192;
    if (this.lowPower) n = Math.min(n, 4096);
    if (fs > 50000) n *= 2;
    return n;
  }

  _scheduleFir(delay = 60) {
    clearTimeout(this._firTimer);
    this._firTimer = setTimeout(() => this._computeFir(), delay);
  }

  async _computeFir() {
    const mode = this.model.settings.mode;
    if (mode === 'zero') return;
    const id = ++firReqId;
    this._firPending = id;
    const payload = { id, bands: this.model.bands, fs: this.ctx.sampleRate, size: this._firSize(), mode };
    let res;
    const w = getFirWorker();
    if (w) {
      res = await new Promise((resolve) => {
        const on = (e) => { if (e.data.id === id) { w.removeEventListener('message', on); resolve(e.data); } };
        w.addEventListener('message', on);
        w.postMessage(payload);
      });
    } else {
      // Фолбэк без воркера / fallback without worker
      await new Promise((r) => setTimeout(r, 0));
      res = designFir(payload.bands, payload);
    }
    if (res.error) { console.error('[EQ] FIR design failed:', res.error); return; }
    if (id !== this._firPending || this.model.settings.mode !== mode) return; // устарело / stale
    this._installFir(res);
  }

  _installFir(res) {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const next = new FirProcessor(ctx, res);
    next.output.gain.value = 0;
    this.input.connect(next.input);
    next.output.connect(this.firPath);
    next.output.gain.setValueAtTime(0, t);
    next.output.gain.linearRampToValueAtTime(1, t + 0.03);
    const old = this.fir;
    if (old) {
      old.output.gain.setValueAtTime(1, t);
      old.output.gain.linearRampToValueAtTime(0, t + 0.03);
      setTimeout(() => old.dispose(), 150);
    }
    this.fir = next;
    this.firPath.gain.setTargetAtTime(1, t, 0.01);
    this.iirPath.gain.setTargetAtTime(0, t, 0.01);
    // Отключаем IIR-вход ради экономии CPU на мобильных / detach IIR input to save mobile CPU
    setTimeout(() => {
      if (this._mode !== 'zero' && this._iirInputConnected) {
        try { this.input.disconnect(this.iirIn); } catch { /* noop */ }
        this._iirInputConnected = false;
      }
    }, 120);
    this.latency = res.latency;
    this.model.emit('latency', { samples: res.latency });
  }

  setFftSize(n) {
    this.preAnalyser.fftSize = n;
    this.postAnalyser.fftSize = n;
  }

  getState() { return this.model.toJSON(); }
  setState(state) { this.model.loadJSON(state, { history: false }); }

  /** Начальная раскладка / initial layout. */
  init(state) {
    if (state) this.setState(state);
    this._rewire();
    this._applySettings();
  }

  dispose() {
    this.model.removeEventListener('change', this._onChange);
    clearTimeout(this._firTimer);
    this.procs.forEach((p) => p.dispose());
    this.fir?.dispose();
    for (const n of [this.input, this.output, this.iirIn, this.iirOut, this.iirPath, this.firPath,
      this.wetSum, this.outGain, this.wet, this.dry, this.preAnalyser, this.postAnalyser]) {
      try { n.disconnect(); } catch { /* noop */ }
    }
  }
}

ProEQPlugin.descriptor = {
  id: 'proeq',
  name: 'Pro EQ 3',
  category: 'EQ',
  description: 'Параметрический эквалайзер в стиле Pro-Q 3 / Pro-Q 3-style parametric EQ',
  editor: 'eq'
};
