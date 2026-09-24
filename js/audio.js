/**
 * audio.js — аудио-движок: AudioContext, микрофон, воспроизведение, FX-цепочка, мониторинг.
 * audio.js — audio engine: AudioContext, microphone, playback, FX chain, monitoring.
 *
 * Граф / Graph:
 *   mic ─┐
 *   file ┼─► sourceBus ─► chainIn ─► [FX slot 1] ─► … ─► chainOut ─► monitor ─► speakers
 *   take ┘       │                                          │
 *                └─► inMeter / dry tap                      └─► outMeter / wet tap (запись / recording)
 */
import { FxChain } from './fx-chain.js';

/** Feature detection AudioContext (webkit-префикс для старых iOS). */
const AC = window.AudioContext || window.webkitAudioContext;

export const audioSupported = !!AC;
export const micSupported = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

export class AudioEngine extends EventTarget {
  constructor({ lowPower = false, fftSize = 8192, maxBands = 24 } = {}) {
    super();
    if (!AC) throw new Error('Этот браузер не поддерживает Web Audio API');
    // latencyHint 'interactive' — минимальная задержка для мониторинга микрофона.
    // latencyHint 'interactive' — lowest latency for mic monitoring.
    this.ctx = new AC({ latencyHint: 'interactive' });
    const ctx = this.ctx;

    const stereo = (n) => { n.channelCount = 2; n.channelCountMode = 'explicit'; n.channelInterpretation = 'speakers'; return n; };
    this.sourceBus = stereo(ctx.createGain());
    this.chainIn = stereo(ctx.createGain());
    this.chainOut = stereo(ctx.createGain());
    this.masterGain = ctx.createGain();
    this.monitorGain = ctx.createGain();
    this.monitorGain.gain.value = 0;

    this.inMeter = ctx.createAnalyser();
    this.outMeter = ctx.createAnalyser();
    for (const m of [this.inMeter, this.outMeter]) { m.fftSize = 1024; m.smoothingTimeConstant = 0; }

    this.sourceBus.connect(this.chainIn);
    this.sourceBus.connect(this.inMeter);
    this.chainOut.connect(this.masterGain);
    this.masterGain.connect(this.outMeter);
    // Цепь всегда подключена к destination (через gain=0), иначе некоторые браузеры
    // (WebKit) не «тянут» граф и анализаторы молчат.
    // Chain is always connected to destination (via gain 0), otherwise some browsers
    // (WebKit) do not pull the graph and analysers stay silent.
    this.masterGain.connect(this.monitorGain).connect(ctx.destination);

    this.chain = new FxChain(ctx, this.chainIn, this.chainOut, { lowPower, fftSize, maxBands });

    this.mic = null;          // { stream, node }
    this.player = null;       // { node, buffer, startedAt, offset, loop, takeId }
    this.monitor = false;
    this._meterBuf = new Float32Array(1024);
    this._peaks = { in: 0, out: 0 };

    // iOS/Safari: контекст стартует в 'suspended' до жеста пользователя.
    // iOS/Safari: the context starts 'suspended' until a user gesture.
    ctx.onstatechange = () => this._emit('state');
  }

  _emit(type, detail = {}) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  get running() { return this.ctx.state === 'running'; }
  get sampleRate() { return this.ctx.sampleRate; }

  /** Разблокировка аудио по жесту / unlock audio on user gesture. */
  async resume() {
    if (this.ctx.state !== 'running') {
      try { await this.ctx.resume(); } catch (e) { console.warn('[audio] resume failed', e); }
    }
    return this.running;
  }

  /* ---------------- Микрофон / Microphone ---------------- */

  async enableMic(deviceId) {
    if (!micSupported) throw new Error('Микрофон недоступен: откройте страницу по HTTPS');
    await this.resume();
    this.disableMic();
    // iOS 16.4+: аудиосессия «запись и воспроизведение», иначе звук уходит в трубку.
    // iOS 16.4+: 'play-and-record' audio session, otherwise output goes to the earpiece.
    try { if (navigator.audioSession) navigator.audioSession.type = 'play-and-record'; } catch { /* noop */ }
    const constraints = {
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        // Для музыки отключаем «голосовую» обработку / disable voice processing for music
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: { ideal: 2 },
        latency: { ideal: 0 }
      },
      video: false
    };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      // Некоторые устройства не принимают расширенные ограничения / some devices reject advanced constraints
      if (e.name === 'OverconstrainedError' || e.name === 'TypeError') stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      else throw e;
    }
    const node = this.ctx.createMediaStreamSource(stream);
    node.connect(this.sourceBus);
    this.mic = { stream, node };
    // Если трек завершился (отключили гарнитуру) / track ended (headset unplugged)
    stream.getAudioTracks().forEach((t) => { t.onended = () => { this.disableMic(); }; });
    this._emit('source');
    return stream;
  }

  disableMic() {
    if (!this.mic) return;
    try { this.mic.node.disconnect(); } catch { /* noop */ }
    this.mic.stream.getTracks().forEach((t) => t.stop());
    this.mic = null;
    this._emit('source');
  }

  async listInputs() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const list = await navigator.mediaDevices.enumerateDevices();
    return list.filter((d) => d.kind === 'audioinput');
  }

  /* ---------------- Воспроизведение / Playback ---------------- */

  async decode(arrayBuffer) {
    // Safari < 14.1: только callback-версия / callback-only on old Safari
    return new Promise((resolve, reject) => {
      const p = this.ctx.decodeAudioData(arrayBuffer, resolve, reject);
      if (p && p.then) p.then(resolve, reject);
    });
  }

  play(buffer, { loop = false, offset = 0, takeId = null } = {}) {
    this.stop(false);
    const node = this.ctx.createBufferSource();
    node.buffer = buffer;
    node.loop = loop;
    node.connect(this.sourceBus);
    node.start(0, Math.min(offset, buffer.duration - 0.01));
    node.onended = () => {
      if (this.player && this.player.node === node) { this.player = null; this._emit('playback'); }
    };
    this.player = { node, buffer, startedAt: this.ctx.currentTime - offset, loop, takeId };
    this._emit('playback');
  }

  stop(emit = true) {
    if (!this.player) return;
    const { node } = this.player;
    this.player = null;
    try { node.onended = null; node.stop(); node.disconnect(); } catch { /* noop */ }
    if (emit) this._emit('playback');
  }

  get playPosition() {
    if (!this.player) return 0;
    const d = this.player.buffer.duration;
    const t = this.ctx.currentTime - this.player.startedAt;
    return this.player.loop ? t % d : Math.min(t, d);
  }

  /* ---------------- Мониторинг / Monitoring ---------------- */

  setMonitor(on) {
    this.monitor = on;
    this.monitorGain.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.02);
    this._emit('monitor');
  }

  setMasterGain(db) {
    this.masterGain.gain.setTargetAtTime(Math.pow(10, db / 20), this.ctx.currentTime, 0.02);
  }

  /** Пиковые уровни (0..1+) с плавным спадом / peak levels with decay. */
  levels() {
    const read = (an, key) => {
      const buf = this._meterBuf;
      if (an.getFloatTimeDomainData) an.getFloatTimeDomainData(buf);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]); if (v > peak) peak = v; }
      this._peaks[key] = Math.max(peak, this._peaks[key] * 0.9);
      return this._peaks[key];
    };
    return { in: read(this.inMeter, 'in'), out: read(this.outMeter, 'out') };
  }

  get hasSignal() { return !!(this.mic || this.player); }
}
