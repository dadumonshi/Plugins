/**
 * deesser-worklet.js — AudioWorklet Movexe DeEss: вся обработка с точностью до сэмпла.
 * deesser-worklet.js — Movexe DeEss AudioWorklet: sample-accurate processing.
 *
 * Почему AudioWorklet, а не DynamicsCompressorNode: у компрессора Web Audio нет
 * внешнего sidechain, поэтому им нельзя «слушать» только сибилянты и при этом
 * ослаблять полосу/весь сигнал. Здесь детект-цепь и аудио-цепь разделены честно.
 * Why AudioWorklet instead of DynamicsCompressorNode: Web Audio's compressor has
 * no external sidechain, so it cannot listen to sibilants only.
 */
import { SibilanceDetector, Biquad, designFilters, gainComputer, timeCoef, DS_DEFAULTS } from '../detection.js';

const MAX_LOOKAHEAD_MS = 20;

class MovexeDeEss extends AudioWorkletProcessor {
  constructor() {
    super();
    const fs = sampleRate;
    this.fs = fs;
    this.p = { ...DS_DEFAULTS };
    this.det = [new SibilanceDetector(fs), new SibilanceDetector(fs)];
    this.lp = [[], []];
    this.hp = [[], []];
    this.sign = 1;
    // Кольцевой буфер lookahead / lookahead ring buffer
    this.bufLen = 1;
    while (this.bufLen < Math.ceil((MAX_LOOKAHEAD_MS / 1000) * fs) + 256) this.bufLen <<= 1;
    this.buf = [new Float32Array(this.bufLen), new Float32Array(this.bufLen)];
    this.wpos = 0;
    this.delay = 0;

    this.gr = [0, 0];        // сглаженное подавление, дБ / smoothed reduction, dB
    this.gr2 = [0, 0];       // второй каскад сглаживания (анти-«ступеньки») / 2nd smoothing stage
    this.autoThr = -30;      // оценка автопорога / auto-threshold estimate
    this.avgGr = 0;          // для автоуровня / for auto level
    this.outLin = 1;         // сглаженный выход / smoothed output gain
    this.mixS = 1;
    this.bypS = 0;
    this.makeup = 1;

    // Метры для UI (~60 раз в секунду) / meters for UI (~60 Hz)
    this.mEvery = Math.max(1, Math.round(fs / 60 / 128));
    this.mCount = 0;
    this.mGr = 0; this.mGrL = 0; this.mGrR = 0; this.mDet = -120; this.mIn = 0; this.mOut = 0;

    this.configure();
    this.port.onmessage = (e) => {
      if (e.data && e.data.type === 'params') { Object.assign(this.p, e.data.params); this.configure(); }
      if (e.data && e.data.type === 'reset') { this.gr = [0, 0]; this.gr2 = [0, 0]; }
    };
  }

  configure() {
    const p = this.p, fs = this.fs;
    const f = designFilters(p, fs);
    this.det[0].configure(f);
    this.det[1].configure(f);
    const sync = (cur, list) => list.map((c, i) => { const b = cur[i] || new Biquad(c); b.set(c); return b; });
    for (let ch = 0; ch < 2; ch++) {
      // При смене крутизны число секций меняется — сбрасываем состояние / reset state when the order changes
      if (this.lp[ch].length !== f.lp.length) { this.lp[ch] = []; this.hp[ch] = []; }
      this.lp[ch] = sync(this.lp[ch], f.lp);
      this.hp[ch] = sync(this.hp[ch], f.hp);
    }
    this.sign = f.sign;
    this.aAtt = timeCoef(p.attack, fs);
    this.aRel = timeCoef(p.release, fs);
    this.aSmooth = timeCoef(0.4, fs);          // финальное сглаживание / final smoothing
    this.aParam = timeCoef(20, fs);            // выход/микс/обход / output/mix/bypass
    this.aAuto = timeCoef(1500, fs);           // автопорог / auto threshold
    this.aLevel = timeCoef(1000, fs);          // автоуровень / auto level
    this.delay = Math.min(this.bufLen - 1, Math.round((p.lookahead / 1000) * fs));
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || !output.length) return true;
    const oL = output[0];
    const oR = output[1] || output[0];
    const n = oL.length;
    if (!input || !input.length) { oL.fill(0); if (oR !== oL) oR.fill(0); return true; }
    const iL = input[0];
    const iR = input[1] || input[0];

    const p = this.p;
    const ms = p.channelMode === 'mid-side';
    const link = p.channelMode === 'left-right' ? 0 : p.stereoLink / 100;
    const sv = p.mode === 'single-vocal';
    const split = p.processing !== 'wideband';
    const outT = Math.pow(10, p.outputGain / 20);
    const mixT = p.mix / 100;
    const bypT = p.bypass ? 1 : 0;
    const mask = this.bufLen - 1;
    const [d0, d1] = this.det;
    const [b0, b1] = this.buf;
    const [l0s, l1s] = this.lp;
    const [h0s, h1s] = this.hp;
    const sg = this.sign;

    for (let i = 0; i < n; i++) {
      let x0 = iL[i], x1 = iR[i];
      const inAbs = Math.max(Math.abs(x0), Math.abs(x1));
      if (ms) { const m = (x0 + x1) * 0.5, s = (x0 - x1) * 0.5; x0 = m; x1 = s; }

      // ── детект-цепь (без задержки) / detection path (undelayed) ──
      let e0 = d0.process(x0, sv);
      let e1 = d1.process(x1, sv);
      if (link > 0) {
        const mx = e0 > e1 ? e0 : e1;
        e0 = e0 + (mx - e0) * link;
        e1 = e1 + (mx - e1) * link;
      }
      const detMax = e0 > e1 ? e0 : e1;

      // Автопорог: медленное среднее уровня полосы (только при наличии сигнала).
      // Auto threshold: slow average of the band level (gated).
      if (detMax > -75) this.autoThr += this.aAuto * (detMax - this.autoThr);
      const thr = p.autoThreshold ? Math.min(0, Math.max(-60, this.autoThr + 6)) : p.threshold;

      // ── гейн-компьютер + атака/восстановление / gain computer + attack/release ──
      const t0 = gainComputer(e0 - thr, p.knee, p.range);
      const t1 = gainComputer(e1 - thr, p.knee, p.range);
      this.gr[0] += (t0 > this.gr[0] ? this.aAtt : this.aRel) * (t0 - this.gr[0]);
      this.gr[1] += (t1 > this.gr[1] ? this.aAtt : this.aRel) * (t1 - this.gr[1]);
      this.gr2[0] += this.aSmooth * (this.gr[0] - this.gr2[0]);
      this.gr2[1] += this.aSmooth * (this.gr[1] - this.gr2[1]);
      const g0 = Math.pow(10, -this.gr2[0] / 20);
      const g1 = Math.pow(10, -this.gr2[1] / 20);

      // ── аудио-цепь с упреждением / audio path with lookahead ──
      b0[this.wpos] = x0; b1[this.wpos] = x1;
      const rp = (this.wpos - this.delay) & mask;
      const y0 = b0[rp], y1 = b1[rp];
      this.wpos = (this.wpos + 1) & mask;

      // dry — «сухой» сигнал для микса (в Split — сумма полос, та же фаза, что у wet)
      // dry — the mix reference (in Split: band sum, same phase as wet → no comb filtering)
      let w0, w1, r0, r1, dry0 = y0, dry1 = y1;
      if (split) {
        let lo0 = y0, lo1 = y1, hi0 = y0, hi1 = y1;
        for (let k = 0; k < l0s.length; k++) { lo0 = l0s[k].process(lo0); lo1 = l1s[k].process(lo1); }
        for (let k = 0; k < h0s.length; k++) { hi0 = h0s[k].process(hi0); hi1 = h1s[k].process(hi1); }
        hi0 *= sg; hi1 *= sg;
        dry0 = lo0 + hi0; dry1 = lo1 + hi1;
        r0 = hi0 * (1 - g0); r1 = hi1 * (1 - g1);
      } else {
        r0 = y0 * (1 - g0); r1 = y1 * (1 - g1);
      }
      w0 = dry0 - r0; w1 = dry1 - r1;

      // Автоуровень / auto level
      const grAvg = (this.gr2[0] + this.gr2[1]) * 0.5;
      this.avgGr += this.aLevel * (grAvg - this.avgGr);
      const mkT = p.autoLevel ? Math.pow(10, (this.avgGr * (split ? 0.35 : 0.85)) / 20) : 1;
      this.makeup += this.aParam * (mkT - this.makeup);

      this.outLin += this.aParam * (outT - this.outLin);
      this.mixS += this.aParam * (mixT - this.mixS);
      this.bypS += this.aParam * (bypT - this.bypS);

      let z0, z1;
      if (p.audition) { z0 = r0; z1 = r1; } // слушаем удаляемое / listen to what is removed
      else {
        const k = this.outLin * this.makeup;
        z0 = (dry0 + (w0 - dry0) * this.mixS) * k;
        z1 = (dry1 + (w1 - dry1) * this.mixS) * k;
      }
      // Обход (с той же задержкой — без скачка фазы) / bypass (same latency)
      z0 += (y0 - z0) * this.bypS;
      z1 += (y1 - z1) * this.bypS;
      if (ms) { const l = z0 + z1, r = z0 - z1; z0 = l; z1 = r; }
      oL[i] = z0;
      if (oR !== oL) oR[i] = z1;

      // метры / meters
      const gm = this.gr2[0] > this.gr2[1] ? this.gr2[0] : this.gr2[1];
      if (gm > this.mGr) this.mGr = gm;
      if (this.gr2[0] > this.mGrL) this.mGrL = this.gr2[0];
      if (this.gr2[1] > this.mGrR) this.mGrR = this.gr2[1];
      if (detMax > this.mDet) this.mDet = detMax;
      if (inAbs > this.mIn) this.mIn = inAbs;
      const oa = Math.max(Math.abs(z0), Math.abs(z1));
      if (oa > this.mOut) this.mOut = oa;
      this.mThr = thr;
    }

    if (++this.mCount >= this.mEvery) {
      this.mCount = 0;
      this.port.postMessage({
        gr: this.p.bypass ? 0 : this.mGr, grL: this.mGrL, grR: this.mGrR,
        det: this.mDet, thr: this.mThr, inPk: this.mIn, outPk: this.mOut, makeup: 20 * Math.log10(this.makeup)
      });
      this.mGr = this.mGrL = this.mGrR = 0; this.mDet = -120; this.mIn = this.mOut = 0;
    }
    return true;
  }
}

registerProcessor('movexe-deesser', MovexeDeEss);
