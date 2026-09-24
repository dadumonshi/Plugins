/**
 * deesser.js — Movexe DeEss: модель параметров (история, события) и аудио-плагин.
 * deesser.js — Movexe DeEss: parameter model (history, events) and audio plugin.
 *
 * Плагин реализует интерфейс FX-цепочки (см. fx-chain.js):
 *   input, output, init(state), getState(), setState(), dispose(), model, latency, ready
 */
import { DS_DEFAULTS, sanitizeDeEss } from './detection.js';

/* ================================================================== *
 *  МОДЕЛЬ / MODEL
 * ================================================================== */

export class DeEssModel extends EventTarget {
  constructor() {
    super();
    this.params = { ...DS_DEFAULTS };
    this.selected = 'frequency';  // выбранный параметр (подсветка, сброс long press)
    this._undo = [];
    this._redo = [];
    this._gesture = null;
  }

  emit(kind, detail = {}) {
    this.dispatchEvent(new CustomEvent('change', { detail: { kind, ...detail } }));
  }

  snapshot() {
    // audition/bypass — состояние прослушивания, в историю не пишем / not undoable
    const { audition, bypass, ...rest } = this.params;
    return JSON.stringify(rest);
  }

  _restore(s) {
    const { audition, bypass } = this.params;
    this.params = sanitizeDeEss({ ...JSON.parse(s), audition, bypass });
    this.emit('params', { all: true });
  }

  _record() {
    if (this._gesture) return;
    this._undo.push(this.snapshot());
    if (this._undo.length > 200) this._undo.shift();
    this._redo.length = 0;
    this.emit('history');
  }

  begin() { if (!this._gesture) this._gesture = this.snapshot(); }
  commit() {
    const s = this._gesture;
    this._gesture = null;
    if (s && s !== this.snapshot()) { this._undo.push(s); this._redo.length = 0; this.emit('history'); }
  }
  cancelGesture() { const s = this._gesture; this._gesture = null; if (s) this._restore(s); }

  get canUndo() { return this._undo.length > 0; }
  get canRedo() { return this._redo.length > 0; }
  undo() { if (!this._undo.length) return false; this._redo.push(this.snapshot()); this._restore(this._undo.pop()); this.emit('history'); return true; }
  redo() { if (!this._redo.length) return false; this._undo.push(this.snapshot()); this._restore(this._redo.pop()); this.emit('history'); return true; }

  /**
   * Изменить параметры. { history:false } — для обхода/прослушивания.
   * Set params. { history:false } for bypass/audition toggles.
   */
  set(patch, { history = true } = {}) {
    const next = sanitizeDeEss({ ...this.params, ...patch });
    const changed = Object.keys(patch).filter((k) => next[k] !== this.params[k]);
    if (!changed.length) return;
    if (history) this._record();
    this.params = next;
    this.emit('params', { keys: changed });
  }

  reset(keys) {
    const patch = {};
    for (const k of keys) patch[k] = DS_DEFAULTS[k];
    this.set(patch);
  }

  select(key) {
    if (this.selected === key) return;
    this.selected = key;
    this.emit('select', { key });
  }

  toJSON() { const { audition, bypass, ...rest } = this.params; return rest; }

  loadJSON(obj, { history = true } = {}) {
    if (!obj || typeof obj !== 'object') throw new Error('Некорректный пресет де-эссера');
    if (history) this._record();
    const { audition, bypass } = this.params;
    this.params = sanitizeDeEss({ ...obj, audition, bypass });
    this.emit('params', { all: true });
  }
}

/* ================================================================== *
 *  АУДИО / AUDIO
 * ================================================================== */

// Модуль ворклета загружается один раз на контекст / worklet module loaded once per context
const moduleCache = new WeakMap();
function loadWorklet(ctx) {
  if (!ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') return Promise.reject(new Error('AudioWorklet не поддерживается'));
  if (!moduleCache.has(ctx)) {
    moduleCache.set(ctx, ctx.audioWorklet.addModule(new URL('./worklets/deesser-worklet.js', import.meta.url)));
  }
  return moduleCache.get(ctx);
}

export class DeEsserPlugin {
  constructor(ctx, { fftSize = 8192 } = {}) {
    this.ctx = ctx;
    this.model = new DeEssModel();
    this.latency = 0;
    this.meters = { gr: 0, grL: 0, grR: 0, det: -120, thr: -24, inPk: 0, outPk: 0, makeup: 0 };
    this.fallback = false;

    // Вход принудительно стерео (моно-микрофон → L=R) / force stereo input
    this.input = ctx.createGain();
    this.input.channelCount = 2;
    this.input.channelCountMode = 'explicit';
    this.input.channelInterpretation = 'speakers';
    this.output = ctx.createGain();

    this.inAnalyser = ctx.createAnalyser();
    this.outAnalyser = ctx.createAnalyser();
    for (const a of [this.inAnalyser, this.outAnalyser]) {
      a.fftSize = fftSize;
      a.minDecibels = -120;
      a.maxDecibels = 0;
      a.smoothingTimeConstant = 0.7;
    }
    this.input.connect(this.inAnalyser);
    this.output.connect(this.outAnalyser);
    // Пока ворклет грузится — сигнал проходит насквозь / pass-through until the worklet loads
    this.input.connect(this.output);

    this.node = null;
    // Только изменения параметров (не 'latency', который шлёт сам _apply) / params only
    this._onChange = (e) => { if (e.detail.kind === 'params') this._apply(); };
    this.model.addEventListener('change', this._onChange);

    this.ready = loadWorklet(ctx).then(() => this._installWorklet()).catch((err) => {
      console.warn('[DeEss] AudioWorklet недоступен, упрощённый режим:', err.message);
      this._installFallback();
    });
  }

  _installWorklet() {
    const node = new AudioWorkletNode(this.ctx, 'movexe-deesser', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
      channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers'
    });
    node.port.onmessage = (e) => { Object.assign(this.meters, e.data); };
    node.onprocessorerror = (e) => console.error('[DeEss] processor error', e);
    this.node = node;
    this._send();
    try { this.input.disconnect(this.output); } catch { /* noop */ }
    this.input.connect(node).connect(this.output);
  }

  /**
   * Упрощённый режим без AudioWorklet: ФВЧ → DynamicsCompressorNode + субтрактивная НЧ-часть
   * (без отдельного sidechain — поэтому это только запасной вариант).
   * Fallback without AudioWorklet: HP → DynamicsCompressorNode + subtractive low part.
   * У DynamicsCompressorNode встроено упреждение 6 мс — выравниваем НЧ-ветку DelayNode.
   * DynamicsCompressorNode has a fixed 6 ms lookahead — align the low branch with a DelayNode.
   */
  _installFallback() {
    const ctx = this.ctx;
    this.fallback = true;
    const hp1 = ctx.createBiquadFilter(); hp1.type = 'highpass';
    const hp2 = ctx.createBiquadFilter(); hp2.type = 'highpass';
    const inv = ctx.createGain(); inv.gain.value = -1;
    const lowSum = ctx.createGain();
    const delay = ctx.createDelay(0.05); delay.delayTime.value = 0.006;
    const comp = ctx.createDynamicsCompressor();
    comp.ratio.value = 20;
    this.fb = { hp1, hp2, inv, lowSum, delay, comp };
    try { this.input.disconnect(this.output); } catch { /* noop */ }
    this.input.connect(hp1).connect(hp2);
    this.input.connect(lowSum);
    hp2.connect(inv).connect(lowSum);               // НЧ = x − ФВЧ(x)
    lowSum.connect(delay).connect(this.output);
    hp2.connect(comp).connect(this.output);
    this._applyFallback();
    this._fbTimer = setInterval(() => {
      const r = -(comp.reduction.value ?? comp.reduction) || 0;
      this.meters.gr = this.meters.grL = this.meters.grR = Math.min(r, this.model.params.range);
    }, 16);
  }

  _applyFallback() {
    const p = this.model.params, f = this.fb, t = this.ctx.currentTime;
    for (const h of [f.hp1, f.hp2]) { h.frequency.setTargetAtTime(p.frequency, t, 0.01); h.Q.value = 0.7; }
    f.comp.threshold.setTargetAtTime(p.threshold, t, 0.01);
    f.comp.knee.setTargetAtTime(p.knee, t, 0.01);
    f.comp.attack.setTargetAtTime(Math.max(0.001, p.attack / 1000), t, 0.01);
    f.comp.release.setTargetAtTime(Math.max(0.01, p.release / 1000), t, 0.01);
    this.output.gain.setTargetAtTime(p.bypass ? 1 : Math.pow(10, p.outputGain / 20), t, 0.02);
  }

  _send() {
    if (this.node) this.node.port.postMessage({ type: 'params', params: this.model.params });
  }

  _apply() {
    const p = this.model.params;
    this.latency = this.fallback ? Math.round(0.006 * this.ctx.sampleRate) : Math.round((p.lookahead / 1000) * this.ctx.sampleRate);
    if (this.node) this._send();
    else if (this.fallback) this._applyFallback();
    this.model.emit('latency', { samples: this.latency });
  }

  setFftSize(n) { this.inAnalyser.fftSize = n; this.outAnalyser.fftSize = n; }

  init(state) {
    if (state) this.model.loadJSON(state, { history: false });
    this._apply();
  }

  getState() { return this.model.toJSON(); }
  setState(s) { this.model.loadJSON(s, { history: false }); }

  dispose() {
    this.model.removeEventListener('change', this._onChange);
    clearInterval(this._fbTimer);
    for (const n of [this.input, this.output, this.node, this.inAnalyser, this.outAnalyser, ...Object.values(this.fb || {})]) {
      try { n && n.disconnect(); } catch { /* noop */ }
    }
  }
}

DeEsserPlugin.descriptor = {
  id: 'deesser',
  name: 'Movexe DeEss',
  category: 'Динамика',
  description: 'Де-эссер: подавление шипящих «с», «ш», «щ», «ц»',
  editor: 'deesser'
};
