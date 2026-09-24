/**
 * denoise-worklet.js — AudioWorklet Movexe DeNoise: STFT (N=2048, шаг 512, 75 %),
 * спектральное подавление, обучение профиля, режимы каналов, микс, выход.
 * denoise-worklet.js — Movexe DeNoise AudioWorklet: STFT, spectral reduction,
 * noise-print learning, channel modes, mix, output.
 *
 * Задержка = N − 1 сэмпл (≈ 43 мс при 48 кГц). «Сухой» сигнал задерживается так же,
 * поэтому Mix и Обход не дают гребенчатой фильтрации.
 * Latency = N samples. The dry path is delayed by the same amount, so Mix and Bypass
 * never comb-filter.
 */
import { FFT, hann } from '../fft.js';
import { SpectralProcessor, DN_DEFAULTS } from '../spectral.js';

class MovexeDenoise extends AudioWorkletProcessor {
  constructor() {
    super();
    const fs = sampleRate;
    const N = fs > 64000 ? 4096 : 2048;   // одинаковое разрешение по частоте / same resolution
    this.N = N;
    this.H = N / 4;
    this.fft = new FFT(N);
    this.win = hann(N);
    this.olaGain = 2 / 3;                 // 1 / Σw² при перекрытии 75 %
    this.sp = new SpectralProcessor(N, fs);
    this.p = { ...DN_DEFAULTS };
    this.sp.configure(this.p);
    this.ch = [this.sp.channel(), this.sp.channel()];
    const ring = () => new Float32Array(N);
    this.inRing = [ring(), ring()];
    this.dry = [ring(), ring()];          // линия задержки «сухого» / dry delay line
    this.ola = [ring(), ring()];
    this.fifo = [new Float32Array(2 * N), new Float32Array(2 * N)];
    this.fifoR = 0; this.fifoW = 0; this.fifoN = 0;
    this.wpos = 0;
    this.hopCount = 0;
    this.re = new Float64Array(N); this.im = new Float64Array(N);
    this.P = [new Float64Array(N / 2 + 1), new Float64Array(N / 2 + 1)];
    this.spec = [{ re: new Float64Array(N), im: new Float64Array(N) }, { re: new Float64Array(N), im: new Float64Array(N) }];
    this.outS = 1; this.mixS = 1; this.bypS = 0;
    this.learning = false; this.learnSum = null; this.learnFrames = 0; this.learnTarget = 0;
    this.hops = 0;
    this.pkIn = 0; this.pkOut = 0; this.eIn = 0; this.eOut = 0;
    this.source = 'auto';

    this.port.onmessage = (e) => this._msg(e.data || {});
    this.port.postMessage({ ready: true, fftSize: N, hop: this.H, latency: N - 1 });
  }

  _msg(d) {
    if (d.type === 'params') {
      const wasAdaptive = this.p.adaptive;
      Object.assign(this.p, d.params);
      this.sp.configure(this.p);
      // Включили Adaptive — стартуем с обученного профиля / start adaptive from the profile
      if (this.p.adaptive && !wasAdaptive) this.ch.forEach((c) => this.sp.seedTracker(c));
    } else if (d.type === 'profile') {
      this.sp.setProfile(d.bins || null);
      if (this.p.adaptive) this.ch.forEach((c) => this.sp.seedTracker(c));
    } else if (d.type === 'depth') {
      this.sp.setDepth(d.bins || null);
    } else if (d.type === 'learn') {
      this.learning = true;
      this.learnSum = new Float64Array(this.N / 2 + 1);
      this.learnFrames = 0;
      this.learnTarget = Math.max(8, Math.round((d.seconds * sampleRate) / this.H));
    } else if (d.type === 'learnCancel') {
      this.learning = false;
    }
  }

  /** Один шаг STFT (каждые H сэмплов) / one STFT hop. */
  _hop() {
    const { N, H, re, im, win, fft } = this;
    const p = this.p;
    const nch = p.channelMode === 'mono' ? 1 : 2;
    const bins = N / 2 + 1;
    const pass = this.learning || p.mode === 'learn';

    for (let c = 0; c < nch; c++) {
      const ring = this.inRing[c];
      // кадр = последние N сэмплов, окно анализа / frame = last N samples, analysis window
      for (let i = 0; i < N; i++) { re[i] = ring[(this.wpos + i) % N] * win[i]; im[i] = 0; }
      fft.forward(re, im);
      const P = this.P[c];
      for (let k = 0; k < bins; k++) P[k] = re[k] * re[k] + im[k] * im[k];
      this.spec[c].re.set(re); this.spec[c].im.set(im);
      if (this.learning) for (let k = 0; k < bins; k++) this.learnSum[k] += P[k] / nch;
      if (!pass) {
        this.source = this.sp.noiseFor(this.ch[c], P, { adaptive: p.adaptive || p.mode === 'adaptive', frozen: p.freeze });
        this.sp.gains(this.ch[c], P);
      }
    }

    // Связь каналов (усреднение усилений) / stereo link (gain averaging)
    const link = p.channelMode === 'left-right' ? 0 : p.stereoLink / 100;
    if (!pass && nch === 2 && link > 0) {
      const g0 = this.ch[0].G, g1 = this.ch[1].G;
      for (let k = 0; k < bins; k++) {
        const m = (g0[k] + g1[k]) * 0.5;
        g0[k] += (m - g0[k]) * link;
        g1[k] += (m - g1[k]) * link;
      }
    }

    for (let c = 0; c < nch; c++) {
      const sr = this.spec[c].re, si = this.spec[c].im;
      const G = this.ch[c].G, P = this.P[c];
      for (let k = 0; k < bins; k++) {
        const g = pass ? 1 : G[k];
        this.eIn += P[k];
        this.eOut += P[k] * g * g;
        re[k] = sr[k] * g; im[k] = si[k] * g;
        if (k > 0 && k < N / 2) { re[N - k] = sr[N - k] * g; im[N - k] = si[N - k] * g; }
      }
      fft.inverse(re, im);
      const ola = this.ola[c];
      for (let i = 0; i < N; i++) ola[i] += re[i] * win[i] * this.olaGain;
      // Готовые H сэмплов → FIFO; сдвиг накопителя / ready H samples → FIFO; shift accumulator
      const fifo = this.fifo[c];
      for (let i = 0; i < H; i++) fifo[(this.fifoW + i) % fifo.length] = ola[i];
      ola.copyWithin(0, H);
      ola.fill(0, N - H);
    }
    if (nch === 1) this.fifo[1].set(this.fifo[0]);
    this.fifoW = (this.fifoW + H) % this.fifo[0].length;
    this.fifoN += H;

    if (this.learning) {
      this.learnFrames++;
      if (this.learnFrames % 4 === 0) this.port.postMessage({ learn: this.learnFrames / this.learnTarget });
      if (this.learnFrames >= this.learnTarget) {
        const prof = new Float32Array(bins);
        const ref = this.sp.REF;
        for (let k = 0; k < bins; k++) prof[k] = 10 * Math.log10(this.learnSum[k] / this.learnFrames / ref + 1e-16);
        this.learning = false;
        this.port.postMessage({ profile: prof, fftSize: N, sampleRate }, [prof.buffer]);
      }
    }

    // Данные для графика ~30 раз в секунду / graph data ~30 times per second
    if (++this.hops % 3 === 0) {
      const g = new Float32Array(bins), nz = new Float32Array(bins), sp = new Float32Array(bins);
      const ref = this.sp.REF;
      for (let k = 0; k < bins; k++) {
        // Спектр входа в той же шкале, что профиль / input spectrum on the profile's scale
        sp[k] = 10 * Math.log10((nch === 2 ? (this.P[0][k] + this.P[1][k]) * 0.5 : this.P[0][k]) / ref + 1e-16);
        const gg = pass ? 1 : nch === 2 ? (this.ch[0].G[k] + this.ch[1].G[k]) * 0.5 : this.ch[0].G[k];
        g[k] = gg;
        const nv = this.sp.profilePow && !(p.adaptive || p.mode === 'adaptive') ? this.sp.profilePow[k] : this.ch[0].noise[k];
        nz[k] = 10 * Math.log10(nv / ref + 1e-16);
      }
      const gr = this.eIn > 0 ? 10 * Math.log10(this.eIn / Math.max(this.eOut, 1e-30)) : 0;
      this.port.postMessage({ gains: g, noise: nz, spec: sp, gr: pass || p.bypass ? 0 : gr, inPk: this.pkIn, outPk: this.pkOut, source: this.source }, [g.buffer, nz.buffer, sp.buffer]);
      this.eIn = this.eOut = 0;
      this.pkIn = this.pkOut = 0;
    }
  }

  process(inputs, outputs) {
    const out = outputs[0];
    if (!out || !out.length) return true;
    const oL = out[0], oR = out[1] || out[0];
    const input = inputs[0];
    const n = oL.length;
    const iL = input && input[0], iR = input && (input[1] || input[0]);
    const p = this.p;
    const ms = p.channelMode === 'mid-side', mono = p.channelMode === 'mono';
    const outT = Math.pow(10, p.outputGain / 20), mixT = p.mix / 100, bypT = p.bypass ? 1 : 0;
    const N = this.N, fl = this.fifo[0].length;

    for (let i = 0; i < n; i++) {
      let a = iL ? iL[i] : 0, b = iR ? iR[i] : 0;
      const pk = Math.max(Math.abs(a), Math.abs(b));
      if (pk > this.pkIn) this.pkIn = pk;
      if (ms) { const m = (a + b) * 0.5, s = (a - b) * 0.5; a = m; b = s; }
      else if (mono) { a = b = (a + b) * 0.5; }
      // «Сухой» с той же задержкой, что у обработанного: N − 1 сэмпл (кадр [t−N+1 … t]
      // отдаёт первым сэмпл t−N+1). Dry delayed exactly like the wet path: N − 1 samples.
      const dr = (this.wpos + 1) % N;
      const d0 = this.dry[0][dr], d1 = this.dry[1][dr];
      this.dry[0][this.wpos] = a; this.dry[1][this.wpos] = b;
      this.inRing[0][this.wpos] = a; this.inRing[1][this.wpos] = b;
      this.wpos = (this.wpos + 1) % N;
      if (++this.hopCount >= this.H) { this.hopCount = 0; this._hop(); }

      let w0 = 0, w1 = 0;
      if (this.fifoN > 0) {
        w0 = this.fifo[0][this.fifoR]; w1 = this.fifo[1][this.fifoR];
        this.fifoR = (this.fifoR + 1) % fl;
        this.fifoN--;
      }
      this.outS += 0.0015 * (outT - this.outS);
      this.mixS += 0.0015 * (mixT - this.mixS);
      this.bypS += 0.0015 * (bypT - this.bypS);
      let z0 = (d0 + (w0 - d0) * this.mixS) * this.outS;
      let z1 = (d1 + (w1 - d1) * this.mixS) * this.outS;
      z0 += (d0 - z0) * this.bypS;
      z1 += (d1 - z1) * this.bypS;
      if (ms) { const l = z0 + z1, r = z0 - z1; z0 = l; z1 = r; }
      oL[i] = z0;
      if (oR !== oL) oR[i] = z1;
      const po = Math.max(Math.abs(z0), Math.abs(z1));
      if (po > this.pkOut) this.pkOut = po;
    }
    return true;
  }
}

registerProcessor('movexe-denoise', MovexeDenoise);
