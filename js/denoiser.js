/**
 * denoiser.js — Movexe DeNoise: модель (параметры, профиль шума, нарисованные кривые,
 * история) и аудио-плагин для FX-цепочки.
 * denoiser.js — Movexe DeNoise: model (params, noise print, drawn curves, history) and
 * FX-chain audio plugin.
 *
 * Кривые / curves (96 точек на лог-сетке CURVE_FREQS):
 *   reductionCurve — глубина подавления по частоте, дБ; null в точке = общий Reduction;
 *   profileOffset  — ручная правка профиля шума, дБ (0 = как обучено).
 */
import { DN_DEFAULTS, sanitizeDenoise, curveToBins, resampleProfile, CURVE_FREQS } from './spectral.js';
import { profileToJSON, profileFromJSON } from './learn.js';

/* ================================================================== *
 *  МОДЕЛЬ / MODEL
 * ================================================================== */

export class DenoiseModel extends EventTarget {
  constructor() {
    super();
    this.params = { ...DN_DEFAULTS };
    this.profile = null;                 // { name, sampleRate, fftSize, bins, id? }
    this.reductionCurve = null;          // Array(96) | null
    this.profileOffset = null;           // Array(96) | null
    this.brush = 'draw';                 // 'draw' | 'smooth' | 'erase'
    this.target = 'reduction';           // 'reduction' | 'profile'
    this.selectedPoint = -1;
    this.learnProgress = -1;             // −1 — не учимся / not learning
    this._profiles = new Map();          // ссылка → профиль (для отмены) / ref → profile (undo)
    this._pref = 0;
    this._undo = []; this._redo = []; this._gesture = null;
  }

  emit(kind, detail = {}) { this.dispatchEvent(new CustomEvent('change', { detail: { kind, ...detail } })); }

  /* ---------- история: параметры + кривые + ссылка на профиль / history ---------- */
  snapshot() {
    const { bypass, freeze, ...p } = this.params;
    return JSON.stringify({ p, rc: this.reductionCurve, po: this.profileOffset, pr: this._curRef ?? null });
  }
  _restore(s) {
    const o = JSON.parse(s);
    const { bypass, freeze } = this.params;
    this.params = sanitizeDenoise({ ...o.p, bypass, freeze });
    this.reductionCurve = o.rc;
    this.profileOffset = o.po;
    if (o.pr !== (this._curRef ?? null)) { this._curRef = o.pr; this.profile = o.pr == null ? null : this._profiles.get(o.pr); this.emit('profile'); }
    this.emit('params', { all: true });
    this.emit('curves');
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
    const s = this._gesture; this._gesture = null;
    if (s && s !== this.snapshot()) { this._undo.push(s); this._redo.length = 0; this.emit('history'); }
  }
  get canUndo() { return this._undo.length > 0; }
  get canRedo() { return this._redo.length > 0; }
  undo() { if (!this._undo.length) return false; this._redo.push(this.snapshot()); this._restore(this._undo.pop()); this.emit('history'); return true; }
  redo() { if (!this._redo.length) return false; this._undo.push(this.snapshot()); this._restore(this._redo.pop()); this.emit('history'); return true; }

  /* ---------- параметры / params ---------- */
  set(patch, { history = true } = {}) {
    const next = sanitizeDenoise({ ...this.params, ...patch });
    const keys = Object.keys(patch).filter((k) => next[k] !== this.params[k]);
    if (!keys.length) return;
    if (history) this._record();
    this.params = next;
    this.emit('params', { keys });
  }

  /* ---------- профиль / profile ---------- */
  setProfile(profile, { history = true } = {}) {
    if (history) this._record();
    const ref = ++this._pref;
    this._profiles.set(ref, profile);
    this._curRef = ref;
    this.profile = profile;
    this.profileOffset = null; // новые данные — правки сбрасываются / new print resets edits
    this.emit('profile');
    this.emit('curves');
  }

  /* ---------- кривые / curves ---------- */
  /** Установить кривую (в жесте begin/commit — одна запись истории). Set a curve. */
  setCurve(which, arr) {
    this._record();
    if (which === 'reduction') this.reductionCurve = arr; else this.profileOffset = arr;
    this.emit('curves', { which });
  }
  /** Сброс кривой: подавление → «по профилю» (общий Reduction), профиль → без правок. */
  resetCurve(which = this.target) { this.setCurve(which, null); }

  setTool({ brush, target }) {
    if (brush) this.brush = brush;
    if (target) this.target = target;
    this.selectedPoint = -1;
    this.emit('tool');
  }

  /* ---------- сериализация / serialisation ---------- */
  toJSON() {
    const { bypass, freeze, ...p } = this.params;
    return {
      ...p,
      reductionCurve: this.reductionCurve,
      profileOffset: this.profileOffset,
      noiseProfile: this.profile?.id || null,
      profile: this.profile ? profileToJSON(this.profile) : null
    };
  }

  loadJSON(obj, { history = true } = {}) {
    if (!obj || typeof obj !== 'object') throw new Error('Некорректный пресет шумоподавителя');
    if (history) this._record();
    const { bypass, freeze } = this.params;
    this.params = sanitizeDenoise({ ...obj, bypass, freeze, mode: obj.mode === 'learn' ? 'reduce' : obj.mode });
    const okCurve = (a) => (Array.isArray(a) && a.length === CURVE_FREQS.length ? a.map((v) => (v == null ? null : Math.max(-60, Math.min(60, Number(v)) || 0))) : null);
    this.reductionCurve = okCurve(obj.reductionCurve);
    this.profileOffset = okCurve(obj.profileOffset);
    if (obj.profile) {
      try {
        const pr = profileFromJSON(obj.profile);
        const ref = ++this._pref;
        this._profiles.set(ref, pr);
        this._curRef = ref;
        this.profile = pr;
      } catch (e) { console.warn('[DeNoise] профиль пропущен:', e.message); }
    }
    this.pendingProfileId = !obj.profile && typeof obj.noiseProfile === 'string' ? obj.noiseProfile : null;
    this.emit('profile');
    this.emit('params', { all: true });
    this.emit('curves');
  }
}

/* ================================================================== *
 *  АУДИО / AUDIO
 * ================================================================== */

const moduleCache = new WeakMap();
function loadWorklet(ctx) {
  if (!ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') return Promise.reject(new Error('AudioWorklet не поддерживается'));
  if (!moduleCache.has(ctx)) moduleCache.set(ctx, ctx.audioWorklet.addModule(new URL('./worklets/denoise-worklet.js', import.meta.url)));
  return moduleCache.get(ctx);
}

export class DenoisePlugin {
  constructor(ctx, { fftSize = 4096 } = {}) {
    this.ctx = ctx;
    this.model = new DenoiseModel();
    this.fftSize = ctx.sampleRate > 64000 ? 4096 : 2048;  // как в ворклете / same as worklet
    this.latency = this.fftSize - 1;
    this.meters = { gains: null, noise: null, gr: 0, inPk: 0, outPk: 0, source: 'auto', t: 0 };
    this.supported = true;

    this.input = ctx.createGain();
    this.input.channelCount = 2;
    this.input.channelCountMode = 'explicit';
    this.input.channelInterpretation = 'speakers'; // моно-микрофон → L=R
    this.output = ctx.createGain();
    this.inAnalyser = ctx.createAnalyser();
    this.outAnalyser = ctx.createAnalyser();
    for (const a of [this.inAnalyser, this.outAnalyser]) {
      a.fftSize = Math.min(Math.max(2048, fftSize), 8192); a.minDecibels = -120; a.maxDecibels = 0; a.smoothingTimeConstant = 0.6;
    }
    this.input.connect(this.inAnalyser);
    this.output.connect(this.outAnalyser);
    this.input.connect(this.output); // до загрузки ворклета — насквозь / pass-through until loaded
    this.node = null;

    this._onChange = (e) => this._handle(e.detail);
    this.model.addEventListener('change', this._onChange);
    this.ready = loadWorklet(ctx).then(() => this._install()).catch((err) => {
      this.supported = false;
      console.warn('[DeNoise] обработка недоступна:', err.message);
    });
  }

  _install() {
    const node = new AudioWorkletNode(this.ctx, 'movexe-denoise', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
      channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers'
    });
    node.port.onmessage = (e) => this._fromWorklet(e.data);
    node.onprocessorerror = (e) => console.error('[DeNoise] processor error', e);
    this.node = node;
    try { this.input.disconnect(this.output); } catch { /* noop */ }
    this.input.connect(node).connect(this.output);
    this._sendParams(); this._sendProfile(); this._sendDepth();
  }

  _fromWorklet(d) {
    if (d.gains) { Object.assign(this.meters, d); this.meters.t = performance.now(); }
    if (d.latency) { this.latency = d.latency; this.model.emit('latency', { samples: d.latency }); }
    if (d.learn !== undefined) { this.model.learnProgress = Math.min(1, d.learn); this.model.emit('learn', { progress: this.model.learnProgress }); }
    if (d.profile) {
      const t = new Date();
      this.model.learnProgress = -1;
      this.model.setProfile({ name: `Обучено ${t.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`, sampleRate: d.sampleRate, fftSize: d.fftSize, bins: d.profile, created: t.toISOString() });
      // После обучения — сразу подавление / switch to reduction after learning
      this.model.set({ mode: this.model.params.adaptive ? 'adaptive' : 'reduce' }, { history: false });
      this.model.emit('learn', { done: true });
    }
  }

  _handle(d) {
    if (d.kind === 'params') { this._sendParams(); if (d.all || d.keys?.includes('reduction')) this._sendDepth(); }
    if (d.kind === 'profile' || (d.kind === 'curves' && (d.which === 'profile' || !d.which))) this._sendProfile();
    if (d.kind === 'curves' && (d.which === 'reduction' || !d.which)) this._sendDepth();
  }

  _sendParams() { this.node?.port.postMessage({ type: 'params', params: this.model.params }); }

  /** Профиль с правками в бинах ворклета / profile with edits in worklet bins. */
  profileBins() {
    const m = this.model;
    if (!m.profile) return null;
    const bins = resampleProfile(m.profile, this.fftSize, this.ctx.sampleRate);
    if (m.profileOffset) {
      const off = curveToBins(m.profileOffset, this.fftSize, this.ctx.sampleRate, 0);
      for (let k = 0; k < bins.length; k++) bins[k] += off[k];
    }
    return bins;
  }

  _sendProfile() { this.node?.port.postMessage({ type: 'profile', bins: this.profileBins() }); }

  _sendDepth() {
    const m = this.model;
    const bins = m.reductionCurve ? curveToBins(m.reductionCurve, this.fftSize, this.ctx.sampleRate, m.params.reduction) : null;
    this.node?.port.postMessage({ type: 'depth', bins });
  }

  /** Запуск обучения / start learning. */
  learn() {
    if (!this.node) throw new Error(this.supported ? 'Шумоподавитель ещё загружается' : 'Браузер не поддерживает AudioWorklet');
    const m = this.model;
    m.set({ mode: 'learn' }, { history: false });
    m.learnProgress = 0;
    m.emit('learn', { progress: 0 });
    this.node.port.postMessage({ type: 'learn', seconds: m.params.learnSeconds });
  }

  cancelLearn() {
    this.node?.port.postMessage({ type: 'learnCancel' });
    this.model.learnProgress = -1;
    this.model.set({ mode: 'reduce' }, { history: false });
    this.model.emit('learn', { cancelled: true });
  }

  setFftSize(n) { this.inAnalyser.fftSize = Math.min(Math.max(2048, n), 8192); this.outAnalyser.fftSize = this.inAnalyser.fftSize; }
  init(state) { if (state) this.model.loadJSON(state, { history: false }); }
  getState() { return this.model.toJSON(); }
  setState(s) { this.model.loadJSON(s, { history: false }); }

  dispose() {
    this.model.removeEventListener('change', this._onChange);
    for (const n of [this.input, this.output, this.node, this.inAnalyser, this.outAnalyser]) { try { n && n.disconnect(); } catch { /* noop */ } }
  }
}

DenoisePlugin.descriptor = {
  id: 'denoise',
  name: 'Movexe DeNoise',
  category: 'Реставрация',
  description: 'Шумоподавитель: обучение профиля шума и спектральное подавление',
  editor: 'denoise'
};
