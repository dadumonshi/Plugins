/**
 * recorder.js — запись с микрофона (до или после FX), список дублей, WAV-экспорт, IndexedDB.
 * recorder.js — recording (pre- or post-FX), takes list, WAV export, IndexedDB persistence.
 */

const DB_NAME = 'proeq-takes';
const STORE = 'takes';

/* ---------------- IndexedDB (best effort) ---------------- */

function openDb() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject(new Error('no IndexedDB')); return; }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbOp(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const res = fn(tx.objectStore(STORE));
    tx.oncomplete = () => { db.close(); resolve(res && res.result); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

/* ---------------- WAV ---------------- */

/** 16-bit PCM WAV из каналов Float32 / 16-bit PCM WAV from Float32 channels. */
export function encodeWav(channels, sampleRate) {
  const nCh = channels.length;
  const len = channels[0].length;
  const bytes = 44 + len * nCh * 2;
  const buf = new ArrayBuffer(bytes);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, bytes - 8, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nCh, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * nCh * 2, true);
  v.setUint16(32, nCh * 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, len * nCh * 2, true);
  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < nCh; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}

function concat(chunks, total) {
  const out = new Float32Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/* ---------------- Recorder ---------------- */

export class Recorder extends EventTarget {
  /** @param {import('./audio.js').AudioEngine} engine */
  constructor(engine) {
    super();
    this.engine = engine;
    this.takes = [];      // { id, name, sampleRate, channels:[L,R], duration, created, wet }
    this.recording = false;
    this.startTime = 0;
    this.tapMode = 'wet'; // 'wet' — после FX / post-FX ; 'dry' — до FX / pre-FX
    this._node = null;
    this._chunksL = [];
    this._chunksR = [];
    this._frames = 0;
    this._workletReady = null;
  }

  _emit(type) { this.dispatchEvent(new CustomEvent(type)); }

  async load() {
    try {
      const all = await dbOp('readonly', (s) => s.getAll());
      this.takes = (all || []).sort((a, b) => a.created - b.created);
    } catch (e) {
      console.info('[rec] IndexedDB unavailable, takes will not persist', e.message);
    }
    this._emit('takes');
  }

  async _ensureNode() {
    const ctx = this.engine.ctx;
    if (this._node) return this._node;
    // Предпочитаем AudioWorklet; фолбэк — ScriptProcessor (устарел, но есть везде).
    // Prefer AudioWorklet; fall back to ScriptProcessor (deprecated but universal).
    if (ctx.audioWorklet && window.AudioWorkletNode) {
      try {
        if (!this._workletReady) this._workletReady = ctx.audioWorklet.addModule(new URL('./worklets/recorder-worklet.js', import.meta.url));
        await this._workletReady;
        const node = new AudioWorkletNode(ctx, 'pcm-recorder', {
          numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
          channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers'
        });
        node.port.onmessage = (e) => {
          if (e.data.l) this._push(e.data.l, e.data.r);
          else if (e.data.done) this._finish();
        };
        // Выход молчит, но подключение к destination нужно для «вытягивания» графа.
        // Output is silent, but connecting to destination keeps the node pulled.
        node.connect(ctx.destination);
        this._node = { node, worklet: true };
        return this._node;
      } catch (e) {
        console.warn('[rec] AudioWorklet failed, using ScriptProcessor', e);
      }
    }
    const sp = ctx.createScriptProcessor(4096, 2, 1);
    sp.onaudioprocess = (e) => {
      if (!this.recording) return;
      const ib = e.inputBuffer;
      const l = ib.getChannelData(0).slice();
      const r = (ib.numberOfChannels > 1 ? ib.getChannelData(1) : ib.getChannelData(0)).slice();
      this._push(l, r);
    };
    sp.connect(ctx.destination);
    this._node = { node: sp, worklet: false };
    return this._node;
  }

  _push(l, r) {
    this._chunksL.push(l);
    this._chunksR.push(r);
    this._frames += l.length;
  }

  async start() {
    if (this.recording) return;
    await this.engine.resume();
    const { node, worklet } = await this._ensureNode();
    const tap = this.tapMode === 'dry' ? this.engine.sourceBus : this.engine.masterGain;
    try { this.engine.sourceBus.disconnect(node); } catch { /* noop */ }
    try { this.engine.masterGain.disconnect(node); } catch { /* noop */ }
    tap.connect(node);
    this._chunksL = []; this._chunksR = []; this._frames = 0;
    if (worklet) node.port.postMessage('start');
    this.recording = true;
    this.startTime = performance.now();
    this._emit('state');
  }

  stop() {
    if (!this.recording) return;
    this.recording = false;
    if (this._node.worklet) this._node.node.port.postMessage('stop'); // → _finish после flush
    else this._finish();
    this._emit('state');
  }

  get elapsed() { return this.recording ? (performance.now() - this.startTime) / 1000 : 0; }

  async _finish() {
    const n = this._node.node;
    try { this.engine.sourceBus.disconnect(n); } catch { /* noop */ }
    try { this.engine.masterGain.disconnect(n); } catch { /* noop */ }
    if (!this._frames) return;
    const sr = this.engine.sampleRate;
    const take = {
      id: `t${Date.now().toString(36)}`,
      name: `Запись ${this.takes.length + 1}`,
      sampleRate: sr,
      channels: [concat(this._chunksL, this._frames), concat(this._chunksR, this._frames)],
      duration: this._frames / sr,
      created: Date.now(),
      wet: this.tapMode === 'wet'
    };
    this._chunksL = []; this._chunksR = [];
    this.takes.push(take);
    this._emit('takes');
    try { await dbOp('readwrite', (s) => s.put(take)); } catch { /* не критично / non-critical */ }
  }

  /** Импорт аудиофайла как дубля / import an audio file as a take. */
  async importFile(file) {
    const buf = await this.engine.decode(await file.arrayBuffer());
    const channels = [buf.getChannelData(0).slice(), (buf.numberOfChannels > 1 ? buf.getChannelData(1) : buf.getChannelData(0)).slice()];
    const take = {
      id: `t${Date.now().toString(36)}`,
      name: file.name.replace(/\.[^.]+$/, '').slice(0, 40),
      sampleRate: buf.sampleRate, channels, duration: buf.duration, created: Date.now(), wet: false, imported: true
    };
    this.takes.push(take);
    this._emit('takes');
    try { await dbOp('readwrite', (s) => s.put(take)); } catch { /* noop */ }
    return take;
  }

  toBuffer(take) {
    const ctx = this.engine.ctx;
    const b = ctx.createBuffer(2, take.channels[0].length, take.sampleRate);
    b.copyToChannel(take.channels[0], 0);
    b.copyToChannel(take.channels[1], 1);
    return b;
  }

  wav(take) { return encodeWav(take.channels, take.sampleRate); }

  async rename(id, name) {
    const t = this.takes.find((x) => x.id === id);
    if (!t) return;
    t.name = String(name).slice(0, 40);
    this._emit('takes');
    try { await dbOp('readwrite', (s) => s.put(t)); } catch { /* noop */ }
  }

  async remove(id) {
    this.takes = this.takes.filter((t) => t.id !== id);
    this._emit('takes');
    try { await dbOp('readwrite', (s) => s.delete(id)); } catch { /* noop */ }
  }

  /**
   * Офлайн-рендер дубля через FX-цепочку (bounce) — быстрее реального времени.
   * Offline bounce of a take through the FX chain — faster than realtime.
   */
  async bounce(take, chainState, PluginLookup) {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OAC) throw new Error('Офлайн-обработка не поддерживается этим браузером');
    const len = take.channels[0].length;
    const tail = Math.round(take.sampleRate * 0.25);
    const octx = new OAC(2, len + tail, take.sampleRate);
    const src = octx.createBufferSource();
    const b = octx.createBuffer(2, len, take.sampleRate);
    b.copyToChannel(take.channels[0], 0);
    b.copyToChannel(take.channels[1], 1);
    src.buffer = b;
    let prev = src;
    const plugins = [];
    for (const slot of chainState) {
      if (slot.bypass) continue;
      const P = PluginLookup(slot.plugin);
      if (!P) continue;
      const p = new P(octx, { lowPower: false });
      p.init?.(slot.state);
      // Плагины на AudioWorklet (де-эссер) грузят модуль асинхронно / worklet plugins load async
      if (p.ready) await p.ready;
      // В офлайне FIR считается синхронно / offline: design FIR synchronously
      if (p.model?.settings && p.model.settings.mode !== 'zero') await p._computeFir?.(); // только EQ 24
      prev.connect(p.input);
      prev = p.output;
      plugins.push(p);
    }
    prev.connect(octx.destination);
    src.start();
    const rendered = await octx.startRendering();
    const lat = plugins.reduce((s, p) => s + (p.latency || 0), 0);
    const ch = [0, 1].map((c) => rendered.getChannelData(c).slice(lat, lat + len));
    const out = {
      id: `t${Date.now().toString(36)}`,
      name: `${take.name} (эффекты)`.slice(0, 40),
      sampleRate: take.sampleRate, channels: ch, duration: len / take.sampleRate, created: Date.now(), wet: true
    };
    this.takes.push(out);
    this._emit('takes');
    try { await dbOp('readwrite', (s) => s.put(out)); } catch { /* noop */ }
    return out;
  }
}
